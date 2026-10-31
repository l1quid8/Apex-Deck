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
    std::fs::write(project.join("marker"), "shown\n").unwrap();
    let init = root.join("init");
    std::fs::write(&init, "#!/bin/sh\nshift 3\nexec \"$@\"\n").unwrap();
    std::fs::set_permissions(&init, std::fs::Permissions::from_mode(0o755)).unwrap();
    let root = root.canonicalize().unwrap();
    Tree { home: root.join("home"), data: root.join("home/.local/share/apex"), project: root.join("home/work/app"), init: root.join("init"), root }
}

fn mounts() -> paths::Mounts { paths::Mounts::current().unwrap() }

fn run(tree: &Tree, writable: bool, folder: &Path) -> std::process::Output {
    let args = vec![tree.project.join("probe.py").display().to_string(), if writable { "edit" } else { "read" }.into(),
                    tree.home.display().to_string(), tree.data.display().to_string(), tree.project.display().to_string()];
    jail(tree, folder, writable, tree.project.clone(), "/usr/bin/python3", args)
}

/// Tries to read each file in the jail, and to overwrite it when `writable`.
fn poke(tree: &Tree, folder: &Path, writable: bool, files: &[PathBuf]) -> String {
    let write = if writable { "echo broken > \"$f\" 2>/dev/null;" } else { "" };
    let script = format!("for f in \"$@\"; do {write} cat \"$f\" 2>/dev/null; done; echo done");
    let mut args = vec!["-c".to_owned(), script, "sh".to_owned()];
    args.extend(files.iter().map(|f| f.display().to_string()));
    let output = jail(tree, folder, writable, folder.to_path_buf(), "/bin/sh", args);
    let out = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(out.ends_with("done\n"), "{out}\n{}", String::from_utf8_lossy(&output.stderr));
    out
}

fn jail(tree: &Tree, folder: &Path, writable: bool, cwd: PathBuf, program: &str, args: Vec<String>) -> std::process::Output {
    let (read, raw) = filter_pipe();
    let spec = JailSpec {
        program: program.into(),
        args,
        cwd,
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
    let args = bwrap_args(&spec, &mounts(), |p| std::fs::metadata(p).ok().map(|m| m.is_dir())).unwrap();
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
    let refused = paths::check_writable(&second, &guard, &mounts());
    let inside = paths::check_writable(&second.join(".ssh"), &guard, &mounts());
    let seen = poke(&tree, &second, false, &[second.join(".local/share/apex/gateway.token"), second.join(".ssh/id_ed25519")]);
    let visible = poke(&tree, &second, false, &[second.join("work/app/marker")]);
    unmount(&second);
    assert!(refused.is_err() && inside.is_err());
    assert_eq!(seen, "done\n");
    assert_eq!(visible, "shown\ndone\n", "the mount really was in the jail");
    assert_eq!(std::fs::read_to_string(tree.data.join("gateway.token")).unwrap(), "secret");
    let _ = std::fs::remove_dir_all(&tree.root);
}

fn mount(source: &Path, at: &Path) {
    std::fs::create_dir_all(at).unwrap();
    assert!(Command::new("mount").args(["--bind"]).arg(source).arg(at).status().unwrap().success());
}

fn unmount(at: &Path) { assert!(Command::new("umount").arg(at).status().unwrap().success()); }

fn guard(tree: &Tree) -> paths::Guard {
    paths::Guard { home: tree.home.clone(), protected: paths::standard_protected(&tree.home, &tree.data), ..Default::default() }
}

#[test]
fn a_data_folder_mounted_inside_a_project_is_refused_and_hidden() {
    if !wanted() { return; }
    let tree = tree("nested");
    let nested = tree.project.join("nested");
    mount(&tree.data, &nested);
    let refused = paths::check_writable(&tree.project, &guard(&tree), &mounts());
    let seen = poke(&tree, &tree.project, false, &[nested.join("gateway.token")]);
    let visible = poke(&tree, &tree.project, false, &[tree.project.join("marker")]);
    unmount(&nested);
    assert!(refused.is_err());
    assert_eq!(seen, "done\n");
    assert_eq!(visible, "shown\ndone\n");
    assert_eq!(std::fs::read_to_string(tree.data.join("gateway.token")).unwrap(), "secret");
    let _ = std::fs::remove_dir_all(&tree.root);
}

#[test]
fn a_folder_around_the_source_of_home_is_refused_and_hidden() {
    if !wanted() { return; }
    let source = tree("source");
    // A home that lives elsewhere: the tree's root is no ancestor of it by name.
    let alias = std::env::temp_dir().canonicalize().unwrap().join(format!("apex-jail-alias-{}", std::process::id()));
    mount(&source.home, &alias);
    let data = alias.join(".local/share/apex");
    let guard = paths::Guard { home: alias.clone(), protected: paths::standard_protected(&alias, &data), ..Default::default() };
    let refused = paths::check_writable(&source.root, &guard, &mounts());
    let hidden = paths::hidden_in(&source.root, &guard.protected, &mounts()).unwrap();
    unmount(&alias);
    let _ = std::fs::remove_dir(&alias);
    assert!(refused.is_err());
    assert!(hidden.contains(&source.home.join(".ssh")), "{hidden:?}");
    let _ = std::fs::remove_dir_all(&source.root);
}
