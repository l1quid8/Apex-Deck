//! File snapshots for Retry and Revert, kept in Deck's own data and never in
//! the workspace's `.git`. Each workspace folder has one hidden bare git
//! repository, so identical files are stored once; each thread keeps its own
//! index (for fast re-snapshots) and its own list of checkpoints.
//!
//! A checkpoint is taken when the thread opens, when the person sends, when
//! each bot starts and when the thread goes idle. Changes between a Send or
//! Start checkpoint and the next one happened while this thread's bots were
//! working, so they are this thread's. Changes after an Idle (or Open, or
//! Restore) checkpoint belong to someone else, and a revert leaves them alone.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use apex_core::ParticipantId;
use serde::{Deserialize, Serialize};

/// Package and cache folders: never saved, never restored, never deleted.
pub const SKIPPED_FOLDERS: &[&str] = &["node_modules", "target", ".venv", "venv", "__pycache__", ".next", ".turbo", ".gradle", "Pods", ".git"];
/// Files larger than this are left out of snapshots, so a revert can't restore them.
pub const MAX_FILE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind { Open, Send, Start, Idle, Restore }

impl Kind {
    /// Whether changes after this checkpoint were made while this thread's bots were working.
    fn working(self) -> bool { matches!(self, Kind::Send | Kind::Start) }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Checkpoint {
    /// How many messages the transcript held when it was taken.
    pub seq: usize,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<ParticipantId>,
    pub tree: String,
    /// Files left out because they are over `MAX_FILE`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<String>,
}

/// A command a bot ran that a revert can't undo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SideEffect { pub seq: usize, pub by: ParticipantId, pub command: String }

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct ThreadFile {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    checkpoints: Vec<Checkpoint>,
    #[serde(default)]
    effects: Vec<SideEffect>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanFile {
    pub path: String,
    /// True when the file didn't exist then, so going back deletes it.
    pub delete: bool,
    /// Someone outside this thread's turns also changed it since then.
    pub conflict: bool,
}

/// What going back to a message would do to the folder.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RevertPlan {
    /// False when there's no snapshot for that point; only the chat can go back.
    pub available: bool,
    pub note: Option<String>,
    pub files: Vec<PlanFile>,
    /// Big files changed since then that weren't saved, so stay as they are.
    pub skipped: Vec<String>,
    pub effects: Vec<SideEffect>,
}

impl RevertPlan {
    fn unavailable(note: &str) -> Self {
        RevertPlan { available: false, note: Some(note.into()), files: vec![], skipped: vec![], effects: vec![] }
    }
}

/// One thread's snapshots run one at a time, since they share its index and
/// checkpoint list. Other threads, even in the same folder, never wait for
/// them: a snapshot of a large folder can take minutes. The list also has a
/// lock of its own, held only while it is read and saved, so noting a
/// command a bot ran never waits for a snapshot.
pub struct Snapshots { root: PathBuf, threads: Mutex<HashMap<String, Arc<Mutex<()>>>>, lists: Mutex<HashMap<String, Arc<Mutex<()>>>>, stores: Mutex<()> }

fn git(store: &Path, cwd: &Path, index: Option<&Path>, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let cwd = &std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let mut command = Command::new("git");
    command.args(["-c", "core.quotePath=false", "-c", "core.excludesFile=", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false"])
        .args(args)
        .env("GIT_DIR", crate::assistant_git::external_path(store).as_os_str())
        .env("GIT_WORK_TREE", crate::assistant_git::external_path(cwd).as_os_str())
        .current_dir(cwd)
        .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(path) = crate::agents::login_path() { command.env("PATH", path); }
    match index { Some(index) => { command.env("GIT_INDEX_FILE", crate::assistant_git::external_path(index).as_os_str()); }, None => { command.env_remove("GIT_INDEX_FILE"); } }
    let mut child = command.spawn().map_err(|e| format!("could not run git: {e}"))?;
    if let Some(input) = input { child.stdin.take().unwrap().write_all(input).map_err(|e| e.to_string())?; }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
    Ok(out.stdout)
}

fn text(bytes: Vec<u8>) -> String { String::from_utf8_lossy(&bytes).trim().to_string() }

/// A short stable name for a folder, so each folder gets its own store.
fn folder_key(cwd: &Path) -> String {
    let canonical = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in canonical.to_string_lossy().bytes() { hash ^= byte as u64; hash = hash.wrapping_mul(0x100000001b3); }
    format!("{hash:016x}")
}

fn safe(thread: &str) -> String {
    thread.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// Folders the project's own `.gitignore` files ignore, relative to `cwd`:
/// build output such as `release/` or `dist/`, which can hold gigabytes.
/// Listed against an index that is never written, so what an earlier
/// snapshot saved doesn't hide them, and git doesn't walk into them.
fn ignored_folders(store: &Path, cwd: &Path) -> Vec<String> {
    let args = ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"];
    let Ok(out) = git(store, cwd, Some(&store.join("empty-index")), &args, None) else { return Vec::new() };
    out.split(|b| *b == 0)
        .filter_map(|p| String::from_utf8_lossy(p).strip_suffix('/').map(str::to_string))
        .filter(|p| !p.is_empty())
        .collect()
}

/// Files over `MAX_FILE`, outside the skipped and `ignored` folders, relative to `cwd`.
fn big_files(cwd: &Path, ignored: &[String]) -> Vec<String> {
    let ignored: BTreeSet<PathBuf> = ignored.iter().map(|folder| cwd.join(folder)).collect();
    let mut found = Vec::new();
    let mut stack = vec![cwd.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let name = entry.file_name();
            if kind.is_dir() {
                if !SKIPPED_FOLDERS.iter().any(|s| name == *s) && !ignored.contains(&entry.path()) { stack.push(entry.path()); }
            } else if kind.is_file() && entry.metadata().map(|m| m.len() > MAX_FILE).unwrap_or(false) {
                if let Ok(rel) = entry.path().strip_prefix(cwd) { found.push(rel.to_string_lossy().into_owned()); }
            }
        }
    }
    found.sort();
    found
}

fn changed(store: &Path, cwd: &Path, from: &str, to: &str) -> Result<BTreeSet<String>, String> {
    if from == to { return Ok(BTreeSet::new()); }
    let out = git(store, cwd, None, &["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to], None)?;
    Ok(out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect())
}

/// Commands that change things outside the folder, which a revert can't undo.
pub fn irreversible(command: &str) -> bool {
    let c = command.to_lowercase();
    let has = |needle: &str| c.contains(needle);
    has("git push") || has("git commit") || has("git tag") || has("git reset --hard") || has("git rebase") || has("git merge")
        || has("npm install -g") || has("npm i -g") || has("pnpm add -g") || has("yarn global") || has("brew install") || has("brew uninstall")
        || has("pip install") && !has("venv") || has("cargo install") || has("gem install") || has("apt install") || has("apt-get install")
        || has("sudo ") || has("npm publish") || has("cargo publish") || has("docker push") || has("docker rm") || has("kubectl ")
        || has("vercel deploy") || has("vercel --prod") || has("fly deploy") || has("gh pr create") || has("gh release")
        || has("migrate") || has("drop table") || has("psql ") || has("mysql ") || has("curl -x post") || has("curl -x delete") || has("rm -rf ~")
}

impl Snapshots {
    pub fn new(root: PathBuf) -> Self { Snapshots { root, threads: Mutex::default(), lists: Mutex::default(), stores: Mutex::default() } }

    fn thread_lock(&self, thread: &str) -> Arc<Mutex<()>> {
        Arc::clone(self.threads.lock().unwrap().entry(thread.to_string()).or_default())
    }

    /// Held while the thread's list is read and saved. Anything that also
    /// holds `thread_lock` takes this one second.
    fn list_lock(&self, thread: &str) -> Arc<Mutex<()>> {
        Arc::clone(self.lists.lock().unwrap().entry(thread.to_string()).or_default())
    }

    /// Tests stand in for a slow snapshot by holding a thread's lock.
    #[cfg(test)]
    pub(crate) fn hold_for_test(&self, thread: &str) -> Arc<Mutex<()>> { self.thread_lock(thread) }

    fn thread_path(&self, thread: &str) -> PathBuf { self.root.join("threads").join(format!("{}.json", safe(thread))) }

    fn load(&self, thread: &str) -> ThreadFile {
        std::fs::read(self.thread_path(thread)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save(&self, thread: &str, file: &ThreadFile) -> Result<(), String> {
        let path = self.thread_path(thread);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_vec(file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }

    /// The folder's bare store, made on first use.
    fn store(&self, cwd: &Path) -> Result<PathBuf, String> {
        let dir = self.root.join(folder_key(cwd));
        let store = dir.join("store.git");
        // Two threads opening in a new folder make its store once.
        let _making = self.stores.lock().unwrap();
        if !store.join("HEAD").exists() {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let out = Command::new("git").args(["init", "--bare", "-q"]).arg(&store).env_remove("GIT_DIR")
                .output().map_err(|e| format!("could not run git: {e}"))?;
            if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
            // Unreachable objects are only collected after a long while, and
            // the store is never pushed anywhere.
            let _ = std::fs::write(dir.join("README"), "Apex Deck file snapshots for Retry and Revert. Safe to delete when Deck is closed.\n");
        }
        Ok(store)
    }

    fn index(&self, cwd: &Path, thread: &str) -> PathBuf { self.root.join(folder_key(cwd)).join(format!("index-{}", safe(thread))) }

    /// Write the folder as it is now into the store and return its tree.
    fn write_tree(&self, cwd: &Path, thread: &str) -> Result<(String, Vec<String>), String> {
        let store = self.store(cwd)?;
        let index = self.index(cwd, thread);
        // Ignored files on their own (a .env) are still saved; ignored folders are not.
        let ignored = ignored_folders(&store, cwd);
        let skipped = big_files(cwd, &ignored);
        let mut args: Vec<String> = ["add", "-A", "-f", "--ignore-errors", "--", "."].iter().map(|s| s.to_string()).collect();
        for folder in SKIPPED_FOLDERS { args.push(format!(":(exclude,glob)**/{folder}/**")); }
        for folder in &ignored { args.push(format!(":(exclude,literal){folder}")); }
        for file in &skipped { args.push(format!(":(exclude,literal){file}")); }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        // --ignore-errors still exits non-zero when one file can't be read;
        // the rest are added, so carry on to write-tree.
        let _ = git(&store, cwd, Some(&index), &args, None);
        if !ignored.is_empty() {
            // An earlier snapshot may have saved a folder that is ignored now.
            let mut forget: Vec<String> = ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--"].iter().map(|s| s.to_string()).collect();
            forget.extend(ignored.iter().map(|folder| format!(":(literal){folder}")));
            let forget: Vec<&str> = forget.iter().map(String::as_str).collect();
            let _ = git(&store, cwd, Some(&index), &forget, None);
        }
        let tree = text(git(&store, cwd, Some(&index), &["write-tree"], None)?);
        Ok((tree, skipped))
    }

    /// Take a checkpoint for `thread` in `cwd`.
    pub fn take(&self, thread: &str, cwd: &Path, seq: usize, kind: Kind, by: Option<ParticipantId>) -> Result<Checkpoint, String> {
        self.take_if_live(thread, cwd, seq, kind, by, &std::sync::atomic::AtomicBool::new(false))
    }

    /// A host room may retire while its background snapshot waits to start.
    pub(crate) fn take_if_live(&self, thread: &str, cwd: &Path, seq: usize, kind: Kind, by: Option<ParticipantId>, retired: &std::sync::atomic::AtomicBool) -> Result<Checkpoint, String> {
        // Check under the same lock as delete: a job either completes before
        // Mount clears the old list, or observes retirement and writes nothing.
        let lock = self.thread_lock(thread); let _guard = lock.lock().unwrap();
        if retired.load(std::sync::atomic::Ordering::SeqCst) { return Err("The chat folder changed; discard the old snapshot.".into()); }
        let (tree, skipped) = self.write_tree(cwd, thread)?;
        let list = self.list_lock(thread); let _list = list.lock().unwrap();
        let mut file = self.load(thread);
        file.cwd = cwd.to_string_lossy().into_owned();
        // Two idle checkpoints in a row with the same tree say nothing new.
        if let Some(last) = file.checkpoints.last() {
            if last.tree == tree && !kind.working() && !last.kind.working() { return Ok(last.clone()); }
        }
        let checkpoint = Checkpoint { seq, kind, by, tree, skipped };
        file.checkpoints.push(checkpoint.clone());
        self.save(thread, &file)?;
        Ok(checkpoint)
    }

    /// Remember a command a bot ran, if a revert couldn't undo it.
    pub fn note_command(&self, thread: &str, seq: usize, by: &ParticipantId, command: &str) {
        if !irreversible(command) { return; }
        // Not the thread lock: the bot is mid-turn, and a snapshot can take minutes.
        let lock = self.list_lock(thread); let _guard = lock.lock().unwrap();
        let mut file = self.load(thread);
        file.effects.push(SideEffect { seq, by: by.clone(), command: command.to_string() });
        let _ = self.save(thread, &file);
    }

    /// Which checkpoint "going back to message `at`" means. A bot's reply
    /// goes back to when that bot started on it; your message to when you sent it.
    fn point(checkpoints: &[Checkpoint], at: usize, bot: Option<&ParticipantId>) -> Option<usize> {
        if let Some(bot) = bot {
            if let Some(k) = checkpoints.iter().rposition(|c| c.seq <= at && c.kind == Kind::Start && c.by.as_ref() == Some(bot)) { return Some(k); }
        }
        checkpoints.iter().rposition(|c| c.seq <= at)
    }

    /// What going back to message `at` would restore. `bot` is set for a retry.
    pub fn plan(&self, thread: &str, cwd: &Path, at: usize, bot: Option<&ParticipantId>) -> RevertPlan {
        let file = self.load(thread);
        let Some(k) = Self::point(&file.checkpoints, at, bot) else {
            return RevertPlan::unavailable("There's no file snapshot from that point, so only the chat can go back.");
        };
        match self.plan_from(thread, cwd, &file, k) {
            Ok(plan) => plan,
            Err(error) => RevertPlan::unavailable(&format!("Couldn't read the snapshots ({error}), so only the chat can go back.")),
        }
    }

    fn plan_from(&self, thread: &str, cwd: &Path, file: &ThreadFile, k: usize) -> Result<RevertPlan, String> {
        let store = self.store(cwd)?;
        let (now, now_skipped) = { let lock = self.thread_lock(thread); let _guard = lock.lock().unwrap(); self.write_tree(cwd, thread)? };
        let list = &file.checkpoints[k..];
        let mut ours = BTreeSet::new();
        let mut theirs = BTreeSet::new();
        for pair in list.windows(2) {
            let set = changed(&store, cwd, &pair[0].tree, &pair[1].tree)?;
            if pair[0].kind.working() { ours.extend(set) } else { theirs.extend(set) }
        }
        let last = list.last().unwrap();
        let tail = changed(&store, cwd, &last.tree, &now)?;
        // A thread that stopped without an idle checkpoint (the app quit) still owns its last turn.
        if last.kind.working() { ours.extend(tail) } else { theirs.extend(tail) }
        let then = &list[0].tree;
        let existed = self.paths_in(&store, cwd, then, &ours)?;
        let files = ours.iter().map(|path| PlanFile { path: path.clone(), delete: !existed.contains(path), conflict: theirs.contains(path) }).collect();
        let mut skipped: Vec<String> = list.iter().flat_map(|c| c.skipped.iter().cloned()).chain(now_skipped).collect();
        skipped.sort();
        skipped.dedup();
        let seq = list[0].seq;
        let effects = file.effects.iter().filter(|e| e.seq >= seq).cloned().collect();
        Ok(RevertPlan { available: true, note: None, files, skipped, effects })
    }

    fn paths_in(&self, store: &Path, cwd: &Path, tree: &str, paths: &BTreeSet<String>) -> Result<BTreeSet<String>, String> {
        if paths.is_empty() { return Ok(BTreeSet::new()); }
        let mut args = vec!["ls-tree", "-r", "--name-only", "-z", tree, "--"];
        args.extend(paths.iter().map(String::as_str));
        let out = git(store, cwd, None, &args, None)?;
        Ok(out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect())
    }

    /// Put `paths` back as they were at message `at`, deleting the ones that
    /// didn't exist then. Returns the paths it couldn't restore.
    pub fn restore(&self, thread: &str, cwd: &Path, at: usize, bot: Option<&ParticipantId>, paths: &[String]) -> Result<Vec<String>, String> {
        let file = self.load(thread);
        let k = Self::point(&file.checkpoints, at, bot).ok_or("there's no file snapshot from that point")?;
        let tree = file.checkpoints[k].tree.clone();
        let store = self.store(cwd)?;
        let wanted: BTreeSet<String> = paths.iter().filter(|p| safe_path(p)).cloned().collect();
        let existed = self.paths_in(&store, cwd, &tree, &wanted)?;
        let mut failed = Vec::new();
        if !existed.is_empty() {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let temp = std::env::temp_dir().join(format!("apex-deck-restore-{}-{}-{serial}", std::process::id(), safe(thread)));
            let mut input = Vec::new();
            for path in &existed { input.extend_from_slice(path.as_bytes()); input.push(0); }
            let result = git(&store, cwd, Some(&temp), &["read-tree", &tree], None)
                .and_then(|_| git(&store, cwd, Some(&temp), &["checkout-index", "-f", "-z", "--stdin"], Some(&input)));
            let _ = std::fs::remove_file(&temp);
            if let Err(error) = result { return Err(format!("could not restore files: {error}")); }
        }
        for path in wanted.difference(&existed) {
            match remove_project_file(cwd, path) {
                Ok(()) => {},
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                Err(_) => failed.push(path.clone()),
            }
        }
        Ok(failed)
    }

    /// The chat went back to message `at`: forget checkpoints from that point
    /// on, and mark the folder as it is now as not this thread's work.
    pub fn rewind(&self, thread: &str, cwd: &Path, at: usize, bot: Option<&ParticipantId>, kind: Kind) -> Result<(), String> {
        {
            let lock = self.thread_lock(thread); let _guard = lock.lock().unwrap();
            let list = self.list_lock(thread); let _list = list.lock().unwrap();
            let mut file = self.load(thread);
            if let Some(k) = Self::point(&file.checkpoints, at, bot) {
                // Keep the point itself only if it was taken before anything at `at` happened.
                let keep = if file.checkpoints[k].kind.working() { k } else { k + 1 };
                file.checkpoints.truncate(keep);
            }
            file.effects.retain(|e| e.seq < at);
            self.save(thread, &file)?;
        }
        self.take(thread, cwd, at, kind, None).map(|_| ())
    }

    /// `/clear`: forget every checkpoint and start again from now.
    pub fn clear(&self, thread: &str, cwd: Option<&Path>) {
        {
            let lock = self.thread_lock(thread); let _guard = lock.lock().unwrap();
            let list = self.list_lock(thread); let _list = list.lock().unwrap();
            let _ = std::fs::remove_file(self.thread_path(thread));
        }
        if let Some(cwd) = cwd { let _ = self.take(thread, cwd, 0, Kind::Open, None); }
    }

    pub fn delete(&self, thread: &str) {
        let lock = self.thread_lock(thread); let _guard = lock.lock().unwrap();
        let list = self.list_lock(thread); let _list = list.lock().unwrap();
        let file = self.load(thread);
        if !file.cwd.is_empty() { let _ = std::fs::remove_file(self.index(Path::new(&file.cwd), thread)); }
        let _ = std::fs::remove_file(self.thread_path(thread));
    }

    /// A fork keeps the checkpoints for the messages it keeps.
    pub fn fork(&self, source: &str, target: &str, upto: Option<usize>) {
        // Reads one thread's list and writes another's: hold both, always in the same order.
        let (first, second) = if source <= target { (source, target) } else { (target, source) };
        let (first, second) = (self.thread_lock(first), self.thread_lock(second));
        let _first = first.lock().unwrap();
        let _second = (!Arc::ptr_eq(&first, &second)).then(|| second.lock().unwrap());
        let mut file = { let list = self.list_lock(source); let _list = list.lock().unwrap(); self.load(source) };
        if let Some(upto) = upto {
            file.checkpoints.retain(|c| c.seq < upto || (c.seq == upto && !c.kind.working()));
            file.effects.retain(|e| e.seq < upto);
        }
        let list = self.list_lock(target); let _list = list.lock().unwrap();
        let _ = self.save(target, &file);
    }

    /// The diff panel: what changed since the thread's first checkpoint.
    pub fn diff_since_start(&self, thread: &str, cwd: &Path) -> Option<Result<String, String>> {
        let first = self.load(thread).checkpoints.first()?.tree.clone();
        Some(self.store(cwd).and_then(|store| {
            let (now, _) = { let lock = self.thread_lock(thread); let _guard = lock.lock().unwrap(); self.write_tree(cwd, thread)? };
            git(&store, cwd, None, &["diff", "--no-color", "--no-ext-diff", "--no-renames", &first, &now], None).map(|b| String::from_utf8_lossy(&b).into_owned())
        }))
    }

    /// Drop loose objects no thread can reach any more. Cheap enough to run at startup.
    pub fn compact(&self) {
        let Ok(dirs) = std::fs::read_dir(&self.root) else { return };
        for dir in dirs.flatten() {
            let store = dir.path().join("store.git");
            if store.join("HEAD").exists() {
                let _ = Command::new("git").arg("--git-dir").arg(&store).args(["gc", "--auto", "--quiet"]).env_remove("GIT_DIR").output();
            }
        }
    }
}

fn safe_path(path: &str) -> bool {
    let p = Path::new(path);
    !p.is_absolute() && !p.components().any(|c| matches!(c, std::path::Component::ParentDir))
        && !p.components().any(|c| SKIPPED_FOLDERS.iter().any(|s| c.as_os_str() == *s))
}

/// Walk and unlink relative to held directories, never following an ancestor
/// link. A link replacement after opening cannot redirect the unlink outside.
#[cfg(unix)]
fn remove_project_file(cwd: &Path, relative: &str) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::ffi::CString;
    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid restore path");
    let root = CString::new(cwd.as_os_str().as_bytes()).map_err(|_| invalid())?;
    let fd = unsafe { libc::open(root.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    let mut dirs = vec![unsafe { OwnedFd::from_raw_fd(fd) }];
    let names: Vec<CString> = Path::new(relative).components().map(|c| {
        if let std::path::Component::Normal(name) = c { CString::new(name.as_bytes()).map_err(|_| invalid()) } else { Err(invalid()) }
    }).collect::<Result<_, _>>()?;
    let (leaf, ancestors) = names.split_last().ok_or_else(invalid)?;
    for name in ancestors {
        let fd = unsafe { libc::openat(dirs.last().unwrap().as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        dirs.push(unsafe { OwnedFd::from_raw_fd(fd) });
    }
    if unsafe { libc::unlinkat(dirs.last().unwrap().as_raw_fd(), leaf.as_ptr(), 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    for index in (0..ancestors.len()).rev() {
        if unsafe { libc::unlinkat(dirs[index].as_raw_fd(), ancestors[index].as_ptr(), libc::AT_REMOVEDIR) } != 0 { break; }
    }
    Ok(())
}

// Fail closed on platforms without directory-relative no-follow deletion.
#[cfg(not(unix))]
fn remove_project_file(_cwd: &Path, _relative: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "safe checkpoint deletion is unavailable on this platform"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> (PathBuf, Snapshots) {
        let base = std::env::temp_dir().join(format!("apex-cp-{}-{}-{}", name, std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let cwd = base.join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        (cwd, Snapshots::new(base.join("data")))
    }

    fn bot() -> Option<ParticipantId> { Some(ParticipantId::new("jigga")) }

    #[test]
    fn retired_room_snapshot_cannot_replace_new_checkouts_history() {
        let root = std::env::temp_dir().join(format!("apex-snapshot-retired-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let old = root.join("old"); let new = root.join("new");
        std::fs::create_dir_all(&old).unwrap(); std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("old.txt"), "old checkout").unwrap();
        std::fs::write(new.join("new.txt"), "new checkout").unwrap();
        let snapshots = Snapshots::new(root.join("snapshots"));
        snapshots.take("r", &new, 5, Kind::Open, None).unwrap();
        let retired = std::sync::atomic::AtomicBool::new(true);
        let late = snapshots.take_if_live("r", &old, 0, Kind::Open, None, &retired);
        assert!(late.is_err(), "a queued job from the retired room must be discarded");
        assert_eq!(snapshots.load("r").cwd, new.to_string_lossy());
        assert_eq!(snapshots.load("r").checkpoints.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn revert_does_not_follow_a_replaced_ancestor_symlink() {
        let (cwd, snaps) = folder("ancestor-symlink");
        snaps.take("t", &cwd, 0, Kind::Open, None).unwrap();
        snaps.take("t", &cwd, 0, Kind::Send, None).unwrap();
        std::fs::create_dir(cwd.join("sub")).unwrap();
        std::fs::write(cwd.join("sub/victim"), "task").unwrap();
        snaps.take("t", &cwd, 1, Kind::Idle, None).unwrap();
        let plan = snaps.plan("t", &cwd, 0, None);
        let outside = cwd.parent().unwrap().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("victim"), "keep").unwrap();
        std::fs::remove_dir_all(cwd.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, cwd.join("sub")).unwrap();
        let paths = plan.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>();
        let failed = snaps.restore("t", &cwd, 0, None, &paths).unwrap();
        assert_eq!(std::fs::read_to_string(outside.join("victim")).unwrap(), "keep");
        assert_eq!(failed, vec!["sub/victim"]);
    }

    #[test]
    fn revert_puts_back_this_threads_files_and_leaves_others_alone() {
        let (cwd, snaps) = folder("revert");
        std::fs::write(cwd.join("a.txt"), "one\n").unwrap();
        std::fs::write(cwd.join(".gitignore"), "dist/\n").unwrap();
        std::fs::create_dir_all(cwd.join("node_modules/x")).unwrap();
        std::fs::write(cwd.join("node_modules/x/i.js"), "v1").unwrap();
        snaps.take("t", &cwd, 0, Kind::Open, None).unwrap();
        // You send message 0; the bot edits a.txt, makes dist/ and a new file, installs a package.
        snaps.take("t", &cwd, 0, Kind::Send, None).unwrap();
        snaps.take("t", &cwd, 1, Kind::Start, bot()).unwrap();
        std::fs::write(cwd.join("a.txt"), "two\n").unwrap();
        std::fs::create_dir_all(cwd.join("dist/js")).unwrap();
        std::fs::write(cwd.join("dist/js/out.js"), "built").unwrap();
        std::fs::write(cwd.join("shared.txt"), "bot\n").unwrap();
        std::fs::write(cwd.join("node_modules/x/i.js"), "v2").unwrap();
        snaps.take("t", &cwd, 2, Kind::Idle, None).unwrap();
        // Then someone else edits mine.txt and shared.txt while the thread is idle.
        std::fs::write(cwd.join("mine.txt"), "human\n").unwrap();
        std::fs::write(cwd.join("shared.txt"), "human\n").unwrap();

        let plan = snaps.plan("t", &cwd, 0, None);
        assert!(plan.available);
        let files: Vec<_> = plan.files.iter().map(|f| (f.path.as_str(), f.delete, f.conflict)).collect();
        assert_eq!(files, [("a.txt", false, false), ("shared.txt", true, true)]);

        let paths: Vec<String> = plan.files.iter().map(|f| f.path.clone()).collect();
        let failed = snaps.restore("t", &cwd, 0, None, &paths).unwrap();
        #[cfg(unix)]
        assert!(failed.is_empty());
        #[cfg(not(unix))]
        assert_eq!(failed, vec!["shared.txt"], "unsupported safe deletion must be reported");
        assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "one\n");
        assert_eq!(std::fs::read_to_string(cwd.join("dist/js/out.js")).unwrap(), "built", "folders the project ignores are left as they are");
        #[cfg(unix)]
        assert!(!cwd.join("shared.txt").exists());
        #[cfg(not(unix))]
        assert_eq!(std::fs::read_to_string(cwd.join("shared.txt")).unwrap(), "human\n");
        assert_eq!(std::fs::read_to_string(cwd.join("mine.txt")).unwrap(), "human\n", "someone else's file is untouched");
        assert_eq!(std::fs::read_to_string(cwd.join("node_modules/x/i.js")).unwrap(), "v2", "package folders are left as they are");

        snaps.rewind("t", &cwd, 0, None, Kind::Restore).unwrap();
        assert!(snaps.plan("t", &cwd, 0, None).files.is_empty(), "nothing of this thread's is left to undo");
    }

    #[cfg(not(unix))]
    #[test]
    fn checkpoint_deletion_refuses_unsupported_platform_without_touching_files() {
        let (cwd, _snaps) = folder("refuse-delete");
        std::fs::write(cwd.join("keep.txt"), "human").unwrap();
        let error = remove_project_file(&cwd, "keep.txt").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read_to_string(cwd.join("keep.txt")).unwrap(), "human");
    }

    #[test]
    fn retry_goes_back_to_when_that_bot_started() {
        let (cwd, snaps) = folder("retry");
        std::fs::write(cwd.join("a.txt"), "0\n").unwrap();
        snaps.take("t", &cwd, 0, Kind::Send, None).unwrap();
        snaps.take("t", &cwd, 1, Kind::Start, Some(ParticipantId::new("first"))).unwrap();
        std::fs::write(cwd.join("a.txt"), "1\n").unwrap();
        snaps.take("t", &cwd, 2, Kind::Start, bot()).unwrap();
        std::fs::write(cwd.join("a.txt"), "2\n").unwrap();
        snaps.take("t", &cwd, 3, Kind::Idle, None).unwrap();
        let plan = snaps.plan("t", &cwd, 2, bot().as_ref());
        assert_eq!(plan.files.len(), 1);
        snaps.restore("t", &cwd, 2, bot().as_ref(), &["a.txt".into()]).unwrap();
        assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "1\n");
    }

    #[test]
    fn no_snapshot_means_chat_only_and_commands_are_listed() {
        let (cwd, snaps) = folder("none");
        assert!(!snaps.plan("t", &cwd, 0, None).available);
        snaps.take("t", &cwd, 0, Kind::Send, None).unwrap();
        snaps.note_command("t", 1, &ParticipantId::new("jigga"), "Running: git push origin main");
        snaps.note_command("t", 1, &ParticipantId::new("jigga"), "Running: ls");
        let plan = snaps.plan("t", &cwd, 0, None);
        assert_eq!(plan.effects.len(), 1);
        assert!(irreversible("npm i -g pnpm") && !irreversible("npm test"));
    }

    fn files_in(snaps: &Snapshots, cwd: &Path, tree: &str) -> Vec<String> {
        let store = snaps.store(cwd).unwrap();
        text(git(&store, cwd, None, &["ls-tree", "-r", "--name-only", tree], None).unwrap()).lines().map(String::from).collect()
    }

    #[test]
    fn snapshots_leave_out_folders_the_project_ignores_but_keep_ignored_files() {
        let (cwd, snaps) = folder("ignored");
        std::fs::write(cwd.join("a.txt"), "one\n").unwrap();
        std::fs::create_dir_all(cwd.join("release/app")).unwrap();
        std::fs::write(cwd.join("release/app/build.bin"), "artifact").unwrap();
        std::fs::write(cwd.join(".env"), "KEY=1\n").unwrap();
        // Saved before anything was ignored.
        let before = snaps.take("t", &cwd, 0, Kind::Open, None).unwrap();
        assert!(files_in(&snaps, &cwd, &before.tree).contains(&"release/app/build.bin".to_string()));

        // Build output in an ignored folder can be gigabytes; a secret file is small and worth restoring.
        std::fs::write(cwd.join(".gitignore"), "release/\n.env\n").unwrap();
        std::fs::write(cwd.join("release/app/more.bin"), "artifact").unwrap();
        let after = snaps.take("t", &cwd, 1, Kind::Send, None).unwrap();
        assert_eq!(files_in(&snaps, &cwd, &after.tree), [".env", ".gitignore", "a.txt"], "an ignored folder is left out, even what an earlier snapshot saved");
    }

    #[test]
    fn a_slow_snapshot_holds_up_only_its_own_thread() {
        let (cwd, snaps) = folder("parallel");
        std::fs::write(cwd.join("a.txt"), "x").unwrap();
        let snaps = std::sync::Arc::new(snaps);
        // Thread "slow" is in the middle of a long snapshot of the same folder.
        let slow = snaps.thread_lock("slow");
        let _taking = slow.lock().unwrap();
        let (done, finished) = std::sync::mpsc::channel();
        let other = std::sync::Arc::clone(&snaps);
        let cwd_other = cwd.clone();
        std::thread::spawn(move || {
            let _ = done.send(other.take("other", &cwd_other, 0, Kind::Send, None).map(|_| ()));
            other.note_command("other", 0, &ParticipantId::new("jigga"), "Running: git push");
            other.delete("other");
        });
        assert!(finished.recv_timeout(std::time::Duration::from_secs(10)).expect("another thread's snapshot waited for the slow one").is_ok());
    }

    #[test]
    fn noting_a_command_does_not_wait_for_its_threads_slow_snapshot() {
        let (cwd, snaps) = folder("note-mid-snapshot");
        snaps.take("t", &cwd, 0, Kind::Send, None).unwrap();
        let snaps = std::sync::Arc::new(snaps);
        // Another bot in "t" is starting, and its snapshot of a large folder takes minutes.
        let slow = snaps.hold_for_test("t");
        let taking = slow.lock().unwrap();
        let (done, noted) = std::sync::mpsc::channel();
        let other = std::sync::Arc::clone(&snaps);
        std::thread::spawn(move || {
            other.note_command("t", 1, &ParticipantId::new("jigga"), "Running: git push origin main");
            let _ = done.send(());
        });
        let noted = noted.recv_timeout(std::time::Duration::from_secs(10));
        drop(taking);
        noted.expect("noting a bot's command waited for its thread's snapshot");
        let effects = snaps.plan("t", &cwd, 0, None).effects;
        assert_eq!(effects, [SideEffect { seq: 1, by: ParticipantId::new("jigga"), command: "Running: git push origin main".into() }]);
    }

    #[test]
    fn repos_git_folder_is_never_written() {
        let (cwd, snaps) = folder("git");
        assert!(Command::new("git").arg("-C").arg(&cwd).args(["init", "-q"]).status().unwrap().success());
        std::fs::write(cwd.join("a.txt"), "x").unwrap();
        let before = std::fs::read_dir(cwd.join(".git/objects")).unwrap().count();
        snaps.take("t", &cwd, 0, Kind::Open, None).unwrap();
        assert_eq!(std::fs::read_dir(cwd.join(".git/objects")).unwrap().count(), before);
        assert!(!cwd.join(".git/index").exists());
    }
}
