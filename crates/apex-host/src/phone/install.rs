//! The pinned AXe download that drives the shared phone's screen.
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub const AXE_VERSION: &str = "1.8.0";
pub const AXE_URL: &str = "https://github.com/cameroncooke/AXe/releases/download/v1.8.0/AXe-macOS-v1.8.0-universal.tar.gz";
pub const AXE_SHA256: &str = "7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834";

const DOWNLOAD_LIMIT: Duration = Duration::from_secs(120);
const UNPACK_LIMIT: Duration = Duration::from_secs(60);

pub fn axe_dir(data: &Path) -> PathBuf {
    data.join("tools").join(format!("axe-{AXE_VERSION}"))
}

pub fn verify(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    if format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        Err("The phone tool download didn't match its fingerprint, so it wasn't installed.".into())
    }
}

fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// The path to `axe`, downloading and unpacking the pinned release the first time.
pub async fn ensure(data: &Path) -> Result<PathBuf, String> {
    let dir = axe_dir(data);
    let axe = dir.join("axe");
    if is_file(&axe) {
        return Ok(axe);
    }
    let part = data.join("tools").join(format!("axe-{AXE_VERSION}.part"));
    let installed = install(&dir, &part).await;
    if installed.is_err() {
        let _ = tokio::fs::remove_dir_all(&part).await;
    }
    installed?;
    Ok(axe)
}

async fn install(dir: &Path, part: &Path) -> Result<(), String> {
    let download = |e: reqwest::Error| format!("Couldn't download the phone tool: {e}");
    let bytes = reqwest::Client::builder()
        .timeout(DOWNLOAD_LIMIT)
        .build()
        .map_err(download)?
        .get(AXE_URL)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(download)?
        .bytes()
        .await
        .map_err(download)?;
    verify(&bytes, AXE_SHA256)?;

    let disk = |e: std::io::Error| format!("Couldn't install the phone tool: {e}");
    match tokio::fs::remove_dir_all(part).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(disk(e)),
        _ => {}
    }
    tokio::fs::create_dir_all(part).await.map_err(disk)?;
    let archive = part.join("axe.tgz");
    tokio::fs::write(&archive, &bytes).await.map_err(disk)?;

    let unpack = tokio::process::Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(part)
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(UNPACK_LIMIT, unpack)
        .await
        .map_err(|_| "Unpacking the phone tool took too long.".to_string())?
        .map_err(disk)?;
    if !output.status.success() || !is_file(&part.join("axe")) {
        return Err("Couldn't unpack the phone tool.".into());
    }

    tokio::fs::remove_file(&archive).await.map_err(disk)?;
    // A folder here has no `axe` in it, so it is a broken earlier install.
    match tokio::fs::remove_dir_all(dir).await {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(disk(e)),
        _ => {}
    }
    tokio::fs::rename(part, dir).await.map_err(disk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_pinned_download_is_accepted() {
        // sha256("abc")
        assert_eq!(
            verify(
                b"abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            ),
            Ok(())
        );
        assert_eq!(
            verify(
                b"abd",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
            )
            .unwrap_err(),
            "The phone tool download didn't match its fingerprint, so it wasn't installed."
        );
    }

    #[test]
    fn axe_lives_under_tools() {
        assert_eq!(
            axe_dir(Path::new("/d")),
            PathBuf::from("/d/tools/axe-1.8.0")
        );
    }
}
