//! Selected-data-directory input history. Recall never submits an input.
use crate::input::{clean, Editor};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 500;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 256 * 1024;
const HISTORY_FILE: &str = "cli-input-history.json";
const LOCK_FILE: &str = "cli-input-history.lock";

#[derive(Debug)]
struct Navigation {
    index: usize,
    draft: Editor,
}

#[derive(Debug, Default)]
pub struct History {
    entries: Vec<String>,
    navigation: Option<Navigation>,
}
impl History {
    pub fn load(data: &Path) -> Result<Self, String> {
        let _lock = acquire_lock(data)?;
        Ok(Self {
            entries: read_entries(data)?,
            navigation: None,
        })
    }

    /// Record exactly what the person typed, before attachment paths are added.
    /// Re-read under a stable OS lock so another CLI's commits are retained.
    pub fn record(&mut self, data: &Path, text: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Ok(());
        }
        if text.len() > MAX_ENTRY_BYTES {
            return Err("Input is too large for command history".into());
        }
        let _lock = acquire_lock(data)?;
        let mut entries = read_entries(data)?;
        entries.push(clean(text));
        bound_entries(&mut entries)?;
        write_entries(data, &entries)?;
        self.entries = entries;
        self.reset_navigation();
        Ok(())
    }

    pub fn reset_navigation(&mut self) {
        self.navigation = None;
    }

    /// Leaving a thread during recall must save its unfinished draft, including
    /// its caret, rather than replacing that draft with a history candidate.
    pub fn restore_draft(&mut self, editor: &mut Editor) {
        if let Some(navigation) = self.navigation.take() {
            *editor = navigation.draft;
        }
    }

    pub fn previous(&mut self, editor: &mut Editor) -> bool {
        let index = match self.navigation.as_ref() {
            Some(navigation) => match navigation.index.checked_sub(1) {
                Some(index) => index,
                None => return false,
            },
            None => {
                let Some(index) = self.entries.len().checked_sub(1) else {
                    return false;
                };
                self.navigation = Some(Navigation {
                    index,
                    draft: editor.clone(),
                });
                index
            }
        };
        self.navigation.as_mut().unwrap().index = index;
        editor.text = self.entries[index].clone();
        editor.end();
        true
    }

    pub fn next(&mut self, editor: &mut Editor) -> bool {
        let Some(navigation) = self.navigation.as_mut() else {
            return false;
        };
        let index = navigation.index + 1;
        if index == self.entries.len() {
            self.restore_draft(editor);
        } else {
            navigation.index = index;
            editor.text = self.entries[index].clone();
            editor.end();
        }
        true
    }
}

fn private_file(path: &Path, create: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    }
    #[cfg(not(unix))]
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Command history cannot use a symbolic link".into());
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Command history: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Command history requires a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Command history requires a private file owned by you".into());
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(file)
}

fn acquire_lock(data: &Path) -> Result<File, String> {
    fs::create_dir_all(data).map_err(|e| format!("Command history: {e}"))?;
    let file = private_file(&data.join(LOCK_FILE), true)?;
    let started = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock)
                if started.elapsed() < Duration::from_secs(2) =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("Command history is busy in another CLI; input was not saved".into())
            }
            Err(e) => return Err(format!("Command history lock: {e}")),
        }
    }
}

fn read_entries(data: &Path) -> Result<Vec<String>, String> {
    let path = data.join(HISTORY_FILE);
    // Check absence without following symlinks; dangling links must be refused.
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("Command history: {e}")),
        Ok(_) => {}
    }
    let file = private_file(&path, false)?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES as u64 {
        return Err("Command history exceeds the 2 MiB limit".into());
    }
    let mut bytes = vec![];
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Command history exceeds the 2 MiB limit".into());
    }
    let mut entries: Vec<String> =
        serde_json::from_slice(&bytes).map_err(|e| format!("Cannot read command history: {e}"))?;
    entries = entries
        .into_iter()
        .filter(|text| text.len() <= MAX_ENTRY_BYTES)
        .map(|text| clean(&text))
        .filter(|text| !text.trim().is_empty())
        .collect();
    bound_entries(&mut entries)?;
    Ok(entries)
}

fn bound_entries(entries: &mut Vec<String>) -> Result<(), String> {
    let sizes = entries
        .iter()
        .map(|entry| serde_json::to_vec(entry).map(|v| v.len()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut bytes = 2 + sizes.iter().sum::<usize>() + entries.len().saturating_sub(1);
    let mut removed = 0;
    while entries.len() - removed > MAX_ENTRIES || bytes > MAX_BYTES {
        bytes -= sizes[removed] + usize::from(entries.len() - removed > 1);
        removed += 1;
    }
    entries.drain(..removed);
    Ok(())
}

fn write_entries(data: &Path, entries: &[String]) -> Result<(), String> {
    let bytes = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
    let temp = data.join(format!(".cli-input-history-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, data.join(HISTORY_FILE)).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        File::open(data)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
