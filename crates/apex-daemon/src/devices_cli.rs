//! `apex-daemon devices …`: list, add and revoke remote devices.
//!
//! With a daemon running, the request goes through its local socket, so a
//! revoke also cuts off a connected device at once. Otherwise the registry
//! file is changed here on Linux, under the data folder's lock. Mac grants
//! require the running installed daemon and never fall back to editable JSON.

use std::path::PathBuf;

use apex_host::lock::{DataLock, LockError};
use serde_json::{json, Value};

use crate::devices::Devices;
use crate::{ipc, local_call, paths, protocol};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicesAction {
    List,
    /// Temporary until QR pairing (milestone 3) adds devices.
    Add { id: String, label: String, restore: bool },
    Revoke { id: String },
}

pub const USAGE: &str = "\
usage: apex-daemon devices list
       apex-daemon devices add <endpoint-id> --label NAME [--restore]
       apex-daemon devices revoke <endpoint-id>";

/// Read what follows `devices`.
pub fn parse(args: &[String]) -> Result<DevicesAction, String> {
    let usage = |why: String| format!("{why}\n\n{USAGE}");
    match args.first().map(String::as_str) {
        Some("list") if args.len() == 1 => Ok(DevicesAction::List),
        Some("revoke") if args.len() == 2 => Ok(DevicesAction::Revoke { id: args[1].clone() }),
        Some("add") if args.len() >= 2 => {
            let id = args[1].clone();
            let (mut label, mut restore) = (None, false);
            let mut rest = args[2..].iter();
            while let Some(arg) = rest.next() {
                let mut value = || rest.next().cloned().ok_or_else(|| usage(format!("{arg} needs a value")));
                match arg.as_str() {
                    "--label" => label = Some(value()?),
                    "--restore" => restore = true,
                    other => return Err(usage(format!("unknown argument {other}"))),
                }
            }
            let label = label.ok_or_else(|| usage("add needs --label".into()))?;
            Ok(DevicesAction::Add { id, label, restore })
        }
        _ => Err(usage("say list, add or revoke".into())),
    }
}

/// The protocol request for `action`.
pub fn request(action: &DevicesAction) -> Value {
    match action {
        DevicesAction::List => json!({ "cmd": "devices_list", "args": {} }),
        DevicesAction::Add { id, label, restore } => json!({ "cmd": "devices_add", "args": { "id": id, "label": label, "restore": restore } }),
        DevicesAction::Revoke { id } => json!({ "cmd": "devices_revoke", "args": { "id": id } }),
    }
}

pub fn run(data_dir: Option<PathBuf>, action: DevicesAction) -> Result<(), String> {
    let paths = paths::host_paths(data_dir)?;
    let request = request(&action);
    let answer = match ipc::endpoint(&paths.data).and_then(|path| ipc::connect_blocking(&path)) {
        Ok(socket) => local_call::through_daemon(socket, request)?,
        Err(_) => {
            let devices = Devices::open(&paths.data);
            if devices.requires_ui_receipt() {
                return Err("Protected phone grants cannot be managed offline. Start the installed Apex Deck for this data directory and retry through its running daemon. If the protected provenance service is unavailable, repair it and restart Deck first.".into());
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<DevicesAction, String> {
        super::parse(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn devices_has_list_add_and_revoke_only() {
        assert_eq!(parse(&["list"]), Ok(DevicesAction::List));
        assert_eq!(parse(&["revoke", "abc"]), Ok(DevicesAction::Revoke { id: "abc".into() }));
        assert!(parse(&["tier", "abc", "full"]).is_err());
        assert!(parse(&["threads", "abc", "all"]).is_err());
        let add = parse(&["add", "abc", "--label", "My phone", "--restore"]).unwrap();
        assert_eq!(add, DevicesAction::Add { id: "abc".into(), label: "My phone".into(), restore: true });
        assert_eq!(request(&add), json!({ "cmd": "devices_add", "args": { "id": "abc", "label": "My phone", "restore": true } }));
    }

    #[test]
    fn mistakes_are_named() {
        assert!(parse(&[]).unwrap_err().contains("say list"));
        assert!(parse(&["add", "abc"]).unwrap_err().contains("--label"));
        assert!(parse(&["add", "abc", "--label"]).unwrap_err().contains("--label needs a value"));
        assert!(parse(&["revoke"]).is_err());
    }

    /// Without a daemon, the CLI changes the registry itself.
    #[test]
    fn without_a_daemon_the_registry_is_changed_here() {
        let data = crate::devices::tests::folder();
        let id = crate::devices::tests::id(1);
        run(Some(data.0.clone()), DevicesAction::Add { id: id.clone(), label: "Phone".into(), restore: false }).unwrap();
        run(Some(data.0.clone()), DevicesAction::Revoke { id: id.clone() }).unwrap();
        let saved = Devices::open(&data.0).list().unwrap();
        assert!(saved.devices.is_empty());
        assert_eq!(saved.revoked[0].endpoint_id, id);
    }
}
