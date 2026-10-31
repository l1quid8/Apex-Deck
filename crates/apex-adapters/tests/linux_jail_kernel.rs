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
        protected: protected(tree),
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
