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
    // Pending trust supplies no epoch: Linux device authority stays disabled
    // until a changed boot ID or the explicit no-reboot decision grants it.
    let rec = load(data)?;
    if !rec.trusted { return None; }
    if rec.epoch.is_empty() { return None; }
    Some(rec.epoch)
}

/// Linux device authority always requires one complete, current trust record.
/// Callers decide platform scope; Mac/Windows do not use this Linux policy.
pub(crate) fn check_device_epoch(data: &Path, device: &crate::devices::Device) -> Result<(), String> {
    let current = epoch(data).ok_or_else(|| "this Linux machine is not trusted; run trust-host and pair this device again".to_string())?;
    if device.confined_epoch.as_deref() != Some(current.as_str()) {
        return Err("this device was paired before trust and must pair again".into());
    }
    Ok(())
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
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Stop only the owner of this exact data folder, then keep its lock until
/// trust is published. SIGTERM runs the daemon's bot/PTY wind-down; unlinking
/// the socket would leave established remote sessions and children alive.
fn stop_daemon(data: &Path) -> Result<apex_host::lock::DataLock, String> {
    use apex_host::lock::{DataLock, LockError};
    let owner = format!("apex-daemon trust-host (pid {})", std::process::id());
    let previous = match DataLock::acquire(data, &owner) {
        Ok(lock) => return Ok(lock),
        Err(LockError::Held { owner }) => owner,
        Err(error) => return Err(error.to_string()),
    };
    let pid = daemon_owner_pid(&previous)
        .ok_or_else(|| format!("cannot safely stop the owner of {}: {previous}", data.display()))?;
    if pid == std::process::id() {
        return Err("cannot reset trust from inside the running daemon".into());
    }
    #[cfg(unix)]
    {
        verify_daemon_owner(data, pid)?;
        let children = daemon_descendants(pid)?;
        // SAFETY: pid is a positive PID verified against this folder's live
        // owner lock, not a substring search across unrelated processes.
        if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
            return Err(format!("could not stop daemon {pid}: {}", std::io::Error::last_os_error()));
        }
        let deadline = std::time::Instant::now() + crate::signals::WIND_DOWN + std::time::Duration::from_secs(5);
        let mut lock = None;
        loop {
            if lock.is_none() {
                match DataLock::acquire(data, &owner) {
                    Ok(acquired) => lock = Some(acquired),
                    Err(LockError::Held { owner: current }) if current == previous => {},
                    Err(error) => return Err(format!("daemon did not release its data folder: {error}")),
                }
            }
            // Lock release alone does not prove process termination. The lock
            // remains held through wind_down, so acquiring it also waits for
            // the existing graceful bot/terminal cleanup path.
            if lock.is_some() && process_has_exited(pid)? {
                let mut children_exited = true;
                for child in &children {
                    if !process_has_exited(*child)? { children_exited = false; break; }
                }
                if children_exited { return Ok(lock.unwrap()); }
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!("daemon {pid} did not stop and release {} before the shutdown deadline; trust was not granted", data.display()));
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    #[cfg(not(unix))]
    Err("stop the running daemon before running trust-host on this platform".into())
}

fn daemon_owner_pid(owner: &str) -> Option<u32> {
    let value = owner.strip_prefix("apex-daemon serve (pid ")
        .or_else(|| owner.strip_prefix("apex-daemon --stdio (pid "))?
        .strip_suffix(')')?;
    let pid = value.parse::<u32>().ok()?;
    (pid > 1 && pid <= i32::MAX as u32).then_some(pid)
}

/// Check that a stale or hand-edited PID cannot target another data folder.
#[cfg(unix)]
fn verify_daemon_owner(data: &Path, pid: u32) -> Result<(), String> {
    let lock = std::fs::canonicalize(data.join(apex_host::lock::LOCK_FILE)).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    let (executable, holds_lock) = {
        use std::os::unix::fs::MetadataExt;
        let executable = std::fs::read_link(format!("/proc/{pid}/exe")).map_err(|e| format!("cannot verify daemon {pid}: {e}"))?;
        let expected = std::fs::metadata(&lock).map_err(|e| e.to_string())?;
        let entries = std::fs::read_dir(format!("/proc/{pid}/fd")).map_err(|e| format!("cannot verify daemon {pid}'s owner lock: {e}"))?;
        let holds_lock = entries.flatten().any(|entry| {
            std::fs::metadata(entry.path()).is_ok_and(|meta| meta.dev() == expected.dev() && meta.ino() == expected.ino())
        });
        (executable, holds_lock)
    };
    #[cfg(not(target_os = "linux"))]
    let (executable, holds_lock) = {
        let process = std::process::Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).output().map_err(|e| e.to_string())?;
        let executable = PathBuf::from(String::from_utf8_lossy(&process.stdout).trim());
        let open = std::process::Command::new("lsof").args(["-a", "-p", &pid.to_string(), "-Fn", "--"]).arg(&lock).output().map_err(|e| format!("cannot verify daemon's owner lock: {e}"))?;
        (executable, open.status.success())
    };
    let name = executable.file_name().and_then(|name| name.to_str());
    if !matches!(name, Some("apex-daemon" | "apex-daemon-fixture")) || !holds_lock {
        return Err(format!("refusing to signal {pid}: it is not the daemon owning {}", data.display()));
    }
    Ok(())
}

/// Read process ancestry, never signal by process-name or command substring.
/// Detached processes outside this tree are the reason normal trust requires
/// a reboot and --no-reboot explicitly warns about what may remain running.
#[cfg(unix)]
fn daemon_descendants(pid: u32) -> Result<Vec<u32>, String> {
    let table = std::process::Command::new("ps").args(["-axo", "pid=,ppid="]).output().map_err(|e| format!("cannot inspect daemon children: {e}"))?;
    if !table.status.success() { return Err("cannot inspect daemon children; trust was not granted".into()); }
    let entries: Vec<(u32, u32)> = String::from_utf8_lossy(&table.stdout).lines().filter_map(|line| {
        let mut fields = line.split_whitespace();
        Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
    }).collect();
    let mut tree = vec![pid];
    let mut cursor = 0;
    while cursor < tree.len() {
        let parent = tree[cursor];
        for &(child, ppid) in &entries {
            if ppid == parent && !tree.contains(&child) { tree.push(child); }
        }
        cursor += 1;
    }
    Ok(tree.into_iter().skip(1).collect())
}

#[cfg(unix)]
fn process_has_exited(pid: u32) -> Result<bool, String> {
    // SAFETY: signal zero only checks existence; it cannot stop a process.
    if unsafe { libc::kill(pid as i32, 0) } != 0 {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) { Ok(true) } else { Err(format!("cannot check process {pid}: {error}")) };
    }
    // A zombie has terminated and cannot act, even before its parent reaps it.
    let status = std::process::Command::new("ps").args(["-p", &pid.to_string(), "-o", "stat="]).output().map_err(|e| format!("cannot check process termination: {e}"))?;
    let state = String::from_utf8_lossy(&status.stdout);
    if !status.status.success() {
        // It may have exited between the existence check and ps. Any other
        // failure is an error rather than proof that the daemon stopped.
        return if unsafe { libc::kill(pid as i32, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { Ok(true) } else { Err(format!("cannot verify termination of process {pid}")) };
    }
    Ok(state.trim().starts_with('Z'))
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

fn save(data: &Path, record: &TrustRecord) -> Result<(), String> {
    let text = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    crate::files::write_private(&path_for(data), &format!("{text}\n"))
}

fn grant(data: &Path, boot_id: Option<String>) -> Result<String, String> {
    let epoch = random_epoch()?;
    save(data, &TrustRecord { trusted: true, epoch: epoch.clone(), trusted_at_ms: now_ms(), boot_id })?;
    Ok(epoch)
}

/// Explicit no-reboot decision: still waits for daemon/bot shutdown, but no
/// claim is made about detached programs outside the daemon.
pub fn run_no_reboot(data: &Path, _rebooted: bool) -> Result<String, String> {
    let _lock = stop_daemon(data)?;
    grant(data, boot_id())
}

/// `apex-daemon trust-host` implementation.
pub fn run(data: &Path, no_reboot: bool) -> Result<(), String> {
    run_with_boot_id(data, no_reboot, boot_id())
}

fn run_with_boot_id(data: &Path, no_reboot: bool, current_boot: Option<String>) -> Result<(), String> {
    let _lock = stop_daemon(data)?;
    println!("{}", inspection_report());
    if no_reboot {
        println!("\nNo reboot was performed. Programs already running outside the daemon may still be running.");
        grant(data, current_boot)?;
    } else {
        let previous = load(data);
        let pending = previous.as_ref().filter(|record| !record.trusted);
        let proved_reboot = pending.and_then(|record| record.boot_id.as_deref())
            .zip(current_boot.as_deref())
            .is_some_and(|(old, current)| !old.is_empty() && !current.is_empty() && old != current);
        if !proved_reboot {
            // Preserve the original boot baseline on repeat invocations. If a
            // previously unavailable boot ID becomes readable, record it as a
            // baseline now and require a subsequent, provable reboot.
            let baseline = pending.and_then(|record| record.boot_id.clone()).filter(|id| !id.is_empty()).or(current_boot);
            save(data, &TrustRecord { trusted: false, epoch: String::new(), trusted_at_ms: now_ms(), boot_id: baseline })?;
            println!("\nReboot this machine, then run `apex-daemon trust-host` again to finish trusting it.");
            println!("An unchanged or unavailable boot ID cannot prove a reboot. Use --no-reboot only if this account cannot reboot.");
            return if pending.is_some() { Err("reboot required; machine remains not trusted".into()) } else { Ok(()) };
        }
        grant(data, current_boot)?;
    }
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
    fn normal_trust_does_not_complete_on_a_second_run_without_reboot() {
        let t = tmp();
        run(&t.0, false).unwrap();
        assert!(!is_trusted(&t.0));
        let _ = run(&t.0, false);
        assert!(!is_trusted(&t.0), "same or unavailable boot ID must remain pending");
    }

    #[test]
    fn missing_previous_boot_id_does_not_authorize_normal_trust() {
        let t = tmp();
        let pending = TrustRecord { trusted: false, epoch: String::new(), trusted_at_ms: now_ms(), boot_id: None };
        std::fs::write(path_for(&t.0), serde_json::to_vec(&pending).unwrap()).unwrap();
        let _ = run(&t.0, false);
        assert!(!is_trusted(&t.0), "a missing boot ID cannot prove a reboot");
    }

    #[test]
    fn trust_refuses_an_unknown_lock_owner_without_removing_its_socket() {
        let t = tmp();
        let _lock = apex_host::lock::DataLock::acquire(&t.0, "some other application").unwrap();
        std::fs::write(t.0.join("daemon.sock"), "owned by another app").unwrap();
        assert!(run_no_reboot(&t.0, true).is_err(), "must refuse if owner cannot be stopped safely");
        assert!(!is_trusted(&t.0));
        assert_eq!(std::fs::read_to_string(t.0.join("daemon.sock")).unwrap(), "owned by another app");
    }

    #[test]
    fn normal_trust_requires_a_changed_readable_boot_id() {
        let t = tmp();
        run_with_boot_id(&t.0, false, Some("boot-one".into())).unwrap();
        assert!(!is_trusted(&t.0));
        for boot in [Some("boot-one".into()), None, Some(String::new())] {
            assert!(run_with_boot_id(&t.0, false, boot).is_err());
            let pending = load(&t.0).unwrap();
            assert!(!pending.trusted);
            assert!(pending.epoch.is_empty());
            assert_eq!(pending.boot_id.as_deref(), Some("boot-one"));
        }
        run_with_boot_id(&t.0, false, Some("boot-two".into())).unwrap();
        assert!(is_trusted(&t.0));
        assert_eq!(load(&t.0).unwrap().boot_id.as_deref(), Some("boot-two"));
    }

    #[test]
    fn newly_readable_boot_id_first_establishes_a_baseline() {
        let t = tmp();
        run_with_boot_id(&t.0, false, None).unwrap();
        assert!(run_with_boot_id(&t.0, false, Some("boot-one".into())).is_err());
        assert!(!is_trusted(&t.0));
        assert_eq!(load(&t.0).unwrap().boot_id.as_deref(), Some("boot-one"));
        run_with_boot_id(&t.0, false, Some("boot-two".into())).unwrap();
        assert!(is_trusted(&t.0));
    }

    #[test]
    fn resetting_previously_trusted_host_requires_a_new_reboot() {
        let t = tmp();
        run_with_boot_id(&t.0, true, Some("original-boot".into())).unwrap();
        run_with_boot_id(&t.0, false, Some("reset-boot".into())).unwrap();
        assert!(!is_trusted(&t.0));
        assert_eq!(load(&t.0).unwrap().boot_id.as_deref(), Some("reset-boot"));
        assert!(run_with_boot_id(&t.0, false, Some("reset-boot".into())).is_err());
        run_with_boot_id(&t.0, false, Some("after-reset".into())).unwrap();
        assert!(is_trusted(&t.0));
    }

    #[test]
    fn explicit_no_reboot_rotates_epoch_even_without_a_boot_id() {
        let t = tmp();
        run_with_boot_id(&t.0, false, None).unwrap();
        run_with_boot_id(&t.0, true, None).unwrap();
        let first = epoch(&t.0).unwrap();
        run_with_boot_id(&t.0, true, None).unwrap();
        assert_ne!(epoch(&t.0).unwrap(), first);
    }

    #[test]
    fn epoch_ignores_pending() {
        let t = tmp();
        // Save pending record with empty epoch and trusted=false
        let pending = TrustRecord { trusted: false, epoch: String::new(), trusted_at_ms: now_ms(), boot_id: None };
        let text = serde_json::to_string_pretty(&pending).unwrap();
        std::fs::write(path_for(&t.0), format!("{text}\n")).unwrap();
        assert!(super::epoch(&t.0).is_none(), "pending trust must not supply a usable epoch");
        assert!(!is_trusted(&t.0));
    }
}
