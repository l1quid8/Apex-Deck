#![cfg(target_os = "linux")]
use apex_provenance::linux_enroll::{confirm, parse_request};

#[test]
fn enrollment_request_cannot_supply_identity_or_consent() {
    assert_eq!(
        parse_request(&serde_json::json!({"op":"enroll","dataDir":"/home/dev/deck"}))
            .unwrap()
            .to_str(),
        Some("/home/dev/deck")
    );
    for request in [
        serde_json::json!({"op":"enroll","dataDir":"/home/dev/deck","uid":1000}),
        serde_json::json!({"op":"enroll","dataDir":"/home/dev/deck","consent":true}),
        serde_json::json!({"op":"enroll","dataDir":"/home/dev/\u{1b}[2J"}),
        serde_json::json!({"op":"enroll","dataDir":"relative"}),
        serde_json::json!({"op":"issue","dataDir":"/home/dev/deck"}),
    ] {
        assert!(parse_request(&request).is_err(), "{request}");
    }
}

#[test]
fn administrator_confirmation_binds_uid_disclosure_and_linger_explicitly() {
    let expected = "ENROLL 1000 ACCEPT SAME-ACCOUNT LIMIT NO LINGER";
    assert!(confirm(1000, false, expected).is_ok());
    assert!(confirm(1000, true, expected).is_err());
    assert!(confirm(
        1000,
        true,
        "ENROLL 1000 ACCEPT SAME-ACCOUNT LIMIT ALLOW LINGER"
    )
    .is_ok());
    for bad in [
        "yes",
        "ENROLL 1001 ACCEPT SAME-ACCOUNT LIMIT NO LINGER",
        "ENROLL 1000 NO LINGER",
        "",
        "ENROLL 0 ACCEPT SAME-ACCOUNT LIMIT NO LINGER",
    ] {
        assert!(confirm(1000, false, bad).is_err());
    }
    assert!(confirm(0, false, "ENROLL 0 ACCEPT SAME-ACCOUNT LIMIT NO LINGER").is_err());
}

#[test]
#[ignore = "creates fixed authority paths; disposable root Linux container only"]
fn administrator_terminal_enrolls_kernel_peer_and_preserves_rejected_scope() {
    use std::{
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                fs::{MetadataExt, PermissionsExt},
                process::CommandExt,
            },
        },
        path::Path,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    assert_eq!(unsafe { libc::geteuid() }, 0);
    let root = Path::new(apex_provenance::ROOT);
    assert!(
        !root.exists(),
        "fixture requires absent authority; never removes existing state"
    );
    let binary = env!("CARGO_BIN_EXE_apex-provenance");
    assert!(Command::new(binary)
        .arg("initialize-linux-authority")
        .status()
        .unwrap()
        .success());
    let owner = std::fs::metadata("/home/dev").unwrap();
    let uid = owner.uid();
    let gid = owner.gid();
    let folder = format!("/home/dev/apex-enroll-fixture-{}", std::process::id());
    std::fs::create_dir(&folder).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    let c = std::ffi::CString::new(folder.clone()).unwrap();
    assert_eq!(unsafe { libc::chown(c.as_ptr(), uid, gid) }, 0);
    fn ceremony(binary: &str, folder: &str, answer: &str, uid: u32, gid: u32) -> (bool, bool) {
        let (mut master, mut slave) = (-1, -1);
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        let mut master = unsafe { std::fs::File::from_raw_fd(master) };
        let slave = unsafe { std::fs::File::from_raw_fd(slave) };
        let mut command = Command::new(binary);
        command.arg("enroll-linux").stdin(Stdio::from(slave));
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut administrator = command.spawn().unwrap();
        unsafe {
            libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
        }
        let wait = |master: &mut std::fs::File, wanted: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut text = String::new();
            while Instant::now() < deadline {
                let mut bytes = [0; 4096];
                match master.read(&mut bytes) {
                    Ok(n) => text.push_str(&String::from_utf8_lossy(&bytes[..n])),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => (),
                    Err(e) => panic!("terminal read: {e}: {text}"),
                }
                if text.contains(wanted) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("terminal missing {wanted}: {text}");
        };
        wait(&mut master, "Waiting up to");
        let mut requester = Command::new(binary);
        requester.args(["request-linux-enrollment", folder]);
        requester.uid(uid).gid(gid);
        let mut requester = requester.spawn().unwrap();
        wait(&mut master, "Type exactly:");
        writeln!(master, "{answer}").unwrap();
        (
            administrator.wait().unwrap().success(),
            requester.wait().unwrap().success(),
        )
    }
    assert_eq!(ceremony(binary, &folder, "no", uid, gid), (false, false));
    assert!(
        apex_provenance::linux_registration::RegistrationStore::open()
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ceremony(
            binary,
            &folder,
            &format!("ENROLL {uid} ACCEPT SAME-ACCOUNT LIMIT NO LINGER"),
            uid,
            gid
        ),
        (true, true)
    );
    let registration = apex_provenance::linux_registration::RegistrationStore::open()
        .unwrap()
        .load(uid)
        .unwrap();
    assert_eq!(registration.data_dir(), Path::new(&folder));
    assert_eq!(registration.uid(), uid);
    std::fs::remove_dir_all(&folder).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
