//! Explicit administrator ceremony. The desktop request supplies a scope only;
//! kernel credentials supply identity and the administrator's terminal consent.
use crate::{
    channel::{LINUX_ENROLL as SOCKET, LINUX_RUNTIME},
    linux::KernelPeer,
    linux_registration::{EnrollmentConsent, LinuxRegistration, RegistrationStore},
};
use serde::Deserialize;
use std::{
    io::{BufRead, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const DISCLOSURE: &str = "On Linux, unrestricted programs under the same account can inject into or automate the trusted UI. This cannot provide macOS dynamic code-signature guarantees.";

pub fn parse_request(value: &serde_json::Value) -> Result<PathBuf, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        op: String,
        data_dir: PathBuf,
    }
    let request: Request = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    let text = request.data_dir.to_str().ok_or("Scope must be UTF-8")?;
    if request.op != "enroll"
        || !request.data_dir.is_absolute()
        || text.len() > 4096
        || text.chars().any(char::is_control)
    {
        return Err("Invalid enrollment scope request".into());
    }
    Ok(request.data_dir)
}

pub fn confirm(uid: u32, lingering: bool, answer: &str) -> Result<EnrollmentConsent, String> {
    let suffix = if lingering {
        "ALLOW LINGER"
    } else {
        "NO LINGER"
    };
    let expected = format!("ENROLL {uid} ACCEPT SAME-ACCOUNT LIMIT {suffix}");
    if answer != expected {
        return Err("Administrator confirmation did not match; no enrollment saved".into());
    }
    EnrollmentConsent::new(uid, uid, true, lingering, lingering)
}

/// No elevation, environment UID inference, or unattended confirmation option.
pub fn administrator() -> Result<(), String> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::geteuid() } != 0 {
        return Err("Enrollment listener requires an explicit administrator terminal".into());
    }
    crate::linux_install::protected_path(Path::new(LINUX_RUNTIME))?;
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .map_err(|_| "Enrollment requires a controlling administrator terminal")?;
    if unsafe { libc::isatty(tty.as_raw_fd()) } != 1 {
        return Err("Enrollment requires an administrator terminal".into());
    }
    let store = RegistrationStore::open()?;
    // Bind must fail if an earlier ceremony has not been explicitly recovered.
    let listener = UnixListener::bind(SOCKET).map_err(|e| e.to_string())?;
    crate::linux::enable_credentials(listener.as_raw_fd())?;
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(SOCKET);
        }
    }
    let _cleanup = Cleanup;
    std::fs::set_permissions(SOCKET, std::fs::Permissions::from_mode(0o666))
        .map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    writeln!(tty, "Waiting up to 60 seconds for the desktop account to run apex-provenance request-linux-enrollment DATA_DIR").map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(value) => break value,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(e) => return Err(format!("Enrollment accept failed or timed out: {e}")),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let peer = KernelPeer::capture(&stream)?;
        let folder = parse_request(&peer.read_request(&stream)?)?;
        let registration = LinuxRegistration::from_peer(&peer, &folder)?;
        let uid = registration.uid();
        let lingering = crate::linux_registration::lingering(uid)?;
        let suffix = if lingering {
            "ALLOW LINGER"
        } else {
            "NO LINGER"
        };
        writeln!(tty, "Desktop kernel UID: {uid}\nCanonical scope: {}\n{DISCLOSURE}\nExisting linger: {lingering}. No linger setting will be changed.\nType exactly: ENROLL {uid} ACCEPT SAME-ACCOUNT LIMIT {suffix}", folder.display()).map_err(|e| e.to_string())?;
        tty.flush().map_err(|e| e.to_string())?;
        let mut answer = String::new();
        std::io::BufReader::new((&tty).take(256))
            .read_line(&mut answer)
            .map_err(|e| e.to_string())?;
        let answer = answer.strip_suffix('\n').unwrap_or(&answer);
        let consent = confirm(uid, lingering, answer)?;
        peer.validate()?;
        let saved = store.enroll(&peer, &folder, consent)?;
        Ok::<_, String>(
            serde_json::json!({"enrolled":true,"uid":saved.uid(),"dataDir":saved.data_dir()}),
        )
    })();
    let response = match &result {
        Ok(value) => value.clone(),
        Err(error) => serde_json::json!({"error":error}),
    };
    writeln!(stream, "{response}").map_err(|e| e.to_string())?;
    result.map(|_| ())
}

pub fn request(folder: &Path) -> Result<(), String> {
    if unsafe { libc::geteuid() } == 0 {
        return Err(
            "Run the enrollment request as the ordinary desktop account, never root".into(),
        );
    }
    let value = serde_json::json!({"op":"enroll","dataDir":folder});
    parse_request(&value)?;
    crate::linux_install::protected_path(Path::new(LINUX_RUNTIME))?;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let stat = std::fs::symlink_metadata(SOCKET).map_err(|e| e.to_string())?;
    if stat.uid() != 0 || !stat.file_type().is_socket() {
        return Err("Enrollment socket is not administrator-owned".into());
    }
    let mut stream = UnixStream::connect(SOCKET).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(180)))
        .map_err(|e| e.to_string())?;
    writeln!(stream, "{value}").map_err(|e| e.to_string())?;
    let reply = crate::io::read_frame(&mut stream)?;
    if let Some(error) = reply["error"].as_str() {
        return Err(error.into());
    }
    if reply["enrolled"] != true
        || reply["uid"].as_u64() != Some(unsafe { libc::geteuid() } as u64)
        || reply["dataDir"].as_str() != folder.to_str()
    {
        return Err("Enrollment response does not match desktop request".into());
    }
    println!("Administrator saved enrollment for {}", folder.display());
    Ok(())
}
