//! Records which commit this build came from, so a UI talking to an older
//! background service can tell the builds apart. Never fails the build: with
//! no git (a tarball, say), the commit is "unknown" and the tree is clean.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Runs git in `dir`; `None` if git is missing or the command fails.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(dir).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()));

    let commit = git(&manifest, &["rev-parse", "--short=12", "HEAD"]).filter(|s| !s.is_empty()).unwrap_or_else(|| "unknown".into());
    let dirty = git(&manifest, &["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());

    println!("cargo:rustc-env=APEX_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=APEX_BUILD_DIRTY={}", if dirty { "true" } else { "false" });

    // Rebuild when the checked-out commit or the index changes. Paths that
    // don't exist would make cargo rerun this script every time, so skip them.
    let mut watched = vec!["HEAD".to_string(), "index".to_string()];
    if let Some(reference) = git(&manifest, &["symbolic-ref", "-q", "HEAD"]).filter(|s| !s.is_empty()) {
        watched.push(reference);
    }
    for name in watched {
        let Some(path) = git(&manifest, &["rev-parse", "--git-path", &name]).filter(|s| !s.is_empty()) else {
            continue;
        };
        let path = PathBuf::from(path);
        let path = if path.is_absolute() { path } else { manifest.join(path) };
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
