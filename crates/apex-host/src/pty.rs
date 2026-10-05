//! Terminal sessions. Each pane in the UI owns one pseudo-terminal here.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Called with terminal output as it arrives.
pub type OutputSink = Box<dyn Fn(&str) + Send>;
/// Called once when the program in the terminal exits.
pub type ExitSink = Box<dyn FnOnce(Option<u32>) + Send>;

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// All open terminal sessions, keyed by pane id.
#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

pub struct SpawnOptions {
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

        self.sessions
            .lock()
            .unwrap()
            .insert(id.to_string(), Session { writer, master: pair.master, killer });

        std::thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let text = decoder.push(&buffer[..read]);
                        if !text.is_empty() {
                            on_output(&text);
                        }
                    }
                }
            }
        });

        let sessions = Arc::clone(&self.sessions);
        let id = id.to_string();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            sessions.lock().unwrap().remove(&id);
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
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), script.into()],
                    cwd: None,
                    cols: 80,
                    rows: 24,
                },
                Box::new(move |text| {
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
                    program: "/bin/sh".into(),
                    args: vec!["-c".into(), "pwd".into()],
                    cwd: Some("/tmp".into()),
                    cols: 80,
                    rows: 24,
                },
                Box::new(move |text| {
                    let _ = out_tx.send(text.to_string());
                }),
                Box::new(|_| {}),
            )
            .unwrap();
        assert!(read_until(&out_rx, "/tmp").contains("/tmp"));
    }
}
