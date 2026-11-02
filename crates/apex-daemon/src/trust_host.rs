//! `trust-host` — the one mechanism to mark a Linux machine as trusted.
//! Per design rev 6: stops daemon, prints inspection, asks reboot, writes epoch.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE: &str = "host-trust.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustRecord {
    pub trusted: bool,
    pub epoch: String,
    #[serde(default)]
    pub trusted_at_ms: u64,
    #[serde(default)]
    pub boot_id: Option<String>,
}

fn path_for(data: &Path) -> PathBuf {
    data.join(FILE)
}

pub fn load(data: &Path) -> Option<TrustRecord> {
    let bytes = std::fs::read(path_for(data)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn is_trusted(data: &Path) -> bool {
    load(data).map(|r| r.trusted && !r.epoch.is_empty()).unwrap_or(false)
}

pub fn epoch(data: &Path) -> Option<String> {
    // Ignore pending record (trusted=false or empty epoch) per Task 3: returns "" locks out every device during reboot wait
    let rec = load(data)?;
    if !rec.trusted { return None; }
    if rec.epoch.is_empty() { return None; }
    Some(rec.epoch)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_epoch() -> Result<String, String> {
    // 32 random bytes from /dev/urandom, must fail if unreadable per Task 3
    let mut buf = [0u8; 32];
    #[cfg(unix)]
    {
        let mut f = std::fs::File::open("/dev/urandom").map_err(|e| format!("could not read /dev/urandom: {e}"))?;
        use std::io::Read;
        f.read_exact(&mut buf).map_err(|e| format!("could not read /dev/urandom: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        return Err("random epoch requires /dev/urandom".into());
    }
    if buf.iter().all(|&b| b == 0) {
        return Err("random epoch read zeros from /dev/urandom".into());
    }
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn boot_id() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok().map(|s| s.trim().to_string())
}

/// Attempt to stop any running daemon for this data dir.
/// On Linux, looks for apex-daemon processes and kills them, and removes the socket.
fn stop_daemon(data: &Path) {
    // Try to remove socket file to prevent new connections
    let sock = data.join("daemon.sock");
    let _ = std::fs::remove_file(&sock);
    // On Unix, try to kill apex-daemon processes (best effort)
    #[cfg(unix)]
    {
        if let Ok(entries) = std::fs::read_dir("/proc") {
            let self_pid = std::process::id();
            for entry in entries.flatten() {
                let name = entry.file_name();
                let s = name.to_string_lossy();
                if !s.chars().all(|c| c.is_ascii_digit()) { continue; }
                if let Ok(pid) = s.parse::<u32>() {
                    if pid == self_pid { continue; }
                    let cmdline_path = format!("/proc/{}/cmdline", pid);
                    if let Ok(cmdline) = std::fs::read(&cmdline_path) {
                        if cmdline.windows(12).any(|w| w == b"apex-daemon") {
                            // Send SIGTERM
                            unsafe { libc::kill(pid as i32, libc::SIGTERM); }
                        }
                    }
                }
            }
        }
        // Give it a moment
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Print what could outlive daemon (best effort, incomplete).
pub fn inspection_report() -> String {
    let mut lines = vec![
        "Deck can't check this machine for you. Only continue if you trust what has run on this account.".into(),
        "".into(),
        "What could outlive the daemon (incomplete list):".into(),
    ];
    #[cfg(unix)]
    {
        if let Ok(entries) = std::fs::read_dir("/proc") {
            let mut others = 0;
            for e in entries.flatten() {
                let name = e.file_name();
                let s = name.to_string_lossy();
                if s.chars().all(|c| c.is_ascii_digit()) {
                    if s.parse::<u32>().ok() != Some(std::process::id()) {
                        others += 1;
                    }
                }
            }
            if others > 0 {
                lines.push(format!("- {others} other processes running as this user"));
            }
        }
    }
    lines.push("- crontab (crontab -l)".into());
    if std::path::Path::new(&format!("{}/.config/systemd/user", std::env::var("HOME").unwrap_or_default())).exists() {
        lines.push("- ~/.config/systemd/user units".into());
    }
    if std::path::Path::new(&format!("{}/.config/autostart", std::env::var("HOME").unwrap_or_default())).exists() {
        lines.push("- ~/.config/autostart entries".into());
    }
    for f in [".bashrc", ".zshrc", ".profile", ".bash_profile"] {
        let p = format!("{}/{}", std::env::var("HOME").unwrap_or_default(), f);
        if std::path::Path::new(&p).exists() {
            if let Ok(meta) = std::fs::metadata(&p) {
                if let Ok(modified) = meta.modified() {
                    if let Ok(elapsed) = modified.elapsed() {
                        if elapsed.as_secs() < 7*24*3600 {
                            lines.push(format!("- ~/{f} changed recently"));
                        }
                    }
                }
            }
        }
    }
    lines.join("\n")
}

/// First run: stop daemon, show report, require reboot.
pub fn run_no_reboot(data: &Path, _rebooted: bool) -> Result<String, String> {
    stop_daemon(data);
    let epoch = random_epoch()?;
    let record = TrustRecord { trusted: true, epoch: epoch.clone(), trusted_at_ms: now_ms(), boot_id: boot_id() };
    let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    let path = path_for(data);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, format!("{text}\n")).map_err(|e| format!("could not write trust record: {e}"))?;
    Ok(epoch)
}

/// `apex-daemon trust-host` implementation.
pub fn run(data: &Path, no_reboot: bool) -> Result<(), String> {
    println!("{}", inspection_report());
    // Stop daemon first per spec
    stop_daemon(data);
    if !no_reboot {
        if let Some(prev) = load(data) {
            if prev.trusted {
                if let (Some(prev_boot), Some(cur_boot)) = (prev.boot_id, boot_id()) {
                    if prev_boot == cur_boot {
                        println!("\nReboot first, then run trust-host again. Boot id unchanged.");
                        println!("Use --no-reboot if this account cannot reboot.");
                        return Err("reboot required".into());
                    }
                }
            }
        }
        if load(data).as_ref().map(|r| !r.trusted).unwrap_or(false) || load(data).is_none() {
            // If no record or pending non-trusted, save pending and ask reboot
            if load(data).is_none() {
                let pending = TrustRecord { trusted: false, epoch: String::new(), trusted_at_ms: now_ms(), boot_id: boot_id() };
                let text = serde_json::to_string_pretty(&pending).map_err(|e| e.to_string())?;
                std::fs::write(path_for(data), format!("{text}\n")).map_err(|e| e.to_string())?;
                println!("\nReboot this machine, then run `apex-daemon trust-host` again to finish trusting it.");
                return Ok(());
            }
        }
    }
    let _ = run_no_reboot(data, no_reboot)?;
    println!("\nTrusted this machine. Existing device records without the new epoch cannot act until paired again.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Tmp(std::path::PathBuf);
    impl Drop for Tmp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn tmp() -> Tmp {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("trust-host-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    #[test]
    fn trust_and_epoch_roundtrip() {
        let t = tmp();
        assert!(!is_trusted(&t.0));
        let epoch = run_no_reboot(&t.0, true).unwrap();
        assert!(is_trusted(&t.0));
        assert_eq!(epoch.len(), 64);
        assert_eq!(super::epoch(&t.0).unwrap(), epoch);
    }
    #[test]
    fn epoch_ignores_pending() {
        let t = tmp();
        // Save pending record with empty epoch and trusted=false
        let pending = TrustRecord { trusted: false, epoch: String::new(), trusted_at_ms: now_ms(), boot_id: None };
        let text = serde_json::to_string_pretty(&pending).unwrap();
        std::fs::write(path_for(&t.0), format!("{text}\n")).unwrap();
        assert!(super::epoch(&t.0).is_none(), "pending epoch must be ignored, not lock out");
        assert!(!is_trusted(&t.0));
    }
}
