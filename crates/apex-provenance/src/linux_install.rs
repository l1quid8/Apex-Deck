//! Signed Linux payload validation. No service activation is performed here.
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom};

pub const MANIFEST_LIMIT: usize = 4 * 1024 * 1024;
pub const PAYLOAD_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
pub const FILE_LIMIT: usize = 20_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinuxReleaseManifest {
    pub version: String,
    pub commit: String,
    pub arch: String,
    pub protocol: u32,
    pub evaluation: bool,
    pub archive_size: u64,
    pub archive_sha256: String,
    pub files: Vec<PayloadFile>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PayloadFile {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub mode: u32,
    pub sha256: String,
}

fn verify_with_key<R: Read + Seek>(
    bytes: &[u8],
    signature: &[u8],
    key: &[u8],
    arch: &str,
    evaluation: bool,
    archive: &mut R,
) -> Result<LinuxReleaseManifest, String> {
    if bytes.len() > MANIFEST_LIMIT {
        return Err("Manifest exceeds limit".into());
    }
    UnparsedPublicKey::new(&ED25519, key)
        .verify(bytes, signature)
        .map_err(|_| "Invalid release signature")?;
    let manifest: LinuxReleaseManifest =
        serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if !matches!(arch, "arm64" | "x64") || manifest.arch != arch {
        return Err("Wrong payload architecture".into());
    }
    if manifest.protocol != 1 || manifest.evaluation != evaluation {
        return Err("Incompatible release protocol or trust class".into());
    }
    if manifest.version.is_empty()
        || manifest.version.len() > 64
        || !manifest
            .version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        || manifest.commit.len() != 40
        || !hex(&manifest.commit)
        || manifest.archive_size == 0
        || manifest.archive_size > PAYLOAD_LIMIT
        || manifest.archive_sha256.len() != 64
        || !hex(&manifest.archive_sha256)
        || manifest.files.is_empty()
        || manifest.files.len() > FILE_LIMIT
    {
        return Err("Invalid release bounds or identity".into());
    }
    let mut names = BTreeSet::new();
    let mut total = 0u64;
    for file in &manifest.files {
        if !safe_path(&file.path) || !names.insert(file.path.as_str()) {
            return Err("Unsafe or duplicate manifest path".into());
        }
        if !matches!(file.kind.as_str(), "file" | "directory")
            || !matches!(
                (file.kind.as_str(), file.mode),
                ("file", 0o644 | 0o755) | ("directory", 0o755)
            )
            || (file.kind == "directory" && (file.size != 0 || !file.sha256.is_empty()))
            || (file.kind == "file" && (file.sha256.len() != 64 || !hex(&file.sha256)))
        {
            return Err("Unsafe manifest entry type or mode".into());
        }
        total = total
            .checked_add(file.size)
            .filter(|n| *n <= PAYLOAD_LIMIT)
            .ok_or("Expanded payload exceeds limit")?;
    }
    for file in &manifest.files {
        let mut parent = std::path::Path::new(&file.path).parent();
        while let Some(path) = parent.filter(|p| !p.as_os_str().is_empty()) {
            if !manifest
                .files
                .iter()
                .any(|p| p.path == path.to_str().unwrap_or("") && p.kind == "directory")
            {
                return Err("Unlisted parent directory".into());
            }
            parent = path.parent();
        }
    }
    archive
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;
    let (length, digest) = digest_reader(&mut archive.take(PAYLOAD_LIMIT + 1))?;
    if length != manifest.archive_size || digest != manifest.archive_sha256 {
        return Err("Archive size or digest mismatch".into());
    }
    archive
        .seek(SeekFrom::Start(0))
        .map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(archive);
    let mut seen = BTreeSet::new();
    // Raw iteration exposes extension/link entries instead of silently applying them.
    for entry in tar.entries().map_err(|e| e.to_string())?.raw(true) {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path_bytes = entry.path_bytes();
        let name = std::str::from_utf8(&path_bytes)
            .map_err(|_| "Non UTF-8 archive path")?
            .to_owned();
        if !safe_path(&name) || !seen.insert(name.clone()) {
            return Err("Unsafe or duplicate archive path".into());
        }
        let pin = manifest
            .files
            .iter()
            .find(|f| f.path == name)
            .ok_or("Unlisted archive entry")?;
        let header = entry.header();
        let kind = header.entry_type();
        if !((pin.kind == "file" && kind == tar::EntryType::Regular)
            || (pin.kind == "directory" && kind == tar::EntryType::Directory))
            || header.link_name().map_err(|e| e.to_string())?.is_some()
            || header.mode().map_err(|e| e.to_string())? != pin.mode
            || entry.size() != pin.size
        {
            return Err("Archive entry type, mode or size mismatch".into());
        }
        let (length, digest) = digest_reader(&mut entry)?;
        if length != pin.size || (pin.kind == "file" && digest != pin.sha256) {
            return Err("Payload file digest mismatch".into());
        }
    }
    let rest = tar.into_inner();
    let mut buffer = [0u8; 65536];
    loop {
        let n = rest.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if buffer[..n].iter().any(|b| *b != 0) {
            return Err("Nonzero data after archive terminator".into());
        }
    }
    if seen.len() != manifest.files.len() {
        return Err("Missing payload entries".into());
    }
    Ok(manifest)
}

fn hex(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn safe_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && value.split('/').all(|p| {
            !p.is_empty()
                && p != "."
                && p != ".."
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-+@ ".contains(&b))
        })
}
fn digest_reader(reader: &mut impl Read) -> Result<(u64, String), String> {
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        size += count as u64;
        digest.update(&buffer[..count]);
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

/// The trust root is compiled into the independently provisioned verifier;
/// payloads and runtime environment variables cannot choose it.
pub fn verify_release<R: Read + Seek>(
    bytes: &[u8],
    signature: &[u8],
    archive: &mut R,
) -> Result<LinuxReleaseManifest, String> {
    if !cfg!(feature = "linux-evaluation-verifier") {
        return Err(
            "Linux publisher trust is not provisioned; protected installation disabled".into(),
        );
    }
    let encoded = option_env!("APEX_LINUX_EVALUATION_TRUST_ROOT")
        .ok_or("Linux publisher trust is not provisioned; protected installation disabled")?;
    use base64::Engine;
    let key = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid compiled evaluation trust root")?;
    if key.len() != 32 {
        return Err("Invalid compiled evaluation trust root".into());
    }
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => return Err("Unsupported architecture".into()),
    };
    verify_with_key(bytes, signature, &key, arch, true, archive)
}

/// Refuse symlinks and writable ancestors, including the target itself.
pub fn protected_path(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if path
        .to_str()
        .is_none_or(|p| p.split('/').any(|c| c == "." || c == ".."))
        || !path.is_absolute()
        || path.components().any(|p| {
            !matches!(
                p,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
    {
        return Err("Protected path must be absolute and normalized".into());
    }
    for part in path.ancestors() {
        let meta = std::fs::symlink_metadata(part).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(
                "Protected path requires root ownership without symlinks or writable ancestors"
                    .into(),
            );
        }
    }
    Ok(())
}

/// Stage verified files only. This function never changes an active descriptor,
/// services, signing keys, authority records or user data.
pub fn stage_release(
    manifest_path: &std::path::Path,
    signature_path: &std::path::Path,
    archive_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if unsafe { libc::geteuid() } != 0 {
        return Err("Staging requires explicit administrator installation".into());
    }
    for path in [manifest_path, signature_path, archive_path] {
        protected_path(path)?;
    }
    let bytes = crate::io::root_file_limit(manifest_path, MANIFEST_LIMIT)?;
    let signature = crate::io::root_file_limit(signature_path, 64)?;
    let mut archive = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(archive_path)
        .map_err(|e| e.to_string())?;
    if !archive.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Expected staged regular archive".into());
    }
    let manifest = verify_release(&bytes, &signature, &mut archive)?;
    let parent = std::path::Path::new("/opt/apex-deck");
    protected_path(parent)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let target = parent.join(format!(
        "staging-{}-{}-{}",
        manifest.version,
        manifest.commit,
        &digest[..16]
    ));
    std::fs::DirBuilder::new()
        .create(&target)
        .map_err(|e| e.to_string())?;
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    let result = (|| {
        archive
            .seek(SeekFrom::Start(0))
            .map_err(|e| e.to_string())?;
        // All names, types, sizes and content hashes were checked before mkdir.
        // The input and extraction ancestors are exclusively root-controlled.
        let mut tar = tar::Archive::new(&mut archive);
        let mut directories = manifest
            .files
            .iter()
            .filter(|p| p.kind == "directory")
            .collect::<Vec<_>>();
        directories.sort_by_key(|p| p.path.split('/').count());
        for dir in directories {
            let path = target.join(&dir.path);
            std::fs::create_dir(&path).map_err(|e| e.to_string())?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        for entry in tar.entries().map_err(|e| e.to_string())?.raw(true) {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let name = std::str::from_utf8(&entry.path_bytes())
                .map_err(|e| e.to_string())?
                .to_owned();
            let pin = manifest
                .files
                .iter()
                .find(|f| f.path == name)
                .ok_or("Unlisted extraction entry")?;
            if pin.kind == "directory" {
                continue;
            }
            let mut output = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(target.join(&name))
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
            output
                .set_permissions(std::fs::Permissions::from_mode(pin.mode))
                .and_then(|_| output.sync_all())
                .map_err(|e| e.to_string())?;
        }
        validate_tree(&target, &manifest)?;
        let mut directories = manifest
            .files
            .iter()
            .filter(|p| p.kind == "directory")
            .collect::<Vec<_>>();
        directories.sort_by_key(|p| std::cmp::Reverse(p.path.split('/').count()));
        for dir in directories {
            std::fs::File::open(target.join(&dir.path))
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        std::fs::File::open(&target)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(target.clone())
    })();
    // Retain failed staging for diagnosis; it is never selected for execution.
    result
}

pub fn validate_tree(
    root: &std::path::Path,
    manifest: &LinuxReleaseManifest,
) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    protected_path(root)?;
    fn walk(
        root: &std::path::Path,
        path: &std::path::Path,
        manifest: &LinuxReleaseManifest,
        seen: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            protected_path(&path)?;
            let name = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("Invalid installed path")?
                .to_owned();
            let pin = manifest
                .files
                .iter()
                .find(|p| p.path == name)
                .ok_or("Unlisted installed file")?;
            let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if meta.mode() & 0o7777 != pin.mode {
                return Err("Installed permission mismatch".into());
            }
            if pin.kind == "directory" && meta.is_dir() {
                walk(root, &path, manifest, seen)?;
            } else if pin.kind == "file" && meta.is_file() && meta.nlink() == 1 {
                let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
                let (size, digest) = digest_reader(&mut file)?;
                if size != pin.size || digest != pin.sha256 {
                    return Err("Installed file digest mismatch".into());
                }
            } else {
                return Err("Installed file type mismatch".into());
            }
            seen.insert(name);
        }
        Ok(())
    }
    let mut seen = BTreeSet::new();
    walk(root, root, manifest, &mut seen)?;
    if seen.len() != manifest.files.len() {
        return Err("Missing installed file".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    use std::io::Cursor;

    fn fixture() -> (crate::Signed, Vec<u8>, Vec<u8>) {
        let key = crate::new_key().unwrap();
        let data = b"verified executable";
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_ustar();
        header.set_size(data.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "apex-deck", &data[..])
            .unwrap();
        let archive = builder.into_inner().unwrap();
        let manifest = LinuxReleaseManifest {
            version: "0.9.9".into(),
            commit: "a".repeat(40),
            arch: "arm64".into(),
            protocol: 1,
            evaluation: true,
            archive_size: archive.len() as u64,
            archive_sha256: format!("{:x}", Sha256::digest(&archive)),
            files: vec![PayloadFile {
                path: "apex-deck".into(),
                kind: "file".into(),
                size: data.len() as u64,
                mode: 0o755,
                sha256: format!("{:x}", Sha256::digest(data)),
            }],
        };
        (
            crate::sign(&key, &serde_json::to_value(manifest).unwrap()).unwrap(),
            key.public_key().as_ref().to_vec(),
            archive,
        )
    }
    fn check(
        signed: &crate::Signed,
        key: &[u8],
        archive: &[u8],
        arch: &str,
    ) -> Result<LinuxReleaseManifest, String> {
        use base64::Engine;
        verify_with_key(
            signed.payload.as_bytes(),
            &base64::engine::general_purpose::STANDARD
                .decode(&signed.signature)
                .unwrap(),
            key,
            arch,
            true,
            &mut Cursor::new(archive),
        )
    }
    #[test]
    fn signed_payload_is_verified() {
        let (signed, key, archive) = fixture();
        assert_eq!(
            check(&signed, &key, &archive, "arm64").unwrap().commit,
            "a".repeat(40)
        );
    }
    #[test]
    fn forged_signature_is_rejected_before_parsing_archive() {
        let (mut signed, key, archive) = fixture();
        signed.payload.push(' ');
        assert!(check(&signed, &key, &archive, "arm64")
            .unwrap_err()
            .contains("signature"));
    }
    #[test]
    fn wrong_architecture_is_rejected() {
        let (signed, key, archive) = fixture();
        assert!(check(&signed, &key, &archive, "x64")
            .unwrap_err()
            .contains("architecture"));
    }
    #[test]
    fn archive_substitution_is_rejected() {
        let (signed, key, mut archive) = fixture();
        archive[512] ^= 1;
        assert!(check(&signed, &key, &archive, "arm64")
            .unwrap_err()
            .contains("digest"));
    }
    #[test]
    fn payload_cannot_supply_its_own_key() {
        let (signed, _, archive) = fixture();
        let foreign = crate::new_key().unwrap();
        assert!(
            check(&signed, foreign.public_key().as_ref(), &archive, "arm64")
                .unwrap_err()
                .contains("signature")
        );
    }
    fn resigned(
        signed: &crate::Signed,
        change: impl FnOnce(&mut serde_json::Value),
    ) -> (crate::Signed, Vec<u8>) {
        let key = crate::new_key().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&signed.payload).unwrap();
        change(&mut value);
        (
            crate::sign(&key, &value).unwrap(),
            key.public_key().as_ref().to_vec(),
        )
    }
    #[test]
    fn manifest_rejects_paths_types_modes_duplicates_and_self_supplied_keys() {
        let (signed, _, archive) = fixture();
        for path in [
            "/escape",
            "../escape",
            "a/../escape",
            "a//b",
            "./apex-deck",
            "a\\b",
            "a\u{0}b",
        ] {
            let (changed, key) = resigned(&signed, |v| v["files"][0]["path"] = path.into());
            assert!(check(&changed, &key, &archive, "arm64").is_err(), "{path}");
        }
        for mode in [0o777, 0o4755, 0o2755, 0o666] {
            let (changed, key) = resigned(&signed, |v| v["files"][0]["mode"] = mode.into());
            assert!(check(&changed, &key, &archive, "arm64").is_err());
        }
        for kind in ["symlink", "hardlink", "device", "fifo"] {
            let (changed, key) = resigned(&signed, |v| v["files"][0]["kind"] = kind.into());
            assert!(check(&changed, &key, &archive, "arm64").is_err());
        }
        let (changed, key) = resigned(&signed, |v| {
            let f = v["files"][0].clone();
            v["files"].as_array_mut().unwrap().push(f);
        });
        assert!(check(&changed, &key, &archive, "arm64").is_err());
        let (changed, key) = resigned(&signed, |v| v["publicKey"] = "self supplied".into());
        assert!(check(&changed, &key, &archive, "arm64").is_err());
    }
    #[test]
    fn signed_inventory_must_match_file_contents() {
        let (signed, _, archive) = fixture();
        let (changed, key) = resigned(&signed, |v| v["files"][0]["sha256"] = "0".repeat(64).into());
        assert!(check(&changed, &key, &archive, "arm64")
            .unwrap_err()
            .contains("digest"));
    }
    #[test]
    fn signed_archive_cannot_smuggle_entries_or_links() {
        let (signed, _, original) = fixture();
        for kind in [
            tar::EntryType::Regular,
            tar::EntryType::Symlink,
            tar::EntryType::Link,
            tar::EntryType::Fifo,
        ] {
            let mut builder = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_ustar();
            header.set_size(0);
            header.set_mode(0o755);
            header.set_entry_type(kind);
            header.set_cksum();
            builder
                .append_data(&mut header, "apex-deck", &[][..])
                .unwrap();
            let archive = builder.into_inner().unwrap();
            let (changed, key) = resigned(&signed, |v| {
                v["archiveSha256"] = format!("{:x}", Sha256::digest(&archive)).into();
                v["archiveSize"] = (archive.len() as u64).into();
            });
            assert!(check(&changed, &key, &archive, "arm64").is_err());
        }
        // Concatenate an extra raw entry before the tar terminator; even a
        // correctly signed outer digest cannot authorize an unlisted path.
        let mut extra = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_ustar();
        header.set_size(0);
        header.set_mode(0o644);
        header.set_cksum();
        extra.append_data(&mut header, "extra", &[][..]).unwrap();
        let extra = extra.into_inner().unwrap();
        for name in ["extra", "apex-deck"] {
            let mut archive = original[..1024].to_vec();
            let mut header = extra[..512].to_vec();
            header[..100].fill(0);
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[148..156].fill(b' ');
            let sum: u32 = header.iter().map(|b| *b as u32).sum();
            header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
            archive.extend(header);
            archive.extend([0; 1024]);
            let (changed, key) = resigned(&signed, |v| {
                v["archiveSha256"] = format!("{:x}", Sha256::digest(&archive)).into();
                v["archiveSize"] = (archive.len() as u64).into();
            });
            assert!(check(&changed, &key, &archive, "arm64").is_err(), "{name}");
        }
    }
    #[test]
    fn evaluation_release_cannot_enter_production_trust() {
        let (signed, key, archive) = fixture();
        use base64::Engine;
        assert!(verify_with_key(
            signed.payload.as_bytes(),
            &base64::engine::general_purpose::STANDARD
                .decode(signed.signature)
                .unwrap(),
            &key,
            "arm64",
            false,
            &mut Cursor::new(archive)
        )
        .is_err());
    }
    #[test]
    fn user_writable_ancestor_is_rejected_without_changing_authority() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        assert!(protected_path(&dir)
            .unwrap_err()
            .contains("writable ancestors"));
    }
    #[test]
    fn relative_and_unnormalized_install_roots_are_refused() {
        for path in ["relative", "/opt/../tmp", "/opt/./apex-deck"] {
            // Path::components normalizes interior '.', so explicitly check it
            // at the public API boundary as well.
            assert!(protected_path(std::path::Path::new(path)).is_err());
        }
    }
    #[test]
    fn ordinary_account_cannot_stage_privileged_files() {
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let missing = std::path::Path::new("/does-not-exist");
        assert!(stage_release(missing, missing, missing)
            .unwrap_err()
            .contains("administrator"));
    }
}
