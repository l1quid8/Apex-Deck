//! Root-controlled service configuration. A plan is reviewable configuration,
//! not service installation or process attestation. Activation below requires
//! a verified release, supervised exec and an authenticated health handshake.
#[cfg(target_os = "linux")]
use crate::channel::LINUX_TREE;
use crate::channel::{LINUX_DAEMON_UNIT, LINUX_RUNTIME, LINUX_SERVICE, PRODUCT};
use crate::linux_activation::Descriptor;
use crate::linux_registration::LinuxRegistration;
use std::path::{Path, PathBuf};

/// The caller verifies the signature first. A socket or a live supervisor is
/// insufficient: every expected engine must answer its authenticated probe.
pub fn validate_health(
    value: &serde_json::Value,
    descriptor: &Descriptor,
    release: Option<&serde_json::Value>,
    nonce: &str,
    expected_uids: &[u32],
    ready: bool,
) -> Result<(), String> {
    descriptor.validate()?;
    let instance = value["brokerInstance"].as_str().unwrap_or("");
    if nonce.len() != 32
        || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
        || value["domain"] != crate::DOMAIN
        || value["kind"] != "linux-health"
        || value["nonce"] != nonce
        || value["epoch"] != descriptor.epoch
        || value["manifestSha256"] != descriptor.manifest_sha256
        || value["protocol"] != descriptor.protocol
        || value["tree"].as_str() != descriptor.tree.to_str()
        || value.get("release") != release
        || value["ready"] != ready
        || instance.len() != 32
        || !instance.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(
            "Installed broker health does not match the challenged candidate and phase".into(),
        );
    }
    let engines = value["daemons"].as_array().ok_or("Missing engine health")?;
    let mut actual = std::collections::BTreeSet::new();
    for engine in engines {
        let uid = engine["uid"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= u32::MAX as u64)
            .ok_or("Invalid engine UID")? as u32;
        if !actual.insert(uid)
            || engine["processLive"] != true
            || engine["protocolReady"] != true
            || engine["pid"]
                .as_i64()
                .is_none_or(|p| p <= 0 || p > i32::MAX as i64)
        {
            return Err("Engine health is duplicate, stopped or not protocol-ready".into());
        }
    }
    if actual != expected_uids.iter().copied().collect() {
        return Err("Engine health does not match active enrolled sessions".into());
    }
    Ok(())
}

#[derive(Debug)]
pub struct UnitFile {
    pub path: PathBuf,
    pub contents: String,
}
#[derive(Debug)]
pub struct LoginDependency {
    pub path: PathBuf,
    pub target: PathBuf,
}
#[derive(Debug)]
pub struct ServicePlan {
    pub units: Vec<UnitFile>,
    pub login_dependencies: Vec<LoginDependency>,
}

fn quoted_literal(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(|c| c.is_control()) {
        return Err("Unsafe systemd argument".into());
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    ))
}
fn quoted(value: &str) -> Result<String, String> {
    // ExecStart expands environment variables even in quotes. Other fields,
    // such as WorkingDirectory, expand specifiers but not dollar variables.
    Ok(quoted_literal(value)?.replace('$', "$$"))
}

fn daemon_instance(uid: u32) -> String {
    LINUX_DAEMON_UNIT.replacen("@.", &format!("@{uid}."), 1)
}

/// Generate fixed system units only. No user unit, shell, remote listener,
/// environment inheritance or linger operation is included in this plan.
pub fn plan(
    descriptor: &Descriptor,
    registrations: &[LinuxRegistration],
) -> Result<ServicePlan, String> {
    descriptor.validate()?;
    let broker = descriptor.tree.join("resources/bin/apex-provenance");
    let runtime = Path::new(LINUX_RUNTIME)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid runtime directory")?;
    let mut units = vec![UnitFile {
        path: Path::new("/etc/systemd/system").join(LINUX_SERVICE),
        contents: format!("[Unit]\nDescription={PRODUCT} protected authority\nAfter=local-fs.target\n\n[Service]\nType=notify\nNotifyAccess=main\nTimeoutStartSec=180\nUser=root\nGroup=root\nUMask=0077\nRuntimeDirectory={runtime}\nRuntimeDirectoryMode=0755\nExecStart=/usr/bin/env -i PATH=/usr/bin:/bin NOTIFY_SOCKET=${{NOTIFY_SOCKET}} {} service-linux\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=multi-user.target\n", quoted(broker.to_str().ok_or("Invalid broker path")?)?),
    }, UnitFile {
        path: Path::new("/etc/systemd/system").join(LINUX_DAEMON_UNIT),
        contents: format!("[Unit]\nDescription={PRODUCT} desktop engine for UID %i\nRequires={LINUX_SERVICE}\nPartOf={LINUX_SERVICE}\nAfter={LINUX_SERVICE} user@%i.service\nBindsTo=user@%i.service\n\n[Service]\nType=simple\nUser=%i\nUMask=0077\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nNoNewPrivileges=yes\n"),
    }];
    let mut login_dependencies = Vec::new();
    let mut uids = std::collections::BTreeSet::new();
    for registration in registrations {
        let uid = registration.uid();
        if uid == 0 || !uids.insert(uid) {
            return Err("Invalid or duplicate desktop UID".into());
        }
        registration.validate_scope(uid, registration.data_dir())?;
        let name = daemon_instance(uid);
        units.push(UnitFile {
            path: format!("/etc/systemd/system/{name}.d/registration.conf").into(),
            contents: format!("[Service]\nGroup={}\nWorkingDirectory=/\nExecStart=/usr/bin/env -i PATH=/usr/bin:/bin {} {} wait-linux-daemon\nExecStopPost=/usr/bin/env -i PATH=/usr/bin:/bin {} stop-linux-daemon\n",
                registration.gid(),
                quoted(&format!("HOME={}", registration.home().to_str().ok_or("Invalid home")?))?,
                quoted(broker.to_str().ok_or("Invalid broker path")?)?,quoted(broker.to_str().ok_or("Invalid broker path")?)?),
        });
        login_dependencies.push(LoginDependency {
            path: format!("/etc/systemd/system/user@{uid}.service.wants/{name}").into(),
            target: Path::new("..").join(LINUX_DAEMON_UNIT),
        });
    }
    Ok(ServicePlan {
        units,
        login_dependencies,
    })
}

/// Verify signed payload and complete installed tree before considering any
/// lifecycle action. Unsupported trusted launch/health must never leave a
/// partially activated descriptor or runnable units behind.
pub fn activate(
    tree: &Path,
    manifest: &Path,
    signature: &Path,
    archive: &Path,
) -> Result<(), String> {
    if !cfg!(target_os = "linux") || unsafe { libc::geteuid() } != 0 {
        return Err("Linux activation requires explicit native administrator installation".into());
    }
    let candidate =
        crate::linux_activation::VerifiedCandidate::verify(tree, manifest, signature, archive)?;
    #[cfg(target_os = "linux")]
    return orchestration(&candidate, manifest, signature, archive, false);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = candidate;
        Err("Linux activation requires Linux".into())
    }
}

#[cfg(target_os = "linux")]
fn systemctl(arguments: &[&str]) -> Result<(), String> {
    crate::linux_install::protected_path(Path::new("/usr/bin/systemctl"))?;
    let status = std::process::Command::new("/usr/bin/systemctl")
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C")
        .stdin(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("systemctl {arguments:?} failed: {status}"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn unit_state(name: &str) -> Result<(String, String), String> {
    crate::linux_install::protected_path(Path::new("/usr/bin/systemctl"))?;
    let output = std::process::Command::new("/usr/bin/systemctl")
        .args([
            "show",
            "--property=LoadState",
            "--property=ActiveState",
            name,
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C")
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let load = text
        .lines()
        .find_map(|l| l.strip_prefix("LoadState="))
        .ok_or("Missing systemd load state")?;
    let active = text
        .lines()
        .find_map(|l| l.strip_prefix("ActiveState="))
        .ok_or("Missing systemd active state")?;
    if !output.status.success() && !(load == "not-found" && active == "inactive") {
        return Err("Cannot query systemd unit state".into());
    }
    Ok((load.into(), active.into()))
}

#[cfg(target_os = "linux")]
pub fn session_active(uid: u32) -> Result<bool, String> {
    if uid == 0 {
        return Err("Root is not a desktop session".into());
    }
    Ok(unit_state(&format!("user@{uid}.service"))?.1 == "active")
}

#[cfg(target_os = "linux")]
fn stop_unit(name: &str) -> Result<(), String> {
    let (load, active) = unit_state(name)?;
    if load == "not-found" && active == "inactive" {
        return Ok(());
    }
    // A broken/incomplete unit can reject Stop even though it is already
    // inactive. The read-back is the safety gate needed for explicit repair.
    let _ = systemctl(&["stop", name]);
    let (_, after) = unit_state(name)?;
    if !matches!(after.as_str(), "inactive" | "failed") {
        return Err(format!("Service {name} did not stop"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => (),
        Ok(_) => return Err("Service path is not a directory".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            directory(path.parent().ok_or("Missing directory parent")?)?;
            std::fs::DirBuilder::new()
                .mode(0o755)
                .create(path)
                .map_err(|e| e.to_string())?;
            std::fs::File::open(path.parent().unwrap())
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Err(e) => return Err(e.to_string()),
    }
    crate::linux_install::protected_path(path)
}

#[cfg(target_os = "linux")]
fn write_protected(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let parent = path.parent().ok_or("Missing service file parent")?;
    directory(parent)?;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => crate::linux_install::protected_path(path)?,
        Ok(_) => return Err("Refusing substituted service file".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    // An interrupted configuration write must not obstruct explicit recovery.
    // Each attempt owns its root-directory temporary; stale attempts are never
    // treated as committed state or silently imported into authority history.
    let pending = path.with_extension(format!("apex-pending-{}", crate::io::challenge()?));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&pending, path).map_err(|e| e.to_string())?;
    std::fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn metadata(
    candidate: &crate::linux_activation::VerifiedCandidate,
    manifest: &Path,
    signature: &Path,
    archive: &Path,
) -> Result<(), String> {
    use std::{
        io::{Read, Write},
        os::unix::fs::OpenOptionsExt,
    };
    let root = Path::new(crate::ROOT)
        .join("releases")
        .join(&candidate.descriptor().manifest_sha256);
    directory(&root)?;
    for (source, name, limit) in [
        (
            manifest,
            "manifest.json",
            crate::linux_install::MANIFEST_LIMIT as u64,
        ),
        (signature, "manifest.sig", 64),
        (archive, "payload.tar", crate::linux_install::PAYLOAD_LIMIT),
    ] {
        let destination = root.join(name);
        if !destination.try_exists().map_err(|e| e.to_string())? {
            let mut input = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(source)
                .map_err(|e| e.to_string())?
                .take(limit + 1);
            let temporary = root.join(format!("{name}.pending-{}", crate::io::challenge()?));
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
            if copied > limit {
                return Err("Service verification metadata exceeds bound".into());
            }
            output
                .flush()
                .and_then(|_| output.sync_all())
                .map_err(|e| e.to_string())?;
            std::fs::rename(temporary, destination).map_err(|e| e.to_string())?;
            std::fs::File::open(&root)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
    }
    let copied = crate::linux_activation::VerifiedCandidate::verify(
        &candidate.descriptor().tree,
        &root.join("manifest.json"),
        &root.join("manifest.sig"),
        &root.join("payload.tar"),
    )?;
    if copied.descriptor() != candidate.descriptor() {
        return Err("Persisted service metadata differs from verified candidate".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn signed_request(request: serde_json::Value) -> Result<serde_json::Value, String> {
    use std::{io::Write, os::unix::net::UnixStream, time::Duration};
    let key = crate::io::root_file(&Path::new(crate::ROOT).join("public-key"))?;
    let mut stream = UnixStream::connect(crate::SOCKET).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    writeln!(stream, "{request}").map_err(|e| e.to_string())?;
    let response = crate::io::read_frame(&mut stream)?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    let signed: crate::Signed = serde_json::from_value(response).map_err(|e| e.to_string())?;
    let value = crate::verify(&key, &signed)?;
    if value["domain"] != crate::DOMAIN || value["nonce"] != request["nonce"] {
        return Err("Service challenge mismatch".into());
    }
    Ok(value)
}

#[cfg(target_os = "linux")]
pub fn wait_daemon() -> Result<(), String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let nonce = crate::io::challenge()?;
    let reply = signed_request(serde_json::json!({"op":"launch-daemon","nonce":nonce}))?;
    let pid = reply["pid"]
        .as_i64()
        .filter(|p| *p > 0 && *p <= i32::MAX as i64)
        .ok_or("Invalid supervised engine process")?;
    if reply["kind"] != "linux-launch"
        || reply["role"] != "daemon"
        || reply["uid"] != unsafe { libc::geteuid() }
        || reply["epoch"].as_u64().is_none_or(|n| n == 0)
    {
        return Err("Invalid supervised engine launch response".into());
    }
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as i32, 0) } as i32;
    if fd < 0 {
        return Err("Supervised engine stopped before wait".into());
    }
    let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    let mut poll = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let result = unsafe { libc::poll(&mut poll, 1, -1) };
        if result > 0 {
            return Err("Supervised engine stopped; service restart required".into());
        }
        if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err("Engine wait failed".into());
        }
    }
}

#[cfg(target_os = "linux")]
pub fn stop_daemon() -> Result<(), String> {
    let nonce = crate::io::challenge()?;
    let reply = signed_request(serde_json::json!({"op":"stop-daemon","nonce":nonce}))?;
    if reply["kind"] != "linux-stop"
        || reply["role"] != "daemon"
        || reply["uid"] != unsafe { libc::geteuid() }
    {
        return Err("Invalid engine stop response".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn initialize() -> Result<(), String> {
    if unsafe { libc::geteuid() } != 0 {
        return Err("Explicit administrator initialization required".into());
    }
    directory(Path::new(crate::ROOT))?;
    let _store = crate::linux_activation::Store::initialize()?;
    crate::linux_registration::RegistrationStore::initialize()?.publish_scopes()?;
    directory(Path::new(LINUX_RUNTIME))?;
    directory(Path::new(LINUX_TREE))?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn recover(
    tree: &Path,
    manifest: &Path,
    signature: &Path,
    archive: &Path,
) -> Result<(), String> {
    if unsafe { libc::geteuid() } != 0 {
        return Err("Explicit administrator recovery required".into());
    }
    let candidate =
        crate::linux_activation::VerifiedCandidate::verify(tree, manifest, signature, archive)?;
    orchestration(&candidate, manifest, signature, archive, true)
}

#[cfg(target_os = "linux")]
fn orchestration(
    candidate: &crate::linux_activation::VerifiedCandidate,
    manifest: &Path,
    signature: &Path,
    archive: &Path,
    recovery: bool,
) -> Result<(), String> {
    use std::{
        os::unix::{fs::OpenOptionsExt, io::AsRawFd},
        time::{Duration, Instant},
    };
    if std::fs::read_to_string("/proc/1/comm")
        .map_err(|e| e.to_string())?
        .trim()
        != "systemd"
    {
        return Err(
            "Protected services require a systemd/logind host; no installation changed".into(),
        );
    }
    let root = Path::new(crate::ROOT);
    crate::linux_install::protected_path(root)?;
    let lock_path = root.join("service-transaction.lock");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    crate::linux_install::protected_path(&lock_path)?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another service transaction is active".into());
    }
    let registry = crate::linux_registration::RegistrationStore::open()?;
    registry.publish_scopes()?;
    let registrations = registry.list()?;
    metadata(candidate, manifest, signature, archive)?;
    let marker = root.join("service.pending");
    if marker.try_exists().map_err(|e| e.to_string())? && !recovery {
        return Err("Interrupted service transaction; explicit recovery required".into());
    }
    write_protected(
        &marker,
        b"admission closed for explicit service transaction\n",
        0o600,
    )?;
    let stop = || -> Result<(), String> {
        let mut errors = Vec::new();
        for r in &registrations {
            if let Err(error) = stop_unit(&daemon_instance(r.uid())) {
                errors.push(error);
            }
        }
        if let Err(error) = stop_unit(LINUX_SERVICE) {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    };
    let result = (|| {
        stop()?;
        let mut store = if recovery {
            match crate::linux_activation::Store::open() {
                Ok(mut store) => {
                    if store.state()?.phase() == crate::linux_activation::Phase::Ready {
                        // A service failure can occur after the phase commit but
                        // before the admission marker is removed. Burn a fresh
                        // epoch rather than resetting or reopening that state.
                        store.prepare(candidate.descriptor().clone())?;
                    } else {
                        store.recover(candidate.descriptor().clone())?;
                    }
                    store
                }
                Err(_) => crate::linux_activation::Store::recover_interrupted(candidate.descriptor().clone())?,
            }
        } else {
            let mut store = crate::linux_activation::Store::open()?;
            store.prepare(candidate.descriptor().clone())?;
            store
        };
        store.services_stopped()?;
        let descriptor = store.state()?.service_descriptor()?.clone();
        let service = plan(&descriptor, &registrations)?;
        for unit in service.units {
            write_protected(&unit.path, unit.contents.as_bytes(), 0o644)?;
        }
        for link in service.login_dependencies {
            directory(link.path.parent().unwrap())?;
            match std::fs::read_link(&link.path) {
                Ok(target) if target == link.target => (),
                Ok(_) => return Err("Conflicting login service dependency".into()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    std::os::unix::fs::symlink(&link.target, &link.path)
                        .map_err(|e| e.to_string())?
                }
                Err(e) => return Err(e.to_string()),
            }
            std::fs::File::open(link.path.parent().unwrap())
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        drop(store);
        systemctl(&["daemon-reload"])?;
        systemctl(&["enable", LINUX_SERVICE])?;
        systemctl(&["start", LINUX_SERVICE])?;
        let mut active = Vec::new();
        for registration in &registrations {
            if session_active(registration.uid())? {
                active.push(registration.uid());
                systemctl(&[
                    "start",
                    &daemon_instance(registration.uid()),
                ])?;
            }
        }
        let release = candidate.manifest().nightly_identity();
        let health = |ready| -> Result<(), String> {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let nonce = crate::io::challenge()?;
                let reply = signed_request(serde_json::json!({"op":"health","nonce":nonce}));
                let result = reply
                    .and_then(|value| validate_health(&value, &descriptor, release.as_ref(), &nonce, &active, ready));
                match result {
                    Ok(()) => return Ok(()),
                    Err(error) if Instant::now() >= deadline => return Err(error),
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        };
        health(false)?;
        let mut store = crate::linux_activation::Store::open()?;
        if store.state()?.service_descriptor()? != &descriptor {
            return Err("Candidate changed during health verification".into());
        }
        store.healthy()?;
        drop(store);
        health(true)?;
        std::fs::remove_file(&marker).map_err(|e| e.to_string())?;
        std::fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        let nonce = crate::io::challenge()?;
        let final_health = signed_request(serde_json::json!({"op":"health","nonce":nonce}))?;
        validate_health(&final_health, &descriptor, release.as_ref(), &nonce, &active, true)?;
        if final_health["authorityReady"] != true {
            return Err("Service did not reopen authenticated admission".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = write_protected(
            &marker,
            b"service transaction failed; recovery required\n",
            0o600,
        );
        let _ = stop();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::{LINUX_TREE, NIGHTLY};
    #[test]
    #[cfg(target_os="linux")]
    #[ignore="requires a disposable root Linux filesystem"]
    fn stale_configuration_temporaries_cannot_block_explicit_service_repair() {
        assert_eq!(unsafe{libc::geteuid()},0);
        let root=Path::new("/var/lib").join(format!("apex-service-recovery-{}",crate::io::challenge().unwrap()));
        directory(&root).unwrap();
        let path=root.join("service.pending");
        let stale=path.with_extension("apex-pending");
        std::fs::write(&stale,b"interrupted configuration write").unwrap();
        write_protected(&path,b"fresh recovery",0o600).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(),b"fresh recovery");
        assert_eq!(std::fs::read(&stale).unwrap(),b"interrupted configuration write");
        write_protected(&path,b"next attempt",0o600).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(),b"next attempt");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn systemd_arguments_cannot_expand_specifiers_variables_or_new_directives() {
        assert_eq!(
            quoted("/home/a%u/$X/\"x\\y").unwrap(),
            "\"/home/a%%u/$$X/\\\"x\\\\y\""
        );
        for value in ["", "x\nUser=root", "x\0y", "x\rExecStart=bad"] {
            assert!(quoted(value).is_err());
        }
    }
    #[test]
    fn service_plan_uses_system_user_manager_and_fixed_clean_nonroot_daemon_template() {
        let descriptor = Descriptor {
            tree: Path::new(LINUX_TREE).join("test"),
            manifest_sha256: "a".repeat(64),
            protocol: 1,
            epoch: 1,
        };
        let service = plan(&descriptor, &[]).unwrap();
        let broker = &service.units[0].contents;
        assert!(broker.contains(&format!("ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin NOTIFY_SOCKET=${{NOTIFY_SOCKET}} \"{LINUX_TREE}/test/resources/bin/apex-provenance\" service-linux")));
        let (broker_name, runtime, daemon_name, instance) = if NIGHTLY {
            ("apex-deck-nightly-provenance.service", "apex-deck-nightly", "apex-deck-nightly-daemon@.service", "apex-deck-nightly-daemon@1000.service")
        } else {
            ("apex-deck-provenance.service", "apex-deck", "apex-deck-daemon@.service", "apex-deck-daemon@1000.service")
        };
        assert_eq!(service.units[0].path, Path::new("/etc/systemd/system").join(broker_name));
        assert_eq!(service.units[1].path, Path::new("/etc/systemd/system").join(daemon_name));
        assert_eq!(daemon_instance(1000), instance);
        assert!(broker.contains(&format!("RuntimeDirectory={runtime}\n")));
        let daemon = &service.units[1].contents;
        assert!(daemon.contains("User=%i"));
        assert!(daemon.contains("BindsTo=user@%i.service"));
        assert!(daemon.contains(&format!("Requires={broker_name}\n")));
        assert!(daemon.contains(&format!("PartOf={broker_name}\n")));
        assert!(!daemon.contains("WantedBy=multi-user.target"));
        assert!(!broker.contains("--no-sandbox"));
        assert!(service.login_dependencies.is_empty());
    }
    #[test]
    fn invalid_descriptor_cannot_generate_service_configuration() {
        let mut descriptor = Descriptor {
            tree: Path::new(LINUX_TREE).join("test"),
            manifest_sha256: "a".repeat(64),
            protocol: 1,
            epoch: 1,
        };
        descriptor.tree = Path::new(LINUX_TREE).join("../bad");
        assert!(plan(&descriptor, &[]).is_err());
    }
}
