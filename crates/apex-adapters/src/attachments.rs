//! Convert saved attachment references into model input, without persisting bytes
//! in the transcript. Only unseen messages are loaded; old paths stay as context.
use apex_core::{ParticipantError, Role, TurnRequest};
use base64::Engine;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(crate) struct Image {
    pub path: PathBuf,
    pub mime: &'static str,
    pub data: String,
}
impl Image {
    pub fn url(&self) -> String {
        format!("data:{};base64,{}", self.mime, self.data)
    }
    pub fn claude(&self) -> Value {
        json!({"type":"image", "source":{"type":"base64", "media_type":self.mime, "data":self.data}})
    }
}

pub(crate) fn paths(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| line.strip_prefix("Attached image: "))
        .map(|path| PathBuf::from(path.trim()))
        .collect()
}

const MAX: u64 = 20 * 1024 * 1024;

fn reason(path: &Path, why: impl std::fmt::Display) -> String {
    format!("Couldn't send attached image {}: {why}", path.display())
}

fn failed(path: &Path, why: impl std::fmt::Display) -> ParticipantError {
    ParticipantError::Failed(reason(path, why))
}

pub(crate) fn load(path: &Path, roots: &[PathBuf]) -> Result<Image, ParticipantError> {
    read(path, &check(path, roots)?)
}

/// Every check that doesn't need the file's contents. Returns the real path
/// and the size on disk, so a caller can skip a file before reading it.
fn check(path: &Path, roots: &[PathBuf]) -> Result<(PathBuf, u64), ParticipantError> {
    let fail = |why: String| failed(path, why);
    if !path.is_absolute() {
        return Err(fail("attachment paths must be absolute".into()));
    }
    let canonical = path.canonicalize().map_err(|e| fail(e.to_string()))?;
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err(fail("image is outside the host-authorized attachment folders".into()));
    }
    let metadata = std::fs::metadata(&canonical).map_err(|e| fail(e.to_string()))?;
    if !metadata.is_file() {
        return Err(fail("attachment is not a regular file".into()));
    }
    if metadata.len() > MAX {
        return Err(fail("image exceeds 20 MB; attach a smaller image".into()));
    }
    Ok((canonical, metadata.len()))
}

fn read(path: &Path, (canonical, _): &(PathBuf, u64)) -> Result<Image, ParticipantError> {
    let fail = |why: String| failed(path, why);
    let file = std::fs::File::open(canonical).map_err(|e| fail(e.to_string()))?;
    let mut bytes = Vec::new();
    file.take(MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| fail(e.to_string()))?;
    if bytes.len() as u64 > MAX {
        return Err(fail("image exceeds 20 MB; attach a smaller image".into()));
    }
    let mime = match bytes.as_slice() {
        [0x89, b'P', b'N', b'G', 13, 10, 26, 10, ..] => "image/png",
        [0xff, 0xd8, 0xff, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => {
            return Err(fail(
                "unsupported image format; attach PNG, JPEG, GIF or WebP".into(),
            ))
        }
    };
    Ok(Image {
        path: path.to_owned(),
        mime,
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Images for one turn, plus older ones that couldn't be sent.
pub(crate) struct Loaded {
    pub images: Vec<Image>,
    /// Why each skipped image from an earlier unseen message was left out.
    pub skipped: Vec<String>,
}
impl Loaded {
    /// Tells the bot an earlier image is missing.
    pub fn note(&self) -> Option<String> {
        if self.skipped.is_empty() {
            return None;
        }
        let mut note = String::from("[Deck: these images from earlier messages were left out and not sent to you:");
        for why in &self.skipped {
            note.push_str("\n- ");
            note.push_str(why);
        }
        note.push(']');
        Some(note)
    }
    /// The transcript with the note added as the last message. It quotes paths
    /// written in messages, so it goes with the messages, not the instructions.
    pub fn with_note<'a>(&self, turns: &'a [apex_core::ViewTurn]) -> std::borrow::Cow<'a, [apex_core::ViewTurn]> {
        match self.note() {
            None => std::borrow::Cow::Borrowed(turns),
            Some(content) => {
                let mut turns = turns.to_vec();
                turns.push(apex_core::ViewTurn { role: Role::User, content });
                std::borrow::Cow::Owned(turns)
            }
        }
    }
}

/// Images in the newest message must load or the turn fails, so the sender
/// hears about it. Images in older unseen messages are skipped with a note,
/// so one stale reference can't block every later reply.
pub(crate) fn for_request(request: &TurnRequest, roots: &[PathBuf]) -> Result<Loaded, ParticipantError> {
    load_within(request, roots, 32 * 1024 * 1024)
}

/// Base64 sends 4 bytes for every 3.
fn encoded_len(raw: usize) -> usize {
    raw.div_ceil(3) * 4
}

/// One attached path, where it was last mentioned, and whether the newest
/// message mentions it.
struct Found {
    path: PathBuf,
    last: usize,
    newest: bool,
}

/// `raw_budget` is the combined size limit in image bytes (32 MB in real turns).
fn load_within(request: &TurnRequest, roots: &[PathBuf], raw_budget: usize) -> Result<Loaded, ParticipantError> {
    let (texts, newest): (Vec<&str>, usize) = if request.unseen.is_empty() {
        let last_user = request.turns.iter().rev().find(|t| t.role == Role::User);
        (last_user.map(|t| t.content.as_str()).into_iter().collect(), 0)
    } else {
        // The newest message is the human's newest, even when bot replies came
        // after it. With no unseen human message, it's the last unseen one.
        let unseen = &request.unseen;
        let newest = unseen.iter().rposition(|m| m.speaker == apex_core::Speaker::Human).unwrap_or(unseen.len() - 1);
        (unseen.iter().map(|m| m.text.as_str()).collect(), newest)
    };
    // A path repeated in the newest message counts as newest.
    let mut found: Vec<Found> = Vec::new();
    for (index, text) in texts.into_iter().enumerate() {
        for path in paths(text) {
            match found.iter_mut().find(|seen| seen.path == path) {
                Some(seen) => {
                    seen.last = index;
                    seen.newest |= index == newest;
                }
                None => found.push(Found { path, last: index, newest: index == newest }),
            }
        }
    }
    // Only the newest message counts toward the 10-image and 32 MB limits, and
    // fails loudly if it alone goes over. Older images fill what it leaves.
    const LIMIT: usize = 10;
    if found.iter().filter(|f| f.newest).count() > LIMIT {
        return Err(ParticipantError::Failed(
            "Attach at most 10 images per turn.".into(),
        ));
    }
    let encoded_budget = encoded_len(raw_budget);
    let mut encoded = 0;
    let mut slots: Vec<Option<Image>> = Vec::with_capacity(found.len());
    for f in &found {
        if !f.newest {
            slots.push(None);
            continue;
        }
        let image = load(&f.path, roots)?;
        encoded += image.data.len();
        if encoded > encoded_budget {
            return Err(ParticipantError::Failed(
                "Attached images exceed 32 MB combined; attach smaller images.".into(),
            ));
        }
        slots.push(Some(image));
    }
    // Older images fill the places left, newest message first (in reading
    // order within a message). Any that can't be sent are skipped with a note.
    let mut older: Vec<usize> = (0..found.len()).filter(|&i| !found[i].newest).collect();
    older.sort_by_key(|&i| std::cmp::Reverse(found[i].last));
    let mut free = LIMIT - slots.iter().flatten().count();
    let mut skipped = Vec::new();
    for i in older {
        let path = &found[i].path;
        let too_big = || reason(path, "a turn sends at most 32 MB of images");
        if free == 0 {
            skipped.push(reason(path, "a turn sends at most 10 images"));
            continue;
        }
        let image = match check(path, roots) {
            // Skip by size on disk first, so a picture that can't fit isn't read.
            Ok(checked) if encoded + encoded_len(checked.1 as usize) > encoded_budget => {
                skipped.push(too_big());
                continue;
            }
            Ok(checked) => read(path, &checked),
            Err(e) => Err(e),
        };
        let image = match image {
            Ok(image) => image,
            Err(ParticipantError::Failed(why)) => {
                skipped.push(why);
                continue;
            }
            Err(e) => return Err(e),
        };
        // The file may have grown since its size was checked.
        if encoded + image.data.len() > encoded_budget {
            skipped.push(too_big());
            continue;
        }
        encoded += image.data.len();
        free -= 1;
        slots[i] = Some(image);
    }
    // Images keep the order of the messages they came from.
    let images = slots.into_iter().flatten().collect();
    Ok(Loaded { images, skipped })
}

pub(crate) fn claude_content(prompt: &str, images: &[Image]) -> Value {
    if images.is_empty() {
        return json!(prompt);
    }
    let mut parts = vec![json!({"type":"text", "text":prompt})];
    parts.extend(images.iter().map(Image::claude));
    json!(parts)
}

pub(crate) fn codex_input(prompt: &str, images: &[Image]) -> Value {
    let mut parts = vec![json!({"type":"text", "text":prompt})];
    // Data URLs avoid requiring the sandbox to read a path outside the workspace.
    parts.extend(
        images
            .iter()
            .map(|image| json!({"type":"image", "url":image.url()})),
    );
    json!(parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
    fn fixture(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("apex-image-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path.canonicalize().unwrap()
    }
    #[test]
    fn transcript_paths_without_host_authority_are_rejected() {
        let path = fixture("outside.png", PNG);
        let request = TurnRequest { computer: None, system: String::new(), turns: vec![apex_core::ViewTurn {
            role: Role::User, content: format!("Attached image: {}", path.display())
        }], unseen: vec![], effort_override: None, access: None, plan: false, cwd: None };
        let result = for_request(&request, &[]);
        std::fs::remove_file(path).unwrap();
        assert!(result.is_err(), "transcript text alone must not authorize reading a file");
    }
    #[test]
    fn canonical_roots_reject_outside_files_and_symlink_escapes() {
        let dir = std::env::temp_dir().join(format!("apex-image-roots-{}", std::process::id()));
        let trusted = dir.join("attachments");
        std::fs::create_dir_all(&trusted).unwrap();
        let outside = dir.join("outside.png");
        let inside = trusted.join("inside.png");
        std::fs::write(&outside, PNG).unwrap();
        std::fs::write(&inside, PNG).unwrap();
        let roots = vec![trusted.canonicalize().unwrap()];
        assert!(load(&inside, &roots).is_ok());
        assert!(load(&outside, &roots).is_err());
        assert!(load(&roots[0].join("../outside.png"), &roots).is_err());
        #[cfg(unix)] {
            let link = roots[0].join("escape.png");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(load(&link, &roots).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn human_and_bot_references_cannot_read_sibling_threads_or_library() {
        let dir = std::env::temp_dir().join(format!("apex-image-room-authority-{}", std::process::id()));
        let own = dir.join("attachments/a");
        let sibling = dir.join("attachments/b");
        let library = dir.join("library");
        for folder in [&own, &sibling, &library] {
            std::fs::create_dir_all(folder).unwrap();
            std::fs::write(folder.join("picture.png"), PNG).unwrap();
        }
        let roots = vec![own.canonicalize().unwrap()];
        for speaker in [apex_core::Speaker::Human, apex_core::Speaker::Bot(apex_core::ParticipantId::new("image-bot"))] {
            for folder in [&own, &sibling, &library] {
                let request = TurnRequest { computer: None, system: String::new(), turns: vec![], unseen: vec![apex_core::Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None,
                    seq: 1, speaker: speaker.clone(), text: format!("Attached image: {}", folder.join("picture.png").display()),
                    servers: vec![], at: None,
                }], effort_override: None, access: None, plan: false, cwd: None };
                assert_eq!(for_request(&request, &roots).is_ok(), folder == &own, "{speaker:?}: {}", folder.display());
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn unseen(seq: usize, text: String) -> apex_core::Message {
        apex_core::Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None,
            seq, speaker: apex_core::Speaker::Human, text, servers: vec![], at: None }
    }
    fn queue(messages: Vec<apex_core::Message>) -> TurnRequest {
        TurnRequest { computer: None, system: String::new(), turns: vec![], unseen: messages, effort_override: None, access: None, plan: false, cwd: None }
    }
    #[test]
    fn an_older_unreadable_image_is_skipped_so_the_newest_message_still_gets_a_reply() {
        // A thread whose first message points at another thread's folder (asst-1).
        let dir = std::env::temp_dir().join(format!("apex-image-queue-lock-{}", std::process::id()));
        let own = dir.join("attachments/plan-color-scheme-fix");
        let other = dir.join("attachments/asst-1");
        for folder in [&own, &other] {
            std::fs::create_dir_all(folder).unwrap();
        }
        std::fs::write(other.join("Pasted-Graphic.png"), PNG).unwrap();
        let roots = vec![own.canonicalize().unwrap()];
        let request = queue(vec![
            unseen(1, format!("Look at this\nAttached image: {}", other.join("Pasted-Graphic.png").display())),
            unseen(2, "@null please reply".into()),
        ]);
        let result = for_request(&request, &roots);
        std::fs::remove_dir_all(&dir).unwrap();
        let loaded = result.expect("an old unreadable image must not block the reply");
        assert!(loaded.images.is_empty());
        assert_eq!(loaded.skipped.len(), 1);
        assert!(loaded.skipped[0].contains("Pasted-Graphic.png") && loaded.skipped[0].contains("outside the host-authorized attachment folders"));
        let note = loaded.note().expect("the bot is told an image was left out");
        assert!(note.contains("left out") && note.contains("Pasted-Graphic.png"));
    }
    #[test]
    fn an_unreadable_image_in_the_newest_message_still_fails_loudly() {
        let dir = std::env::temp_dir().join(format!("apex-image-newest-loud-{}", std::process::id()));
        let own = dir.join("attachments/own");
        let other = dir.join("attachments/asst-1");
        for folder in [&own, &other] {
            std::fs::create_dir_all(folder).unwrap();
            std::fs::write(folder.join("picture.png"), PNG).unwrap();
        }
        let roots = vec![own.canonicalize().unwrap()];
        // Also when the same bad path appeared earlier: the newest message wins.
        let bad = format!("Attached image: {}", other.join("picture.png").display());
        let alone = for_request(&queue(vec![unseen(1, bad.clone())]), &roots);
        let repeated = for_request(&queue(vec![unseen(1, bad.clone()), unseen(2, bad)]), &roots);
        // A good older image is still sent alongside a good newest one.
        let mixed = for_request(&queue(vec![
            unseen(1, format!("Attached image: {}", own.join("picture.png").display())),
            unseen(2, "no image".into()),
        ]), &roots);
        std::fs::remove_dir_all(&dir).unwrap();
        for result in [alone, repeated] {
            assert!(matches!(result, Err(ParticipantError::Failed(why)) if why.contains("outside the host-authorized attachment folders")));
        }
        let mixed = mixed.unwrap();
        assert_eq!((mixed.images.len(), mixed.skipped.len()), (1, 0));
        assert!(mixed.note().is_none());
    }
    #[test]
    fn only_the_newest_message_counts_toward_the_ten_image_limit() {
        let dir = std::env::temp_dir().join(format!("apex-image-limit-{}", std::process::id()));
        let own = dir.join("attachments/own");
        std::fs::create_dir_all(&own).unwrap();
        let roots = vec![own.canonicalize().unwrap()];
        let lines = |range: std::ops::Range<usize>| -> String {
            range.map(|i| {
                let path = own.join(format!("picture-{i}.png"));
                std::fs::write(&path, PNG).unwrap();
                format!("Attached image: {}\n", path.display())
            }).collect()
        };
        // 11 older images, newest has none: 10 are sent, the extra one is skipped with a note.
        let old_only = for_request(&queue(vec![unseen(1, lines(0..11)), unseen(2, "reply please".into())]), &roots);
        // 9 older + 3 newest: all 3 newest are sent, older fill the remaining 7 slots.
        let shared = for_request(&queue(vec![unseen(1, lines(20..29)), unseen(2, lines(30..33))]), &roots);
        // 11 in the newest message still fails loudly.
        let newest_over = for_request(&queue(vec![unseen(1, lines(40..51))]), &roots);
        std::fs::remove_dir_all(&dir).unwrap();
        let old_only = old_only.expect("older images must not trip the limit");
        assert_eq!((old_only.images.len(), old_only.skipped.len()), (10, 1));
        let note = old_only.note().unwrap();
        assert!(note.contains("picture-10.png") && note.contains("at most 10 images"), "{note}");
        let shared = shared.expect("older images must not trip the limit");
        assert_eq!((shared.images.len(), shared.skipped.len()), (10, 2));
        let sent: Vec<_> = shared.images.iter().map(|image| image.path.clone()).collect();
        for i in 30..33 {
            assert!(sent.iter().any(|p| p.ends_with(format!("picture-{i}.png"))), "newest picture-{i} must be sent");
        }
        assert!(matches!(newest_over, Err(ParticipantError::Failed(why)) if why.contains("at most 10 images")));
    }
    #[test]
    fn only_the_newest_message_counts_toward_the_size_limit() {
        // A 32-byte budget stands in for 32 MB so the fixtures stay tiny.
        // Each fixture is 24 raw bytes = 32 base64 bytes, so one fits and two don't.
        const BUDGET: usize = 24;
        let dir = std::env::temp_dir().join(format!("apex-image-size-{}", std::process::id()));
        let own = dir.join("attachments/own");
        std::fs::create_dir_all(&own).unwrap();
        let roots = vec![own.canonicalize().unwrap()];
        let picture = |name: &str| -> String {
            let path = own.join(name);
            let mut bytes = PNG.to_vec();
            bytes.resize(24, 0);
            std::fs::write(&path, bytes).unwrap();
            format!("Attached image: {}\n", path.display())
        };
        // Two older images, newest has none: the first fits, the second is skipped with a note.
        let old_only = load_within(&queue(vec![
            unseen(1, picture("old-a.png") + &picture("old-b.png")),
            unseen(2, "reply please".into()),
        ]), &roots, BUDGET);
        // An older image and a newest one: the newest claims the budget first.
        let shared = load_within(&queue(vec![
            unseen(1, picture("old-c.png")),
            unseen(2, picture("new-a.png")),
        ]), &roots, BUDGET);
        // Two images in the newest message alone still fail loudly.
        let newest_over = load_within(&queue(vec![unseen(1, picture("new-b.png") + &picture("new-c.png"))]), &roots, BUDGET);
        std::fs::remove_dir_all(&dir).unwrap();
        let old_only = old_only.expect("older images must not trip the size limit");
        assert_eq!((old_only.images.len(), old_only.skipped.len()), (1, 1));
        assert!(old_only.images[0].path.ends_with("old-a.png"));
        let note = old_only.note().unwrap();
        assert!(note.contains("old-b.png") && note.contains("at most 32 MB"), "{note}");
        let shared = shared.expect("an older image must not crowd out the newest one");
        assert_eq!((shared.images.len(), shared.skipped.len()), (1, 1));
        assert!(shared.images[0].path.ends_with("new-a.png"));
        assert!(shared.skipped[0].contains("old-c.png"));
        assert!(matches!(newest_over, Err(ParticipantError::Failed(why)) if why.contains("exceed 32 MB")));
    }
    fn said(seq: usize, speaker: apex_core::Speaker, text: String) -> apex_core::Message {
        apex_core::Message { speaker, ..unseen(seq, text) }
    }
    #[test]
    fn the_newest_message_is_the_humans_not_a_later_bot_reply() {
        // The human sends 6 pictures to two bots. The first bot replies, so the
        // second bot's unseen messages end with that reply, not the human's.
        let dir = std::env::temp_dir().join(format!("apex-image-anchor-{}", std::process::id()));
        let own = dir.join("attachments/own");
        let other = dir.join("attachments/asst-1");
        for folder in [&own, &other] {
            std::fs::create_dir_all(folder).unwrap();
        }
        let roots = vec![own.canonicalize().unwrap()];
        let lines = |prefix: &str, count: usize| -> String {
            (0..count).map(|i| {
                let path = own.join(format!("{prefix}-{i}.png"));
                std::fs::write(&path, PNG).unwrap();
                format!("Attached image: {}\n", path.display())
            }).collect()
        };
        let human = apex_core::Speaker::Human;
        let bot = apex_core::Speaker::Bot(apex_core::ParticipantId::new("jigga"));
        let request = queue(vec![
            said(1, human.clone(), lines("stale", 5)),
            said(2, bot.clone(), lines("recent", 3)),
            said(3, human.clone(), lines("mine", 6)),
            said(4, bot.clone(), "I replied first".into()),
        ]);
        let loaded = for_request(&request, &roots);
        // A bad picture in the human's newest message still fails loudly, even
        // when a bot reply came after it.
        std::fs::write(other.join("bad.png"), PNG).unwrap();
        let bad = for_request(&queue(vec![
            said(1, human.clone(), format!("Attached image: {}", other.join("bad.png").display())),
            said(2, bot.clone(), "I replied first".into()),
        ]), &roots);
        // With no unseen human message, the last unseen message is the newest.
        let bots_only = for_request(&queue(vec![
            said(1, bot.clone(), lines("first", 1)),
            said(2, bot.clone(), format!("Attached image: {}", other.join("bad.png").display())),
        ]), &roots);
        std::fs::remove_dir_all(&dir).unwrap();
        let loaded = loaded.expect("the human's pictures fit within 10");
        let sent: Vec<String> = loaded.images.iter()
            .map(|image| image.path.file_name().unwrap().to_string_lossy().into_owned()).collect();
        // All 6 of the human's pictures, then the 4 leftover places go newest
        // first: the bot's 3 recent ones, then the oldest message's first one.
        // Pictures still go out in the order of their messages.
        assert_eq!(sent, ["stale-0", "recent-0", "recent-1", "recent-2", "mine-0", "mine-1", "mine-2", "mine-3", "mine-4", "mine-5"]
            .map(|name| format!("{name}.png")));
        assert_eq!(loaded.skipped.len(), 4);
        assert!(loaded.skipped.iter().all(|why| why.contains("stale-") && why.contains("at most 10 images")), "{:?}", loaded.skipped);
        assert!(matches!(bad, Err(ParticipantError::Failed(why)) if why.contains("outside the host-authorized attachment folders")));
        assert!(matches!(bots_only, Err(ParticipantError::Failed(why)) if why.contains("outside the host-authorized attachment folders")));
    }
    #[cfg(unix)]
    #[test]
    fn an_older_image_that_cannot_fit_is_skipped_without_reading_it() {
        use std::os::unix::fs::PermissionsExt;
        const BUDGET: usize = 24;
        let dir = std::env::temp_dir().join(format!("apex-image-size-first-{}", std::process::id()));
        let own = dir.join("attachments/own");
        std::fs::create_dir_all(&own).unwrap();
        let roots = vec![own.canonicalize().unwrap()];
        // Bigger than what's left, and unreadable: if the loader read it before
        // checking its size, the skip reason would be the read error instead.
        let big = own.join("big.png");
        let mut bytes = PNG.to_vec();
        bytes.resize(64, 0);
        std::fs::write(&big, bytes).unwrap();
        std::fs::set_permissions(&big, std::fs::Permissions::from_mode(0o000)).unwrap();
        let result = load_within(&queue(vec![
            unseen(1, format!("Attached image: {}", big.display())),
            unseen(2, "reply please".into()),
        ]), &roots, BUDGET);
        std::fs::set_permissions(&big, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let loaded = result.unwrap();
        assert!(loaded.images.is_empty());
        assert_eq!(loaded.skipped.len(), 1);
        assert!(loaded.skipped[0].contains("big.png") && loaded.skipped[0].contains("at most 32 MB"), "{:?}", loaded.skipped);
    }
    #[test]
    fn the_left_out_note_goes_with_the_messages_not_the_instructions() {
        let turns = vec![apex_core::ViewTurn { role: Role::User, content: "[User]: hi".into() }];
        let nothing = Loaded { images: vec![], skipped: vec![] };
        assert_eq!(&*nothing.with_note(&turns), turns.as_slice());
        let missing = Loaded { images: vec![], skipped: vec!["Couldn't send attached image /a/old.png: gone".into()] };
        let with = missing.with_note(&turns);
        assert_eq!(with.len(), 2);
        assert_eq!(with[0], turns[0]);
        assert_eq!(with[1].role, Role::User);
        assert!(with[1].content.starts_with("[Deck:") && with[1].content.contains("/a/old.png"), "{}", with[1].content);
        // The note can't be mistaken for an attachment line.
        assert!(paths(&with[1].content).is_empty());
    }
    #[test]
    fn every_native_protocol_receives_the_image_bytes() {
        let path = fixture("native.png", PNG);
        let image = load(&path, &[path.parent().unwrap().to_owned()]).unwrap();
        std::fs::remove_file(&path).unwrap();
        let images = vec![image];
        let claude = claude_content("describe", &images);
        assert_eq!(claude[1]["source"]["media_type"], "image/png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(claude[1]["source"]["data"].as_str().unwrap())
                .unwrap(),
            PNG
        );
        let codex = codex_input("describe", &images);
        assert_eq!(codex[1]["type"], "image");
        assert_eq!(codex[1]["url"], images[0].url());
    }
    #[test]
    fn missing_and_unsupported_images_fail_clearly() {
        let path = fixture("bad.png", b"not an image");
        assert!(
            matches!(load(&path, &[path.parent().unwrap().to_owned()]), Err(ParticipantError::Failed(why)) if why.contains("unsupported image format"))
        );
        std::fs::remove_file(&path).unwrap();
        assert!(
            matches!(load(&path, &[path.parent().unwrap().to_owned()]), Err(ParticipantError::Failed(why)) if why.contains("Couldn't send attached image"))
        );
    }
    #[test]
    fn text_only_protocols_stay_unchanged() {
        assert_eq!(claude_content("hello", &[]), json!("hello"));
        assert_eq!(
            codex_input("hello", &[]),
            json!([{"type":"text","text":"hello"}])
        );
    }
    #[test]
    fn only_new_images_are_loaded_and_duplicates_are_sent_once() {
        let path = fixture("current.png", PNG);
        let text = format!(
            "Attached image: {}\nAttached image: {}",
            path.display(),
            path.display()
        );
        let request = TurnRequest {
            computer: None,
            system: String::new(),
            turns: vec![apex_core::ViewTurn {
                role: Role::User,
                content: "Attached image: /missing/old.png".into(),
            }],
            unseen: vec![apex_core::Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None,
                seq: 1,
                // Another participant's generated picture is also visible to this bot.
                speaker: apex_core::Speaker::Bot(apex_core::ParticipantId::new("venice")),
                text,
                servers: vec![],
                at: None,
            }],
            effort_override: None,
            access: None,
            plan: false,
            cwd: None,
        };
        assert_eq!(for_request(&request, &[path.parent().unwrap().to_owned()]).unwrap().images.len(), 1);
        std::fs::remove_file(path).unwrap();
    }
}

/// Private per-turn staging for CLIs that accept files instead of stdin blocks.
/// Kept alive until the child exits, then removed even on error/cancellation.
pub(crate) struct Staged {
    pub dir: PathBuf,
}
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
impl Staged {
    pub fn new() -> Result<Self, ParticipantError> {
        Self::new_in(&std::env::temp_dir())
    }
    /// Keep file-based image protocols inside an existing private process sandbox.
    pub(crate) fn new_in(parent: &Path) -> Result<Self, ParticipantError> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..100 {
            let dir = parent.join(format!(
                "apex-vision-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&dir) {
                Ok(()) => return Ok(Self { dir }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(ParticipantError::Failed(format!(
                        "Couldn't stage image input: {e}"
                    )))
                }
            }
        }
        Err(ParticipantError::Failed(
            "Couldn't create a private image input folder.".into(),
        ))
    }
    pub fn grok(&self, prompt: &str, images: &[Image]) -> Result<PathBuf, ParticipantError> {
        let mut parts = vec![json!({"type":"text", "text":prompt})];
        parts.extend(
            images
                .iter()
                .map(|image| json!({"type":"image", "mimeType":image.mime, "data":image.data})),
        );
        let path = self.dir.join("prompt.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&parts).expect("JSON values serialize"),
        )
        .map_err(|e| ParticipantError::Failed(format!("Couldn't stage Grok images: {e}")))?;
        Ok(path)
    }
    pub fn gemini(&self, prompt: &str, images: &[Image]) -> Result<String, ParticipantError> {
        let mut prompt = prompt.to_owned();
        prompt.push_str("\n\nImages submitted with this turn:\n");
        for (i, image) in images.iter().enumerate() {
            let extension = image.mime.strip_prefix("image/").unwrap();
            let path = self.dir.join(format!("image-{i}.{extension}"));
            // Use the already validated bytes, not a second read of the source.
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&image.data)
                .expect("loader encoded base64");
            std::fs::write(&path, bytes).map_err(|e| {
                ParticipantError::Failed(format!("Couldn't stage Gemini images: {e}"))
            })?;
            prompt.push('@');
            for ch in path.to_string_lossy().chars() {
                if ch.is_whitespace() || "\\'\"()[]{};&|*?$`!<>#".contains(ch) {
                    prompt.push('\\');
                }
                prompt.push(ch);
            }
            prompt.push('\n');
        }
        Ok(prompt)
    }
}

#[cfg(test)]
mod staging_tests {
    use super::*;
    #[test]
    fn grok_uses_acp_image_blocks_and_gemini_stages_bytes_in_an_allowed_folder() {
        let images = vec![Image {
            path: PathBuf::from("/original with spaces/photo.png"),
            mime: "image/png",
            data: base64::engine::general_purpose::STANDARD.encode(b"image bytes"),
        }];
        let staged = Staged::new().unwrap();
        let dir = staged.dir.clone();
        let input = staged.grok("describe", &images).unwrap();
        assert_eq!(input.extension().unwrap(), "json");
        let parts: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
        assert_eq!(parts[0], json!({"type":"text","text":"describe"}));
        assert_eq!(
            parts[1],
            json!({"type":"image","mimeType":"image/png","data":images[0].data})
        );
        let prompt = staged.gemini("describe", &images).unwrap();
        assert!(prompt.contains(&format!(
            "@{}",
            dir.join("image-0.png")
                .to_string_lossy()
                .replace('\\', "\\\\")
                .replace(' ', "\\ ")
        )));
        assert_eq!(
            std::fs::read(dir.join("image-0.png")).unwrap(),
            b"image bytes"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        drop(staged);
        assert!(!dir.exists());
    }
}
