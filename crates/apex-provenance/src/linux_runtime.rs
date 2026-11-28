//! Linux broker-owned launch registry. Never infer authority from service names,
//! ancestry, UID or caller-selected executable paths.
use crate::{
    io::root_file_limit,
    linux::{launch::ExecGuard, KernelPeer},
    linux_activation::{self, Activation, Descriptor, VerifiedCandidate},
    linux_registration::{LinuxRegistration, RegistrationStore},
    DOMAIN, ROOT,
};
use serde_json::{json, Value};
use std::{
    os::unix::{fs::MetadataExt, process::CommandExt},
    path::Path,
};

/// Deck's own bubblewrap, copied by the installer to `/var/lib/<slug>-jail/bwrap`
/// (outside every path a jail mounts) and the only copy its AppArmor profile
/// lets make user namespaces. Passed to the engine only while it is a
/// root-owned file no one else can replace, and only after it matches the
/// system's bubblewrap again, so a security update reaches it at the next
/// engine start. Any doubt leaves it out: the jail then fails closed.
fn jail_bwrap(gid: u32) -> Option<std::path::PathBuf> {
    let slug = Path::new(crate::channel::LINUX_TREE).file_name()?.to_str()?;
    let dir = Path::new("/var/lib").join(format!("{slug}-jail"));
    let bwrap = dir.join("bwrap");
    let meta = std::fs::symlink_metadata(&bwrap).ok()?;
    if !meta.file_type().is_file() || crate::linux_install::protected_path(&bwrap).is_err() {
        return None;
    }
    match refresh_jail_bwrap(&dir, &bwrap, gid) {
        Ok(()) => Some(bwrap),
        Err(error) => {
            eprintln!("apex-provenance: agent jail bubblewrap left out: {error}");
            None
        }
    }
}

fn refresh_jail_bwrap(dir: &Path, bwrap: &Path, gid: u32) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let system = Path::new("/usr/bin/bwrap").canonicalize().map_err(|e| format!("system bubblewrap: {e}"))?;
    crate::linux_install::protected_path(&system)?;
    let fresh = std::fs::read(&system).map_err(|e| e.to_string())?;
    let current = std::fs::read(bwrap).map_err(|e| e.to_string())?;
    let owned = |path: &Path| std::fs::symlink_metadata(path).is_ok_and(|m| m.uid() == 0 && m.gid() == gid);
    if fresh == current && owned(dir) && owned(bwrap) {
        return Ok(());
    }
    let next = dir.join("bwrap.new");
    let _ = std::fs::remove_file(&next);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&next)
        .map_err(|e| e.to_string())?;
    file.write_all(&fresh).and_then(|()| file.sync_all()).map_err(|e| e.to_string())?;
    std::os::unix::fs::fchown(&file, Some(0), Some(gid)).map_err(|e| e.to_string())?;
    file.set_permissions(std::fs::Permissions::from_mode(0o750)).map_err(|e| e.to_string())?;
    drop(file);
    std::os::unix::fs::lchown(dir, Some(0), Some(gid)).map_err(|e| e.to_string())?;
    std::fs::rename(&next, bwrap).map_err(|e| e.to_string())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    App,
    Daemon,
}
impl Role {
    fn name(self) -> &'static str {
        if self == Self::App {
            "app"
        } else {
            "daemon"
        }
    }
}
struct Launch {
    role: Role,
    uid: u32,
    guard: ExecGuard,
}
pub struct Context {
    descriptor: Descriptor,
    candidate: VerifiedCandidate,
    launches: Vec<Launch>,
    instance: String,
}
impl Context {
    pub fn open() -> Result<Self, String> {
        if unsafe { libc::geteuid() } != 0 {
            return Err("Linux broker requires administrator service".into());
        }
        if std::fs::symlink_metadata(Path::new(ROOT).join("installation.pending")).is_ok() {
            return Err(
                "Incomplete installation persistence; administrator recovery required".into(),
            );
        }
        let state = Activation::restore(&root_file_limit(
            &Path::new(ROOT).join("installation.json"),
            16384,
        )?)?;
        let descriptor = state.service_descriptor()?.clone();
        let metadata = Path::new(ROOT)
            .join("releases")
            .join(&descriptor.manifest_sha256);
        let candidate = VerifiedCandidate::verify(
            &descriptor.tree,
            &metadata.join("manifest.json"),
            &metadata.join("manifest.sig"),
            &metadata.join("payload.tar"),
        )?;
        if candidate.descriptor().tree != descriptor.tree
            || candidate.descriptor().manifest_sha256 != descriptor.manifest_sha256
            || candidate.descriptor().protocol != descriptor.protocol
        {
            return Err("Selected installation differs from authenticated release".into());
        }
        let running = std::fs::metadata("/proc/self/exe").map_err(|e| e.to_string())?;
        let pinned = std::fs::metadata(descriptor.tree.join("resources/bin/apex-provenance"))
            .map_err(|e| e.to_string())?;
        if (running.dev(), running.ino()) != (pinned.dev(), pinned.ino()) {
            return Err("Broker is not the selected installed image".into());
        }
        Ok(Self {
            descriptor,
            candidate,
            launches: Vec::new(),
            instance: crate::io::challenge()?,
        })
    }
    pub fn descriptor(&self) -> &Descriptor {
        &self.descriptor
    }
    pub fn admission(&self) -> Result<linux_activation::AdmissionGuard, String> {
        let guard = linux_activation::admission()?;
        self.selected()?;
        if guard.descriptor() != &self.descriptor {
            return Err("Broker installation epoch was superseded; restart required".into());
        }
        Ok(guard)
    }
    pub fn selected(&self) -> Result<(), String> {
        match std::fs::symlink_metadata(Path::new(ROOT).join("installation.pending")) {
            Ok(_) => return Err("Incomplete installation persistence".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
        let state = Activation::restore(&root_file_limit(
            &Path::new(ROOT).join("installation.json"),
            16384,
        )?)?;
        if state.service_descriptor()? != &self.descriptor {
            return Err("Selected service installation changed".into());
        }
        crate::linux_install::validate_tree(&self.descriptor.tree, self.candidate.manifest())
    }
    pub fn role(&self, peer: &KernelPeer) -> Result<Option<Role>, String> {
        for launch in &self.launches {
            if launch.uid == peer.identity().1 && launch.guard.matches(peer)? {
                return Ok(Some(launch.role));
            }
        }
        Ok(None)
    }
    pub fn lease(&self, peer: &KernelPeer) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        for launch in &self.launches {
            if launch.uid == peer.identity().1 && launch.guard.matches(peer)? {
                let lease = launch.guard.lease()?;
                if !launch.guard.matches(peer)? {
                    return Err("Launch role changed before dispatch".into());
                }
                return Ok(lease);
            }
        }
        Err("No live broker-owned role".into())
    }
    fn registration(peer: &KernelPeer) -> Result<LinuxRegistration, String> {
        peer.validate()?;
        if !crate::linux_service::session_active(peer.identity().1)? {
            return Err("Enrolled desktop login manager is inactive".into());
        }
        let registration = RegistrationStore::open()?.load(peer.identity().1)?;
        registration.validate_peer(peer, registration.data_dir())?;
        Ok(registration)
    }
    pub fn validate_scope(&self, peer: &KernelPeer, folder: &Path) -> Result<(), String> {
        let registration = Self::registration(peer)?;
        registration.validate_peer(peer, folder)
    }
    fn nonce<'a>(request: &'a Value) -> Result<&'a str, String> {
        request["nonce"]
            .as_str()
            .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| "Invalid Linux service challenge".into())
    }
    pub fn scope(&self, peer: &KernelPeer, request: &Value) -> Result<Value, String> {
        let _admission = self.admission()?;
        let registration = Self::registration(peer)?;
        let daemon = self
            .launches
            .iter()
            .find(|l| l.uid == registration.uid() && l.role == Role::Daemon && l.guard.is_live());
        if let Some(daemon) = daemon {
            let _ = self.probe_launch(daemon, std::time::Duration::from_secs(3))?;
        }
        peer.validate()?;
        let role = self.role(peer)?.map(Role::name);
        let mut scope = json!({"domain":DOMAIN,"kind":"linux-scope","nonce":Self::nonce(request)?,"uid":registration.uid(),"dataDir":registration.data_dir(),"epoch":self.descriptor.epoch,"manifestSha256":self.descriptor.manifest_sha256,"protocol":1,"tree":self.descriptor.tree,"brokerInstance":self.instance,"role":role,"daemonEndpoint":registration.data_dir().join("daemon.sock"),"daemonPid":daemon.map(|d|d.guard.pid())});
        if let Some(release) = self.candidate.manifest().nightly_identity() {
            scope["release"] = release;
        }
        Ok(scope)
    }
    pub fn stop_daemon(&mut self, peer: &KernelPeer, request: &Value) -> Result<Value, String> {
        peer.validate()?;
        Self::nonce(request)?;
        let uid = peer.identity().1;
        if uid == 0 {
            return Err("Daemon stop requires its enrolled account".into());
        }
        // Logout must revoke even if the session has already gone inactive or
        // an installer has closed admissions. Never select another account.
        self.launches
            .retain(|launch| !(launch.uid == uid && launch.role == Role::Daemon));
        Ok(
            json!({"domain":DOMAIN,"kind":"linux-stop","role":"daemon","nonce":request["nonce"],"uid":uid,"epoch":self.descriptor.epoch}),
        )
    }
    pub fn launch(
        &mut self,
        peer: &KernelPeer,
        request: &Value,
        role: Role,
    ) -> Result<Value, String> {
        // Candidate daemon startup is allowed while Switched, but no issuance,
        // claim, read or protected write is admitted before Ready.
        let _admission = if role == Role::App {
            Some(self.admission()?)
        } else {
            self.selected()?;
            None
        };
        Self::nonce(request)?;
        let registration = Self::registration(peer)?;
        self.launches.retain(|l| l.guard.is_live());
        if let Some(existing) = self
            .launches
            .iter()
            .find(|l| l.uid == registration.uid() && l.role == role)
        {
            return Ok(self.launch_payload(
                request,
                role,
                registration.uid(),
                existing.guard.pid(),
            ));
        }
        crate::linux_install::validate_tree(&self.descriptor.tree, self.candidate.manifest())?;
        let executable = self.descriptor.tree.join(if role == Role::App {
            "apex-deck"
        } else {
            "resources/bin/apex-daemon"
        });
        if role == Role::App {
            crate::linux_fuses::installed(&executable)?;
        }
        let mut command = std::process::Command::new(&executable);
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", registration.home())
            .current_dir(registration.home());
        if role == Role::Daemon {
            command
                .args(["serve", "--local-only", "--data-dir"])
                .arg(registration.data_dir());
            if let Some(bwrap) = jail_bwrap(registration.gid()) {
                command.env("APEX_JAIL_BWRAP", bwrap);
            }
        } else {
            let runtime = format!("/run/user/{}", registration.uid());
            let runtime_path = Path::new(&runtime);
            let meta = std::fs::symlink_metadata(runtime_path).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink()
                || !meta.is_dir()
                || meta.uid() != registration.uid()
                || meta.mode() & 0o077 != 0
            {
                return Err("Unsafe desktop runtime directory".into());
            }
            command.env("XDG_RUNTIME_DIR", &runtime).env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={runtime}/bus"),
            );
            if let Some(environment) = request.get("environment") {
                let values = environment
                    .as_object()
                    .ok_or("Invalid desktop environment")?;
                for (name, value) in values {
                    if !matches!(
                        name.as_str(),
                        "DISPLAY" | "WAYLAND_DISPLAY" | "XAUTHORITY" | "XDG_SESSION_TYPE"
                    ) {
                        return Err("Unsupported desktop environment input".into());
                    }
                    let value = value
                        .as_str()
                        .filter(|v| {
                            !v.is_empty() && v.len() <= 4096 && !v.chars().any(char::is_control)
                        })
                        .ok_or("Invalid desktop environment value")?;
                    if name == "WAYLAND_DISPLAY"
                        && (value.contains('/') || value == "." || value == "..")
                    {
                        return Err("Unsafe Wayland display name".into());
                    }
                    command.env(name, value);
                }
            }
        }
        let uid = registration.uid();
        let gid = registration.gid();
        unsafe {
            command.pre_exec(move || {
                if libc::setgroups(0, std::ptr::null()) != 0
                    || libc::setresgid(gid, gid, gid) != 0
                    || libc::setresuid(uid, uid, uid) != 0
                    || libc::geteuid() == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let guard = ExecGuard::spawn(command)?;
        let pid = guard.pid();
        self.launches.push(Launch {
            role,
            uid: registration.uid(),
            guard,
        });
        Ok(self.launch_payload(request, role, registration.uid(), pid))
    }
    fn launch_payload(&self, request: &Value, role: Role, uid: u32, pid: i32) -> Value {
        json!({"domain":DOMAIN,"kind":"linux-launch","nonce":request["nonce"],"role":role.name(),"uid":uid,"pid":pid,"epoch":self.descriptor.epoch})
    }
    fn probe_launch(&self, launch: &Launch, timeout: std::time::Duration) -> Result<Value, String> {
        let registration = RegistrationStore::open()?.load(launch.uid)?;
        let _lease = launch.guard.lease()?;
        let nonce = crate::io::challenge()?;
        let mut command =
            std::process::Command::new(self.descriptor.tree.join("resources/bin/apex-provenance"));
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .args(["probe-linux-daemon"])
            .arg(registration.data_dir().join("daemon.sock"))
            .arg(launch.guard.pid().to_string())
            .arg(launch.uid.to_string())
            .arg(launch.guard.start().to_string())
            .arg(&nonce)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit());
        let uid = registration.uid();
        let gid = registration.gid();
        unsafe {
            command.pre_exec(move || {
                if libc::setgroups(0, std::ptr::null()) != 0
                    || libc::setresgid(gid, gid, gid) != 0
                    || libc::setresuid(uid, uid, uid) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let output = bounded_probe_output(&mut command, timeout)?;
        let probe: Value = serde_json::from_slice(&output).map_err(|e| e.to_string())?;
        if probe["nonce"] != nonce
            || probe["pid"] != launch.guard.pid()
            || probe["uid"] != uid
            || probe["start"] != launch.guard.start()
            || probe["protocol"] != 1
            || !launch.guard.is_live()
        {
            return Err("Daemon readiness process generation changed".into());
        }
        if probe.get("release") != self.candidate.manifest().nightly_identity().as_ref() {
            return Err("Installed daemon release identity differs from the signed manifest".into());
        }
        Ok(probe)
    }
    pub fn health(&self, peer: &KernelPeer, request: &Value) -> Result<Value, String> {
        peer.validate()?;
        if peer.identity().1 != 0 {
            return Err("Candidate health requires administrator peer".into());
        }
        let state = Activation::restore(&root_file_limit(
            &Path::new(ROOT).join("installation.json"),
            16384,
        )?)?;
        if state.service_descriptor()? != &self.descriptor {
            return Err("Health installation was superseded".into());
        }
        let ready = state.phase() == linux_activation::Phase::Ready;
        let authority_ready = self.admission().is_ok();
        let mut daemons = Vec::new();
        let health_deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        for launch in self
            .launches
            .iter()
            .filter(|l| l.role == Role::Daemon && l.guard.is_live())
        {
            let timeout = health_deadline
                .checked_duration_since(std::time::Instant::now())
                .ok_or("Overall daemon health deadline expired")?
                .min(std::time::Duration::from_secs(3));
            let probe = self.probe_launch(launch, timeout)?;
            daemons.push(json!({"uid":launch.uid,"pid":launch.guard.pid(),"processLive":true,"protocolReady":true,"bootId":probe["bootId"]}));
        }
        let mut health = json!({"domain":DOMAIN,"kind":"linux-health","nonce":Self::nonce(request)?,"epoch":self.descriptor.epoch,"manifestSha256":self.descriptor.manifest_sha256,"protocol":1,"tree":self.descriptor.tree,"brokerInstance":self.instance,"ready":ready,"authorityReady":authority_ready,"daemons":daemons});
        if let Some(release) = self.candidate.manifest().nightly_identity() {
            health["release"] = release;
        }
        Ok(health)
    }
}

/// Fixed read-only same-UID probe executed by the installed broker. It creates
/// no role, receipt, file or registration. Server identity comes from the kernel
/// and is compared with the broker's live supervised process generation.
pub fn probe_daemon(
    socket: &Path,
    pid: i32,
    uid: u32,
    start: u64,
    nonce: &str,
) -> Result<Value, String> {
    use std::{io::Write, os::unix::net::UnixStream, time::Duration};
    if unsafe { libc::geteuid() } != uid || uid == 0 {
        return Err("Daemon probe must run as its enrolled nonroot account".into());
    }
    if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid probe challenge".into());
    }
    let mut stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let peer = KernelPeer::capture(&stream)?;
    if peer.identity().0 != pid
        || peer.identity().1 != uid
        || crate::linux::process_start(&peer.read_proc("stat", 8192)?)? != start
    {
        return Err("Daemon socket is not owned by the supervised installed process".into());
    }
    let id = u64::from_str_radix(&nonce[..16], 16).map_err(|e| e.to_string())?;
    let mut bytes = serde_json::to_vec(&json!({"id":id,"cmd":"hello","args":{"protocol":1}}))
        .map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let response = crate::io::read_frame(&mut stream)?;
    peer.validate()?;
    if response["id"] != id
        || response["ok"]["protocol"] != 1
        || response["ok"]["boot_id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .is_none()
    {
        return Err("Daemon did not complete the challenged installed protocol handshake".into());
    }
    let mut probe = json!({"nonce":nonce,"uid":uid,"pid":pid,"start":start,"protocol":1,"bootId":response["ok"]["boot_id"]});
    if let Some(release) = response["ok"].get("build_identity") {
        probe["release"] = release.clone();
    }
    Ok(probe)
}

fn bounded_probe_output(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, String> {
    use std::{io::Read, os::fd::AsRawFd};
    let mut child = command
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut pipe = child
        .stdout
        .take()
        .ok_or("Missing readiness probe output")?;
    let flags = unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(pipe.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Cannot bound readiness probe output".into());
    }
    let deadline = std::time::Instant::now() + timeout;
    let mut output = Vec::new();
    let mut finished = false;
    loop {
        let mut bytes = [0u8; 1024];
        loop {
            match pipe.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => {
                    output.extend_from_slice(&bytes[..n]);
                    if output.len() > 4096 {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("Readiness probe output exceeds bound".into());
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            }
        }
        if finished {
            return Ok(output);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                finished = true;
                continue;
            }
            Ok(Some(_)) => return Err("Installed daemon readiness probe failed".into()),
            Ok(None) => (),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Installed daemon readiness probe timed out".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}
#[cfg(test)]
mod runtime_tests {
    use super::*;
    #[test]
    fn readiness_subprocess_has_outer_time_and_output_bounds() {
        let mut stalled = std::process::Command::new("/bin/sh");
        stalled.args(["-c", "exec sleep 30"]);
        let start = std::time::Instant::now();
        assert!(
            bounded_probe_output(&mut stalled, std::time::Duration::from_millis(25))
                .unwrap_err()
                .contains("timed out")
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        let mut oversized = std::process::Command::new("/bin/sh");
        oversized.args(["-c", "head -c 8192 /dev/zero"]);
        assert!(
            bounded_probe_output(&mut oversized, std::time::Duration::from_secs(2))
                .unwrap_err()
                .contains("bound")
        );
        let mut valid = std::process::Command::new("/bin/sh");
        valid.args(["-c", "printf valid"]);
        assert_eq!(
            bounded_probe_output(&mut valid, std::time::Duration::from_secs(2)).unwrap(),
            b"valid"
        );
    }
}

/// Notify systemd only after signing state and the protected listener are ready.
/// This value is inherited by the root broker unit, never forwarded to children.
pub fn notify_ready() -> Result<(), String> {
    match std::env::var_os("NOTIFY_SOCKET") {
        Some(socket) => notify_at(&socket),
        None => Ok(()),
    }
}
fn notify_at(socket: &std::ffi::OsStr) -> Result<(), String> {
    use std::os::{
        linux::net::SocketAddrExt,
        unix::{
            ffi::OsStrExt,
            net::{SocketAddr, UnixDatagram},
        },
    };
    let bytes = socket.as_bytes();
    if bytes.is_empty() || bytes.len() > 107 || bytes.contains(&0) {
        return Err("Invalid systemd notify endpoint".into());
    }
    let address = if bytes[0] == b'@' {
        SocketAddr::from_abstract_name(&bytes[1..])
    } else {
        SocketAddr::from_pathname(std::path::Path::new(socket))
    }
    .map_err(|e| e.to_string())?;
    let notify = UnixDatagram::unbound().map_err(|e| e.to_string())?;
    notify.connect_addr(&address).map_err(|e| e.to_string())?;
    if notify.send(b"READY=1").map_err(|e| e.to_string())? != 7 {
        return Err("Incomplete systemd readiness notification".into());
    }
    Ok(())
}
#[cfg(test)]
mod notify_tests {
    #[test]
    fn readiness_notification_uses_the_requested_systemd_datagram_socket() {
        use std::os::unix::net::UnixDatagram;
        let path = std::env::temp_dir().join(format!(
            "apex-notify-{}-{}",
            std::process::id(),
            crate::io::challenge().unwrap()
        ));
        let listener = UnixDatagram::bind(&path).unwrap();
        listener
            .set_read_timeout(Some(std::time::Duration::from_secs(1)))
            .unwrap();
        super::notify_at(path.as_os_str()).unwrap();
        let mut buffer = [0u8; 32];
        let count = listener.recv(&mut buffer).unwrap();
        assert_eq!(&buffer[..count], b"READY=1");
        std::fs::remove_file(path).unwrap();
    }
}
