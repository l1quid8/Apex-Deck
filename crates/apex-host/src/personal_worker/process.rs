//! Finding and stopping a command's process group after the service that
//! started it is gone. Each command runs as the leader of its own group, so
//! the group id is the leader's pid. A group is only ours if its leader is
//! the process we started (same start time), or, once the leader has exited,
//! if everything left in it started no earlier than our leader did.

use crate::personal::ProcessMark;

/// What recovery found for one saved process group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Leftover {
    /// Nothing from the group was still running.
    Gone,
    /// The group was still running and has been killed.
    Stopped,
    /// Something holds that id, but it isn't the command we started.
    NotOurs,
}

/// The mark for a process we just spawned as its own group's leader.
pub(crate) fn mark(pid: u32) -> Option<ProcessMark> {
    let (pgid, started) = info(pid)?;
    (pgid == pid).then(|| ProcessMark { pgid, started, boot: boot() })
}

/// Kill the saved group if what's running under that id is still ours.
pub(crate) fn stop_leftover(mark: &ProcessMark) -> Leftover {
    #[cfg(windows)]
    { return windows_leftover(mark); }
    #[cfg(not(windows))]
    {
    // Never touch init, the whole session, or this service's own group.
    if mark.pgid <= 1 || Some(mark.pgid) == own_group() {
        return Leftover::NotOurs;
    }
    // A reboot ended everything the old service started.
    if mark.boot != boot() {
        return Leftover::Gone;
    }
    let members = members(mark.pgid);
    if members.is_empty() {
        return Leftover::Gone;
    }
    let ours = match info(mark.pgid) {
        // The leader is alive: it must be the very process we started.
        Some((pgid, started)) => pgid == mark.pgid && started == mark.started,
        // The leader exited and left children behind. A reused group would
        // need a new leader with this pid, so check every member's start.
        None => members.iter().all(|pid| info(*pid).is_some_and(|(pgid, started)| pgid == mark.pgid && started >= mark.started)),
    };
    if !ours {
        return Leftover::NotOurs;
    }
    kill_group(mark.pgid);
    Leftover::Stopped
    }
}

// Windows Jobs are closed by the OS when the owner dies. Recovery never
// signals a bare PID: a reused PID cannot prove ownership of a Job or its
// descendants. FILETIME creation identity distinguishes a reused process.
#[cfg(windows)]
fn windows_leftover(mark: &ProcessMark) -> Leftover {
    if mark.pgid <= 1 || mark.boot != boot() { return Leftover::NotOurs; }
    match windows_started(mark.pgid) {
        Ok(None) => Leftover::Gone,
        Ok(Some(started)) if started != mark.started => Leftover::Gone,
        Ok(Some(_)) | Err(_) => Leftover::NotOurs,
    }
}

#[cfg(windows)]
fn windows_started(pid: u32) -> std::io::Result<Option<u64>> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, FILETIME, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, GetProcessTimes, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
    if raw.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) { Ok(None) } else { Err(error) };
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
    if unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) } == WAIT_OBJECT_0 { return Ok(None); }
    let mut times = [FILETIME::default(); 4];
    let [created, exited, kernel, user] = &mut times;
    if unsafe { GetProcessTimes(handle.as_raw_handle().cast(), created, exited, kernel, user) } == 0 { return Err(std::io::Error::last_os_error()); }
    Ok(Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)))
}

#[cfg(windows)]
fn info(pid: u32) -> Option<(u32, u64)> { windows_started(pid).ok().flatten().map(|started| (pid, started)) }

#[cfg(windows)]
fn boot() -> String { "windows-job-v1".into() }

#[cfg(unix)]
fn kill_group(pgid: u32) {
    if let Ok(pgid) = libc::pid_t::try_from(pgid) {
        // SAFETY: plain syscall on a group checked above to be ours.
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    }
}

#[cfg(not(any(unix, windows)))]
fn kill_group(_pgid: u32) {}

#[cfg(unix)]
fn own_group() -> Option<u32> {
    // SAFETY: plain syscall with no arguments.
    u32::try_from(unsafe { libc::getpgrp() }).ok()
}

#[cfg(not(any(unix, windows)))]
fn own_group() -> Option<u32> {
    None
}

/// `(group id, start time)` for a live process.
#[cfg(target_os = "macos")]
fn info(pid: u32) -> Option<(u32, u64)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is a zeroed `proc_bsdinfo` of exactly `size` bytes.
    let got = unsafe { libc::proc_pidinfo(libc::c_int::try_from(pid).ok()?, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (got == size).then(|| (info.pbi_pgid, info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec))
}

/// `<sys/proc_info.h>`; not exported by the `libc` crate.
#[cfg(target_os = "macos")]
const PROC_PGRP_ONLY: u32 = 2;

#[cfg(target_os = "macos")]
fn members(pgid: u32) -> Vec<u32> {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else { return vec![] };
    let mut pids = vec![0 as libc::pid_t; 4096];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    // `proc_listpids` returns bytes; `proc_listpgrppids` returns a count.
    // SAFETY: the buffer holds `bytes` bytes of pids.
    let got = unsafe { libc::proc_listpids(PROC_PGRP_ONLY, pgid as u32, pids.as_mut_ptr().cast(), bytes) };
    let count = usize::try_from(got).unwrap_or(0) / std::mem::size_of::<libc::pid_t>();
    pids.into_iter().take(count).filter_map(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0).collect()
}

/// When this Mac booted, so a reboot is told apart from a reused id.
#[cfg(target_os = "macos")]
fn boot() -> String {
    let mut time = libc::timeval { tv_sec: 0, tv_usec: 0 };
    let mut size = std::mem::size_of::<libc::timeval>();
    // SAFETY: the name is NUL-terminated and the buffer is a timeval of `size` bytes.
    let ok = unsafe { libc::sysctlbyname(c"kern.boottime".as_ptr(), (&raw mut time).cast(), &mut size, std::ptr::null_mut(), 0) } == 0;
    if ok { format!("{}.{}", time.tv_sec, time.tv_usec) } else { String::new() }
}

/// `(group id, start time)` from `/proc/<pid>/stat`: fields 5 and 22.
#[cfg(target_os = "linux")]
fn info(pid: u32) -> Option<(u32, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name in field 2 may hold spaces and ')', so start after the last ')'.
    let fields: Vec<&str> = stat.get(stat.rfind(')')? + 1..)?.split_whitespace().collect();
    Some((fields.get(2)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

#[cfg(target_os = "linux")]
fn members(pgid: u32) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return vec![] };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| info(*pid).is_some_and(|(group, _)| group == pgid))
        .collect()
}

#[cfg(target_os = "linux")]
fn boot() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id").map(|id| id.trim().to_owned()).unwrap_or_default()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn info(_pid: u32) -> Option<(u32, u64)> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn members(_pgid: u32) -> Vec<u32> {
    vec![]
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn boot() -> String {
    String::new()
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn recovery_never_signals_a_live_or_reused_process_id() {
        let mark = mark(std::process::id()).unwrap();
        assert_eq!(stop_leftover(&mark), Leftover::NotOurs);
        let reused = ProcessMark { started: mark.started + 1, ..mark };
        assert_eq!(stop_leftover(&reused), Leftover::Gone);
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn command_tree() {
        let _child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "personal_worker::process::windows_tests::command_leaf"])
            .spawn().unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn command_leaf() {
        std::fs::write("child-pid", std::process::id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    #[tokio::test]
    async fn cancelling_personal_command_kills_its_windows_descendant() {
        use crate::personal::{OperationSpec, ProcessMark};
        use crate::personal_worker::{run_command, COMMAND_TOOL};
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::sync::{Arc, Mutex};
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

        let dir = std::env::temp_dir().join(format!("apx-personal-job-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("child-pid"));
        let spec = OperationSpec { tool: COMMAND_TOOL.into(), host: "test".into(), cwd: dir.to_string_lossy().into(),
            argv: vec![std::env::current_exe().unwrap().to_string_lossy().into(), "--ignored".into(), "--exact".into(),
                "personal_worker::process::windows_tests::command_tree".into()], plan: None };
        let saved = Arc::new(Mutex::new(None::<ProcessMark>));
        let callback = saved.clone();
        let running = tokio::spawn(run_command(spec, Arc::new(move |mark| *callback.lock().unwrap() = Some(mark))));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(dir.join("child-pid")).ok().and_then(|text| text.parse::<u32>().ok()) { break pid; }
            if std::time::Instant::now() >= deadline {
                running.abort();
                panic!("personal command's child did not start");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!raw.is_null(), "descendant must be alive before cancellation");
        let handle = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        assert!(saved.lock().unwrap().is_some(), "Windows command identity is recorded");
        running.abort();
        let _ = running.await;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) } != WAIT_OBJECT_0 {
            assert!(std::time::Instant::now() < deadline, "descendant survived cancellation");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
