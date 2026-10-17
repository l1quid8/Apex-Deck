# Work-step feed probe notes (2026-10-16)

Probed: Claude Code 2.1.302 (model claude-haiku-5-5), codex-cli 0.162.1 (model gpt-6.1-sol).
Claude was launched the way Deck launches it (`-p --output-format stream-json --verbose --include-partial-messages --input-format stream-json --permission-prompt-tool stdio --permission-mode bypassPermissions`, prompt on stdin as a `{"type":"user",...}` line). Codex through `codex app-server` with the codex_server.rs handshake (initialize, initialized, thread/start `ephemeral:true`, turn/start), approvalPolicy `never`, sandbox `danger-full-access`.

## CONTRADICTIONS WITH THE PLAN (read first)

1. **Claude 2.1.302 has no `TodoWrite` in Deck's launch mode.** Not in the init tool list, and ToolSearch finds nothing. The to-do tools `TaskCreate` / `TaskUpdate` (also `TaskGet`, `TaskList`) appear ONLY when the env var `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set. Deck sets no such variable, so a stock Deck Claude bot writes no to-do list at all. The fixture was recorded with that variable so the shape is known. Shapes differ from the plan:
   - `TaskCreate` input `{subject, description, activeForm}` (one task per call, no `status`, no `todos` array). Result text `"Task #1 created successfully: <subject>"`; `tool_use_result` is `{"task":{"id":"1","subject":"..."}}`.
   - `TaskUpdate` input `{taskId:"2", status:"completed"}` (status values seen: `completed`; pending is the starting state). `tool_use_result` is `{"success":true,"taskId":"2","updatedFields":["status"],"statusChange":{"from":"pending","to":"completed"}}`.
   - So a to-do list must be rebuilt by folding TaskCreate/TaskUpdate calls, keyed by the id in the TaskCreate result (not the tool_use id). The parser should still accept `TodoWrite {todos:[{content,status,activeForm}]}` for older/other builds, but it was not observed.
2. **Claude has no `Grep` or `Glob` tool in this build** (also no TodoWrite). Searching is a plain `Bash` call (`grep -rn ...`). A call to `Grep` returns `is_error:true` "No such tool available". Reading is `Read`.
3. **Codex emits `turn/plan/updated` only when `tools.update_plan.enabled=true`** is passed (`codex -c tools.update_plan.enabled=true app-server`). Without it the model says "update_plan tool isn't available" and writes the plan as chat text (first probe: no `turn/plan/updated` at all). Deck does not set this today (`codex_server.rs` args are just `app-server`), so Deck would need to add the `-c`. Plan mode (`collaborationMode:{mode:"plan"}`) gives `item/plan/delta` plus a final item of `type:"plan"` with markdown `text` instead (see "Plan mode" below), not `turn/plan/updated`.
4. **Codex helper tasks carry no prompt/description.** The spawn shows as `item/*` `subAgentActivity` with only `agentPath` (e.g. `/root/read_b`, a model-chosen slug) and `agentThreadId`. The `collabAgentToolCall` seen was only `tool:"wait"` with `prompt:null`, `receiverThreadIds:[]`, `agentsStates:{}`; no `spawnAgent` collab item appeared. So the only label for a Codex helper is the `agentPath` slug.
5. **Background-helper link (Claude):** the `background_tasks_changed` task entries do NOT carry `tool_use_id`. The link is through `task_id`: `system/task_started` carries both `task_id` and the starting `tool_use_id`; `background_tasks_changed.tasks[].task_id` matches it. See below.

## Claude

Fixtures: `claude_turn.jsonl` (foreground helper, Bash/Read/failed Bash/TaskCreate/TaskUpdate/Agent), `claude_background.jsonl` (background helper).

### tool_use shape
`assistant` event, `message.content[]` item `{type:"tool_use", id:"toolu_...", name, input, caller:{type:"direct"}}`. Each assistant event holds one content block (thinking / text / tool_use arrive as separate `assistant` lines sharing `message.id`). Streaming shows tool_use as `stream_event` `content_block_start` with `input:{}` then `input_json_delta` pieces (trimmed in the fixture to 2 per block).
Names seen: `Bash`, `Read`, `ToolSearch`, `Agent` (Task is listed as an alias in init, but the call name is `Agent`), `TaskCreate`, `TaskUpdate`.
Agent input: `{description, prompt, subagent_type:"general-purpose", run_in_background:false|true}`.

### tool_result shapes
`user` event, `message.content[]` item `{type:"tool_result", tool_use_id, content, is_error?}`.
- `content` is a **string** for Bash, Read, TaskCreate, TaskUpdate, ToolSearch-miss, and errors. Path: `message.content[0].content`.
- `content` is an **array** in two cases: the foreground Agent result `[{type:"text",text:"[Subagent hand-back] ... report ..."}]`, and the background Agent launch result `[{type:"text",text:"Async agent launched successfully. ... agentId: ... output_file: ..."}]`; a ToolSearch hit gives `[{type:"tool_reference",tool_name:"TaskCreate"}]` (not text).
- Read results are line-numbered text (`"1\talpha\n2\t..."`).
- `is_error`: present as `false` on Bash success, **`true` on failed Bash** (content `"Exit code 1\ncat: ...: No such file or directory"`, event-level `tool_use_result` is the string `"Error: Exit code 1\n..."`). Read, Agent, TaskCreate and ToolSearch-hit results omit the key entirely, so treat missing as false. A call to an unavailable tool also sets `is_error:true`.
- Event-level `tool_use_result` carries structured data (Bash `{stdout,stderr,interrupted,...}`; Read `{type:"text",file:{filePath,content,numLines,...}}`).

### Helper (Agent tool) linkage
- Foreground: `system/task_started {task_id, run_id, tool_use_id (= the Agent tool_use id), description, subagent_type, is_backgrounded:false, task_type:"local_agent", prompt}`; then `system/task_progress` (`description`, `last_tool_name`, `usage`), then `task_updated` (`patch.status:"completed"`), `task_notification {status, summary, output_file, usage}`, then the Agent `tool_result`.
- The helper's own tool calls are normal `assistant` / `user` events with top-level `parent_tool_use_id` = the Agent tool_use id and `agent_id` = task_id. The helper's first `user` event is its prompt text.
- Background (`run_in_background:true`): the Agent tool_result returns immediately with the launch text. Then: `system/background_tasks_changed {tasks:[{task_id, run_id, task_type, subagent_type, description}]}` (**no tool_use_id**), `task_started` with `is_backgrounded:true` and `tool_use_id`, helper events (with `parent_tool_use_id`/`agent_id`), `task_updated`, `task_notification` (with `summary`, `output_file`), then `background_tasks_changed {tasks:[]}`. The Claude bot then continues with a new turn (a second `system/init` appears) once the notification arrives.

## Codex

Fixtures: `codex_turn.jsonl` (all of reads/search/list/git status/failed read/plan/helper), `codex_plan_only.jsonl` (minimal `turn/plan/updated` example).

### commandExecution
`item/started` and `item/completed` with `params.item.type:"commandExecution"`, `params.threadId`, `params.turnId`.
- `command` is the shell form `"/bin/zsh -lc 'cat /tmp/probe3/a.txt'"` (single-quoted body; inner double quotes kept, e.g. `/bin/zsh -lc 'rg "needle" /tmp/probe3'`).
- Other fields: `cwd`, `processId`, `source:"unifiedExecStartup"`, `status` (`inProgress` -> `completed` | `failed`), `pluginId:null`, `scriptPath:null`.
- `commandActions[]` variants seen (the list always has at least one element): 
  - `{type:"read", command, name, path}` (path is the full path; `cat <file>`)
  - `{type:"search", command, query, path}` (`rg`; `path` is just the folder name `probe3`, not full)
  - `{type:"listFiles", command, path}` (`ls`; `path` relative `sub`)
  - `{type:"unknown", command}` (`git status`, and a multi-file `cat a b`). Note: the `command` inside an action has quotes stripped and the `/bin/zsh -lc` wrapper removed.
- On `item/started`: `aggregatedOutput`, `exitCode`, `durationMs` are all `null`. On `item/completed`: `aggregatedOutput` (string), `exitCode` (int; failed `cat` gave `1` with `status:"failed"`), `durationMs` (int; 0 for these quick commands).

### Plan
`turn/plan/updated` params: `{threadId, turnId, explanation:null|string, plan:[{step, status}]}`; status values seen: `pending`, `inProgress`, `completed` (camelCase `inProgress`). Full plan resent on each update. Only with `tools.update_plan.enabled=true` (see contradiction 3).
Plan mode: `item/plan/delta` streams, final item `{type:"plan", id:"<turn>-plan", text:"<markdown>"}` on `item/completed`.

### Helpers
- Spawn: `item/started` + `item/completed` with `item.type:"subAgentActivity"`, `kind:"started"`, `model`, `reasoningEffort`, `agentThreadId`, `agentPath:"/root/<slug>"`, `id` = the spawn call id.
- Finish: another `subAgentActivity` with `kind:"completed"`, `model:null`, `id:"subagent-completed-<helper turn id>"`, same `agentThreadId` / `agentPath`.
- `collabAgentToolCall` appeared only for the `wait` tool: `{tool:"wait", status, senderThreadId, receiverThreadIds:[], prompt:null, model:null, reasoningEffort:null, agentsStates:{}}`. No spawn-prompt anywhere.
- The helper runs as its own thread: it gets its own `turn/started` / `turn/completed` (with `threadId` = `agentThreadId`, `rootTurnId` = the parent turn id) and its commandExecution items carry the helper's `threadId`. Callers must not treat the helper's `turn/completed` as the end of the main turn: compare `threadId` to the main thread.

## Trimming / scrubbing
- `/Users/<name>/` replaced by `/work/`; emails replaced by `<email>`. No tokens found. All probes ran under `/tmp` so few paths were affected.
- Claude: dropped `system` events hook_started, hook_response (they contain a dump of an installed plugin), commands_changed, ui_status (a plugin's portfolio line), ui_invalidate, thinking_tokens, status; dropped `rate_limit_event`; removed from `system/init` the tools, slash_commands, skills, plugins, agents, mcp_servers, memory_paths, messaging_socket_path, capabilities lists (marked by `_trimmed`); blanked `thinking` text and removed `signature`; kept only the first 2 `content_block_delta` lines per distinct (event type, index, delta type) — this includes tool-input `input_json_delta` pieces, so partial JSON in the stream is incomplete, use the `assistant` events for full inputs. Every tool_use, tool_result, `task_*` and `background_tasks_changed` event is intact.
- Codex: dropped mcpServer/startupStatus/updated, turn/moderationMetadata, account/*, remoteControl, configWarning, warning, hook/*, thread/tokenUsage/updated; kept the first 2 `item/agentMessage/delta` per item. Every item/*, turn/* and plan event is intact.
- Raw first-pass probes (not saved): a Claude foreground run through `-p` without stdin stream-json showed the same missing-tool behaviour.
