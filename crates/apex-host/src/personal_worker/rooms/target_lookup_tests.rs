use super::*;
use crate::{HostPaths, personal::PersonalAssistant};
use std::{path::PathBuf, time::Instant};

struct Fixture {
    root: PathBuf,
    host: Arc<Host>,
    assistant: PersonalAssistant,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("apex-target-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let host = Host::new(HostPaths { data: root.join("data"), downloads: None }, tokio::runtime::Handle::current());
        std::fs::write(root.join("data/host-id"), "owner").unwrap();
        let cwd = root.join("project");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap().to_string_lossy().into_owned();
        let worker = serde_json::from_value(json!({"id":"worker","display_name":"Worker","backend":{"kind":"open_ai_compatible","base_url":"http://127.0.0.1:9/v1","model":"text"}})).unwrap();
        host.room_create("selected".into(), vec![worker], Default::default(), Some(cwd.clone())).unwrap();
        host.store().save_session(&json!({"workspaces":[{"id":"project","path":cwd}],"panes":[{"kind":"chat","id":"selected","workspaceId":"project","title":"Selected title"}]})).unwrap();
        let assistant = serde_json::from_value(json!({"id":"assistant","name":"Assistant","style":"","hostId":"owner","profile":null,"allowedFolders":[cwd],"paused":false,"revision":1,"createdAt":0,"counters":{"message":0,"event":0,"task":0,"decision":0},"messages":[],"events":[],"tasks":[],"projects":[{"project":{"hostId":"owner","workspaceId":"project","cwd":cwd},"tools":"full"}]})).unwrap();
        Self { root, host, assistant }
    }

    fn room_file(&self, id: &str) -> PathBuf {
        self.root.join("data/saved-chats-v1/rooms").join(format!("{}.json", id.bytes().map(|b| format!("{b:02x}")).collect::<String>()))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
}

#[tokio::test]
async fn exact_target_survives_an_unrelated_unreadable_saved_room() {
    let f = Fixture::new();
    std::fs::write(f.room_file("unrelated"), b"not valid saved-room JSON").unwrap();
    let target = f.host.personal_room_target(&f.assistant, "selected").expect("unrelated damage must not block a valid exact action target");
    assert_eq!(target.thread, "selected");
    assert_eq!(target.title, "Selected title");
    assert_eq!(target.workers, vec![("worker".into(), "Worker".into())]);
    assert_eq!(target.tools, ProjectTools::Full);
}

#[tokio::test]
async fn exact_target_rechecks_current_project_and_archive_boundaries() {
    for change in ["off", "unassigned", "folder-revoked", "workspace-moved", "room-moved", "session-archived", "meta-archived", "missing", "foreign-host"] {
        let mut f = Fixture::new();
        assert!(f.host.personal_room_target(&f.assistant, "selected").is_ok());
        match change {
            "off" => f.assistant.projects[0].tools = ProjectTools::Off,
            "unassigned" => f.assistant.projects.clear(),
            "folder-revoked" => f.assistant.allowed_folders.clear(),
            "workspace-moved" => f.host.store().save_session(&json!({"workspaces":[{"id":"project","path":f.root}],"panes":[]})).unwrap(),
            "room-moved" => {
                let mut saved = f.host.store().room("selected").unwrap().unwrap();
                saved.cwd = Some(f.root.canonicalize().unwrap().to_string_lossy().into_owned());
                f.host.store().save_room("selected", &saved).unwrap();
            }
            "session-archived" => {
                let mut session = f.host.store().session().unwrap().unwrap();
                session["panes"][0]["archived"] = json!(true);
                f.host.store().save_session(&session).unwrap();
            }
            "meta-archived" => { f.host.chat_update_meta("selected".into(), None, Some(true), None).unwrap(); }
            "missing" => std::fs::remove_file(f.room_file("selected")).unwrap(),
            "foreign-host" => f.assistant.projects[0].project.host_id = "elsewhere".into(),
            _ => unreachable!(),
        }
        assert!(f.host.personal_room_target(&f.assistant, "selected").is_err(), "must reject changed boundary: {change}");
    }
}

#[tokio::test]
async fn exact_target_keeps_closed_room_access_and_current_title_precedence() {
    let mut f = Fixture::new();
    let mut session = f.host.store().session().unwrap().unwrap();
    session["panes"] = json!([]);
    f.host.store().save_session(&session).unwrap();
    f.host.chat_update_meta("selected".into(), Some("Current title".into()), None, None).unwrap();
    f.assistant.projects[0].tools = ProjectTools::Ask;
    let target = f.host.personal_room_target(&f.assistant, "selected").unwrap();
    assert_eq!(target.title, "Current title");
    assert_eq!(target.tools, ProjectTools::Ask);
    assert_eq!(target.project.cwd, f.root.join("project").canonicalize().unwrap().to_string_lossy());
}

#[tokio::test]
async fn exact_target_requires_the_selected_rooms_protected_authority() {
    let f = Fixture::new();
    let path = f.host.store().root().join("room-authority-v1.json");
    let mut authority: Value = serde_json::from_slice(&crate::authority_file::read(&path).unwrap()).unwrap();
    authority.as_object_mut().unwrap().remove("selected");
    crate::authority_file::write(&path, &serde_json::to_vec(&authority).unwrap()).unwrap();
    assert!(f.host.personal_room_target(&f.assistant, "selected").is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn exact_target_uses_canonical_folders_and_protected_room_fields() {
    let mut f = Fixture::new();
    let alias = f.root.join("alias");
    std::os::unix::fs::symlink(f.root.join("project"), &alias).unwrap();
    f.assistant.projects[0].project.cwd = alias.to_string_lossy().into_owned();
    f.assistant.allowed_folders = vec![alias.to_string_lossy().into_owned()];
    let path = f.room_file("selected");
    let mut untrusted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    untrusted["cwd"] = json!(f.root);
    untrusted["snapshot"]["participants"] = json!([]);
    std::fs::write(path, serde_json::to_vec(&untrusted).unwrap()).unwrap();
    let target = f.host.personal_room_target(&f.assistant, "selected").unwrap();
    assert_eq!(target.project.cwd, f.root.join("project").canonicalize().unwrap().to_string_lossy());
    assert_eq!(target.workers, vec![("worker".into(), "Worker".into())]);
}

#[tokio::test]
#[ignore = "bounded lookup measurement; run explicitly with --ignored --nocapture"]
async fn benchmark_exact_target_lookup_with_52_saved_rooms() {
    let f = Fixture::new();
    let saved = f.host.store().room("selected").unwrap().unwrap();
    for i in 0..51 { f.host.store().save_room(&format!("unrelated-{i:02}"), &saved).unwrap(); }
    let mut samples = Vec::new();
    let mut authority_reads = 0;
    for _ in 0..20 {
        let start = Instant::now();
        let (result, reads) = crate::authority_file::tests::track_reads(|| f.host.personal_room_target(&f.assistant, "selected"));
        result.unwrap();
        samples.push(start.elapsed().as_secs_f64() * 1_000.0);
        authority_reads += reads.iter().filter(|path| path.file_name().is_some_and(|name| name == "room-authority-v1.json")).count();
    }
    samples.sort_by(f64::total_cmp);
    println!("exact-target-benchmark rooms=52 iterations=20 median_ms={:.3} max_ms={:.3} authority_reads_per_lookup={}", samples[10], samples[19], authority_reads / 20);
}
