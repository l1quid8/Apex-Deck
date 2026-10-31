//! What the kernel really does with the jail. Runs only where
//! APEX_JAIL_KERNEL_TEST is set, so a missing bubblewrap can't pass quietly:
//! see tests/linux-jail/run.sh.
#![cfg(target_os = "linux")]

use apex_adapters::linux_jail::{bwrap_args, jail_env, paths, seccomp, Bind, JailSpec};
use std::io::Write;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const PROBE: &str = include_str!("../../../tests/linux-jail/probe.py");

fn wanted() -> bool { std::env::var_os("APEX_JAIL_KERNEL_TEST").is_some() }

fn filter_pipe() -> (OwnedFd, RawFd) {
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    std::fs::File::from(write).write_all(&seccomp::filter()).unwrap();
    let raw = std::os::fd::AsRawFd::as_raw_fd(&read);
    (read, raw)
}

struct Tree { root: PathBuf, home: PathBuf, data: PathBuf, project: PathBuf, init: PathBuf }

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
    let init = root.join("init");
    std::fs::write(&init, "#!/bin/sh\nshift 3\nexec \"$@\"\n").unwrap();
    std::fs::set_permissions(&init, std::fs::Permissions::from_mode(0o755)).unwrap();
    let root = root.canonicalize().unwrap();
    Tree { home: root.join("home"), data: root.join("home/.local/share/apex"), project: root.join("home/work/app"), init: root.join("init"), root }
}

fn run(tree: &Tree, writable: bool, folder: &Path) -> std::process::Output {
    let (read, raw) = filter_pipe();
    let spec = JailSpec {
        program: "/usr/bin/python3".into(),
        args: vec![tree.project.join("probe.py").display().to_string(), if writable { "edit" } else { "read" }.into(),
                   tree.home.display().to_string(), tree.data.display().to_string(), tree.project.display().to_string()],
        cwd: tree.project.clone(),
        home: tree.home.clone(),
        private_home: tree.data.join("jail-homes/r/b"),
        folders: vec![Bind { source: folder.into(), target: folder.into(), writable }],
        read_only: vec!["/usr/local/bin".into()],
        protected: paths::standard_protected(&tree.home, &tree.data),
        restored: vec![Bind { source: tree.data.join("attachments"), target: tree.data.join("attachments"), writable: false }],
        init: tree.init.clone(),
        path: "/usr/local/bin:/usr/bin:/bin".into(),
        provider_env: vec![],
        seccomp_fd: raw,
        control_fd: 0,
    };
    let args = bwrap_args(&spec, |p| std::fs::metadata(p).ok().map(|m| m.is_dir()));
    let mut command = Command::new("bwrap");
    command.env_clear().args(args).envs(jail_env(&spec));
    unsafe {
        command.pre_exec(move || {
            libc::fcntl(raw, libc::F_SETFD, 0);
            if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); }
            Ok(())
        });
    }
    let output = command.output().unwrap();
    drop(read);
    output
}

fn expect(output: std::process::Output) {
    let (out, err) = (String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success() && out.contains("ALL PASSED"), "status {:?}\n{out}\n{err}", output.status);
}

#[test]
fn edit_level_jail_holds() {
    if !wanted() { return; }
    let tree = tree("edit");
    expect(run(&tree, true, &tree.project));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn read_level_jail_around_home_hides_secrets() {
    if !wanted() { return; }
    let tree = tree("read");
    expect(run(&tree, false, &tree.home));
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_second_mount_of_home_is_refused() {
    if !wanted() { return; }
    let tree = tree("mount");
    let second = tree.root.join("second");
    std::fs::create_dir(&second).unwrap();
    assert!(Command::new("mount").args(["--bind"]).arg(&tree.home).arg(&second).status().unwrap().success());
    let guard = paths::Guard { home: tree.home.clone(), protected: paths::standard_protected(&tree.home, &tree.data), ..Default::default() };
    let refused = paths::check_writable(&second, &guard);
    let inside = paths::check_writable(&second.join(".ssh"), &guard);
    assert!(Command::new("umount").arg(&second).status().unwrap().success());
    assert!(refused.is_err() && inside.is_err());
    let _ = std::fs::remove_dir_all(&tree.root);
}
