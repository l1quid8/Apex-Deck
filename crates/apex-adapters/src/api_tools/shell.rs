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

#[cfg(any(windows, test))]
fn windows_shell(mut env: impl FnMut(&str) -> Option<std::ffi::OsString>, path: Option<&str>) -> PathBuf {
    let mut candidates = Vec::new();
    if let Some(explicit) = env("CLAUDE_CODE_GIT_BASH_PATH").filter(|p| !p.is_empty()) {
        candidates.push(PathBuf::from(explicit));
    }
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(base) = env(key).filter(|p| !p.is_empty()) {
            candidates.push(PathBuf::from(base).join("Git/bin/bash.exe"));
        }
    }
    if let Some(base) = env("LOCALAPPDATA").filter(|p| !p.is_empty()) {
        candidates.push(PathBuf::from(base).join("Programs/Git/bin/bash.exe"));
    }
    // Git may have a custom installation root on PATH. Do not select the
    // unrelated System32/bash.exe (the WSL launcher).
    let path = path.map(std::ffi::OsString::from).or_else(|| env("PATH")).unwrap_or_default();
    for directory in std::env::split_paths(&path).filter(|p| !p.as_os_str().is_empty()) {
        if directory.join("git.exe").is_file() {
            if let Some(root) = directory.parent() {
                candidates.extend([root.join("bin/bash.exe"), root.join("usr/bin/bash.exe")]);
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file()).unwrap_or_else(|| "powershell.exe".into())
}

#[cfg(test)]
mod windows_selection_tests {
    use super::*;

    #[test]
    fn windows_shell_uses_git_bash_and_falls_back_to_powershell() {
        let root = std::env::temp_dir().join(format!("apx-bash-{}", std::process::id()));
        let bash = root.join("Git/bin/bash.exe");
        std::fs::create_dir_all(bash.parent().unwrap()).unwrap();
        std::fs::write(&bash, "").unwrap();
        let environment = |key: &str| (key == "ProgramFiles").then(|| root.clone().into_os_string());
        assert_eq!(windows_shell(environment, None), bash);
        std::fs::remove_file(&bash).unwrap();
        assert_eq!(windows_shell(environment, None), PathBuf::from("powershell.exe"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod windows_runtime_tests {
    use super::*;

    #[tokio::test]
    async fn selected_windows_shell_reports_output_exit_status_and_timeout() {
        let env = Env { cwd: Some(std::env::temp_dir()), ..Env::default() };
        let bash = env.shell_description().starts_with("Git Bash");
        let script = if bash { "echo out; echo err >&2; exit 3" } else { "Write-Output out; [Console]::Error.WriteLine('err'); exit 3" };
        let finished = run(&env, &Registry::default(), script, Duration::from_secs(10)).await.unwrap();
        assert_eq!(finished.code, Some(3));
        assert!(finished.output.contains("out") && finished.output.contains("err"), "{}", finished.output);
        assert!(!finished.timed_out);
        let script = if bash { "sleep 30" } else { "Start-Sleep -Seconds 30" };
        let finished = run(&env, &Registry::default(), script, Duration::from_millis(300)).await.unwrap();
        assert!(finished.timed_out);
    }
}

/// Where and with what commands run.
#[derive(Debug, Clone, Default)]
pub(crate) struct Env {
    pub cwd: Option<PathBuf>,
    pub path: Option<String>,
    pub temp: Option<PathBuf>,
    pub cargo_target_dir: Option<PathBuf>,
}

impl Env {
    #[cfg(windows)]
    fn windows_shell(&self) -> PathBuf { windows_shell(|key| std::env::var_os(key), self.path.as_deref()) }

    #[cfg(windows)]
    pub(super) fn shell_description(&self) -> &'static str {
        if self.windows_shell().file_name().is_some_and(|p| p.to_string_lossy().eq_ignore_ascii_case("bash.exe")) {
            "Git Bash (bash -c)"
        } else { "Windows PowerShell (powershell.exe -NoProfile -NonInteractive -Command)" }
    }

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
        #[cfg(windows)]
        let mut command = {
            let shell = self.windows_shell();
            let bash = shell.file_name().is_some_and(|p| p.to_string_lossy().eq_ignore_ascii_case("bash.exe"));
            let mut command = Command::new(shell);
            if bash { command.arg("-c"); } else {
                command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
            }
            command.arg(script);
            command
        };
        #[cfg(not(any(unix, windows)))]
        return Err("Shell commands are unsupported on this platform.".into());
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

/// A started shell: the child itself, the buffer both its streams land in,
/// and the task that drains them until it exits.
type Started = (OwnedChild, Arc<Mutex<Output>>, tokio::task::JoinHandle<()>);

/// Start `script`, with both output streams copied into one buffer.
fn start(env: &Env, registry: &Registry, script: &str) -> Result<Started, String> {
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
    } else {
        // Done: end anything left in its group and clear its ownership
        // record, so a later Stop never signals a reused process id.
        child.terminate_tree().await?;
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
    async fn a_finished_command_leaves_no_ownership_record() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("apex-shell-registry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let dir = base.join("workers");
        let registry = Registry::new(Some(dir.clone()));
        run(&env(), &registry, "echo hi", Duration::from_secs(10)).await.unwrap();
        let left: Vec<_> = std::fs::read_dir(&dir).map(|d| d.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).collect()).unwrap_or_default();
        assert!(left.is_empty(), "records left: {left:?}");
        assert!(!registry.terminate_all().await.unwrap(), "nothing is still owned, so Stop signals nobody");
        let _ = std::fs::remove_dir_all(base);
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
