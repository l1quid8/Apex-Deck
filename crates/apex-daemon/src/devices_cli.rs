//! `apex-daemon devices …`: list, add, retier and revoke remote devices.
//!
//! With a daemon running, the request goes through its local socket, so a
//! revoke also cuts off a connected device at once. Otherwise the registry
//! file is changed here, under the data folder's lock.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use apex_host::lock::{DataLock, LockError};
use serde_json::{json, Value};

use crate::devices::{Devices, Tier};
use crate::{paths, protocol, serve};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicesAction {
    List,
    /// Temporary until QR pairing (milestone 3) adds devices.
    Add { id: String, label: String, tier: Tier, threads: Option<Vec<String>>, restore: bool },
    Tier { id: String, tier: Tier },
    Threads { id: String, threads: Option<Vec<String>> },
    Revoke { id: String },
}

pub const USAGE: &str = "\
usage: apex-daemon devices list
       apex-daemon devices add <endpoint-id> --label NAME [--tier read_only|chat|full] [--threads ID,ID] [--restore]
       apex-daemon devices tier <endpoint-id> <read_only|chat|full>
       apex-daemon devices threads <endpoint-id> <all|ID,ID>
       apex-daemon devices revoke <endpoint-id>";

/// Read what follows `devices`.
pub fn parse(args: &[String]) -> Result<DevicesAction, String> {
    let usage = |why: String| format!("{why}\n\n{USAGE}");
    let threads = |list: &str| -> Option<Vec<String>> { (list != "all").then(|| list.split(',').map(str::trim).filter(|t| !t.is_empty()).map(String::from).collect()) };
    match args.first().map(String::as_str) {
        Some("list") if args.len() == 1 => Ok(DevicesAction::List),
        Some("revoke") if args.len() == 2 => Ok(DevicesAction::Revoke { id: args[1].clone() }),
        Some("tier") if args.len() == 3 => Ok(DevicesAction::Tier { id: args[1].clone(), tier: Tier::parse(&args[2])? }),
        Some("threads") if args.len() == 3 => Ok(DevicesAction::Threads { id: args[1].clone(), threads: threads(&args[2]) }),
        Some("add") if args.len() >= 2 => {
            let id = args[1].clone();
            let (mut label, mut tier, mut list, mut restore) = (None, Tier::Chat, None, false);
            let mut rest = args[2..].iter();
            while let Some(arg) = rest.next() {
                let mut value = || rest.next().cloned().ok_or_else(|| usage(format!("{arg} needs a value")));
                match arg.as_str() {
                    "--label" => label = Some(value()?),
                    "--tier" => tier = Tier::parse(&value()?)?,
                    "--threads" => list = threads(&value()?),
                    "--restore" => restore = true,
                    other => return Err(usage(format!("unknown argument {other}"))),
                }
            }
            let label = label.ok_or_else(|| usage("add needs --label".into()))?;
            Ok(DevicesAction::Add { id, label, tier, threads: list, restore })
        }
        _ => Err(usage("say list, add, tier, threads or revoke".into())),
    }
}

/// The protocol request for `action`.
pub fn request(action: &DevicesAction) -> Value {
    let threads = |t: &Option<Vec<String>>| t.as_ref().map_or(json!("all"), |t| json!(t));
    match action {
        DevicesAction::List => json!({ "cmd": "devices_list", "args": {} }),
        DevicesAction::Add { id, label, tier, threads: t, restore } => json!({ "cmd": "devices_add", "args": { "id": id, "label": label, "tier": tier, "threads": threads(t), "restore": restore } }),
        DevicesAction::Tier { id, tier } => json!({ "cmd": "devices_set_tier", "args": { "id": id, "tier": tier } }),
        DevicesAction::Threads { id, threads: t } => json!({ "cmd": "devices_set_threads", "args": { "id": id, "threads": threads(t) } }),
        DevicesAction::Revoke { id } => json!({ "cmd": "devices_revoke", "args": { "id": id } }),
    }
}

pub fn run(data_dir: Option<PathBuf>, action: DevicesAction) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let request = request(&action);
    let answer = match std::os::unix::net::UnixStream::connect(paths.data.join(serve::SOCKET)) {
        Ok(socket) => through_daemon(socket, request)?,
        Err(_) => {
            let _lock = match DataLock::acquire(&paths.data, &format!("apex-daemon devices (pid {})", std::process::id())) {
                Ok(lock) => lock,
                Err(LockError::Held { owner }) => return Err(format!("{} is in use by {owner}, which takes no connections; quit it first", paths.data.display())),
                Err(e) => return Err(e.to_string()),
            };
            protocol::manage_json(&Devices::open(&paths.data), request)?
        }
    };
    println!("{}", serde_json::to_string_pretty(&answer).map_err(|e| e.to_string())?);
    Ok(())
}

/// Say hello on the daemon's socket, send `request`, and return its answer.
fn through_daemon(socket: std::os::unix::net::UnixStream, mut request: Value) -> Result<Value, String> {
    request["id"] = json!(1);
    let mut writer = socket.try_clone().map_err(|e| e.to_string())?;
    let hello = json!({ "id": 0, "cmd": "hello", "args": { "protocol": protocol::PROTOCOL } });
    writeln!(writer, "{hello}\n{request}").map_err(|e| format!("could not reach the daemon: {e}"))?;
    for line in BufReader::new(socket).lines() {
        let frame: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if frame["id"] == json!(0) && frame.get("err").is_some() {
            return Err(frame["err"].as_str().unwrap_or("the daemon refused").to_string());
        }
        if frame["id"] == json!(1) {
            return match frame.get("err") {
                Some(why) => Err(why.as_str().unwrap_or_default().to_string()),
                None => Ok(frame["ok"].clone()),
            };
        }
    }
    Err("the daemon closed the connection without answering".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<DevicesAction, String> {
        super::parse(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn each_action_and_its_request() {
        assert_eq!(parse(&["list"]), Ok(DevicesAction::List));
        assert_eq!(parse(&["revoke", "abc"]), Ok(DevicesAction::Revoke { id: "abc".into() }));
        assert_eq!(parse(&["tier", "abc", "full"]), Ok(DevicesAction::Tier { id: "abc".into(), tier: Tier::Full }));
        assert_eq!(parse(&["threads", "abc", "all"]), Ok(DevicesAction::Threads { id: "abc".into(), threads: None }));
        let add = parse(&["add", "abc", "--label", "My phone", "--threads", "r1, r2", "--restore"]).unwrap();
        assert_eq!(add, DevicesAction::Add { id: "abc".into(), label: "My phone".into(), tier: Tier::Chat, threads: Some(vec!["r1".into(), "r2".into()]), restore: true });
        assert_eq!(request(&add), json!({ "cmd": "devices_add", "args": { "id": "abc", "label": "My phone", "tier": "chat", "threads": ["r1", "r2"], "restore": true } }));
        assert_eq!(request(&DevicesAction::Tier { id: "abc".into(), tier: Tier::ReadOnly }), json!({ "cmd": "devices_set_tier", "args": { "id": "abc", "tier": "read_only" } }));
    }

    #[test]
    fn mistakes_are_named() {
        assert!(parse(&[]).unwrap_err().contains("say list"));
        assert!(parse(&["tier", "abc", "admin"]).unwrap_err().contains("admin"));
        assert!(parse(&["add", "abc"]).unwrap_err().contains("--label"));
        assert!(parse(&["add", "abc", "--label"]).unwrap_err().contains("--label needs a value"));
        assert!(parse(&["revoke"]).is_err());
    }

    /// Without a daemon, the CLI changes the registry itself.
    #[test]
    fn without_a_daemon_the_registry_is_changed_here() {
        let data = crate::devices::tests::folder();
        let id = crate::devices::tests::id(1);
        run(Some(data.0.clone()), DevicesAction::Add { id: id.clone(), label: "Phone".into(), tier: Tier::Full, threads: None, restore: false }).unwrap();
        run(Some(data.0.clone()), DevicesAction::Revoke { id: id.clone() }).unwrap();
        let saved = Devices::open(&data.0).list().unwrap();
        assert!(saved.devices.is_empty());
        assert_eq!(saved.revoked[0].endpoint_id, id);
    }
}
