//! Isolated task startup and resource limits.

use crate::assistant_git::{self, GitSnapshot};
use apex_adapters::OwnedProcessRegistry;
use apex_core::{AgentTool, Backend, ParticipantConfig};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command as TokioCommand,
    sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
    time::timeout,
};

const GLOBAL_LIMIT: usize = 4;
const PROJECT_LIMIT: usize = 2;
const SETUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HELP_TIMEOUT: Duration = Duration::from_secs(15);
const CAPTURE_LIMIT: usize = 256 * 1024;

pub(crate) fn operation_process_dir(data_dir: &Path, task_id: &str) -> Result<PathBuf, String> {
    if task_id.is_empty()
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Task ID is invalid for an owned process registry.".into());
    }
    Ok(data_dir.join("operation-processes").join(task_id))
}

#[derive(Clone)]
pub struct IsolatedSlots {
    host: Arc<Semaphore>,
    projects: Arc<Mutex<std::collections::HashMap<PathBuf, Weak<Semaphore>>>>,
}

impl Default for IsolatedSlots {
    fn default() -> Self {
        Self::new()
    }
}

impl IsolatedSlots {
    pub fn new() -> Self {
        Self {
            host: Arc::new(Semaphore::new(GLOBAL_LIMIT)),
            projects: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    async fn project_slot(&self, project: &Path) -> Result<Arc<Semaphore>, String> {
        let root = std::fs::canonicalize(project)
            .map_err(|e| format!("Could not resolve project folder: {e}"))?;
        let mut projects = self.projects.lock().await;
        projects.retain(|_, semaphore| semaphore.strong_count() > 0);
        if let Some(semaphore) = projects.get(&root).and_then(Weak::upgrade) {
            return Ok(semaphore);
        }
        let semaphore = Arc::new(Semaphore::new(PROJECT_LIMIT));
        projects.insert(root, Arc::downgrade(&semaphore));
        Ok(semaphore)
    }

    /// Acquire a per-project permit before a host permit so queued projects do
    /// not consume global capacity. Stop drops a partial acquisition promptly.
    pub async fn acquire(
        &self,
        project: PathBuf,
        stop: &mut watch::Receiver<bool>,
    ) -> Result<IsolatedPermit, String> {
        let project_sem = self.project_slot(&project).await?;
        let project_permit = acquire_or_cancel(project_sem, stop).await?;
        let host_permit = acquire_or_cancel(self.host.clone(), stop).await?;
        if *stop.borrow() {
            return Err("Task startup was cancelled while waiting for an isolation slot.".into());
        }
        Ok(IsolatedPermit {
            _project: project_permit,
            _host: host_permit,
        })
    }
}

pub struct IsolatedPermit {
    _project: OwnedSemaphorePermit,
    _host: OwnedSemaphorePermit,
}

async fn acquire_or_cancel(
    sem: Arc<Semaphore>,
    stop: &mut watch::Receiver<bool>,
) -> Result<OwnedSemaphorePermit, String> {
    loop {
        if *stop.borrow() {
            return Err("Task startup was cancelled while waiting for an isolation slot.".into());
        }
        tokio::select! {
            permit = sem.clone().acquire_owned() => return permit.map_err(|_| "Isolation slot manager was closed.".to_string()),
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Err("Task startup was cancelled while waiting for an isolation slot.".into());
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkerReadiness {
    Ready { profile_id: String, detail: String },
    NeedsYou { profile_id: String, detail: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupNeedsYou {
    pub message: String,
    pub workers: Vec<WorkerReadiness>,
}

impl StartupNeedsYou {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            workers: Vec::new(),
        }
    }
    fn from_workers(workers: Vec<WorkerReadiness>) -> Self {
        let blocked = workers
            .iter()
            .filter_map(|worker| match worker {
                WorkerReadiness::NeedsYou { profile_id, detail } => {
                    Some(format!("{profile_id}: {detail}"))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        Self {
            message: format!("Task startup needs you. {}", blocked.join("; ")),
            workers,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DependencySetup {
    None,
    NpmCi,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupMetadata {
    pub dependency_setup: DependencySetup,
    pub npm_installed: bool,
    pub cargo_target_dir: PathBuf,
    pub node_modules_shared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedWorkspace {
    pub path: PathBuf,
    pub setup: SetupMetadata,
    pub workers: Vec<WorkerReadiness>,
}

fn classify_backend(profile_id: &str, backend: &Backend) -> WorkerReadiness {
    let detail = match backend {
        Backend::Agent { tool: AgentTool::Codex, .. } => "The current Codex adapter cannot establish isolated folder trust while preserving approval settings. Use an in-place task or a supported isolated worker.".to_string(),
        Backend::Agent { tool, .. } => format!("The {} adapter has no verified per-folder trust startup path. Use an in-place task or a supported isolated worker.", agent_name(*tool)),
        Backend::OpenAiCompatible { .. } => "This API profile has no verified local workspace editing adapter.".into(),
        Backend::Cli { .. } => "Custom commands do not have a verified workspace trust or permission adapter.".into(),
        Backend::Scripted { .. } => return WorkerReadiness::Ready { profile_id: profile_id.into(), detail: "Scripted worker requires no workspace trust prompt.".into() },
    };
    WorkerReadiness::NeedsYou {
        profile_id: profile_id.into(),
        detail,
    }
}

fn agent_name(tool: AgentTool) -> &'static str {
    match tool {
        AgentTool::ClaudeCode => "Claude Code",
        AgentTool::Codex => "Codex",
        AgentTool::Gemini => "Gemini",
        AgentTool::Grok => "Grok",
    }
}

fn claude_noninteractive_trust_supported(help: &str) -> bool {
    let normalized = help.to_ascii_lowercase();
    normalized.contains("workspace trust dialog") && normalized.contains("stdout is not a tty")
}

fn classify_claude_help(profile_id: &str, help: &str) -> WorkerReadiness {
    if claude_noninteractive_trust_supported(help) {
        WorkerReadiness::Ready { profile_id: profile_id.into(), detail: "Installed Claude Code help confirms piped, non-interactive sessions skip the workspace trust dialog; the adapter uses piped stdout.".into() }
    } else {
        WorkerReadiness::NeedsYou { profile_id: profile_id.into(), detail: "Installed Claude Code help does not confirm that its non-interactive mode skips workspace trust. Update/verify Claude Code or open it once in this task folder, approve trust, then retry.".into() }
    }
}

async fn verify_claude(
    stop: &mut watch::Receiver<bool>,
    registry: &OwnedProcessRegistry,
) -> WorkerReadiness {
    match run_owned("claude", &["--help"], Path::new("."), HELP_TIMEOUT, stop, registry).await {
        Ok(output) if output.status.success() => {
            let help = String::from_utf8_lossy(&output.stdout);
            classify_claude_help("", &help)
        }
        Ok(_) => WorkerReadiness::NeedsYou { profile_id: String::new(), detail: "Could not verify Claude Code startup behavior. Check the installed CLI, then retry.".into() },
        Err(message) => WorkerReadiness::NeedsYou { profile_id: String::new(), detail: message },
    }
}

pub async fn verify_workers(
    profiles: &[ParticipantConfig],
    stop: &mut watch::Receiver<bool>,
) -> Result<Vec<WorkerReadiness>, StartupNeedsYou> {
    verify_workers_with_registry(profiles, stop, &OwnedProcessRegistry::default()).await
}

pub(crate) async fn verify_workers_with_registry(
    profiles: &[ParticipantConfig],
    stop: &mut watch::Receiver<bool>,
    registry: &OwnedProcessRegistry,
) -> Result<Vec<WorkerReadiness>, StartupNeedsYou> {
    let mut workers = Vec::new();
    for profile in profiles {
        let mut readiness = match &profile.backend {
            Backend::Agent {
                tool: AgentTool::ClaudeCode,
                ..
            } => verify_claude(stop, registry).await,
            backend => classify_backend(&profile.id.0, backend),
        };
        match &mut readiness {
            WorkerReadiness::Ready { profile_id, .. }
            | WorkerReadiness::NeedsYou { profile_id, .. }
                if profile_id.is_empty() =>
            {
                *profile_id = profile.id.0.clone()
            }
            _ => {}
        }
        workers.push(readiness);
    }
    if profiles.is_empty() {
        return Err(StartupNeedsYou::new(
            "Choose at least one worker before starting isolated execution.",
        ));
    }
    if workers
        .iter()
        .any(|w| matches!(w, WorkerReadiness::NeedsYou { .. }))
    {
        return Err(StartupNeedsYou::from_workers(workers));
    }
    Ok(workers)
}

fn dependency_setup(root: &Path) -> Result<DependencySetup, String> {
    let package = root.join("package.json");
    let lock = [
        root.join("package-lock.json"),
        root.join("npm-shrinkwrap.json"),
    ];
    let package_exists = std::fs::symlink_metadata(&package).is_ok();
    let package_is_file = std::fs::symlink_metadata(&package)
        .map(|m| m.is_file())
        .unwrap_or(false);
    let lock_exists = lock
        .iter()
        .any(|path| std::fs::symlink_metadata(path).is_ok());
    let lock_is_file = lock.iter().any(|path| {
        std::fs::symlink_metadata(path)
            .map(|m| m.is_file())
            .unwrap_or(false)
    });
    if lock_exists {
        if !package_is_file || !lock_is_file {
            return Err("The project has an npm lockfile that is missing or linked. Repair the package manifest/lockfile before isolated setup.".into());
        }
        return Ok(DependencySetup::NpmCi);
    }
    for (file, manager) in [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "Yarn")] {
        if root.join(file).exists() {
            return Err(format!("This project uses {manager}; its dependency setup needs an explicit human-selected command before isolated execution."));
        }
    }
    if package_exists && !package_is_file {
        return Err("The project's package.json is linked or not a regular file; repair it before isolated setup.".into());
    }
    Ok(DependencySetup::None)
}

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut input: R) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = input.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        let remaining = CAPTURE_LIMIT.saturating_sub(output.len());
        output.extend_from_slice(&chunk[..n.min(remaining)]);
    }
    Ok(output)
}

async fn join_reader(reader: &mut JoinHandle<std::io::Result<Vec<u8>>>) -> Result<Vec<u8>, String> {
    reader
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

async fn join_readers(
    stdout: &mut JoinHandle<std::io::Result<Vec<u8>>>,
    stderr: &mut JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (stdout, stderr) = tokio::join!(join_reader(stdout), join_reader(stderr));
    Ok((stdout?, stderr?))
}

async fn drain_readers(
    stdout: &mut JoinHandle<std::io::Result<Vec<u8>>>,
    stderr: &mut JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    match timeout(Duration::from_secs(2), join_readers(stdout, stderr)).await {
        Ok(result) => result,
        Err(_) => {
            stdout.abort();
            stderr.abort();
            let _ = stdout.await;
            let _ = stderr.await;
            Err("Process output pipes did not close after process-tree termination.".into())
        }
    }
}

async fn run_owned(
    program: &str,
    args: &[&str],
    cwd: &Path,
    limit: Duration,
    stop: &mut watch::Receiver<bool>,
    registry: &OwnedProcessRegistry,
) -> Result<Output, String> {
    let mut command = TokioCommand::new(program);
    command
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = registry
        .spawn(&mut command)
        .map_err(|e| format!("Could not start {program}: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Setup process stdout unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Setup process stderr unavailable")?;
    let stdout_task = tokio::spawn(read_capped(stdout));
    let stderr_task = tokio::spawn(read_capped(stderr));
    let mut stdout_task = stdout_task;
    let mut stderr_task = stderr_task;
    let status = tokio::select! {
        status = child.wait() => match status {
            Ok(status) => status,
            Err(error) => { child.terminate_tree().await?; return Err(format!("Could not wait for {program}: {error}")); }
        },
        _ = stop_cancelled(stop) => {
            child.terminate_tree().await?;
            let _ = child.wait().await;
            drain_readers(&mut stdout_task, &mut stderr_task).await?;
            return Err(format!("{program} setup was cancelled."));
        }
        _ = tokio::time::sleep(limit) => {
            child.terminate_tree().await?;
            let _ = child.wait().await;
            drain_readers(&mut stdout_task, &mut stderr_task).await?;
            return Err(format!("{program} setup exceeded {} seconds and was stopped.", limit.as_secs()));
        }
    };
    let output = tokio::select! {
        result = join_readers(&mut stdout_task, &mut stderr_task) => result,
        _ = tokio::time::sleep(Duration::from_secs(2)) => {
            child.terminate_tree().await?;
            drain_readers(&mut stdout_task, &mut stderr_task).await?;
            return Err(format!("{program} left output pipes open after exiting."));
        }
        _ = stop_cancelled(stop) => {
            child.terminate_tree().await?;
            drain_readers(&mut stdout_task, &mut stderr_task).await?;
            return Err(format!("{program} setup was cancelled."));
        }
    };
    let (stdout, stderr) = match output {
        Ok(output) => output,
        Err(error) => {
            child.terminate_tree().await?;
            return Err(error);
        }
    };
    child.terminate_tree().await?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

async fn stop_cancelled(stop: &mut watch::Receiver<bool>) {
    loop {
        if *stop.borrow() {
            return;
        }
        if stop.changed().await.is_err() || *stop.borrow() {
            return;
        }
    }
}

pub async fn prepare(
    snapshot: &GitSnapshot,
    task_id: &str,
    data_dir: &Path,
    profiles: &[ParticipantConfig],
    stop: &mut watch::Receiver<bool>,
) -> Result<PreparedWorkspace, StartupNeedsYou> {
    let operation_dir = operation_process_dir(data_dir, task_id).map_err(StartupNeedsYou::new)?;
    let registry = OwnedProcessRegistry::new(Some(operation_dir));
    let workers = verify_workers_with_registry(profiles, stop, &registry).await?;
    if *stop.borrow() {
        return Err(StartupNeedsYou::new("Task startup was cancelled."));
    }
    let path = assistant_git::prepare_worktree(snapshot, task_id, data_dir)
        .map_err(StartupNeedsYou::new)?;
    let data_root = std::fs::canonicalize(data_dir).map_err(|e| {
        StartupNeedsYou::new(format!("Could not resolve isolated data folder: {e}"))
    })?;
    let base = data_root.join("apex-agent").join("tasks").join(task_id);
    let cargo_target_dir = base.join("cargo-target");
    std::fs::create_dir_all(&cargo_target_dir).map_err(|e| {
        StartupNeedsYou::new(format!(
            "Could not prepare the task's separate Rust target folder: {e}"
        ))
    })?;
    let setup = dependency_setup(&path).map_err(StartupNeedsYou::new)?;
    let npm_installed = if setup == DependencySetup::NpmCi {
        let output = run_owned("npm", &["ci"], &path, SETUP_TIMEOUT, stop, &registry)
            .await
            .map_err(StartupNeedsYou::new)?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(StartupNeedsYou::new(format!(
                "Locked npm setup failed in the isolated worktree: {}",
                detail
                    .lines()
                    .last()
                    .unwrap_or("npm ci exited unsuccessfully")
            )));
        }
        true
    } else {
        false
    };
    Ok(PreparedWorkspace {
        path,
        setup: SetupMetadata {
            dependency_setup: setup,
            npm_installed,
            cargo_target_dir,
            node_modules_shared: false,
        },
        workers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::{oneshot, watch};

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_setup_kills_descendants_and_clears_durable_manifest() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("apex-owned-setup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("fake-npm");
        let child_pid_file = root.join("child.pid");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nsleep 30 &\necho $! > '{}'\nwait\n",
                child_pid_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let registry_dir = root.join("registry");
        let registry = OwnedProcessRegistry::new(Some(registry_dir.clone()));
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let run_root = root.clone();
        let run_script = script.to_string_lossy().to_string();
        let run = tokio::spawn(async move {
            run_owned(
                &run_script,
                &[],
                &run_root,
                Duration::from_secs(60),
                &mut stop_rx,
                &registry,
            )
            .await
        });
        for _ in 0..500 {
            if child_pid_file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            child_pid_file.exists(),
            "fake CLI did not start its descendant"
        );
        let child_pid = std::fs::read_to_string(&child_pid_file)
            .unwrap()
            .trim()
            .to_owned();
        stop_tx.send(true).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), run)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert_eq!(std::fs::read_dir(&registry_dir).unwrap().count(), 0);
        let state = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &child_pid])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&state.stdout).trim().to_owned();
        assert!(
            state.is_empty() || state.starts_with('Z'),
            "descendant remained active: {state}"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_and_host_slots_bound_concurrency_and_cancel_queued_work() {
        let slots = Arc::new(IsolatedSlots::new());
        let root =
            std::env::temp_dir().join(format!("apex-isolation-slots-{}", std::process::id()));
        let project = root.join("project");
        let other_a = root.join("other-a");
        let other_b = root.join("other-b");
        let other_c = root.join("other-c");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&other_a).unwrap();
        std::fs::create_dir_all(&other_b).unwrap();
        std::fs::create_dir_all(&other_c).unwrap();
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        let first = slots.acquire(project.clone(), &mut stop_rx).await.unwrap();
        let second = slots.acquire(project.clone(), &mut stop_rx).await.unwrap();
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let queued_slots = slots.clone();
        let queued =
            tokio::spawn(
                async move { queued_slots.acquire(project.clone(), &mut cancel_rx).await },
            );
        tokio::task::yield_now().await;
        cancel_tx.send(true).unwrap();
        assert!(
            queued.await.unwrap().is_err(),
            "a cancelled queued task must not start"
        );

        let third_project = slots.acquire(other_a, &mut stop_rx).await.unwrap();
        let fourth_project = slots.acquire(other_b, &mut stop_rx).await.unwrap();
        let (global_cancel_tx, mut global_cancel_rx) = watch::channel(false);
        let queued_slots = slots.clone();
        let (started_tx, started_rx) = oneshot::channel();
        let queued_global = tokio::spawn(async move {
            let permit = queued_slots.acquire(other_c, &mut global_cancel_rx).await;
            let _ = started_tx.send(());
            permit
        });
        tokio::task::yield_now().await;
        global_cancel_tx.send(true).unwrap();
        assert!(
            queued_global.await.unwrap().is_err(),
            "a task queued on the host limit must cancel"
        );
        assert!(started_rx.await.is_ok());
        drop((first, second, third_project, fourth_project));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claude_trust_is_ready_only_when_installed_help_confirms_non_tty_skip() {
        let confirmed = "-p, --print Print response and exit. Note: The workspace trust dialog is skipped when Claude is run in non-interactive mode (via -p, or when stdout is not a TTY).";
        assert!(claude_noninteractive_trust_supported(confirmed));
        assert!(!claude_noninteractive_trust_supported(
            "-p, --print Print response and exit."
        ));
        assert!(matches!(
            classify_claude_help("claude", confirmed),
            WorkerReadiness::Ready { .. }
        ));
    }

    #[test]
    fn dependency_plan_requires_a_root_npm_manifest_and_lock_and_never_links_modules() {
        let root = std::env::temp_dir().join(format!("apex-isolation-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(dependency_setup(&root).unwrap(), DependencySetup::None);
        std::fs::write(root.join("package.json"), "{}\n").unwrap();
        assert_eq!(dependency_setup(&root).unwrap(), DependencySetup::None);
        std::fs::write(root.join("package-lock.json"), "{}\n").unwrap();
        assert_eq!(dependency_setup(&root).unwrap(), DependencySetup::NpmCi);
        std::fs::remove_file(root.join("package-lock.json")).unwrap();
        std::fs::write(root.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();
        assert!(dependency_setup(&root)
            .unwrap_err()
            .contains("explicit human-selected command"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounded_setup_runner_kills_the_owned_process_group_on_timeout() {
        // The registry refuses shared parents such as Linux's /tmp, so give it
        // a private namespace like production's data folder.
        let root = std::env::temp_dir().join(format!("apex-isolation-timeout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let registry_dir = root.join("registry");
        let registry = OwnedProcessRegistry::new(Some(registry_dir.clone()));
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        let started = std::time::Instant::now();
        let result = run_owned(
            "/bin/sh",
            &["-c", "sleep 30"],
            &root,
            Duration::from_millis(25),
            &mut stop_rx,
            &registry,
        )
        .await;
        let error = result.unwrap_err();
        assert!(error.contains("exceeded"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(std::fs::read_dir(&registry_dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn unsupported_editing_worker_requires_human_startup_action() {
        let readiness = classify_backend(
            "profile-1",
            &Backend::Agent {
                tool: AgentTool::Codex,
                model: None,
            },
        );
        assert!(matches!(readiness, WorkerReadiness::NeedsYou { .. }));
        let api = classify_backend(
            "profile-2",
            &Backend::OpenAiCompatible {
                base_url: "http://localhost".into(),
                model: "test".into(),
                api_key_env: None,
            },
        );
        assert!(matches!(api, WorkerReadiness::NeedsYou { .. }));
    }
}
