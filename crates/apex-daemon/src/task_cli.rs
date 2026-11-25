//! `apex-daemon task <verb>`: how Claude Code and Codex agents move their work
//! onto its own branch. Like `phone`, it reads the turn's identity from the
//! environment, asks the running daemon over its local socket, and prints the
//! answer. An error exits non-zero.

use serde_json::{json, Value};

const USAGE: &str = "Use: \"$APEX_DECK_BIN\" task start <type>/<name> (for example fix/paste-images), or \"$APEX_DECK_BIN\" task status";
const MISSING_NAME: &str = "Name the branch: \"$APEX_DECK_BIN\" task start <type>/<name>, for example fix/paste-images.";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Parsed {
    Start { branch: String },
    Status,
}

const NOT_IN_A_TURN: &str = "This command only works inside an Apex Deck agent turn, at Full access.";
const NOT_REACHABLE: &str = "Deck isn't reachable. Is the Apex Deck app running?";

/// Reads `args` (everything after `task`).
pub(crate) fn parse(args: &[String]) -> Result<Parsed, String> {
    match args {
        [verb] if verb == "start" => Err(MISSING_NAME.into()),
        [verb, branch] if verb == "start" => Ok(Parsed::Start { branch: branch.clone() }),
        [verb] if verb == "status" => Ok(Parsed::Status),
        _ => Err(USAGE.into()),
    }
}

/// The daemon command for `parsed`, run as `bot` in `room`.
pub(crate) fn call(parsed: &Parsed, room: &str, bot: &str) -> Value {
    match parsed {
        Parsed::Start { branch } => json!({ "cmd": "task_start", "args": { "room": room, "bot": bot, "branch": branch } }),
        Parsed::Status => json!({ "cmd": "task_status", "args": { "room": room, "bot": bot } }),
    }
}

/// The daemon's endpoint from the path an agent was given: `<data>/daemon.sock`
/// on Unix, and on Windows the named pipe that data folder's daemon listens on.
fn endpoint(socket: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    if socket.file_name() == Some(std::ffi::OsStr::new(apex_adapters::DAEMON_SOCKET)) {
        if let Some(pipe) = socket.parent().and_then(|data| crate::ipc::endpoint(data).ok()) {
            return pipe;
        }
    }
    socket.to_path_buf()
}

/// Runs `task <args>` and returns the exit code.
pub fn main(args: &[String]) -> i32 {
    let parsed = match parse(args) {
        Ok(parsed) => parsed,
        Err(why) => {
            eprintln!("{why}");
            return 1;
        }
    };
    let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    // The socket is given only at Full access; without it there is nothing to ask.
    let (Some(socket), Some(room), Some(bot)) = (env("APEX_DECK_PHONE_SOCKET"), env("APEX_DECK_ROOM"), env("APEX_DECK_BOT")) else {
        eprintln!("{NOT_IN_A_TURN}");
        return 1;
    };
    let Ok(stream) = crate::ipc::connect_blocking(&endpoint(std::path::Path::new(&socket))) else {
        eprintln!("{NOT_REACHABLE}");
        return 1;
    };
    match crate::local_call::through_daemon(stream, call(&parsed, &room, &bot)) {
        Ok(Value::String(text)) => {
            println!("{text}");
            0
        }
        Ok(other) => {
            println!("{other}");
            0
        }
        Err(why) => {
            eprintln!("{why}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn start_and_status_are_read_and_a_missing_name_is_explained() {
        assert_eq!(parse(&args(&["start", "fix/paste-images"])), Ok(Parsed::Start { branch: "fix/paste-images".into() }));
        assert_eq!(parse(&args(&["status"])), Ok(Parsed::Status));
        assert_eq!(parse(&args(&["start"])), Err(MISSING_NAME.into()));
        for wrong in [&[][..], &["begin", "fix/x"], &["start", "fix/a", "fix/b"], &["status", "now"]] {
            assert_eq!(parse(&args(wrong)), Err(USAGE.into()), "{wrong:?}");
        }
    }

    #[test]
    fn each_verb_asks_the_daemon_as_this_agent_in_this_thread() {
        assert_eq!(
            call(&Parsed::Start { branch: "fix/paste-images".into() }, "pane-1", "jigga"),
            json!({ "cmd": "task_start", "args": { "room": "pane-1", "bot": "jigga", "branch": "fix/paste-images" } })
        );
        assert_eq!(call(&Parsed::Status, "pane-1", "jigga"), json!({ "cmd": "task_status", "args": { "room": "pane-1", "bot": "jigga" } }));
    }
}
