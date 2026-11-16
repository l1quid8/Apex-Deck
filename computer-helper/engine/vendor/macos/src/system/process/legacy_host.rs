//! Stops command hosts that earlier agent-desktop versions left running.

use std::mem::{MaybeUninit, size_of};

const HOST_MARKER: &[u8] = b"AGENT_DESKTOP_INTERNAL_COMMAND_HOST=1";
const PROC_UID_ONLY: u32 = 4;
const CS_OPS_IDENTITY: u32 = 11;
const IDENTITY_BUFFER_LEN: usize = 512;
const BLOB_HEADER_LEN: usize = 8;

unsafe extern "C" {
    fn csops(
        pid: libc::pid_t,
        ops: u32,
        useraddr: *mut libc::c_void,
        usersize: usize,
    ) -> libc::c_int;
}

/// Sends SIGKILL to this user's agent-desktop processes whose environment carries the old command
/// host marker. A process whose owner, start time, environment or code-signing identifier cannot be
/// read, or whose identifier is not agent-desktop's, is left alone.
pub fn stop_legacy_command_hosts() {
    let uid = unsafe { libc::geteuid() };
    let own_pid = std::process::id() as libc::pid_t;
    let Some(mut buffer) = argument_buffer() else {
        return;
    };
    for pid in user_processes(uid) {
        if pid <= 0 || pid == own_pid || !has_marker(pid, &mut buffer) {
            continue;
        }
        let Some(started_at) = process_start_time(pid, uid) else {
            continue;
        };
        if !is_agent_desktop(pid) {
            continue;
        }
        if has_marker(pid, &mut buffer) && process_start_time(pid, uid) == Some(started_at) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// Whether a `KERN_PROCARGS2` buffer carries the host marker in its environment,
/// skipping the executable path and arguments that precede it.
pub(crate) fn environment_has_marker(procargs: &[u8]) -> bool {
    let Some((count, rest)) = procargs.split_first_chunk::<4>() else {
        return false;
    };
    let arguments = i32::from_ne_bytes(*count);
    if arguments <= 0 {
        return false;
    }
    let Some(path_end) = rest.iter().position(|byte| *byte == 0) else {
        return false;
    };
    let rest = &rest[path_end + 1..];
    let Some(arguments_start) = rest.iter().position(|byte| *byte != 0) else {
        return false;
    };
    let mut rest = &rest[arguments_start..];
    for _ in 0..arguments {
        let Some(end) = rest.iter().position(|byte| *byte == 0) else {
            return false;
        };
        rest = &rest[end + 1..];
    }
    while let Some(end) = rest.iter().position(|byte| *byte == 0) {
        let entry = &rest[..end];
        if entry.is_empty() {
            break;
        }
        if entry == HOST_MARKER {
            return true;
        }
        rest = &rest[end + 1..];
    }
    false
}

/// Whether a `CS_OPS_IDENTITY` blob names an agent-desktop build: an 8-byte big-endian magic and
/// length header followed by the NUL-terminated identifier.
fn blob_names_agent_desktop(blob: &[u8]) -> bool {
    let Some(identifier) = blob.get(BLOB_HEADER_LEN..) else {
        return false;
    };
    let Some(end) = identifier.iter().position(|byte| *byte == 0) else {
        return false;
    };
    let identifier = &identifier[..end];
    identifier == b"agent-desktop" || identifier.starts_with(b"agent_desktop-")
}

fn is_agent_desktop(pid: libc::pid_t) -> bool {
    let mut blob = [0u8; IDENTITY_BUFFER_LEN];
    let read = unsafe { csops(pid, CS_OPS_IDENTITY, blob.as_mut_ptr().cast(), blob.len()) };
    read == 0 && blob_names_agent_desktop(&blob)
}

fn user_processes(uid: libc::uid_t) -> Vec<libc::pid_t> {
    let size = unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, std::ptr::null_mut(), 0) };
    let Ok(size) = usize::try_from(size) else {
        return Vec::new();
    };
    let mut pids = vec![0; size / size_of::<libc::pid_t>() + 1];
    loop {
        let Some(bytes) = pids.len().checked_mul(size_of::<libc::pid_t>()) else {
            return Vec::new();
        };
        let Ok(bytes) = i32::try_from(bytes) else {
            return Vec::new();
        };
        let written =
            unsafe { libc::proc_listpids(PROC_UID_ONLY, uid, pids.as_mut_ptr().cast(), bytes) };
        if written <= 0 {
            return Vec::new();
        }
        if written < bytes {
            pids.truncate(written as usize / size_of::<libc::pid_t>());
            return pids;
        }
        pids.resize(pids.len() * 2, 0);
    }
}

fn process_start_time(pid: libc::pid_t, uid: libc::uid_t) -> Option<(u64, u64)> {
    let info = process_info(pid)?;
    (info.pbi_pid == pid as u32 && info.pbi_uid == uid && info.pbi_status != libc::SZOMB)
        .then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
}

fn process_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    (read == size).then(|| unsafe { info.assume_init() })
}

fn argument_buffer() -> Option<Vec<u8>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut max: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut max as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 {
        return None;
    }
    usize::try_from(max)
        .ok()
        .filter(|max| *max > 0)
        .map(|max| vec![0u8; max])
}

fn has_marker(pid: libc::pid_t, buffer: &mut [u8]) -> bool {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = buffer.len();
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    read == 0 && size <= buffer.len() && environment_has_marker(&buffer[..size])
}

#[cfg(test)]
#[path = "legacy_host_tests.rs"]
mod tests;
