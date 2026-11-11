//! What the kernel really does with the jail. Runs only where
//! APEX_JAIL_KERNEL_TEST is set, so a missing bubblewrap can't pass quietly:
//! see tests/linux-jail/run.sh.
#![cfg(target_os = "linux")]

use apex_adapters::linux_jail::{channel, home, launch, paths, probe, proxy, refresh, Bind, JailSpec, HOOK_PORT, PROXY_PORT};
use apex_core::{AgentTool, Backend};
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
        writable: Vec::new(),
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
fn retiring_setsid_loop_and_double_fork_child_on_level_downgrade() {
    if !wanted() { return; }
    let tree = tree("retire");
    let script = "setsid sh -c 'while true; do sleep 1; done' & (sh -c '(sleep 3202 &)' &); exec sleep 3200";
    Runtime::new().unwrap().block_on(async {
        let (mut child, serve) = start(&shell(&tree, script), Stdio::null());
        until(|| running(&["sleep", "3200"]) >= 1).await;
        child.terminate_tree().await.unwrap();
        until(|| running(&["sleep", "3200"]) == 0 && running(&["sleep", "3202"]) == 0).await;
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
    assert!(String::from_utf8_lossy(&output.stderr).contains("could not start the agent"));
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

fn values(cwd: &Path, host_home: &Path) -> home::HomeValues {
    home::HomeValues { cwd: cwd.display().to_string(), effort: None, host: home::HostPaths {
        claude_dir: host_home.join(".claude"), claude_json: host_home.join(".claude.json"), codex_dir: host_home.join(".codex"),
        gemini_dir: host_home.join(".gemini"), grok_dir: host_home.join(".grok"), muse_auth: host_home.join(".config/muse/auth.json"),
    }}
}

fn agent(tool: AgentTool) -> Backend { Backend::Agent { tool, model: None } }

#[test]
fn claude_and_codex_start_on_a_generated_home_and_see_nothing_of_the_hosts() {
    if !wanted() { return; }
    let tree = tree("generated");
    std::fs::create_dir_all(tree.home.join(".claude")).unwrap();
    std::fs::create_dir_all(tree.home.join(".codex")).unwrap();
    std::fs::write(tree.home.join(".claude.json"), r#"{"marker":"HOST-ONLY"}"#).unwrap();
    std::fs::write(tree.home.join(".claude/settings.json"), r#"{"hooks":"HOST-ONLY"}"#).unwrap();
    std::fs::write(tree.home.join(".codex/config.toml"), "notify = [\"HOST-ONLY\"]\n").unwrap();
    let values = values(&tree.project, &tree.home);
    for (tool, program, files) in [(AgentTool::ClaudeCode, "claude", "~/.claude.json ~/.claude/settings.json"), (AgentTool::Codex, "codex", "~/.codex/config.toml")] {
        let made = home::prepare(&tree.data, "r", program, &agent(tool), &values).unwrap();
        made.check(&mounts()).unwrap();
        let mut spec = shell(&tree, &format!("{program} --version && cat {files} && test ! -e ~/.ssh && test ! -e {} && echo ALL PASSED", made.path().display()));
        spec.private_home = made.path().into();
        let output = Runtime::new().unwrap().block_on(async { finish(start(&spec, Stdio::null()).0).await });
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(!text.contains("HOST-ONLY"), "{text}");
        expect(output);
    }
}

struct Web;

#[async_trait::async_trait]
impl channel::Purposes for Web {
    async fn proxy(&self, stream: UnixStream) { proxy::serve(stream, &proxy::Internet::default()).await }
    async fn codex_hook(&self, _: UnixStream) {}
}

/// One real turn through the real proxy. Returns once the jail has ended.
fn turn(tree: &Tree, made: &home::JailHome, program: &str, args: Vec<String>) {
    let mut spec = spec(tree, &tree.project, true, tree.project.clone(), program, args);
    spec.private_home = made.path().into();
    spec.provider_env = made.env().to_vec();
    let output = Runtime::new().unwrap().block_on(async {
        let mut jailed = launch::jailed_command(&spec, Path::new("/usr/bin/bwrap")).unwrap();
        jailed.command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (child, control) = jailed.spawn(&Registry::default()).unwrap();
        let serve = tokio::spawn(channel::serve(control, Arc::new(Web)));
        let output = tokio::time::timeout(Duration::from_secs(240), finish(child)).await.expect("the turn hung");
        ended(serve).await;
        output
    });
    let (out, err) = (String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "{program}: {:?}\n{out}\n{err}", output.status);
}

/// Run by tests/linux-jail/signed-in.sh, after a person signed in as this user.
/// A bot works from an access-only copy of Deck's login, which stays exactly as it
/// was: nothing in the jail can refresh it or write to it. The script moved the
/// logins into Deck's folder, so the person's own files aren't there to fall on.
#[test]
fn signed_in_turns_run_on_access_only_logins() {
    if std::env::var_os("APEX_JAIL_SIGNED_IN").is_none() { return; }
    let user = PathBuf::from(std::env::var_os("HOME").unwrap());
    let data = user.join(".local/share/apex");
    let project = user.join("proj");
    std::fs::create_dir_all(data.join("attachments")).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    let tree = Tree { root: user.clone(), home: user.clone(), data, project: project.clone() };
    let values = values(&project, &user);
    let ask = "Run this exact shell command, then reply with only the word finished: echo signed-in > ";
    let claude = vec!["-p".to_string(), format!("{ask}claude.txt"), "--permission-mode".into(), "acceptEdits".into(), "--allowedTools".into(), "Bash".into()];
    let codex = vec!["exec".to_string(), "--skip-git-repo-check".into(), "--sandbox".into(), "workspace-write".into(), format!("{ask}codex.txt")];
    let runs = [(AgentTool::ClaudeCode, "/usr/local/bin/claude", claude, "claude", ".claude/.credentials.json", "claude.txt"),
        (AgentTool::Codex, "/usr/local/bin/codex", codex, "codex", ".codex/auth.json", "codex.txt")];
    for (tool, program, args, provider, login, file) in runs {
        assert!(!user.join(login).exists(), "the person's {login} is still there");
        let _ = std::fs::remove_file(project.join(file));
        let deck = home::login_home(&tree.data, provider).join(login);
        let host = std::fs::read(&deck).unwrap();
        let made = home::prepare(&tree.data, "r", file, &agent(tool), &values).unwrap();
        let staged = std::fs::read_to_string(made.path().join(login)).unwrap();
        assert!(!staged.contains("refreshToken") && staged.matches("refresh_token\":\"\"").count() == staged.matches("refresh_token").count(), "{login} went in with a refresh token");
        turn(&tree, &made, program, args);
        assert_eq!(std::fs::read_to_string(project.join(file)).unwrap().trim(), "signed-in", "{file}");
        assert_eq!(std::fs::read(&deck).unwrap(), host, "{login} changed in Deck's folder");
    }
    println!("SIGNED-IN TURNS PASSED");
}

/// Makes a real login look nearly expired, leaving its refresh token alone.
fn nearly_expired(path: &Path, tool: AgentTool) {
    use base64::Engine;
    let mut doc: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let soon = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 60;
    match tool {
        AgentTool::ClaudeCode => doc["claudeAiOauth"]["expiresAt"] = (soon * 1000).into(),
        _ => {
            let claims = serde_json::json!({"exp": soon}).to_string();
            doc["tokens"]["access_token"] = format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims)).into();
        }
    }
    std::fs::write(path, doc.to_string()).unwrap();
}

/// Run by tests/linux-jail/signed-in.sh. Nobody prompts this refresh: the daemon
/// sees a login a launch would refuse, renews it outside the jail, and a real
/// turn then works on the new one.
#[test]
fn signed_in_turns_survive_a_refresh_by_the_daemon() {
    if std::env::var_os("APEX_JAIL_SIGNED_IN").is_none() { return; }
    let user = PathBuf::from(std::env::var_os("HOME").unwrap());
    let data = user.join(".local/share/apex");
    let project = user.join("proj");
    std::fs::create_dir_all(data.join("attachments")).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    let tree = Tree { root: user.clone(), home: user.clone(), data, project: project.clone() };
    let values = values(&project, &user);
    let ask = "Run this exact shell command, then reply with only the word finished: echo refreshed > ";
    let claude = vec!["-p".to_string(), format!("{ask}claude-after.txt"), "--permission-mode".into(), "acceptEdits".into(), "--allowedTools".into(), "Bash".into()];
    let codex = vec!["exec".to_string(), "--skip-git-repo-check".into(), "--sandbox".into(), "workspace-write".into(), format!("{ask}codex-after.txt")];
    let runs = [(AgentTool::ClaudeCode, "/usr/local/bin/claude", claude, "claude", ".claude/.credentials.json", "claude-after.txt"),
        (AgentTool::Codex, "/usr/local/bin/codex", codex, "codex", ".codex/auth.json", "codex-after.txt")];
    for (tool, program, args, provider, login, file) in runs {
        let _ = std::fs::remove_file(project.join(file));
        let deck = home::login_home(&tree.data, provider).join(login);
        nearly_expired(&deck, tool);
        let stale = home::prepare(&tree.data, "r", file, &agent(tool), &values).unwrap_err();
        assert!(stale.to_string().contains("needs refreshing"), "{stale}");
        let before = std::fs::read(&deck).unwrap();
        Runtime::new().unwrap().block_on(refresh::ensure(&Registry::default(), &tree.data, tool, Path::new(program),
            std::ffi::OsStr::new("/usr/local/bin:/usr/bin:/bin"))).unwrap();
        assert_ne!(std::fs::read(&deck).unwrap(), before, "{login} wasn't renewed");
        let made = home::prepare(&tree.data, "r", file, &agent(tool), &values).unwrap();
        turn(&tree, &made, program, args);
        assert_eq!(std::fs::read_to_string(project.join(file)).unwrap().trim(), "refreshed", "{file}");
    }
    println!("REFRESH PASSED");
}

// The start-up probe, against the real jail and against jails with one wall
// removed, so each of its checks is shown to catch what it's for.

fn probe_env(tree: &Tree) -> probe::ProbeEnv {
    probe::ProbeEnv { init: init(), home: tree.home.clone(), data: tree.data.clone() }
}

fn run_probe(tree: &Tree, bwrap: Option<&Path>) -> probe::JailState {
    Runtime::new().unwrap().block_on(probe::run(&probe_env(tree), bwrap))
}

fn wrapper(tree: &Tree, name: &str, body: &str) -> PathBuf {
    let path = tree.root.join(name);
    std::fs::write(&path, format!("#!/bin/bash\n{body}\n")).unwrap();
    assert!(Command::new("chmod").arg("+x").arg(&path).status().unwrap().success());
    path
}

/// A bubblewrap that runs with `drop` (and `extra` values after it) removed.
fn without(tree: &Tree, name: &str, drop: &str, values: usize) -> PathBuf {
    wrapper(tree, name, &format!(r#"out=(); skip=0
for a in "$@"; do
  if [ $skip -gt 0 ]; then skip=$((skip-1)); continue; fi
  if [ "$a" = "{drop}" ]; then skip={values}; continue; fi
  out+=("$a")
done
exec /usr/bin/bwrap "${{out[@]}}""#))
}

fn fails_naming(state: probe::JailState, names: &[&str]) {
    let probe::JailState::Fails(why) = state else { panic!("the probe passed") };
    for name in names { assert!(why.contains(name), "{name} not in: {why}"); }
}

#[test]
fn the_probe_passes_on_a_sound_jail_and_leaves_nothing() {
    if !wanted() { return; }
    let tree = tree("probe-good");
    assert_eq!(run_probe(&tree, Some(Path::new("/usr/bin/bwrap"))), probe::JailState::Works);
    assert!(!tree.data.join("probe").exists());
    assert!(std::fs::read_dir("/tmp").unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().starts_with("apex-probe")));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_probe_fails_without_bubblewrap() {
    if !wanted() { return; }
    let tree = tree("probe-none");
    fails_naming(run_probe(&tree, None), &[probe::NEEDS_ADMIN]);
    fails_naming(run_probe(&tree, Some(Path::new("/nope/bwrap"))), &[probe::NEEDS_ADMIN]);
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_probe_fails_when_bubblewrap_can_not_start() {
    if !wanted() { return; }
    let tree = tree("probe-refused");
    let blocked = wrapper(&tree, "bwrap", "echo 'bwrap: setting up uid map: Permission denied' >&2; exit 1");
    fails_naming(run_probe(&tree, Some(&blocked)), &[probe::NEEDS_ADMIN, "uid map"]);
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_probe_catches_a_shared_network() {
    if !wanted() { return; }
    let tree = tree("probe-net");
    let open = without(&tree, "bwrap", "--unshare-net", 0);
    fails_naming(run_probe(&tree, Some(&open)), &["host-loopback"]);
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_probe_catches_a_missing_filter() {
    if !wanted() { return; }
    let tree = tree("probe-filter");
    let open = without(&tree, "bwrap", "--seccomp", 1);
    fails_naming(run_probe(&tree, Some(&open)), &["bound-socket"]);
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_probe_catches_a_shared_network_with_no_filter() {
    if !wanted() { return; }
    let tree = tree("probe-both");
    let body = r#"out=(); skip=0
for a in "$@"; do
  if [ $skip -gt 0 ]; then skip=$((skip-1)); continue; fi
  if [ "$a" = "--seccomp" ]; then skip=1; continue; fi
  if [ "$a" = "--unshare-net" ]; then continue; fi
  out+=("$a")
done
exec /usr/bin/bwrap "${out[@]}""#;
    let open = wrapper(&tree, "bwrap", body);
    fails_naming(run_probe(&tree, Some(&open)), &["abstract-socket", "bound-socket"]);
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_probe_catches_the_data_folder_in_the_jail() {
    if !wanted() { return; }
    let tree = tree("probe-data");
    let data = tree.data.display();
    let body = format!(r#"out=()
for a in "$@"; do
  if [ "$a" = "--chdir" ]; then out+=(--ro-bind "{data}" "{data}"); fi
  out+=("$a")
done
exec /usr/bin/bwrap "${{out[@]}}""#);
    let open = wrapper(&tree, "bwrap", &body);
    fails_naming(run_probe(&tree, Some(&open)), &["data-folder"]);
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn the_probe_fails_when_it_is_cut_off() {
    if !wanted() { return; }
    let tree = tree("probe-hang");
    let stuck = wrapper(&tree, "bwrap", "exec sleep 600");
    let started = Instant::now();
    fails_naming(run_probe(&tree, Some(&stuck)), &[probe::NEEDS_ADMIN]);
    assert!(started.elapsed() < Duration::from_secs(40));
    assert_eq!(running(&["sleep", "600"]), 0);
    let _ = std::fs::remove_dir_all(&tree.root);
}

// The breakout suite: tests/linux-jail/breakout.py tries every way out from
// inside, against the real proxy with a scripted network behind it.

const OWN: &str = "10.99.0.1";

#[derive(Default)]
struct ScriptedNet { dialled: std::sync::Mutex<Vec<std::net::SocketAddr>>, rebinds: std::sync::atomic::AtomicUsize }

#[async_trait::async_trait]
impl proxy::Net for ScriptedNet {
    type Upstream = tokio::io::DuplexStream;

    async fn lookup(&self, host: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        let turn = if host == "rebinds.test" { self.rebinds.fetch_add(1, std::sync::atomic::Ordering::SeqCst) } else { 0 };
        Ok(match (host, turn) {
            ("public.test", _) | ("rebinds.test", 0) => vec!["1.1.1.1".parse().unwrap()],
            ("metadata.test", _) | ("rebinds.test", _) => vec!["169.254.169.254".parse().unwrap()],
            ("mixed-refused.test", _) => vec!["10.0.0.1".parse().unwrap(), "127.0.0.1".parse().unwrap()],
            ("own.test", _) => vec![OWN.parse().unwrap()],
            _ => return Err(std::io::ErrorKind::NotFound.into()),
        })
    }

    fn own_addrs(&self) -> std::io::Result<Vec<std::net::IpAddr>> { Ok(vec![OWN.parse().unwrap()]) }

    async fn dial(&self, target: std::net::SocketAddr) -> std::io::Result<tokio::io::DuplexStream> {
        self.dialled.lock().unwrap().push(target);
        let (near, mut far) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            let mut head = [0u8; 1024];
            if matches!(far.read(&mut head).await, Ok(1..)) {
                let _ = far.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://metadata.test:443/\r\nContent-Length: 0\r\n\r\n").await;
                let _ = far.flush().await;
            }
        });
        Ok(near)
    }
}

struct Breakout { net: ScriptedNet }

#[async_trait::async_trait]
impl channel::Purposes for Breakout {
    async fn proxy(&self, stream: UnixStream) { proxy::serve(stream, &self.net).await }
    async fn codex_hook(&self, mut stream: UnixStream) {
        let mut sink = Vec::new();
        let _ = stream.read_to_end(&mut sink).await;
        let _ = stream.write_all(b"hook-only").await;
        let _ = stream.flush().await;
    }
}

/// Everything a bot might try to reach, set up on the host side.
struct Bait {
    sockets: Vec<(PathBuf, std::os::unix::net::UnixListener)>,
    abstracts: Vec<(String, std::os::unix::net::UnixListener)>,
    loopback: std::net::TcpListener,
    sleeper: std::process::Child,
    guarded: Vec<(PathBuf, Vec<u8>)>,
}

fn abstract_socket(name: &str) -> std::os::unix::net::UnixListener {
    use std::os::linux::net::SocketAddrExt;
    let addr = std::os::unix::net::SocketAddr::from_abstract_name(name).unwrap();
    std::os::unix::net::UnixListener::bind_addr(&addr).unwrap()
}

fn bait(tree: &Tree, tag: &str) -> Bait {
    let listen = |path: PathBuf| { let _ = std::fs::remove_file(&path); let listener = std::os::unix::net::UnixListener::bind(&path).unwrap(); (path, listener) };
    let outside = tree.root.join("outside.sock");
    let mut sockets = vec![listen(tree.project.join("cmd.sock")), listen(PathBuf::from(format!("/usr/local/bin/cmd-{tag}.sock"))), listen(outside.clone())];
    std::os::unix::fs::symlink(&outside, tree.project.join("link.sock")).unwrap();
    sockets.push(listen(tree.data.join("daemon.sock")));
    let _ = std::fs::create_dir_all("/tmp/.X11-unix");
    sockets.push(listen(PathBuf::from(format!("/tmp/.X11-unix/X{tag}"))));
    let abstracts = [format!("apex-bait-{tag}"), format!("/tmp/.X11-unix/X{tag}")].map(|name| { let listener = abstract_socket(&name); (name, listener) }).into();
    let mut guarded = Vec::new();
    for (path, text) in [
        (tree.home.join(".bashrc"), "# real\n"),
        (tree.home.join(".claude/settings.json"), "{}\n"),
        (tree.home.join(".claude.json"), "{}\n"),
        (tree.data.join("devices.json"), "[]\n"),
    ] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        guarded.push((path, text.as_bytes().to_vec()));
    }
    let sleeper = Command::new("sleep").arg(format!("3133{}", tag.len())).spawn().unwrap();
    Bait { sockets, abstracts, loopback: std::net::TcpListener::bind("127.0.0.1:0").unwrap(), sleeper, guarded }
}

fn breakout(tree: &Tree, level: &str, tag: &str) {
    let bait = bait(tree, tag);
    std::fs::write(tree.project.join("breakout.py"), include_str!("../../../tests/linux-jail/breakout.py")).unwrap();
    for name in ["socket32", "socketx32"] {
        if let Ok(built) = std::fs::read(format!("/tmp/{name}")) {
            let at = tree.project.join(name);
            std::fs::write(&at, built).unwrap();
            assert!(Command::new("chmod").arg("+x").arg(&at).status().unwrap().success());
            assert!(Command::new(&at).status().unwrap().success(), "{name} must make a socket outside the jail");
        }
    }
    let quoted = |items: Vec<String>| items.iter().map(|item| format!("{item:?}")).collect::<Vec<_>>().join(",");
    let mut sockets: Vec<String> = bait.sockets.iter().map(|(path, _)| path.display().to_string()).collect();
    sockets.push(tree.project.join("link.sock").display().to_string());
    let facts = format!(
        r#"{{"home":{:?},"data":{:?},"project":{:?},"sockets":[{}],"abstract":[{}],"loopback":{},"proxy":{PROXY_PORT},"hook":{HOOK_PORT},"own":{OWN:?},"host_marker":"3133{}"}}"#,
        tree.home.display().to_string(), tree.data.display().to_string(), tree.project.display().to_string(),
        quoted(sockets), quoted(bait.abstracts.iter().map(|(name, _)| name.clone()).collect()),
        bait.loopback.local_addr().unwrap().port(), tag.len(),
    );
    let writable = level == "edit";
    let args = vec![tree.project.join("breakout.py").display().to_string(), level.into(), facts];
    let mut spec = spec(tree, &tree.project, writable, tree.project.clone(), "/usr/bin/python3", args);
    spec.read_only = vec!["/usr/local/bin".into()];
    spec.restored = vec![];
    let net = Arc::new(Breakout { net: ScriptedNet::default() });
    let output = Runtime::new().unwrap().block_on(async {
        let mut jailed = launch::jailed_command(&spec, Path::new("/usr/bin/bwrap")).unwrap();
        jailed.command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let (child, control) = jailed.spawn(&Registry::default()).unwrap();
        tokio::spawn(channel::serve(control, net.clone()));
        finish(child).await
    });
    let text = String::from_utf8_lossy(&output.stdout);
    println!("{text}");
    assert!(output.status.success() && text.contains("ALL PASSED"), "status {:?}\n{text}\n{}", output.status, String::from_utf8_lossy(&output.stderr));
    let dialled = net.net.dialled.lock().unwrap();
    assert!(dialled.iter().all(|target| target.ip().to_string() == "1.1.1.1"), "{dialled:?}");
    for (path, text) in &bait.guarded {
        assert_eq!(&std::fs::read(path).unwrap(), text, "{} changed", path.display());
    }
    let mut sleeper = bait.sleeper;
    let _ = sleeper.kill();
    let _ = sleeper.wait();
    for (path, _) in &bait.sockets { let _ = std::fs::remove_file(path); }
}

#[test]
fn a_bot_at_edit_finds_no_way_out() {
    if !wanted() { return; }
    let tree = tree("breakout-edit");
    breakout(&tree, "edit", "1");
    assert!(tree.project.join("wrote-this").exists());
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_bot_at_read_finds_no_way_out() {
    if !wanted() { return; }
    let tree = tree("breakout-read");
    breakout(&tree, "read", "22");
    assert!(!tree.project.join("wrote-this").exists());
    let _ = std::fs::remove_dir_all(&tree.root);
}
