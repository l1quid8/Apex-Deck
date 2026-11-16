//! `apex-daemon doctor`: the first thing to run when something is off. One
//! page that says which build this is, what it speaks, where its data is,
//! whether a daemon is running on that folder and answering, and the last
//! lines of its log, so a report can carry the facts instead of guesses.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// How many log lines the report ends with.
pub const LOG_LINES: usize = 20;

pub fn run(data_dir: Option<PathBuf>) -> Result<(), String> {
    let paths = crate::paths::host_paths(data_dir)?;
    let answers = |endpoint: &Path| crate::ipc::connect_blocking(endpoint).is_ok();
    print!("{}", report(&paths.data, dirs::home_dir().as_deref(), &answers));
    Ok(())
}

/// The whole report. `home` finds the installed app's log; `answers` says
/// whether something accepts connections at the local endpoint.
pub fn report(data: &Path, home: Option<&Path>, answers: &dyn Fn(&Path) -> bool) -> String {
    let mut out = String::new();
    let line = |out: &mut String, text: String| { out.push_str(&text); out.push('\n'); };
    line(&mut out, crate::build_info::version_line());
    let capabilities: Vec<&str> = crate::protocol::CAPABILITIES.iter().chain(crate::protocol::OPTIONAL_CAPABILITIES).copied().collect();
    line(&mut out, format!("protocol {}; {} capabilities: {}", crate::protocol::PROTOCOL, capabilities.len(), capabilities.join(", ")));
    line(&mut out, format!("data folder: {} ({})", data.display(), if data.is_dir() { "exists" } else { "missing" }));

    let info_path = data.join("daemon.json");
    match std::fs::read_to_string(&info_path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
        None => line(&mut out, "daemon.json: none; no daemon has run on this folder, or it never got as far as listening".into()),
        Some(info) => {
            let pid = info["pid"].as_u64();
            let running = match pid { Some(pid) => match process_alive(pid) { Some(true) => "running", Some(false) => "not running (stale file)", None => "unknown" }, None => "no pid recorded" };
            line(&mut out, format!("daemon.json: pid {} ({running}); protocol {}; host {}; boot {}", pid.map_or("?".into(), |p| p.to_string()), info["protocol"], info["host_id"].as_str().unwrap_or("?"), info["boot_id"].as_str().unwrap_or("?")));
            let port = &info["port"];
            line(&mut out, format!("  socket {}; network port {}; remote access {}; model gateway {}",
                info["socket"].as_str().unwrap_or("?"),
                if port.is_null() { "none".to_string() } else { format!("{} on {}", port, info["bind"].as_str().unwrap_or("?")) },
                if info["remote"].is_null() { "off".to_string() } else { format!("on as {}", info["remote"]["endpoint_id"].as_str().unwrap_or("?")) },
                if info["gateway"]["enabled"] == true { "on".to_string() } else { "off".to_string() }));
        }
    }
    match crate::ipc::endpoint(data) {
        Ok(endpoint) => line(&mut out, format!("endpoint: {} ({})", endpoint.display(), if answers(&endpoint) { "answers" } else { "nothing listening" })),
        Err(error) => line(&mut out, format!("endpoint: could not be resolved: {error}")),
    }
    line(&mut out, format!("remote access setting: {}", match crate::remote_settings::enabled(data) { Some(true) => "on", Some(false) => "off", None => "never set" }));

    line(&mut out, "logs:".into());
    let mut candidates = vec![data.join("desktop-daemon.log")];
    if let Some(home) = home {
        if cfg!(target_os = "macos") { candidates.push(home.join("Library/Logs/Apex Deck/apex-daemon.log")); }
    }
    let mut any = false;
    for path in candidates {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        any = true;
        let lines: Vec<&str> = text.lines().collect();
        let shown = &lines[lines.len().saturating_sub(LOG_LINES)..];
        line(&mut out, format!("  {} (last {} of {} lines):", path.display(), shown.len(), lines.len()));
        for l in shown { line(&mut out, format!("    {l}")); }
    }
    if !any { line(&mut out, "  no log file found next to the data or in the app's Logs folder".into()); }
    if cfg!(target_os = "linux") { line(&mut out, "  on a Linux service: journalctl --user -u 'apex-daemon@*' -n 20".into()); }
    out
}

/// Whether a process with `pid` exists, where that can be asked.
#[cfg(unix)]
fn process_alive(pid: u64) -> Option<bool> {
    let Ok(pid) = i32::try_from(pid) else { return Some(false) };
    // kill(pid, 0) sends nothing; it fails with ESRCH when there is no such process.
    let result = unsafe { libc::kill(pid, 0) };
    Some(result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

#[cfg(not(unix))]
fn process_alive(_pid: u64) -> Option<bool> { None }

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-doctor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_folder_no_daemon_ever_used_says_so_and_still_names_the_build() {
        let data = temp("empty");
        let text = report(&data, None, &|_| false);
        assert!(text.starts_with(&crate::build_info::version_line()), "{text}");
        assert!(text.contains(&format!("protocol {};", crate::protocol::PROTOCOL)));
        assert!(text.contains("capabilities: monitor,"));
        assert!(text.contains("daemon.json: none"));
        assert!(text.contains("nothing listening"));
        assert!(text.contains("remote access setting: never set"));
        assert!(text.contains("no log file found"));
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn a_running_daemon_is_read_from_daemon_json_and_the_log_tail_is_the_last_twenty_lines() {
        let data = temp("running");
        let info = serde_json::json!({ "pid": std::process::id(), "port": 4321, "bind": "127.0.0.1", "socket": "/tmp/x.sock", "protocol": 1, "host_id": "h1", "boot_id": "b1", "remote": { "endpoint_id": "abc" }, "gateway": { "enabled": true } });
        std::fs::write(data.join("daemon.json"), info.to_string()).unwrap();
        std::fs::write(data.join("desktop-daemon.log"), (1..=30).map(|i| format!("line {i}\n")).collect::<String>()).unwrap();
        let text = report(&data, None, &|_| true);
        if cfg!(unix) { assert!(text.contains(&format!("pid {} (running)", std::process::id())), "{text}"); }
        assert!(text.contains("socket /tmp/x.sock; network port 4321 on 127.0.0.1; remote access on as abc; model gateway on"), "{text}");
        assert!(text.contains("(answers)"));
        assert!(text.contains("(last 20 of 30 lines):"));
        assert!(text.contains("    line 11\n") && text.contains("    line 30\n") && !text.contains("    line 10\n"));
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_pid_is_called_stale() {
        let data = temp("stale");
        // PID 2^22-1 is above any live pid on macOS and Linux defaults.
        std::fs::write(data.join("daemon.json"), serde_json::json!({ "pid": 4194303, "protocol": 1 }).to_string()).unwrap();
        let text = report(&data, None, &|_| false);
        assert!(text.contains("(not running (stale file))"), "{text}");
        std::fs::remove_dir_all(&data).unwrap();
    }
}
