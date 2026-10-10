//! Running an assistant's operation on another machine (the Mac), only
//! while it's connected. The assistant's host keeps the task; the other
//! machine's app claims what's due for it, runs it through that machine's
//! own check (`personal_execute_local`) and posts the result back. If the
//! machine stays away, only its tasks wait; nothing fails over.

use serde::{Deserialize, Serialize};

use super::{claim_run, finish_run, run_command, Claimed, ToolRun, WorkerTools, COMMAND_TOOL};
use crate::personal::{now, OpPhase, OperationSpec, TaskStatus, TaskWait};
use crate::Host;

/// A claimed operation for the other machine to run.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteOp {
    pub task_id: String,
    pub op_id: String,
    pub operation: OperationSpec,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteResult {
    pub task_id: String,
    pub op_id: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A remote attempt with no result after this long is treated as unknown.
const REMOTE_STALE_MS: u64 = 15 * 60_000;

impl Host {
    /// On the assistant's host: hand `machine` what's due for it.
    pub fn personal_machine_claim(&self, assistant_id: &str, machine: &str) -> Result<Vec<RemoteOp>, String> {
        let tools = WorkerTools::real();
        self.change_assistant(assistant_id, |assistant| {
            let at = now();
            let link = assistant.machines.iter_mut().find(|m| m.host_id == machine).ok_or("That machine isn't linked to this assistant.")?;
            link.last_seen = Some(at);
            if assistant.paused { return Ok(vec![]); }
            let due: Vec<String> = assistant.tasks.iter()
                .filter(|t| t.operation.as_ref().is_some_and(|op| op.host == machine))
                .filter(|t| t.status == TaskStatus::Queued || (t.status == TaskStatus::Waiting && matches!(&t.wait, Some(TaskWait::Machine { host_id }) if host_id == machine)))
                .map(|t| t.id.clone()).collect();
            let mut out = Vec::new();
            for task_id in due {
                if let Some(task) = assistant.task_mut(&task_id) {
                    task.status = TaskStatus::Queued;
                    task.wait = None;
                }
                if let Some(Claimed::Operation(op_id, operation)) = claim_run(assistant, &tools, &task_id, machine, at) {
                    out.push(RemoteOp { task_id, op_id, operation });
                }
            }
            Ok(out)
        })
    }

    /// On the assistant's host: what the other machine's run did.
    pub fn personal_machine_result(&self, assistant_id: &str, machine: &str, result: RemoteResult) -> Result<(), String> {
        self.change_assistant(assistant_id, |assistant| {
            let task = assistant.tasks.iter().find(|t| t.id == result.task_id).ok_or("That task doesn't exist.")?;
            let operation = task.operation.clone().ok_or("That task has no operation.")?;
            if operation.host != machine { return Err("That task belongs to a different machine.".into()); }
            if !task.receipts.iter().any(|r| r.op_id == result.op_id && r.phase == OpPhase::Attempted) { return Ok(()); }
            let run = match (result.exit_code, result.error) {
                (Some(exit_code), _) => Ok(ToolRun { exit_code, output: result.output.unwrap_or_default() }),
                (None, Some(error)) => Err(error),
                (None, None) => Err("The machine sent no result.".into()),
            };
            finish_run(assistant, &result.task_id, &result.op_id, &operation, Some(run), now());
            Ok(())
        })
    }

    /// On the other machine: run one operation for a remote assistant, if
    /// the human allowed that assistant here and it's in the allowed folder.
    pub async fn personal_execute_local(&self, assistant_id: &str, assistant_host_id: &str, operation: OperationSpec) -> Result<ToolRun, String> {
        let local = self.local_host_id()?;
        if operation.host != local { return Err("That operation is for a different machine.".into()); }
        if operation.tool != COMMAND_TOOL { return Err("Only commands can run on this machine for an assistant.".into()); }
        crate::personal::valid_argv(&operation.argv)?;
        let allows = self.personal_machine_allowed()?;
        let allow = allows.allows.iter().find(|a| a.assistant_id == assistant_id && a.assistant_host_id == assistant_host_id)
            .ok_or("This Mac hasn't been set up for that assistant. Choose “Let assistant use this Mac” first.")?;
        if operation.cwd != allow.folder { return Err("That folder isn't the one you allowed the assistant to use here.".into()); }
        // This machine checks for itself: no reading private files outside the folder.
        if super::gateway::classify(&operation, std::slice::from_ref(&allow.folder)).1 {
            return Err("That reads a file outside the folder you allowed here, so this Mac refused it.".into());
        }
        run_command(operation, std::sync::Arc::new(|_| {})).await
    }
}

/// Clock work: a remote attempt that never reported back is unknown, and
/// the task waits for its machine again (which then asks before repeating
/// anything that isn't a read).
pub(super) fn expire_remote(assistant: &mut crate::personal::PersonalAssistant, local: &str, at: u64) {
    for task in assistant.tasks.iter_mut().filter(|t| t.status == TaskStatus::Running) {
        let Some(op) = &task.operation else { continue };
        if op.host == local || op.host == assistant.host_id { continue; }
        let host = op.host.clone();
        let stale = task.receipts.last().is_some_and(|r| r.phase == OpPhase::Attempted && r.started_at + REMOTE_STALE_MS < at);
        if !stale { continue; }
        if let Some(receipt) = task.receipts.last_mut() {
            receipt.phase = OpPhase::Uncertain;
            receipt.note = Some("The other machine never reported back.".into());
        }
        task.status = TaskStatus::Waiting;
        task.wait = Some(TaskWait::Machine { host_id: host });
        task.last_update = Some("The other machine went quiet mid-run; waiting for it again.".into());
        task.updated_at = at;
    }
}
