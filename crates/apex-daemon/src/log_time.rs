//! Puts the local time in front of each line the daemon writes to stderr.
//! The LaunchAgent sends stderr straight to a log file, which has no times.
//! So when stderr is a regular file, it goes through a pipe, and a thread
//! copies each line out with the time in front. Pipes and terminals are left
//! alone, since the desktop app reads the daemon's stderr through a pipe.

use std::io::Write;

/// Adds `stamp` and a space in front of each line that starts in `chunk`.
/// `at_line_start` says whether the chunk begins a new line. Returns the
/// text and whether the next chunk begins a new line. A partial line is
/// written out at once, so nothing waits for its newline.
pub fn stamp_chunk(stamp: &str, chunk: &[u8], mut at_line_start: bool) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(chunk.len() + 32);
    for piece in chunk.split_inclusive(|b| *b == b'\n') {
        if at_line_start {
            out.extend_from_slice(stamp.as_bytes());
            out.push(b' ');
        }
        out.extend_from_slice(piece);
        at_line_start = piece.ends_with(b"\n");
    }
    (out, at_line_start)
}

/// "2026-10-08 15:42:06" from a broken-down local time.
#[cfg(unix)]
fn format_time(tm: &libc::tm) -> String {
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
}

/// The local time now.
#[cfg(unix)]
fn now_stamp() -> String {
    let now = unsafe { libc::time(std::ptr::null_mut()) };
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    format_time(&tm)
}

/// Whether `fd` is a regular file, such as a log file.
#[cfg(unix)]
fn is_regular_file(fd: libc::c_int) -> bool {
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    unsafe { libc::fstat(fd, &mut info) == 0 && info.st_mode & libc::S_IFMT == libc::S_IFREG }
}

/// The read end of the stderr pipe, for `flush`. -1 until `start` runs.
#[cfg(unix)]
static READER: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

/// Sends stderr through a pipe that stamps each line with the local time.
/// Only when stderr is a regular file (the LaunchAgent's log). Does nothing
/// when stderr is a terminal or pipe, or when `APEX_DECK_LOG_PLAIN=1` is set.
/// Write errors on the log file are ignored, so a missing log never stops
/// the daemon.
#[cfg(unix)]
pub fn start() {
    use std::os::fd::FromRawFd;
    use std::sync::atomic::Ordering;
    if std::env::var("APEX_DECK_LOG_PLAIN").is_ok_and(|v| v == "1") || !is_regular_file(2) {
        return;
    }
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    let original = unsafe { libc::dup(2) };
    if original < 0 {
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
        return;
    }
    unsafe {
        libc::dup2(fds[1], 2);
        libc::close(fds[1]);
    }
    READER.store(fds[0], Ordering::SeqCst);
    let mut out = unsafe { std::fs::File::from_raw_fd(original) };
    let mut input = unsafe { std::fs::File::from_raw_fd(fds[0]) };
    // Panics print through stderr too; wait for their lines before the
    // process ends.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        flush();
    }));
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 8192];
        let mut at_line_start = true;
        // This thread must outlive the daemon: if it stopped, a full pipe
        // would block every eprintln. So read errors only pause it.
        loop {
            match input.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let (text, next) = stamp_chunk(&now_stamp(), &buf[..n], at_line_start);
                    at_line_start = next;
                    let _ = out.write_all(&text);
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
    });
}

/// Waits, for at most half a second, until the lines already written to
/// stderr have been copied out. Call before the process exits.
#[cfg(unix)]
pub fn flush() {
    let fd = READER.load(std::sync::atomic::Ordering::SeqCst);
    if fd < 0 {
        return;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
    loop {
        let mut waiting: libc::c_int = 0;
        unsafe { libc::ioctl(fd, libc::FIONREAD, &mut waiting) };
        if waiting <= 0 || std::time::Instant::now() > deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // The copy thread may hold one more chunk; give it a moment.
    std::thread::sleep(std::time::Duration::from_millis(20));
}

#[cfg(not(unix))]
pub fn start() {}

#[cfg(not(unix))]
pub fn flush() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_line_gets_the_stamp_once() {
        let (text, next) = stamp_chunk("2026-10-08 15:42:06", b"one\ntwo\n", true);
        assert_eq!(String::from_utf8(text).unwrap(), "2026-10-08 15:42:06 one\n2026-10-08 15:42:06 two\n");
        assert!(next);
    }

    #[test]
    fn a_partial_line_goes_out_now_and_its_rest_is_not_stamped_again() {
        let (first, at_start) = stamp_chunk("T", b"no newline yet", true);
        assert_eq!(first, b"T no newline yet");
        assert!(!at_start);
        let (second, at_start) = stamp_chunk("T", b" and then\nnext", at_start);
        assert_eq!(second, b" and then\nT next");
        assert!(!at_start);
    }

    #[test]
    fn an_empty_read_changes_nothing() {
        assert_eq!(stamp_chunk("T", b"", false), (vec![], false));
        assert_eq!(stamp_chunk("T", b"", true), (vec![], true));
    }

    #[cfg(unix)]
    #[test]
    fn the_time_reads_as_year_month_day_then_clock() {
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        (tm.tm_year, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec) = (126, 9, 8, 15, 42, 6);
        assert_eq!(format_time(&tm), "2026-10-08 15:42:06");
    }
}
