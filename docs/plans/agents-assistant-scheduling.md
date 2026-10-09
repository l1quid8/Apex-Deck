# ApexAgent: project monitoring and scheduled runs

**Date:** 2026-10-08 · **Authors:** Jigga, Null · **Status:** revision 6 — the ApexAgent panel and durable blocker attention are built on `feat/apex-agent` (f8a119a, 1c90bfa). The background half is not built yet; its task list is the last section ("Background half: task list") and is awaiting Null's review.

**Goal:** ApexAgent monitors one selected project, remembers the work the Human wants to finish, identifies evidence of blockers, and follows up with a specific next step or decision. Scheduled runs are the trigger; the durable monitor ledger is its project memory. Generic timed agent messages remain the scheduling foundation described below.

**Not in v1:** schedules that start a terminal pane, chains like "when A finishes, start B", or schedules shared between machines. Each schedule belongs to one machine.

## ApexAgent's first workflow: project monitoring

**Success:** after reopening Deck, the Human can see what changed in the selected project, which tracked work needs their input, why ApexAgent thinks so, and the last agreed next step. A resolved or dismissed blocker does not keep producing reminders.

1. **Start with one project and a goal.** The Human selects a workspace on its owning machine and describes the current milestone, for example "finish the scheduling foundation and get its race tests passing". Select which existing project threads and plan files ApexAgent may use as evidence. The folder in this checkout is a possible first project, not an assumed selection. Creation/editing stays Mac-only in v1.
2. **Keep one monitoring thread.** ApexAgent has one dedicated thread per monitor, rather than a new thread for every check. It holds summaries and the Human's replies; structured memory lives in the ledger, so compaction or a closed window cannot erase it. The monitor's first work items come from the Human's goal and accepted suggestions from the selected plans/threads. Suggested tasks and owners stay unconfirmed until the Human accepts them.
3. **Track work explicitly.** Each item has a stable id, goal, owner if confirmed, next step, optional Human-set deadline, status, and evidence links. Status is `Watching`, `NeedsYou`, `Blocked`, or `Done`. Only a Human decision or an explicitly agreed verifiable completion criterion can mark it `Done`. A commit or bot saying "done" is progress evidence, not proof of the whole goal being finished.
4. **Spot blockers with reasons.** Open approval/question cards are observed requests for input. A recorded command failure is an observed failure; its continuing relevance to a work item must be explained. An unmet dependency, a missed agreed deadline, or repeated failure can support a blocker suggestion. Silence, an idle thread, a dirty tree, or an old failed reply alone cannot establish a blocker. Every finding says whether it is observed, inferred, or unknown, includes the evidence and its observation time, and offers one concrete next step.
5. **Follow up in Deck.** A finding can say "The cancellation race test is still failing; should I keep this as the next task or defer it?" and link to the selected evidence. The Human can reply or use Confirm blocker, Set next step, Done, Dismiss, or Snooze. Follow-up cards persist independently of a running model request; the two-hour approval timeout never expires a tracked work item or a Human reminder. ApexAgent does not alter the repo, delegate tasks, approve tools, or contact anyone as part of monitoring.
6. **Keep checks quiet.** Proposed default: a read-only check every 60 minutes, using the existing `Every` schedule, plus Check now. Unchanged evidence requires no new model call or chat message. New actionable findings get one in-app follow-up; progress without a decision is collected into at most one daily summary. Attention is delivered during weekdays 09:00–18:00 in the monitor's configured time zone; findings outside that window wait for the next window. An unanswered finding gets at most one reminder after 24 hours, then stays visible without further reminders until the Human replies or materially new evidence arrives. Snooze and dismissal survive restart.

**Proposed defaults, not unanswered blockers to writing this plan:** one dedicated monitor thread; hourly checks; existing Mac/iPhone attention only; read-only evidence and explicit Human decisions; the scheduler's two-hour continuous approval wait; the paid-chat soft cap with its existing disclosure. The initial project and the Human's current goal are setup inputs, not hard-coded product decisions.

## What the user sees

1. **A Schedule button on each agent** in the Agents section and in a thread's bot menu. It opens a small form:
   - **What to say:** the message the agent gets, e.g. "Summarise yesterday's commits on main".
   - **Where:** a thread you pick, or **New thread each time** (named `<agent> · <date>`) in a folder you pick.
   - **When:** Once (date + time), Every day, Weekdays, Every week (pick days), or Every N minutes/hours (minimum 15 minutes). Time is shown in your own time zone.
   - **Which machine:** this Mac or any machine from Pick-the-machine. The default is the machine that owns the thread. Choose the Hetzner server for anything that must run while the Mac is asleep, and the form says so.
   - **Spend limit per run** (custom-provider bots only): default $0.50. See "Spending" below for exactly what it does and doesn't promise.
2. **A Scheduled list** in the sidebar under Agents. Each row shows the agent, a short version of the message, the next run ("tomorrow 8:00"), and the last result: a dot plus "done", "running", "waiting on you", "failed", "skipped" or "gave up". Each row has Pause, Run now, Edit and Delete.
3. **Scheduled messages are marked in the chat.** A run posts its message as a human line with a small clock tag ("Scheduled · weekdays 8:00") so you can tell it apart from something you typed. The reply comes in as usual.
4. **When a run needs you**, for example an approval card, a question form or a paid-job confirm, the thread is flagged in the attention menu and the Scheduled row switches to "waiting on you" **as soon as the card opens**. This covers a card from any bot in the run, including one the scheduled bot @mentioned. It waits up to 2 hours, then stops that run (every bot in it, and any follow-up hops it had queued) and leaves a note. Anything you posted yourself in the meantime keeps running. Nothing gets approved automatically just because nobody was watching.
5. **Missed runs:** if the machine was off or asleep at the scheduled time, Deck runs the job **once** when it wakes up and marks it "late · 07:42 → 09:10". It never catches up by running the same job several times. Once-only jobs that are more than 12 hours late are skipped and marked "skipped". If Deck stopped at the exact moment it was posting a job, it can't tell whether the post went out, so it marks that run "failed · Deck stopped while posting" and never posts it a second time.
6. **Busy threads:** if the thread is already running a turn when a job is due, the job waits for it to finish, for up to 30 minutes from when it first tried to post (so a job found late after sleep still gets its full 30 minutes). If the thread is still busy after that, the run is marked "skipped · thread busy" and the schedule moves on to its next time. A scheduled message only starts in an idle thread, so it never jumps into a turn that's already running. **Your own messages are never held back by a schedule:** once a job has started, anything you type works exactly as it does today while a bot is busy. Your line shows straight away; a message to a different bot runs alongside the job; a message to the same bot waits for that bot's current reply. Nothing is lost either way.
7. **Deleted threads stay deleted.** If you delete a thread that a schedule posts into, the schedule pauses and shows "thread removed". It never brings the thread back, even if you delete it at the exact moment the job is opening it.
8. **Phone:** the Scheduled list shows on the iPhone app too, with Pause, Run now and Delete. Creating and editing schedules is Mac-only in v1.

### Spending (what the limit really does)
Deck can't always know what a reply costs until it's finished. So the limit works like this:
- **Picture and video bots:** they already ask before every paid job (14ec992), showing the price quote. A scheduled run never skips that card, so an unattended media job always waits for you. The limit only adds a line to the card when the quote is over it.
- **Chat bots on custom providers:** the cost of a reply is only known when the reply ends. Deck adds it up after each reply. Once the run's total reaches the limit, no further replies start (no follow-up hops, no tool rounds that start a new reply). **One reply can still go over the limit**, and the form says so in plain words. To keep a single reply small, each scheduled request is sent with an output-token cap worked out from the model's listed price and the limit.
- **Models with no listed price:** you can't schedule them unless you tick "price unknown, run anyway". Otherwise the form refuses and says why.
- **Claude / Codex subscription bots:** no money limit (they report no per-reply cost). The form hides the box.

### Phase 2: an agent can suggest a schedule
In its reply, a bot can write a line like `Schedule: tomorrow 09:00, "check whether CI went green on main"`. Deck turns that line into a card ("Gronk wants to check back tomorrow at 9:00. Add schedule?") and only adds the schedule if you accept. A bot can never set up a schedule without you.

## How it's built

### 1. Schedule store (Rust, new `crates/apex-host/src/schedules.rs`)
- A `Schedule` holds `id`, `agent` (a profile id from the Agents library), `text`, `target` (`Thread { room }` or `NewThread { cwd }`), `when` (`Once { at }`, `Daily { time }`, `Weekly { days, time }`, `Every { minutes }`), `tz`, `paused`, `spend_cap_micros`, `allow_unpriced`, `next_run` (UTC), `last_run`.
- A separate **occurrence record** per run: `Occurrence { schedule, due: Utc, run_id, state }` where `phase` is `Claimed → Dispatching → Started → Ended(Done | Failed | Skipped | GaveUp)`, and it also keeps `open: usize`, the number of open cards for the run ("waiting on you" is `Started` with `open > 0`; see "Occurrence transitions" in section 2). At most one occurrence per schedule is not finished. `Claimed` means "not posted, safe to post". `Dispatching` means "a post may have gone out" and is never posted again. The occurrence also keeps `admit_from: Option<Utc>`, the time it first tried to post, which starts the busy wait.
- Saved as `schedules.json` in the data folder (next to `devices.json`) and written the same atomic way `Store` writes everything else. Tests use `APEX_DECK_DATA_DIR` set to a temp folder and never touch the user's data.
- `next_run` comes from a pure function `next_after(when, tz, after: Utc) -> Option<Utc>`. Times are UTC instants plus the zone name, so daylight-saving changes keep "8:00" at 8:00.

### 2. The clock
- One tokio task per host. It wakes on a schedule change, on the timer for the earliest `next_run`, and **every 60 s as a backstop**. On every wake it compares stored UTC `next_run` values with `Utc::now()`. Nothing relies on how a tokio timer behaves across sleep; the backstop plus wall-clock comparison is what catches a missed run.
- **Claim before dispatch.** When a schedule is due, the clock writes, in one atomic save, a new `Occurrence { due, run_id, state: Claimed }` and the schedule's advanced `next_run`. Only then does it try to post. So:
  - a second tick finds `next_run` already in the future and does nothing;
  - **Dispatching is saved before the post.** Once admission has reserved the room (below) and before the human line is pushed, the occurrence is saved as `Dispatching`. Only after that save succeeds does the message go in. When the batch is under way it moves to `Started`.
  - **Restart recovery.** `Claimed` was never posted, so it runs once if it's still inside the late window. `Dispatching` is ambiguous (the post may or may not have gone out), so it becomes `Failed: Deck stopped while posting` and is never re-posted. `Started` becomes `Failed: Deck restarted during the run`. A crash test kills the host right after the `Dispatching` save and again right after the push, and checks that the job is posted at most once in both cases.
- **Opening without resurrecting.** Checking storage and then calling `room_create` leaves a gap: `room_delete` can run in between, and `room_create` would then save a fresh empty room under the same id. So:
  - A host-wide `lifecycle` mutex is held by `room_delete` for its whole run (close + checkpoint delete), and by a new `room_open_existing(id)`.
  - `room_open_existing` holds `lifecycle`, returns the open handle if the room is already open, otherwise loads the saved room and opens it. If there is no saved room it returns `Gone` and never creates or saves anything. It shares the restore code with `room_create` but has no "create new" branch.
  - `room_delete` pauses every schedule targeting the room inside the same `lifecycle` hold, before it releases.
  - **Admission re-checks.** `room_post_scheduled` (below) refuses with `Gone` if the handle's `deleted` flag is set, and the clock re-reads the schedule and refuses if it is paused or deleted, right before admitting. A job waiting in the busy loop therefore stops the moment its thread or schedule goes away.
  - Test: delete the thread between the clock's lookup and its open (a test hook pauses the clock there); the room stays deleted and the schedule shows "thread removed".
- **Atomic admission.** New `ConcurrentRoom::begin_post_if_idle(text, targets, run_id, sink)`. While holding the room lock that `begin_post` already takes, it checks `pending == 0` and creates the batch (which bumps `pending`) in one step. If the room is busy it returns `Busy` and pushes nothing. Human posts keep using `begin_post` unchanged, so they never wait on the scheduler. **Admission is the only guarantee:** a scheduled line is pushed only into an idle room, and a job that loses the room lock to a human post gets `Busy`. After admission there is no room-wide queue. A human post made during the run behaves exactly like one made during any other bot turn today: `begin_post` pushes the human line at once and queues execution per participant, so a message to another bot runs in parallel and a same-bot message waits on that slot. We considered a room-wide queue and rejected it, because it would make the human's own messages wait up to a whole scheduled run. The host wraps this as `room_post_scheduled(id, text, agent, run_id, before_push) -> Result<RunHandle, Busy | Gone>`, where `before_push` is the `Dispatching` save above. It runs after the room is reserved and before the line is pushed. If the save fails, the reservation is dropped and nothing is posted.
- **Busy wait.** On `Busy`, the clock sets `admit_from` (if unset, and saves it), waits on the room's idle notification or the 60 s backstop, then re-checks deletion/pause and tries again. It gives up 30 minutes after `admit_from`, not after `due`, and marks `Skipped: thread busy`. The 12-hour lateness rule is checked separately, once, when the occurrence is first claimed.
- **Completion handle.** `room_post_scheduled` runs the batch like `room_post_to` does, but returns a `RunHandle` (a oneshot plus the `run_id`) that resolves when that batch ends, with its outcome. The clock sends `Ended(Done/Failed)` through `Schedules::apply` from it. `room_post_to` itself is unchanged.
- **Run ownership covers the whole batch.** Today stop is per participant (a slot's `generation`), not per batch, and the desk only knows a request's participant. So:
  - `TurnBatch` gets `run: Option<RunId>` and a shared `cancelled: Arc<AtomicBool>`. Every `Ticket` it creates, including hop tickets made later in `run`, carries the same `run`.
  - Each `Slot` records `current: Option<(RunId, cancel flag)>` while a ticket from a run is executing. `run_one` sets it in the same short `slots` critical section it already uses for the generation check, and clears it when the turn ends.
  - `run_one` and the hop loop also check `cancelled`: a cancelled batch starts no new ticket and queues no new hops.
  - The desk stores `(owner, run)` per request. The turn's `TurnRequest` carries `run`, and `open_for` / `open_question_for` take it from there, so a card opened by an @mentioned bot two hops later still belongs to the run.
- **Registration and rejection share one lock.** Today `open_owned`, `open_question_for` and `reject_for` each take `waiting` or `asking` on their own, so a bot could register a card just after a rejection finished. The desk gets `runs: Mutex<RunBook>`, where `RunBook { closed: HashSet<RunId>, open: HashMap<RunId, usize> }`. Lock order is always `runs → waiting → asking`.
  - `open_for` / `open_question_for` with `Some(run)` take `runs` first. If `run` is in `closed`, they register nothing: the approval receiver gets `Decision::Reject` at once and the question receiver's sender is dropped (shown as dropped, like a stop). Otherwise they insert the request and bump `open[run]` while still holding `runs`.
  - `reject_run(run)` takes `runs`, adds `run` to `closed`, then removes and rejects every request tagged `run` from `waiting` and `asking`, and zeroes `open[run]`, all before releasing. So a request either registered before (and is rejected) or arrives after (and is refused). No card is left behind.
  - `resolve`, `answer` and `withdraw` decrement `open[run]` under the same lock. `closed` entries are pruned when the run's `RunHandle` resolves.
  - Requests with `run: None` (human turns) skip `RunBook` entirely and behave as today.
- **Waiting state comes from the open-request count.** The desk listener fires on every `open[run]` change with the new count. The occurrence doesn't store `Waiting` as a step of its own. It shows "waiting on you" whenever it is started and `open > 0` (see transitions below), and `schedules_changed` is sent on each change.
- **Occurrence transitions are ordered by run id.** Three writers touch an occurrence: the dispatcher (after `before_push` returns, it records "started"), the desk listener (open count), and the `RunHandle` (batch ended). An immediate approval or a bot that finishes at once can fire before the dispatcher's bookkeeping runs. So every change goes through one `Schedules::apply(run_id, Event)` under the store mutex, which ignores events for a run id that isn't the schedule's current occurrence and then saves:
  - phases only move forward: `Claimed → Dispatching → Started → Ended(outcome)`. `Ended` (Done / Failed / Skipped / GaveUp) is final, so a later event is dropped.
  - `Started` is applied only from `Dispatching`. A late "started" after `Ended` changes nothing.
  - `OpenCount(n)` and `Ended` are accepted from `Dispatching` too (the post went out; the dispatcher just hasn't recorded it yet). `OpenCount` moves `Dispatching` to `Started`.
  - the shown state is computed, not stored: `Started` with `open > 0` shows "waiting on you", `Started` with `open == 0` shows "running".
  - restart recovery reads phase: `Dispatching` → `Failed: Deck stopped while posting`, `Started` → `Failed: Deck restarted during the run`.
  - Test: the scheduled bot @mentions another bot, finishes, and the mentioned bot then opens an approval. The row shows "waiting on you" (`Started`, `open == 1`).
- The posted message carries `scheduled: Some(schedule_id)` in its metadata, so the chat can draw the clock tag and Fork/Export keep it. One optional field on the human `Message` in `apex-core/src/types.rs`; old saved chats load unchanged.
- `NewThread` targets: create a room whose roster is just that agent's profile, save it, and add it to the session so the sidebar shows it, then admit as above.

### 3. Closing rooms the clock opened
- The host keeps an **attach count** per room: `room_create` from a client (window or phone) adds one; `room_close` from that client takes one away. The scheduler opens rooms with its own flag and doesn't count as a client.
- 10 minutes after a scheduled run ends, the clock tries `room_close_if_unused(id, run_id)`. Under the rooms lock it closes only if the attach count is 0, the room is idle, and no newer run has started. If a client attached in the meantime, it does nothing. A plain `room_close` stops running work, so the check and the close must happen under one lock.

### 4. Unattended safety
- **Timeout tied to the run.** The 2-hour timer holds the `run_id`. When it fires it checks that the occurrence is still `Started` with that `run_id` and `open > 0`, then calls `ConcurrentRoom::stop_run(run_id)`. All of the following happens under the `slots` lock, the same lock `run_one` takes to start a ticket, so no human turn can start between the ownership check and the cancel:
  1. set the batch's `cancelled` flag (no new tickets, no queued hops);
  2. for each slot whose `current` run is `run_id`, set `slot.stop` so the running turn ends. It does **not** bump `generation`, because that would also kill a human ticket already queued on the same bot;
  3. `approvals.reject_run(run_id)` closes the run in the desk's `RunBook` and rejects or drops only the requests tagged with it. Because the run is closed under the same lock that registers cards, a bot that was mid-way through opening a card when the timer fired gets an instant rejection instead of a fresh card.

  A late timer for run A finds no slot or request tagged A and does nothing, so it can't touch run B or a human turn. `room_stop` (the Stop button) is unchanged.
- Tests: a scripted bot keeps working after a rejection and `stop_run` ends it; a mentioned bot is waiting after the original bot finished and `stop_run` ends it and drops its card; a human message queued on the same bot during the wait still runs after `stop_run`; a stale timer for an old run does nothing; `reject_run` racing `open_for` and racing `open_question_for` (a test hook pauses registration just before it takes `runs`) leaves no card open either way, and the bot sees a rejection / dropped question.
- "Always allow" rules the thread already has still apply. Nothing new is auto-approved.
- Paused machine or daemon not running means no runs; the Scheduled row says "machine offline" (from the Pick-the-machine status).
- A schedule whose agent profile or thread was deleted pauses itself and shows "agent removed" / "thread removed" instead of failing over and over.

### 5. Commands (`command.rs` → `commandBackend.ts`, `hostBackends.ts`)
`schedule_list {}`, `schedule_save { schedule }` (create or edit; returns the computed `next_run`), `schedule_delete { id }`, `schedule_pause { id, paused }`, `schedule_run_now { id }` (claims an occurrence the same way the clock does, so pressing it twice quickly runs once). A new `schedules_changed` event goes to every client, including the phone over the remote link. All five go into the `hostBackends.ts` list so Pick-the-machine sends them to the right machine.

### 6. UI (`src/`)
- `ScheduleForm.tsx`: the form above, opened from `AgentsSection.tsx` and the bot menu in `ChatPane.tsx`. Render it offscreen and check the PNG before installing.
- `ScheduledList.tsx` in the sidebar under Agents: plain rows, one state dot, quiet labels, the same style as the phone list rules.
- Chat: a clock tag on messages that have `scheduled` set.
- Phone (`src/phone/`): read-only list with Pause / Run now / Delete.

### 7. Phase 2: suggested schedules
`apex-core/src/next_steps.rs` already reads things out of replies. Add a parser for `Schedule: <when>, "<text>"` lines that makes a proposal card (`ActionKind::Tool`, title "Add schedule"). Accepting it calls `schedule_save` with the agent and thread filled in. Only plain wording that is easy to parse gets accepted ("in 20 minutes", "tomorrow 09:00", "every weekday 08:00"). Anything else produces a card asking you to fill the form yourself.

## Tests
- `next_after`: DST spring-forward and fall-back in America/New_York, weekly, Every N across midnight, Once in the past, Feb 29.
- **Wall-clock jump:** a fake clock whose wall time jumps 3 hours while no timer fires; the next backstop tick runs the job once, marked late. Kept separate from timer-advance tests.
- **Duplicate ticks:** two ticks for the same due time, and Run now pressed twice, post once.
- **Restart during a run:** kill the host with an occurrence `Claimed`, `Dispatching` (before and after the push), and `Started`. On restart `Claimed` runs once, and the other two are marked failed and never re-posted.
- **Admission race:** a human message and a due job race for the room lock. If the human wins, the job gets `Busy` and starts only once the room is idle. If the job wins, the human line is still pushed straight away and runs per participant as it does today. Both are posted exactly once, and a scheduled line is never pushed into a room with a turn in progress. A job that is still busy 30 min after `admit_from` becomes `Skipped`. A job found 2 hours late still gets its full 30-minute wait.
- **Transition ordering:** a bot that approves at once (always-allow) and finishes before the dispatcher records `Started`; a bot that opens a card before `Started` is recorded. The final state is `Done`, the card shows "waiting on you", and a late `Started` never overwrites `Ended`. Events for an old run id are ignored.
- **Stale timeout:** run A times out after run B has started on the same agent; B keeps running.
- **Timeout really stops (whole batch):** see the tests listed in section 4.
- **Waiting state:** opening an approval, by the scheduled bot or by a bot it mentioned, makes the row show "waiting on you" (`open > 0`) before the batch ends, and closing the last card turns it back to "running".
- **Spending:** the cap stops further hops once reached; an unpriced model is refused without the tick box; media runs always show the confirm card.
- **Deletion:** a deleted thread is never recreated, including when it's deleted between lookup and open. Deleting a thread while its job is in the busy wait pauses the schedule, and the next admission attempt refuses with `Gone`.
- **Cleanup vs attach:** a client attaches during the 10-minute wait; the room stays open and its turn keeps running.
- Commands: argument names match what the UI sends (the existing `every_command_the_ui_sends_is_one_the_host_takes` test).
- UI: form validation (time required, minimum 15 minutes, at least one weekday, unpriced tick box), list rows, the clock tag.
- **Live check** after the Human OK: a schedule set 2 minutes ahead on a throwaway thread with a scripted bot (no paid models), on a dev build with its own `APEX_DECK_DATA_DIR`, so it never touches the installed Deck's data.

## Open questions for the Human
1. Should **New thread each time** be the default, or should a schedule post into one thread you pick? I lean toward new thread each time for daily reports, so one thread doesn't fill up with a month of summaries.
2. Is a 2-hour wait for approvals right, or should a run that needs you just wait until you answer?
3. Phone: is the read-only list with Pause / Run now / Delete enough for v1, or do you want to create schedules from the phone too?
4. Is "one reply can go over the spend limit, but nothing starts after it" acceptable for chat bots? The only stricter option is not scheduling paid chat bots at all.

## Build order
1. `schedules.rs` store + occurrences + `next_after` + tests.
2. Core runtime (`apex-core/src/concurrent.rs`, `approval.rs`): run id on batches/tickets/requests, `begin_post_if_idle`, `stop_run`, the desk's `RunBook` (`reject_run` + run-aware registration), open-count listener. Host: `Schedules::apply` transition guard. Then host: `lifecycle` lock + `room_open_existing`, `room_post_scheduled` with `before_push` + `RunHandle`, attach count + `room_close_if_unused`. Each with its race test.
3. Clock: claim → dispatching → running, backstop, restart recovery (incl. the Dispatching crash test), busy wait from `admit_from`, deleted/paused re-checks, late handling + tests.
4. Spending: per-run total, hop stop, output-token cap, unpriced refusal.
5. Commands + event.
6. Mac form + Scheduled list + clock tag (render and check first).
7. Phone list.
8. Phase 2 suggested schedules: separate branch, after v1 has been used for a while.

## Background half: task list

The panel on `feat/apex-agent` already calls five commands the host doesn't have, so every button except loading fails today. These tasks make a real run able to produce a blocker. They use what's already in `monitor.rs` (`ProjectMonitor`, `claim`/`is_current`/`recover`, `redirect`, `set_paused`) and `monitor_evidence.rs` (`collect`, `validate_files`, `fingerprint`). They do **not** depend on the generic scheduler above (`schedules.rs`, run ids, admission): a monitor check never posts into a room, so it has its own claim instead.

**Rule for every task:** each change to `monitor.json` is one locked read → change → atomic save on the host (a `monitors: Mutex<()>` held around `Store::monitors` + `save_monitors`). Nothing holds that lock across a model call or a git command.

### Task 1 · Host commands (`command.rs`, `host.rs`, `authority.rs`)
Each returns the updated `ProjectMonitor` (the panel rejects anything whose `workspaceId`/`hostId`/`cwd` don't match).
- `monitor_assign { workspaceId, cwd, hostId, text, files, threads, profile }` *(built, e875895)*: the Mac sends the folder, its route host id and the whole chat profile, because a remote machine has neither the Mac's project list nor its saved profiles. The host runs `validate_files` on that folder. It requires each chat to be saved on this machine **with the same folder**. It requires the profile to be an OpenAI-compatible text profile. Only then does it create or replace the monitor. Replacing keeps nothing from the old one. *Null: is trusting the client's `workspaceId`/`hostId` OK, given the panel already rejects any monitor whose folder or host doesn't match?*
- `monitor_message { workspaceId, text }`: `redirect`, which already bumps `revision` (so an in-flight check is discarded) and sets an immediate wake.
- `monitor_pause { workspaceId, paused }`: `set_paused`.
- `monitor_check_now { workspaceId }`: sets `next_check_at = now` with wake reason `check_now` and wakes the clock. It doesn't run the check inside the command, so the reply is quick.
- `monitor_resolve { workspaceId, findingId, status: resolved|dismissed|snoozed, snoozedUntil? }`: `snoozed` needs a future `snoozedUntil`. A resolved or dismissed finding is never reopened by a later check that sees the same issue. It needs new evidence, which gets a new finding id.
- `authority.rs`: all five need Full access to every thread (`full(Global)`), because a monitor reads a whole folder and any chat in it. `hostBackends.ts` already lists them as guarded writes.
- Tests: each command round-trips through a restarted `Store`; a bad file path, another workspace's thread or a missing profile is refused without saving; an unknown `workspaceId` errors.

### Task 2 · Evidence reader hookup (`monitor_check.rs`, new)
- `gather(monitor) -> EvidenceSnapshot`: load each selected thread with `Store::room` (closed threads work; missing ones become warnings), then call `collect(cwd, files, threads, now)`. It's read-only: no builds, no `git fetch`, no files outside `cwd`.
- Change detection: if the fingerprint equals `evidence_fingerprint` and the wake reason isn't `redirected`, `check_now` or `initial`, the check ends with no model call and no message. Only `last_checked_at` and the next wake move.
- Tests: the fingerprint is the same for unchanged evidence and changes when a selected file or thread changes; a deleted selected thread gives a warning, not an error; a path outside the workspace is refused.

### Task 3 · The check itself: one model call (`monitor_check.rs`)
One request through the existing OpenAI-compatible adapter. No tools and no approvals, so nothing it says can act.

**Profile.** The check uses `monitor.profile`, the copy saved at assignment (Task 1). It never looks `profileId` up, because the project's machine may not have the Mac's profiles. A missing profile, or one that is no longer OpenAI-compatible text, or has no key on this machine, means no model call: an `error` note and a retry in 60 min.

**Host identity.** A host's `monitor.json` only ever holds monitors assigned *to that host*, because the app routes every monitor command to the project's own machine. So the clock runs every monitor in its own store. `hostId` is the app's name for the route, used only by the app to match replies. The host never compares it with anything. The host checks the folder, files and chats itself (Task 1), so a wrong `workspaceId`/`hostId` from the client can only file the monitor under the wrong name in that client. It can't widen what gets read. This answers the Task 1 question.

**Unique sources, with versions (Task 1/2 changes this needs).**
- `monitor_assign` drops duplicate files (after `validate_files` normalises them) and duplicate thread ids, so every source id in a snapshot is unique. `collect` also skips a second source with an id it has already used, as a backstop.
- `EvidenceSource` and `EvidenceRef` gain `version`: an FNV-1a hash of that one source's `kind`, `content` and `truncated`, computed the same way as `fingerprint`. `EvidenceRef.version` is `#[serde(default)]`, so old saved data loads with `""`, which never matches a real version.

**Prompt.** Responsibility, decisions, preferences, `next_step`, the last ~20 conversation messages, and the evidence as `id · label · content`. Open and snoozed findings are listed with short aliases `F1…Fn`, which the host maps back to finding ids. Settled findings are listed as "already handled, don't raise again unless the evidence changed". The model sees labels and content only, never absolute paths.

**Reply contract.** It's parsed into a typed struct. A JSON or type error is a bad reply.
```
{ "message": string (≤ 4000 chars, "" = stay quiet),
  "messageEvidence": [ { "id": string, "quote"?: string } ],
  "findings": [ { "ref"?: "F1"…, "summary": string ≤ 200, "reason": string ≤ 1000,
                  "confidence": "observed" | "inferred", "nextStep": string ≤ 500,
                  "evidence": [ { "id": string, "quote"?: string } ] } ]  (≤ 10),
  "nextStep": string ≤ 500,
  "nextCheckInMinutes": integer, "wakeReason": string ≤ 100 }
```
- Strings over their limit are cut at a UTF-8 boundary. They aren't rejected.
- `nextCheckInMinutes` is clamped to 15–1440.
- **Bad reply:** nothing changes except `last_checked_at`, an `error` activity note, and the next wake at 60 min. No message, no findings, and `evidence_fingerprint` isn't saved, so the next check isn't skipped as "no change".

**Evidence validation (per finding, all or nothing).** `evidence` must be non-empty, with no repeated id, and every id must be in *this* snapshot. One unknown id drops the whole finding and adds a "dropped a finding with unknown evidence" activity note. The host builds every `EvidenceRef` from the snapshot: label, `observed_at`, `version`. Its `excerpt` is the model's `quote` only if that quote appears word for word in the source content. Otherwise the excerpt is the first 300 chars. `messageEvidence` is checked the same way, except that bad ids are removed and the message is still posted.

**Finding identity and lifecycle (the host owns both).**
- **Update:** `ref` must name a finding that is open or snoozed *at apply time*. The host replaces `summary`, `reason`, `confidence`, `next_step` and `evidence`, and sets `last_seen_at = now`. It keeps `id`, `status`, `first_seen_at`, `snoozed_until` and `last_notified_at`. An unknown `ref`, or one the Human settled during the call, drops that item.
- **New:** no `ref`. The host gives it the id `finding-<conversationId>-<n>`, status `open`, and `first_seen_at = last_seen_at = now`.
- **Recurrence:** a new finding is dropped if any settled finding (resolved or dismissed) cites *every* one of its sources with the same `version`. In other words, nothing it's based on has changed since the Human settled it. If one cited source has a new version, it counts as new evidence and goes through as a new finding. A settled finding is never reopened.
- **Not mentioned in the reply:** the finding is left exactly as it is. In v1 only the Human settles findings. The model can only say in `message` that something looks fixed.
- **Snooze:** once `snoozed_until` passes, the finding counts as open again (already what `notifiable_findings` does). Apply leaves `status` alone.
- **Alert:** `last_notified_at = now` when a finding is new, or when an update changed its evidence versions. Nothing else raises an alert.

**Apply, under the monitor lock.** Re-load the monitor and check `is_current(claim)`. If it isn't current, drop the result and clear `active_check` only if it is still this claim. If it is current, merge findings into the *just-loaded* list, so a Resolve made during the call survives: Resolve doesn't bump `revision`, and the merge treats it as settled. Then append the message if it isn't empty, set `next_step`, `last_checked_at`, `next_check_at`, `wake_reason` and `evidence_fingerprint`, and clear `active_check`. Save once.

- Tests (scripted fake model, no network):
  - a quiet check
  - a new blocker
  - an update via `F1` keeps `first_seen_at` and the status
  - one unknown id drops the whole finding
  - a repeated id is rejected
  - a quote not found in the source falls back to the first 300 chars
  - a malformed reply saves no fingerprint
  - a resolve during the call survives apply, and an update aimed at it is dropped
  - a dismissed finding with unchanged versions isn't re-raised
  - the same issue with one changed source comes back as a new id
  - a redirect during the call discards the result
  - a missing profile makes no call
  - duplicate files or threads at assign give unique source ids

### Task 4 · Timed check, the clock (`monitor_clock.rs`, started by the daemon)

Execution wiring implemented: daemon startup starts one host-owned worker; successful monitor writes wake it; persisted UTC deadlines are rechecked at least every 60 seconds. The worker permits two concurrent checks, recovers interrupted claims before dispatch, and aborts its calls at shutdown so unfinished claims recover on the next boot. Regression tests exercise the real HTTP adapter with a local test server for assignment, Check now, pause, duplicate startup, and restart recovery.
- One tokio task per host. It wakes at the earliest `next_check_at`, on `check_now`/`message`/`assign`/`pause`, and every 60 s as a backstop, always comparing saved times with the wall clock, the same as the scheduler rule above.
- For each due monitor: `claim` (saved) → gather → model call → apply. One check at a time per monitor (the claim enforces it), at most 2 in parallel per host.
- On start-up, `recover` every monitor that has a stale `active_check` (already backs off 15 min).
- The clock runs every monitor in this host's own store. Only that host's monitors are ever saved there (see Task 3, Host identity).
- Tests: a duplicate tick doesn't run twice; a restart mid-check recovers instead of re-running at once; a paused monitor isn't run; a wall-clock jump is caught by the backstop.

### Task 5 · Telling the app (small)
- Emit a `MonitorChanged { workspaceId }` bus event after each save, so the panel and `HostMonitors` refresh without waiting for their 15 s poll. Polling stays as the fallback, so this is optional for the first test.

### Order and first real test
1 → 2 → 3 → 4, then 5. Tasks 1 and 2 don't touch each other and can be built side by side. After task 4: on a scratch project in the dev build (`APEX_DECK_DATA_DIR=/tmp/apex-agent-test-data`), select a plan file that says a step is blocked, assign ApexAgent, and check that a blocker appears, survives reading the conversation, and clears on Resolve. Then the Rust side gets a review before merge.
