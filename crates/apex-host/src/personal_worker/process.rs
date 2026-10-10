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

#[cfg(unix)]
fn kill_group(pgid: u32) {
    if let Ok(pgid) = libc::pid_t::try_from(pgid) {
        // SAFETY: plain syscall on a group checked above to be ours.
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
    }
}

#[cfg(not(unix))]
fn kill_group(_pgid: u32) {}

#[cfg(unix)]
fn own_group() -> Option<u32> {
    // SAFETY: plain syscall with no arguments.
    u32::try_from(unsafe { libc::getpgrp() }).ok()
}

#[cfg(not(unix))]
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

#[cfg(target_os = "macos")]
fn boot() -> String {
    String::new()
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn info(_pid: u32) -> Option<(u32, u64)> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn members(_pgid: u32) -> Vec<u32> {
    vec![]
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn boot() -> String {
    String::new()
}
