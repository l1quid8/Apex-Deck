#![cfg(target_os = "linux")]
use apex_provenance::linux::launch::ExecGuard;
use std::{
    process::Command,
    time::{Duration, Instant},
};

// Removing TRACECLONE/TRACEEXEC or continuing a second exec makes these fail:
// the forbidden image writes the marker before the guard can revoke it.
#[test]
fn initial_exec_runs_but_second_exec_cannot_execute_a_single_instruction() {
    let marker = format!("/tmp/apex-exec-guard-{}", std::process::id());
    let _ = std::fs::remove_file(&marker);
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        &format!("exec /bin/sh -c 'echo forbidden > {marker}'"),
    ]);
    let guard = ExecGuard::spawn(command).unwrap();
    let start = Instant::now();
    while guard.is_live() && start.elapsed() < Duration::from_secs(5) {
        std::thread::yield_now();
    }
    assert!(!guard.is_live(), "exec did not revoke the launch");
    assert!(
        !std::path::Path::new(&marker).exists(),
        "second image executed"
    );
}

#[test]
fn initial_exec_may_exit_normally_and_drop_kills_a_running_image() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "while :; do :; done"]);
    let guard = ExecGuard::spawn(command).unwrap();
    assert!(guard.is_live());
    let pid = guard.pid();
    drop(guard);
    let start = Instant::now();
    while std::path::Path::new(&format!("/proc/{pid}")).exists()
        && start.elapsed() < Duration::from_secs(5)
    {
        std::thread::yield_now();
    }
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
}

#[test]
fn a_nonleader_thread_exec_revokes_before_the_replacement_runs() {
    // The test binary execs itself from a spawned thread in a dedicated child.
    if std::env::var_os("APEX_EXEC_THREAD_CHILD").is_some() {
        std::thread::spawn(|| {
            use std::os::unix::process::CommandExt;
            let marker = std::env::var("APEX_EXEC_MARKER").unwrap();
            let _ = Command::new("/bin/sh")
                .args(["-c", &format!("echo forbidden > {marker}")])
                .exec();
        })
        .join()
        .unwrap();
        return;
    }
    let marker = format!("/tmp/apex-thread-exec-{}", std::process::id());
    let _ = std::fs::remove_file(&marker);
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "a_nonleader_thread_exec_revokes_before_the_replacement_runs",
            "--nocapture",
        ])
        .env("APEX_EXEC_THREAD_CHILD", "1")
        .env("APEX_EXEC_MARKER", &marker);
    let guard = ExecGuard::spawn(command).unwrap();
    let start = Instant::now();
    while guard.is_live() && start.elapsed() < Duration::from_secs(5) {
        std::thread::yield_now();
    }
    assert!(!guard.is_live());
    assert!(!std::path::Path::new(&marker).exists());
}

#[test]
fn dispatch_lease_serializes_revocation_before_replacement_continuation() {
    use std::{
        io::Write,
        os::{fd::OwnedFd, unix::net::UnixStream},
        process::Stdio,
    };
    let marker = format!("/tmp/apex-leased-exec-{}", std::process::id());
    let _ = std::fs::remove_file(&marker);
    let (mut trigger, input) = UnixStream::pair().unwrap();
    let input: OwnedFd = input.into();
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            &format!("read value; exec /bin/sh -c 'echo forbidden > {marker}'"),
        ])
        .stdin(Stdio::from(input));
    let guard = ExecGuard::spawn(command).unwrap();
    let lease = guard.lease().unwrap();
    trigger.write_all(b"go\n").unwrap();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(2) {
        if std::fs::read_to_string(format!("/proc/{}/status", guard.pid()))
            .unwrap_or_default()
            .lines()
            .any(|l| l.starts_with("State:") && l.contains("tracing stop"))
        {
            break;
        }
        std::thread::yield_now();
    }
    assert!(
        guard.is_live(),
        "dispatch lease was revoked during its transaction"
    );
    assert!(!std::path::Path::new(&marker).exists());
    drop(lease);
    let start = Instant::now();
    while guard.is_live() && start.elapsed() < Duration::from_secs(2) {
        std::thread::yield_now();
    }
    assert!(!guard.is_live());
    assert!(guard.lease().is_err());
    assert!(!std::path::Path::new(&marker).exists());
}

#[test]
fn tracer_death_kills_owned_image_and_descendants() {
    if let Some(marker) = std::env::var_os("APEX_TRACER_DEATH_MARKER") {
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            &format!("sleep 1; echo forbidden > {}", marker.to_string_lossy()),
        ]);
        let _guard = ExecGuard::spawn(command).unwrap();
        unsafe { libc::_exit(0) }
    }
    let marker = format!("/tmp/apex-tracer-death-{}", std::process::id());
    let _ = std::fs::remove_file(&marker);
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tracer_death_kills_owned_image_and_descendants",
            "--nocapture",
        ])
        .env("APEX_TRACER_DEATH_MARKER", &marker)
        .status()
        .unwrap();
    assert!(status.success());
    std::thread::sleep(Duration::from_millis(1200));
    assert!(
        !std::path::Path::new(&marker).exists(),
        "image survived its tracer"
    );
}

#[test]
fn clone_untraced_and_opaque_clone3_cannot_escape_exec_supervision() {
    if std::env::var_os("APEX_CLONE_ESCAPE_CHILD").is_some() {
        let result = unsafe {
            libc::syscall(
                libc::SYS_clone,
                (libc::CLONE_UNTRACED | libc::SIGCHLD) as libc::c_ulong,
                0,
                0,
                0,
                0,
            )
        };
        if result == 0 {
            unsafe { libc::_exit(44) }
        }
        assert_eq!(result, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        );
        let result = unsafe { libc::syscall(libc::SYS_clone3, std::ptr::null::<u8>(), 0) };
        assert_eq!(result, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ENOSYS)
        );
        std::fs::write(
            std::env::var("APEX_CLONE_ESCAPE_MARKER").unwrap(),
            b"denied",
        )
        .unwrap();
        return;
    }
    let marker = format!("/tmp/apex-clone-denied-{}", std::process::id());
    let _ = std::fs::remove_file(&marker);
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "clone_untraced_and_opaque_clone3_cannot_escape_exec_supervision",
            "--nocapture",
        ])
        .env("APEX_CLONE_ESCAPE_CHILD", "1")
        .env("APEX_CLONE_ESCAPE_MARKER", &marker);
    let guard = ExecGuard::spawn(command).unwrap();
    let start = Instant::now();
    while guard.is_live() && start.elapsed() < Duration::from_secs(3) {
        std::thread::yield_now();
    }
    assert_eq!(std::fs::read(&marker).unwrap(), b"denied");
    std::fs::remove_file(marker).unwrap();
}
