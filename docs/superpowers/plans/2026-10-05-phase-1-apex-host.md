# Phase 1: extract apex-host

Goal: move the logic behind the 54 Tauri commands in `src-tauri/src/lib.rs`
into a UI-free `crates/apex-host`, so `apex-daemon` (phase 2) and Electron
(phase 3) can reuse it. No behaviour change; every existing test stays green.

## Steps
1. **Create the crate.** `crates/apex-host`, add to the workspace. Move
   `storage`, `pty`, `agents`, `checkpoints`, `changes`, `export`, `images`,
   `reply_images`, `mods`, `preview` from `src-tauri/src/` as modules. Fix
   imports. `cargo test --workspace` passes.
2. **Event sink instead of `AppHandle`.** Define `enum HostEvent { Room{room,
   event}, PtyData{id,data}, PtyExit{id,code}, QuitRequested(..) }` and a
   `tokio::sync::broadcast` bus with a monotonically increasing `seq`. Replace
   each `app.emit(...)` (about 10 sites) with `host.emit(...)`. Tauri spawns
   one task that forwards bus events to the existing event names, so the
   frontend is untouched.
3. **`Host` struct.** Move `AppState`, `RoomHandle`, `Store`, snapshots and
   `QuitGate` state into `Host`. Each Tauri command becomes a one-line call
   to a `Host` method. Tests in `lib.rs` move with the logic.
4. **Command enum.** Add `#[serde(tag = "cmd", content = "args")] enum
   Command` covering every command, and `Host::call(Command) ->
   Result<serde_json::Value, String>`. Add a test that every Tauri command
   name has a matching variant, so the daemon can't drift from the desktop.
5. **Session and settings owned by Rust.** Add typed `Session` and
   `Settings` structs in `apex-host` matching what `src/` writes today, with
   load-time migration of the existing JSON files. Keep `session_save` /
   `settings_save` working as whole-document writes for now, but have them
   emit `session-changed` / `settings-changed`. Finer-grained commands come
   when a second client needs them.
6. **Verify.** `cargo test --workspace`, `npm test`, launch the app and run
   one chat, one terminal, an approval and a restart restore.

## Out of scope
Daemon binary, network listeners, Electron, pairing.
