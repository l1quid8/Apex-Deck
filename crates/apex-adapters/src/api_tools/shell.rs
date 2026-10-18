//! The shell tool: a command run to the end, or one left running in the
//! background for the rest of the turn.
//!
//! Every command gets its own process group in the participant's registry,
//! so Stop ends it with everything it started. Nothing outlives the turn:
//! when the reply is finished, background commands are stopped too.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{oneshot, watch};

use crate::owned_process::{OwnedChild, Registry};

/// Bytes kept from the start of a command's output.
const HEAD_MAX: usize = 64 * 1024;
/// Bytes kept from the end of a command's output.
const TAIL_MAX: usize = 1024 * 1024;
/// How long a finished command's output pipes may stay open, held by
/// something it started, before that is stopped.
const DRAIN_WAIT: Duration = Duration::from_secs(2);
/// Most commands left running at once.
const JOBS_MAX: usize = 8;

/// Where and with what commands run.
#[derive(Debug, Clone, Default)]
pub(crate) struct Env {
    pub cwd: Option<PathBuf>,
    pub path: Option<String>,
    pub temp: Option<PathBuf>,
    pub cargo_target_dir: Option<PathBuf>,
}

impl Env {
    /// A shell running `script` in the project folder, with nothing to read
    /// from and the output piped back.
    fn command(&self, script: &str) -> Result<Command, String> {
        #[cfg(unix)]
        let mut command = {
            let shell = if std::path::Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" };
            let mut command = Command::new(shell);
            command.arg("-c").arg(script);
            command
        };
        #[cfg(not(unix))]
        let mut command = {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(script);
            command
        };
        // No terminal: keep pagers, colours and password prompts out.
        command
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .env("PAGER", "cat")
            .env("GIT_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0");
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        if let Some(temp) = self.temp.as_ref().filter(|dir| dir.is_dir()) {
            command.env("TMPDIR", temp).env("TMP", temp).env("TEMP", temp);
        }
        if let Some(target) = &self.cargo_target_dir {
            command.env("CARGO_TARGET_DIR", target);
        }
        if let Some(cwd) = &self.cwd {
            if !cwd.is_dir() {
                return Err(format!("The project folder {} doesn't exist.", cwd.display()));
            }
            command.current_dir(cwd);
        }
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        Ok(command)
    }
}

/// A command's output as it arrives: the start, and a rolling end.
#[derive(Debug, Default)]
pub(crate) struct Output {
    head: Vec<u8>,
    tail: Vec<u8>,
    /// Where `tail[0]` is in the whole output.
    tail_from: u64,
    total: u64,
}

impl Output {
    fn push(&mut self, mut bytes: &[u8]) {
        self.total += bytes.len() as u64;
        if self.head.len() < HEAD_MAX {
            let take = (HEAD_MAX - self.head.len()).min(bytes.len());
            self.head.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            self.tail_from = self.head.len() as u64;
        }
        self.tail.extend_from_slice(bytes);
        if self.tail.len() > TAIL_MAX {
            let drop = self.tail.len() - TAIL_MAX;
            self.tail.drain(..drop);
            self.tail_from += drop as u64;
        }
    }

    /// Everything kept, with a note where the middle was dropped.
    pub fn whole(&self) -> String {
        let mut out = text(&self.head);
        let gap = self.tail_from - self.head.len() as u64;
        if gap > 0 {
            out.push_str(&format!("\n… {gap} bytes of output not kept …\n"));
        }
        out.push_str(&text(&self.tail));
        out
    }

    /// What arrived after byte `from`, and where that leaves off.
    fn since(&self, from: u64) -> (String, u64) {
        let mut out = String::new();
        let head_len = self.head.len() as u64;
        if from < head_len {
            out.push_str(&text(&self.head[from as usize..]));
        }
        let start = from.max(head_len);
        if start < self.tail_from {
            out.push_str(&format!("… {} bytes of output not kept …\n", self.tail_from - start));
        }
        let skip = start.saturating_sub(self.tail_from) as usize;
        if skip < self.tail.len() {
            out.push_str(&text(&self.tail[skip..]));
        }
        (out, self.total)
    }
}

fn text(bytes: &[u8]) -> String {
    crate::ansi::AnsiStripper::default().push(&String::from_utf8_lossy(bytes))
}

/// Copy a pipe into `output` until it closes.
async fn pump(mut pipe: impl AsyncRead + Unpin, output: Arc<Mutex<Output>>) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => output.lock().unwrap().push(&buffer[..n]),
        }
    }
}

/// Start `script`, with both output streams copied into one buffer.
fn start(env: &Env, registry: &Registry, script: &str) -> Result<(OwnedChild, Arc<Mutex<Output>>, tokio::task::JoinHandle<()>), String> {
    let mut command = env.command(script)?;
    let mut child = registry.spawn(&mut command).map_err(|e| format!("Couldn't start the shell: {e}"))?;
    let output = Arc::new(Mutex::new(Output::default()));
    let out = child.stdout.take().map(|p| tokio::spawn(pump(p, output.clone())));
    let err = child.stderr.take().map(|p| tokio::spawn(pump(p, output.clone())));
    let readers = tokio::spawn(async move {
        if let Some(out) = out {
            let _ = out.await;
        }
        if let Some(err) = err {
            let _ = err.await;
        }
    });
    Ok((child, output, readers))
}

/// How a command ended.
#[derive(Debug)]
pub(crate) struct Finished {
    pub code: Option<i32>,
    pub output: String,
    pub timed_out: bool,
    /// Something it started was still holding its output open, and was stopped.
    pub leftovers_stopped: bool,
}

/// Run `script` to the end, or until `timeout`.
pub(crate) async fn run(env: &Env, registry: &Registry, script: &str, timeout: Duration) -> Result<Finished, String> {
    let (mut child, output, mut readers) = start(env, registry, script)?;
    let (code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => (status.ok().and_then(|s| s.code()), false),
        Err(_) => {
            child.terminate_tree().await?;
            (None, true)
        }
    };
    let mut leftovers_stopped = false;
    if tokio::time::timeout(DRAIN_WAIT, &mut readers).await.is_err() {
        // A process it started in the background still has the pipes.
        child.terminate_tree().await?;
        leftovers_stopped = !timed_out;
        let _ = tokio::time::timeout(DRAIN_WAIT, &mut readers).await;
    }
    let output = output.lock().unwrap().whole();
    Ok(Finished { code, output, timed_out, leftovers_stopped })
}

/// What a background command has done so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum State {
    Running,
    Exited(Option<i32>),
    Stopped,
}

struct Job {
    command: String,
    output: Arc<Mutex<Output>>,
    read_to: u64,
    started: Instant,
    state: watch::Receiver<State>,
    stop: Option<oneshot::Sender<()>>,
}

/// The background commands of one turn. Dropping it stops them all.
#[derive(Default)]
pub(crate) struct Jobs {
    next: u32,
    jobs: HashMap<String, Job>,
}

impl Jobs {
    /// Start `script` and leave it running. Returns its id.
    pub fn start(&mut self, env: &Env, registry: &Registry, script: &str) -> Result<String, String> {
        let running = self.jobs.values().filter(|j| *j.state.borrow() == State::Running).count();
        if running >= JOBS_MAX {
            return Err(format!("{JOBS_MAX} commands are already running. Stop one with job_stop first."));
        }
        let (mut child, output, readers) = start(env, registry, script)?;
        let (state_tx, state_rx) = watch::channel(State::Running);
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            tokio::select! {
                status = child.wait() => {
                    let code = status.ok().and_then(|s| s.code());
                    // Whatever it left behind goes with it.
                    let _ = tokio::time::timeout(DRAIN_WAIT, readers).await;
                    let _ = child.terminate_tree().await;
                    let _ = state_tx.send(State::Exited(code));
                }
                // Asked to stop, or the turn is over and the sender was dropped.
                _ = stop_rx => {
                    let _ = child.terminate_tree().await;
                    let _ = state_tx.send(State::Stopped);
                }
            }
        });
        self.next += 1;
        let id = format!("job-{}", self.next);
        self.jobs.insert(id.clone(), Job { command: script.to_string(), output, read_to: 0, started: Instant::now(), state: state_rx, stop: Some(stop_tx) });
        Ok(id)
    }

    /// New output from job `id` since the last look, waiting up to `wait`
    /// for it to finish first.
    pub async fn output(&mut self, id: &str, wait: Duration) -> Result<(String, State, Duration, String), String> {
        let job = self.jobs.get_mut(id).ok_or_else(|| format!("There is no job {id} in this reply."))?;
        if *job.state.borrow() == State::Running && !wait.is_zero() {
            let mut state = job.state.clone();
            let _ = tokio::time::timeout(wait, state.wait_for(|s| *s != State::Running)).await;
        }
        // Let the last of the output land.
        if *job.state.borrow() != State::Running {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let state = *job.state.borrow();
        let (text, to) = job.output.lock().unwrap().since(job.read_to);
        job.read_to = to;
        Ok((text, state, job.started.elapsed(), job.command.clone()))
    }

    /// Stop job `id` and everything it started.
    pub async fn stop(&mut self, id: &str) -> Result<State, String> {
        let job = self.jobs.get_mut(id).ok_or_else(|| format!("There is no job {id} in this reply."))?;
        if let Some(stop) = job.stop.take() {
            let _ = stop.send(());
        }
        let mut state = job.state.clone();
        let _ = tokio::time::timeout(Duration::from_secs(3), state.wait_for(|s| *s != State::Running)).await;
        let state = *job.state.borrow();
        Ok(state)
    }

    /// Stop every job still running, and wait for them to go.
    pub async fn stop_all(&mut self) {
        let ids: Vec<String> = self.jobs.keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn env() -> Env {
        Env { cwd: Some(std::env::temp_dir()), ..Env::default() }
    }

    #[tokio::test]
    async fn a_command_runs_to_the_end_with_both_streams() {
        let finished = run(&env(), &Registry::default(), "echo out; echo err >&2; exit 3", Duration::from_secs(10)).await.unwrap();
        assert_eq!(finished.code, Some(3));
        assert!(finished.output.contains("out") && finished.output.contains("err"), "{}", finished.output);
        assert!(!finished.timed_out && !finished.leftovers_stopped);
    }

    #[tokio::test]
    async fn a_command_past_its_time_is_stopped() {
        let started = Instant::now();
        let finished = run(&env(), &Registry::default(), "echo begun; sleep 30", Duration::from_millis(300)).await.unwrap();
        assert!(finished.timed_out);
        assert!(finished.output.contains("begun"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn something_left_holding_the_output_is_stopped() {
        let started = Instant::now();
        let finished = run(&env(), &Registry::default(), "sleep 30 & echo done", Duration::from_secs(10)).await.unwrap();
        assert_eq!(finished.code, Some(0));
        assert!(finished.leftovers_stopped);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn a_background_job_reports_new_output_and_its_end() {
        let mut jobs = Jobs::default();
        let id = jobs.start(&env(), &Registry::default(), "echo one; sleep 0.3; echo two").unwrap();
        let (_, state, _, _) = jobs.output(&id, Duration::ZERO).await.unwrap();
        assert_eq!(state, State::Running);
        let (text, state, _, _) = jobs.output(&id, Duration::from_secs(5)).await.unwrap();
        assert_eq!(state, State::Exited(Some(0)));
        assert!(text.contains("two"), "{text}");
        let (again, _, _, _) = jobs.output(&id, Duration::ZERO).await.unwrap();
        assert_eq!(again, "", "output already read isn't repeated");
    }

    #[tokio::test]
    async fn a_background_job_can_be_stopped_and_dropping_jobs_stops_them() {
        let mut jobs = Jobs::default();
        let id = jobs.start(&env(), &Registry::default(), "sleep 30").unwrap();
        assert_eq!(jobs.stop(&id).await.unwrap(), State::Stopped);
        let id = jobs.start(&env(), &Registry::default(), "sleep 30").unwrap();
        let mut state = jobs.jobs[&id].state.clone();
        drop(jobs);
        tokio::time::timeout(Duration::from_secs(5), state.wait_for(|s| *s == State::Stopped)).await.unwrap().unwrap();
    }

    #[test]
    fn output_keeps_the_start_and_the_end() {
        let mut output = Output::default();
        output.push(&vec![b'a'; HEAD_MAX]);
        output.push(&vec![b'b'; TAIL_MAX + 10]);
        output.push(b"end");
        let whole = output.whole();
        assert!(whole.starts_with('a') && whole.ends_with("end"));
        assert!(whole.contains("13 bytes of output not kept"), "{}", &whole[HEAD_MAX..HEAD_MAX + 60]);
        let (fresh, to) = output.since(output.total - 3);
        assert_eq!(fresh, "end");
        assert_eq!(to, output.total);
    }
}
