# Phone agent editor: ✨ Write with AI

Look: `mockups/phone-agent-write-with-ai-v2.html` (five steps). Phone-only. The Mac side does not change.
Branch `feat/phone-agent-write-with-ai`, folder `~/Downloads/apex-deck-worktrees/phone-agent-write-with-ai`.

## The agreement (the only thing the screen calls)

New file `src/phone/personaDrafter.ts` (Jigga). Muck imports the types from it.

```ts
/** One row in the "Written by" list. */
export interface WriterOption {
  key: string;      // "agent:claude_code" | "saved:<profile id>"
  label: string;    // "Claude Code", "Scout (saved)"
  own: boolean;     // true on the row that matches the agent being edited
}

export type DraftReply =
  | { name?: string; brief: string }  // name only when the request had no name
  | { error: string };                // "" = cancelled (show nothing); otherwise one plain sentence for the amber line

export interface PersonaDrafter {
  /** Coding AIs turned on on that Mac first, then saved agents. Never rejects: [] when the Mac can't say. */
  writerOptions(own: ParticipantConfig): Promise<WriterOption[]>;
  /** One request at a time. Never rejects. A newer call or cancelDraft() makes an older one resolve { error: "" }. */
  draftPersona(req: { writer: string; idea: string; name?: string }): Promise<DraftReply>;
  /** Drop the answer in flight. */
  cancelDraft(): void;
}
```

`AgentSheet` gets one new prop: `drafter?: PersonaDrafter`. Until step 3, Muck uses a stand-in when it's missing.

Rules the screen can rely on:
- `own` row: the agent's own coding AI (`agent:<tool>`), or for an API agent its own saved row. The screen starts on it every time the editor opens. If no row is `own`, it starts on the first row.
- `idea` is whatever is in the Brief box (it's sent trimmed). If the box is blank, the reply is `{ error: "Type a few words about the agent first." }` and nothing is sent.
- `name`: the screen passes the name only when the person typed it. If no name is passed, the reply carries the AI's name. A new agent gets a name; an existing one keeps its own.
- Nothing is saved. The reply only fills the form; Save agent saves.
- Cancel: the Mac has no cancel for `persona_draft`, so Cancel only drops the answer on the phone. The Mac finishes its one read-only turn (capped at 2 minutes) and the answer is thrown away.

## How it works (Jigga, connection)

```
AgentSheet ──draftPersona──▶ personaDrafter ──persona_draft {writer config, idea, taken}──▶ Mac (unchanged)
           ◀─{name?,brief}─                 ◀──────────── {name, persona} or error ─────────
```

- `writerOptions`: the coding AIs come from the Mac's `chat_profiles` answer (its `backends` list, `chatOk` only), with any provider switched off in the Mac's Settings removed. The saved agents come from the session's profiles (agent or API backend, no picture/video models, provider on). Each list keeps the same order as the desktop's `personaWriters`. The saved-agent configs come from the session and not from `chat_profiles`, because `chat_profiles` strips the API-key name and an API writer would then fail.
- `draftPersona`: looks up the key to get a writer config and calls the existing `backend.personaDraft(writer, idea, taken)`. `taken` lists every other saved agent's name, leaving out the agent being edited. It turns `persona` into `brief`, drops `name` when the request had one, and turns failures into one sentence: "The Mac isn't connected." for an offline Mac, and the Mac's own words for everything else (for example "That AI's API key is missing on this machine.").
- `src/phoneBackend.ts`: `PhoneHost` gains `personaDrafter(profiles: () => ParticipantConfig[], editingId: string | null): PersonaDrafter`, built on that host's backend.
- Tests: `tests/phone-persona-drafter.test.mjs`, run against a fake backend. They cover: list order and the `own` row; turned-off providers and picture/video models left out; saved configs taken from the session, not the redacted copy; key → writer config; `taken` leaving out the agent being edited; `name` dropped when one was passed; a blank idea never reaching the Mac; cancel and a newer call making the older one resolve `{ error: "" }`; never rejecting.

## Screen (Muck, `src/phone/AgentSheet.tsx` only)

All five steps from v2: ✨ next to the Brief label; "Writing…" lock with Cancel; filled box with "Undo · Try again" and the Done line; the "Written by [AI ⌄]" picker using the phone's normal pop-up list; the amber error line that keeps the person's words. Try again starts from the person's own words, not the last answer (like the desktop). Use the existing `ph-` classes. If a style is missing, ask here and Jigga adds it in step 3.

## Step 3 (Jigga)

1. In `PhoneApp.tsx`, pass `drafter={macHost.personaDrafter(() => session?.profiles ?? [], agentSheet.id)}` and remove the stand-in.
2. Run `npx tsc --noEmit`, the new tests, `tests/phone-agent-edit.test.mjs` and `tests/persona-draft*.test.mjs`.
3. Simulator check against a throwaway Mac service in `/tmp` (never the real data folder). Take a screenshot of each of the five steps. Step 5 is forced with a writer that has a missing key.
4. Cross-review: Muck reviews the connection, Jigga reviews the screen. No merge or push until the user says so.
