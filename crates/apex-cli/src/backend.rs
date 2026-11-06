//! Start or reuse the shared backend; either interface can run independently.
use crate::{args::Args, client::Client};
use serde_json::Value;
use std::{path::{Path, PathBuf}, process::Stdio, time::Duration};

pub fn sibling_daemon() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e|e.to_string())?.canonicalize().map_err(|e|e.to_string())?;
    let parent = exe.parent().ok_or("CLI executable has no parent")?;
    let path = parent.join(if cfg!(windows) { "apex-daemon.exe" } else { "apex-daemon" });
    let meta = std::fs::symlink_metadata(&path).map_err(|e|format!("Missing packaged backend {}: {e}. Install the complete Apex CLI package.",path.display()))?;
    if !meta.is_file() || meta.file_type().is_symlink() { return Err("Packaged backend must be a regular sibling executable".into()); }
    Ok(path)
}

pub async fn probe(data: &Path) -> Result<Value, String> {
    let (_, _, hello) = tokio::time::timeout(Duration::from_secs(2), Client::connect(data,None)).await.map_err(|_|"Backend did not answer within two seconds")??;
    Ok(hello)
}

pub async fn ensure(args: &Args) -> Result<Value, String> {
    apex_daemon::ipc::endpoint(&args.data).map_err(|e|e.to_string())?;
    if !args.connect_deck && ["CODEX_HOME","CLAUDE_CONFIG_DIR"].iter().any(|name|std::env::var_os(name).is_some()) {
        return Err("Standalone Apex uses the official default provider credential homes. Remove CODEX_HOME/CLAUDE_CONFIG_DIR before launching.".into());
    }
    if let Ok(hello) = probe(&args.data).await { return Ok(hello); }
    if args.connect_deck { return Err("No compatible Deck backend is running. --connect-deck never starts one.".into()); }
    let daemon = sibling_daemon()?;
    let version = tokio::process::Command::new(&daemon).arg("--version").output().await.map_err(|e|format!("Cannot execute packaged backend: {e}"))?;
    if !version.status.success() || !String::from_utf8_lossy(&version.stdout).contains(env!("CARGO_PKG_VERSION")) {
        return Err("Packaged backend version does not match Apex CLI; reinstall the complete package.".into());
    }
    std::fs::create_dir_all(&args.data).map_err(|e|e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&args.data,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?; }
    // Each racer starts the same verified executable. The daemon's kernel lock
    // elects the owner; no client ever unlinks a socket or steals a live lock.
    let log_path=args.data.join("backend-startup.log");
    let mut log_options=std::fs::OpenOptions::new();log_options.create(true).append(true);
    #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;log_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);}
    let log=log_options.open(&log_path).map_err(|e|format!("Cannot open private backend log: {e}"))?;
    let mut command = tokio::process::Command::new(daemon);
    command.args(["serve","--local-only","--data-dir"]).arg(&args.data)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
    for (name,_) in std::env::vars_os() {
        let s=name.to_string_lossy();
        if s.starts_with("APEX_") || s.starts_with("DYLD_") || s.starts_with("ELECTRON_") || matches!(s.as_ref(),"NODE_OPTIONS"|"LD_PRELOAD"|"LD_LIBRARY_PATH"|"OPENAI_API_KEY"|"CODEX_API_KEY"|"OPENAI_BASE_URL"|"ANTHROPIC_API_KEY"|"ANTHROPIC_BASE_URL"|"ANTHROPIC_AUTH_TOKEN"|"CLAUDE_CODE_OAUTH_TOKEN"|"CLAUDE_CODE_USE_BEDROCK"|"CLAUDE_CODE_USE_VERTEX"|"CLAUDE_CODE_USE_FOUNDRY"|"CODEX_HOME"|"CLAUDE_CONFIG_DIR") { command.env_remove(name); }
    }
    #[cfg(unix)] { unsafe { command.pre_exec(|| { if libc::setsid()<0 {return Err(std::io::Error::last_os_error());} Ok(()) }); } }
    let mut child = command.spawn().map_err(|e|format!("Cannot start packaged backend: {e}"))?;
    let mut child_exit = None;
    for _ in 0..100 {
        if let Ok(hello)=probe(&args.data).await { tokio::spawn(async move {let _=child.wait().await;}); return Ok(hello); }
        child_exit=child.try_wait().map_err(|e|e.to_string())?.or(child_exit);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let diagnostic=std::fs::read_to_string(log_path).unwrap_or_default();
    let tail=diagnostic.chars().rev().take(3000).collect::<String>().chars().rev().collect::<String>();
    Err(format!("Backend failed to become ready at {} (child status: {child_exit:?}). A locked or unresponsive owner was preserved; no socket was removed.\n{tail}",args.data.display()))
}

pub async fn lifecycle(args: &Args, stop: bool) -> Result<(),String> {
    let hello=probe(&args.data).await.map_err(|e|format!("Backend is not available at {}: {e}",args.data.display()))?;
    if !stop { println!("Backend running · boot {} · {}",hello["boot_id"],args.data.display()); return Ok(()); }
    if args.connect_deck { return Err("Refusing to stop a Deck-owned backend.".into()); }
    use std::io::{IsTerminal,Write};
    if !std::io::stdin().is_terminal(){return Err("Stopping requires an interactive confirmation; no work was stopped.".into());}
    print!("Stop the shared backend and all active work in connected terminals and desktop windows? Type stop: ");std::io::stdout().flush().map_err(|e|e.to_string())?;
    let mut answer=String::new();std::io::stdin().read_line(&mut answer).map_err(|e|e.to_string())?;
    if answer.trim()!="stop" {println!("Canceled.");return Ok(());}
    let authorized=crate::authority::authorize(serde_json::json!({"cmd":"backend_stop","args":{"bootId":hello["boot_id"]}}),&args.data).await?;
    use futures::{SinkExt,StreamExt};
    let endpoint=apex_daemon::ipc::endpoint(&args.data).map_err(|e|e.to_string())?.with_file_name("ctl.sock");
    let stream=apex_daemon::ipc::connect(&endpoint).await.map_err(|e|format!("Standalone backend control unavailable: {e}"))?;
    let(r,w)=apex_daemon::ipc::split(stream);let(mut input,mut output)=apex_daemon::protocol::lines(r,w);
    output.send(serde_json::json!({"op":"stop","receipt":authorized["args"]["receipt"]}).to_string()).await.map_err(|e|e.to_string())?;
    let line=tokio::time::timeout(Duration::from_secs(3),input.next()).await.map_err(|_|"Backend stop outcome unknown; check status before retrying")?.ok_or("Backend closed without confirmation")?.map_err(|e|e.to_string())?;
    if serde_json::from_str::<Value>(&line).map_err(|e|e.to_string())?["ok"]!=true{return Err("Backend refused stop".into());}
    println!("Backend is stopping.");Ok(())
}
