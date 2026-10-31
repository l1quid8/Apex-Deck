//! What the kernel really does with the jail. Runs only where
//! APEX_JAIL_KERNEL_TEST is set, so a missing bubblewrap can't pass quietly:
//! see tests/linux-jail/run.sh.
#![cfg(target_os = "linux")]

use apex_adapters::linux_jail::{channel, launch, paths, Bind, JailSpec, HOOK_PORT, PROXY_PORT};
use apex_adapters::{OwnedProcessChild as OwnedChild, OwnedProcessRegistry as Registry};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::runtime::Runtime;

const PROBE: &str = include_str!("../../../tests/linux-jail/probe.py");

fn wanted() -> bool { std::env::var_os("APEX_JAIL_KERNEL_TEST").is_some() }

/// The real daemon binary, so these run the real start-up too.
fn init() -> PathBuf { std::env::var_os("APEX_JAIL_INIT").expect("run.sh sets this").into() }

struct Echo;

#[async_trait::async_trait]
impl channel::Purposes for Echo {
    async fn proxy(&self, stream: UnixStream) { echo(stream, b"proxy:").await }
    async fn codex_hook(&self, stream: UnixStream) { echo(stream, b"hook:").await }
}

async fn echo(mut stream: UnixStream, label: &[u8]) {
    let mut seen = Vec::new();
    let _ = stream.read_to_end(&mut seen).await;
    let _ = stream.write_all(label).await;
    let _ = stream.write_all(&seen).await;
}

struct Tree { root: PathBuf, home: PathBuf, data: PathBuf, project: PathBuf }

fn tree(name: &str) -> Tree {
    let root = std::env::temp_dir().join(format!("apex-jail-kernel-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let data = home.join(".local/share/apex");
    let project = home.join("work/app");
    for folder in [home.join(".ssh"), data.join("jail-homes/r/b"), data.join("attachments"), project.clone()] {
        std::fs::create_dir_all(folder).unwrap();
    }
    std::fs::write(home.join(".ssh/id_ed25519"), "secret").unwrap();
    std::fs::write(data.join("gateway.token"), "secret").unwrap();
    std::fs::write(data.join("attachments/note.txt"), "shown").unwrap();
    std::fs::write(project.join("probe.py"), PROBE).unwrap();
    std::fs::write(project.join("marker"), "shown\n").unwrap();
    let root = root.canonicalize().unwrap();
    Tree { home: root.join("home"), data: root.join("home/.local/share/apex"), project: root.join("home/work/app"), root }
}

fn mounts() -> paths::Mounts { paths::Mounts::current().unwrap() }

fn run(tree: &Tree, writable: bool, folder: &Path) -> std::process::Output {
    let args = vec![tree.project.join("probe.py").display().to_string(), if writable { "edit" } else { "read" }.into(),
                    tree.home.display().to_string(), tree.data.display().to_string(), tree.project.display().to_string()];
    jail(tree, folder, writable, tree.project.clone(), "/usr/bin/python3", args)
}

fn spec(tree: &Tree, folder: &Path, writable: bool, cwd: PathBuf, program: &str, args: Vec<String>) -> JailSpec {
    JailSpec {
        program: program.into(),
        args,
        cwd,
        home: tree.home.clone(),
        private_home: tree.data.join("jail-homes/r/b"),
        folders: vec![Bind { source: folder.into(), target: folder.into(), writable }],
        read_only: vec!["/usr/local/bin".into()],
        protected: protected(tree),
        restored: vec![Bind { source: tree.data.join("attachments"), target: tree.data.join("attachments"), writable: false }],
        init: init(),
        path: "/usr/local/bin:/usr/bin:/bin".into(),
        provider_env: vec![],
        seccomp_fd: -1,
        control_fd: -1,
    }
}

fn start(spec: &JailSpec, stdin: Stdio) -> (OwnedChild, tokio::task::JoinHandle<()>) {
    let mut jailed = launch::jailed_command(spec, Path::new("/usr/bin/bwrap")).unwrap();
    jailed.command.stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::piped());
    let (child, control) = jailed.spawn(&Registry::default()).unwrap();
    (child, tokio::spawn(channel::serve(control, Arc::new(Echo))))
}

async fn finish(mut child: OwnedChild) -> std::process::Output {
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let (_, _, status) = tokio::join!(out.read_to_end(&mut stdout), err.read_to_end(&mut stderr), child.wait());
    std::process::Output { status: status.unwrap(), stdout, stderr }
}

fn jail(tree: &Tree, folder: &Path, writable: bool, cwd: PathBuf, program: &str, args: Vec<String>) -> std::process::Output {
    let spec = spec(tree, folder, writable, cwd, program, args);
    Runtime::new().unwrap().block_on(async { finish(start(&spec, Stdio::null()).0).await })
}

/// `sh -c script` in a jail on the tree's project.
fn shell(tree: &Tree, script: &str) -> JailSpec {
    spec(tree, &tree.project, true, tree.project.clone(), "/bin/sh", vec!["-c".into(), script.into()])
}

/// Processes with exactly this command line, seen from outside the jail.
fn running(words: &[&str]) -> usize {
    let wanted: Vec<u8> = words.iter().flat_map(|word| [word.as_bytes(), b"\0"].concat()).collect();
    std::fs::read_dir("/proc").unwrap().flatten()
        .filter(|entry| std::fs::read(entry.path().join("cmdline")).is_ok_and(|line| line == wanted))
        .filter(|entry| !std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default().contains(") Z "))
        .count()
}

async fn until(what: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !what() {
        assert!(Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn ended(serve: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(10), serve).await.expect("the channel outlived the jail").unwrap();
}

fn expect(output: std::process::Output) {
    let (out, err) = (String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success() && out.contains("ALL PASSED"), "status {:?}\n{out}\n{err}", output.status);
}

/// The registry's start gate execs for itself, so this has to go through it.
#[test]
fn only_the_allowlist_reaches_a_bot_through_the_start_gate() {
    if !wanted() { return; }
    let tree = tree("environment");
    let spec = spec(&tree, &tree.project, true, tree.project.clone(), "/usr/bin/env", vec![]);
    let registry = Registry::new(Some(tree.root.join("workers")));
    let output = Runtime::new().unwrap().block_on(async {
        let mut jailed = launch::jailed_command(&spec, Path::new("/usr/bin/bwrap")).unwrap();
        jailed.command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (child, control) = jailed.spawn(&registry).unwrap();
        let serve = tokio::spawn(channel::serve(control, Arc::new(Echo)));
        let output = finish(child).await;
        ended(serve).await;
        output
    });
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let out = String::from_utf8_lossy(&output.stdout);
    let mut seen: Vec<&str> = out.lines().filter_map(|line| line.split('=').next()).collect();
    let allowed = apex_adapters::linux_jail::jail_env(&spec);
    // bubblewrap sets PWD itself after it changes folder.
    let mut wanted: Vec<&str> = allowed.iter().map(|(name, _)| name.as_str()).chain(["PWD"]).collect();
    seen.sort();
    wanted.sort();
    assert_eq!(seen, wanted, "{out}");
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn edit_level_jail_holds() {
    if !wanted() { return; }
    let tree = tree("edit");
    expect(run(&tree, true, &tree.project));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn read_level_jail_holds() {
    if !wanted() { return; }
    let tree = tree("read");
    expect(run(&tree, false, &tree.project));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_read_folder_around_home_is_refused() {
    if !wanted() { return; }
    let tree = tree("around");
    assert!(paths::check_read(&tree.home, &protected(&tree), &mounts()).is_err());
    assert!(paths::check_read(&tree.root, &protected(&tree), &mounts()).is_err());
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_login_made_after_launch_stays_out_of_a_running_jail() {
    if !wanted() { return; }
    let tree = tree("later");
    let file = tree.home.join(".aws/credentials");
    let login = {
        let file = file.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, "secret").unwrap();
        })
    };
    let script = format!("sleep 1; cat \"{}\" 2>/dev/null; cat marker; echo done", file.display());
    let output = jail(&tree, &tree.project, false, tree.project.clone(), "/bin/sh", vec!["-c".into(), script]);
    login.join().unwrap();
    assert!(file.exists());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "shown\ndone\n");
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_second_mount_of_home_is_refused() {
    if !wanted() { return; }
    let tree = tree("mount");
    let second = tree.root.join("second");
    mount(&tree.home, &second);
    let table = mounts();
    let read = paths::check_read(&second, &protected(&tree), &table);
    let missing = paths::check_read(&second, &[tree.home.join(".aws")], &table);
    let writable = paths::check_writable(&second, &guard(&tree), &table);
    let inside = paths::check_writable(&second.join(".ssh"), &guard(&tree), &table);
    unmount(&second);
    assert!(read.is_err() && missing.is_err() && writable.is_err() && inside.is_err());
    let _ = std::fs::remove_dir_all(&tree.root);
}

fn mount(source: &Path, at: &Path) {
    std::fs::create_dir_all(at).unwrap();
    assert!(Command::new("mount").args(["--bind"]).arg(source).arg(at).status().unwrap().success());
}

fn unmount(at: &Path) { assert!(Command::new("umount").arg(at).status().unwrap().success()); }

fn protected(tree: &Tree) -> Vec<PathBuf> { paths::standard_protected(&tree.home, &tree.data) }

fn guard(tree: &Tree) -> paths::Guard {
    paths::Guard { home: tree.home.clone(), protected: protected(tree), ..Default::default() }
}

#[test]
fn a_data_folder_mounted_inside_a_project_is_refused() {
    if !wanted() { return; }
    let tree = tree("nested");
    let nested = tree.project.join("nested");
    mount(&tree.data, &nested);
    let table = mounts();
    let read = paths::check_read(&tree.project, &protected(&tree), &table);
    let writable = paths::check_writable(&tree.project, &guard(&tree), &table);
    unmount(&nested);
    assert!(read.is_err() && writable.is_err());
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_folder_around_the_source_of_home_is_refused() {
    if !wanted() { return; }
    let source = tree("source");
    // A home that lives elsewhere: the tree's root is no ancestor of it by name.
    let alias = std::env::temp_dir().canonicalize().unwrap().join(format!("apex-jail-alias-{}", std::process::id()));
    mount(&source.home, &alias);
    let data = alias.join(".local/share/apex");
    let guard = paths::Guard { home: alias.clone(), protected: paths::standard_protected(&alias, &data), ..Default::default() };
    let table = mounts();
    let read = paths::check_read(&source.root, &guard.protected, &table);
    let writable = paths::check_writable(&source.root, &guard, &table);
    unmount(&alias);
    let _ = std::fs::remove_dir(&alias);
    assert!(read.is_err() && writable.is_err());
    let _ = std::fs::remove_dir_all(&source.root);
}

#[test]
fn a_second_view_of_a_mount_inside_a_protected_folder_is_refused() {
    if !wanted() { return; }
    let tree = tree("inner");
    let keys = tree.home.join(".ssh/keys");
    std::fs::create_dir(&keys).unwrap();
    assert!(Command::new("mount").args(["-t", "tmpfs", "tmpfs"]).arg(&keys).status().unwrap().success());
    let alias = tree.project.join("alias");
    mount(&keys, &alias);
    let table = mounts();
    let read = paths::check_read(&tree.project, &protected(&tree), &table);
    let writable = paths::check_writable(&tree.project, &guard(&tree), &table);
    unmount(&alias);
    unmount(&keys);
    assert!(read.is_err() && writable.is_err());
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_project_that_is_its_own_mount_under_home_still_works() {
    if !wanted() { return; }
    let tree = tree("own");
    let disk = tree.root.join("disk");
    let code = tree.home.join("code");
    mount(&disk_folder(&disk), &code);
    let allowed = paths::check_writable(&code, &guard(&tree), &mounts());
    unmount(&code);
    assert_eq!(allowed, Ok(code));
    let _ = std::fs::remove_dir_all(&tree.root);
}

fn disk_folder(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    path.to_path_buf()
}

#[test]
fn the_bot_holds_only_stdio_and_no_process_shows_it_a_socket() {
    if !wanted() { return; }
    let tree = tree("fds");
    // The forwarder would show its control socket here if it could be read.
    let script = r#"
import glob, os
print(sorted(f for f in map(int, os.listdir("/proc/self/fd")) if os.path.exists(f"/proc/self/fd/{f}")))
links = []
for fd in glob.glob("/proc/[0-9]*/fd/*"):
    try: links.append(os.readlink(fd))
    except OSError: pass
print([l for l in links if l.startswith("socket:")])
print(len(glob.glob("/proc/[0-9]*")) >= 3)
"#;
    let output = jail(&tree, &tree.project, true, tree.project.clone(), "/usr/bin/python3", vec!["-c".into(), script.into()]);
    assert_eq!(String::from_utf8_lossy(&output.stdout), "[0, 1, 2]\n[]\nTrue\n", "{}", String::from_utf8_lossy(&output.stderr));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_file_the_daemon_leaked_stops_at_the_jail_door() {
    if !wanted() { return; }
    let tree = tree("leak");
    let secret = std::fs::File::open(tree.data.join("gateway.token")).unwrap();
    let leaked = std::os::fd::AsRawFd::as_raw_fd(&secret);
    let script = r#"import os; print(sorted(f for f in map(int, os.listdir("/proc/self/fd")) if os.path.exists(f"/proc/self/fd/{f}")))"#;
    let spec = spec(&tree, &tree.project, true, tree.project.clone(), "/usr/bin/python3", vec!["-c".into(), script.into()]);
    let output = Runtime::new().unwrap().block_on(async {
        let mut jailed = launch::jailed_command(&spec, Path::new("/usr/bin/bwrap")).unwrap();
        jailed.command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        unsafe {
            jailed.command.pre_exec(move || {
                if libc::fcntl(leaked, libc::F_SETFD, 0) < 0 { return Err(std::io::Error::last_os_error()); }
                Ok(())
            });
        }
        let (child, control) = jailed.spawn(&Registry::default()).unwrap();
        tokio::spawn(channel::serve(control, Arc::new(Echo)));
        finish(child).await
    });
    assert_eq!(String::from_utf8_lossy(&output.stdout), "[0, 1, 2]\n", "{}", String::from_utf8_lossy(&output.stderr));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_forwarder_passes_bytes_under_the_filter_on_each_port() {
    if !wanted() { return; }
    let tree = tree("forward");
    let script = format!(r#"
import socket
for port, words in (({PROXY_PORT}, b"hello"), ({HOOK_PORT}, b"there"), ({PROXY_PORT}, b"again" * 100000)):
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    s.sendall(words); s.shutdown(socket.SHUT_WR)
    got = b""
    while (more := s.recv(65536)): got += more
    print(got[:16], len(got))
"#);
    let output = jail(&tree, &tree.project, true, tree.project.clone(), "/usr/bin/python3", vec!["-c".into(), script]);
    assert_eq!(String::from_utf8_lossy(&output.stdout),
        "b'proxy:hello' 11\nb'hook:there' 10\nb'proxy:againagain' 500006\n", "{}", String::from_utf8_lossy(&output.stderr));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn group_stop_ends_the_bot_and_everything_that_tried_to_leave() {
    if !wanted() { return; }
    let tree = tree("stop");
    let script = "setsid sleep 3101 & (sleep 3102 &) ; setsid sh -c '(sleep 3103 &)'; exec sleep 3100";
    Runtime::new().unwrap().block_on(async {
        let (mut child, serve) = start(&shell(&tree, script), Stdio::null());
        let all = [["sleep", "3100"], ["sleep", "3101"], ["sleep", "3102"], ["sleep", "3103"]];
        until(|| all.iter().all(|words| running(words) == 1)).await;
        child.terminate_tree().await.unwrap();
        until(|| all.iter().all(|words| running(words) == 0)).await;
        ended(serve).await;
    });
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_bot_exit_ends_the_jail_with_its_status() {
    if !wanted() { return; }
    let tree = tree("exit");
    Runtime::new().unwrap().block_on(async {
        let (child, serve) = start(&shell(&tree, "sleep 3104 & exit 7"), Stdio::null());
        let output = tokio::time::timeout(Duration::from_secs(10), finish(child)).await.expect("the jail outlived the bot");
        assert_eq!(output.status.code(), Some(7), "{}", String::from_utf8_lossy(&output.stderr));
        until(|| running(&["sleep", "3104"]) == 0).await;
        ended(serve).await;
    });
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_jail_killed_while_starting_leaves_nothing() {
    if !wanted() { return; }
    let tree = tree("starting");
    Runtime::new().unwrap().block_on(async {
        for delay in 0..30 {
            let (mut child, serve) = start(&shell(&tree, "exec sleep 3105"), Stdio::null());
            tokio::time::sleep(Duration::from_millis(delay)).await;
            child.terminate_tree().await.unwrap();
            ended(serve).await;
            until(|| running(&["sleep", "3105"]) == 0).await;
        }
    });
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_bad_launch_never_runs_the_bot_or_outlives_its_failure() {
    if !wanted() { return; }
    let tree = tree("noprogram");
    let spec = spec(&tree, &tree.project, true, tree.project.clone(), "/no/such/program", vec![]);
    let output = Runtime::new().unwrap().block_on(async { finish(start(&spec, Stdio::null()).0).await });
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("could not start the bot"));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_bot_can_not_type_into_a_terminal_it_inherits() {
    if !wanted() { return; }
    let tree = tree("tty");
    let (mut main, mut side) = (-1, -1);
    assert_eq!(unsafe { libc::openpty(&mut main, &mut side, std::ptr::null_mut(), std::ptr::null(), std::ptr::null()) }, 0);
    let side = unsafe { <std::os::fd::OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(side) };
    let script = r#"
import fcntl, os, termios
print(os.isatty(0))
for name, try_it in (("TIOCSTI", lambda: fcntl.ioctl(0, termios.TIOCSTI, b"x")), ("/dev/tty", lambda: open("/dev/tty"))):
    try: try_it(); print(name, "worked")
    except OSError as e: print(name, "refused")
"#;
    let spec = spec(&tree, &tree.project, true, tree.project.clone(), "/usr/bin/python3", vec!["-c".into(), script.into()]);
    let output = Runtime::new().unwrap().block_on(async { finish(start(&spec, Stdio::from(side)).0).await });
    assert_eq!(String::from_utf8_lossy(&output.stdout), "True\nTIOCSTI refused\n/dev/tty refused\n", "{}", String::from_utf8_lossy(&output.stderr));
    unsafe { libc::close(main) };
    let _ = std::fs::remove_dir_all(&tree.root);
}
