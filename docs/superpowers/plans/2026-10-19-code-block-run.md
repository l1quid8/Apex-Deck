# Run a code block from the chat (Play button beside Copy)

Handoff plan. Clean-room: behaviour taken from static notes on Claude.app
(`/Users/tylercaldwell/Downloads/REA/evidence/claude-code-block-run/README.md`),
no Anthropic code copied.

## Goal

A shell code block in a bot reply gets a **Run** button (▶ icon, label
"Run in terminal") to the left of **Copy**. Clicking it runs the block in a
shell in the thread's workspace on the thread's host, and the output streams
into a small box under the block. From there you can Stop, Open in terminal,
Dismiss, or **Add output to message**.

## What already exists (verified on `main` at `d253701`)

- `src/Markdown.tsx:10` — `codeAction` prop renders extra controls in the code
  block header *before* Copy (`md-code-actions`, line ~143). It is the right slot.
- `src/ChatPane.tsx:3067` — passes `codeAction={(code) => artifactAction(...)}`.
  Today only the Artifact button uses it.
- `src/backend.ts:74-82` — `ptySpawn/ptyWrite/ptyKill/onPtyData/onPtyExit`.
  `ptySpawn` with no `agent` starts the user's shell (`crates/apex-host/src/host.rs:480`).
  `cwd` is accepted. No backend change is needed for v1.
- `src/terminalRun.ts` — PTY id and generation rules for terminal panes; reuse
  `ptyIdFor` style ids so a late event can't reach a newer run.

## Steps

Work on a new branch `feat/code-block-run` in a new worktree off `main`.
Don't use the main checkout: it has uncommitted `feat/pop-out-panes` changes
to `ChatPane.tsx`, and this work touches the same file.

### 1. Which blocks can run: `src/codeRun.ts` (pure, tested)
- `isRunnable(language, text)`: true for `sh bash zsh shell console fish`;
  for untagged or `text` blocks, only when every non-blank line looks like a
  command (starts with a known binary or `./`, `$ `, `!`, with no prose sentences).
  False for anything over 4 KB or 50 lines.
- `commandFrom(text)`: trims the end; strips a leading `$ ` or `!` prompt from each line;
  drops output lines in `console` blocks (lines without a prompt).
- Tests in `tests/code-run.test.mjs` cover tagged, untagged, prompt stripping,
  prose rejection and the size cap. Write them first.

### 2. Run state: `src/useCodeRuns.ts`
- Keyed by `${messageSeq}:${blockIndex}`. State:
  `{ ptyId, output, state: "running"|"exited"|"error", code, truncated }`.
- `run(key, command, cwd)`: `ptySpawn({ id: "run:"+key+":"+n, cwd, cols: 120, rows: 24 })`,
  then `ptyWrite(command + "\n" + "exit\n")` so the shell ends when the command does.
  Strip ANSI and handle `\r` before storing. Cap stored output at 64 KB and
  keep the tail, with `truncated: true`.
- `stop(key)` calls `ptyKill`. `dismiss(key)` kills the PTY if it's running and drops the state.
- Thread switch / pane unmount: kill running runs (Claude does the same on eviction).

### 3. UI
- `ChatPane.tsx`: make `codeAction` render both the Artifact button and a
  `RunButton` when `isRunnable`. Pass the block index through
  `Markdown.tsx` (`BlockView` → `codeAction({ language, text, index })`).
- Under the block: `<pre class="md-code-run" role="log" aria-live="polite">`,
  `max-height: 160px`, auto-scroll while it runs. Its toolbar holds Stop (while running),
  `Exit 0` / `Exit 1` status, **Open in terminal**, **Add output to message**,
  and Dismiss.
- **Open in terminal**: open a new terminal pane in the same project, with
  the command typed in and *not* run, so nothing runs twice.
- **Add output to message**: add a fenced block with the command and the output
  to the composer draft. It does not send. The human decides.
- Styles go in `styles.css` beside `.md-code`. Clay and Glass inherit from the variables.

### 4. Safety
- The human's click is the consent, so there's no approval card. Show the full command in
  the button's `title`. If it has more than one line or contains `sudo` or `rm -rf`, the
  first click turns the button into "Click again to run", which resets after 3 s.
- Remote hosts: it runs on the thread's host. Label the output box
  "Ran on <host>" so it's never ambiguous.
- Off in preview/browser mode (`backend.isBrowser`), where nothing really runs.
- A Settings → General toggle "Run buttons on code blocks", default on.

### 5. Verify
- `npx tsc --noEmit`, `npm test`, `vite build`.
- `npm run desktop:dev`: run `echo hi`, `ls`, a long `sleep 5; echo done` (then Stop),
  a failing `false` (Exit 1), a `console` block with mixed output, and an untagged prose block
  (should get no button). Check that Add output to message fills the draft without sending.
- Leave it uncommitted for Tyler's review.

## Later (not v1)
- "Run and send output to the bot", the way Claude's captured run works:
  it would run, then post the output to the room addressed to the bot that wrote the block.
- Phone: show the output read-only. Running stays desktop-only.

## Team split and contract (Jigga, 2026-10-19)

Folder: `/Users/tylercaldwell/Downloads/apex-deck-worktrees/code-block-run`, branch
`feat/code-block-run` off `main` d253701. Each owner touches only their files.
Don't commit; Jigga integrates, runs the checks, and leaves it uncommitted.

| Owner | Files |
|---|---|
| Forge | `src/codeRun.ts`, `tests/code-run.test.mjs` |
| deepgeek | `src/useCodeRuns.ts`, `tests/code-runs-hook.test.mjs`, the Settings toggle (`src/SettingsPage.tsx` General + `src/settings.ts`) |
| Jigga | `src/Markdown.tsx`, `src/ChatPane.tsx`, new `src/CodeRunBox.tsx`, `src/styles.css`, integration + review |

### Change from step 2: wrapping the command

Typing `command\nexit\n` into a login shell puts the rc noise, the prompt and the
echoed command into the output box. Instead we type one line and keep only what
comes after a start marker the shell prints:

    ␠printf '\033]777;apex-run\007'; eval "$(printf %s '<base64 of command>' | base64 -d)"; exit $?\n

The literal `\033` in the echoed line is four characters, not ESC, so only the
real printf output contains the marker. Everything before it is dropped.
Exit code comes from `onPtyExit`. (fish users: not handled in v1.)

### `src/codeRun.ts` (Forge) — pure, no React, no backend

```ts
export const MAX_RUN_BYTES = 4096, MAX_RUN_LINES = 50, OUTPUT_CAP = 65536;
export const RUN_MARKER = "\x1b]777;apex-run\x07";
export function isRunnable(language: string, text: string): boolean;
export function commandFrom(language: string, text: string): string;
/** True when the first click should only arm: more than one line, sudo, or rm -rf. */
export function needsConfirm(command: string): boolean;
/** The single line typed into the shell (see above), ending in "\n". UTF-8 safe base64. */
export function shellLine(command: string): string;
export interface RunOutput { started: boolean; output: string; truncated: boolean; carry: string }
export const EMPTY_OUTPUT: RunOutput;
/** Drop everything before RUN_MARKER; strip ANSI/OSC; "\r\n"→"\n"; lone "\r" rewinds to
 *  the start of the current line; keep the tail at `cap` chars with truncated=true.
 *  `carry` holds an incomplete escape (or partial marker) split across chunks. */
export function appendOutput(prev: RunOutput, chunk: string, cap?: number): RunOutput;
```

### `src/useCodeRuns.ts` (deepgeek)

```ts
export type CodeRunState = "running" | "exited" | "error";
export interface CodeRun { ptyId: string; command: string; out: RunOutput; state: CodeRunState; code: number | null; error?: string }
/** `scope` is the thread id: when it changes, or on unmount, running runs are killed. */
export function useCodeRuns(backend: Backend, scope: string): {
  runs: Record<string, CodeRun>;           // key = `${messageSeq}:${blockIndex}`
  run(key: string, command: string, cwd: string): void;   // new run replaces a finished one
  stop(key: string): void;                 // ptyKill
  dismiss(key: string): void;              // kill if running, drop state
};
```
- PTY id `run:${scope}:${key}:${n}`, n increments per hook instance; events for any
  other id are ignored. `ptySpawn({ id, cwd, cols: 120, rows: 24 })` then
  `ptyWrite(id, shellLine(command))`. Spawn failure → state "error" with the message.
- Subscribe to `onPtyData`/`onPtyExit` once per backend, not per run.
- Keep the reducer pure and exported (e.g. `codeRunsReducer`) so the test can drive it
  without React.
- Setting: `codeRunButtons: boolean`, default true, Settings → General
  "Run buttons on code blocks". Export however settings.ts already does it; tell Jigga the name.
