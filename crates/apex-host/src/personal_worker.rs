//! The personal assistant's worker: one per host. It takes saved events in
//! order, answers human messages with a tool-free model call, applies
//! decisions and cancellations in code, and runs approved operations through
//! the gateway check. No model keeps running while a task waits: timers,
//! dependencies, schedules and notices are moved along by a clock in code.
//!
//! Jobs run side by side: a slow reply doesn't hold up approvals, cancels or
//! commands. Per assistant there is at most one reply in flight (so each one
//! sees the last), and an operation that isn't safe to repeat runs alone.

use std::{collections::{HashMap, HashSet}, future::Future, pin::Pin, sync::Arc, time::Duration};

use apex_core::{ParticipantConfig, TurnRequest};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::personal::{
    now, valid_argv, ActionMode, CostEntry, CostSource, DecisionKind, DecisionStatus, EventSource, EventState, Fact, FactKind,
    FactSource, OpPhase, OperationReceipt, OperationSpec, PendingDecision, PersonalAssistant, PersonalEvent, PersonalTask,
    ProcessMark, RunPlan, Schedule, ScheduleStatus, StopCondition, TaskKind, TaskStatus, TaskWait, ToolClass, MAX_FACTS,
};
use crate::Host;

pub const COMMAND_TOOL: &str = "host.command";
/// A Spend decision for one model reply: its argv is the held event's id.
pub const REPLY_TOOL: &str = "model.reply";
const COMMAND_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const EXCERPT_BYTES: usize = 4 * 1024;
const MAX_EVENT_ATTEMPTS: u32 = 3;
const MAX_TASK_ATTEMPTS: u32 = 3;
/// Replies and operations in flight at once, across all assistants.
/// Approvals and cancels don't count: they're quick and never wait.
const MAX_JOBS: usize = 4;
const MAX_HELPERS: usize = 3;
const DEFAULT_REPEAT_RUNS: u32 = 24;
const MAX_REPEAT_RUNS: u32 = 500;
const MAX_LATER_MS: u64 = 30 * 86_400_000;
const MIN_SCHEDULE_MS: u64 = 5 * 60_000;
/// A deadline this close, with the task not done, is worth a notice.
const AT_RISK_MS: u64 = 60 * 60_000;
/// A command result older than this is history, not the machine's current
/// state, so its output is kept out of the model's context.
pub(crate) const FRESH_RESULT_MS: u64 = 2 * 60 * 1000;

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// Told which process group a command started in, so it can be saved.
pub type Started = Arc<dyn Fn(ProcessMark) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRun {
    pub exit_code: i32,
    pub output: String,
}

/// A model's answer and what the backend said it cost.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReasonOut {
    pub text: String,
    pub cost_micros: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

impl ReasonOut {
    pub fn text(text: impl Into<String>) -> Self {
        ReasonOut { text: text.into(), ..Self::default() }
    }
}

/// What the worker calls out to. Tests swap in fakes.
#[derive(Clone)]
pub struct WorkerTools {
    pub reason: Arc<dyn Fn(ParticipantConfig, TurnRequest) -> BoxFuture<Result<ReasonOut, String>> + Send + Sync>,
    pub execute: Arc<dyn Fn(OperationSpec, Started) -> BoxFuture<Result<ToolRun, String>> + Send + Sync>,
    /// `Some(repeatable)` for an operation this machine can run, `None` for
    /// an unknown tool. Repeatable means running it twice does no harm.
    pub tool: Arc<dyn Fn(&OperationSpec) -> Option<bool> + Send + Sync>,
}

impl WorkerTools {
    pub fn real() -> Self {
        WorkerTools {
            reason: Arc::new(|config, request| Box::pin(async move {
                crate::monitor_check::reason_reply(config, request).await.map(|reply| ReasonOut {
                    text: reply.text, cost_micros: reply.cost_micros, input_tokens: reply.input_tokens, output_tokens: reply.output_tokens,
                })
            })),
            execute: Arc::new(|spec, started| Box::pin(run_operation(spec, started))),
            // A command that only reads may run twice; anything else is never
            // repeated blindly after a restart. Connectors only read.
            tool: Arc::new(|op| match op.tool.as_str() {
                COMMAND_TOOL => Some(gateway::classify(op, &[]).0 == ToolClass::Read),
                name if connectors::known(name) => Some(true),
                _ => None,
            }),
        }
    }
}

/// Kills the command's whole process group unless it finished by itself, so
/// a timeout or a cancel also ends anything the command started.
struct GroupKill(Option<u32>);

impl Drop for GroupKill {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.and_then(|pid| libc::pid_t::try_from(pid).ok()).filter(|pid| *pid > 0) {
            // SAFETY: plain syscall; the group was made for this command alone.
            unsafe { libc::killpg(pid, libc::SIGKILL) };
        }
    }
}

fn timeout_of(spec: &OperationSpec) -> Duration {
    Duration::from_millis(spec.plan.as_ref().and_then(|p| p.timeout_ms).unwrap_or(COMMAND_TIMEOUT_MS).clamp(1_000, MAX_TIMEOUT_MS))
}

async fn run_operation(spec: OperationSpec, started: Started) -> Result<ToolRun, String> {
    if spec.tool == COMMAND_TOOL {
        run_command(spec, started).await
    } else {
        connectors::run(&spec).await
    }
}

/// `host.command`: argv with no shell, in its folder, time- and size-limited.
/// Dropping the future (a cancel) kills the command and everything it started.
pub(crate) async fn run_command(spec: OperationSpec, started: Started) -> Result<ToolRun, String> {
    let limit = timeout_of(&spec);
    let (program, args) = spec.argv.split_first().ok_or("The command is empty.")?;
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(&spec.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    // Its own process group, so its children can be stopped with it.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| format!("Could not start {program}: {e}"))?;
    let mut group = GroupKill(child.id());
    if let Some(mark) = child.id().and_then(process::mark) {
        started(mark);
    }
    // Keep at most the cap of each stream in memory; the rest is read and dropped.
    async fn capped(stream: Option<impl tokio::io::AsyncRead + Unpin>) -> Vec<u8> {
        use tokio::io::AsyncReadExt;
        let (Some(mut stream), mut kept, mut buf) = (stream, Vec::new(), [0u8; 8192]) else { return vec![] };
        while let Ok(n) = stream.read(&mut buf).await {
            if n == 0 { break; }
            let room = MAX_OUTPUT_BYTES.saturating_sub(kept.len());
            kept.extend_from_slice(&buf[..n.min(room)]);
        }
        kept
    }
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let run = async { tokio::join!(child.wait(), capped(out), capped(err)) };
    let (status, mut bytes, stderr) = tokio::time::timeout(limit, run)
        .await
        .map_err(|_| format!("The command took longer than {} seconds and was stopped.", limit.as_secs()))?;
    let status = status.map_err(|e| format!("The command failed: {e}"))?;
    group.0 = None;
    bytes.extend_from_slice(&stderr);
    bytes.truncate(MAX_OUTPUT_BYTES);
    Ok(ToolRun { exit_code: status.code().unwrap_or(-1), output: String::from_utf8_lossy(&bytes).into_owned() })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelReply {
    reply: String,
    #[serde(default)]
    task: Option<ProposedTask>,
    #[serde(default)]
    schedule: Option<ProposedSchedule>,
    #[serde(default)]
    helpers: Vec<ProposedHelper>,
    #[serde(default)]
    remember: Vec<ProposedFact>,
    #[serde(default)]
    forget: Vec<String>,
}

impl ModelReply {
    fn plain(text: &str) -> Self {
        ModelReply { reply: text.trim().to_owned(), task: None, schedule: None, helpers: vec![], remember: vec![], forget: vec![] }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposedTask {
    #[serde(default)]
    goal: String,
    #[serde(default)]
    criteria: Vec<String>,
    #[serde(default)]
    argv: Vec<String>,
    /// A connector call instead of a command, such as `github.get`.
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    start_in_minutes: Option<f64>,
    #[serde(default)]
    every_minutes: Option<f64>,
    #[serde(default)]
    max_runs: Option<u32>,
    #[serde(default)]
    until: Option<StopCondition>,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    deadline_minutes: Option<f64>,
    #[serde(default)]
    timeout_seconds: Option<u64>,
    #[serde(default)]
    machine: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposedSchedule {
    #[serde(default)]
    goal: String,
    argv: Vec<String>,
    #[serde(default)]
    daily_at: Option<String>,
    #[serde(default)]
    every_minutes: Option<f64>,
}

#[derive(Deserialize)]
struct ProposedHelper {
    assignment: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposedFact {
    text: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    explicit: bool,
    #[serde(default)]
    confidence: Option<u8>,
    #[serde(default)]
    replaces: Option<String>,
    #[serde(default)]
    expires_in_days: Option<f64>,
}

/// The outermost JSON object in the model's text, or the text as a plain reply.
fn parse_reply(text: &str) -> ModelReply {
    let parsed = serde_json::from_str::<ModelReply>(text.trim()).ok().or_else(|| {
        let (start, end) = (text.find('{')?, text.rfind('}')?);
        serde_json::from_str::<ModelReply>(text.get(start..=end)?).ok()
    });
    parsed.unwrap_or_else(|| ModelReply::plain(text))
}

fn excerpt(text: &str) -> String {
    if text.len() <= EXCERPT_BYTES {
        return text.to_owned();
    }
    let mut end = EXCERPT_BYTES;
    while !text.is_char_boundary(end) { end -= 1; }
    format!("{}\n… (cut)", &text[..end])
}

fn output_hash(text: &str) -> String {
    format!("sha256:{}", Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>())
}

pub(crate) fn shown(op: &OperationSpec) -> String {
    if op.tool == COMMAND_TOOL { op.argv.join(" ") } else { format!("{} {}", op.tool, op.argv.join(" ")) }
}

pub(crate) fn clock(ms: u64) -> String {
    let minutes = ms / 60_000;
    format!("{:02}:{:02} UTC", minutes / 60 % 24, minutes % 60)
}

/// "14:05" in the human's time zone.
fn local(assistant: &PersonalAssistant, ms: u64) -> String {
    let minutes = assistant.local_minutes(ms);
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

pub(crate) fn age(ms: u64) -> String {
    match ms / 1000 {
        s if s < 60 => format!("{s}s ago"),
        s if s < 3600 => format!("{} min ago", s / 60),
        s if s < 86_400 => format!("{} h ago", s / 3600),
        s => format!("{} days ago", s / 86_400),
    }
}

fn minutes_ms(minutes: f64, cap: u64) -> Option<u64> {
    (minutes.is_finite() && minutes > 0.0).then(|| ((minutes * 60_000.0) as u64).min(cap))
}

fn plan_from(proposed: &ProposedTask, now: u64) -> Option<RunPlan> {
    let every_ms = proposed.every_minutes.and_then(|m| minutes_ms(m, 7 * 86_400_000)).map(|ms| ms.max(60_000));
    let plan = RunPlan {
        start_at: proposed.start_in_minutes.and_then(|m| minutes_ms(m, MAX_LATER_MS)).map(|ms| now + ms),
        every_ms,
        max_runs: every_ms.map(|_| proposed.max_runs.unwrap_or(DEFAULT_REPEAT_RUNS).clamp(1, MAX_REPEAT_RUNS)),
        until: proposed.until.clone().filter(|until| !until.empty() && every_ms.is_some()),
        timeout_ms: proposed.timeout_seconds.map(|s| s.saturating_mul(1000).clamp(1_000, MAX_TIMEOUT_MS)),
        deadline_at: proposed.deadline_minutes.and_then(|m| minutes_ms(m, MAX_LATER_MS)).map(|ms| now + ms),
        after: proposed.after.clone().map(|a| a.trim().to_owned()).filter(|a| !a.is_empty()),
    };
    (plan != RunPlan::default()).then_some(plan)
}

/// The plan in plain words, for approval lines and updates.
fn describe_plan(assistant: &PersonalAssistant, plan: &RunPlan) -> String {
    let mut parts = Vec::new();
    if let Some(at) = plan.start_at { parts.push(format!("starts at {}", local(assistant, at))); }
    if let Some(every) = plan.every_ms {
        parts.push(format!("every {} min, up to {} runs", every / 60_000, plan.max_runs.unwrap_or(DEFAULT_REPEAT_RUNS)));
    }
    if let Some(until) = &plan.until {
        let mut when = Vec::new();
        if let Some(code) = until.exit_code { when.push(format!("it exits with {code}")); }
        if let Some(text) = &until.output_contains { when.push(format!("the output contains \"{text}\"")); }
        if let Some(text) = &until.output_lacks { when.push(format!("the output no longer contains \"{text}\"")); }
        parts.push(format!("stops when {}", when.join(" and ")));
    }
    if let Some(after) = &plan.after { parts.push(format!("after {after} finishes")); }
    if let Some(at) = plan.deadline_at { parts.push(format!("deadline {}", local(assistant, at))); }
    if let Some(ms) = plan.timeout_ms { parts.push(format!("time limit {} s", ms / 1000)); }
    parts.join("; ")
}

fn machine_name(assistant: &PersonalAssistant, host: &str) -> String {
    if host == assistant.host_id { return "this server".into(); }
    assistant.machines.iter().find(|m| m.host_id == host).map_or_else(|| host.to_owned(), |m| m.name.clone())
}

/// Replies and operations count toward `MAX_JOBS`; approvals and cancels don't.
fn heavy_key(key: &str) -> bool {
    key.starts_with("reply:") || key.starts_with("task:")
}

/// The model host a profile sends its requests to.
pub(crate) fn endpoint(profile: &ParticipantConfig) -> String {
    use apex_core::{AgentTool, Backend};
    match &profile.backend {
        Backend::Agent { tool: AgentTool::ClaudeCode, .. } => "api.anthropic.com".into(),
        Backend::Agent { tool: AgentTool::Codex, .. } => "api.openai.com".into(),
        Backend::Agent { tool: AgentTool::Gemini, .. } => "generativelanguage.googleapis.com".into(),
        Backend::Agent { tool: AgentTool::Grok, .. } => "api.x.ai".into(),
        Backend::OpenAiCompatible { base_url, .. } => {
            let rest = base_url.split("://").nth(1).unwrap_or(base_url);
            let host = rest.split(['/', '?']).next().unwrap_or(rest);
            host.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(host, |(h, _)| h).to_lowercase()
        }
        // A command-line tool may call anywhere, so it never counts as local.
        Backend::Cli { program, .. } => format!("cli:{program}"),
        Backend::Scripted { .. } => "scripted".into(),
    }
}

fn is_local(endpoint: &str) -> bool {
    if endpoint == "scripted" || endpoint == "localhost" {
        return true;
    }
    match endpoint.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

/// Why a model call to this profile isn't allowed, checked before sending.
fn endpoint_refusal(assistant: &PersonalAssistant, profile: &ParticipantConfig) -> Option<String> {
    let host = endpoint(profile);
    if assistant.privacy.local_only && !is_local(&host) {
        return Some(format!("Local-only mode is on, and this assistant's model is at {host}, so nothing was sent."));
    }
    let allowed = &assistant.privacy.allowed_endpoints;
    if !allowed.is_empty() && !allowed.iter().any(|a| a.trim().eq_ignore_ascii_case(&host)) {
        return Some(format!("{host} isn't on this assistant's list of allowed model endpoints, so nothing was sent."));
    }
    None
}

fn dollars(micros: u64) -> String {
    format!("${:.2}", micros as f64 / 1e6)
}

/// Why this reply needs the human's OK to spend, if it does.
fn spend_hold(assistant: &PersonalAssistant, profile: &ParticipantConfig, event: &PersonalEvent, now: u64) -> Option<String> {
    let limit = assistant.budget.daily_limit_micros?;
    if event.spend_approved {
        return None;
    }
    let spent = assistant.spent_today(now);
    if spent >= limit {
        return Some(format!("Today's spending is {} of your {} daily limit. Reply anyway?", dollars(spent), dollars(limit)));
    }
    let host = endpoint(profile);
    let unknown = match assistant.costs.iter().rev().find(|c| c.endpoint == host) {
        Some(last) => last.source == CostSource::Unknown,
        // No history yet: an API profile may not report cost.
        None => matches!(profile.backend, apex_core::Backend::OpenAiCompatible { .. }),
    };
    (unknown && !assistant.budget.unknown_cost_ok).then(|| "This model doesn't report what each reply costs, so I can't keep to your daily limit. Reply anyway?".to_owned())
}

fn cost_entry(purpose: &str, out: &ReasonOut, bytes_out: usize, endpoint: String, at: u64) -> CostEntry {
    CostEntry {
        at, purpose: purpose.into(), kind: "text".into(),
        source: if out.cost_micros.is_some() { CostSource::Reported } else { CostSource::Unknown },
        micros: out.cost_micros, input_tokens: out.input_tokens, output_tokens: out.output_tokens,
        bytes_out: bytes_out as u64, endpoint,
    }
}

fn read_only_request(system: String) -> TurnRequest {
    TurnRequest { system, turns: vec![], unseen: vec![], plan: false, access: Some(apex_core::Access::Read), effort_override: None }
}

/// What one step of the worker found to do.
pub(crate) enum Work {
    Event(PersonalAssistant, PersonalEvent),
    Task(String, String),
}

/// What the clock found: when to wake next, and notices to push.
pub(crate) struct Tick {
    pub next: Option<u64>,
    pub pushes: Vec<(String, crate::personal::Notice)>,
}

impl Host {
    /// Start once per daemon, after `<data>/host-id` exists.
    pub fn start_personal_worker(self: &Arc<Self>) -> Result<(), String> {
        self.start_personal_worker_with(WorkerTools::real())
    }

    pub fn start_personal_worker_with(self: &Arc<Self>, tools: WorkerTools) -> Result<(), String> {
        let mut worker = self.personal_worker.lock().unwrap();
        if worker.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(());
        }
        self.personal_recover()?;
        browser::use_profile(self.data_dir().join("assistant-browser"));
        let owner = Arc::downgrade(self);
        let wake = self.personal_wake.clone();
        *worker = Some(self.runtime().spawn(async move {
            let mut jobs = tokio::task::JoinSet::new();
            // Keys held by each running job, so a panicked job still frees them.
            let mut held: HashMap<tokio::task::Id, Vec<String>> = HashMap::new();
            loop {
                let Some(host) = owner.upgrade() else { break };
                let mut delay = Duration::from_secs(60);
                match host.personal_tick(now()) {
                    Ok(tick) => {
                        if let Some(next) = tick.next {
                            delay = delay.min(Duration::from_millis(next.saturating_sub(now()).max(250)));
                        }
                        if !tick.pushes.is_empty() {
                            let host = host.clone();
                            tokio::spawn(async move { host.personal_push(tick.pushes).await });
                        }
                    }
                    Err(error) => eprintln!("Personal assistant clock: {error}"),
                }
                let busy: HashSet<String> = held.values().flatten().cloned().collect();
                let heavy = busy.iter().filter(|key| heavy_key(key)).count();
                match host.personal_claim(&tools, &busy, usize::MAX, MAX_JOBS.saturating_sub(heavy)) {
                    Ok(claimed) => {
                        for (keys, work) in claimed {
                            let (host, tools) = (host.clone(), tools.clone());
                            let job = jobs.spawn(async move {
                                if let Err(error) = host.personal_do(&tools, work).await {
                                    eprintln!("Personal assistant: {error}");
                                }
                            });
                            held.insert(job.id(), keys);
                        }
                    }
                    Err(error) => {
                        eprintln!("Personal assistant: {error}");
                        delay = delay.min(Duration::from_secs(5));
                    }
                }
                drop(host);
                tokio::select! {
                    Some(done) = jobs.join_next_with_id(), if !jobs.is_empty() => {
                        let id = match done { Ok((id, ())) => id, Err(error) => error.id() };
                        held.remove(&id);
                    }
                    _ = wake.notified() => {},
                    _ = tokio::time::sleep(delay) => {},
                }
            }
        }));
        Ok(())
    }

    /// Put interrupted work back where the worker can see it, after
    /// stopping any command the old service left running.
    pub(crate) fn personal_recover(&self) -> Result<(), String> {
        self.change_personal(|assistants| {
            for assistant in assistants {
                let mut changed = false;
                for receipt in assistant.tasks.iter_mut().flat_map(|t| &mut t.receipts) {
                    if receipt.phase != OpPhase::Attempted { continue }
                    let Some(mark) = &receipt.process else { continue };
                    let found = match process::stop_leftover(mark) {
                        process::Leftover::Stopped => "its leftover processes were stopped",
                        process::Leftover::Gone => "nothing from it was still running",
                        process::Leftover::NotOurs => "the process now using its id isn't this command, so it was left alone",
                    };
                    eprintln!("Personal assistant: recovering {}: {found}.", receipt.op_id);
                    receipt.note = Some(format!("The service restarted before this finished; {found}."));
                    changed = true;
                }
                if assistant.recover() | changed { assistant.revision += 1; }
            }
            Ok(())
        })
    }

    /// Do one thing: the oldest waiting event, else one approved task.
    /// `Ok(false)` when there was nothing to do.
    pub async fn personal_step(&self, tools: &WorkerTools) -> Result<bool, String> {
        self.personal_step_at(tools, now()).await
    }

    /// `personal_step` as if the clock said `at`, for timers in tests.
    pub async fn personal_step_at(&self, tools: &WorkerTools, at: u64) -> Result<bool, String> {
        self.personal_tick(at)?;
        match self.personal_claim(tools, &HashSet::new(), 1, 1)?.pop() {
            None => Ok(false),
            Some((_, work)) => self.personal_do(tools, work).await.map(|()| true),
        }
    }

    /// Move timers, dependencies, deadlines, schedules and notices along.
    pub(crate) fn personal_tick(&self, at: u64) -> Result<Tick, String> {
        let local = self.local_host_id().unwrap_or_default();
        self.change_personal(|assistants| {
            let mut tick = Tick { next: None, pushes: vec![] };
            for assistant in assistants.iter_mut() {
                let before = assistant.clone();
                let (next, pushes) = tick_assistant(assistant, &local, at);
                tick.next = match (tick.next, next) { (Some(a), Some(b)) => Some(a.min(b)), (a, b) => a.or(b) };
                tick.pushes.extend(pushes.into_iter().map(|n| (assistant.id.clone(), n)));
                if *assistant != before { assistant.revision += 1; }
            }
            Ok(tick)
        })
    }

    /// Claim up to `max` jobs that don't clash with `busy`, at most `room` of
    /// them replies or operations. Each comes with the keys it holds while it
    /// runs: `reply:<assistant>` (one reply at a time), `task:<assistant>:<task>`,
    /// and `write:<assistant>` for an operation that isn't safe to repeat.
    pub(crate) fn personal_claim(&self, tools: &WorkerTools, busy: &HashSet<String>, max: usize, room: usize) -> Result<Vec<(Vec<String>, Work)>, String> {
        self.change_personal(|assistants| {
            let mut taken = busy.clone();
            let mut out = Vec::new();
            let mut heavy = 0;
            for assistant in assistants.iter_mut() {
                let id = assistant.id.clone();
                let mut events = Vec::new();
                for event in assistant.events.iter_mut().filter(|e| e.state == EventState::Received) {
                    let model = matches!(event.source, EventSource::Human { .. } | EventSource::Internal { .. });
                    let key = if model { format!("reply:{id}") } else { format!("event:{id}:{}", event.id) };
                    if out.len() + events.len() >= max || (model && heavy >= room) || taken.contains(&key) { continue; }
                    heavy += usize::from(model);
                    taken.insert(key.clone());
                    event.state = EventState::Processing;
                    event.attempts += 1;
                    events.push((key, event.clone()));
                }
                if !events.is_empty() {
                    assistant.revision += 1;
                }
                for (key, event) in events {
                    out.push((vec![key], Work::Event(assistant.clone(), event)));
                }
                // Paused: messages and controls above still go through, but no task starts.
                for task in assistant.tasks.iter().filter(|t| t.status == TaskStatus::Queued && !assistant.paused) {
                    if out.len() >= max || heavy >= room { break; }
                    let mut keys = vec![format!("task:{id}:{}", task.id)];
                    // Unknown tools count as unsafe to repeat; the gateway then refuses them.
                    if task.kind == TaskKind::Command && !task.operation.as_ref().and_then(|op| (tools.tool)(op)).unwrap_or(false) {
                        keys.push(format!("write:{id}"));
                    }
                    if keys.iter().any(|key| taken.contains(key)) { continue; }
                    heavy += 1;
                    taken.extend(keys.iter().cloned());
                    out.push((keys, Work::Task(id.clone(), task.id.clone())));
                }
            }
            Ok(out)
        })
    }

    async fn personal_do(&self, tools: &WorkerTools, work: Work) -> Result<(), String> {
        match work {
            Work::Event(assistant, event) => self.personal_event(tools, assistant, event).await,
            Work::Task(assistant, task) => self.personal_run(tools, &assistant, &task).await,
        }
    }

    async fn personal_event(&self, tools: &WorkerTools, snapshot: PersonalAssistant, event: PersonalEvent) -> Result<(), String> {
        match &event.source {
            EventSource::Human { text } => self.personal_answer(tools, snapshot, &event, text.clone()).await,
            EventSource::Internal { what } => self.personal_internal(tools, snapshot, &event, what.clone()).await,
            _ => {
                let stop = self.change_assistant(&snapshot.id, |assistant| Ok(apply_control(assistant, &event)))?;
                // The cancel is saved first, so a stopped command can't be mistaken for a finished one.
                let stops = self.personal_stops.lock().unwrap();
                for task_id in stop {
                    if let Some(signal) = stops.get(&format!("{}:{task_id}", snapshot.id)) {
                        signal.notify_one();
                    }
                }
                Ok(())
            }
        }
    }

    /// Answer the human: privacy and spend checks in code, then one
    /// tool-free model call with the assembled context.
    async fn personal_answer(&self, tools: &WorkerTools, snapshot: PersonalAssistant, event: &PersonalEvent, text: String) -> Result<(), String> {
        let Some(profile) = snapshot.profile.clone() else {
            return self.finish_event(&snapshot.id, &event.id, Err("This assistant has no model profile.".into()));
        };
        let at = now();
        if let Some(why) = endpoint_refusal(&snapshot, &profile) {
            return self.refuse_event(&snapshot.id, &event.id, why);
        }
        if let Some(prompt) = spend_hold(&snapshot, &profile, event, at) {
            return self.change_assistant(&snapshot.id, |assistant| { hold_for_spend(assistant, &event.id, prompt, at); Ok(()) });
        }
        let tools_on = if snapshot.privacy.local_only { vec![] } else { connectors::available() };
        let system = context::assemble(&snapshot, &text, at, &tools_on);
        let bytes = system.len();
        // No lock is held across the model call. A restart here leaves the
        // event `Processing`, which recovery turns back into `Received`; the
        // call has no side effects, so running it again commits one reply.
        match (tools.reason)(profile.clone(), read_only_request(system)).await {
            Ok(out) => {
                let cost = cost_entry("reply", &out, bytes, endpoint(&profile), now());
                self.commit_reply(tools, &snapshot.id, &event.id, &text, parse_reply(&out.text), cost)
            }
            Err(error) => self.finish_event(&snapshot.id, &event.id, Err(error)),
        }
    }

    /// Work the host gave itself. Today: pull helpers' reports into one answer.
    async fn personal_internal(&self, tools: &WorkerTools, snapshot: PersonalAssistant, event: &PersonalEvent, what: String) -> Result<(), String> {
        let Some(parent) = what.strip_prefix("consolidate:") else {
            return self.finish_event(&snapshot.id, &event.id, Ok(()));
        };
        let Some(profile) = snapshot.profile.clone() else {
            return self.finish_event(&snapshot.id, &event.id, Err("This assistant has no model profile.".into()));
        };
        if let Some(why) = endpoint_refusal(&snapshot, &profile) {
            return self.refuse_event(&snapshot.id, &event.id, why);
        }
        let question = snapshot.events.iter().find(|e| e.id == parent).and_then(|e| match &e.source { EventSource::Human { text } => Some(text.clone()), _ => None }).unwrap_or_default();
        let reports: Vec<(String, String)> = snapshot.tasks.iter()
            .filter(|t| t.kind == TaskKind::Helper && t.parent.as_deref() == Some(parent) && t.status == TaskStatus::Done)
            .map(|t| (t.assignment.clone().unwrap_or_default(), t.receipts.last().map(|r| r.output_excerpt.clone()).unwrap_or_default()))
            .collect();
        if reports.is_empty() {
            return self.finish_event(&snapshot.id, &event.id, Ok(()));
        }
        let system = context::consolidate_prompt(&snapshot, &question, &reports, now());
        let bytes = system.len();
        match (tools.reason)(profile.clone(), read_only_request(system)).await {
            Ok(out) => {
                let cost = cost_entry("summary", &out, bytes, endpoint(&profile), now());
                // Only the text is used: a summary of helper reports can't start anything.
                let reply = parse_reply(&out.text).reply;
                self.change_assistant(&snapshot.id, |assistant| {
                    let at = now();
                    let Some(saved) = assistant.events.iter_mut().find(|e| e.id == event.id && e.state == EventState::Processing) else { return Ok(()) };
                    saved.state = EventState::Done;
                    assistant.add_cost(cost);
                    let text = if reply.trim().is_empty() { "The helpers finished; their reports are above.".to_owned() } else { reply.trim().to_owned() };
                    assistant.post("assistant", "chat", text.clone(), None, Some(event.id.clone()), at);
                    notify::notify(assistant, format!("Helpers finished: {}", text.chars().take(140).collect::<String>()), None, false, format!("consolidated:{parent}"), at);
                    Ok(())
                })
            }
            Err(error) => self.finish_event(&snapshot.id, &event.id, Err(error)),
        }
    }

    /// Settle an event that may not go ahead, and say why.
    fn refuse_event(&self, assistant_id: &str, event_id: &str, why: String) -> Result<(), String> {
        self.change_assistant(assistant_id, |assistant| {
            let Some(event) = assistant.events.iter_mut().find(|e| e.id == event_id && e.state == EventState::Processing) else { return Ok(()) };
            event.state = EventState::Failed;
            event.error = Some(why.clone());
            assistant.post("system", "update", why, None, Some(event_id.into()), now());
            Ok(())
        })
    }

    /// Settle a failed model event, or put it back to try again.
    fn finish_event(&self, assistant_id: &str, event_id: &str, result: Result<(), String>) -> Result<(), String> {
        self.change_assistant(assistant_id, |assistant| {
            let at = now();
            let Some(event) = assistant.events.iter_mut().find(|e| e.id == event_id && e.state == EventState::Processing) else { return Ok(()) };
            let Err(error) = result else { event.state = EventState::Done; return Ok(()) };
            event.error = Some(error.clone());
            if event.attempts >= MAX_EVENT_ATTEMPTS {
                event.state = EventState::Failed;
                let id = event.id.clone();
                assistant.post("system", "update", format!("I couldn't answer that: {error}"), None, Some(id), at);
            } else {
                event.state = EventState::Received;
            }
            Ok(())
        })
    }

    fn commit_reply(&self, tools: &WorkerTools, assistant_id: &str, event_id: &str, asked: &str, reply: ModelReply, cost: CostEntry) -> Result<(), String> {
        let local = self.local_host_id()?;
        self.change_assistant(assistant_id, |assistant| {
            let at = now();
            // A duplicate claim or a restart already settled it: one reply per event.
            let Some(event) = assistant.events.iter_mut().find(|e| e.id == event_id && e.state == EventState::Processing) else { return Ok(()) };
            event.state = EventState::Done;
            event.error = None;
            assistant.add_cost(cost);
            let text = if reply.reply.trim().is_empty() { "…".to_owned() } else { reply.reply.trim().to_owned() };
            assistant.post("assistant", "chat", text, None, Some(event_id.to_owned()), at);
            // Outside content (app results, helper reports) in view could have
            // planted a "remember"; only the human's own words may forget.
            let outside = assistant.messages.iter().any(|m| at.saturating_sub(m.at) <= FRESH_RESULT_MS && (m.kind == "helper" || (m.kind == "result" && m.task_id.as_ref().is_some_and(|id| assistant.tasks.iter().any(|t| &t.id == id && t.operation.as_ref().is_some_and(|op| op.tool != COMMAND_TOOL))))));
            let asked_to_forget = ["forget", "delete", "remove", "erase"].iter().any(|w| asked.to_lowercase().contains(w));
            let remember: &[ProposedFact] = if outside { &[] } else { &reply.remember };
            let forget: &[String] = if asked_to_forget { &reply.forget } else { &[] };
            apply_memory(assistant, remember, forget, event_id, at);
            if let Some(proposed) = reply.task {
                propose_task(assistant, tools, &local, event_id, asked, proposed, at);
            }
            if let Some(proposed) = reply.schedule {
                propose_schedule(assistant, event_id, proposed, at);
            }
            let helpers: Vec<String> = reply.helpers.into_iter().map(|h| h.assignment.trim().chars().take(2_000).collect::<String>()).filter(|a| !a.is_empty()).take(MAX_HELPERS).collect();
            if !helpers.is_empty() {
                let count = helpers.len();
                for assignment in helpers {
                    let task_id = assistant.next_task_id();
                    assistant.tasks.push(PersonalTask {
                        id: task_id, goal: format!("Helper: {}", assignment.chars().take(120).collect::<String>()),
                        completion_criteria: vec!["a written report".into()], target_host: assistant.host_id.clone(),
                        status: TaskStatus::Queued, operation: None, decision: None, receipts: vec![],
                        from_event: event_id.to_owned(), max_attempts: 2, created_at: at, updated_at: at,
                        last_update: Some("Waiting to start.".into()), class: ToolClass::Read, kind: TaskKind::Helper,
                        wait: None, runs_done: 0, parent: Some(event_id.to_owned()), schedule_id: None, assignment: Some(assignment),
                    });
                }
                let them = if count == 1 { "a helper" } else { "helpers" };
                assistant.post("system", "update", format!("Sent {them} to look into this ({count}). Their reports will come back here, and I'll pull them together."), None, Some(event_id.to_owned()), at);
            }
            Ok(())
        })
    }

    /// The gateway: everything is re-checked in one locked read right before
    /// the operation runs, and the attempt is saved before it starts.
    async fn personal_run(&self, tools: &WorkerTools, assistant_id: &str, task_id: &str) -> Result<(), String> {
        let local = self.local_host_id()?;
        // Registered before the claim: a cancel saved after the claim always
        // finds it, and `notify_one` keeps the signal if it lands before we wait.
        let key = format!("{assistant_id}:{task_id}");
        let stop = Arc::new(tokio::sync::Notify::new());
        self.personal_stops.lock().unwrap().insert(key.clone(), stop.clone());
        let result = self.personal_run_stoppable(tools, assistant_id, task_id, &local, &stop).await;
        self.personal_stops.lock().unwrap().remove(&key);
        result
    }

    async fn personal_run_stoppable(&self, tools: &WorkerTools, assistant_id: &str, task_id: &str, local: &str, stop: &tokio::sync::Notify) -> Result<(), String> {
        let claimed = self.change_assistant(assistant_id, |assistant| Ok(claim_run(assistant, tools, task_id, local, now())))?;
        let operation = match claimed {
            None => return Ok(()),
            Some(Claimed::Helper(profile, assignment)) => return self.personal_helper(tools, assistant_id, task_id, profile, assignment, stop).await,
            Some(Claimed::Operation(op_id, operation)) => (op_id, operation),
        };
        let (op_id, operation) = operation;
        // A cancel drops the running command, which kills it and its children.
        let (marks, mut marked) = tokio::sync::mpsc::unbounded_channel();
        let run = (tools.execute)(operation.clone(), Arc::new(move |mark| { let _ = marks.send(mark); }));
        tokio::pin!(run);
        let result = loop {
            tokio::select! {
                result = &mut run => break Some(result),
                () = stop.notified() => break None,
                Some(mark) = marked.recv() => {
                    // Saved so a restart can stop whatever this leaves running.
                    let saved = self.change_assistant(assistant_id, |assistant| {
                        if let Some(receipt) = assistant.task_mut(task_id).and_then(|t| t.receipts.iter_mut().find(|r| r.op_id == op_id)) {
                            receipt.process = Some(mark);
                        }
                        Ok(())
                    });
                    if let Err(error) = saved { eprintln!("Personal assistant: {error}"); }
                }
            }
        };
        self.change_assistant(assistant_id, |assistant| { finish_run(assistant, task_id, &op_id, &operation, result, now()); Ok(()) })
    }

    /// A helper: one model call with only its assignment. Its answer comes
    /// back as a quoted report; once every helper for a message is done the
    /// host pulls them together.
    async fn personal_helper(&self, tools: &WorkerTools, assistant_id: &str, task_id: &str, profile: ParticipantConfig, assignment: String, stop: &tokio::sync::Notify) -> Result<(), String> {
        let system = context::helper_prompt(&assignment);
        let bytes = system.len();
        let call = (tools.reason)(profile.clone(), read_only_request(system));
        let result = tokio::select! {
            result = call => Some(result),
            () = stop.notified() => None,
        };
        self.change_assistant(assistant_id, |assistant| {
            let at = now();
            if let Some(Ok(out)) = &result {
                assistant.add_cost(cost_entry("helper", out, bytes, endpoint(&profile), at));
            }
            let Some(task) = assistant.task_mut(task_id) else { return Ok(()) };
            let Some(receipt) = task.receipts.iter_mut().rev().find(|r| r.phase == OpPhase::Attempted) else { return Ok(()) };
            receipt.finished_at = Some(at);
            let cancelled = task.status == TaskStatus::Cancelled;
            let line = match &result {
                None => { receipt.phase = OpPhase::Failed; receipt.note = Some("Stopped because the task was cancelled.".into()); None }
                Some(Ok(out)) => {
                    receipt.phase = OpPhase::Verified;
                    receipt.output_excerpt = excerpt(out.text.trim());
                    receipt.output_hash = Some(output_hash(&out.text));
                    if !cancelled { task.status = TaskStatus::Done; task.last_update = Some("Reported back.".into()); }
                    Some(format!("Helper report on “{}”:\n{}", task.assignment.clone().unwrap_or_default().chars().take(200).collect::<String>(), receipt.output_excerpt))
                }
                Some(Err(error)) => {
                    receipt.phase = OpPhase::Failed;
                    receipt.note = Some(error.clone());
                    if !cancelled {
                        let retry = task.receipts.len() < task.max_attempts as usize;
                        task.status = if retry { TaskStatus::Queued } else { TaskStatus::Failed };
                        task.last_update = Some(if retry { "Failed once; trying again.".into() } else { format!("Failed: {error}") });
                    }
                    None
                }
            };
            task.updated_at = at;
            let parent = task.parent.clone();
            if let Some(line) = line {
                assistant.post("assistant", "helper", line, Some(task_id.into()), None, at);
            }
            // Every helper for that message settled: pull the reports together once.
            if let Some(parent) = parent {
                let siblings: Vec<&PersonalTask> = assistant.tasks.iter().filter(|t| t.kind == TaskKind::Helper && t.parent.as_deref() == Some(parent.as_str())).collect();
                let all_settled = siblings.iter().all(|t| t.status.settled());
                let any_done = siblings.iter().any(|t| t.status == TaskStatus::Done);
                let request = format!("internal:consolidate:{parent}");
                if all_settled && any_done && !assistant.events.iter().any(|e| e.request_id == request) {
                    assistant.counters.event += 1;
                    let id = format!("pe-{}", assistant.counters.event);
                    assistant.events.push(PersonalEvent {
                        id, request_id: request, source: EventSource::Internal { what: format!("consolidate:{parent}") },
                        received_at: at, state: EventState::Received, attempts: 0, error: None, spend_approved: false,
                    });
                }
            }
            Ok(())
        })
    }
}

/// What a claimed task turned out to be.
enum Claimed {
    Operation(String, OperationSpec),
    Helper(ParticipantConfig, String),
}

/// Re-check a queued task in the gateway and, if it may run, save the
/// attempt. Everything the human or a rule allowed is checked again here.
fn claim_run(assistant: &mut PersonalAssistant, tools: &WorkerTools, task_id: &str, local: &str, at: u64) -> Option<Claimed> {
    let task = assistant.tasks.iter().find(|t| t.id == task_id && t.status == TaskStatus::Queued).cloned()?;
    if task.kind == TaskKind::Helper {
        let Some(profile) = assistant.profile.clone() else { return fail(assistant, task_id, "This assistant has no model profile.", at) };
        if let Some(why) = endpoint_refusal(assistant, &profile) { return fail(assistant, task_id, &why, at); }
        let host = endpoint(&profile);
        let unknown = assistant.costs.iter().rev().find(|c| c.endpoint == host).map_or(matches!(profile.backend, apex_core::Backend::OpenAiCompatible { .. }), |c| c.source == CostSource::Unknown);
        let blocked = match assistant.budget.daily_limit_micros {
            Some(limit) if assistant.spent_today(at) >= limit => Some("Over today's spending limit. Raise it in Settings or stop this helper."),
            Some(_) if unknown && !assistant.budget.unknown_cost_ok => Some("Its model doesn't report cost, so it can't keep to your daily limit. Allow unknown cost in Settings or stop this helper."),
            _ => None,
        };
        if let Some(why) = blocked {
            let task = assistant.task_mut(task_id)?;
            task.status = TaskStatus::Blocked;
            task.last_update = Some(why.into());
            task.updated_at = at;
            return None;
        }
        let task = assistant.task_mut(task_id)?;
        let op_id = next_op_id(task);
        task.receipts.push(attempt(op_id, String::new(), at, false));
        task.status = TaskStatus::Running;
        task.updated_at = at;
        task.last_update = Some("Thinking it through.".into());
        return Some(Claimed::Helper(profile, task.assignment.clone().unwrap_or_default()));
    }
    let host_id = assistant.host_id.clone();
    let folders: Vec<String> = assistant.allowed_folders.clone();
    let (Some(operation), Some(decision)) = (task.operation.clone(), task.decision.clone()) else {
        return fail(assistant, task_id, "The task has no approved operation.", at);
    };
    let Some(idempotent) = (tools.tool)(&operation) else {
        return fail(assistant, task_id, &format!("{} isn't a tool this machine knows.", operation.tool), at);
    };
    if operation.host != local {
        if operation.host != host_id && assistant.machines.iter().any(|m| m.host_id == operation.host) {
            // Its machine runs it when it connects; nothing fails over to here.
            let name = machine_name(assistant, &operation.host);
            let task = assistant.task_mut(task_id)?;
            task.status = TaskStatus::Waiting;
            task.wait = Some(TaskWait::Machine { host_id: operation.host.clone() });
            task.last_update = Some(format!("Waiting for {name} to connect."));
            task.updated_at = at;
            return None;
        }
        return fail(assistant, task_id, "This operation belongs to a different machine, so it won't run here.", at);
    }
    // On another machine, only the folder linked for it.
    let folders: Vec<String> = if operation.host == host_id { folders } else { assistant.machines.iter().filter(|m| m.host_id == operation.host).map(|m| m.folder.clone()).collect() };
    if operation.tool == COMMAND_TOOL && !folders.iter().any(|f| *f == operation.cwd) {
        return fail(assistant, task_id, "The operation's folder isn't one the assistant may use.", at);
    }
    let hash = operation.hash();
    if decision.status != DecisionStatus::Approved || decision.params_hash != hash {
        // Approval is for one exact operation. Anything else asks again.
        reask(assistant, task_id, &operation, "The command changed since you approved it.", at);
        return None;
    }
    // What let it through must still hold now.
    let by = decision.decided_by_event.clone().unwrap_or_default();
    match gateway::gate(assistant, &task, None) {
        gateway::Gate::Refuse(why) => return fail(assistant, task_id, why, at),
        gateway::Gate::HandOff if !by.starts_with("pe-") => {
            reask(assistant, task_id, &operation, "Your rules now hand this kind of step to you.", at);
            return None;
        }
        gateway::Gate::Run(_) => {}
        _ if by.starts_with("rule:") => {
            reask(assistant, task_id, &operation, "Your rules changed since this was set to run without asking.", at);
            return None;
        }
        _ => {}
    }
    if let Some(schedule_id) = by.strip_prefix("schedule:") {
        let live = assistant.schedules.iter().any(|s| s.id == schedule_id && s.status == ScheduleStatus::Active && s.params_hash == hash);
        if !live {
            let task = assistant.task_mut(task_id)?;
            task.status = TaskStatus::Cancelled;
            task.last_update = Some("Its schedule was cancelled or changed, so it didn't run.".into());
            task.updated_at = at;
            return None;
        }
    }
    let uncertain = task.receipts.last().is_some_and(|r| r.phase == OpPhase::Uncertain);
    // A human "run it again" is an `Uncertain` decision opened after the last attempt.
    let rerun_approved = decision.kind == DecisionKind::Uncertain && task.receipts.last().is_some_and(|r| decision.opened_at >= r.started_at);
    if uncertain && !idempotent && !rerun_approved {
        let decision = open_decision(assistant, DecisionKind::Uncertain, &operation, at);
        let prompt = format!("The service restarted while `{}` was running, so I can't tell whether it happened. Running it again could do it twice. Run it again?", shown(&operation));
        let task = assistant.task_mut(task_id)?;
        task.decision = Some(PendingDecision { prompt: prompt.clone(), ..decision });
        task.status = TaskStatus::NeedsYou;
        task.updated_at = at;
        task.last_update = Some("Waiting for you: the last attempt's outcome is unknown.".into());
        let decision_id = task.decision.as_ref().map(|d| d.id.clone()).unwrap_or_default();
        assistant.post("system", "approval", prompt, Some(task_id.into()), None, at);
        notify::notify(assistant, "A command's outcome is unknown after a restart; I need your decision.".into(), Some(task_id.into()), true, format!("decision:{decision_id}"), at);
        return None;
    }
    // A repeating task counts failed attempts in a row; a one-off counts all of them.
    let repeating = operation.plan.as_ref().is_some_and(|p| p.every_ms.is_some());
    let tries = if repeating {
        task.receipts.iter().rev().take_while(|r| matches!(r.phase, OpPhase::Failed | OpPhase::Uncertain) && r.exit_code.is_none()).count()
    } else {
        task.receipts.len()
    };
    if tries as u32 >= task.max_attempts {
        return fail(assistant, task_id, "The task used up its attempts.", at);
    }
    let task = assistant.task_mut(task_id)?;
    let op_id = next_op_id(task);
    task.receipts.push(attempt(op_id.clone(), hash, at, uncertain));
    task.status = TaskStatus::Running;
    task.wait = None;
    task.updated_at = at;
    task.last_update = Some(format!("Running `{}`.", shown(&operation)));
    Some(Claimed::Operation(op_id, operation))
}

/// Op ids keep counting even after old receipts are pruned.
fn next_op_id(task: &PersonalTask) -> String {
    let last = task.receipts.iter().filter_map(|r| r.op_id.rsplit("-op-").next()?.parse::<u64>().ok()).max().unwrap_or(0);
    format!("{}-op-{}", task.id, last.max(task.receipts.len() as u64) + 1)
}

fn attempt(op_id: String, params_hash: String, at: u64, rerun: bool) -> OperationReceipt {
    OperationReceipt {
        op_id, params_hash, phase: OpPhase::Attempted, started_at: at, finished_at: None, exit_code: None,
        output_excerpt: String::new(), output_hash: None, rerun_after_restart: rerun, note: None, process: None,
    }
}

/// Open a fresh approval for a task whose old one no longer covers it.
fn reask(assistant: &mut PersonalAssistant, task_id: &str, operation: &OperationSpec, why: &str, at: u64) {
    let decision = open_decision(assistant, DecisionKind::Approve, operation, at);
    let line = format!("{why} {}", approval_line(assistant, &decision, operation));
    let decision_id = decision.id.clone();
    let Some(task) = assistant.task_mut(task_id) else { return };
    if let Some(old) = task.decision.as_mut() { old.status = DecisionStatus::Superseded; }
    task.decision = Some(decision);
    task.status = TaskStatus::NeedsYou;
    task.wait = None;
    task.updated_at = at;
    task.last_update = Some("Waiting for your approval.".into());
    assistant.post("system", "approval", line, Some(task_id.into()), None, at);
    notify::notify(assistant, format!("Approval needed: {}", shown(operation)), Some(task_id.into()), true, format!("decision:{decision_id}"), at);
}

/// Save what an operation did and decide what happens to its task next.
fn finish_run(assistant: &mut PersonalAssistant, task_id: &str, op_id: &str, operation: &OperationSpec, result: Option<Result<ToolRun, String>>, at: u64) {
    let later = assistant.task_mut(task_id).is_some_and(|t| t.schedule_id.is_some() || t.created_at + 5 * 60_000 < at);
    let Some(task) = assistant.task_mut(task_id) else { return };
    let previous = task.receipts.iter().rev().filter(|r| r.op_id != op_id && r.phase == OpPhase::Verified).find_map(|r| r.output_hash.clone());
    let Some(receipt) = task.receipts.iter_mut().find(|r| r.op_id == op_id && r.phase == OpPhase::Attempted) else { return };
    receipt.finished_at = Some(at);
    let cancelled = task.status == TaskStatus::Cancelled;
    let plan = operation.plan.clone().unwrap_or_default();
    let repeating = plan.every_ms.is_some();
    let what = shown(operation);
    let mut notice: Option<(String, bool, String)> = None;
    let line: Option<String> = match &result {
        None => {
            receipt.phase = OpPhase::Failed;
            receipt.note = Some("Stopped because the task was cancelled.".into());
            task.status = TaskStatus::Cancelled;
            Some(format!("`{what}` was stopped because you cancelled the task."))
        }
        Some(Ok(run)) => {
            receipt.exit_code = Some(run.exit_code);
            receipt.output_excerpt = excerpt(&run.output);
            let hash = output_hash(&run.output);
            receipt.output_hash = Some(hash.clone());
            receipt.phase = if run.exit_code == 0 || repeating { OpPhase::Verified } else { OpPhase::Failed };
            let rerun = if receipt.rerun_after_restart { " It ran again after a restart left the first run unfinished." } else { "" };
            let body = format!("`{what}` exited with {}.{rerun}\n```\n{}\n```", run.exit_code, receipt.output_excerpt.trim_end());
            if repeating {
                task.runs_done += 1;
                let runs = task.runs_done;
                let max = plan.max_runs.unwrap_or(DEFAULT_REPEAT_RUNS);
                let met = plan.until.as_ref().is_some_and(|until| until.met(run.exit_code, &run.output));
                let changed = previous.as_deref() != Some(hash.as_str());
                if cancelled {
                    Some(body)
                } else if met {
                    task.status = TaskStatus::Done;
                    task.last_update = Some(format!("Stopped after {runs} check{}: the condition was met.", if runs == 1 { "" } else { "s" }));
                    notice = Some((format!("Condition met: {}", task.goal), true, format!("met:{task_id}")));
                    Some(format!("{body}\nThe condition was met after {runs} check{}, so I've stopped checking.", if runs == 1 { "" } else { "s" }))
                } else if runs >= max {
                    task.status = TaskStatus::Done;
                    task.last_update = Some(format!("Stopped after {runs} checks without the condition being met."));
                    notice = Some((format!("Finished checking: {}", task.goal), false, format!("last:{task_id}")));
                    Some(format!("{body}\nThat was the last of {runs} checks{}.", if plan.until.is_some() { " and the condition never held" } else { "" }))
                } else {
                    let next = at + plan.every_ms.unwrap_or(60_000);
                    task.status = TaskStatus::Waiting;
                    task.wait = Some(TaskWait::Timer { at: next });
                    task.last_update = Some(format!("Check {runs} done{}; next one in {} min.", if changed { "" } else { ", nothing changed" }, plan.every_ms.unwrap_or(60_000) / 60_000));
                    // Unchanged results stay quiet; a change is worth a line.
                    if changed && runs > 1 {
                        notice = Some((format!("Something changed: {}", task.goal), false, format!("result:{task_id}:{hash}")));
                    }
                    (runs == 1 || changed).then_some(body)
                }
            } else {
                if !cancelled {
                    task.status = if run.exit_code == 0 { TaskStatus::Done } else { TaskStatus::Failed };
                    task.last_update = Some(if run.exit_code == 0 { "Done.".into() } else { "Failed.".into() });
                    if later {
                        notice = Some((format!("{}: {}", if run.exit_code == 0 { "Done" } else { "Failed" }, task.goal), run.exit_code != 0, format!("result:{task_id}:{hash}")));
                    }
                }
                Some(body)
            }
        }
        Some(Err(error)) => {
            receipt.phase = OpPhase::Failed;
            receipt.note = Some(error.clone());
            if repeating && !cancelled {
                let failures = task.receipts.iter().rev().take_while(|r| r.phase == OpPhase::Failed && r.exit_code.is_none()).count() as u32;
                if failures < task.max_attempts {
                    let next = at + plan.every_ms.unwrap_or(60_000);
                    task.status = TaskStatus::Waiting;
                    task.wait = Some(TaskWait::Timer { at: next });
                    task.last_update = Some(format!("That check failed ({error}); trying again at the next one."));
                    None
                } else {
                    task.status = TaskStatus::Failed;
                    task.last_update = Some("Failed too many times in a row.".into());
                    notice = Some((format!("Stopped: {}", task.goal), true, format!("failed:{task_id}")));
                    Some(format!("`{what}` failed {failures} times in a row, so I've stopped: {error}"))
                }
            } else {
                if !cancelled {
                    task.status = TaskStatus::Failed;
                    task.last_update = Some("Failed.".into());
                    if later { notice = Some((format!("Failed: {}", task.goal), true, format!("failed:{task_id}"))); }
                }
                Some(format!("`{what}` didn't run: {error}"))
            }
        }
    };
    task.updated_at = at;
    if let Some(line) = line {
        assistant.post("assistant", "result", line, Some(task_id.into()), None, at);
    }
    if let Some((text, urgent, fingerprint)) = notice {
        notify::notify(assistant, text, Some(task_id.into()), urgent, fingerprint, at);
    }
}

/// Where a just-approved task goes: waiting for another task, a machine or
/// a time, or straight to the queue.
fn place(assistant: &PersonalAssistant, task: &PersonalTask, local: &str, at: u64) -> (TaskStatus, Option<TaskWait>, String) {
    let plan = task.operation.as_ref().and_then(|op| op.plan.clone()).unwrap_or_default();
    if let Some(after) = &plan.after {
        match assistant.tasks.iter().find(|t| &t.id == after).map(|t| t.status) {
            Some(TaskStatus::Done) => {}
            Some(TaskStatus::Failed | TaskStatus::Cancelled) => return (TaskStatus::Blocked, None, format!("Blocked: {after}, which this waits for, didn't finish.")),
            None => return (TaskStatus::Blocked, None, format!("Blocked: there's no task {after} to wait for.")),
            Some(_) => return (TaskStatus::Waiting, Some(TaskWait::Dependency { task_id: after.clone() }), format!("Waiting for {after} to finish.")),
        }
    }
    if let Some(op) = &task.operation {
        if op.host != local && op.host != assistant.host_id && assistant.machines.iter().any(|m| m.host_id == op.host) {
            return (TaskStatus::Waiting, Some(TaskWait::Machine { host_id: op.host.clone() }), format!("Waiting for {} to connect.", machine_name(assistant, &op.host)));
        }
    }
    if let Some(start) = plan.start_at.filter(|start| *start > at) {
        return (TaskStatus::Waiting, Some(TaskWait::Timer { at: start }), format!("Starts at {}.", local_time(assistant, start)));
    }
    (TaskStatus::Queued, None, if assistant.paused { "Approved; starts when you resume.".into() } else { "Approved; starting.".into() })
}

fn local_time(assistant: &PersonalAssistant, at: u64) -> String {
    local(assistant, at)
}

fn set_place(assistant: &mut PersonalAssistant, task_id: &str, local_id: &str, at: u64) {
    let Some(task) = assistant.tasks.iter().find(|t| t.id == task_id).cloned() else { return };
    let (status, wait, update) = place(assistant, &task, local_id, at);
    if let Some(task) = assistant.task_mut(task_id) {
        task.status = status;
        task.wait = wait;
        task.last_update = Some(update);
        task.updated_at = at;
    }
}

/// The next time a schedule fires after `at`.
fn next_fire(assistant: &PersonalAssistant, schedule: &Schedule, at: u64) -> Option<u64> {
    if let Some(every) = schedule.every_ms {
        let base = schedule.next_at.unwrap_or(at);
        let mut next = base.max(at.saturating_sub(every)) + every;
        while next <= at { next += every; }
        return Some(next);
    }
    let (h, m) = schedule.daily_at.as_deref()?.split_once(':')?;
    let minutes = u64::from(h.trim().parse::<u32>().ok()?) * 60 + u64::from(m.trim().parse::<u32>().ok()?);
    let mut next = assistant.local_day_start(at) + minutes * 60_000;
    while next <= at { next += 86_400_000; }
    Some(next)
}

/// The clock's work for one assistant, in code with no model call.
fn tick_assistant(assistant: &mut PersonalAssistant, local_id: &str, at: u64) -> (Option<u64>, Vec<crate::personal::Notice>) {
    assistant.prune_tasks();
    // Schedules: each firing makes one task the human's confirmation covers.
    for index in 0..assistant.schedules.len() {
        let schedule = assistant.schedules[index].clone();
        if schedule.status != ScheduleStatus::Active || schedule.next_at.is_none_or(|next| next > at) { continue; }
        let next = next_fire(assistant, &schedule, at);
        assistant.schedules[index].next_at = next;
        // The last run is still going: skip this one rather than pile up.
        let busy = schedule.last_task_id.as_ref().is_some_and(|id| assistant.tasks.iter().any(|t| &t.id == id && !t.status.settled()));
        if busy { continue; }
        let Some(folder) = assistant.allowed_folders.first().cloned() else { continue };
        let operation = OperationSpec { tool: COMMAND_TOOL.into(), host: assistant.host_id.clone(), cwd: folder, argv: schedule.argv.clone(), plan: None };
        if operation.hash() != schedule.params_hash { continue; }
        let task_id = assistant.next_task_id();
        let decision_id = assistant.next_decision_id();
        assistant.tasks.push(PersonalTask {
            id: task_id.clone(), goal: schedule.goal.clone(), completion_criteria: vec![], target_host: assistant.host_id.clone(),
            status: TaskStatus::Queued, class: gateway::classify(&operation, &assistant.allowed_folders).0, operation: Some(operation.clone()),
            decision: Some(PendingDecision {
                id: decision_id, kind: DecisionKind::Approve, params_hash: schedule.params_hash.clone(),
                prompt: format!("Scheduled: {}", shown(&operation)), status: DecisionStatus::Approved, opened_at: at,
                decided_at: Some(at), decided_by_event: Some(format!("schedule:{}", schedule.id)),
            }),
            receipts: vec![], from_event: format!("schedule:{}", schedule.id), max_attempts: MAX_TASK_ATTEMPTS,
            created_at: at, updated_at: at, last_update: Some("Started by its schedule.".into()), kind: TaskKind::Command,
            wait: None, runs_done: 0, parent: None, schedule_id: Some(schedule.id.clone()), assignment: None,
        });
        let entry = &mut assistant.schedules[index];
        entry.runs += 1;
        entry.last_task_id = Some(task_id);
    }

    // Tasks: timers, dependencies and deadlines.
    let ids: Vec<String> = assistant.tasks.iter().filter(|t| !t.status.settled()).map(|t| t.id.clone()).collect();
    for id in ids {
        let Some(task) = assistant.tasks.iter().find(|t| t.id == id).cloned() else { continue };
        let deadline = task.operation.as_ref().and_then(|op| op.plan.as_ref()).and_then(|p| p.deadline_at);
        if let Some(deadline) = deadline {
            if deadline <= at && task.status != TaskStatus::Running {
                if let Some(task) = assistant.task_mut(&id) {
                    task.status = TaskStatus::Failed;
                    task.wait = None;
                    task.last_update = Some("Its deadline passed before it finished.".into());
                    task.updated_at = at;
                    if let Some(decision) = task.decision.as_mut().filter(|d| d.status == DecisionStatus::Open) { decision.status = DecisionStatus::Superseded; }
                }
                assistant.post("system", "update", format!("{} missed its deadline, so I stopped it.", task.goal), Some(id.clone()), None, at);
                notify::notify(assistant, format!("Deadline passed: {}", task.goal), Some(id.clone()), true, format!("deadline:{id}"), at);
                continue;
            }
            if deadline <= at + AT_RISK_MS {
                notify::notify(assistant, format!("Due at {} and not done yet: {}", local(assistant, deadline), task.goal), Some(id.clone()), true, format!("at-risk:{id}"), at);
            }
        }
        match (&task.status, &task.wait) {
            (TaskStatus::Waiting, Some(TaskWait::Timer { at: due })) if *due <= at => {
                if let Some(task) = assistant.task_mut(&id) {
                    task.status = TaskStatus::Queued;
                    task.wait = None;
                    task.updated_at = at;
                }
            }
            (TaskStatus::Waiting, Some(TaskWait::Dependency { task_id })) => {
                let status = assistant.tasks.iter().find(|t| &t.id == task_id).map(|t| t.status);
                if matches!(status, Some(TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled) | None) {
                    set_place(assistant, &id, local_id, at);
                    if assistant.tasks.iter().any(|t| t.id == id && t.status == TaskStatus::Blocked) {
                        notify::notify(assistant, format!("Blocked: {}", task.goal), Some(id.clone()), true, format!("blocked:{id}"), at);
                    }
                }
            }
            _ => {}
        }
    }

    machine::expire_remote(assistant, local_id, at);
    let pushes = notify::deliver_due(assistant, at);

    let timers = assistant.tasks.iter().filter_map(|t| match (&t.status, &t.wait) { (TaskStatus::Waiting, Some(TaskWait::Timer { at })) => Some(*at), _ => None });
    let deadlines = assistant.tasks.iter().filter(|t| !t.status.settled())
        .filter_map(|t| t.operation.as_ref()?.plan.as_ref()?.deadline_at)
        .flat_map(|d| [d.saturating_sub(AT_RISK_MS), d]).filter(|d| *d > at);
    let schedules = assistant.schedules.iter().filter(|s| s.status == ScheduleStatus::Active).filter_map(|s| s.next_at);
    let next = timers.chain(deadlines).chain(schedules).chain(notify::next_due(assistant)).min();
    (next, pushes)
}

/// A proposed task goes through the gateway: it runs, asks or is handed over.
fn propose_task(assistant: &mut PersonalAssistant, tools: &WorkerTools, local: &str, event_id: &str, asked: &str, proposed: ProposedTask, at: u64) {
    let tool = proposed.tool.clone().unwrap_or_else(|| COMMAND_TOOL.to_owned());
    let machine = proposed.machine.as_deref().map(str::trim).filter(|m| !m.is_empty() && !["server", "this", "here", "vps"].contains(&m.to_lowercase().as_str()));
    let place_on = match machine {
        None => Ok((assistant.host_id.clone(), assistant.allowed_folders.first().cloned())),
        Some(name) => assistant.machines.iter().find(|m| m.name.eq_ignore_ascii_case(name) || m.host_id == name)
            .map(|m| (m.host_id.clone(), Some(m.folder.clone())))
            .ok_or_else(|| format!("there's no machine called \"{name}\" linked to the assistant")),
    };
    let probe = OperationSpec { tool: tool.clone(), host: String::new(), cwd: String::new(), argv: proposed.argv.clone(), plan: None };
    let problem = if (tools.tool)(&probe).is_none() {
        Some(format!("{tool} isn't something this machine can run for the assistant"))
    } else if let Err(why) = valid_argv(&proposed.argv) {
        Some(why)
    } else {
        match &place_on { Err(why) => Some(why.clone()), Ok((_, None)) => Some("the assistant has no folder on that machine".to_owned()), Ok(_) => None }
    };
    if let Some(problem) = problem {
        assistant.post("system", "update", format!("No task was made: {problem}."), None, Some(event_id.to_owned()), at);
        return;
    }
    let (host, cwd) = place_on.map(|(h, c)| (h, c.unwrap_or_default())).unwrap_or_default();
    let operation = OperationSpec { tool, host, cwd, argv: proposed.argv.clone(), plan: plan_from(&proposed, at) };
    let task_id = assistant.next_task_id();
    let goal = proposed.goal.trim().chars().take(300).collect::<String>();
    let mut task = PersonalTask {
        id: task_id.clone(),
        goal: if goal.is_empty() { shown(&operation) } else { goal },
        completion_criteria: proposed.criteria.into_iter().take(8).map(|c| c.chars().take(300).collect()).collect(),
        target_host: operation.host.clone(),
        status: TaskStatus::NeedsYou,
        class: gateway::classify(&operation, &assistant.allowed_folders).0,
        operation: Some(operation.clone()),
        decision: None,
        receipts: vec![],
        from_event: event_id.to_owned(),
        max_attempts: MAX_TASK_ATTEMPTS,
        created_at: at,
        updated_at: at,
        last_update: None,
        kind: TaskKind::Command,
        wait: None, runs_done: 0, parent: None, schedule_id: None, assignment: None,
    };
    let gate = gateway::gate(assistant, &task, Some(asked));
    let class_word = match task.class { ToolClass::Read => "reading", ToolClass::Write => "changing things", ToolClass::Send => "sending", ToolClass::Spend => "spending" };
    let plan = operation.plan.as_ref().map(|p| describe_plan(assistant, p)).filter(|p| !p.is_empty()).map(|p| format!(" ({p})")).unwrap_or_default();
    match gate {
        gateway::Gate::Refuse(why) => {
            assistant.post("system", "update", format!("No task was made: {why}"), None, Some(event_id.to_owned()), at);
        }
        gateway::Gate::Run(mode) => {
            let mut decision = open_decision(assistant, DecisionKind::Approve, &operation, at);
            decision.status = DecisionStatus::Approved;
            decision.decided_at = Some(at);
            decision.decided_by_event = Some(gateway::rule_marker(mode));
            task.decision = Some(decision);
            assistant.tasks.push(task);
            set_place(assistant, &task_id, local, at);
            let why = if mode == ActionMode::OnRequest { "you asked for it" } else { "your rules let it run without asking" };
            assistant.post("system", "update", format!("Running `{}`{plan} without asking: it's {class_word}, and {why}.", shown(&operation)), Some(task_id), Some(event_id.to_owned()), at);
        }
        gateway::Gate::Ask => {
            let decision = open_decision(assistant, DecisionKind::Approve, &operation, at);
            let line = approval_line(assistant, &decision, &operation);
            task.decision = Some(decision);
            task.last_update = Some("Waiting for your approval.".into());
            assistant.tasks.push(task);
            assistant.post("system", "approval", line, Some(task_id), Some(event_id.to_owned()), at);
        }
        gateway::Gate::HandOff => {
            let mut decision = open_decision(assistant, DecisionKind::HandOff, &operation, at);
            decision.prompt = format!("Your turn: run `{}` in {} on {} yourself{plan}, then tell me it's done.", shown(&operation), operation.cwd, machine_name(assistant, &operation.host));
            let line = decision.prompt.clone();
            task.decision = Some(decision);
            task.last_update = Some("Handed to you.".into());
            assistant.tasks.push(task);
            assistant.post("system", "approval", line, Some(task_id), Some(event_id.to_owned()), at);
        }
    }
}

fn propose_schedule(assistant: &mut PersonalAssistant, event_id: &str, proposed: ProposedSchedule, at: u64) {
    let every_ms = proposed.every_minutes.and_then(|m| minutes_ms(m, 30 * 86_400_000));
    let daily_at = proposed.daily_at.map(|d| d.trim().to_owned()).filter(|d| {
        d.split_once(':').is_some_and(|(h, m)| h.parse::<u32>().is_ok_and(|h| h < 24) && m.parse::<u32>().is_ok_and(|m| m < 60))
    });
    let problem = if let Err(why) = valid_argv(&proposed.argv) {
        Some(why)
    } else if every_ms.is_none() && daily_at.is_none() {
        Some("a schedule needs a time of day or how often".into())
    } else if every_ms.is_some_and(|ms| ms < MIN_SCHEDULE_MS) {
        Some("a schedule can't run more often than every 5 minutes; ask for a repeating task instead".into())
    } else if assistant.allowed_folders.is_empty() {
        Some("the assistant has no folder on this machine".into())
    } else {
        None
    };
    if let Some(problem) = problem {
        assistant.post("system", "update", format!("No schedule was made: {problem}."), None, Some(event_id.to_owned()), at);
        return;
    }
    let operation = OperationSpec { tool: COMMAND_TOOL.into(), host: assistant.host_id.clone(), cwd: assistant.allowed_folders[0].clone(), argv: proposed.argv.clone(), plan: None };
    let when = match (&daily_at, every_ms) { (Some(d), _) => format!("every day at {d}"), (_, Some(ms)) => format!("every {} min", ms / 60_000), _ => String::new() };
    let id = assistant.next_schedule_id();
    let mut decision = open_decision(assistant, DecisionKind::Schedule, &operation, at);
    decision.prompt = format!("Run `{}` {when}? Each run counts as approved once you confirm. Cancel the schedule any time.", shown(&operation));
    let line = format!("Confirm schedule: {}", decision.prompt);
    let goal = proposed.goal.trim().chars().take(300).collect::<String>();
    assistant.schedules.push(Schedule {
        id, goal: if goal.is_empty() { shown(&operation) } else { goal }, argv: proposed.argv, every_ms, daily_at,
        next_at: None, status: ScheduleStatus::Proposed, created_at: at, params_hash: operation.hash(),
        last_task_id: None, runs: 0, decision: Some(decision),
    });
    assistant.post("system", "approval", line, None, Some(event_id.to_owned()), at);
}

/// Save, correct and forget facts the model proposed in answer to the human.
fn apply_memory(assistant: &mut PersonalAssistant, remember: &[ProposedFact], forget: &[String], event_id: &str, at: u64) {
    let mut said = Vec::new();
    for id in forget.iter().take(20) {
        if let Some(fact) = assistant.facts.iter_mut().find(|f| &f.id == id && f.deleted_at.is_none()) {
            fact.deleted_at = Some(at);
            // Forgetting removes the words, not just the flag.
            fact.text.clear();
            said.push("forgot one thing".to_owned());
        }
    }
    let message_id = assistant.messages.iter().rev().find(|m| m.event_id.as_deref() == Some(event_id) && m.role == "human").map(|m| m.id.clone());
    for proposed in remember.iter().take(10) {
        let text = proposed.text.trim().chars().take(500).collect::<String>();
        if text.is_empty() || assistant.facts.iter().any(|f| f.current(at) && f.text.eq_ignore_ascii_case(&text)) { continue; }
        let kind = match proposed.kind.as_deref() { Some("preference") => FactKind::Preference, Some("decision") => FactKind::Decision, Some("commitment") => FactKind::Commitment, _ => FactKind::Fact };
        let mut confidence = proposed.confidence.unwrap_or(if proposed.explicit { 95 } else { 60 }).min(100);
        let mut expires_at = proposed.expires_in_days.and_then(|d| (d.is_finite() && d > 0.0).then(|| at + ((d.min(3_650.0)) * 86_400_000.0) as u64));
        // A one-time choice fades; an inferred preference stays tentative.
        if kind == FactKind::Decision { expires_at.get_or_insert(at + 30 * 86_400_000); }
        if kind == FactKind::Preference && !proposed.explicit {
            confidence = confidence.min(70);
            expires_at.get_or_insert(at + 90 * 86_400_000);
        }
        let id = assistant.next_fact_id();
        let replaced = proposed.replaces.as_ref().and_then(|old| assistant.facts.iter_mut().find(|f| &f.id == old && f.current(at)));
        let corrected = replaced.map(|old| { old.superseded_by = Some(id.clone()); old.text.clone() });
        assistant.facts.push(Fact {
            id, text: text.clone(), kind, explicit: proposed.explicit, confidence,
            source: FactSource { message_id: message_id.clone(), task_id: None }, created_at: at, expires_at,
            superseded_by: None, deleted_at: None,
        });
        said.push(match corrected { Some(old) => format!("updated “{old}” to “{text}”"), None => format!("“{text}”") });
    }
    if assistant.facts.len() > MAX_FACTS {
        // Drop forgotten and replaced ones first, then the oldest.
        let extra = assistant.facts.len() - MAX_FACTS;
        let mut gone: Vec<usize> = assistant.facts.iter().enumerate().filter(|(_, f)| !f.current(at)).map(|(i, _)| i).take(extra).collect();
        if gone.len() < extra {
            let more: Vec<usize> = (0..assistant.facts.len()).filter(|i| !gone.contains(i)).take(extra - gone.len()).collect();
            gone.extend(more);
        }
        gone.sort_unstable();
        for i in gone.into_iter().rev() { assistant.facts.remove(i); }
    }
    if !said.is_empty() {
        assistant.post("system", "update", format!("Memory: {}.", said.join("; ")), None, Some(event_id.to_owned()), at);
    }
}

fn open_decision(assistant: &mut PersonalAssistant, kind: DecisionKind, operation: &OperationSpec, at: u64) -> PendingDecision {
    PendingDecision {
        id: assistant.next_decision_id(),
        kind,
        params_hash: operation.hash(),
        prompt: if operation.tool == COMMAND_TOOL {
            format!("Run `{}` in {} on {}?", shown(operation), operation.cwd, machine_name(assistant, &operation.host))
        } else {
            format!("Use `{}`?", shown(operation))
        },
        status: DecisionStatus::Open,
        opened_at: at,
        decided_at: None,
        decided_by_event: None,
    }
}

fn approval_line(assistant: &PersonalAssistant, decision: &PendingDecision, operation: &OperationSpec) -> String {
    let plan = operation.plan.as_ref().map(|p| describe_plan(assistant, p)).filter(|p| !p.is_empty()).map(|p| format!(" Plan: {p}.")).unwrap_or_default();
    format!("Approval needed: {}{plan}", decision.prompt)
}

/// Hold a reply until the human OKs its cost.
fn hold_for_spend(assistant: &mut PersonalAssistant, event_id: &str, prompt: String, at: u64) {
    let Some(event) = assistant.events.iter_mut().find(|e| e.id == event_id && e.state == EventState::Processing) else { return };
    event.state = EventState::Held;
    let operation = OperationSpec { tool: REPLY_TOOL.into(), host: assistant.host_id.clone(), cwd: String::new(), argv: vec![event_id.to_owned()], plan: None };
    let task_id = assistant.next_task_id();
    let mut decision = open_decision(assistant, DecisionKind::Spend, &operation, at);
    decision.prompt = prompt.clone();
    assistant.tasks.push(PersonalTask {
        id: task_id.clone(), goal: "Reply to your message".into(), completion_criteria: vec![], target_host: assistant.host_id.clone(),
        status: TaskStatus::NeedsYou, class: ToolClass::Spend, operation: Some(operation), decision: Some(decision), receipts: vec![],
        from_event: event_id.to_owned(), max_attempts: 1, created_at: at, updated_at: at, last_update: Some("Waiting for your OK to spend.".into()),
        kind: TaskKind::Command, wait: None, runs_done: 0, parent: None, schedule_id: None, assignment: None,
    });
    assistant.post("system", "approval", prompt, Some(task_id), Some(event_id.to_owned()), at);
}

/// Mark a task failed before it ran. Always `None`: there's nothing to run.
fn fail<T>(assistant: &mut PersonalAssistant, task_id: &str, why: &str, at: u64) -> Option<T> {
    if let Some(task) = assistant.task_mut(task_id) {
        task.status = TaskStatus::Failed;
        task.wait = None;
        task.updated_at = at;
        task.last_update = Some(why.into());
    }
    assistant.post("system", "update", why.into(), Some(task_id.into()), None, at);
    None
}

/// Every task that can't go on once `root` is cancelled: those waiting for
/// it and its helpers, and theirs in turn.
fn cascade(assistant: &PersonalAssistant, root: &str) -> Vec<String> {
    let mut out = vec![root.to_owned()];
    let mut i = 0;
    while i < out.len() {
        let id = out[i].clone();
        for task in &assistant.tasks {
            let after = task.operation.as_ref().and_then(|op| op.plan.as_ref()).and_then(|p| p.after.as_deref()) == Some(id.as_str());
            if (after || task.parent.as_deref() == Some(id.as_str())) && !out.contains(&task.id) {
                out.push(task.id.clone());
            }
        }
        i += 1;
    }
    out
}

/// Decisions and cancellations, in code, with no model call. Returns the
/// running tasks whose operations must now be stopped.
fn apply_control(assistant: &mut PersonalAssistant, event: &PersonalEvent) -> Vec<String> {
    let at = now();
    let local = assistant.host_id.clone();
    let mut stop = Vec::new();
    let outcome: Result<Option<(Option<String>, String)>, String> = match &event.source {
        EventSource::Human { .. } | EventSource::Pause { .. } | EventSource::Internal { .. } => Ok(None),
        EventSource::Decision { decision_id, params_hash, approve } => decide(assistant, decision_id, params_hash, *approve, &event.id, &local, at),
        EventSource::Cancel { task_id } => (|| {
            let task = assistant.tasks.iter().find(|t| &t.id == task_id).ok_or("That task doesn't exist.")?;
            if task.status.settled() {
                return Err("That task already finished.".to_string());
            }
            let running = task.status == TaskStatus::Running;
            let ids = cascade(assistant, task_id);
            let mut others = 0;
            for id in &ids {
                let Some(task) = assistant.task_mut(id) else { continue };
                if task.status.settled() { continue; }
                if task.status == TaskStatus::Running { stop.push(id.clone()); }
                task.status = TaskStatus::Cancelled;
                task.wait = None;
                task.updated_at = at;
                task.last_update = Some(if id == task_id { "Cancelled.".into() } else { format!("Cancelled with {task_id}.") });
                if let Some(decision) = task.decision.as_mut().filter(|d| d.status == DecisionStatus::Open) {
                    decision.status = DecisionStatus::Superseded;
                }
                // A held reply's cost card was cancelled: that reply won't come.
                let held = task.operation.as_ref().filter(|op| op.tool == REPLY_TOOL).and_then(|op| op.argv.first().cloned());
                if let Some(event) = held.and_then(|id| assistant.events.iter_mut().find(|e| e.id == id && e.state == EventState::Held)) {
                    event.state = EventState::Failed;
                    event.error = Some("Cancelled.".into());
                }
                if id != task_id { others += 1; }
            }
            let mut line = if running { "Cancelled. Stopping the command.".to_owned() } else { "Cancelled before anything ran.".to_owned() };
            if others > 0 { line.push_str(&format!(" Also stopped {others} step{} that depended on it.", if others == 1 { "" } else { "s" })); }
            Ok(Some((Some(task_id.clone()), line)))
        })(),
        EventSource::CancelSchedule { schedule_id } => (|| {
            let schedule = assistant.schedules.iter_mut().find(|s| &s.id == schedule_id).ok_or("That schedule doesn't exist.")?;
            if schedule.status == ScheduleStatus::Cancelled {
                return Err("That schedule was already cancelled.".to_string());
            }
            schedule.status = ScheduleStatus::Cancelled;
            schedule.next_at = None;
            if let Some(decision) = schedule.decision.as_mut().filter(|d| d.status == DecisionStatus::Open) { decision.status = DecisionStatus::Superseded; }
            let running = schedule.last_task_id.as_ref().is_some_and(|id| assistant.tasks.iter().any(|t| &t.id == id && !t.status.settled()));
            let goal = assistant.schedules.iter().find(|s| &s.id == schedule_id).map(|s| s.goal.clone()).unwrap_or_default();
            let tail = if running { " Its current run keeps going; stop that task separately if you want." } else { "" };
            Ok(Some((None, format!("Cancelled the schedule “{goal}”.{tail}"))))
        })(),
    };
    let Some(saved) = assistant.events.iter_mut().find(|e| e.id == event.id && e.state == EventState::Processing) else { return stop };
    match outcome {
        Ok(line) => {
            saved.state = EventState::Done;
            if let Some((task_id, text)) = line {
                assistant.post("system", "update", text, task_id, Some(event.id.clone()), at);
            }
        }
        Err(why) => {
            saved.state = EventState::Failed;
            saved.error = Some(why.clone());
            assistant.post("system", "update", why, None, Some(event.id.clone()), at);
        }
    }
    stop
}

/// The human's answer to one decision, on a task or a schedule.
fn decide(assistant: &mut PersonalAssistant, decision_id: &str, params_hash: &str, approve: bool, event_id: &str, local: &str, at: u64) -> Result<Option<(Option<String>, String)>, String> {
    if let Some(index) = assistant.schedules.iter().position(|s| s.decision.as_ref().is_some_and(|d| d.id == decision_id)) {
        let schedule = assistant.schedules[index].clone();
        let decision = schedule.decision.clone().unwrap();
        if decision.status != DecisionStatus::Open || schedule.status != ScheduleStatus::Proposed {
            return Err("That approval isn't open any more.".into());
        }
        if decision.params_hash != params_hash || schedule.params_hash != params_hash {
            return Err("That approval was for a different command, so it wasn't used.".into());
        }
        let next = if approve { next_fire(assistant, &Schedule { next_at: None, ..schedule.clone() }, at) } else { None };
        let entry = &mut assistant.schedules[index];
        let saved = entry.decision.as_mut().unwrap();
        saved.decided_at = Some(at);
        saved.decided_by_event = Some(event_id.into());
        if approve {
            saved.status = DecisionStatus::Approved;
            entry.status = ScheduleStatus::Active;
            entry.next_at = next;
            let when = next.map(|n| format!(" First run at {}.", local_time(assistant, n))).unwrap_or_default();
            return Ok(Some((None, format!("Scheduled “{}”.{when}", schedule.goal))));
        }
        saved.status = DecisionStatus::Denied;
        entry.status = ScheduleStatus::Cancelled;
        return Ok(Some((None, "Declined, so nothing was scheduled.".into())));
    }
    let task = assistant.tasks.iter_mut()
        .find(|t| t.decision.as_ref().is_some_and(|d| d.id == decision_id))
        .ok_or("That approval isn't open any more.")?;
    let decision = task.decision.as_mut().unwrap();
    if decision.status != DecisionStatus::Open || task.status != TaskStatus::NeedsYou {
        return Err("That approval isn't open any more.".to_string());
    }
    let current = task.operation.as_ref().map(OperationSpec::hash);
    if current.as_deref() != Some(params_hash) || decision.params_hash != params_hash {
        return Err("That approval was for a different command, so it wasn't used.".to_string());
    }
    decision.decided_at = Some(at);
    decision.decided_by_event = Some(event_id.into());
    task.updated_at = at;
    let task_id = task.id.clone();
    let kind = decision.kind;
    if !approve {
        decision.status = DecisionStatus::Denied;
        task.status = TaskStatus::Cancelled;
        task.last_update = Some("You declined it.".into());
        let line = match kind {
            DecisionKind::HandOff => "Skipped.",
            DecisionKind::Spend => "OK, I won't reply to that one.",
            _ => "Declined, so nothing ran.",
        };
        if kind == DecisionKind::Spend {
            let held = task.operation.as_ref().and_then(|op| op.argv.first().cloned());
            if let Some(event) = held.and_then(|id| assistant.events.iter_mut().find(|e| e.id == id && e.state == EventState::Held)) {
                event.state = EventState::Failed;
                event.error = Some("You declined the cost.".into());
            }
        }
        return Ok(Some((Some(task_id), line.into())));
    }
    decision.status = DecisionStatus::Approved;
    match kind {
        DecisionKind::HandOff => {
            task.status = TaskStatus::Done;
            task.last_update = Some("You did it.".into());
            Ok(Some((Some(task_id), "Marked done by you.".into())))
        }
        DecisionKind::Spend => {
            task.status = TaskStatus::Done;
            task.last_update = Some("You OK'd the cost.".into());
            let held = task.operation.as_ref().and_then(|op| op.argv.first().cloned());
            if let Some(event) = held.and_then(|id| assistant.events.iter_mut().find(|e| e.id == id && e.state == EventState::Held)) {
                event.state = EventState::Received;
                event.spend_approved = true;
            }
            Ok(Some((Some(task_id), "OK, replying.".into())))
        }
        _ => {
            set_place(assistant, &task_id, local, at);
            let update = assistant.tasks.iter().find(|t| t.id == task_id).and_then(|t| t.last_update.clone()).unwrap_or_default();
            let line = if update.starts_with("Approved") {
                if assistant.paused { "Approved. I'm paused, so it starts when you resume.".to_owned() } else { "Approved.".to_owned() }
            } else {
                format!("Approved. {update}")
            };
            Ok(Some((Some(task_id), line)))
        }
    }
}

pub(crate) mod browser;
pub(crate) mod connectors;
mod context;
pub(crate) mod gateway;
pub(crate) mod machine;
pub(crate) mod notify;
mod process;
mod push;

#[cfg(test)]
mod tests;
