//! File tools: read, write, edit, list, find and search.
//!
//! Paths are taken relative to the project folder. Each one is resolved,
//! symbolic links included, before the access check, so a link inside the
//! project that points outside it counts as outside.

use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

/// Longest line shown by `read`, in characters.
const LINE_MAX: usize = 2_000;
/// Lines `read` shows when no limit is given.
const READ_LINES: usize = 2_000;
/// Files larger than this are not searched or edited.
const FILE_MAX: u64 = 10 * 1024 * 1024;
/// Most entries `list` shows.
const LIST_MAX: usize = 1_000;
/// Most paths `glob` returns.
const GLOB_MAX: usize = 500;
/// Longest matching line `grep` shows, in characters.
const MATCH_LINE_MAX: usize = 300;
/// Largest diff kept for an approval card or the list of changes.
const DIFF_MAX: usize = 64 * 1024;

/// The folders a bot works in: the project, and others it may read freely
/// (the thread's attachments and temp folders).
#[derive(Debug, Clone, Default)]
pub(crate) struct Roots {
    pub workspace: Option<PathBuf>,
    pub readable: Vec<PathBuf>,
}

/// A path, resolved for the access check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Resolved {
    /// Absolute, with `.`, `..` and symbolic links resolved where it exists.
    pub path: PathBuf,
    /// Relative to the project when inside it, else absolute. For labels.
    pub shown: String,
    /// Inside the project folder.
    pub inside: bool,
    /// Inside the project or another folder it may read freely.
    pub readable: bool,
}

impl Roots {
    pub fn new(workspace: Option<&Path>, readable: &[PathBuf]) -> Self {
        Self {
            workspace: workspace.and_then(|w| w.canonicalize().ok()),
            readable: readable.iter().filter_map(|r| r.canonicalize().ok()).collect(),
        }
    }

    /// Resolve `raw` as the bot gave it. A leading `~/` is the home folder;
    /// a relative path is taken from the project folder.
    pub fn resolve(&self, raw: &str) -> Result<Resolved, String> {
        let raw = raw.trim();
        let given = if raw.is_empty() || raw == "." {
            self.workspace.clone().ok_or("This chat has no project folder. Give an absolute path.")?
        } else if let Some(rest) = raw.strip_prefix("~/").or(if raw == "~" { Some("") } else { None }) {
            home().ok_or("The home folder is unknown. Give an absolute path.")?.join(rest)
        } else {
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                path
            } else {
                self.workspace.as_ref().ok_or("This chat has no project folder. Give an absolute path.")?.join(path)
            }
        };
        let path = real(&normal(&given));
        let inside = self.workspace.as_ref().is_some_and(|w| path.starts_with(w));
        let readable = inside || self.readable.iter().any(|r| path.starts_with(r));
        let shown = match self.workspace.as_ref().and_then(|w| path.strip_prefix(w).ok()) {
            Some(rel) if rel.as_os_str().is_empty() => ".".to_string(),
            Some(rel) => rel.to_string_lossy().replace('\\', "/"),
            None => path.to_string_lossy().into_owned(),
        };
        Ok(Resolved { path, shown, inside, readable })
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// `.` and `..` taken out without touching the disk.
fn normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Symbolic links resolved for the part of `path` that exists; the rest,
/// a file still to be written, is added back unchanged.
fn real(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    loop {
        if let Ok(found) = existing.canonicalize() {
            let mut out = found;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Whether the start of `path` holds a NUL byte, as binary files do.
fn looks_binary(path: &Path) -> bool {
    let mut head = [0u8; 8192];
    std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map(|n| head[..n].contains(&0))
        .unwrap_or(false)
}

fn cut_line(line: &str) -> String {
    if line.chars().count() <= LINE_MAX {
        line.to_string()
    } else {
        format!("{}… [line cut]", line.chars().take(LINE_MAX).collect::<String>())
    }
}

/// Lines `offset` (from 1) onward, at most `limit`, numbered.
pub(crate) fn read(path: &Path, offset: Option<u64>, limit: Option<u64>) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    if meta.is_dir() {
        return Err(format!("{} is a folder. Use list_dir to see what's in it.", path.display()));
    }
    if looks_binary(path) {
        return Ok(format!("{} is a binary file ({} bytes) and can't be shown as text.", path.display(), meta.len()));
    }
    let start = offset.unwrap_or(1).max(1) as usize;
    let limit = limit.map(|l| l.clamp(1, 20_000) as usize).unwrap_or(READ_LINES);
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut out = String::new();
    let mut total = 0usize;
    let mut shown = 0usize;
    for line in BufReader::new(file).split(b'\n') {
        let line = line.map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
        total += 1;
        if total >= start && shown < limit {
            let text = String::from_utf8_lossy(&line);
            let text = text.strip_suffix('\r').unwrap_or(&text);
            out.push_str(&format!("{total:>6}\t{}\n", cut_line(text)));
            shown += 1;
        }
    }
    if total == 0 {
        return Ok("(empty file)".into());
    }
    if start > total {
        return Ok(format!("The file has {total} lines; line {start} is past the end."));
    }
    let last = start + shown - 1;
    if last < total {
        out.push_str(&format!("(lines {start} to {last} of {total}; read again with offset {} for more)\n", last + 1));
    }
    Ok(out)
}

/// The file's current text, or None when it doesn't exist yet.
pub(crate) fn current(path: &Path) -> Result<Option<String>, String> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't open {}: {e}", path.display())),
        Ok(meta) if meta.is_dir() => Err(format!("{} is a folder.", path.display())),
        Ok(meta) if meta.len() > FILE_MAX => Err(format!("{} is larger than 10 MB; change it with a command instead.", path.display())),
        Ok(_) => std::fs::read_to_string(path)
            .map(Some)
            .map_err(|_| format!("{} isn't UTF-8 text, so it can't be edited this way.", path.display())),
    }
}

/// Write `content` to `path`, making any missing folders.
pub(crate) fn write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't make {}: {e}", parent.display()))?;
    }
    std::fs::write(path, content).map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

/// The text after replacing `old` with `new` in `text`: once, where it
/// appears exactly once, or everywhere with `all`.
pub(crate) fn replace(text: &str, old: &str, new: &str, all: bool) -> Result<(String, usize), String> {
    if old.is_empty() {
        return Err("old_string is empty. To create a file or replace all of it, use write_file.".into());
    }
    if old == new {
        return Err("old_string and new_string are the same, so there is nothing to change.".into());
    }
    let count = text.matches(old).count();
    match count {
        0 => Err("old_string wasn't found. Read the file again and copy the exact text, including spaces and line breaks.".into()),
        n if n > 1 && !all => Err(format!(
            "old_string appears {n} times. Add more of the surrounding lines so it matches once, or set replace_all to change every one."
        )),
        n => Ok((if all { text.replace(old, new) } else { text.replacen(old, new, 1) }, n)),
    }
}

/// A short diff: the lines between the unchanged start and end, as `-` and
/// `+` lines under a hunk header.
pub(crate) fn diff(old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut end = 0;
    while end < a.len() - start && end < b.len() - start && a[a.len() - 1 - end] == b[b.len() - 1 - end] {
        end += 1;
    }
    let removed = &a[start..a.len() - end];
    let added = &b[start..b.len() - end];
    let mut out = format!("@@ -{},{} +{},{} @@\n", start + 1, removed.len(), start + 1, added.len());
    for line in removed {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in added {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if out.len() > DIFF_MAX {
        let mut end = DIFF_MAX;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        let lines = out[end..].matches('\n').count();
        out.truncate(end);
        out.push_str(&format!("\n… {lines} more lines\n"));
    }
    out
}

/// What is in a folder: folders first, then files with their sizes.
pub(crate) fn list(path: &Path) -> Result<String, String> {
    let entries = std::fs::read_dir(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => folders.push(format!("{name}/")),
            Ok(kind) if kind.is_symlink() => files.push(format!("{name} (link)")),
            _ => {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                files.push(format!("{name} ({})", size_text(size)));
            }
        }
    }
    folders.sort();
    files.sort();
    let total = folders.len() + files.len();
    if total == 0 {
        return Ok("(empty folder)".into());
    }
    let mut out: Vec<String> = folders.into_iter().chain(files).take(LIST_MAX).collect();
    if total > LIST_MAX {
        out.push(format!("… and {} more", total - LIST_MAX));
    }
    Ok(out.join("\n"))
}

fn size_text(bytes: u64) -> String {
    match bytes {
        b if b < 1024 => format!("{b} B"),
        b if b < 1024 * 1024 => format!("{:.1} KB", b as f64 / 1024.0),
        b => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
    }
}

/// Walk `root` the way ripgrep does: hidden files included, `.git` and
/// whatever `.gitignore` lists left out.
fn walker(root: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build()
}

/// A pattern for paths. One with no `/` matches a file's name at any depth.
fn matcher(pattern: &str) -> Result<(globset::GlobMatcher, bool), String> {
    let pattern = pattern.trim().trim_start_matches("./");
    let glob = globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| format!("That pattern isn't valid: {e}"))?;
    Ok((glob.compile_matcher(), !pattern.contains('/')))
}

fn matches(matcher: &(globset::GlobMatcher, bool), rel: &Path) -> bool {
    if matcher.1 {
        rel.file_name().is_some_and(|name| matcher.0.is_match(name))
    } else {
        matcher.0.is_match(rel)
    }
}

/// Files under `root` whose paths match `pattern`, newest first.
pub(crate) fn glob(root: &Path, pattern: &str) -> Result<String, String> {
    let matcher = matcher(pattern)?;
    let mut found: Vec<(SystemTime, String)> = Vec::new();
    for entry in walker(root).flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        if matches(&matcher, rel) {
            let modified = entry.metadata().ok().and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
            found.push((modified, rel.to_string_lossy().replace('\\', "/")));
        }
    }
    if found.is_empty() {
        return Ok("No files match.".into());
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let total = found.len();
    let mut out: Vec<String> = found.into_iter().take(GLOB_MAX).map(|(_, path)| path).collect();
    if total > GLOB_MAX {
        out.push(format!("… and {} more; narrow the pattern", total - GLOB_MAX));
    }
    Ok(out.join("\n"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GrepMode {
    /// The files that match.
    Files,
    /// Each matching line, with its file and number.
    Content,
    /// How many lines match in each file.
    Count,
}

#[derive(Debug, Clone)]
pub(crate) struct Grep<'a> {
    pub pattern: &'a str,
    pub glob: Option<&'a str>,
    pub ignore_case: bool,
    pub mode: GrepMode,
    /// Lines shown before and after each match, in content mode.
    pub context: usize,
    pub max: usize,
}

/// Search the files under `root` (or `root` itself, a file) for lines
/// matching a regular expression.
pub(crate) fn grep(root: &Path, shown_root: &str, args: &Grep<'_>) -> Result<String, String> {
    let regex = regex::RegexBuilder::new(args.pattern)
        .case_insensitive(args.ignore_case)
        .size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|e| format!("That regular expression isn't valid: {e}"))?;
    let filter = args.glob.map(matcher).transpose()?;
    let files: Vec<PathBuf> = if root.is_file() {
        vec![root.to_path_buf()]
    } else {
        walker(root)
            .flatten()
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .map(|e| e.into_path())
            .filter(|p| match (&filter, p.strip_prefix(root)) {
                (Some(filter), Ok(rel)) => matches(filter, rel),
                _ => true,
            })
            .collect()
    };
    let label = |path: &Path| -> String {
        if root.is_file() {
            shown_root.to_string()
        } else {
            match path.strip_prefix(root) {
                Ok(rel) if shown_root == "." => rel.to_string_lossy().replace('\\', "/"),
                Ok(rel) => format!("{}/{}", shown_root.trim_end_matches('/'), rel.to_string_lossy().replace('\\', "/")),
                Err(_) => path.to_string_lossy().into_owned(),
            }
        }
    };
    let mut out: Vec<String> = Vec::new();
    let mut more = false;
    'files: for path in files {
        if std::fs::metadata(&path).map(|m| m.len() > FILE_MAX).unwrap_or(true) || looks_binary(&path) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let hits: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| regex.is_match(l)).map(|(i, _)| i).collect();
        if hits.is_empty() {
            continue;
        }
        let name = label(&path);
        match args.mode {
            GrepMode::Files => out.push(name),
            GrepMode::Count => out.push(format!("{name}: {}", hits.len())),
            GrepMode::Content => {
                let mut last_shown: Option<usize> = None;
                for &hit in &hits {
                    let from = hit.saturating_sub(args.context);
                    let to = (hit + args.context).min(lines.len() - 1);
                    if let Some(last) = last_shown {
                        if from > last + 1 && args.context > 0 {
                            out.push("--".into());
                        }
                    }
                    for i in from.max(last_shown.map_or(0, |l| l + 1))..=to {
                        let mark = if i == hit || hits.binary_search(&i).is_ok() { ':' } else { '-' };
                        let line = lines[i];
                        let line = if line.chars().count() > MATCH_LINE_MAX {
                            format!("{}…", line.chars().take(MATCH_LINE_MAX).collect::<String>())
                        } else {
                            line.to_string()
                        };
                        out.push(format!("{name}{mark}{}{mark}{line}", i + 1));
                        last_shown = Some(i);
                    }
                    if out.len() >= args.max {
                        more = true;
                        break 'files;
                    }
                }
            }
        }
        if out.len() >= args.max {
            more = true;
            break;
        }
    }
    if out.is_empty() {
        return Ok("No matches.".into());
    }
    out.truncate(args.max);
    if more {
        out.push(format!("(stopped at {} results; narrow the search or raise max_results)", args.max));
    }
    Ok(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("apex-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn paths_are_resolved_inside_or_outside_the_project() {
        let dir = scratch("resolve");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let roots = Roots::new(Some(&dir), &[]);
        let inside = roots.resolve("src/../src/main.rs").unwrap();
        assert!(inside.inside && inside.readable);
        assert_eq!(inside.shown, "src/main.rs");
        assert_eq!(inside.path, dir.join("src/main.rs"));
        let outside = roots.resolve("../elsewhere.txt").unwrap();
        assert!(!outside.inside && !outside.readable);
        assert_eq!(roots.resolve("").unwrap().shown, ".");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_project_counts_as_outside() {
        let dir = scratch("link");
        let other = scratch("link-target");
        std::fs::write(other.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&other, dir.join("door")).unwrap();
        let roots = Roots::new(Some(&dir), &[]);
        let through = roots.resolve("door/secret.txt").unwrap();
        assert!(!through.inside, "{through:?}");
        assert_eq!(through.path, other.join("secret.txt"));
        let readable = Roots::new(Some(&dir), std::slice::from_ref(&other)).resolve("door/secret.txt").unwrap();
        assert!(readable.readable && !readable.inside);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(other);
    }

    #[test]
    fn read_numbers_lines_and_says_where_it_stopped() {
        let dir = scratch("read");
        let file = dir.join("a.txt");
        std::fs::write(&file, "one\ntwo\nthree\nfour\n").unwrap();
        assert_eq!(read(&file, None, None).unwrap(), "     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour\n");
        let part = read(&file, Some(2), Some(2)).unwrap();
        assert!(part.starts_with("     2\ttwo\n     3\tthree\n"), "{part}");
        assert!(part.contains("offset 4"), "{part}");
        std::fs::write(&file, b"\x00\x01").unwrap();
        assert!(read(&file, None, None).unwrap().contains("binary"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn replace_needs_one_exact_match_unless_told_all() {
        assert_eq!(replace("a b a", "b", "c", false).unwrap(), ("a c a".into(), 1));
        assert!(replace("a b a", "a", "c", false).unwrap_err().contains("2 times"));
        assert_eq!(replace("a b a", "a", "c", true).unwrap(), ("c b c".into(), 2));
        assert!(replace("abc", "x", "y", false).unwrap_err().contains("wasn't found"));
        assert!(replace("abc", "", "y", false).is_err());
    }

    #[test]
    fn diff_shows_only_the_changed_lines() {
        assert_eq!(diff("a\nb\nc\n", "a\nB\nc\n"), "@@ -2,1 +2,1 @@\n-b\n+B\n");
        assert_eq!(diff("", "new\n"), "@@ -1,0 +1,1 @@\n+new\n");
        assert_eq!(diff("a\nb\n", "a\nb\nc\n"), "@@ -3,0 +3,1 @@\n+c\n");
    }

    #[test]
    fn glob_and_grep_skip_ignored_files() {
        let dir = scratch("search");
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {\n    hello();\n}\n").unwrap();
        std::fs::write(dir.join("src/deep/lib.rs"), "pub fn hello() {}\n").unwrap();
        std::fs::write(dir.join("target/out.rs"), "fn hello() {}\n").unwrap();
        // The walker honours .gitignore only inside a git repository.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let mut found: Vec<String> = glob(&dir, "*.rs").unwrap().lines().map(str::to_string).collect();
        found.sort();
        assert_eq!(found, ["src/deep/lib.rs", "src/main.rs"]);
        assert_eq!(glob(&dir, "src/*.rs").unwrap(), "src/main.rs");
        let args = Grep { pattern: "hello", glob: None, ignore_case: false, mode: GrepMode::Content, context: 0, max: 50 };
        let mut lines: Vec<String> = grep(&dir, ".", &args).unwrap().lines().map(str::to_string).collect();
        lines.sort();
        assert_eq!(lines, ["src/deep/lib.rs:1:pub fn hello() {}", "src/main.rs:2:    hello();"]);
        let files = Grep { mode: GrepMode::Files, glob: Some("main.rs"), ..args.clone() };
        assert_eq!(grep(&dir, ".", &files).unwrap(), "src/main.rs");
        assert_eq!(grep(&dir, ".", &Grep { pattern: "nothing", ..args }).unwrap(), "No matches.");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn list_shows_folders_then_files() {
        let dir = scratch("list");
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a.txt"), "12345").unwrap();
        assert_eq!(list(&dir).unwrap(), "b/\na.txt (5 B)");
        let _ = std::fs::remove_dir_all(dir);
    }
}
