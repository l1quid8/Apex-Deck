//! Which commit this binary was built from; the values come from build.rs.

/// The short commit hash, or "unknown" when the build had no git.
pub fn commit() -> &'static str {
    env!("APEX_BUILD_COMMIT")
}

/// Whether the build had uncommitted changes to tracked files.
pub fn dirty() -> bool {
    env!("APEX_BUILD_DIRTY") == "true"
}

/// `apex-daemon <version> (<commit>[-dirty])`, as `--version` prints it.
pub fn version_line() -> String {
    let dirty = if dirty() { "-dirty" } else { "" };
    format!("apex-daemon {} ({}{dirty})", env!("CARGO_PKG_VERSION"), commit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_names_the_version_and_the_build() {
        let line = version_line();
        assert!(line.starts_with(&format!("apex-daemon {} (", env!("CARGO_PKG_VERSION"))), "{line}");
        assert!(line.ends_with(&format!("{}{})", commit(), if dirty() { "-dirty" } else { "" })), "{line}");
    }

    #[test]
    fn commit_is_a_short_hash_or_unknown() {
        let commit = commit();
        assert!(commit == "unknown" || (commit.len() == 12 && commit.chars().all(|c| c.is_ascii_hexdigit())), "{commit}");
    }
}
