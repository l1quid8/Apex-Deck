#![cfg(target_os = "linux")]
use apex_host::{Host, HostPaths};
use apex_host::assistant_tasks::{AssistantTasks, HumanRequest, TaskDestination, TaskOwner, TaskStatus};

fn root(suffix: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("linux-ledger-recovery-{}-{suffix}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn linux_corrupt_ledger_must_not_start_with_an_empty_fallback() {
    let root = root("corrupt");
    let path = root.join("assistant-tasks-v1.json");
    std::fs::write(&path, b"{damaged-but-recoverable").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = Host::try_new(HostPaths { data: root.clone(), downloads: None }, runtime.handle().clone());
    let accepted = result.is_ok();
    if let Ok(host) = result { host.shutdown(); }
    std::fs::remove_dir_all(root).unwrap();
    assert!(!accepted, "Linux accepted a corrupt task ledger as an empty task store");
}

#[test]
fn unavailable_ledger_must_not_overwrite_existing_linux_records() {
    let root = root("overwrite");
    let path = root.join("assistant-tasks-v1.json");
    let original = b"{damaged-but-recoverable";
    std::fs::write(&path, original).unwrap();
    assert!(AssistantTasks::open(&path).is_err());
    let store = AssistantTasks::unavailable(&path);
    let result = store.submit_human_request(HumanRequest {
        request_id: "after-failed-read".into(), text: "new request".into(), destination: None,
        owner: TaskOwner { workspace_id: "ws".into(), host_id: "local".into(), cwd: root.to_string_lossy().into_owned(), conversation_id: "parent".into() },
    }, "new request".into(), None);
    let preserved = std::fs::read(&path).unwrap() == original;
    std::fs::remove_dir_all(root).unwrap();
    assert!(result.is_err() && preserved, "Unavailable fallback accepted a write and replaced the original ledger: write_succeeded={}, preserved={preserved}", result.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn linux_startup_must_recover_a_never_started_queued_task() {
    let root = root("queued");
    let path = root.join("assistant-tasks-v1.json");
    let owner = TaskOwner { workspace_id: "ws".into(), host_id: "local".into(), cwd: root.to_string_lossy().into_owned(), conversation_id: "parent".into() };
    let destination = TaskDestination { thread_id: Some("missing-destination".into()), workers: vec!["worker".into()], new_thread: false };
    let store = AssistantTasks::open(&path).unwrap();
    let task = store.submit_human_request(HumanRequest { request_id: "queued-before-restart".into(), owner: owner.clone(), text: "work".into(), destination: Some(destination.clone()) }, "work".into(), Some(destination)).unwrap();
    assert_eq!(task.status, TaskStatus::Queued);
    drop(store);
    let host = Host::try_new(HostPaths { data: root.clone(), downloads: None }, tokio::runtime::Handle::current()).unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    let final_status = loop {
        let list = host.assistant_tasks_list(owner.clone()).unwrap();
        let status = list["tasks"].as_array().unwrap().iter().find(|item| item["id"] == task.id).unwrap()["status"].as_str().unwrap().to_owned();
        if status != "queued" || tokio::time::Instant::now() >= deadline { break status; }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    host.shutdown(); drop(host);
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(final_status, "failed", "Restart must try the queued task and report its missing destination instead of leaving it queued forever");
}
