use crate::host::MAX_WORKSPACE_READ;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};

const MAX_IMAGE: u64 = 5 * 1024 * 1024;
const TEXT_PROBE: usize = 8 * 1024;
const MAX_FIND_FILES: usize = 50_000;
const MAX_SEARCH_HITS: usize = 500;
const MAX_SEARCH_FILE: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Hit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreview {
    Text {
        text: String,
        size: u64,
        truncated: bool,
        version: String,
        /// False when the path itself is a symbolic link, which `write` refuses.
        editable: bool,
    },
    Image {
        mime: String,
        data: String,
        size: u64,
    },
    Binary {
        size: u64,
    },
    TooLarge {
        size: u64,
    },
}

fn has_git_component(path: &Path) -> bool {
    path.components()
        .any(|part| matches!(part, Component::Normal(name) if name == ".git"))
}

/// Resolve a project path inside the canonical root. Symlinks that escape the
/// project and every path inside Git's own metadata are refused.
fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("Could not open project folder: {e}"))?;
    if !root.is_dir() {
        return Err("The project folder is not a directory.".into());
    }
    if has_git_component(path) {
        return Err("Files inside .git are not available here.".into());
    }
    let target = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let target = target
        .canonicalize()
        .map_err(|e| format!("Could not open file: {e}"))?;
    if !target.starts_with(&root) {
        return Err("That path is outside the project folder.".into());
    }
    if has_git_component(&target.strip_prefix(&root).unwrap_or(&target)) {
        return Err("Files inside .git are not available here.".into());
    }
    Ok(target)
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name == ".git"
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err("Use a name without path separators.".into());
    }
    Ok(())
}

fn reject_symlink(root: &Path, path: &Path) -> Result<(), String> {
    let target = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    if fs::symlink_metadata(target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("File operations on symbolic links are not supported.".into());
    }
    Ok(())
}

fn entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn checked_parent(root: &Path, parent: &Path) -> Result<PathBuf, String> {
    let parent = inside(root, parent)?;
    if !parent.is_dir() {
        return Err("The destination is not a folder.".into());
    }
    Ok(parent)
}

pub fn create(root: &Path, parent: &Path, name: &str, folder: bool) -> Result<String, String> {
    validate_name(name)?;
    let parent = checked_parent(root, parent)?;
    let target = parent.join(name);
    if entry_exists(&target) {
        return Err("A file or folder with that name already exists.".into());
    }
    if folder {
        fs::create_dir(&target)
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map(|_| ())
    }
    .map_err(|error| format!("Could not create it: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn rename(root: &Path, path: &Path, new_name: &str) -> Result<String, String> {
    validate_name(new_name)?;
    reject_symlink(root, path)?;
    let path = inside(root, path)?;
    if path == root.canonicalize().map_err(|e| e.to_string())? {
        return Err("The project root cannot be renamed.".into());
    }
    let parent = path.parent().ok_or("That path has no parent folder.")?;
    checked_parent(root, parent)?;
    let target = parent.join(new_name);
    if entry_exists(&target) {
        return Err("A file or folder with that name already exists.".into());
    }
    fs::rename(path, &target).map_err(|error| format!("Could not rename it: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

pub fn duplicate(root: &Path, path: &Path) -> Result<String, String> {
    reject_symlink(root, path)?;
    let path = inside(root, path)?;
    if path == root.canonicalize().map_err(|e| e.to_string())? {
        return Err("The project root cannot be duplicated.".into());
    }
    if !path.is_file() {
        return Err("Only files can be duplicated.".into());
    }
    let parent = path.parent().ok_or("That path has no parent folder.")?;
    checked_parent(root, parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("That file name is not supported.")?;
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, Some(ext)),
        _ => (name, None),
    };
    for index in 1..=10_000 {
        let suffix = if index == 1 {
            " copy".to_string()
        } else {
            format!(" copy {index}")
        };
        let copied = match extension {
            Some(ext) => format!("{stem}{suffix}.{ext}"),
            None => format!("{stem}{suffix}"),
        };
        let target = parent.join(copied);
        if !entry_exists(&target) {
            let mut source =
                File::open(&path).map_err(|error| format!("Could not duplicate it: {error}"))?;
            let mut destination = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| format!("Could not duplicate it: {error}"))?;
            std::io::copy(&mut source, &mut destination)
                .map_err(|error| format!("Could not duplicate it: {error}"))?;
            return Ok(target.to_string_lossy().into_owned());
        }
    }
    Err("Could not find an available copy name.".into())
}

pub fn trash(root: &Path, path: &Path) -> Result<(), String> {
    reject_symlink(root, path)?;
    let path = inside(root, path)?;
    if path == root.canonicalize().map_err(|e| e.to_string())? {
        return Err("The project root cannot be moved to Trash.".into());
    }
    trash::delete(&path).map_err(|error| format!("Could not move it to Trash: {error}"))
}

/// Identifies one state of a file: modification time in nanoseconds plus size.
fn file_version(metadata: &fs::Metadata) -> String {
    let nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{nanos}-{}", metadata.len())
}

/// Replace the text of an existing regular file. `expected` is the version the
/// editor last saw; a different current version returns `"changed-on-disk"`.
/// The new content goes to a temp file in the same folder and is renamed over
/// the target, so a crash never leaves a half-written file.
pub fn write(root: &Path, path: &Path, text: &str, expected: Option<&str>) -> Result<String, String> {
    reject_symlink(root, path)?;
    let target = inside(root, path)?;
    let metadata = fs::symlink_metadata(&target).map_err(|e| format!("Could not open file: {e}"))?;
    if !metadata.is_file() {
        return Err("That path is not a file.".into());
    }
    if text.len() as u64 > MAX_WORKSPACE_READ {
        return Err("File is too large to edit here.".into());
    }
    if let Some(expected) = expected {
        if file_version(&metadata) != expected {
            return Err("changed-on-disk".into());
        }
    }
    let parent = target.parent().ok_or("That file has no folder.")?;
    let name = target.file_name().and_then(|n| n.to_str()).ok_or("Bad file name.")?;
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nonce = format!(
        "{:x}{:x}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let temp = parent.join(format!(".{name}.apexdeck-{nonce}"));
    let result = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(text.as_bytes())?;
        fs::set_permissions(&temp, metadata.permissions())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &target)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not save file: {error}"));
    }
    let saved = fs::metadata(&target).map_err(|e| format!("Could not read file: {e}"))?;
    Ok(file_version(&saved))
}

pub fn read(root: &Path, path: &Path) -> Result<FilePreview, String> {
    let editable = reject_symlink(root, path).is_ok();
    let path = inside(root, path)?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("Could not read file: {e}"))?;
    if !metadata.is_file() {
        return Err("That path is not a file.".into());
    }
    let size = metadata.len();
    let version = file_version(&metadata);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    };
    if let Some(mime) = mime {
        if size > MAX_IMAGE {
            return Ok(FilePreview::TooLarge { size });
        }
        let mut file = File::open(path).map_err(|e| format!("Could not read image: {e}"))?;
        let mut bytes = Vec::with_capacity(size as usize);
        file.by_ref()
            .take(MAX_IMAGE + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Could not read image: {e}"))?;
        if bytes.len() as u64 > MAX_IMAGE {
            return Ok(FilePreview::TooLarge {
                size: size.max(bytes.len() as u64),
            });
        }
        return Ok(FilePreview::Image {
            mime: mime.into(),
            data: STANDARD.encode(bytes),
            size,
        });
    }
    let file = File::open(path).map_err(|e| format!("Could not read file: {e}"))?;
    let mut bytes = Vec::with_capacity((size.min(MAX_WORKSPACE_READ + 1)) as usize);
    file.take(MAX_WORKSPACE_READ + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read file: {e}"))?;
    let probe = &bytes[..bytes.len().min(TEXT_PROBE)];
    if probe.contains(&0) {
        return Ok(FilePreview::Binary { size });
    }
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        let truncated = size > MAX_WORKSPACE_READ;
        let mut end = text.len().min(MAX_WORKSPACE_READ as usize);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        return Ok(FilePreview::Text {
            text: text[..end].to_string(),
            size,
            truncated,
            version,
            editable,
        });
    }
    // A cap may cut a multi-byte character. Only accept a prefix that decodes
    // cleanly when the original is known to be longer than the read cap.
    if size > MAX_WORKSPACE_READ {
        for end in (MAX_WORKSPACE_READ as usize - 4..=MAX_WORKSPACE_READ as usize).rev() {
            if let Ok(text) = std::str::from_utf8(&bytes[..end]) {
                if !text.as_bytes()[..text.len().min(TEXT_PROBE)].contains(&0) {
                    return Ok(FilePreview::Text {
                        text: text.to_string(),
                        size,
                        truncated: true,
                        version,
                        editable,
                    });
                }
            }
        }
    }
    Ok(FilePreview::Binary { size })
}

fn is_git_repo(root: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn git(root: &Path, args: &[&std::ffi::OsStr]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))
}

fn project_files(root: &Path) -> Result<Vec<String>, String> {
    if is_git_repo(root) {
        let output = git(
            root,
            &[
                "ls-files".as_ref(),
                "-co".as_ref(),
                "--exclude-standard".as_ref(),
                "-z".as_ref(),
            ],
        )?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        return Ok(String::from_utf8_lossy(&output.stdout)
            .split('\0')
            .filter(|path| !path.is_empty() && !has_git_component(Path::new(path)))
            .map(str::to_string)
            .take(MAX_FIND_FILES)
            .collect());
    }
    let mut files = Vec::new();
    walk_files(root, root, &mut files)?;
    Ok(files)
}

fn skipped_dir(name: &std::ffi::OsStr) -> bool {
    [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".venv",
        "__pycache__",
    ]
    .iter()
    .any(|skip| name == std::ffi::OsStr::new(skip))
}

fn walk_files(root: &Path, folder: &Path, files: &mut Vec<String>) -> Result<(), String> {
    if files.len() >= MAX_FIND_FILES {
        return Ok(());
    }
    let entries =
        fs::read_dir(folder).map_err(|error| format!("Could not list project files: {error}"))?;
    for item in entries {
        if files.len() >= MAX_FIND_FILES {
            break;
        }
        let item = item.map_err(|error| format!("Could not list project files: {error}"))?;
        let ty = item
            .file_type()
            .map_err(|error| format!("Could not inspect project file: {error}"))?;
        if ty.is_symlink() {
            continue;
        }
        let name = item.file_name();
        let path = item.path();
        if ty.is_dir() {
            if !skipped_dir(&name) {
                walk_files(root, &path, files)?;
            }
        } else if ty.is_file() {
            if name != ".DS_Store" {
                if let Ok(path) = path.strip_prefix(root) {
                    files.push(path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    Ok(())
}

fn match_score(path: &str, query: &str) -> Option<i32> {
    let path_lower = path.to_lowercase();
    let query_lower = query.to_lowercase();
    let chars: Vec<char> = path_lower.chars().collect();
    let needle: Vec<char> = query_lower.chars().collect();
    let mut positions = Vec::with_capacity(needle.len());
    let mut cursor = 0;
    for ch in needle {
        let found = chars[cursor..]
            .iter()
            .position(|candidate| *candidate == ch)?
            + cursor;
        positions.push(found);
        cursor = found + 1;
    }
    let name_start = path_lower.rfind('/').map_or(0, |index| index + 1);
    let mut score = if positions.iter().all(|index| *index >= name_start) {
        100
    } else {
        0
    };
    for (i, position) in positions.iter().enumerate() {
        if i > 0 && *position == positions[i - 1] + 1 {
            score += 10;
        }
        if *position == 0 || !chars[*position - 1].is_alphanumeric() {
            score += 6;
        }
    }
    Some(score)
}

pub fn find(root: &Path, query: &str, limit: usize) -> Result<Vec<String>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not open project folder: {error}"))?;
    if !root.is_dir() {
        return Err("The project folder is not a directory.".into());
    }
    if query.trim().is_empty() {
        return Err("Enter a file name to find.".into());
    }
    let query = query.trim();
    let mut matches: Vec<(i32, String)> = project_files(&root)?
        .into_iter()
        .filter_map(|path| match_score(&path, query).map(|score| (score, path)))
        .collect();
    matches.sort_by(|(score_a, path_a), (score_b, path_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| path_a.len().cmp(&path_b.len()))
            .then_with(|| path_a.cmp(path_b))
    });
    Ok(matches
        .into_iter()
        .take(limit.min(100))
        .map(|(_, path)| path)
        .collect())
}

fn hit_text(line: &str, query: &str, case_sensitive: bool) -> String {
    if line.chars().count() <= 240 {
        return line.trim().to_string();
    }
    let haystack = if case_sensitive {
        line.to_string()
    } else {
        line.to_lowercase()
    };
    let needle = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let start = haystack.find(&needle).unwrap_or(0);
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let char_start = chars
        .iter()
        .position(|(offset, _)| *offset >= start)
        .unwrap_or(0);
    let from = char_start.saturating_sub(100);
    let to = (from + 240).min(chars.len());
    let byte_start = chars.get(from).map_or(0, |(offset, _)| *offset);
    let byte_end = chars.get(to).map_or(line.len(), |(offset, _)| *offset);
    let part = line[byte_start..byte_end].trim();
    if from > 0 {
        format!("…{part}")
    } else {
        part.to_string()
    }
}

fn valid_query(query: &str) -> Result<&str, String> {
    let query = query.trim();
    if query.is_empty() {
        Err("Enter text to search for.".into())
    } else {
        Ok(query)
    }
}

pub fn search(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    folder: Option<&Path>,
) -> Result<SearchResult, String> {
    let query = valid_query(query)?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not open project folder: {error}"))?;
    if !root.is_dir() {
        return Err("The project folder is not a directory.".into());
    }
    let scoped = if let Some(folder) = folder {
        let folder = inside(&root, folder)?;
        if !folder.is_dir() {
            return Err("Search scope must be a folder.".into());
        }
        Some(folder)
    } else {
        None
    };
    if is_git_repo(&root) {
        return search_git(&root, query, case_sensitive, scoped.as_deref());
    }
    search_walk(
        &root,
        scoped.as_deref().unwrap_or(&root),
        query,
        case_sensitive,
    )
}

fn search_git(
    root: &Path,
    query: &str,
    case_sensitive: bool,
    folder: Option<&Path>,
) -> Result<SearchResult, String> {
    let mut args: Vec<std::ffi::OsString> = [
        "grep",
        "-n",
        "-I",
        "--no-color",
        "--untracked",
        "--exclude-standard",
        "-F",
    ]
    .iter()
    .map(std::ffi::OsString::from)
    .collect();
    if !case_sensitive {
        args.push("-i".into());
    }
    args.push("-e".into());
    args.push(query.into());
    args.push("--".into());
    if let Some(folder) = folder {
        let relative = folder
            .strip_prefix(root)
            .map_err(|_| "Search folder is outside the project.".to_string())?;
        args.push(if relative.as_os_str().is_empty() {
            ".".into()
        } else {
            relative.as_os_str().to_owned()
        });
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(&args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run Git search: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Could not read Git search results.")?;
    let mut hits = Vec::new();
    let mut truncated = false;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("Could not read Git search results: {error}"))?;
        if hits.len() >= MAX_SEARCH_HITS {
            truncated = true;
            let _ = child.kill();
            break;
        }
        if let Some(hit) = parse_git_hit(&line, query, case_sensitive) {
            hits.push(hit);
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() && output.status.code() != Some(1) && !truncated {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(SearchResult { hits, truncated })
}

fn parse_git_hit(line: &str, query: &str, case_sensitive: bool) -> Option<Hit> {
    let (path, rest) = line.split_once(':')?;
    let (line_number, text) = rest.split_once(':')?;
    let line_number = line_number.parse().ok()?;
    Some(Hit {
        path: path.to_string(),
        line: line_number,
        text: hit_text(text, query, case_sensitive),
    })
}

fn search_walk(
    root: &Path,
    folder: &Path,
    query: &str,
    case_sensitive: bool,
) -> Result<SearchResult, String> {
    let mut paths = Vec::new();
    walk_files(root, folder, &mut paths)?;
    let mut hits = Vec::new();
    let mut truncated = false;
    'files: for path in paths {
        let absolute = root.join(&path);
        let metadata = match fs::metadata(&absolute) {
            Ok(meta) if meta.len() <= MAX_SEARCH_FILE => meta,
            _ => continue,
        };
        let _ = metadata;
        let bytes = match fs::read(&absolute) {
            Ok(bytes) if bytes.len() as u64 <= MAX_SEARCH_FILE => bytes,
            _ => continue,
        };
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            let matches = if case_sensitive {
                line.contains(query)
            } else {
                line.to_lowercase().contains(&query.to_lowercase())
            };
            if matches {
                if hits.len() >= MAX_SEARCH_HITS {
                    truncated = true;
                    break 'files;
                }
                hits.push(Hit {
                    path: path.clone(),
                    line: index.saturating_add(1).min(u32::MAX as usize) as u32,
                    text: hit_text(line, query, case_sensitive),
                });
            }
        }
    }
    Ok(SearchResult { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("apex-project-files-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn text_version(temp: &Temp, name: &str) -> String {
        match read(&temp.0, Path::new(name)).unwrap() {
            FilePreview::Text { version, .. } => version,
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn write_replaces_text_and_returns_the_new_version() {
        let temp = Temp::new();
        fs::write(temp.0.join("a.txt"), "one").unwrap();
        let before = text_version(&temp, "a.txt");
        let after = write(&temp.0, Path::new("a.txt"), "two!", Some(&before)).unwrap();
        assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "two!");
        assert_eq!(after, text_version(&temp, "a.txt"));
        assert_ne!(before, after);
    }

    #[test]
    fn write_refuses_a_stale_version_and_leaves_the_file_alone() {
        let temp = Temp::new();
        fs::write(temp.0.join("a.txt"), "one").unwrap();
        let error = write(&temp.0, Path::new("a.txt"), "two", Some("0-0")).unwrap_err();
        assert_eq!(error, "changed-on-disk");
        assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "one");
        write(&temp.0, Path::new("a.txt"), "two", None).unwrap();
        assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "two");
    }

    #[test]
    fn write_refuses_git_missing_files_and_oversize_text() {
        let temp = Temp::new();
        fs::create_dir(temp.0.join(".git")).unwrap();
        fs::write(temp.0.join(".git/config"), "private").unwrap();
        assert!(write(&temp.0, Path::new(".git/config"), "x", None).is_err());
        assert!(write(&temp.0, Path::new("missing.txt"), "x", None).is_err());
        assert!(!temp.0.join("missing.txt").exists());
        fs::write(temp.0.join("a.txt"), "one").unwrap();
        let big = "x".repeat(MAX_WORKSPACE_READ as usize + 1);
        assert_eq!(
            write(&temp.0, Path::new("a.txt"), &big, None).unwrap_err(),
            "File is too large to edit here."
        );
        assert_eq!(fs::read_to_string(temp.0.join("a.txt")).unwrap(), "one");
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_escaping_symlinks_keeps_permissions_and_leaves_no_temp() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let temp = Temp::new();
        let outside = Temp::new();
        fs::write(outside.0.join("secret.txt"), "secret").unwrap();
        symlink(outside.0.join("secret.txt"), temp.0.join("link.txt")).unwrap();
        assert!(write(&temp.0, Path::new("link.txt"), "x", None).is_err());
        assert_eq!(fs::read_to_string(outside.0.join("secret.txt")).unwrap(), "secret");

        fs::write(temp.0.join("run.sh"), "#!/bin/sh").unwrap();
        fs::set_permissions(temp.0.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        write(&temp.0, Path::new("run.sh"), "#!/bin/sh\necho", None).unwrap();
        let mode = fs::metadata(temp.0.join("run.sh")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);

        // A folder in place of the file makes the rename fail; no temp may remain.
        fs::create_dir(temp.0.join("dir")).unwrap();
        assert!(write(&temp.0, Path::new("dir"), "x", None).is_err());
        let leftovers: Vec<_> = fs::read_dir(&temp.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".apexdeck-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_file_reads_but_is_not_editable() {
        let temp = Temp::new();
        fs::write(temp.0.join("real.txt"), "hi").unwrap();
        std::os::unix::fs::symlink(temp.0.join("real.txt"), temp.0.join("link.txt")).unwrap();
        let FilePreview::Text { editable, .. } = read(&temp.0, Path::new("link.txt")).unwrap() else {
            panic!("expected text")
        };
        assert!(!editable);
    }

    #[test]
    fn reads_text_and_truncates_at_a_character_boundary() {
        let temp = Temp::new();
        fs::write(temp.0.join("hello.md"), "hello").unwrap();
        assert_eq!(
            read(&temp.0, Path::new("hello.md")).unwrap(),
            FilePreview::Text {
                text: "hello".into(),
                size: 5,
                truncated: false,
                version: match read(&temp.0, Path::new("hello.md")).unwrap() {
                    FilePreview::Text { version, .. } => version,
                    _ => unreachable!(),
                },
                editable: true,
            }
        );
        let source = format!("{}é", "x".repeat(MAX_WORKSPACE_READ as usize - 1));
        fs::write(temp.0.join("large.txt"), source.as_bytes()).unwrap();
        let FilePreview::Text {
            text, truncated, ..
        } = read(&temp.0, Path::new("large.txt")).unwrap()
        else {
            panic!("expected text")
        };
        assert!(truncated);
        assert_eq!(text.len(), MAX_WORKSPACE_READ as usize - 1);
        assert!(text.is_char_boundary(text.len()));
    }

    #[test]
    fn detects_binary_images_and_oversize_images() {
        let temp = Temp::new();
        fs::write(temp.0.join("binary.dat"), [0, 1, 2]).unwrap();
        fs::write(temp.0.join("picture.png"), [137, 80, 78, 71]).unwrap();
        fs::write(temp.0.join("large.webp"), vec![1; MAX_IMAGE as usize + 1]).unwrap();
        assert_eq!(
            read(&temp.0, Path::new("binary.dat")).unwrap(),
            FilePreview::Binary { size: 3 }
        );
        assert!(
            matches!(read(&temp.0, Path::new("picture.png")).unwrap(), FilePreview::Image { mime, .. } if mime == "image/png")
        );
        assert_eq!(
            read(&temp.0, Path::new("large.webp")).unwrap(),
            FilePreview::TooLarge {
                size: MAX_IMAGE + 1
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escapes() {
        let temp = Temp::new();
        let outside = Temp::new();
        fs::write(outside.0.join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside.0, temp.0.join("linked")).unwrap();
        assert!(read(&temp.0, Path::new("../secret")).is_err());
        assert!(read(&temp.0, Path::new("linked/secret")).is_err());
    }

    #[test]
    fn refuses_git_metadata_and_folders() {
        let temp = Temp::new();
        fs::create_dir(temp.0.join(".git")).unwrap();
        fs::write(temp.0.join(".git/config"), "private").unwrap();
        fs::create_dir(temp.0.join("folder")).unwrap();
        assert!(read(&temp.0, Path::new(".git/config")).is_err());
        assert!(read(&temp.0, Path::new("folder")).is_err());
    }

    #[test]
    fn file_operations_stay_in_project_and_choose_unique_copy_names() {
        let temp = Temp::new();
        let created = create(&temp.0, Path::new("."), "notes.txt", false).unwrap();
        fs::write(&created, "sample").unwrap();
        let copy = duplicate(&temp.0, Path::new("notes.txt")).unwrap();
        assert!(copy.ends_with("notes copy.txt"));
        let second = duplicate(&temp.0, Path::new("notes.txt")).unwrap();
        assert!(second.ends_with("notes copy 2.txt"));
        let renamed = rename(&temp.0, Path::new("notes copy.txt"), "renamed.md").unwrap();
        assert!(renamed.ends_with("renamed.md"));
        let folder = create(&temp.0, Path::new("."), "folder", true).unwrap();
        assert!(Path::new(&folder).is_dir());
        assert!(create(&temp.0, Path::new("."), "../escape", false).is_err());
        assert!(rename(&temp.0, Path::new("notes.txt"), "../escape").is_err());
        assert!(duplicate(&temp.0, Path::new("folder")).is_err());
        assert!(create(&temp.0, Path::new("."), ".git", true).is_err());
        assert!(rename(&temp.0, Path::new("."), "renamed").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn file_operations_reject_symbolic_links_and_outside_parents() {
        let temp = Temp::new();
        let outside = Temp::new();
        fs::write(outside.0.join("secret"), "sample").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret"), temp.0.join("link")).unwrap();
        assert!(rename(&temp.0, Path::new("link"), "renamed").is_err());
        assert!(duplicate(&temp.0, Path::new("link")).is_err());
        assert!(create(&temp.0, &outside.0, "escape", false).is_err());
    }

    #[test]
    #[ignore = "would move a file to the current user's system Trash"]
    fn trash_moves_file_to_system_trash() {
        let temp = Temp::new();
        fs::write(temp.0.join("discard.txt"), "sample").unwrap();
        trash(&temp.0, Path::new("discard.txt")).unwrap();
        assert!(!temp.0.join("discard.txt").exists());
    }

    #[test]
    fn fuzzy_find_ranks_file_names_and_word_boundaries() {
        let temp = Temp::new();
        fs::create_dir_all(temp.0.join("src/components")).unwrap();
        fs::write(temp.0.join("src/components/btn.tsx"), "").unwrap();
        fs::write(temp.0.join("else_b_t_n.txt"), "").unwrap();
        fs::write(temp.0.join("notes.txt"), "").unwrap();
        let result = find(&temp.0, "btn", 10).unwrap();
        assert_eq!(result[0], "src/components/btn.tsx");
        assert!(find(&temp.0, "", 10).is_err());
    }

    #[test]
    fn text_search_is_plain_utf8_scoped_and_bounded() {
        let temp = Temp::new();
        fs::create_dir_all(temp.0.join("docs")).unwrap();
        fs::write(
            temp.0.join("docs/readme.md"),
            "Needle one\nother\nneedle two",
        )
        .unwrap();
        fs::write(temp.0.join("outside.txt"), "needle out").unwrap();
        fs::write(temp.0.join("binary.txt"), [0, b'n', b'e', b'e']).unwrap();
        fs::create_dir_all(temp.0.join("target")).unwrap();
        fs::write(temp.0.join("target/ignored.txt"), "needle ignored").unwrap();
        let result = search(&temp.0, "needle", false, Some(Path::new("docs"))).unwrap();
        assert_eq!(
            result
                .hits
                .iter()
                .map(|hit| (hit.path.as_str(), hit.line))
                .collect::<Vec<_>>(),
            vec![("docs/readme.md", 1), ("docs/readme.md", 3)]
        );
        assert!(!result.truncated);
        assert!(search(&temp.0, "  ", false, None).is_err());
        let lines = (0..=MAX_SEARCH_HITS)
            .map(|_| "needle")
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(temp.0.join("many.txt"), lines).unwrap();
        let capped = search(&temp.0, "needle", true, None).unwrap();
        assert_eq!(capped.hits.len(), MAX_SEARCH_HITS);
        assert!(capped.truncated);
    }

    #[test]
    fn git_search_respects_ignore_rules_and_reports_relative_paths() {
        let temp = Temp::new();
        fs::write(temp.0.join("tracked.txt"), "Needle here\n").unwrap();
        fs::write(temp.0.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(temp.0.join("ignored.txt"), "Needle hidden\n").unwrap();
        let status = Command::new("git")
            .arg("-C")
            .arg(&temp.0)
            .args(["init", "-q"])
            .status()
            .unwrap();
        assert!(status.success());
        Command::new("git")
            .arg("-C")
            .arg(&temp.0)
            .args(["add", ".gitignore", "tracked.txt"])
            .status()
            .unwrap();
        fs::write(temp.0.join("untracked.txt"), "Needle untracked\n").unwrap();
        let result = search(&temp.0, "needle", false, None).unwrap();
        assert_eq!(
            result
                .hits
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
            vec!["tracked.txt", "untracked.txt"]
        );
        assert!(
            find(&temp.0, "untracked", 10)
                .unwrap()
                .contains(&"untracked.txt".to_string())
        );
    }
}
