//! What changed in a chat's folder since the chat began, read with git.
//! The starting point is a snapshot of the working tree written as a git
//! tree through a private copy of the index, so the person's staging area,
//! branches and stash never change.

use std::path::{Path, PathBuf};
use std::process::Command;

use apex_core::{ChangeRecord, FileChange, ParticipantId};
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct ThreadDiff { pub files: Vec<DiffFile>, pub note: Option<String> }
#[derive(Debug, Serialize, PartialEq)]
pub struct DiffFile { pub path: String, pub added: usize, pub removed: usize, pub patch: String, pub by: Vec<ParticipantId> }


fn git(cwd: &Path, index: Option<&Path>, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(cwd).args(["-c", "core.quotePath=false"]).args(args);
    if let Some(path) = crate::agents::login_path() { command.env("PATH", path); }
    if let Some(index) = index { command.env("GIT_INDEX_FILE", index); }
    let out = command.output().map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Write the whole working tree (tracked and untracked, minus ignored files)
/// as a git tree and return its id.
pub fn snapshot(cwd: &Path) -> Result<String, String> {
    let real = PathBuf::from(git(cwd, None, &["rev-parse", "--path-format=absolute", "--git-path", "index"])?.trim());
    let temp: PathBuf = std::env::temp_dir().join(format!("apex-deck-index-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    // Starting from the real index means only changed files are re-read.
    if real.exists() {
        std::fs::copy(&real, &temp).map_err(|e| format!("could not copy the git index: {e}"))?;
    }
    let result = git(cwd, Some(&temp), &["add", "-A", "--", ":/"])
        .and_then(|_| git(cwd, Some(&temp), &["write-tree"]));
    let _ = std::fs::remove_file(&temp);
    result.map(|tree| tree.trim().to_string())
}

/// Split `git diff` output into one patch per file, named by its new path,
/// or by its old path when the file was deleted.
pub fn split_patch(patch: &str) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = Vec::new();
    for line in patch.lines() {
        if let Some(header) = line.strip_prefix("diff --git ") {
            let path = header.split_once(" b/").map_or(header, |(_, b)| b);
            files.push((path.to_string(), String::new()));
        }
        if let Some((path, body)) = files.last_mut() {
            if let Some(new_path) = line.strip_prefix("+++ b/") { *path = new_path.strip_suffix('\t').unwrap_or(new_path).to_string(); }
            body.push_str(line);
            body.push('\n');
        }
    }
    files
}

// Adapter reports may use absolute paths or a leading ./.
fn normalized_path(cwd: &Path, path: &str) -> PathBuf {
    let raw = Path::new(path);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { cwd.join(raw) };
    let mut normalized = PathBuf::new();
    for component in joined.components() {
        match component {
            std::path::Component::CurDir => {},
            std::path::Component::ParentDir => { normalized.pop(); },
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// Everyone who reported changing `path`, in the order they first did.
fn who_changed(cwd: &Path, path: &str, records: &[ChangeRecord]) -> Vec<ParticipantId> {
    let mut by: Vec<ParticipantId> = Vec::new();
    for r in records.iter().filter(|r| normalized_path(cwd, &r.path) == normalized_path(cwd, path)) {
        if !by.contains(&r.by) { by.push(r.by.clone()); }
    }
    by
}

/// The models' own reports, one entry per file, when git can't help.
fn reported(records: &[ChangeRecord], note: &str) -> ThreadDiff {
    let mut files: Vec<DiffFile> = Vec::new();
    for r in records {
        match files.iter_mut().find(|f| f.path == r.path) {
            Some(f) => { f.added += r.added; f.removed += r.removed; if !f.by.contains(&r.by) { f.by.push(r.by.clone()); } }
            None => files.push(DiffFile { path: r.path.clone(), added: r.added, removed: r.removed, patch: String::new(), by: vec![r.by.clone()] }),
        }
    }
    ThreadDiff { files, note: Some(note.to_string()) }
}

pub fn thread_diff(cwd: &Path, baseline: Option<&str>, records: &[ChangeRecord]) -> ThreadDiff {
    if git(cwd, None, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return reported(records, "This folder isn't a git repository, so this lists only the edits the models reported. Files changed by commands aren't included.");
    }
    let Some(start) = baseline else {
        return reported(records, "This thread starts tracking the folder with your next message. Until then, this lists only the edits the models reported.");
    };
    if git(cwd, None, &["cat-file", "-e", &format!("{start}^{{tree}}")]).is_err() {
        return reported(records, "The starting snapshot is gone (git cleaned it up), so this lists only the edits the models reported.");
    }
    let patch = match snapshot(cwd).and_then(|now| git(cwd, None, &["diff", "--no-color", "--no-ext-diff", "--no-renames", "--relative", start, &now])) {
        Ok(patch) => patch,
        Err(error) => return reported(records, &format!("git could not compare the folder ({error}), so this lists only the edits the models reported.")),
    };
    let files = split_patch(&patch).into_iter().map(|(path, patch)| {
        let counted = FileChange::new(path.clone(), patch.clone());
        DiffFile { by: who_changed(cwd, &path, records), added: counted.added, removed: counted.removed, path, patch }
    }).collect();
    ThreadDiff { files, note: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{ChangeRecord, ParticipantId};
    use std::process::Command;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-diff-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        for args in [&["init", "-q"][..], &["config", "user.email", "t@t"], &["config", "user.name", "t"]] {
            assert!(Command::new("git").arg("-C").arg(&dir).args(args).status().unwrap().success());
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
        Command::new("git").arg("-C").arg(&dir).args(["add", "-A"]).status().unwrap();
        Command::new("git").arg("-C").arg(&dir).args(["commit", "-qm", "init"]).status().unwrap();
        dir
    }

    fn record(by: &str, path: &str) -> ChangeRecord {
        ChangeRecord { by: ParticipantId::new(by), path: path.into(), added: 1, removed: 0, seq: 1 }
    }

    #[test]
    fn diff_since_start_includes_new_files_attributes_them_and_leaves_git_alone() {
        let dir = repo();
        std::fs::write(dir.join("staged.txt"), "s\n").unwrap();
        Command::new("git").arg("-C").arg(&dir).args(["add", "staged.txt"]).status().unwrap();
        let status_before = Command::new("git").arg("-C").arg(&dir).args(["status", "--porcelain"]).output().unwrap().stdout;

        let start = snapshot(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new file.txt"), "hi\n").unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join("target/out"), "ignored\n").unwrap();

        let diff = thread_diff(&dir, Some(&start), &[record("jigga", "a.txt")]);
        assert_eq!(diff.note, None);
        let paths: Vec<_> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "new file.txt"]);
        assert_eq!(diff.files[0].by, vec![ParticipantId::new("jigga")]);
        assert_eq!((diff.files[0].added, diff.files[0].removed), (1, 1));
        assert!(diff.files[1].by.is_empty());

        // The person's staging area and status are untouched (apart from the files we wrote).
        std::fs::remove_file(dir.join("new file.txt")).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        let status_after = Command::new("git").arg("-C").arg(&dir).args(["status", "--porcelain"]).output().unwrap().stdout;
        assert_eq!(String::from_utf8_lossy(&status_before), String::from_utf8_lossy(&status_after).replace("?? target/\n", ""));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nested_folder_captures_untracked_baseline_and_normalizes_report_paths() {
        let dir = repo();
        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("initial.txt"), "before\n").unwrap();
        let index = std::fs::read(dir.join(".git/index")).unwrap();
        let start = snapshot(&nested).unwrap();
        std::fs::write(nested.join("initial.txt"), "after\n").unwrap();
        std::fs::write(dir.join("outside.txt"), "outside\n").unwrap();
        let absolute = nested.join("initial.txt").to_string_lossy().into_owned();
        let diff = thread_diff(&nested, Some(&start), &[record("a", &absolute), record("b", "./initial.txt")]);
        assert_eq!(diff.note, None);
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "initial.txt");
        assert_eq!((diff.files[0].added, diff.files[0].removed), (1, 1));
        assert_eq!(diff.files[0].by, [ParticipantId::new("a"), ParticipantId::new("b")]);
        assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_repository_lists_reported_edits_with_a_note() {
        let dir = std::env::temp_dir().join(format!("apex-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(snapshot(&dir).is_err());
        let diff = thread_diff(&dir, None, &[record("null", "x.rs"), record("jigga", "x.rs")]);
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].by, vec![ParticipantId::new("null"), ParticipantId::new("jigga")]);
        assert_eq!(diff.files[0].patch, "");
        assert!(diff.note.unwrap().contains("isn't a git repository"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_baseline_object_falls_back_with_a_note() {
        let dir = repo();
        let diff = thread_diff(&dir, Some("0123456789012345678901234567890123456789"), &[record("a", "a.txt")]);
        assert_eq!(diff.files.len(), 1);
        assert!(diff.note.unwrap().contains("starting snapshot is gone"));
        let diff = thread_diff(&dir, None, &[]);
        assert!(diff.note.unwrap().contains("next message"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn split_patch_names_files_by_their_new_path_and_old_path_when_deleted() {
        let patch = "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n\
diff --git a/gone.rs b/gone.rs\ndeleted file mode 100644\n--- a/gone.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
        let files = split_patch(patch);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "x.rs");
        assert!(files[0].1.ends_with("+b\n"));
        assert_eq!(files[1].0, "gone.rs");
        assert_eq!(split_patch(""), vec![]);
    }
}
