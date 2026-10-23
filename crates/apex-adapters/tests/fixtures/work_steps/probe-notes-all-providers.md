# Work-step feed probe notes: Gemini (agy), Grok, Muse (2026-10-17)

Companion to `probe-notes.md` (Claude, Codex). Same task prompt for every tool, run in `/tmp/probe-all` (a.txt with 3 lines, `sub/b.txt`), cheapest model, full-access mode:

> Read a.txt. Run `ls sub`. Run `cat missing.txt` (it will fail). Search this folder for the word alpha. Append the line 'probe' to a.txt. Then start one helper/subagent (if you have that ability) that reads a.txt and reports its line count. Keep a to-do list if you have that tool. Reply 'done'.

Scrubbing (all three fixtures): `/Users/<name>` -> `/work`, the account name -> `user`, emails -> `<email>`. No tokens or keys were present (Grok's init says `apiKeySource:"oauth"`, kept).

## CONTRADICTIONS / SURPRISES (read first)

1. **agy 1.4.0 ignores standard input in `-p` mode.** Deck pipes the conversation on stdin and passes `-p "<STDIN_INSTRUCTION>"`. agy's own transcript (`~/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript.jsonl`) shows the USER_REQUEST holds only the `-p` text. In the first probe the model went looking for its instructions (`ls -la`, read its own transcript, `ps aux | grep agy`, then found the prompt file by luck). A check run with "The secret word is BANANA" on stdin got the answer "the standard input / transcript wasn't included with your message". **So Deck's Gemini/Antigravity bots probably never see the conversation today.** **Fixed in Task 1:** agy's `--input-format stream-json` (needs `--output-format stream-json`) reads one NDJSON message per line from stdin. The shape is `{"event":"user","message":{"role":"user","content":"<chat>"}}` (content may also be a list of content blocks); a line without `event` fails with `stream input message is missing the "event" field`. Checked 2026-10-17 with and without `-p`: both answered PELICAN, and a two-message chat asking for the secret word did too. The fixture comes from a second run with the prompt as the `-p` value.
2. **Grok helper events carry no link to the parent.** A helper's `assistant` / `user` / `stream_event` lines arrive in the main stream with `parent_tool_use_id: null` and the parent's `session_id`. There are no `system/task_*` events. Deck's Claude reader therefore treats helper tool calls as the bot's own steps and **streams the helper's text into the reply** (the background helper's "4" in turn 1, the foreground helper's whole report in turn 2).
3. **Grok `tool_result.content` is a JSON object serialized into a string**, with the command output as a **byte array** (`"output":[98,46,116,...]`). `is_error` is always `false`, even for `cat missing.txt` with `exit_code:1`.
4. **Muse has no working helper under `muse serve` with Deck's client.** The only starter tool is `workflow`. It fails with `failureReason: "workflow_launch_unavailable: this client did not install a workflow launcher; no child work started"`. The MSP schema does define a `subagent` item kind (see the Muse section), but it never appeared.
5. **agy has no to-do tool.** `manage_task` is about background tasks (`{"Action":"list"}` -> "No background tasks are currently running.").

## Gemini (Antigravity CLI `agy`)

Version: `agy --version` = `1.4.0`. Model `gemini-3.8-flash-low`.
Launch used for the fixture (Deck's Full-access flags plus the prompt as the `-p` value, see contradiction 1):
`agy --model gemini-3.8-flash-low --dangerously-skip-permissions --output-format stream-json --print-timeout 280s -p "<prompt>"` (cwd `/tmp/probe-all`).
Deck's line before Task 1: `agy [--model M] [--effort E] [--add-dir D] --dangerously-skip-permissions --output-format stream-json -p "<STDIN_INSTRUCTION>"`, prompt on stdin (ignored). After Task 1: `... --output-format stream-json --input-format stream-json` with no `-p`, and the prompt sent as the one stream-json message above.

Fixture: `gemini_turn.jsonl` (one turn; ACTIVE `agent_response` `text_delta` lines cut to 2 per `step_index`).

### Event shapes
- `{"event":"init","conversation_id","init":{model,cwd,tools:[60 names],permission_mode:"always-proceed"}}`
- Everything else is `{"event":"step_update","step_update":{conversation_id, step_index, state:"ACTIVE"|"DONE", step_type, ...}}`. `step_type` values seen: `user_input`, `agent_response`, `tool`, `subagent`, `system_message`.
- `{"event":"result","result":{conversation_id,status:"SUCCESS",response,duration_seconds,num_turns,usage}}`

### Tool calls
- Start: `state:"ACTIVE", step_type:"tool", tool_name, tool_info:{name, parameters}`.
- End: `state:"DONE"`, same `step_index`, plus `duration_seconds` (float) and `tool_info.output` (string).
- **Output on end event: yes, `step_update.tool_info.output`**, but it depends on the tool:
  - `run_command`: real output text with `\r\n` line ends (`"b.txt\r\n"`, failed cat gives `"cat: missing.txt: No such file or directory\r\n"`).
  - `view_file`: only a summary, `"4 lines, 37 bytes"`, not the content.
  - `write_to_file`: no `output` key at all.
  - `manage_task`, `manage_subagents`: plain text.
- **Exit code / error flag: none in the stream.** A failed command looks the same as a good one. The exit code is only in agy's own transcript file ("The command exited with code 1.").
- **Duration: yes**, `duration_seconds` on DONE (also on `agent_response` DONE steps).
- Parameter names (PascalCase): `run_command {CommandLine}` (transcript also has `Cwd`, `IsDaemon`, `toolAction`, `toolSummary`, but the stream shows only `CommandLine`), `view_file {AbsolutePath}`, `write_to_file {TargetFile}` (no content in the stream), `manage_task {Action}`, `manage_subagents {Action}`, `invoke_subagent {Subagents:[{Model,Prompt,Role,TypeName,Workspace}]}`.
- Tool names seen: `run_command`, `view_file`, `write_to_file`, `manage_task`, `invoke_subagent`, `manage_subagents`. Search was done with `run_command grep -rn ...`, though `grep_search`, `find_by_name`, `list_dir` exist.
- Several tools can run back to back with no `agent_response` step between them (steps 2-5).

### Helpers
- Start: `ACTIVE`, `step_type:"tool"`, `tool_name:"invoke_subagent"`, `tool_info.parameters.Subagents[]` (in the first probe the ACTIVE line already had `step_type:"subagent"` with `subagent_info`, so either can appear).
- Launch done (about 0.1 s, the helper keeps running): `DONE`, `step_type:"subagent"`, `subagent_info:{subagents:[{type_name:"research", role:"Line Counter", initial_prompt, conversation_id:<helper id>, log_uri:"file:///.../brain/<helper id>/.system_generated/logs/transcript.jsonl", workspace_uris}]}`. No `tool_info`.
- **None of the helper's own steps show up in the stream.** The only sign it finished is a `step_type:"system_message"` DONE step with no content (in the transcript it is a `<SYSTEM_MESSAGE>` from `sender=<helper conversation_id>`), and then a new `agent_response` that reports the result.
- Link: `subagent_info.subagents[].conversation_id`. Nothing in the stream carries it later. A helper's steps could only be read from its `log_uri` transcript.
- Deck's `antigravity()` only looks at `step_type:"tool"`, so it never sees the `subagent` DONE line.

### To-do list
None (contradiction 5).

### Step key
`step_update.step_index` (int, unique within one `conversation_id`; ACTIVE and DONE share it). Key on `conversation_id + step_index`.

## Grok

Version: `grok 1.0.46 (2765805b9442) [stable]`. Model `grok-4.7-build-fast`. (`grok models` prints "You are not authenticated" but runs work through OAuth.)
Launch (Deck's Full-access line): `grok --prompt-file /dev/stdin --output-format streaming-messages-json --include-partial-messages --model grok-4.7-build-fast --always-approve`, prompt on stdin (this works; Deck swaps in a `.json` file when there are images).

Fixture: `grok_turn.jsonl` holds **two runs** back to back, each starting at its own `system/init` and ending in `result`:
- run 1 (the task prompt): todo_write x4, read_file, run_terminal_command (the model wrapped `cat missing.txt` in echoes, so exit 0), grep, a **background** spawn_subagent, get_command_or_subagent_output, the helper's run_terminal_command + text "4".
- run 2: a bare `cat missing.txt` (`exit_code:1`), a **foreground** spawn_subagent (`background:false`) whose helper runs `ls sub`.
Trimmed: `slash_commands` and `skills` emptied in init (marked `_trimmed`); thinking text and signatures replaced; text/thinking deltas cut to 2 per content block. Every `input_json_delta`, assistant, user and result line is intact.

### Event shapes (same envelope as Claude)
`system/init {session_id, apiKeySource, model, cwd:"/private/tmp/probe-all", permissionMode:"bypassPermissions", tools, slash_commands, mcp_servers, skills, uuid}`; `stream_event` (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`; delta types `text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`); `assistant`; `user`; `result {subtype:"success", is_error, duration_ms, num_turns, result, total_cost_usd, usage, modelUsage{<model>:{...,contextWindow:256000}}}`. Top-level `assistant`/`user` keys: `type, message, parent_tool_use_id, session_id, uuid`. Event types never seen: `rate_limit_event`, `system/task_*`, `system/background_tasks_changed`, any `tool_use_result` field.

### Tool calls
- Start: `assistant` `message.content[]` `{type:"tool_use", id:"call-<uuid>-<n>", name, input}`. **One assistant event can hold several blocks** (text + 3 tool_use in msg_0). Claude sends one block per event. Deck loops over blocks, so this is fine.
- End: `user` `message.content[]` `{type:"tool_result", tool_use_id, content:<string>, is_error:false}`. One user event can hold several results.
- `content` is always a **string of JSON** with a `type` tag:
  - `Bash`: `{type:"Bash", output:[bytes], output_for_prompt:"exit: 1\ncat: ...\n", exit_code, command, truncated, signal, timed_out, description, current_dir, output_file, total_bytes}`
  - `ReadFile`: `{type:"ReadFile", FileContent:{content:"1→alpha one\n...", content_concise, absolute_path, offset, raw_output, total_lines}}`
  - `GrepSearch`: `{type:"GrepSearch", stdout:[bytes], stderr:[bytes], exit_code, match_count, file_matches:[{path, matches:[{line_number, content}]}]}`
  - `Todo`: `{type:"Todo", TodosUpdated:{summary_for_prompt, todos:[{content, priority, status}]}}`
  - `Text` (background spawn): `{type:"Text", text:"Subagent started in background.\nsubagent_id: <id>\n..."}`
  - `TaskOutput` (get_command_or_subagent_output): `{type:"TaskOutput", Result:{task_id, command:"[subagent:general-purpose] ...", status:"completed", exit_code, started, ended, duration_secs, output:"4\n\n<subagent_meta>...</subagent_meta>\n\n<subagent_result>..."}}`
  - `SubagentCompleted` (foreground spawn): `{type:"SubagentCompleted", output, subagent_id, subagent_type:"general-purpose", tool_calls, turns, duration_ms, worktree_path, resume_from_hint}`
- **Output on end event: yes, but buried in the JSON string**: `output_for_prompt` (Bash: readable text starting `exit: N\n`), `FileContent.raw_output`/`content`, `GrepSearch.stdout` (bytes), `Result.output`, `SubagentCompleted.output`.
- **Error flag: `is_error` is always `false`.** Use the `exit_code` inside the content (Bash: 1 for the failed cat).
- **Duration: no** for plain tools; only `duration_ms` on `SubagentCompleted` and `duration_secs` on `TaskOutput`.
- Tool names seen: `todo_write`, `read_file`, `run_terminal_command`, `grep`, `spawn_subagent`, `get_command_or_subagent_output`. Also in init: `search_replace`, `write`, `list_dir`, `kill_command_or_subagent`, `web_search`, `web_fetch`, `monitor`, `workflow`, `image_*`, ... No `Bash`/`Read`/`Edit`/`Agent`/`TodoWrite`.
- Inputs: `run_terminal_command {command, description}`, `read_file {target_file}` (absolute `/private/tmp/...`), `grep {pattern, path}`, `spawn_subagent {description, prompt, background:bool}`, `get_command_or_subagent_output {task_ids:[...], timeout_ms}`.

### Helpers
- `spawn_subagent` tool_use. Background (`background:true`): result `Text` with `subagent_id` right away; the model later calls `get_command_or_subagent_output`, and its `TaskOutput` result carries the report. Foreground: the `spawn_subagent` result arrives only after the helper finishes, as `SubagentCompleted` with `subagent_id`.
- **The helper's own events are inline with `parent_tool_use_id: null`** and the parent `session_id` (contradiction 2). The only clues: the helper's tool ids restart at `-0` with a new uuid prefix; its Bash `output_file` path holds `.../<subagent_id>/terminal/...`; its `message.id` keeps counting (`msg_5`, `msg_6`). There is no reliable link from the stream alone. For a foreground helper, every event between the `spawn_subagent` tool_use and its `tool_result` belongs to the helper (Grok waits on it). For a background helper they come between the spawn and the `TaskOutput` result.

### To-do list
`todo_write {todos:[{id, content, status}], merge?:bool}`. The first call sends the full list with `content`; later calls send only `{id, status}` with `merge:true`. Status values: `pending`, `in_progress`, `completed`. The **result's `TodosUpdated.todos` always holds the full merged list** (`content`, `priority`, `status`, no `id`); `summary_for_prompt` lists `- [status] id: content`. Build the list from the result, not the input.

### Step key
`tool_use.id` = `tool_result.tool_use_id` (`call-<uuid>-<n>`).

### Does Deck's Claude-stream step code work for Grok? (reasoned from events.rs / work_feed.rs, no test run)
Mostly no. Text, usage, cost and the end of the turn work. Work steps come out wrong:
- `claude_step` matches on `Bash`/`Read`/`Edit|Write|...`/`Agent|Task`/`Web*`. Every Grok name falls through to the generic `_` arm: `kind: Tool`, label `run_terminal_command <command>`, `grep alpha`, `read_file` (`target_file` is not in its key list, so the label is bare `read_file`), `spawn_subagent Count lines in a.txt`. No Command/Read/Helper kinds, no `cd` folder note.
- `claude_todo_tool` does not know `todo_write`, so each todo_write call becomes a work step and no to-do list is produced.
- `claude_result_text` returns the whole JSON string, so step output is a JSON blob with byte arrays instead of the command output.
- `is_error` is always false, so the failed `cat` shows as Done.
- `spawn_subagent` is not a Helper. Its `background` flag is not `run_in_background`, so a background helper's step closes as Done on the launch notice.
- Helper steps have `parent: None` and sit at the top level. The helper's text is streamed as the bot's own reply text (`own` is true), so it leaks into the live reply. The final text still comes from `result.result` (`"done"`).
- `claude_changes` (edit cards) only knows Claude names, so `search_replace`/`write` edits are not reported either (not exercised here).
What a fix needs: a Grok name map (`run_terminal_command`->Command `command`, `read_file`->Read `target_file`, `grep`->search `pattern`/`path`, `search_replace`/`write`->Edit, `spawn_subagent`->Helper `description`/`prompt`, `background`), a result decoder (parse `content` JSON; take `output_for_prompt` minus its `exit: N` line, `FileContent.raw_output`, `GrepSearch` stdout bytes, `Result.output`/`SubagentCompleted.output`; failed when `exit_code != 0`), `todo_write` read from `TodosUpdated.todos`, and helper ownership by position (between the spawn tool_use and its result, or the `TaskOutput`) instead of `parent_tool_use_id`.

## Muse Code

Version: `Muse Code 1.4.10 (1.4.10-R6427.1)` (`serverInfo.version:"1.4.10"`). Model `muse-spark-1.3`, `reasoningEffort:"low"`.
Launch: `muse serve --contributor-mode off --no-session-log --disable-sandbox --model muse-spark-1.3` (Deck's Full-access args), `META_API_KEY` removed from env, cwd `/tmp/probe-all`. Handshake as in muse_server.rs: `initialize {clientInfo:{name:"apex_deck",...}, capabilities:{userInputDialogs:false}}` -> `initialized` -> `session/start {commandId:<uuidv7>, approvalMode:"allowAll", workspaceRoot, modelId}` -> `turn/start {commandId, sessionId, input:[{type:"text",text}], reasoningEffort}`, read until `turn/completed`. Driver: a scratch Python script in /tmp (not saved).

Fixture: `muse_turn.jsonl` holds **two sessions**: turn 1 (the task prompt) and turn 2 ("name your helper tools, start a non-workflow helper"). Each starts with the `id:1` answer. `item/delta` cut to 2 per (itemId, field); `usage/changed.tier` redacted. Everything else is intact.

### Event shapes
Notifications seen: `session/started`, `session/approvalModeChanged`, `session/statusChanged`, `turn/started`, `item/started`, `item/updated`, `item/delta {itemId, field:"text"|"output", delta}`, `item/completed`, `session/tokenUsage`, `session/todoListChanged`, `turn/foregroundCompleted {blockingAgents}`, `usage/changed`, `turn/completed {terminal:"completed", durationMs, timeToFirstTokenMs}`. `params.item` is the full item each time (replace when `revision` is higher).
Item kinds seen: `userMessage`, `agentMessage` (`messagePhase:"commentary"|"finalAnswer"`), `reasoning` (`summary[]`, turn 2), `toolCall`, `reminderChild` (Muse's own reminder agents: `skill-reminder`, `todo-reminder`, `goal-reminder`, `verify-reminder`; `blocking:true` on the last two).
Turn 2 had **three `finalAnswer` agentMessages**: the blocking goal-reminder sent the model back twice, and each answer replaced the one before.

### Tool calls (`kind:"toolCall"`)
- Start: `item/started {itemId, kind:"toolCall", turnId, revision:1, status:"inProgress", recordedAt, tool, callId:"call_...", args:<JSON string, verbatim>}`.
- Progress (bash): `item/updated` with `statusLine` ("tool action serialized: parallel eligibility not proven") or partial `visibleOutput`, and `item/delta {field:"output"}`.
- End: `item/completed`, same `itemId`, higher `revision`, `status:"completed"|"failed"`, `visibleOutput`, and on failure `failureReason`.
- **Output on end event (task question 4): yes, `item.visibleOutput`.** For `bash` it is a pretty-printed JSON string `{chunk_id, command, description, exit_code, terminal_status:"completed"|"failed", terminal_reason?, output, original_output_bytes, original_output_tokens, truncated}`. For `read_file` it is text (`"Read text file \`a.txt\`.\n1|alpha one\n..."`), for `search` text (`"a.txt:1:alpha one\n..."`), for `edit_file` a diff (`"edited\nchanged lines: line 3\n--- original\n+++ updated\n@@\n-...\n+..."`), for `write_todos` `{"ok":true,"revision":1,"items":2}`, and for a failed tool `"tool failed: <reason>"`.
- **Exit status / error flag: yes.** `item.status:"failed"` plus `failureReason:"process exited with status 1"` on the item; `exit_code` only inside the bash `visibleOutput` JSON. A top-level `exitCode` field exists in the schema but only for `userShell`.
- **Duration: not on toolCall.** Schema `durationMs` is for `userShell`/`subagent`/`workflow` only. Use the `recordedAt` difference between started and completed.
- Tool names seen: `write_todos`, `read_file {path}`, `bash {command, description}`, `search {pattern, output_mode}`, `edit_file {path, find, replace}`, `workflow {name, script}`, `work_list {}`. (muse_server.rs `activity()` also expects `write_file`, `shell`, `web_search`, `web_fetch`.) Schema extras worth reading later: `displayLabel`, `toolReceipt`, `outputRef`, `patchRef`/`patchSummary`, `background`.
- `read_file` and `bash` started together (two `item/started` before either completed), so calls can overlap.

### Helpers
- Not observed working (contradiction 4). The model says its only starter is `muse.workflow`, and `workflow` fails without a client "workflow launcher". In turn 2 it gave up, then used plain `bash`.
- Schema (from `muse schema generate-json-schema`): item kind `subagent` with `subagentId`, `childSessionId` (readable via `session/read`/`view/page`), `agentPath`, `role`, `objective`, `depth`, `controlStatus`, `result`, `usage`, `durationMs`, `failureReason`, `workflowRunId`. Item kind `workflow` with `children[]`, `finalSummary`, `message`. Methods `subagent/*` and `workflow/*` exist. A client capability to install a launcher was not found in the stable `ClientCapabilities` (only `experimentalApi`, `optOutNotificationMethods`, `requestedCapabilities`, `userInputDialogs`).
- `reminderChild` items look like helpers (`childSessionId`, `taskId`) but they are Muse's own checks, not model-started helpers. Deck shows them only as "Muse is checking its work".

### To-do list
Yes. Tool `write_todos {todos:[{status:"in_progress"|"pending"|"completed"|"cancelled", text}]}` (the full list every time). Also a dedicated notification `session/todoListChanged {revision, sourceTool:"write_todos", items:[{text, status}]}`, with **camelCase status** (`inProgress`, `completed`, `cancelled`, ...; schema `TodoItem` also allows `activeForm`). Use the notification.

### Step key
`item.itemId` (UUIDv7, same across started/updated/delta/completed; it is the task id). `callId` is the provider's id and is also stable.

### Deck today
`muse_server.rs` `run()` only shows a one-line activity from `item/started` toolCall. It ignores `item/completed` for tools, `session/todoListChanged` and `reasoning`. The `events.rs` `muse()` reader handles an older `kind:"run_output_delta"/"run_terminal"` shape that `muse serve` does not send.

## DeepSeek (OpenAI-compatible API, 2026-10-22)

First API-provider capture in this folder. Taken through Deck's own adapter (`OpenAiCompatParticipant`) with a local pass-through proxy recording the raw SSE, one live turn, access Read, model `deepseek-chat` (the server reports `deepseek-flash`, "DeepSeek-V4.1-Flash", 1,048,576-token context). Key read from the Keychain, never written to disk. Fixtures: `deepseek_todo_write.1.sse` (the tool call) and `deepseek_todo_write.2.sse` (the reply after Deck ran the tool). Prompt: "Before anything else, call the todo_write tool with a four-step plan for moving a project from SQLite to Postgres, mark the first step in_progress, then reply with one sentence."

### To-do list: yes, but only when asked

- Tool: `todo_write {todos:[{content, status}]}`, statuses `pending`/`in_progress`/`completed` — the same shape Deck's own API-bot tool uses, executed by `api_tools`, so `Progress::Todo` reaches the room and the pinned list updates.
- The follow-up request Deck sent carries `{"role":"tool","content":"The to-do list has 4 items."}` — the tool really ran, it was not just called.
- **A plan-shaped prompt does not produce a call.** The same seven tools, with "Plan only, don't read or change any files … keep your to-do list up to date as you go", got 901 frames, `finish_reason:"stop"` and **zero `tool_calls`**: the model wrote the list as prose and signed off with "The to-do list above is marked done for the planning stage". Only the explicit instruction produced a call. Treat a DeepSeek bot's checklist as opt-in.
- Regression test: `deepseek_todo_write_becomes_the_bots_todo_list` in `tests/adapters.rs` replays both fixtures and asserts the 4-item list, `in_progress` first, and the tool result in the second request.

### Caveat

`is_deepseek()` keys off the host name, so a capture taken through a `127.0.0.1` proxy never exercises the `reasoning_content` echo path. It made no difference here (round one carried no reasoning and the follow-up was accepted), but a real DeepSeek turn with thinking on and tool calls may still behave differently. Not captured.
