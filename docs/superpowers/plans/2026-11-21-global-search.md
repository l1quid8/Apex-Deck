# Search Deck (global search) Implementation Plan

Revision 5, 2026-11-22. Planned by Gayble; Part 1 built by Gayble at the user's request ("please continue this implementation"), review by Null. Revision 1 was reviewed by Asstra (`2026-11-21-global-search-review.md`); every finding is folded in below and listed under "What changed since revision 1". Revision 3 rewrites Task 1 after Null's preflight and Asstra's second review; see "What changed since revision 2". Revision 4 records what Part 1 built; see "What changed since revision 3".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow `AGENTS.md`: task worktree from `origin/main`, one PR per Part, a different model reviews each PR.

**Goal:** A **Search Deck…** field pinned at the top of the left sidebar finds anything Deck has saved, on every machine, and jumps straight to it.

**What the Human should see when it works:** from any section, type `installer`; the panel lists the thread *Installer QA*, the message "Try the installer on a clean Mac before signing off" in *Release handoff*, plus any matching setting, task, note, picture, file and work step; Enter on the message opens that thread with that exact message scrolled into view and outlined for two seconds.

**Architecture:** Each machine's daemon searches its own saved files on demand through a new `search` module with its own state (text cache, per-connection grants, cancel table). The desktop and phone ask every machine in parallel and merge the answers as they arrive. No index, no new file on disk, no new dependency.

**Tech stack:** Rust (`apex-host`, `apex-daemon`, `apex-core`), TypeScript/React (`src/`), Node test runner (`tests/*.test.mjs`).

**Spec:** this document plus the two approved mockups, copied into the repo:
- `mockups/search-deck/desktop.html` (Asstra, revision 2)
- `mockups/search-deck/phone.html` (Jigga, revision 2)
- They load `app.css` from `~/Library/Application Support/ApexDeckPreviews/search-deck-static/`; live at `https://macbook-pro.tail47d5c7.ts.net:8443/` (phone) and `/desktop.html`.

Where a mockup and this plan disagree, this plan wins; say so in the PR.

## What is searched

| Kind | Source on each machine | Jump lands on |
|---|---|---|
| Project, thread, chat and agent names | `ProjectList`, room manifests, agent profiles | The project / thread / agent |
| Settings | Desktop only (`searchSettings`, `src/settingsCatalog.ts`) | That setting, marked |
| Messages | `saved-chats-v1/rooms/*.json`, `assistant-conversations-v1.json` | The exact message, outlined |
| Tasks, saved notes, Library pictures | `assistant-tasks-v1.json`, `project-memory-v1.json`, `library/index.json` | The task / note / picture |
| File names | Registered projects | The file in the Files panel |
| Text inside files | Registered projects | The line in the Files panel |
| Work steps and command output | `<id>.steps.jsonl` | The reply, steps open, that step marked |
| Archived and trashed threads | Same stores, behind two switches | See Task 11 |

Search covers **saved history**. Deck shortens long command output (first and last 6,144 bytes) and can drop steps past 2,000 per reply (`crates/apex-core/src/work_steps.rs:9-21`). The panel says so under Work steps; never describe step search as complete.

## What changed since revision 1

1. **Who may search.** Revision 1 made `search` an open read. Now a connection must first open search with a proof the daemon can check for that kind of connection (Task 1 has the table). No open, no search.
2. **Exact jumps.** A hit carries the message's stable identifiers; position is only a checked fallback. Steps resolve by their saved `key`.
3. **Honest coverage.** "Saved history" wording; the matcher runs on parsed records, never on raw JSON bytes; names come from every daemon, not from lists the desktop happened to load.
4. **Bounded work.** Cache freshness, memory, queueing and child-process cleanup are specified and tested. The steps benchmark moves to Part 4, where the step reader exists.
5. **File scope.** Registered projects only, canonical roots, no symlink escapes, one secret-file rule for Git and non-Git folders.
6. **Counts.** Known totals and capped totals are shown differently; overflow has a defined path.
7. **Mockup decisions** from the design review (three rows per group, newest first, offline wording with Retry, one chip row, focus stays in the field).

## What changed since revision 2

Null's preflight and Asstra's second review found two faults in Task 1. Both are fixed there.

1. **Remote machines were locked out.** Adding `search_open` to the desktop's protected list made Desktop refuse it for every remote machine before picking a transport (`desktop/main.mjs:370`). Now Desktop attests `search_open` only for its own machine and forwards it untouched to a remote one, which checks the caller itself. This is what `room_*` and `devices_*` already do in `needsAttestation`.
2. **The grant was a bearer token.** Anyone holding the string could search or cancel. There is no token now. The grant is a mark on the daemon connection that opened it, keyed by an id the daemon makes for each connection and never reads from a command. Another connection has nothing to present, so it cannot use or cancel it. Closing the connection ends the grant and its scans.
3. **SSH.** The VPS (Apex-Terminal) is connected over SSH today, so "SSH: unavailable" would leave it out of search. On Linux, search joins the terminal app's existing typed surface (`Policy::PROTECTED_TERMINAL`): admitted only when the agent jail passed its startup check, the same rule that already lets that route approve tool calls. A remote **Mac** over SSH has no such proof and reports "Search needs this machine paired".
4. **Three tests added** from Asstra's second review: a transcript changing during a cache read (Task 2), a disconnect during a running scan (Tasks 1 and 2), and the Git prefilter keeping Unicode matches (Task 8).

## What changed since revision 3

1. **No search over SSH, on any system.** Revision 3 put `search_open` on the Linux terminal surface (`PROTECTED_TERMINAL`). Asstra's review was right that the jail verdict says confinement passed, not who is asking: a Full-access agent on that machine could open its own grant. That also contradicts the standing rule from 2026-10-30 that the paired device is the identity on Linux. Built: `SearchOpen` is `Policy::PROTECTED` and is not on the terminal surface. A machine reached over SSH answers `SEARCH_NEEDS_PAIRING` and the panel shows "*machine* needs pairing to search". Apex-Terminal is on SSH today, so it stays out of search until it is paired. Step 0 (the VPS jail check) is no longer needed. The route table in Task 1 is kept as written for history; read its SSH-on-Linux row as "refused: `SEARCH_NEEDS_PAIRING`".
2. **The benchmark opens a grant.** Task 3 said "through `Host::call`", which is refused by design. It runs through `Host::call_from` with three session ids on the isolated test host.
3. **`src/commandBackend.ts` moves to Task 4.** The three client calls are added with the model that uses them. Part 1 regenerates `src/generated/protocol.ts` so the commands are typed.
4. **Tests live beside the module** (`crates/apex-host/src/search/admission_tests.rs`, `content_tests.rs`, `crates/apex-daemon/src/protocol_search_tests.rs`) instead of `crates/apex-host/tests/`, because the refusals must run on a production-gated host, which integration tests cannot build.

## What changed since revision 4 (Part 2 as built, 2026-11-22)

Built by Gayble in the agent copy, uncommitted; no PR yet. Files: `src/globalSearch.ts`, `src/SearchDeck.tsx`, `tests/global-search.test.mjs`, `tests/search-deck.test.mjs`, and edits to `src/App.tsx`, `src/ChatPane.tsx`, `src/TalkOnlyChat.tsx`, `src/SettingsPage.tsx`, `src/Sidebar.tsx`, `src/shortcuts.ts`, `src/styles.css`, `desktop/browser-keys.mjs`.

Rulings made while building:
1. **No new `Backend` methods.** Search goes through the existing `Backend.call` and `supports` (a `SearchPort`), so the demo and preview backends need no stubs. `src/commandBackend.ts` is unchanged.
2. **Chips are All · Threads · Messages · Settings.** Files and More (Tasks, Notes, Library, Work steps, scope, Archived, Trash) arrive with Parts 3 and 4, when their results can be opened. Part 2 asks the daemon only for project, thread, agent and message.
3. **Show all** re-asks that machine for up to 200 of the one kind (first answer carries 20 per kind).
4. **Assistant conversations** are hidden from the results until a hit can land on the exact reply (Null's Part 2 review). The daemon still searches them; `reduceSearch` drops the hits and corrects the Messages count.
5. **A project hit** opens only a project already in this window's sidebar; otherwise a note says to add it. **An agent hit** opens the Agents section.
6. **A trashed thread** is not opened; a note points at Trash (Task 11 owns restore).
7. **The speaker check** in `resolveMessage` compares "you or an agent", not the agent's name: the transcript holds agent ids and the hit holds a display name.
8. `MachineState` gains `needs_pairing`. `SearchView` also carries `run`, `query` and `parts`.
9. `shortcutFor` now matches modifiers when two bindings share a key (⌘P searches, ⌥⌘P pins).

Not done: Task 7's run against a real daemon (the component test uses scripted machines); light and glass screenshots; 900-wide screenshot; live check in the installed app, which needs PRs #58 and #59 merged and a new build.

### Part 2 review fixes (Null, 2026-11-22)

- **Exact jumps.** A hit that carries a saved id (`clientMessageId` or `originSeq`) resolves by that id or reports "changed"; it never falls back to its old position. Only a hit with no id uses the position, and then the speaker must be the same agent by name and the text must still match. Limit: replies in project (work) threads carry no id today, so for them the checked position is the only anchor.
- **Stale queries.** `ask` rechecks the run after `search_open` returns and before it re-opens after a refusal, so an older query or a closed panel never dispatches a scan.

## Global Constraints

- A missing result is never silent: every unreachable, outdated, skipped, timed-out or capped source is named in the panel.
- Search never writes: no index, no change to any saved file, never the clipboard (stub it in every check).
- No store is read before the connection's grant is verified.
- Typing never blocks: scans run under `spawn_blocking`; a newer query on the same connection and lane cancels the older one, including its `git grep` child, which is killed and waited on.
- Clean cut-over: no fallback for old daemons. A machine without `search_open` shows "needs an update".
- New subsystem, own module and state (`crates/apex-host/src/search.rs`, `search/`); Host only admits and wires.
- UI rows are plain: no boxed rows, no one-sided coloured edges. Use `--bg`, `--panel`, `--line`, `--text`, `--radius`.
- User-facing words: "agent" (never "bot"), "machine", "saved history".
- Before every PR: `npx tsc --noEmit`, `npm test`, `TMPDIR=/tmp cargo test -p apex-host -p apex-core -p apex-daemon`. Linux: Docker, `--lib -j 3`.
- Never run a settings or search check against the real data folder; use a throwaway `APEX_DECK_DATA_DIR`.

## Review Focus

Each line names the task that owns its test.

1. **A caller without proof reads nothing.** Mac local socket with no receipt, the WebSocket token route, an in-process call, Apex Code Mode, the personal worker, a thread-limited phone, an expired grant, and a second connection trying to use or cancel the first one's grant: all refused before any file is opened. Task 1.
   - Stated limit, not a gap to close here: on Linux a Full-access agent runs as the same user and can already read the saved files; agents below Full are jailed and cannot reach the socket. Search does not widen what either can read.
2. **Two messages contain the same words.** Clicking the second hit lands on the second message, also after the thread was curated between search and click. Tasks 2 and 6.
3. **A thread changes while it is searched.** A rewritten file of the same size is re-read; a half-written file is reported as skipped; a thread trashed since the last query disappears on the next one even from a warm cache. Task 2.
4. **Typing fast.** `installer` typed letter by letter leaves at most one scan and zero `git grep` children once the last answer arrives; a closed window or dropped connection frees its scans and children. Tasks 1, 2 and 8.
5. **A tracked secret file.** A committed `.env` or key file produces no text hit in Git and non-Git folders alike; a symlink pointing out of the project yields nothing. Task 8.

---

## Part 1: Daemon search core (one PR, deep review: it reads every thread)

Branch `feat/search-deck-daemon`.

### Task 1: Grant and admission

**The rule:** a grant belongs to one daemon connection. `search_open` marks the connection after a proof the daemon can verify for that kind of connection. `search` and `search_cancel` carry no token; the host looks up the caller's own connection. Nothing a client sends can name another connection.

**Proof per route** (the "arrives as" column is `Trust` in `crates/apex-daemon/src/protocol.rs:247`):

| Route | Arrives as | Proof the daemon checks | Result |
|---|---|---|---|
| Desktop to its own Mac or Windows daemon | `Trust::Local` | `ProvenanceExecute` receipt signed by the broker for `search_open`, as for every protected command today | granted |
| Desktop or phone over a paired link, Linux machine | `Trust::Device` | transport-authenticated endpoint, live registry entry, trust epoch, confinement, `full(Global)`: `authorize_linux_device`, then `call_from_confined_device` | granted |
| Desktop or phone over a paired link, Mac machine | `Trust::Device` | same registry and tier check, plus the device receipt in `call_from_device` (`consume_device`) | granted |
| Desktop over SSH, or the terminal app, Linux machine | `Trust::Local` on the remote | recorded jail probe is `Works`: `local_linux_cli_admitted`, then `call_from_local_linux_cli` | granted; refused with the existing jail message otherwise |
| Desktop over SSH, Mac or Windows machine | `Trust::Local` on the remote | none available (no receipt can be made remotely) | refused: `SEARCH_NEEDS_PAIRING` |
| WebSocket token, in-process `Host::call`, agent tools | `Trust::Token` or no connection | none | refused |

Do not add any new exemption. Every row uses a check that exists on `origin/main`.

**Files:**
- Create: `crates/apex-host/src/search.rs` (module root, `Search` state), `crates/apex-host/src/search/grant.rs`
- Modify: `crates/apex-host/src/lib.rs`, `host.rs` (field + constructor, as `thread_git` is wired), `command.rs` (three variants near `FileSearch`; `policy()`; the four entry points and `dispatch_command` gain the caller's connection id), `crates/apex-daemon/src/protocol.rs` (pass the connection id; close it when `serve` ends), `crates/apex-daemon/src/authority.rs` (`command_needs` and the access-effect match), `desktop/provenance.mjs`, `src/commandBackend.ts`
- Test: `crates/apex-host/src/search/grant.rs` (unit), `crates/apex-host/tests/search_admission.rs`, `crates/apex-daemon/src/protocol_device_access_tests.rs`, `tests/provenance.test.mjs` (or the file that already tests `needsAttestation`)

**Interfaces (produces):**
```rust
// command.rs — follow FileSearch's argument casing. No grant argument anywhere.
SearchOpen {}                          // Policy::PROTECTED_TERMINAL -> { ttl_ms: u64 }
Search { request: SearchRequest }      // Policy::OPEN, refused unless this connection holds a live grant
SearchCancel { lane: SearchLane }      // Policy::OPEN, same; cancels only this connection's lane

// The connection id. protocol.rs already makes one per `serve()` call
// (`phone_session`, line 430); rename it `session` and pass it for every
// trust class. It is supplied by the daemon and is not a field of Command,
// so no frame and no receipt can set it.
pub struct Caller { pub capability: GeneratedUiCapability, pub session: Option<Arc<str>> }
// `Host::call` and every other in-process caller pass `session: None`.

// search/grant.rs
pub struct Grants { /* Mutex<HashMap<Arc<str>, Instant>> keyed by session */ }
impl Grants {
    pub fn open(&self, session: &Arc<str>);                      // one per session; re-open renews
    pub fn check(&self, session: Option<&Arc<str>>) -> Result<(), String>; // renews the idle clock
    pub fn close(&self, session: &Arc<str>);                     // drop the grant
}
impl Search {
    /// Called by the daemon when `serve` ends for any reason. Drops the grant,
    /// cancels this session's scans in every lane, kills and waits on children.
    pub async fn close_session(&self, session: &Arc<str>);
}
pub const GRANT_IDLE: Duration = Duration::from_secs(30 * 60);
pub const SEARCH_REFUSED: &str = "Search needs to be opened from the Apex Deck app on a trusted device.";
pub const SEARCH_NEEDS_PAIRING: &str = "Search needs this machine paired. It is connected over SSH, which cannot prove the Apex Deck app is asking.";
```
Device tier for all three: `full(Global)`, checked by the daemon on every command and again on delivery, as for any device command. Grants live in memory only and die with the daemon. There is no cap that evicts another session's grant; the number of grants is bounded by the number of connections.

Desktop: `protectedCommands` gains `search_open`, and `needsAttestation(cmd, remote)` returns `false` for `search_open` when `remote` (add it to the existing remote list beside `devices_add`). The comment there already states the rule: a remote host enforces its own grant boundary.

Mac and Windows over SSH: `call_with_client_capability` refuses `SearchOpen` with the general receipt message. Map that to `SEARCH_NEEDS_PAIRING` when the session is a local one without a receipt, so the panel can show "Needs pairing to search" for that machine instead of an error.

- [ ] **Step 0: Preflight on the VPS, before any code.** Over the user's open SSH session (see the SSH ControlMaster note), read whether Apex-Terminal's recorded jail probe is `Works` (`apex-daemon doctor`, or the log line the probe writes at start). Read only. If it is `Fails` or missing, stop and report: SSH search on the VPS would be refused and the Human should choose between pairing the VPS and fixing the jail.
- [ ] **Step 1: Write failing admission tests** through the real entry points (not the `assuming_verified_ui_for_test` helpers, and not a `test_support::isolated` folder, which skips the receipt gate):
  - `search_open_without_receipt_is_refused` (non-Linux): `SearchOpen` with a session and no receipt errors; no grant exists afterwards.
  - `search_without_grant_is_refused_before_any_read`: seed a rooms folder made unreadable (mode 000); `Search` from a session with no grant returns `SEARCH_REFUSED`, not an I/O error.
  - `in_process_call_has_no_session_and_is_refused`: `Host::call(Search { .. })`.
  - `second_session_cannot_search`: session A opens; `Search` from session B returns `SEARCH_REFUSED`.
  - `second_session_cannot_cancel`: A has a scan held open by a test gate; `SearchCancel` from B is refused and A's scan is still running; then A's own `SearchCancel` stops it.
  - `expired_grant_is_refused`, `grant_renews_on_use` (inject the clock).
  - `closing_a_session_drops_its_grant_only`: A and B both open; `close_session(A)`; A refused, B still searches.
  - `receipt_for_search_open_marks_the_executing_session`: a `ProvenanceExecute` for `search_open` run by session A gives A the grant and B nothing. The receipt is one-use already (`apex_provenance::io::consume`); assert a replay from B fails.
  - In `authority.rs` tests: all three need `Tier::Full` + `Scope::Global`; a Full device limited to some threads is refused; ReadOnly and Chat devices are refused.
  - In the Node tests: `needsAttestation('search_open', false)` is true and `needsAttestation('search_open', true)` is false.
- [ ] **Step 2: Run** `TMPDIR=/tmp cargo test -p apex-host search_ -p apex-daemon search_`; expect failures for missing variants.
- [ ] **Step 3: Implement** the variants, policy, `Caller` plumbing, authority rows, `Grants` and the desktop change. `Search` returns an empty reply for now. In `protocol.rs::serve`, hold a guard whose drop runs `close_session` so every return path (`Closed`, `Revoked`, `Refused`, a lagged resync) is covered.
- [ ] **Step 4: One daemon-level test per route in the table**, driving `protocol::serve` with the matching `Trust`: paired device on the Linux policy, paired device on the Mac policy, local Linux caller with the probe recorded `Works`, the same with `Fails`, local caller on the Mac policy without a receipt, `Trust::Token`. Each asserts granted or the exact refusal. Then two cross-session tests at this level: two `serve` sessions on one daemon, the second cannot `search` or `search_cancel` against the first; and a device revoked mid-session (`Ended::Revoked`) loses its grant. If the Linux paired route refuses, stop and report; do not weaken the policy.
- [ ] **Step 5: Disconnect during a scan.** With a scan held open by a test gate, end the `serve` input stream. Assert the scan's cancel flag is set, no result is delivered, and (once Task 8 exists, extend this test there) no `git grep` child is left.
- [ ] **Step 6: Prove agents are out.** Add tests that the Apex Code Mode operation list (`crates/apex-adapters/src/api_tools/code_mode.rs`) and the personal worker's tool list (`crates/apex-host/src/personal_worker/`) contain no path to `Search*`. State in the PR exactly which callers were tested and which were only read.
- [ ] **Step 7: Live acceptance, recorded in the PR with outputs.** From the installed Desktop (or a signed dev build with a throwaway data folder for the local machine): (a) local Mac: open, search, receive an empty reply; (b) Apex-Terminal over SSH: the same; (c) STREAMVAULT over its paired link: the same. For each route, open a second connection (a second window is one) and show it is refused for `search` and `search_cancel` until it opens its own grant. Any route you could not run is listed as "not run", with the reason.
- [ ] **Step 8: Measure** the time from `search_open` sent to the reply on each route (10 runs). Budget 300 ms median on the local Mac. Over budget: report before Part 2, because it delays the first results after focusing the field.
- [ ] **Step 9: Run all three test commands; commit.**

### Task 2: Content lane (names, messages, tasks, notes, pictures)

**Files:**
- Create: `crates/apex-host/src/search/query.rs`, `search/cache.rs`, `search/content.rs`, `search/lanes.rs`
- Test: unit tests beside each file; `crates/apex-host/tests/search_content.rs`

**Interfaces (produces; later tasks and the clients rely on these names):**
```rust
pub enum SearchLane { Content, Steps, Files }
pub enum SearchKind { Project, Thread, Agent, Message, Task, Note, Library, FileName, FileText, Step }
pub struct SearchRequest {
    pub lane: SearchLane, pub query: String, pub kinds: Vec<SearchKind>,
    pub include_archived: bool, pub include_trashed: bool,
    pub project: Option<String>,   // a registered project path, matched against ProjectList, never opened as given
    pub limit: usize,              // per kind; default 20, max 200
}
pub struct SearchReply { pub hits: Vec<SearchHit>, pub totals: BTreeMap<SearchKind, Total>,
                         pub skipped: Vec<Skipped>, pub took_ms: u64 }
pub struct Total { pub count: usize, pub exact: bool }      // exact=false when a cap or deadline cut counting short
pub struct Skipped { pub source: String, pub reason: SkipReason }
pub enum SkipReason { MissingFolder, Unreadable, BeingWritten, Deadline, Cap, Busy }
pub struct SearchHit { pub kind: SearchKind, pub title: String, pub snippet: String,
    pub ranges: Vec<(usize, usize)>,   // matched spans in `snippet`, in chars
    pub at: Option<u64>, pub project: Option<String>, pub room_title: Option<String>,
    pub archived: bool, pub trashed: bool, pub target: SearchTarget }
pub enum SearchTarget {
    Project { path: String }, Agent { id: String }, Room { room: String, room_kind: String },
    Message { room: String, room_kind: String, seq: usize, origin_seq: Option<usize>,
              client_message_id: Option<String>, speaker: String },
    Step { room: String, seq: usize, origin_seq: Option<usize>, step_key: String, output_cut: bool },
    Task { id: String }, Note { id: String, project: Option<String> }, Library { file: String },
    File { project: String, path: String }, FileLine { project: String, path: String, line: usize },
}
// query.rs — the ONE matcher every lane uses
pub struct Query { /* lower-cased terms and phrases */ }
impl Query { pub fn parse(raw: &str) -> Result<Query, String>;
             pub fn matches(&self, text: &str) -> Option<Vec<(usize, usize)>>;
             pub fn longest_literal(&self) -> &str; }
pub fn snippet(text: &str, ranges: &[(usize, usize)], max_chars: usize) -> (String, Vec<(usize, usize)>);
```

**Rules the tests pin:**
- Query: 2 to 200 characters. Case-insensitive (Unicode lower-casing). Space-separated words must all appear in the same item. `"quoted words"` match as a phrase. No regex, no fuzzy matching.
- Order within a kind: names by exact, then prefix, then substring; everything else newest first.
- Snippet: 160 characters, starts up to 40 characters before the first match, cut on character boundaries, `…` at a cut end.
- Names are matched by the daemon (project name and path, thread and chat titles, agent names) so remote machines' names are covered. Archived and trashed titles follow the two switches.
- Permanently deleted threads (`lifecycle-v1.json` `deleted_threads`) are never returned.
- Cache: message text per file, keyed by path with length, modified time in nanoseconds and file identity (inode on Unix, file index on Windows). Confirm in `storage.rs` that transcripts are written by temp file and rename; if any writer edits in place, add a content hash to the key and say so. A file that fails to parse is `Skipped { BeingWritten }` and is retried next query. Cap 64 MiB of text, least recently used dropped.
- Visibility (archived, trashed, deleted) is read fresh on every query and applied after the cache, never stored in it.
- Concurrency: per lane, at most two scans run at once across all connections; each connection and lane holds one running and one waiting request; a newer request replaces the waiting one and cancels the running one. A replaced request answers `Skipped { Busy }`, which the client drops. Cancellation is checked between files.

- [ ] **Step 1: Failing unit tests for `Query` and `snippet`**: `all_words_must_appear`, `phrase_matches_in_order_only`, `case_and_unicode` (`"ÉCOLE"` finds `"école"`), `rejects_one_character`, `snippet_centres_on_first_match`, `snippet_cuts_on_char_boundary` (emoji and CJK), `ranges_point_at_the_matches`.
- [ ] **Step 2: Failing fixture tests in `search_content.rs`** over a temp data folder: `finds_message_newest_first`; `duplicate_phrase_yields_two_hits_with_distinct_targets`; `limit_sets_exact_false`; `archived_and_trashed_hidden_until_asked`; `deleted_thread_never_returned`; `assistant_conversation_hit_has_assistant_room_kind`; `same_size_rewrite_is_reread`; `half_written_file_is_skipped_and_reported`; `file_replaced_during_cache_read_is_not_served_stale` (a test hook swaps the transcript between the cache's stat and its read: the answer holds the new text or `Skipped { BeingWritten }`, never the old text under the new key, and the next query is correct); `session_closed_during_scan_delivers_nothing` (the scan stops between files and its result is dropped); `trashing_a_thread_hides_it_on_a_warm_cache`; `remote_style_names_found` (project, thread, agent with no message match); `newer_request_cancels_older`; `third_window_waits_then_runs`; `task_note_and_library_hits_carry_their_ids`.
- [ ] **Step 3: Run; expect failures.**
- [ ] **Step 4: Implement** `Query`, `snippet`, the cache, the lane scheduler and the content scan.
- [ ] **Step 5: Run all three test commands; commit.**

### Task 3: Content benchmark (decides whether "no index" stands)

**Files:** `crates/apex-host/src/test_support.rs` (store generator), `crates/apex-host/tests/search_bench.rs` (`#[ignore]`, run by hand)

- [ ] **Step 1:** Generator writes N threads of realistic transcripts plus one assistant file into a temp folder.
- [ ] **Step 2:** Measure through `Host::call`, cold and warm, three connections querying at once, 50 queries each. Record p50, p95 and peak resident memory (process RSS, not cache size).
  - **Gate A**, 30 MB store (today's size): warm p95 at most 150 ms.
  - **Gate B**, 200 MB store (larger than the cache): p95 at most 1.5 s; RSS growth at most 150 MiB.
- [ ] **Step 3:** Run on the Mac and in the Linux Docker image. Paste the numbers into the PR.
- [ ] **Step 4:** Either gate fails: stop. Bring the numbers and the saved-index option (SQLite FTS) back to the Human. Do not add an index on your own.

Real VPS and Windows timings stay "not measured" until someone runs them there; write that in the PR.

## Part 2: Desktop field with names, settings and messages (one PR: Tier 1 usable)

Branch `feat/search-deck-desktop`. Starts when Part 1 is merged.

### Task 4: Search model (pure TypeScript)

**Files:** Create `src/globalSearch.ts`, `tests/global-search.test.mjs`. Modify `src/commandBackend.ts` (`searchOpen()`, `search()`, `searchCancel()` beside `fileSearch`).

**Interfaces (produces):**
```ts
export type MachineState = "searching" | "ok" | "offline" | "needs_update" | "refused";
export interface MergedHit extends SearchHit { machineId: string; machineName: string; key: string } // key = `${machineId}:${kind}:${target id}`
export interface SearchView { groups: { kind: GroupKind; hits: MergedHit[]; total: number; exact: boolean }[];
  machines: { id: string; name: string; state: MachineState }[]; notes: string[] }
export function reduceSearch(view: SearchView, event: SearchEvent): SearchView;
export function groupOrder(): GroupKind[]; // Projects, Threads, Agents, Messages, Settings, Tasks, Notes, Library, Files, In files, Work steps
export const ROWS_PER_GROUP = 3;
```
Fan-out copies `src/LibraryView.tsx:50-68`: one daemon connection per machine per window (as `desktop/hostLinks.mjs` already keeps), one `search_open` per connection, one request per machine per lane, merged as each answers. The client holds no token. After a reconnect, or a `SEARCH_REFUSED` answer, it sends `search_open` once and retries the query once. `SEARCH_NEEDS_PAIRING` sets the machine's state to `needs_pairing`, shown as "*machine* needs pairing to search".

- [ ] Tests first: group order; three rows then the rest behind Show all; hits from two machines with the same room id stay separate; an answer for an older query is dropped; `Busy` answers are dropped; each machine state; `needs_update` when a machine rejects `search_open` as unknown; `needs_pairing` on `SEARCH_NEEDS_PAIRING`; one re-open and one retry after `SEARCH_REFUSED`, never a loop; "Show all 6" when `exact`, "Show more" when not; at 200 results the note "Showing the first 200. Add a word to narrow it."; recent places (5) and recent searches (5, with Clear) kept per window in local storage.
- [ ] Implement; run `npm test`; commit.

### Task 5: Field and panel

**Files:** Create `src/SearchDeck.tsx`, `tests/search-deck.test.mjs`. Modify `src/Sidebar.tsx` (field in `.rail` above `.rail-scroll`, near 327), `src/styles.css`, `src/shortcuts.ts`, `desktop/browser-keys.mjs`.

Behaviour, taken from `mockups/search-deck/desktop.html`:
- Field label **Search Deck…**. The panel is drawn through a portal on `document.body` (a glass card's `backdrop-filter` squeezes fixed children), 640 px wide over the main area.
- One chip row: **All · Threads · Messages · Files · Settings · More**. More holds Tasks, Notes, Library, Work steps, the scope switch (Everywhere / This project) and the two switches from Task 11.
- Row: title or snippet with matches highlighted; under it project · thread · speaker; time on the right. No type word in the row. Machine name only when more than one machine is set up.
- Status lines: "Hetzner is offline · not searched" with **Retry**; "Hetzner needs an update before it can be searched"; "Still searching files…"; "2 projects skipped: folder missing".
- Keys: **⌘P** focuses the field (Ctrl+Shift+P on Windows and Linux; ⌥⌘P stays Pin). Focus never leaves the field: ↑ ↓ move a highlighted row, the first hit is preselected, Enter opens it, Escape closes and returns focus to where it was.
- Wait 150 ms after the last keystroke before asking daemons. Settings match locally at once.

- [ ] Tests first: arrow keys keep `document.activeElement` on the field; first row preselected; Enter opens it; Escape restores prior focus; chips filter; Retry re-asks only that machine.
- [ ] Render it offscreen and look at it at 1440 and 900 wide in light, dark and glass before wiring it into the sidebar. Attach the screenshots.
- [ ] Implement, wire in, run `npx tsc --noEmit` and `npm test`; commit.

### Task 6: Jump to the exact message

**Files:** `src/App.tsx` (`focusPane`, `openAssistant`, new `revealMessage` request passed to panes), `src/ChatPane.tsx` (`jumpToMessage` takes a target; rows are keyed `data-seq`), `src/globalSearch.ts`, `tests/global-search.test.mjs`.

```ts
export function resolveMessage(messages: Message[], t: MessageTarget, query: Query):
  { seq: number } | { changed: true };
```
Resolve order: (1) `clientMessageId` equal; (2) `originSeq` equal; (3) `seq`, only if that message has the same speaker and still matches the query; otherwise `{ changed: true }`, which opens the thread at its end and shows "That message has changed since the search." Never guess between two candidates.

- [ ] Tests first: `duplicate_phrase_lands_on_the_clicked_one`; `curated_thread_resolves_by_origin_seq`; `old_message_without_ids_uses_checked_seq`; `deleted_message_reports_changed`.
- [ ] Implement. The landed message gets a two-second outline that fades (the phone mockup's treatment). Work threads, chats and assistant conversations all open; a new pane lands where a newly opened pane lands today (`paneArrangement.ts`).
- [ ] Commit.

### Task 7: Part 2 acceptance

- [ ] Hidden second Deck against a fixture daemon (see the real-server acceptance recipe) seeded with *Installer QA*, *Release handoff* and a second message containing the same phrase. Type `installer`; screenshot the panel; Enter on the second duplicate; screenshot the outlined message. Repeat with one machine unreachable; screenshot the status line and Retry. Clipboard stubbed. Record outputs in the PR.

## Part 3: Tier 2 targets and file names (one PR)

Branch `feat/search-deck-tier2`.

### Task 8: Files lane

**Files:** Create `crates/apex-host/src/search/files.rs`. Modify `crates/apex-host/src/project_files.rs` (make `find` at 485 and the Git and walk search at 554-649 callable with a cancel flag and a deadline). Test: `crates/apex-host/tests/search_files.rs`.

**Rules the tests pin:**
- Roots come only from `ProjectList` entries that are not removed. `request.project` is compared with `path` and `aliases`; nothing from the client is ever opened as a path.
- Each root is canonicalised when scanned. Every returned path is canonicalised and must sit under its root; anything else is dropped. Nested projects are searched once, under the innermost.
- Secret files never give text hits, in Git and non-Git folders alike: `.env`, `.env.*` and `*.env` (except `.env.example`, `.env.sample`, `.env.template`), `*.pem`, `*.key`, `*.p8`, `*.p12`, `*.pfx`, `*.keystore`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `credentials.json`. Their names may still appear as file-name hits, as they do in the Files panel.
- Text in files: all words on the same line. Ask `git grep -F -i -I` for `query.longest_literal()`, then keep only lines `Query::matches` accepts. Binary files are skipped. Three-character minimum.
- Four projects at a time; at most 20 name hits and 20 text hits per project (`Skipped { Cap }`); 10-second deadline, then return what exists with `Skipped { Deadline }`. Missing folders give `Skipped { MissingFolder }`. The three reasons are reported separately.
- On cancel, deadline, grant expiry or a closed connection the child is killed and waited on.
- The Git prefilter must never drop a line the final matcher accepts. `git grep -i` folds case by the process locale, so non-ASCII letters may not fold. If `longest_literal()` contains any non-ASCII character, skip the Git prefilter for that query and use the walk with `Query::matches`; say so in the PR.

- [ ] Tests first: `unregistered_root_is_ignored`; `symlink_out_of_project_yields_nothing`; `tracked_env_file_gives_no_text_hit` (Git) and the same for a non-Git folder; `nested_checkout_searched_once`; `missing_folder_reported`; `binary_file_skipped`; `two_words_must_share_a_line`; `caps_and_deadline_reported_separately`; `cancel_leaves_no_child` and `closed_session_leaves_no_child` (assert the process is gone); `unicode_query_matches_in_git_and_plain_folders` (`ÉCOLE` finds a tracked line containing `école`, and the result equals the non-Git folder's); `windows_path_hit_parses` (`C:\repo\a.rs:12:`).
- [ ] Implement. This PR switches on `FileName` only; `FileText` is built and tested here, switched on in Part 4.
- [ ] Commit.

### Task 9: Open the thing

**Files:** `src/WorkspaceTasksScreen.tsx` (select a given task), `src/ProjectMemoryPanel.tsx` and `src/PersonalPanels.tsx` (show a given note), `src/LibraryView.tsx` (view a given item on a given machine), `src/RightFiles.tsx` (`revealSearchResult` callable from App), `src/SettingsPage.tsx` (open on a setting and mark it), `src/rightPanelModel.ts`.

- [ ] One test per target that the right item is selected after the jump, including switching the active project and machine first.
- [ ] Acceptance screenshots for all five targets against the fixture daemon; commit.

## Part 4: Tier 3 (one PR)

Branch `feat/search-deck-tier3`.

### Task 10: Text in files and work steps

**Files:** Create `crates/apex-host/src/search/steps.rs`. Modify `src/WorkSteps.tsx` (open expanded with one step marked), `src/SearchDeck.tsx`. Test: `crates/apex-host/tests/search_steps.rs`, extend `search_bench.rs`.

- Steps lane reads each `<id>.steps.jsonl` line by line and **parses every record** into label, detail and output before `Query::matches` runs. No raw-byte shortcut in this version. If the benchmark needs one, it ships only with a test proving it never rejects a line the parsed matcher accepts (quotes, backslashes, `\u` escapes, non-ASCII, mixed case).
- A hit carries the step's saved `key` and its reply; the client opens the reply, expands its steps and marks the step with that key. Key missing from the reply: open the reply and show "That step is no longer saved."
- Rows whose output was shortened show "output shortened" in the sub-line. The Work steps group carries the footnote "Searches saved steps. Long outputs are saved shortened."
- Text in files: switch on `FileText`, 400 ms typing pause, "Still searching files…" while it runs; rows show path, line number and the line.

- [ ] Tests first: `escaped_quote_and_backslash_queries_match`; `non_ascii_and_mixed_case_match`; `label_detail_and_output_all_searched`; `hit_names_the_right_reply_and_key`; `dropped_step_reports_no_longer_saved`.
- [ ] Implement.
- [ ] **Steps gate:** generated 1 GB step store, three connections at once: p95 at most 2.5 s per 115 MB scanned, RSS growth at most 150 MiB. Fails: stop and return to the Human with the numbers.
- [ ] Commit.

### Task 11: Archived and Trash switches

- Under More: **Include archived** (off) and **Include Trash** (off).
- An archived hit opens the thread, which restores it, as the Archived menu does today.
- A trashed hit shows "In Trash" and asks: "Restore this thread to open it? Restoring puts it back in *project* on *machine* and opens it." Buttons use Deck's dialog style.
- [ ] Tests: nothing is restored without a yes; Cancel leaves the thread in Trash; the prompt names project and machine.
- [ ] Commit; acceptance screenshots.

## Part 5: Phone (one PR, after the Human passes the desktop parts)

Branch `feat/search-deck-phone`.

### Task 12: Phone search

**Files:** Create `src/phone/PhoneSearch.tsx`; entry at the top of `src/phone/ThreadList.tsx`. Reuses `src/globalSearch.ts` and the same commands per machine, as `PhoneLibrary.tsx` does.

From `mockups/search-deck/phone.html`: entry on the Threads tab only; no "This project" scope; plain rows with one state dot; message snippets up to two lines, centred on the match; every tap target at least 44 pt; the offline line is the last row of the list with Retry; Back returns to the results with the query kept; the keyboard drops on scroll or **search**. File hits open the phone's file view where one exists, otherwise show the path.

- [ ] Check against a throwaway daemon in the shared simulator (`"$APEX_DECK_BIN" phone help` first); screenshots of results, a jump, the offline row and the restore sheet.
- [ ] TestFlight build 41 or later. Real-iPhone, VoiceOver and light-theme checks stay "not done" until the Human runs them.

## Rollout

Each Part is its own branch, PR, review and Human test, in order. The Mac gets each Part with the next build; the VPS updates from tags and shows "needs an update" until then. Nothing changes saved data, so each Part can be reverted alone.

## Decisions the Human can overrule

0. **SSH machines.** Built as: no search over SSH; the machine asks to be paired. Apex-Terminal is left out until it is paired. The looser alternative (a Linux machine on SSH is searchable when its agent jail passed its startup check) is one line in `Command::policy` plus the terminal surface, but it lets a Full-access agent on that machine search.

1. **⌘P** opens search.
2. **Archived and Trash are off** by default; restoring from Trash always asks.
3. **Text in files** searches every project, 20 lines per project.
4. **Phone last.**
5. **No saved index** unless a benchmark gate fails.
6. **Search follows the device table as it stands.** Today that means a phone limited to some threads cannot search at all, rather than getting a filtered search. If phone access levels are removed (`2026-11-20-remove-phone-access-levels.md`), every paired phone can search and the thread-limited test goes with them.
