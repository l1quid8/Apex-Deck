//! "Restart to update", the broker's part: one request file, nothing run.
//!
//! Only the pinned trusted UI may ask (main.rs). The broker checks the
//! request's shape, adds the kernel-verified uid, and drops one JSON file into a
//! root-only queue. launchd starts the root update job (scripts/upgrade.py,
//! `queue` mode) whenever that queue is not empty, and the job checks the
//! package's signature, version and checksum itself before anything is
//! replaced. The broker never opens the package and never starts a process.
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::{
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

/// Largest package the job will copy; the same limit is in upgrade.py.
pub const PACKAGE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const FIELDS: [&str; 5] = ["op", "version", "package", "sha256", "size"];

#[derive(Debug, Clone, PartialEq)]
pub struct UpdateRequest {
    pub version: String,
    pub package: String,
    pub sha256: String,
    pub size: u64,
}

/// Where the queue and the job live. Fixed in production; tests pass their own
/// folder and their own uid as the owner.
pub struct Paths {
    pub upgrades: PathBuf,
    pub service: PathBuf,
    pub updater: PathBuf,
    pub owner: u32,
}

impl Paths {
    pub fn system() -> Self {
        Paths {
            upgrades: "/Library/Application Support/Apex Deck Upgrade".into(),
            service: "/Library/LaunchDaemons/dev.apexdeck.update.plist".into(),
            updater: Path::new(crate::ROOT)
                .join("TrustedUI/Apex Deck.app/Contents/Resources/updater/upgrade.py"),
            owner: 0,
        }
    }
    fn queue(&self) -> PathBuf {
        self.upgrades.join("queue")
    }
}

fn version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn parse_request(value: &Value) -> Result<UpdateRequest, String> {
    let object = value.as_object().ok_or("Malformed update request")?;
    if object.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err("Malformed update request".into());
    }
    let text = |key: &str| value[key].as_str().ok_or(format!("Missing update {key}"));
    let request = UpdateRequest {
        version: text("version")?.to_string(),
        package: text("package")?.to_string(),
        sha256: text("sha256")?.to_string(),
        size: value["size"].as_u64().ok_or("Missing update size")?,
    };
    if !version(&request.version) {
        return Err("Invalid update version".into());
    }
    let package = &request.package;
    if !package.starts_with('/')
        || !package.ends_with(".pkg")
        || package.len() > 1024
        || package.contains("/../")
        || package.chars().any(char::is_control)
    {
        return Err("Invalid update package path".into());
    }
    if request.sha256.len() != 64
        || !request
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid update checksum".into());
    }
    if request.size == 0 || request.size > PACKAGE_LIMIT {
        return Err("Invalid update size".into());
    }
    Ok(request)
}

/// A random v4 UUID: names the job, its backup and the result Deck looks for.
pub fn new_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Could not generate an update id")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// The request as upgrade.py's read_request expects it, byte for byte in shape.
pub fn document(id: &str, uid: u32, request: &UpdateRequest) -> Value {
    json!({"id":id,"version":request.version,"package":request.package,"sha256":request.sha256,"size":request.size,"uid":uid})
}

fn closed(path: &Path, owner: u32, private: bool) -> Result<std::fs::Metadata, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| "missing".to_string())?;
    let open = if private { 0o077 } else { 0o022 };
    if meta.file_type().is_symlink() || meta.uid() != owner || meta.mode() & open != 0 {
        return Err(format!("{} is not protected", path.display()));
    }
    Ok(meta)
}

/// Queue `request` for the update job, refusing while another one is queued or
/// running, or while an earlier install is waiting to be inspected.
pub fn queue(paths: &Paths, uid: u32, id: &str, request: &UpdateRequest) -> Result<(), String> {
    if uid < 500 {
        return Err("Updates are installed for a signed-in person only".into());
    }
    let ready = closed(&paths.service, paths.owner, false).is_ok_and(|m| m.is_file())
        && closed(&paths.updater, paths.owner, false).is_ok_and(|m| m.is_file());
    if !ready {
        return Err("This Mac's protected install has no updater yet. Install this version once from its package; later updates install themselves.".into());
    }
    closed(&paths.upgrades, paths.owner, true)
        .and_then(|_| closed(&paths.queue(), paths.owner, true))
        .map_err(|e| format!("The update queue is unavailable: {e}"))?;
    if std::fs::read_dir(paths.queue())
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("An update is already being installed.".into());
    }
    if std::fs::symlink_metadata(paths.upgrades.join("install.lock")).is_ok() {
        return Err("An earlier upgrade stopped partway and needs to be checked before another can install.".into());
    }
    let bytes = serde_json::to_vec(&document(id, uid, request)).map_err(|e| e.to_string())?;
    // Written beside the queue, then moved in whole: launchd starts the job the
    // moment the queue is not empty, so it must never see a half-written file.
    let pending = paths.upgrades.join(format!(".{id}.request"));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    let written = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) =
        written.and_then(|_| std::fs::rename(&pending, paths.queue().join(format!("{id}.json"))))
    {
        let _ = std::fs::remove_file(&pending);
        return Err(error.to_string());
    }
    std::fs::File::open(paths.queue())
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn good() -> Value {
        json!({"op":"update_install","version":"0.9.1","package":"/Users/a/Library/Caches/dev.apexdeck.desktop/updates/Apex-Deck-0.9.1-arm64.pkg","sha256":"f".repeat(64),"size":123})
    }

    fn fixture() -> (PathBuf, Paths) {
        let base = std::env::temp_dir().join(format!("apex-update-{}", new_id().unwrap()));
        std::fs::create_dir_all(base.join("upgrades/queue")).unwrap();
        for dir in ["upgrades", "upgrades/queue"] {
            std::fs::set_permissions(base.join(dir), std::fs::Permissions::from_mode(0o700))
                .unwrap();
        }
        std::fs::write(base.join("update.plist"), "plist").unwrap();
        std::fs::write(base.join("upgrade.py"), "job").unwrap();
        for file in ["update.plist", "upgrade.py"] {
            std::fs::set_permissions(base.join(file), std::fs::Permissions::from_mode(0o644))
                .unwrap();
        }
        let paths = Paths {
            upgrades: base.join("upgrades"),
            service: base.join("update.plist"),
            updater: base.join("upgrade.py"),
            owner: unsafe { libc::geteuid() },
        };
        (base, paths)
    }

    #[test]
    fn requests_with_any_unexpected_shape_are_refused() {
        assert_eq!(parse_request(&good()).unwrap().version, "0.9.1");
        let mut extra = good();
        extra["uid"] = json!(0);
        assert!(
            parse_request(&extra).is_err(),
            "the uid comes from the kernel, never the request"
        );
        for (field, bad) in [
            ("version", json!("1")),
            ("version", json!("1.0-beta")),
            ("version", json!("1.0;rm")),
            ("package", json!("relative.pkg")),
            ("package", json!("/x/../../etc/passwd.pkg")),
            ("package", json!("/x/app.dmg")),
            ("package", json!("/x/line\nbreak.pkg")),
            ("sha256", json!("F".repeat(64))),
            ("sha256", json!("f".repeat(63))),
            ("size", json!(0)),
            ("size", json!(-1)),
            ("size", json!(PACKAGE_LIMIT + 1)),
            ("size", json!("123")),
        ] {
            let mut value = good();
            value[field] = bad;
            assert!(
                parse_request(&value).is_err(),
                "{field} accepted {}",
                value[field]
            );
        }
    }

    #[test]
    fn ids_are_distinct_v4_uuids() {
        let (a, b) = (new_id().unwrap(), new_id().unwrap());
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
        assert!("89ab".contains(&a[19..20]));
    }

    #[test]
    fn a_request_lands_whole_in_the_queue_and_a_second_waits_for_the_first() {
        let (base, paths) = fixture();
        let request = parse_request(&good()).unwrap();
        let id = new_id().unwrap();
        queue(&paths, 501, &id, &request).unwrap();
        let queued = paths.queue().join(format!("{id}.json"));
        let written: Value = serde_json::from_slice(&std::fs::read(&queued).unwrap()).unwrap();
        assert_eq!(written, document(&id, 501, &request));
        assert_eq!(std::fs::metadata(&queued).unwrap().mode() & 0o777, 0o600);
        assert_eq!(
            std::fs::read_dir(&paths.upgrades).unwrap().count(),
            1,
            "no pending file left behind"
        );
        let again = queue(&paths, 501, &new_id().unwrap(), &request).unwrap_err();
        assert!(again.contains("already being installed"), "{again}");
        std::fs::remove_file(&queued).unwrap();
        std::fs::create_dir(paths.upgrades.join("install.lock")).unwrap();
        assert!(queue(&paths, 501, &new_id().unwrap(), &request)
            .unwrap_err()
            .contains("needs to be checked"));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn nothing_is_queued_without_the_update_service_or_for_system_users() {
        let (base, paths) = fixture();
        let request = parse_request(&good()).unwrap();
        assert!(queue(&paths, 0, &new_id().unwrap(), &request).is_err());
        std::fs::remove_file(&paths.updater).unwrap();
        assert!(queue(&paths, 501, &new_id().unwrap(), &request)
            .unwrap_err()
            .contains("no updater yet"));
        std::fs::write(&paths.updater, "job").unwrap();
        std::fs::set_permissions(&paths.updater, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(
            queue(&paths, 501, &new_id().unwrap(), &request).is_err(),
            "a writable updater is not trusted"
        );
        std::fs::set_permissions(&paths.updater, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::set_permissions(paths.queue(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(queue(&paths, 501, &new_id().unwrap(), &request)
            .unwrap_err()
            .contains("queue is unavailable"));
        assert_eq!(std::fs::read_dir(paths.queue()).unwrap().count(), 0);
        std::fs::remove_dir_all(base).unwrap();
    }
}
