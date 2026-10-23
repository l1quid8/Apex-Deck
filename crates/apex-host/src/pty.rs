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
const DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySummary { pub id: String, pub name: String, pub project: Option<String>, pub cwd: Option<String>, pub tail: String, #[serde(skip_serializing_if = "Option::is_none")] pub matched: Option<String>, pub state: String, pub exit_code: Option<u32>, pub last_activity: u64, pub cursor: u64 }

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySnapshot { pub id: String, pub output: String, pub cursor: u64, pub state: String, pub exit_code: Option<u32> }

struct PtyRecord { generation: u64, name: String, project: Option<String>, cwd: Option<String>, state: String, exit_code: Option<u32>, last_activity: u64, cursor: u64, history: VecDeque<u8>, exited_at: Option<u64> }

const TAIL_LIMIT: usize = 4096;

pub fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes(); let mut out = Vec::with_capacity(bytes.len()); let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1b { out.push(bytes[i]); i += 1; continue; }
        i += 1; if i >= bytes.len() { break; }
        match bytes[i] {
            b'[' => { i += 1; while i < bytes.len() { let b = bytes[i]; i += 1; if (0x40..=0x7e).contains(&b) { break; } } }
            b']' => {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == 0x07 { i += 1; break; }
                    if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') { i += 2; break; }
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    String::from_utf8_lossy(&out).lines().map(|line| line.rsplit('\r').next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

fn history_text(history: &VecDeque<u8>, limit: usize) -> String {
    let start = history.len().saturating_sub(limit);
    let bytes: Vec<_> = history.iter().skip(start).copied().skip_while(|byte| byte & 0xC0 == 0x80).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

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

fn clean_name(name: &str) -> String {
    let cleaned: String = name.trim().chars().filter(|c| !c.is_control()).take(60).collect();
    if cleaned.is_empty() { "shell".into() } else { cleaned }
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
                generation, name: clean_name(options.name.as_deref().unwrap_or("shell")), project, cwd: options.cwd.clone(), state: "running".into(), exit_code: None,
                last_activity: now, cursor, history: VecDeque::new(), exited_at: None,
            });
        }

        let records = Arc::clone(&self.records);
        let output_id = id.to_string();
        let output_generation = generation;
        // Dropped when the reader thread ends, which tells the exit thread
        // that all output has been read.
        let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            let _drained = drained_tx;
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
            // Read all output before closing the session. Dropping its writer
            // sends a newline and EOF, which Linux echoes back as output, and
            // watchers should see the last output before the exit. A
            // background job can keep the terminal open, so don't wait long.
            let _ = drained_rx.recv_timeout(DRAIN_TIMEOUT);
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

    pub fn list(&self, query: Option<&str>) -> Vec<PtySummary> {
        let now = now_ms();
        let mut records_guard = self.records.lock().unwrap();
        prune(&mut records_guard, now);
        let records: Vec<_> = records_guard.iter().map(|(id, r)| (id.clone(), r.name.clone(), r.project.clone(), r.cwd.clone(), r.state.clone(), r.exit_code, r.last_activity, r.cursor, r.history.clone())).collect();
        drop(records_guard);
        let query = query.map(str::trim).filter(|q| !q.is_empty()).map(|q| q.chars().take(100).collect::<String>());
        let mut items: Vec<_> = records.into_iter().filter_map(|(id, name, project, cwd, state, exit_code, last_activity, cursor, history)| {
            let tail = history_text(&history, TAIL_LIMIT);
            let matched = query.as_ref().and_then(|q| {
                if name.to_lowercase().contains(&q.to_lowercase()) { return Some(name.clone()); }
                let clean = strip_ansi(&history_text(&history, HISTORY_LIMIT));
                clean.lines().rev().find(|line| line.to_lowercase().contains(&q.to_lowercase())).map(|line| line.trim().chars().take(160).collect())
            });
            if query.is_some() && matched.is_none() { return None; }
            Some(PtySummary { id, name, project, cwd, tail, matched, state, exit_code, last_activity, cursor })
        }).collect();
        items.sort_by_key(|item| std::cmp::Reverse(item.last_activity));
        items
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<String, String> {
        let name = clean_name(name);
        let mut records = self.records.lock().unwrap();
        let record = records.get_mut(id).ok_or_else(|| format!("no retained terminal with id {id}"))?;
        record.name = name.clone();
        Ok(name)
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

    /// Poll a snapshot until `pred` holds or `timeout` passes. Exit waits for
    /// the output to drain only up to `DRAIN_TIMEOUT`, so a loaded machine can
    /// still report the exit first.
    fn wait_for_snapshot(
        manager: &PtyManager,
        id: &str,
        timeout: Duration,
        mut pred: impl FnMut(&PtySnapshot) -> bool,
    ) -> PtySnapshot {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let snapshot = manager.snapshot(id).unwrap();
            if pred(&snapshot) {
                return snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for pty output in `{id}`"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
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
        assert_eq!(manager.list(None)[0].id, "a");
    }

    #[test]
    fn list_has_folder_tail_and_searches_ansi_stripped_old_output() {
        assert_eq!(strip_ansi("\x1b[31mfoo\x1b[0mbar\rprogress\rDone\n"), "Done");
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "findme", "printf '\\033[31mfoo\\033[0mbar\\n'; sleep 0.1; printf 'latest\\n'");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        let all = manager.list(None);
        assert!(all[0].tail.trim_end().ends_with("latest"));
        assert_eq!(all[0].cwd, None);
        let found = manager.list(Some("FOOBAR"));
        assert_eq!(found.len(), 1);
        assert!(found[0].matched.as_deref().unwrap().contains("foobar"));
    }

    #[test]
    fn rename_changes_name_and_missing_terminal_errors() {
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "rename", "true");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(manager.rename("rename", " new\nname ").unwrap(), "newname");
        assert_eq!(manager.list(None)[0].name, "newname");
        assert!(manager.rename("missing", "x").unwrap_err().contains("no retained terminal"));
    }

    #[test]
    fn listed_tail_is_byte_bounded_and_starts_on_a_utf8_boundary() {
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "tail-cut", "true");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut records = manager.records.lock().unwrap();
        let history = &mut records.get_mut("tail-cut").unwrap().history;
        history.clear();
        history.extend("💥".as_bytes());
        history.extend(std::iter::repeat_n(b'x', TAIL_LIMIT - 3));
        drop(records);
        let record = manager.list(None).remove(0);
        assert!(record.tail.len() <= TAIL_LIMIT);
        assert!(!record.tail.contains('\u{FFFD}'));
        assert!(record.tail.is_char_boundary(0));
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
        // Ends in "x", not "x\r\n": the writer's closing newline must not be
        // echoed into the history (it was on Linux).
        let snapshot = wait_for_snapshot(&manager, "accents", Duration::from_secs(10), |snapshot| snapshot.output.ends_with('x'));
        assert!(!snapshot.output.contains('\u{FFFD}'));
        assert!(snapshot.output.starts_with('é') && snapshot.output.ends_with("éx"));
    }

    #[test]
    fn a_terminal_started_again_under_its_id_keeps_counting() {
        let manager = PtyManager::default();
        let (_out, exit) = spawn_sh(&manager, "again", "echo first");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        let before = wait_for_snapshot(&manager, "again", Duration::from_secs(5), |snapshot| snapshot.cursor > 0).cursor;
        let (_out, exit) = spawn_sh(&manager, "again", "echo second");
        exit.recv_timeout(Duration::from_secs(5)).unwrap();
        // The cursor keeps counting across the restart: wait for the second
        // run's output to be drained, which also proves the counter advanced.
        let after = wait_for_snapshot(&manager, "again", Duration::from_secs(5), |snapshot| snapshot.cursor > before);
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
