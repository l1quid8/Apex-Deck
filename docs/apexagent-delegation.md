# ApexAgent delegation

ApexAgent is the project assistant. Thread agents do the delegated work.
Assign a responsibility and choose its reasoning profile on the setup screen;
the profile remains editable afterward without losing sources or history.

## Assistant dock

Open ApexAgent from its button or floating widget. The resizable dock sits beside
your shared chats; drag its left edge or focus the separator and use the arrow
keys. Expand opens a focused workspace, and Return to dock restores the chat.
The widget stays visible, turns green while open, and can collapse the dock.
In a narrow window the dock takes the available space. Opening a linked worker
chat closes the dock to show that chat; closing the dock restores your sidebar.

Chat contains the conversation and a compact Needs you queue. Tasks groups work
by state and opens a single task for review. Activity keeps recorded attempts,
notes, and monitor checks. Settings edits the assignment and watched sources;
Thinking with chooses the assistant's reasoning profile without changing worker
profiles. Unsent task messages stay with their task when you switch views.

## Task workflow

Send an ordinary message, name a saved chat and bot, or choose a destination.
A clear human request can start work. Suggestions wait for Approve; ambiguous
requests wait for clarification. A uniquely named available worker can receive
work in a new chat; explicit routing choices also let you choose its worker.
A worker incompatible with a named chat requires your routing choice. The task
keeps the original request beside the assistant's brief.
Immediate conversation does not replace the periodic monitoring responsibility.

Each task has a linked execution thread, run attempts, review diff, exact check
commands and their outputs, and usage when the provider reports it.
Missing usage is shown as Unknown. Worker approvals and questions appear in
the task detail and linked chat. Answer every question in a multi-question
request; a single question can also be answered in the task composer. Closing
the dock or linked pane detaches the view;
Cancel stops the owned worker process group and retains existing edits.

Opening a task gives the composer that task's context: a review-ready result
receives Request changes, and working tasks receive notes queued for the next
continuation. New message returns to the assistant conversation. Acceptance is
available only inside current task detail after reviewing its result and criteria.

Read only forces worker read access, takes no checkout writer reservation, and
works without Git. Its findings use Mark reviewed. Custom CLI workers cannot
enforce this mode and require a supported adapter. Read-only tasks do not run
verification commands.

An optional USD spend limit pauses at the CLI-reported estimated cost.
[Claude Code's cost report is a client-side estimate](https://code.claude.com/docs/en/agent-sdk/cost-tracking);
providers without a cost report remain Unknown. Reporting can
arrive at the end of a turn, so this is not a guaranteed hard dollar ceiling.
Raise or remove the limit and explicitly Resume task to continue with the same
task ID and history. A settled spend pause survives daemon restart.

In-place work holds the checkout's Deck writer reservation through review.
Other Deck writers wait; read-only agents can continue. Accept checks the
reviewed files and runs the configured checks before marking Done. Request
changes keeps the reservation and starts a new tracked attempt.

Isolated work uses independent Git worktrees, up to two tasks per project and
four per host. Accept merges the immutable result with the current project in
a scratch checkout, runs checks there, then writes changed working files while
preserving the primary checkout's index. Conflicts or failed checks prevent
Done. A pending interrupted integration must be recovered before retrying,
continuing, cancelling, or archiving. Recovery refuses to overwrite later
human edits.

After a daemon restart, active and queued tasks become Interrupted. Retry is
explicit; the host restores recorded checkout reservations and verifies owned
process cleanup first. Uncertain message responses retain their original
request ID, assignment, text, destination, checks, mode, and thread candidates
for safe replay.

## Isolated startup and disk use

Claude Code uses its documented noninteractive workspace startup with the
normal selected permission policy and the existing human approval protocol.
Adapters without a verified isolated startup path, including the current
Codex adapter, show Needs you. Use in-place execution or a supported isolated
worker in that case. Git is required for isolated editing.

Dependencies are installed independently with a root npm lockfile and `npm ci`;
unsupported package-manager setup requires human intervention. Rust targets
are separate for each task. Task cards show folder sizes and offer archiving
after 14 days. Archive removes owned worktrees and build folders but retains
the task record and Git result refs. Archived tasks cannot silently resume.

Untracked likely secrets (`.env*`, `*.pem`, `*.key`, `id_*`, credential files)
and oversized new files are excluded and listed. Templates and examples are
allowed; tracked files are always retained. Add gitignore patterns to
`.apex-agent-exclude` to exclude additional untracked files. Private snapshot
refs live under `refs/apex/tasks/`; the app never pushes them. Their names are
not a security boundary.

## Development and verification

`npm run desktop:dev` gives each checkout its own default development data
directory. `APEX_DECK_DATA_DIR` overrides it. The daemon's capability list
controls availability; unsupported hosts show an update instruction.

Core verification commands:

```sh
npm test
npm run build
cargo test --locked --workspace --features apex-daemon/remote
npm run test:e2e
npm run desktop:smoke
npm run desktop:smoke:widget
npm run desktop:smoke:multi-host
```

The delegation end-to-end fixtures use a real daemon, two clients, temporary
Git repositories, and deterministic local provider stand-ins. They exercise
in-place review ownership, restart receipts, simultaneous isolated workers,
human approvals, staging preservation, sequential integration, and archive.
The V3 fixture also exercises a non-Git read-only review, complete human answers,
reported cost, a persistent spend pause, and an explicit resumed attempt.
These fixtures do not establish physical iPhone or paid-provider validation.
macOS and Linux support process-group cleanup with durable birth identities;
Windows process-tree recovery is explicitly unsupported.
