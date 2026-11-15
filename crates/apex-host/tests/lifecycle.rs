//! Shared lifecycle contract, through the same command dispatcher as both clients.
use apex_host::{Command, Host, HostPaths};
use serde_json::{json, Value};
use std::sync::Arc;

struct Fixture { root: std::path::PathBuf, host: Arc<Host>, runtime: tokio::runtime::Runtime }
impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!("apex-lifecycle-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("project")).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let host = Self::open(&root, &runtime);
        Self { root, host, runtime }
    }
    fn open(root: &std::path::Path, runtime: &tokio::runtime::Runtime) -> Arc<Host> {
        apex_host::test_support::isolated_host_assuming_verified_ui(HostPaths { data: root.join("data"), downloads: None }, runtime.handle().clone())
    }
    fn call(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let command: Command = serde_json::from_value(json!({"cmd":cmd,"args":args})).map_err(|e|e.to_string())?;
        self.runtime.block_on(self.host.call(command))
    }
    fn cwd(&self) -> String { self.root.join("project").canonicalize().unwrap().to_string_lossy().into_owned() }
    fn work(&self, id: &str) {
        self.call("room_create", json!({"id":id,"cwd":self.cwd(),"participants":[],"options":{"policy":"mention","max_bot_hops":0}})).unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

#[test]
fn deleted_thread_cannot_return_from_a_stale_pane_or_session_after_restart() {
    let mut f = Fixture::new("delete");
    f.work("deleted"); f.work("sibling");
    let stale = json!({"version":1,"panes":[{"id":"deleted","kind":"chat"},{"id":"sibling","kind":"chat"}],"future":{"kept":true}});
    f.call("session_save",json!({"session":stale})).unwrap();
    f.call("room_delete",json!({"id":"deleted"})).unwrap();
    assert!(f.call("room_create",json!({"id":"deleted","cwd":f.cwd(),"participants":[],"options":{"policy":"mention","max_bot_hops":0}})).is_err(), "late desktop mount must not recreate the deleted id");
    f.call("session_save",json!({"session":stale})).unwrap();
    f.host = Fixture::open(&f.root, &f.runtime);
    let session = f.call("session_load",json!({})).unwrap();
    assert_eq!(session["panes"],json!([{"id":"sibling","kind":"chat"}]));
    assert_eq!(session["future"]["kept"],true);
    let list = f.call("chat_list",json!({})).unwrap();
    assert!(list["deletedThreads"].as_array().unwrap().contains(&json!("deleted")));
    assert_eq!(list["rooms"].as_array().unwrap().len(),1);
    assert!(std::path::Path::new(&f.cwd()).is_dir());
}

#[test]
fn project_rename_remove_and_explicit_readd_are_shared_and_durable() {
    let mut f = Fixture::new("project"); f.work("work");
    let cwd = f.cwd();
    let stale = json!({"version":1,"workspaces":[{"id":"w","name":"Original","path":cwd}],"panes":[],"future":42});
    f.call("session_save",json!({"session":stale})).unwrap();
    let project = f.call("project_add",json!({"path":cwd})).unwrap();
    assert_eq!(project["name"],"Original");
    f.call("project_rename",json!({"path":cwd,"name":"Renamed"})).unwrap();
    f.call("session_save",json!({"session":stale})).unwrap();
    assert_eq!(f.call("session_load",json!({})).unwrap()["workspaces"][0]["name"],"Renamed");
    f.call("project_remove",json!({"path":cwd})).unwrap();
    f.call("session_save",json!({"session":stale})).unwrap();
    f.host = Fixture::open(&f.root, &f.runtime);
    assert_eq!(f.call("project_list",json!({})).unwrap()["projects"][0]["removed"],true);
    let session = f.call("session_load",json!({})).unwrap();
    assert_eq!(session["workspaces"][0]["hidden"],true);
    assert_eq!(session["future"],42);
    assert_eq!(f.call("chat_list",json!({})).unwrap()["rooms"].as_array().unwrap().len(),1,"project removal preserves history");
    let restored = f.call("project_add",json!({"path":cwd})).unwrap();
    assert_eq!(restored["name"],"Renamed");
    assert_eq!(restored["removed"],false);
    assert!(std::path::Path::new(&cwd).is_dir());
}

#[test]
fn explicit_transfer_can_return_after_source_or_failed_destination_cleanup() {
    let f = Fixture::new("transfer"); f.work("moved");
    let snapshot = f.call("room_state",json!({"id":"moved"})).unwrap()["snapshot"].clone();
    f.call("room_delete",json!({"id":"moved"})).unwrap();
    f.call("room_import",json!({"id":"moved","snapshot":snapshot,"cwd":f.cwd()})).expect("explicit import may move back; stale room_create still may not");
    assert!(f.call("chat_list",json!({})).unwrap()["deletedThreads"].as_array().unwrap().is_empty());
    f.call("room_delete",json!({"id":"moved"})).unwrap();
    f.call("room_import",json!({"id":"moved","snapshot":snapshot,"cwd":f.cwd()})).expect("retry after transfer cleanup");
}

#[cfg(unix)]
#[test]
fn legacy_project_aliases_rename_and_remove_one_canonical_project() {
    let f = Fixture::new("alias");
    let alias = f.root.join("alias");
    std::os::unix::fs::symlink(f.cwd(),&alias).unwrap();
    f.call("session_save",json!({"session":{"version":1,"workspaces":[{"id":"w","name":"Legacy","path":alias}]}})).unwrap();
    f.call("project_rename",json!({"path":alias,"name":"Renamed"})).expect("rename a legacy alias without explicit add first");
    f.call("project_remove",json!({"path":f.cwd()})).unwrap();
    let projects = f.call("project_list",json!({})).unwrap();
    assert_eq!(projects["projects"].as_array().unwrap().len(),1);
    assert_eq!(projects["projects"][0]["removed"],true);
    assert_eq!(f.call("session_load",json!({})).unwrap()["workspaces"][0]["path"],f.cwd());
}
