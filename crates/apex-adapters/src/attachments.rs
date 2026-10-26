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

pub(crate) fn load(path: &Path, roots: &[PathBuf]) -> Result<Image, ParticipantError> {
    let fail = |why: String| {
        ParticipantError::Failed(format!(
            "Couldn't send attached image {}: {why}",
            path.display()
        ))
    };
    const MAX: u64 = 20 * 1024 * 1024;
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
    let file = std::fs::File::open(&canonical).map_err(|e| fail(e.to_string()))?;
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

pub(crate) fn for_request(request: &TurnRequest, roots: &[PathBuf]) -> Result<Vec<Image>, ParticipantError> {
    let texts: Vec<&str> = if request.unseen.is_empty() {
        request
            .turns
            .iter()
            .rev()
            .find(|t| t.role == Role::User)
            .map(|t| t.content.as_str())
            .into_iter()
            .collect()
    } else {
        request.unseen.iter().map(|m| m.text.as_str()).collect()
    };
    let mut found = Vec::new();
    for text in texts {
        for path in paths(text) {
            if !found.contains(&path) {
                found.push(path);
            }
        }
    }
    if found.len() > 10 {
        return Err(ParticipantError::Failed(
            "Attach at most 10 images per turn.".into(),
        ));
    }
    let mut images = Vec::new();
    // The 32 MB limit is on the images themselves; each is sent base64-encoded,
    // which is 4 bytes for every 3.
    const RAW_BUDGET: usize = 32 * 1024 * 1024;
    let encoded_budget = RAW_BUDGET.div_ceil(3) * 4;
    let mut encoded = 0;
    for path in found {
        let image = load(&path, roots)?;
        encoded += image.data.len();
        if encoded > encoded_budget {
            return Err(ParticipantError::Failed(
                "Attached images exceed 32 MB combined; attach smaller images.".into(),
            ));
        }
        images.push(image);
    }
    Ok(images)
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
        let request = TurnRequest { system: String::new(), turns: vec![apex_core::ViewTurn {
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
                let request = TurnRequest { system: String::new(), turns: vec![], unseen: vec![apex_core::Message { late_reply_from: None, origin_seq: None, origin: None, client_message_id: None, reply_to_client_message_id: None,
                    seq: 1, speaker: speaker.clone(), text: format!("Attached image: {}", folder.join("picture.png").display()),
                    servers: vec![], at: None,
                }], effort_override: None, access: None, plan: false, cwd: None };
                assert_eq!(for_request(&request, &roots).is_ok(), folder == &own, "{speaker:?}: {}", folder.display());
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
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
        assert_eq!(for_request(&request, &[path.parent().unwrap().to_owned()]).unwrap().len(), 1);
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
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        for _ in 0..100 {
            let dir = std::env::temp_dir().join(format!(
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
