use apex_cli::attachments::{append_message, parse_paths, pasted_paths, stage, validate};
use std::path::{Path, PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("apex-attachments-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn parses_quoted_escaped_unicode_and_literal_shell_syntax_without_evaluation() {
    let paths = parse_paths(
        r#""screen one.png" 'résumé 你好.pdf' third\ file.txt '$(touch nope);*.txt'"#,
        Path::new("/launch"),
    )
    .unwrap();
    assert_eq!(
        paths,
        [
            "/launch/screen one.png",
            "/launch/résumé 你好.pdf",
            "/launch/third file.txt",
            "/launch/$(touch nope);*.txt"
        ]
        .map(PathBuf::from)
    );
    for bad in [
        "",
        "  ",
        "''",
        "'unfinished",
        "trailing\\",
        "'line\nbreak.txt'",
    ] {
        assert!(
            parse_paths(bad, Path::new("/launch")).is_err(),
            "accepted {bad:?}"
        );
    }
}

#[test]
fn expands_home_and_resolves_relative_paths_against_the_launch_folder() {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap();
    assert_eq!(
        parse_paths("~/Desktop/file.txt", Path::new("/launch")).unwrap(),
        vec![PathBuf::from(home).join("Desktop/file.txt")]
    );
    assert_eq!(
        parse_paths("../file.txt", Path::new("/launch/work")).unwrap(),
        vec![PathBuf::from("/launch/work/../file.txt")]
    );
    assert!(parse_paths("~someone/file", Path::new("/launch")).is_err());
}

#[cfg(unix)]
#[test]
fn parent_components_after_a_symlink_select_the_real_file() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    std::fs::create_dir_all(f.0.join("actual/nested")).unwrap();
    f.file("actual/chosen.txt", b"correct attachment");
    f.file("chosen.txt", b"wrong attachment");
    symlink(f.0.join("actual/nested"), f.0.join("link")).unwrap();
    let parsed = parse_paths("link/../chosen.txt", &f.0).unwrap();
    assert_eq!(std::fs::read(&parsed[0]).unwrap(), b"correct attachment");
    f.file("missing-at-target.txt", b"must not attach this");
    let missing = parse_paths("link/../missing-at-target.txt", &f.0).unwrap();
    assert!(!missing[0].exists(), "a missing symlink-relative path must stay missing");
}

#[test]
fn paste_only_stages_an_entire_list_of_existing_regular_files() {
    let f = Fixture::new();
    let one = f.file("one file.txt", b"one");
    let two = f.file("two.txt", b"two");
    assert_eq!(
        pasted_paths("'one file.txt' two.txt", &f.0),
        Some(vec![one, two])
    );
    for text in [
        "this is ordinary prose",
        "two.txt missing.txt",
        "two.txt and",
        ".",
        "'unfinished",
    ] {
        assert!(
            pasted_paths(text, &f.0).is_none(),
            "recognized prose/non-file {text:?}"
        );
    }
}

#[test]
fn stage_preserves_visible_errors_for_missing_directories_control_names_and_oversize_files() {
    let f = Fixture::new();
    let big = f.file("large.dat", b"");
    std::fs::File::options()
        .write(true)
        .open(&big)
        .unwrap()
        .set_len(20 * 1024 * 1024 + 1)
        .unwrap();
    let bad_name = f.file("bad\nname.txt", b"hi");
    let queued = stage(vec![f.0.join("missing"), f.0.clone(), bad_name, big]);
    assert_eq!(queued.len(), 4);
    assert!(queued.iter().all(|item| item.error.is_some()));
    assert!(validate(&queued).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_devices_and_fifos_without_opening_a_blocking_stream() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let f = Fixture::new();
    let fifo = f.0.join("pipe");
    let raw = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
    let queued = stage(vec![fifo, PathBuf::from("/dev/null")]);
    assert_eq!(queued.len(), 2);
    assert!(queued.iter().all(|item| item
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("regular file")));
}

#[test]
fn rejects_unsupported_image_contents_and_counts_images_before_send() {
    let f = Fixture::new();
    let valid = f.file("screen.png", b"\x89PNG\r\n\x1a\ncontents");
    let unsupported = stage(vec![f.file("photo.heic", b"heic")]);
    assert!(unsupported[0]
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("PNG, JPEG, GIF or WebP"));
    let invalid = stage(vec![f.file("pretend.png", b"plain text")]);
    assert!(invalid[0].error.is_some());
    let queued = stage(vec![valid; 11]);
    assert!(validate(&queued).unwrap_err().contains("10 images"));
}

#[test]
fn attachment_only_message_uses_saved_paths_and_never_original_sources() {
    let f = Fixture::new();
    let mut queued = stage(vec![
        f.file("notes.txt", b"notes"),
        f.file("screen.png", b"\x89PNG\r\n\x1a\ncontents"),
    ]);
    assert!(append_message("", &queued).is_err());
    queued[0].stored = Some("/data/attachments/thread/notes.txt".into());
    queued[1].stored = Some("/data/attachments/thread/screen.png".into());
    assert_eq!(append_message("", &queued).unwrap(), "Attached file: /data/attachments/thread/notes.txt\nAttached image: /data/attachments/thread/screen.png");
    assert_eq!(append_message("Explain", &queued).unwrap(), "Explain\n\nAttached file: /data/attachments/thread/notes.txt\nAttached image: /data/attachments/thread/screen.png");
}

#[test]
fn rejects_combined_images_above_the_provider_budget_without_reading_the_whole_files() {
    let f = Fixture::new();
    let one = f.file("one.png", b"\x89PNG\r\n\x1a\n");
    let two = f.file("two.png", b"\x89PNG\r\n\x1a\n");
    for path in [&one, &two] {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(17 * 1024 * 1024)
            .unwrap();
    }
    let queued = stage(vec![one, two]);
    assert!(queued.iter().all(|item| item.error.is_none()));
    assert!(validate(&queued).unwrap_err().contains("32 MB"));
}
