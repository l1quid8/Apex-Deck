//! Terminal sessions. Each pane in the UI owns one pseudo-terminal here.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Called with terminal output as it arrives.
pub type OutputSink = Box<dyn Fn(u64, &str) + Send>;
/// Called once when the program in the terminal exits.
pub type ExitSink = Box<dyn FnOnce(Option<u32>) + Send>;

struct Session {
    generation: u64,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// All open terminal sessions, keyed by pane id.
#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    records: Arc<Mutex<HashMap<String, PtyRecord>>>,
    generation: Arc<AtomicU64>,
}

const HISTORY_LIMIT: usize = 256 * 1024;
const EXIT_RETENTION_MS: u64 = 5 * 60 * 1000;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySummary { pub id: String, pub name: String, pub project: Option<String>, pub state: String, pub exit_code: Option<u32>, pub last_activity: u64, pub cursor: u64 }

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySnapshot { pub id: String, pub output: String, pub cursor: u64, pub state: String, pub exit_code: Option<u32> }

struct PtyRecord { generation: u64, name: String, project: Option<String>, state: String, exit_code: Option<u32>, last_activity: u64, cursor: u64, history: VecDeque<u8>, exited_at: Option<u64> }

fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }

/// Forget terminals that ended more than `EXIT_RETENTION_MS` ago.
fn prune(records: &mut HashMap<String, PtyRecord>, now: u64) {
    records.retain(|_, record| record.exited_at.is_none_or(|at| now.saturating_sub(at) <= EXIT_RETENTION_MS));
}

pub struct SpawnOptions {
    pub name: Option<String>,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// Holds back the bytes of a character that has only partly arrived.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(_) => String::from_utf8(std::mem::take(&mut self.pending)).unwrap_or_default(),
            Err(e) if e.error_len().is_none() => {
                let rest = self.pending.split_off(e.valid_up_to());
                let text = String::from_utf8(std::mem::replace(&mut self.pending, rest));
                text.unwrap_or_default()
            }
            Err(_) => {
                let text = String::from_utf8_lossy(&self.pending).into_owned();
                self.pending.clear();
                text
            }
        }
    }
}

impl PtyManager {
    /// Start a program in a new terminal. Replaces any session already
    /// using `id`.
    pub fn spawn(
        &self,
        id: &str,
        options: SpawnOptions,
        on_output: OutputSink,
        on_exit: ExitSink,
    ) -> Result<(), String> {
        self.kill(id);

        let project = options.cwd.as_deref().filter(|c| !c.is_empty()).and_then(|c| {
            std::path::Path::new(c).file_name().map(|name| name.to_string_lossy().into_owned())
        });
        let pair = native_pty_system()
            .openpty(size(options.cols, options.rows))
            .map_err(|e| format!("could not open a terminal: {e}"))?;

        let mut command = CommandBuilder::new(&options.program);
        command.args(&options.args);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if let Some(cwd) = options.cwd.as_deref().filter(|c| !c.is_empty()) {
            command.cwd(cwd);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("could not start `{}`: {e}", options.program))?;
        // The child holds its own copy of the slave side. Dropping ours lets
        // the reader see end-of-file when the child exits.
        drop(pair.slave);

        let mut reader =
            pair.master.try_clone_reader().map_err(|e| format!("could not read the terminal: {e}"))?;
        let writer =
            pair.master.take_writer().map_err(|e| format!("could not write to the terminal: {e}"))?;
        let killer = child.clone_killer();

        let generation = self.generation.fetch_add(1, Ordering::Relaxed).saturating_add(1);
        self.sessions
            .lock()
            .unwrap()
            .insert(id.to_string(), Session { generation, writer, master: pair.master, killer });

        {
            let now = now_ms();
            let mut records = self.records.lock().unwrap();
            prune(&mut records, now);
            // A pane that starts again under the same id keeps counting, so a
            // phone already attached to it doesn't drop the new output as old.
            let cursor = records.get(id).map_or(0, |old| old.cursor);
            records.insert(id.to_string(), PtyRecord {
                generation, name: options.name.clone().unwrap_or_else(|| "shell".into()), project, state: "running".into(), exit_code: None,
                last_activity: now, cursor, history: VecDeque::new(), exited_at: None,
            });
        }

        let records = Arc::clone(&self.records);
        let output_id = id.to_string();
        let output_generation = generation;
        std::thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let text = decoder.push(&buffer[..read]);
                        if !text.is_empty() {
                            let cursor = {
                                let mut records = records.lock().unwrap();
                                let Some(record) = records.get_mut(&output_id).filter(|r| r.generation == output_generation) else { continue };
                                record.cursor = record.cursor.saturating_add(1);
                                record.last_activity = now_ms();
                                record.history.extend(text.as_bytes());
                                while record.history.len() > HISTORY_LIMIT { record.history.pop_front(); }
                                record.cursor
                            };
                            on_output(cursor, &text);
                        }
                    }
                }
            }
        });

        let sessions = Arc::clone(&self.sessions);
        let records = Arc::clone(&self.records);
        let id = id.to_string();
        let exit_generation = generation;
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            let mut sessions = sessions.lock().unwrap();
            if sessions.get(&id).is_some_and(|session| session.generation == exit_generation) {
                sessions.remove(&id);
            }
            drop(sessions);
            if let Some(record) = records.lock().unwrap().get_mut(&id).filter(|r| r.generation == exit_generation) {
                record.state = "exited".into();
                record.exit_code = code;
                record.last_activity = now_ms();
                record.exited_at = Some(record.last_activity);
            }
            on_exit(code);
        });

        Ok(())
    }

    /// Send keystrokes to a terminal.
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or_else(|| format!("no terminal with id {id}"))?;
        session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(id).ok_or_else(|| format!("no terminal with id {id}"))?;
        session.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    /// Stop the program in a terminal. Does nothing if it already ended.
    pub fn kill(&self, id: &str) {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(id) {
            let _ = session.killer.kill();
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }

    pub fn list(&self) -> Vec<PtySummary> {
        let now = now_ms();
        let mut records = self.records.lock().unwrap();
        prune(&mut records, now);
        let mut items: Vec<_> = records.iter().map(|(id, r)| PtySummary {
            id: id.clone(), name: r.name.clone(), project: r.project.clone(), state: r.state.clone(),
            exit_code: r.exit_code, last_activity: r.last_activity, cursor: r.cursor,
        }).collect();
        items.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        items
    }

    pub fn snapshot(&self, id: &str) -> Result<PtySnapshot, String> {
        let now = now_ms();
        let mut records = self.records.lock().unwrap();
        prune(&mut records, now);
        let record = records.get(id).ok_or_else(|| format!("no retained terminal with id {id}"))?;
        let cursor = record.cursor;
        let state = record.state.clone();
        let exit_code = record.exit_code;
        // The byte limit can cut a character in two; skip its leftover tail.
        let history: Vec<_> = record.history.iter().copied().skip_while(|byte| byte & 0xC0 == 0x80).collect();
        drop(records);
        let output = String::from_utf8_lossy(&history).into_owned();
        Ok(PtySnapshot { id: id.into(), output, cursor, state, exit_code })
    }

    #[cfg(test)]
    pub fn is_open(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn spawn_sh(
        manager: &PtyManager,
        id: &str,
        script: &str,
    ) -> (mpsc::Receiver<String>, mpsc::Receiver<Option<u32>>) {
        let (out_tx, out_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        manager
            .spawn(
                id,
                SpawnOptions {
                    name: Some("shell".into()),
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), script.into()],
                    cwd: None,
                    cols: 80,
                    rows: 24,
                },
                Box::new(move |_, text| {
                    let _ = out_tx.send(text.to_string());
                }),
                Box::new(move |code| {
                    let _ = exit_tx.send(code);
                }),
            )
            .unwrap();
        (out_rx, exit_rx)
    }

    /// Collect output until `needle` shows up or five seconds pass.
    fn read_until(rx: &mpsc::Receiver<String>, needle: &str) -> String {
        let mut all = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !all.contains(needle) && std::time::Instant::now() < deadline {
            if let Ok(text) = rx.recv_timeout(Duration::from_millis(100)) {
                all.push_str(&text);
            }
        }
        all
    }

    #[test]
    fn output_and_exit_code_are_reported() {
        let manager = PtyManager::default();
        let (out, exit) = spawn_sh(&manager, "a", "echo hello-from-pty; exit 7");
        assert!(read_until(&out, "hello-from-pty").contains("hello-from-pty"));
        assert_eq!(exit.recv_timeout(Duration::from_secs(5)).unwrap(), Some(7));
        assert!(!manager.is_open("a"));
        let snapshot = manager.snapshot("a").unwrap();
        assert!(snapshot.output.contains("hello-from-pty"));
        assert_eq!(snapshot.state, "exited");
        assert_eq!(snapshot.exit_code, Some(7));
        assert!(snapshot.cursor > 0);
        assert_eq!(manager.list()[0].id, "a");
    }

    #[test]
    fn history_is_bounded_and_snapshot_remains_valid_utf8() {
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "bounded", "head -c 300000 /dev/zero | tr '\\000' x");
        exit.recv_timeout(Duration::from_secs(10)).unwrap();
        let snapshot = manager.snapshot("bounded").unwrap();
        assert!(snapshot.output.len() <= HISTORY_LIMIT);
        assert!(snapshot.output.len() >= HISTORY_LIMIT - 4);
        assert!(snapshot.output.chars().all(|ch| ch == 'x' || ch == '\n' || ch == '\r'));
    }

    #[test]
    fn a_cut_character_at_the_start_of_the_history_is_dropped() {
        let manager = PtyManager::default();
        // 'é' is two bytes. With one more byte at the end, an odd number of
        // bytes is dropped, so the kept history starts on the second byte of one.
        let (_out, exit) = spawn_sh(&manager, "accents", "awk 'BEGIN { for (i = 0; i < 150000; i++) printf \"\\303\\251\"; printf \"x\" }'");
        exit.recv_timeout(Duration::from_secs(10)).unwrap();
        let snapshot = manager.snapshot("accents").unwrap();
        assert!(!snapshot.output.contains('\u{FFFD}'));
        assert!(snapshot.output.starts_with('é') && snapshot.output.ends_with("éx"));
    }

    #[test]
    fn a_terminal_started_again_under_its_id_keeps_counting() {
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "again", "echo first");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        let before = manager.snapshot("again").unwrap().cursor;
        assert!(before > 0);
        let (_out, exit) = spawn_sh(&manager, "again", "echo second");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        let after = manager.snapshot("again").unwrap();
        assert!(after.cursor > before);
        assert!(after.output.contains("second") && !after.output.contains("first"));
    }

    #[test]
    fn starting_a_terminal_forgets_ones_that_ended_long_ago() {
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "old", "true");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        manager.records.lock().unwrap().get_mut("old").unwrap().exited_at = Some(now_ms() - EXIT_RETENTION_MS - 1);
        let (_out, exit) = spawn_sh(&manager, "new", "true");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        let records = manager.records.lock().unwrap();
        assert!(!records.contains_key("old") && records.contains_key("new"));
    }

    #[test]
    fn input_reaches_the_program() {
        let manager = PtyManager::default();
        let (out, exit) = spawn_sh(&manager, "b", "read line; echo \"got:$line\"");
        manager.write("b", "ping\n").unwrap();
        assert!(read_until(&out, "got:ping").contains("got:ping"));
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn the_program_sees_the_size_and_a_resize() {
        let manager = PtyManager::default();
        let (out, _exit) = spawn_sh(&manager, "c", "stty size; read go; stty size; read done");
        assert!(read_until(&out, "24 80").contains("24 80"));
        manager.resize("c", 132, 43).unwrap();
        manager.write("c", "\n").unwrap();
        assert!(read_until(&out, "43 132").contains("43 132"));
        manager.kill("c");
    }

    #[test]
    fn kill_stops_a_running_program() {
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "d", "sleep 60");
        assert!(manager.is_open("d"));
        manager.kill("d");
        assert!(exit.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(manager.write("d", "x").is_err());
    }

    #[test]
    fn the_working_directory_is_honoured() {
        let manager = PtyManager::default();
        let (out_tx, out_rx) = mpsc::channel();
        manager
            .spawn(
                "e",
                SpawnOptions {
                    name: Some("shell".into()),
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), "pwd".into()],
                    cwd: Some("/tmp".into()),
                    cols: 80,
                    rows: 24,
                },
                Box::new(move |_, text| {
                    let _ = out_tx.send(text.to_string());
                }),
                Box::new(|_| {}),
            )
            .unwrap();
        assert!(read_until(&out_rx, "/tmp").contains("/tmp"));
    }
}
