//! The desktop shell: commands the UI calls, and events it listens for. The
//! work is done by `apex_host::Host`; each command here passes its arguments
//! on, and every host event goes to the window under its own name.
//!
//! Events sent to the UI:
//! - `pty-data`   `{ id, data }`   terminal output
//! - `pty-exit`   `{ id, code }`   the program in a terminal ended
//! - `room-event` `{ room, event }` something happened in a group chat
//! - `quit-requested` `request` the window or app was asked to close; answer with `quit_heard`

mod menu;

use std::collections::HashMap;
use std::sync::Arc;

use apex_core::{AgentTool, ModelChoice, ParticipantConfig, ParticipantId, RoomOptions, RoomSnapshot};
use apex_host::{agents, changes, checkpoints, mods, preview, Host, HostPaths};
use tauri::{AppHandle, Emitter, Manager, State};

type HostState<'a> = State<'a, Arc<Host>>;

// ---------------------------------------------------------------- startup

#[tauri::command]
fn startup_folders(host: HostState<'_>) -> Vec<String> {
    host.startup_folders()
}

#[tauri::command]
async fn list_tool_servers(host: HostState<'_>, room: String, agent: String) -> Result<Vec<apex_core::server_request::ToolServer>, String> {
    host.list_tool_servers(room, agent).await
}

// ---------------------------------------------------------------- terminals

#[tauri::command]
fn agents_detect(host: HostState<'_>) -> Vec<agents::AgentInfo> {
    host.agents_detect()
}

/// Open a terminal for pane `id`. `agent` is a key from `agents_detect`, or
/// nothing for a plain shell.
#[tauri::command]
fn pty_spawn(host: HostState<'_>, id: String, agent: Option<String>, cwd: Option<String>, cols: u16, rows: u16) -> Result<(), String> {
    host.pty_spawn(id, agent, cwd, cols, rows)
}

#[tauri::command]
fn pty_write(host: HostState<'_>, id: String, data: String) -> Result<(), String> {
    host.pty_write(id, data)
}

#[tauri::command]
fn pty_resize(host: HostState<'_>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    host.pty_resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(host: HostState<'_>, id: String) {
    host.pty_kill(id)
}

// ---------------------------------------------------------------- group chats

#[tauri::command]
fn room_create(host: HostState<'_>, id: String, participants: Vec<ParticipantConfig>, options: RoomOptions, cwd: Option<String>) -> Result<RoomSnapshot, String> {
    host.room_create(id, participants, options, cwd)
}

#[tauri::command]
async fn room_post(host: HostState<'_>, id: String, text: String) -> Result<(), String> {
    host.room_post(id, text).await
}

#[tauri::command]
async fn room_targets(host: HostState<'_>, id: String, text: String) -> Result<Vec<ParticipantId>, String> {
    host.room_targets(id, text).await
}

#[tauri::command]
async fn room_post_to(host: HostState<'_>, id: String, text: String, targets: Vec<ParticipantId>) -> Result<(), String> {
    host.room_post_to(id, text, targets).await
}

#[tauri::command]
async fn room_turn(host: HostState<'_>, id: String, participants: Vec<ParticipantId>, hops: Option<usize>) -> Result<(), String> {
    host.room_turn(id, participants, hops).await
}

#[tauri::command]
fn room_stop(host: HostState<'_>, id: String, participant: Option<ParticipantId>) {
    host.room_stop(id, participant)
}

#[tauri::command]
fn room_decide(host: HostState<'_>, id: String, request: String, approve: bool, always: Option<bool>) -> Result<(), String> {
    host.room_decide(id, request, approve, always)
}

#[tauri::command]
fn room_forget_allowed(host: HostState<'_>, id: String, rule: apex_core::AllowedRule) -> Result<(), String> {
    host.room_forget_allowed(id, rule)
}

#[tauri::command]
async fn room_set_options(host: HostState<'_>, id: String, options: RoomOptions) -> Result<(), String> {
    host.room_set_options(id, options).await
}

#[tauri::command]
async fn room_add_participant(host: HostState<'_>, id: String, participant: ParticipantConfig) -> Result<(), String> {
    host.room_add_participant(id, participant).await
}

#[tauri::command]
async fn room_update_participant(host: HostState<'_>, id: String, participant: ParticipantConfig) -> Result<(), String> {
    host.room_update_participant(id, participant).await
}

#[tauri::command]
async fn room_remove_participant(host: HostState<'_>, id: String, participant: ParticipantId) -> Result<(), String> {
    host.room_remove_participant(id, participant).await
}

#[tauri::command]
async fn room_clear(host: HostState<'_>, id: String) -> Result<(), String> {
    host.room_clear(id).await
}

#[tauri::command]
async fn room_rewind(host: HostState<'_>, id: String, upto: usize) -> Result<(), String> {
    host.room_rewind(id, upto).await
}

#[tauri::command]
async fn room_revert_plan(host: HostState<'_>, id: String, at: usize, bot: Option<ParticipantId>) -> Result<checkpoints::RevertPlan, String> {
    host.room_revert_plan(id, at, bot).await
}

#[tauri::command]
async fn room_revert(host: HostState<'_>, id: String, at: usize, bot: Option<ParticipantId>, chat: bool, files: Vec<String>) -> Result<Vec<String>, String> {
    host.room_revert(id, at, bot, chat, files).await
}

#[tauri::command]
async fn room_pin(host: HostState<'_>, id: String, fact: String) -> Result<Vec<String>, String> {
    host.room_pin(id, fact).await
}

#[tauri::command]
async fn room_unpin(host: HostState<'_>, id: String, index: usize) -> Result<Vec<String>, String> {
    host.room_unpin(id, index).await
}

#[tauri::command]
async fn room_compact(host: HostState<'_>, id: String) -> Result<(), String> {
    host.room_compact(id).await
}

#[tauri::command]
fn room_close(host: HostState<'_>, id: String) {
    host.room_close(id)
}

#[tauri::command]
fn room_delete(host: HostState<'_>, id: String) -> Result<(), String> {
    host.room_delete(id)
}

#[tauri::command]
async fn room_diff(host: HostState<'_>, id: String) -> Result<changes::ThreadDiff, String> {
    host.room_diff(id).await
}

#[tauri::command]
fn room_fork(host: HostState<'_>, source: String, target: String, upto: Option<usize>) -> Result<(), String> {
    host.room_fork(source, target, upto)
}

#[tauri::command]
async fn api_models(host: HostState<'_>, base_url: String, api_key_env: Option<String>) -> Result<Vec<String>, String> {
    host.api_models(base_url, api_key_env).await
}

#[tauri::command]
fn agent_models(host: HostState<'_>, tool: AgentTool) -> Vec<ModelChoice> {
    host.agent_models(tool)
}

// ---------------------------------------------------------------- files

#[tauri::command]
fn open_target(host: HostState<'_>, target: String, cwd: Option<String>, reveal: Option<bool>) -> Result<(), String> {
    host.open_target(target, cwd, reveal)
}

#[tauri::command]
fn workspace_read(host: HostState<'_>, target: String, cwd: Option<String>) -> Option<String> {
    host.workspace_read(target, cwd)
}

#[tauri::command]
fn paths_exist(host: HostState<'_>, targets: Vec<String>, cwd: Option<String>) -> Vec<bool> {
    host.paths_exist(targets, cwd)
}

#[tauri::command]
fn session_load(host: HostState<'_>) -> Result<Option<serde_json::Value>, String> {
    host.session_load()
}

#[tauri::command]
fn session_save(host: HostState<'_>, session: serde_json::Value) -> Result<(), String> {
    host.session_save(session)
}

#[tauri::command]
fn settings_load(host: HostState<'_>) -> Result<Option<serde_json::Value>, String> {
    host.settings_load()
}

#[tauri::command]
fn settings_save(host: HostState<'_>, settings: serde_json::Value) -> Result<(), String> {
    host.settings_save(settings)
}

#[tauri::command]
fn artifacts_load(host: HostState<'_>, room: String) -> Result<Option<serde_json::Value>, String> {
    host.artifacts_load(room)
}

#[tauri::command]
fn artifacts_save(host: HostState<'_>, room: String, artifacts: serde_json::Value) -> Result<(), String> {
    host.artifacts_save(room, artifacts)
}

#[tauri::command]
fn artifact_export(host: HostState<'_>, name: String, contents: String, path: Option<String>) -> Result<String, String> {
    host.artifact_export(name, contents, path)
}

#[tauri::command]
fn data_folder(host: HostState<'_>) -> String {
    host.data_folder()
}

#[tauri::command]
fn env_present(host: HostState<'_>, names: Vec<String>) -> Vec<bool> {
    host.env_present(names)
}

#[tauri::command]
async fn preview_probe(host: HostState<'_>, address: String) -> Result<preview::Probe, String> {
    host.preview_probe(address).await
}

#[tauri::command]
fn export_thread(host: HostState<'_>, file_name: String, contents: String) -> Result<String, String> {
    host.export_thread(file_name, contents)
}

/// Save a pasted or picked file. The body is the raw bytes; the thread and
/// file name come in the `x-room` and `x-name` headers. Returns the saved path.
#[tauri::command]
fn save_attachment(host: HostState<'_>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes".into());
    };
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).ok_or(format!("missing {key}"));
    host.save_attachment(header("x-room")?, header("x-name")?, bytes)
}

#[tauri::command]
fn copy_attachment(host: HostState<'_>, room: String, path: String) -> Result<String, String> {
    host.copy_attachment(room, path)
}

#[tauri::command]
async fn generate_image(host: HostState<'_>, room: String, provider: String, prompt: String) -> Result<String, String> {
    host.generate_image(room, provider, prompt).await
}

#[tauri::command]
fn import_reply_image(host: HostState<'_>, room: String, path: String) -> Result<String, String> {
    host.import_reply_image(room, path)
}

#[tauri::command]
fn read_attachment(host: HostState<'_>, path: String) -> Result<tauri::ipc::Response, String> {
    host.read_attachment(path).map(tauri::ipc::Response::new)
}

// ---------------------------------------------------------------- mods

#[tauri::command]
fn mod_read(host: HostState<'_>, dir: String) -> Result<mods::ModSource, String> {
    host.mod_read(dir)
}

#[tauri::command]
async fn mod_install(host: HostState<'_>, source: String) -> Result<String, String> {
    host.mod_install(source).await
}

#[tauri::command]
async fn mod_process_run(host: HostState<'_>, argv: Vec<String>, cwd: Option<String>, stdin: Option<String>, timeout_ms: Option<u64>) -> Result<mods::RunResult, String> {
    host.mod_process_run(argv, cwd, stdin, timeout_ms).await
}

#[tauri::command]
async fn mod_http_fetch(host: HostState<'_>, url: String, method: Option<String>, headers: Option<HashMap<String, String>>, body: Option<String>) -> Result<mods::FetchResult, String> {
    host.mod_http_fetch(url, method, headers, body).await
}

#[tauri::command]
fn mod_fs_write(host: HostState<'_>, path: String, text: String) -> Result<(), String> {
    host.mod_fs_write(path, text)
}

#[tauri::command]
fn mod_fs_stat(host: HostState<'_>, path: String, resolve: Option<bool>) -> Result<mods::StatResult, String> {
    host.mod_fs_stat(path, resolve)
}

#[tauri::command]
fn mod_env_get(host: HostState<'_>, name: String) -> Option<String> {
    host.mod_env_get(name)
}

// ---------------------------------------------------------------- quitting

/// Ask the window about a close or quit, and let it through if the window
/// hasn't said it got the request within `ANSWER_TIME`. Returns false when
/// nothing holds it, so the caller lets it go now.
fn ask_to_quit(app: &AppHandle, code: Option<i32>) -> bool {
    let host = Arc::clone(&app.state::<Arc<Host>>());
    let Some(request) = host.quit_request(code) else { return false };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(apex_host::quit::ANSWER_TIME);
        if host.quit_unanswered(request) {
            host.quit_confirm();
            app.exit(0);
        }
    });
    true
}

/// The window got quit request `request` and is asking the person.
#[tauri::command]
fn quit_heard(host: HostState<'_>, request: u64) {
    host.quit_heard(request)
}

/// Quit now: the person chose to, or nothing was running. Every terminal
/// ends on the way out (`RunEvent::Exit`).
#[tauri::command]
fn quit_app(app: AppHandle, host: HostState<'_>) {
    host.quit_confirm();
    app.exit(0);
}

// ---------------------------------------------------------------- app

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = HostPaths { data: app.path().app_data_dir()?, downloads: app.path().download_dir().ok() };
            let host = Host::new(paths, tauri::async_runtime::handle().inner().clone());
            let window = app.handle().clone();
            host.events().listen(move |envelope| {
                let _ = window.emit(envelope.event.name(), envelope.event.payload());
            });
            app.manage(host);
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == menu::QUIT_MENU_ID && !ask_to_quit(app, None) {
                app.exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            session_load,
            session_save,
            settings_load,
            settings_save,
            artifacts_load,
            artifacts_save,
            artifact_export,
            preview_probe,
            data_folder,
            env_present,
            room_delete,
            startup_folders,
            agents_detect,
            list_tool_servers,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            room_diff,
            room_fork,
            export_thread,
            save_attachment,
            copy_attachment,
            generate_image,
            read_attachment,
            import_reply_image,
            room_create,
            room_post,
            room_targets,
            room_post_to,
            room_turn,
            room_stop,
            room_decide,
            room_forget_allowed,
            room_set_options,
            room_add_participant,
            room_update_participant,
            room_remove_participant,
            room_clear,
            room_rewind,
            room_revert_plan,
            room_revert,
            room_pin,
            room_unpin,
            room_compact,
            room_close,
            api_models,
            agent_models,
            open_target,
            workspace_read,
            paths_exist,
            quit_heard,
            quit_app,
            mod_read,
            mod_install,
            mod_process_run,
            mod_http_fetch,
            mod_fs_write,
            mod_fs_stat,
            mod_env_get,
        ]);
    // The system Quit item ends the app without asking; Deck's own asks first.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|handle| menu::app_menu(handle));
    builder
        .build(tauri::generate_context!())
        .expect("error while building Apex Deck")
        .run(|app, event| match event {
            // The close button and ⌘W.
            tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { api, .. }, .. } => {
                if ask_to_quit(app, None) {
                    api.prevent_close();
                }
            }
            // The last window going away (no code), or an exit with a code, which is never held.
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if ask_to_quit(app, code) {
                    api.prevent_exit();
                }
            }
            // Do not leave agents running after the window is gone.
            tauri::RunEvent::Exit => app.state::<Arc<Host>>().shutdown(),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    /// The daemon takes `apex_host::Command`s, so every desktop command must
    /// have one with the same name, and the other way round.
    #[test]
    fn every_desktop_command_has_a_host_command_of_the_same_name() {
        let source = include_str!("lib.rs");
        let start = source.find("generate_handler![").unwrap() + "generate_handler![".len();
        let list = &source[start..start + source[start..].find(']').unwrap()];
        let mut desktop: Vec<String> = list.split(',').map(|name| name.trim().to_string()).filter(|name| !name.is_empty()).collect();
        let mut host = apex_host::command::names();
        desktop.sort();
        host.sort();
        assert_eq!(desktop, host);
    }
}
