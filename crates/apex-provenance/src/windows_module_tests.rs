//! Real filesystem/ACL/signature regressions. Run elevated on native Windows.
use super::*;

const SERVICE: &str = "S-1-5-80-1-2-3-4-5";

fn privilege(name: &str) {
    let mut raw = ptr::null_mut();
    assert_ne!(
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES,
                &mut raw,
            )
        },
        0
    );
    let token = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut luid = unsafe { std::mem::zeroed() };
    assert_ne!(
        unsafe { LookupPrivilegeValueW(ptr::null(), wide(name).as_ptr(), &mut luid) },
        0
    );
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    unsafe { SetLastError(0) };
    assert_ne!(
        unsafe {
            AdjustTokenPrivileges(
                token.as_raw_handle(),
                0,
                &privileges,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        },
        0
    );
    assert_eq!(unsafe { GetLastError() }, 0, "requires elevated {name}");
}

fn acl(path: &Path, owner: &str, extra: &str) {
    let desc = descriptor(&format!(
        "O:{owner}G:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA){extra}"
    ))
    .unwrap();
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    assert_ne!(
        unsafe {
            SetFileSecurityW(
                name.as_ptr(),
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                desc.0,
            )
        },
        0,
        "{}: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
}

struct Fixture {
    base: PathBuf,
    file: PathBuf,
}
impl Fixture {
    fn new(name: &str) -> Self {
        privilege("SeRestorePrivilege");
        let base = program_files()
            .unwrap()
            .join(format!("Apex-DLL-test-{}-{name}", std::process::id()));
        secure_directory(&base, false).unwrap();
        let file = base.join("module.dll");
        // This Windows component is catalog-signed. Copying preserves its
        // signed hash while allowing independent owner/ACL tests.
        let source = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        std::fs::copy(source, &file).unwrap();
        acl(&file, ADMIN, "");
        Self { base, file }
    }
    fn accepted(&self) -> bool {
        let result = verify_module(self.file.to_str().unwrap());
        if let Err(reason) = &result {
            eprintln!("{reason}");
        }
        result.is_ok()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.base).unwrap();
    }
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn signed_service_owned_module_in_protected_tree_is_accepted() {
    let fixture = Fixture::new("service");
    acl(&fixture.file, SERVICE, &format!("(A;;FA;;;{SERVICE})"));
    acl(&fixture.base, SERVICE, &format!("(A;OICI;FA;;;{SERVICE})"));
    assert!(
        fixture.accepted(),
        "a protected signed service-owned DLL must work"
    );
    assert!(
        protected_handle(&File::open(&fixture.file).unwrap()).is_err(),
        "service ownership must never extend to authority files"
    );
}

#[test]
#[ignore = "requires elevated Windows and PowerShell 7; windows-dll-safety CI"]
fn embedded_signed_service_module_works_but_tampered_bytes_are_refused() {
    use std::io::{Seek, SeekFrom};
    let fixture = Fixture::new("embedded");
    let source = program_files().unwrap().join(r"PowerShell\7\pwsh.exe");
    std::fs::copy(source, &fixture.file).unwrap();
    acl(&fixture.file, SERVICE, &format!("(A;;FA;;;{SERVICE})"));
    assert_eq!(
        embedded_module_signature(&File::open(&fixture.file).unwrap(), &fixture.file),
        0,
        "fixture must have a valid embedded signature"
    );
    assert!(fixture.accepted());
    let mut bytes = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&fixture.file)
        .unwrap();
    bytes.seek(SeekFrom::Start(0x50)).unwrap();
    let mut value = [0u8];
    bytes.read_exact(&mut value).unwrap();
    value[0] ^= 1;
    bytes.seek(SeekFrom::Start(0x50)).unwrap();
    bytes.write_all(&value).unwrap();
    drop(bytes);
    assert!(
        !fixture.accepted(),
        "valid owner/ACL cannot excuse a damaged signature"
    );
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn unsigned_service_owned_module_is_refused() {
    let fixture = Fixture::new("unsigned");
    std::fs::write(&fixture.file, b"unsigned module").unwrap();
    acl(&fixture.file, SERVICE, "");
    assert!(!fixture.accepted());
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn signed_user_owned_module_is_refused() {
    let fixture = Fixture::new("user");
    acl(&fixture.file, &current_sid().unwrap(), "");
    assert!(!fixture.accepted());
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn signed_module_in_user_writable_folder_is_refused() {
    let fixture = Fixture::new("folder");
    acl(&fixture.base, ADMIN, "(A;;FA;;;BU)");
    assert!(
        !fixture.accepted(),
        "a protected file in a replaceable folder must fail"
    );
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn unusual_deny_is_conservative_but_unusual_allow_is_refused() {
    let fixture = Fixture::new("ace");
    acl(
        &fixture.file,
        ADMIN,
        "(OD;;FW;11111111-1111-1111-1111-111111111111;;BU)",
    );
    assert!(
        fixture.accepted(),
        "object deny must not make a protected DLL fail"
    );
    acl(
        &fixture.file,
        ADMIN,
        "(OA;;FW;11111111-1111-1111-1111-111111111111;;BU)",
    );
    assert!(!fixture.accepted(), "unknown granting ACE must fail closed");
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn checked_module_replaced_at_same_path_is_rechecked() {
    let fixture = Fixture::new("replacement");
    assert!(fixture.accepted());
    std::fs::rename(&fixture.file, fixture.base.join("previous.dll")).unwrap();
    std::fs::write(&fixture.file, b"replacement").unwrap();
    acl(&fixture.file, &current_sid().unwrap(), "(A;;FA;;;BU)");
    assert!(
        !fixture.accepted(),
        "a path-only cache must not trust a replacement"
    );
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn previously_safe_ancestor_becoming_writable_is_refused() {
    let fixture = Fixture::new("ancestor-changed");
    assert!(fixture.accepted());
    acl(&fixture.base, ADMIN, "(A;;FA;;;BU)");
    assert!(!fixture.accepted());
}

#[test]
#[ignore = "requires elevated Windows; windows-dll-safety CI"]
fn protected_windows_process_passes_full_peer_check() {
    // Production runs as SYSTEM. CI uses an elevated debug privilege to inspect
    // the closed child without relaxing the child's production process ACL.
    privilege("SeDebugPrivilege");
    let image = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join(r"System32\ping.exe");
    let mut child = std::process::Command::new(image)
        .args(["-n", "30", "127.0.0.1"])
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let result = (|| {
        assert!(
            peer_intact(child.id()).is_err(),
            "unprotected process must fail"
        );
        protect_process(child.id())?;
        // Wait for the loader before asking PSAPI to enumerate its images.
        let mut last = Err("Windows process did not finish loading".to_owned());
        for _ in 0..50 {
            last = peer_intact(child.id());
            if last.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        last
    })();
    child.kill().unwrap();
    child.wait().unwrap();
    result.unwrap();
}

#[test]
fn only_specific_service_sids_qualify() {
    assert!(service_sid(SERVICE));
    for sid in [
        "S-1-5-80-0",
        "S-1-5-80-1",
        "S-1-5-80-1-2-3-4-5-6",
        "S-1-5-80-1-2-3-4-4294967296",
        "S-1-5-80-1-2-3-4-+5",
        "S-1-5-21-1-2-3-4-5",
    ] {
        assert!(!service_sid(sid), "{sid}");
    }
}
