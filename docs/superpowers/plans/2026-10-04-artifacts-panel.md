# Artifacts panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On request, a code block in a bot's reply (HTML, SVG or Markdown) opens in a side panel inside the thread, rendered in a sandbox, with every version kept, Source and Changes tabs, and a full-window view; saved beside the thread.

**Architecture:** Three pure modules carry the rules, each with node:test tests: `src/artifacts.ts` (the saved file's shape and validation, kinds, titles, adding artifacts and versions, what a code block offers, picking a version, export names), `src/lineDiff.ts` (a line diff with context) and `src/artifactFrame.ts` (the sandboxed document with its content security policy). Rust keeps the file as opaque JSON beside the thread (`rooms/<hex id>.artifacts.json`), deletes it with the thread, copies it on fork, and writes exports. `Markdown.tsx` gains a hook for extra code-block controls; `ArtifactButton.tsx` is that control; `ArtifactsPanel.tsx` is the panel; `ChatPane.tsx` loads, saves and places it.

**Tech Stack:** Tauri 2 (+ dialog plugin's save), React 19, TypeScript, Rust, node:test with `--experimental-strip-types`, Vite.

**Spec:** docs/superpowers/specs/2026-10-04-preview-and-artifacts.md (section 2)

## Global Constraints

- Branch `feat/artifacts-panel` from `main`. Commit on it. Don't push and don't merge to `main` unless Tyler asks. No attribution lines in commit messages.
- Never stash, reset or discard edits you didn't make. If the working tree has someone else's uncommitted changes, work in a separate worktree.
- Copy: second person, plain, sentence case, verb-first buttons, " · " joins facts, no emoji. Glyphs: ▣ restore, × close, ‹ › steps, ▾ disclosure. The four-corners icon means full window.
- No new npm dependencies and no new crates.
- Bots never create artifacts. Only a person's click on a code block does.
- The browser preview backend (`src/backend.ts`, stand-in half) gets every new command the native backend gets.
- New file names differ from every existing file name by more than case.
- Checks: `npm test`, `npm run build`, and when Rust changes `cargo test --workspace -- --test-threads=1` from `src-tauri`.
- Shared names are fixed: `ArtifactFile`, `Artifact`, `ArtifactVersion`, `ArtifactKind` in `src/artifacts.ts`; `PanelView`, `DEFAULT_VIEW` in `src/ArtifactsPanel.tsx`; `CodeChoice` in `src/ArtifactButton.tsx`; Rust commands `artifacts_load`, `artifacts_save`, `artifact_export`; CSS variable `--deck-top` (shared with the Preview plan).

## Review Focus

1. **Artifact code reaching the network, the app or another page.** `fetch`, `<img src="https://…">`, `top.location`, `window.open`, `<meta http-equiv="refresh">` and links inside an artifact. Tests: Task 3, "the policy blocks the network and allows inline code", "the policy goes right after the document's head"; Task 7 puts the artifact back when its frame loads twice; Task 9 checks it in the desktop app.
2. **A damaged or hand-edited artifacts file.** Wrong types, repeated ids, unknown kinds, empty version lists, oversized sources: keep what is valid, renumber versions, drop the rest. Test: Task 1, "a saved file is read back, and damage loses only the damaged parts".
3. **A read error followed by a change.** If the file can't be read, opening an artifact must not write over it. Check: Task 8's `artifactsReadable` guard and Task 8 step 6.
4. **Big sources and big diffs.** A block over 512 KiB can't be opened; a diff too large to compare line by line shows everything removed then everything added instead of freezing. Tests: Task 1, "a block can become a new version of up to three artifacts of its kind, newest first" (`tooLarge`); Task 2, "a diff too big to compare shows all removed then all added".
5. **The same text opened twice.** Opening a block identical to the newest version adds no version. Test: Task 1, "the same text as the newest version adds nothing, and an unknown artifact is left alone".

---

## Before you start

- Line numbers are from `main@3d9a428`. Find every edit by the quoted code, not the number.
- Pure modules load under `node --experimental-strip-types`: type-only imports may omit the extension, value imports between pure modules use `.ts`, no enums, no parameter properties, no React.
- React components have no test harness. UI tasks end with a browser-preview check: `npm run dev -- --port 1431`, http://localhost:1431/ (stand-in backend). Scripted bots are the easy way to get replies with code blocks: add a Scripted bot whose line is a fenced code block.
- If the Preview plan landed first, `--deck-top` is already set by `App.tsx`; Task 8 step 1 says how to tell.

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/artifacts.ts` | Create (Task 1) | File shape, validation, kinds, titles, versions, code-block choices, picking, export names, `ago` |
| `tests/artifacts.test.mjs` | Create (Task 1) | Tests for the above |
| `src/lineDiff.ts` | Create (Task 2) | `lineDiff`, `diffCounts`, `compact` |
| `tests/line-diff.test.mjs` | Create (Task 2) | Tests for the above |
| `src/artifactFrame.ts` | Create (Task 3) | `FRAME_POLICY`, `frameDocument` |
| `tests/artifact-frame.test.mjs` | Create (Task 3) | Tests for the above |
| `src-tauri/src/storage.rs` | Modify (Task 4) | The artifacts file: read, write, delete with the thread, copy on fork |
| `src-tauri/src/lib.rs` | Modify (Task 4) | `artifacts_load`, `artifacts_save`, `artifact_export`, `safe_name` |
| `src-tauri/capabilities/default.json` | Modify (Task 4) | `dialog:allow-save` |
| `src/backend.ts` | Modify (Task 5) | `artifactsLoad`, `artifactsSave`, `artifactSave`, `artifactOpenExternal` |
| `src/Markdown.tsx` | Modify (Task 6) | `codeAction` for code block headers |
| `src/ArtifactButton.tsx` | Create (Task 6) | Open as artifact, its menu, Show vN |
| `src/ArtifactsPanel.tsx` | Create (Task 7) | The panel |
| `src/styles.css` | Append (Tasks 6, 7) | Button, menu and panel styles |
| `src/ChatPane.tsx` | Modify (Task 8) | Load, save, toggle, place the panel |
| `src/App.tsx` | Modify (Task 8, only if absent) | `--deck-top` |
| `README.md` | Modify (Task 9) | Artifacts |

---

### Task 1: The artifacts model

**Files:**
- Create: `src/artifacts.ts`
- Test: `tests/artifacts.test.mjs`

**Interfaces:**
- Produces: `type ArtifactKind = "html" | "svg" | "markdown"`; `interface ArtifactVersion { n; source; by: string | null; seq: number | null; at }`; `interface Artifact { id; title; kind; versions }`; `interface ArtifactFile { version: 1; artifacts: Artifact[] }`; `EMPTY_ARTIFACTS`, `MAX_SOURCE`, `KIND_LABEL`; `kindOf`, `titleFor`, `readArtifacts`, `addArtifact`, `addVersion`, `codeChoices` → `CodeChoices | null`, `newestFirst`, `pickVersion`, `ago`, `exportName`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_ARTIFACTS, MAX_SOURCE, addArtifact, addVersion, ago, codeChoices, exportName, kindOf, newestFirst, pickVersion, readArtifacts, titleFor } from "../src/artifacts.ts";

const v = (source, extra = {}) => ({ source, by: "ada", seq: 1, at: 1000, ...extra });

test("code block languages map to the kinds that can open", () => {
  assert.equal(kindOf("html", "<p>"), "html");
  assert.equal(kindOf("HTM", "<p>"), "html");
  assert.equal(kindOf("svg", "<svg>"), "svg");
  assert.equal(kindOf("xml", '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>'), "svg");
  assert.equal(kindOf("", '  <svg width="1"></svg>'), "svg");
  assert.equal(kindOf("", "<!DOCTYPE html><html></html>"), "html");
  assert.equal(kindOf("markdown", "# Hi"), "markdown");
  assert.equal(kindOf("md", "# Hi"), "markdown");
  for (const [language, text] of [["js", "alert(1)"], ["", "plain text"], ["xml", "<note/>"], ["mermaid", "flowchart LR"]]) {
    assert.equal(kindOf(language, text), null, language);
  }
});

test("titles come from the page, a heading, or the kind", () => {
  assert.equal(titleFor("html", "<html><head><title>Welcome &amp; hello</title></head><body><h1>Other</h1></body></html>"), "Welcome & hello");
  assert.equal(titleFor("html", '<body><h1 class="x">Your next <em>idea</em>.</h1></body>'), "Your next idea.");
  assert.equal(titleFor("markdown", "Intro\n\n## Launch *checklist*\n"), "Launch checklist");
  assert.equal(titleFor("svg", "<svg><title>App icon</title></svg>"), "App icon");
  assert.equal(titleFor("svg", "<svg></svg>"), "SVG image");
  assert.equal(titleFor("html", "<p>no heading</p>"), "HTML page");
  assert.equal(titleFor("markdown", "no heading"), "Document");
  assert.equal(titleFor("html", `<title>${"x".repeat(80)}</title>`), `${"x".repeat(59)}…`);
});

test("a new artifact starts at v1, and a new version is numbered after the last", () => {
  const { file, artifact } = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<title>Page</title>"));
  assert.deepEqual(artifact, { id: "a", title: "Page", kind: "html", versions: [{ n: 1, source: "<title>Page</title>", by: "ada", seq: 1, at: 1000 }] });
  const second = addVersion(file, "a", v("<title>Page</title><p>2</p>", { by: "ben", seq: 4, at: 2000 }));
  assert.equal(second.n, 2);
  assert.equal(second.file.artifacts[0].versions[1].by, "ben");
  assert.equal(second.file.artifacts[0].title, "Page", "the title stays what v1 gave it");
});

test("the same text as the newest version adds nothing, and an unknown artifact is left alone", () => {
  const { file } = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<p>1</p>"));
  const same = addVersion(file, "a", v("<p>1</p>", { seq: 9 }));
  assert.equal(same.file, file);
  assert.equal(same.n, 1);
  assert.deepEqual(addVersion(file, "missing", v("<p>2</p>")), { file, n: 0 });
});

test("a code block knows the version it was opened as", () => {
  const { file } = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<p>1</p>", { seq: 3 }));
  assert.deepEqual(codeChoices(file, 3, "html", "<p>1</p>").opened, { artifactId: "a", n: 1 });
  assert.equal(codeChoices(file, 4, "html", "<p>1</p>").opened, null, "the same text in another reply hasn't been opened");
  assert.equal(codeChoices(file, 3, "js", "x"), null);
});

test("a block can become a new version of up to three artifacts of its kind, newest first", () => {
  let file = EMPTY_ARTIFACTS;
  for (const [id, at] of [["a", 1], ["b", 4], ["c", 2], ["d", 3]]) file = addArtifact(file, id, "html", v(`<p>${id}</p>`, { at })).file;
  file = addArtifact(file, "s", "svg", v("<svg></svg>", { at: 9 })).file;
  const choices = codeChoices(file, 99, "html", "<p>new</p>");
  assert.deepEqual(choices.targets.map((t) => t.id), ["b", "d", "c"]);
  assert.deepEqual(choices.targets[0], { id: "b", title: "HTML page", next: 2 });
  assert.equal(choices.tooLarge, false);
  assert.equal(codeChoices(file, 99, "html", "x".repeat(MAX_SOURCE + 1)).tooLarge, true);
});

test("a saved file is read back, and damage loses only the damaged parts", () => {
  const raw = { version: 1, artifacts: [
    { id: "a", title: "Page", kind: "html", versions: [{ source: "<p>1</p>", by: "ada", seq: 2, at: 5 }, { source: 42 }, { source: "<p>2</p>", by: 7, seq: "x" }] },
    { id: "a", title: "Repeat", kind: "html", versions: [{ source: "x" }] },
    { id: "b", kind: "mermaid", versions: [{ source: "x" }] },
    { id: "c", kind: "svg", versions: [] },
    { id: "d", title: "  ", kind: "markdown", versions: [{ source: "# Notes" }] },
    "junk",
  ] };
  const file = readArtifacts(raw);
  assert.deepEqual(file.artifacts.map((a) => a.id), ["a", "d"]);
  assert.deepEqual(file.artifacts[0].versions, [
    { n: 1, source: "<p>1</p>", by: "ada", seq: 2, at: 5 },
    { n: 2, source: "<p>2</p>", by: null, seq: null, at: 0 },
  ]);
  assert.equal(file.artifacts[1].title, "Notes", "a missing title comes from the first version");
  assert.deepEqual(readArtifacts(null), EMPTY_ARTIFACTS);
  assert.deepEqual(readArtifacts({ artifacts: "nope" }), EMPTY_ARTIFACTS);
});

test("the panel shows the asked-for version, or the newest", () => {
  let file = addArtifact(EMPTY_ARTIFACTS, "a", "html", v("<p>1</p>", { at: 1 })).file;
  file = addVersion(file, "a", v("<p>2</p>", { at: 3 })).file;
  file = addArtifact(file, "b", "svg", v("<svg></svg>", { at: 2 })).file;
  assert.equal(pickVersion(file, "a", 1).version.source, "<p>1</p>");
  assert.equal(pickVersion(file, "a", null).version.n, 2);
  assert.equal(pickVersion(file, "a", 7).version.n, 2);
  assert.equal(pickVersion(file, null, null).artifact.id, "a", "the most recently changed");
  assert.equal(pickVersion(file, "gone", null).artifact.id, "a");
  assert.equal(pickVersion(EMPTY_ARTIFACTS, null, null), null);
  assert.deepEqual(newestFirst(file).map((a) => a.id), ["a", "b"]);
});

test("times read as a few words, and export names are safe file names", () => {
  assert.equal(ago(0, 30_000), "just now");
  assert.equal(ago(0, 2 * 60_000), "2m ago");
  assert.equal(ago(0, 3 * 3_600_000), "3h ago");
  assert.equal(ago(0, 2 * 86_400_000), "2d ago");
  assert.equal(ago(5000, 0), "just now");
  assert.equal(exportName({ title: "Welcome email!", kind: "html" }, 3), "welcome-email-v3.html");
  assert.equal(exportName({ title: "App icon", kind: "svg" }, 1), "app-icon-v1.svg");
  assert.equal(exportName({ title: "✓✓", kind: "markdown" }, 2), "artifact-v2.md");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/artifacts.test.mjs`
Expected: FAIL, cannot find module `../src/artifacts.ts`.

- [ ] **Step 3: Write the module**

```ts
// Artifacts: code from a bot's reply, opened on request and kept with every
// version. Saved beside the thread in rooms/<id>.artifacts.json; the desktop
// side treats the file as opaque JSON. See the spec, section 2.

export type ArtifactKind = "html" | "svg" | "markdown";

export interface ArtifactVersion {
  /** Its number, from 1: always its position in the list. */
  n: number;
  source: string;
  /** The participant whose reply it came from; null when unknown. */
  by: string | null;
  /** The reply's message number; null when unknown. */
  seq: number | null;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface Artifact {
  id: string;
  title: string;
  kind: ArtifactKind;
  versions: ArtifactVersion[];
}

export interface ArtifactFile {
  version: 1;
  artifacts: Artifact[];
}

/** What a new version is made from. */
export type NewVersion = Omit<ArtifactVersion, "n">;

export const EMPTY_ARTIFACTS: ArtifactFile = { version: 1, artifacts: [] };
/** The largest version that can be opened, in characters. */
export const MAX_SOURCE = 512 * 1024;
export const KIND_LABEL: Record<ArtifactKind, string> = { html: "HTML", svg: "SVG", markdown: "Markdown" };

const KINDS: ArtifactKind[] = ["html", "svg", "markdown"];
const FALLBACK_TITLE: Record<ArtifactKind, string> = { html: "HTML page", svg: "SVG image", markdown: "Document" };
const EXTENSION: Record<ArtifactKind, string> = { html: "html", svg: "svg", markdown: "md" };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The kind a code block can open as, from its language tag and text; null when it can't. */
export function kindOf(language: string, text: string): ArtifactKind | null {
  const tag = language.trim().toLowerCase();
  if (tag === "html" || tag === "htm" || tag === "xhtml") return "html";
  if (tag === "svg") return "svg";
  if ((tag === "xml" || tag === "") && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return "svg";
  if (tag === "" && /^\s*<!doctype html/i.test(text)) return "html";
  if (tag === "md" || tag === "markdown") return "markdown";
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const plainText = (html: string) =>
  html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name]).replace(/\s+/g, " ").trim();

/** A title from the source: an HTML or SVG <title>, an HTML <h1>, a Markdown heading; else the kind's own. */
export function titleFor(kind: ArtifactKind, source: string): string {
  const tag = (name: string) => plainText(source.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "");
  const found =
    kind === "markdown" ? (source.match(/^#{1,3}[ \t]+(.+)$/m)?.[1] ?? "").replace(/[#*_`]+/g, "").replace(/\s+/g, " ").trim()
    : kind === "html" ? tag("title") || tag("h1")
    : tag("title");
  if (!found) return FALLBACK_TITLE[kind];
  return found.length > 60 ? `${found.slice(0, 59)}…` : found;
}

/** Read a saved file. What is damaged is left out; versions are renumbered from 1. */
export function readArtifacts(raw: unknown): ArtifactFile {
  const list = record(raw).artifacts;
  if (!Array.isArray(list)) return EMPTY_ARTIFACTS;
  const seen = new Set<string>();
  const artifacts = list.flatMap((value): Artifact[] => {
    const a = record(value);
    if (typeof a.id !== "string" || !a.id || seen.has(a.id)) return [];
    if (!KINDS.includes(a.kind as ArtifactKind)) return [];
    const kind = a.kind as ArtifactKind;
    const versions = (Array.isArray(a.versions) ? a.versions : [])
      .flatMap((item): NewVersion[] => {
        const x = record(item);
        if (typeof x.source !== "string" || x.source.length > MAX_SOURCE) return [];
        return [{
          source: x.source,
          by: typeof x.by === "string" ? x.by : null,
          seq: typeof x.seq === "number" && Number.isInteger(x.seq) ? x.seq : null,
          at: typeof x.at === "number" && Number.isFinite(x.at) ? x.at : 0,
        }];
      })
      .map((version, i) => ({ n: i + 1, ...version }));
    if (versions.length === 0) return [];
    seen.add(a.id);
    const title = typeof a.title === "string" && a.title.trim() ? a.title.trim().slice(0, 80) : titleFor(kind, versions[0].source);
    return [{ id: a.id, title, kind, versions }];
  });
  return { version: 1, artifacts };
}

export function addArtifact(file: ArtifactFile, id: string, kind: ArtifactKind, version: NewVersion): { file: ArtifactFile; artifact: Artifact } {
  const artifact: Artifact = { id, title: titleFor(kind, version.source), kind, versions: [{ n: 1, ...version }] };
  return { file: { version: 1, artifacts: [...file.artifacts, artifact] }, artifact };
}

/** A new version of an artifact. The same text as its newest version adds nothing; an unknown id gives n 0. */
export function addVersion(file: ArtifactFile, artifactId: string, version: NewVersion): { file: ArtifactFile; n: number } {
  const artifact = file.artifacts.find((a) => a.id === artifactId);
  if (!artifact) return { file, n: 0 };
  const latest = artifact.versions[artifact.versions.length - 1];
  if (latest.source === version.source) return { file, n: latest.n };
  const n = artifact.versions.length + 1;
  const next: Artifact = { ...artifact, versions: [...artifact.versions, { n, ...version }] };
  return { file: { version: 1, artifacts: file.artifacts.map((a) => (a.id === artifactId ? next : a)) }, n };
}

const lastAt = (artifact: Artifact) => artifact.versions[artifact.versions.length - 1].at;

/** Most recently changed first. */
export function newestFirst(file: ArtifactFile): Artifact[] {
  return [...file.artifacts].sort((a, b) => lastAt(b) - lastAt(a));
}

/** What a code block in a reply offers. */
export interface CodeChoices {
  kind: ArtifactKind;
  /** The version this block was opened as, if it was. */
  opened: { artifactId: string; n: number } | null;
  /** Artifacts of the same kind it could become a new version of: newest first, at most three. */
  targets: { id: string; title: string; next: number }[];
  tooLarge: boolean;
}

/** Null when the block's kind can't open. */
export function codeChoices(file: ArtifactFile, seq: number, language: string, text: string): CodeChoices | null {
  const kind = kindOf(language, text);
  if (!kind) return null;
  for (const artifact of file.artifacts) {
    const match = artifact.versions.find((version) => version.seq === seq && version.source === text);
    if (match) return { kind, opened: { artifactId: artifact.id, n: match.n }, targets: [], tooLarge: false };
  }
  const targets = newestFirst(file)
    .filter((artifact) => artifact.kind === kind)
    .slice(0, 3)
    .map((artifact) => ({ id: artifact.id, title: artifact.title, next: artifact.versions.length + 1 }));
  return { kind, opened: null, targets, tooLarge: text.length > MAX_SOURCE };
}

/** The version to show: the one asked for, else the newest; the artifact asked for, else the most recently changed. */
export function pickVersion(file: ArtifactFile, artifactId: string | null, n: number | null): { artifact: Artifact; version: ArtifactVersion } | null {
  const artifact = file.artifacts.find((a) => a.id === artifactId) ?? newestFirst(file)[0];
  if (!artifact) return null;
  const version = artifact.versions.find((v) => v.n === n) ?? artifact.versions[artifact.versions.length - 1];
  return { artifact, version };
}

/** "just now", "4m ago", "3h ago", "2d ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A file name for saving or opening a version: "welcome-email-v3.html". */
export function exportName(artifact: Pick<Artifact, "title" | "kind">, n: number): string {
  const slug = artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "artifact";
  return `${slug}-v${n}.${EXTENSION[artifact.kind]}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/artifacts.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/artifacts.ts tests/artifacts.test.mjs
git commit -m "feat: artifacts model: kinds, titles, versions and the saved file"
```

---

### Task 2: Line diff

**Files:**
- Create: `src/lineDiff.ts`
- Test: `tests/line-diff.test.mjs`

**Interfaces:**
- Produces: `type DiffLine = { sign: " " | "+" | "-"; text: string }`; `type DiffRow = DiffLine | { skipped: number }`; `lineDiff(before, after): DiffLine[]`; `diffCounts(lines): { added: number; removed: number }`; `compact(lines, context = 3): DiffRow[]`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { compact, diffCounts, lineDiff } from "../src/lineDiff.ts";

const signs = (lines) => lines.map((l) => `${l.sign}${l.text}`);

test("unchanged text is all context", () => {
  assert.deepEqual(signs(lineDiff("a\nb", "a\nb")), [" a", " b"]);
});

test("changed lines show removals before additions, between unchanged ones", () => {
  const before = '<p class="brand">\n<h1>Welcome</h1>\n<p>Thanks</p>\n<a>Open</a>';
  const after = '<p class="brand">\n<h1>Your next idea.</h1>\n<p>Add a workspace</p>\n<a>Open</a>';
  assert.deepEqual(signs(lineDiff(before, after)), [' <p class="brand">', "-<h1>Welcome</h1>", "-<p>Thanks</p>", "+<h1>Your next idea.</h1>", "+<p>Add a workspace</p>", " <a>Open</a>"]);
  assert.deepEqual(diffCounts(lineDiff(before, after)), { added: 2, removed: 2 });
});

test("lines added in the middle keep everything around them", () => {
  assert.deepEqual(signs(lineDiff("a\nd", "a\nb\nc\nd")), [" a", "+b", "+c", " d"]);
});

test("a diff too big to compare shows all removed then all added", () => {
  const before = Array.from({ length: 2100 }, (_, i) => `a${i}`).join("\n");
  const after = Array.from({ length: 2100 }, (_, i) => `b${i}`).join("\n");
  const lines = lineDiff(before, after);
  assert.equal(lines.length, 4200);
  assert.equal(lines[0].sign, "-");
  assert.equal(lines[4199].sign, "+");
});

test("long unchanged stretches fold to a count, keeping three lines each side", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
  const rows = compact(lineDiff(before, before.replace("f", "F")));
  assert.deepEqual(rows.map((r) => ("skipped" in r ? `…${r.skipped}` : `${r.sign}${r.text}`)), ["…2", " c", " d", " e", "-f", "+F", " g", " h", " i", "…1"]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/line-diff.test.mjs`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the module**

```ts
// A line diff for the artifacts panel's Changes tab: what one version
// changed from the one before it.

export type DiffLine = { sign: " " | "+" | "-"; text: string };
export type DiffRow = DiffLine | { skipped: number };

/** Above this many cells, comparing line by line would take too long and too much memory. */
const CELL_LIMIT = 4_000_000;

/** Removals come before additions where lines changed. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ sign: " ", text }));
  const n = endA - start;
  const m = endB - start;
  if (n * m > CELL_LIMIT) {
    for (let i = start; i < endA; i++) out.push({ sign: "-", text: a[i] });
    for (let j = start; j < endB; j++) out.push({ sign: "+", text: b[j] });
  } else {
    // table[i][j]: the longest common run of lines from a[start+i] and b[start+j] on.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ sign: " ", text: a[start + i] });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        out.push({ sign: "-", text: a[start + i++] });
      } else {
        out.push({ sign: "+", text: b[start + j++] });
      }
    }
    while (i < n) out.push({ sign: "-", text: a[start + i++] });
    while (j < m) out.push({ sign: "+", text: b[start + j++] });
  }
  for (let k = endA; k < a.length; k++) out.push({ sign: " ", text: a[k] });
  return out;
}

export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.sign === "+").length, removed: lines.filter((l) => l.sign === "-").length };
}

/** Keep `context` unchanged lines on each side of a change; fold the rest into counts. */
export function compact(lines: DiffLine[], context = 3): DiffRow[] {
  const changed = lines.map((line) => line.sign !== " ");
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    let near = false;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context) && !near; k++) near = changed[k];
    if (near) {
      if (skipped) rows.push({ skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped) rows.push({ skipped });
  return rows;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/line-diff.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lineDiff.ts tests/line-diff.test.mjs
git commit -m "feat: line diff for artifact versions"
```

---

### Task 3: The sandboxed document

**Files:**
- Create: `src/artifactFrame.ts`
- Test: `tests/artifact-frame.test.mjs`

**Interfaces:**
- Produces: `FRAME_POLICY: string`; `frameDocument(kind: "html" | "svg", source: string): string`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { FRAME_POLICY, frameDocument } from "../src/artifactFrame.ts";

test("the policy goes right after the document's head", () => {
  const doc = frameDocument("html", '<!doctype html><html lang="en"><head><title>x</title></head><body>hi</body></html>');
  assert.match(doc, /^<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy"/);
  assert.equal(doc.split("Content-Security-Policy").length, 2);
});

test("a page without a head gets one, and a fragment gets the policy first", () => {
  assert.match(frameDocument("html", "<html><body>hi</body></html>"), /^<html><head><meta http-equiv="Content-Security-Policy"[^>]*><\/head><body>/);
  assert.match(frameDocument("html", "<p>hi</p>"), /^<meta http-equiv="Content-Security-Policy"[^>]*><p>hi<\/p>$/);
  assert.match(frameDocument("html", "<body><header>x</header></body>"), /^<meta http-equiv="Content-Security-Policy"[^>]*><body><header>/);
});

test("the policy blocks the network and allows inline code", () => {
  assert.match(FRAME_POLICY, /default-src 'none'/);
  assert.match(FRAME_POLICY, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(FRAME_POLICY, /https?:|\*/);
});

test("an SVG is centred in a page of its own", () => {
  const doc = frameDocument("svg", '<svg viewBox="0 0 1 1"></svg>');
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /<body><svg viewBox="0 0 1 1"><\/svg><\/body>/);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/artifact-frame.test.mjs`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Write the module**

```ts
// The document an HTML or SVG artifact runs as. The frame's sandbox (an
// opaque origin, scripts only) is the boundary; this policy is a second line
// that keeps the artifact off the network. See the spec, 2.4.

export const FRAME_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const META = `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`;

export function frameDocument(kind: "html" | "svg", source: string): string {
  if (kind === "svg") {
    return `<!doctype html><html><head>${META}<meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${source}</body></html>`;
  }
  const head = /<head(\s[^>]*)?>/i.exec(source);
  if (head) {
    const at = head.index + head[0].length;
    return source.slice(0, at) + META + source.slice(at);
  }
  const html = /<html(\s[^>]*)?>/i.exec(source);
  if (html) {
    const at = html.index + html[0].length;
    return `${source.slice(0, at)}<head>${META}</head>${source.slice(at)}`;
  }
  return META + source;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/artifact-frame.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/artifactFrame.ts tests/artifact-frame.test.mjs
git commit -m "feat: sandboxed document for HTML and SVG artifacts"
```

---

### Task 4: Saving artifacts and writing exports (Rust)

**Files:**
- Modify: `src-tauri/src/storage.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`

**Interfaces:**
- Produces: commands `artifacts_load(room) -> Option<Value>`, `artifacts_save(room, artifacts)`, `artifact_export(name, contents, path: Option<String>) -> String` (the path written).

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/storage.rs`, inside `mod tests`, add:

```rust
    #[tokio::test]
    async fn artifacts_live_beside_their_thread_follow_forks_and_go_with_it() {
        let root = temp();
        let store = Store::new(root.clone());
        assert!(store.artifacts("chat-1").unwrap().is_none());
        let artifacts = serde_json::json!({"version":1,"artifacts":[{"id":"a","title":"Page","kind":"html","versions":[{"source":"<p>hi</p>","by":"ada","seq":3,"at":1}]}]});
        store.save_artifacts("chat-1", &artifacts).unwrap();
        assert_eq!(Store::new(root.clone()).artifacts("chat-1").unwrap().unwrap(), artifacts);

        let mut room = Room::new(vec![], RoomOptions::default());
        room.post_human("saved", &|_| {}).await;
        store.save_room("chat-1", &SavedRoom { cwd: None, snapshot: room.snapshot() }).unwrap();
        store.fork_room("chat-1", "chat-2", None, None).unwrap();
        assert_eq!(store.artifacts("chat-2").unwrap().unwrap(), artifacts);

        store.delete_room("chat-1").unwrap();
        assert!(store.artifacts("chat-1").unwrap().is_none());
        assert!(store.artifacts("chat-2").unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_damaged_artifacts_file_is_reported_not_emptied() {
        let root = temp();
        let store = Store::new(root.clone());
        store.save_artifacts("chat-1", &serde_json::json!({"version":1,"artifacts":[]})).unwrap();
        let path = store.artifacts_path("chat-1");
        std::fs::write(&path, "broken").unwrap();
        assert!(store.artifacts("chat-1").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        std::fs::remove_dir_all(root).unwrap();
    }
```

In `src-tauri/src/lib.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn export_names_keep_only_safe_characters() {
        assert_eq!(safe_name("welcome-email-v3.html").unwrap(), "welcome-email-v3.html");
        assert_eq!(safe_name("../../etc/passwd").unwrap(), "etcpasswd");
        assert_eq!(safe_name(".hidden").unwrap(), "hidden");
        assert!(safe_name("..").is_err());
        assert!(safe_name("✓").is_err());
    }
```

- [ ] **Step 2: Run them to see them fail**

Run (from `src-tauri`): `cargo test --workspace -- --test-threads=1 artifacts export_names`
Expected: FAIL to compile: no method `artifacts`, `save_artifacts`, `artifacts_path`; no function `safe_name`.

- [ ] **Step 3: Storage**

In `impl Store`, after `room_path`, add:

```rust
    /// A thread's artifacts, beside its file: "<hex id>.artifacts.json".
    fn artifacts_path(&self, id: &str) -> PathBuf {
        self.room_path(id).with_extension("artifacts.json")
    }
```

After `save_room`, add:

```rust
    /// Artifacts opened from a thread's replies. The frontend owns their shape (src/artifacts.ts).
    pub fn artifacts(&self, id: &str) -> Result<Option<serde_json::Value>, String> {
        self.read(&self.artifacts_path(id))
    }

    pub fn save_artifacts(&self, id: &str, artifacts: &serde_json::Value) -> Result<(), String> {
        self.write(&self.artifacts_path(id), artifacts)
    }
```

In `fork_room`, after the `if let Err(e) = file.write_all(…) { … }` block and before the final `std::fs::File::open(parent)…` line, add:

```rust
        // A fork keeps the thread's artifacts. Copied directly: the write lock is already held.
        match std::fs::copy(self.artifacts_path(source), self.artifacts_path(target)) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not copy the thread's artifacts: {e}")),
        }
```

In `delete_room`, replace the body after the guard with:

```rust
        for path in [self.room_path(id), self.artifacts_path(id)] {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Could not delete chat: {e}")),
            }
        }
        Ok(())
```

(The tests call `artifacts_path`, which is private; tests in the same module can call it.)

- [ ] **Step 4: Commands**

In `src-tauri/src/lib.rs`, after `settings_save`, add:

```rust
#[tauri::command]
fn artifacts_load(store: State<'_, Store>, room: String) -> Result<Option<serde_json::Value>, String> {
    store.artifacts(&room)
}

#[tauri::command]
fn artifacts_save(store: State<'_, Store>, room: String, artifacts: serde_json::Value) -> Result<(), String> {
    store.save_artifacts(&room, &artifacts)
}

/// Write an artifact out of the app: to the path chosen in the save dialog,
/// or, with none, to the exports folder, for opening in its default app.
/// Returns where it went.
#[tauri::command]
fn artifact_export(store: State<'_, Store>, name: String, contents: String, path: Option<String>) -> Result<String, String> {
    let target = match path {
        Some(path) => std::path::PathBuf::from(path),
        None => store.folder().join("exports").join(safe_name(&name)?),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not save it: {e}"))?;
    }
    std::fs::write(&target, contents).map_err(|e| format!("Could not save it: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// A file name with only letters, digits, dots, dashes and underscores, never starting with a dot.
fn safe_name(name: &str) -> Result<String, String> {
    let kept: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
    let clean = kept.trim_start_matches('.');
    if clean.is_empty() {
        return Err("That file name can't be used.".into());
    }
    Ok(clean.to_string())
}
```

In `tauri::generate_handler![`, after `settings_save,` add `artifacts_load, artifacts_save, artifact_export,`.

- [ ] **Step 5: Allow the save dialog**

In `src-tauri/capabilities/default.json`, change `"dialog:allow-open"` to `"dialog:allow-open", "dialog:allow-save"`.

- [ ] **Step 6: Run the Rust tests**

Run (from `src-tauri`): `cargo test --workspace -- --test-threads=1`
Expected: PASS, including the three new tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/storage.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: save a thread's artifacts beside it, and export them"
```

---

### Task 5: Artifacts in both backends

**Files:**
- Modify: `src/backend.ts`

**Interfaces:**
- Produces: `artifactsLoad(room: string): Promise<unknown>`, `artifactsSave(room: string, artifacts: unknown): Promise<void>`, `artifactSave(name: string, contents: string): Promise<string | null>`, `artifactOpenExternal(name: string, contents: string): Promise<void>`.

- [ ] **Step 1: The interface**

In `interface Backend`, after `settingsSave(settings: unknown): Promise<void>;` add:

```ts
  /** A thread's artifacts file, beside the thread; artifacts.ts reads it. Null when there is none. */
  artifactsLoad(room: string): Promise<unknown>;
  artifactsSave(room: string, artifacts: unknown): Promise<void>;
  /** Ask where to save an artifact and write it there. Null when you cancel. */
  artifactSave(name: string, contents: string): Promise<string | null>;
  /** Write an artifact to the exports folder and open it in its default app. It runs outside the sandbox there. */
  artifactOpenExternal(name: string, contents: string): Promise<void>;
```

- [ ] **Step 2: Native**

After `settingsSave: (settings) => invoke("settings_save", { settings }),` add:

```ts
    artifactsLoad: (room) => invoke<unknown>("artifacts_load", { room }),
    artifactsSave: (room, artifacts) => invoke("artifacts_save", { room, artifacts }),
    artifactSave: async (name, contents) => {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: name });
      return path ? invoke<string>("artifact_export", { name, contents, path }) : null;
    },
    artifactOpenExternal: async (name, contents) => {
      const path = await invoke<string>("artifact_export", { name, contents, path: null });
      await invoke("open_target", { target: path, cwd: null, reveal: false });
    },
```

- [ ] **Step 3: Stand-in**

After the stand-in's `settingsSave`, add:

```ts
    artifactsLoad: async (room) => JSON.parse(localStorage.getItem(`apex-deck.demo.artifacts.${room}`) ?? "null"),
    artifactsSave: async (room, artifacts) => { localStorage.setItem(`apex-deck.demo.artifacts.${room}`, JSON.stringify(artifacts)); },
    artifactSave: async (name, contents) => {
      const url = URL.createObjectURL(new Blob([contents]));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return name;
    },
    artifactOpenExternal: async (name, contents) => {
      const type = name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".md") ? "text/plain" : "text/html";
      window.open(URL.createObjectURL(new Blob([contents], { type })), "_blank", "noopener");
    },
```

In the stand-in's `roomFork`, after the forked room is created, copy `apex-deck.demo.artifacts.<source>` to `apex-deck.demo.artifacts.<target>` when it exists. In the stand-in's `roomDelete`, remove `apex-deck.demo.artifacts.<id>`.

- [ ] **Step 4: Check and commit**

Run: `npm run build`
Expected: PASS.

```bash
git add src/backend.ts
git commit -m "feat: artifact load, save and export in both backends"
```

---

### Task 6: Open as artifact, on code blocks

**Files:**
- Modify: `src/Markdown.tsx`, `src/styles.css` (append)
- Create: `src/ArtifactButton.tsx`

**Interfaces:**
- Consumes: `CodeChoices` (Task 1).
- Produces: `Markdown` prop `codeAction?: (code: { language: string; text: string }) => ReactNode`; `ArtifactButton({ choices, showing, onChoose })`; `type CodeChoice = { kind: "new" } | { kind: "version"; artifactId: string } | { kind: "show"; artifactId: string; n: number }`.

- [ ] **Step 1: Let Markdown take extra code-block controls**

In `src/Markdown.tsx`:

- In `interface Props`, after `onOpen`, add:

```ts
  /** Extra controls for a code block's header, beside Copy. */
  codeAction?: (code: { language: string; text: string }) => ReactNode;
```

- Change `export function Markdown({ text, onOpen }: Props)` to take `codeAction`, and the map to `<BlockView key={i} block={block} inline={inline} codeAction={codeAction} />`.
- Change `function BlockView({ block, inline }: { block: Block; inline: (source: string) => ReactNode })` to `function BlockView({ block, inline, codeAction }: { block: Block; inline: (source: string) => ReactNode; codeAction?: Props["codeAction"] })`, and its code case to:

```tsx
    case "code":
      return <CodeBlock language={block.language} text={block.text} action={codeAction?.({ language: block.language, text: block.text })} />;
```

- Change `function CodeBlock({ language, text }: { language: string; text: string })` to `function CodeBlock({ language, text, action }: { language: string; text: string; action?: ReactNode })`, and replace its Copy button with:

```tsx
        <span className="md-code-actions">
          {action}
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
```

- [ ] **Step 2: The button**

`src/ArtifactButton.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";

import type { CodeChoices } from "./artifacts";

// The control a code block in a finished reply gets when its kind can open
// as an artifact. Only a person's click makes an artifact. See the spec, 2.2.

export type CodeChoice = { kind: "new" } | { kind: "version"; artifactId: string } | { kind: "show"; artifactId: string; n: number };

interface Props {
  choices: CodeChoices;
  /** True while the panel shows the version this block was opened as. */
  showing: boolean;
  onChoose: (choice: CodeChoice) => void;
}

export function ArtifactButton({ choices, showing, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (choices.opened) {
    const { artifactId, n } = choices.opened;
    return (
      <button type="button" className={showing ? "artifact-shown on" : "artifact-shown"} aria-pressed={showing} onClick={() => onChoose({ kind: "show", artifactId, n })}>
        {showing ? `Showing v${n}` : `Show v${n}`}
      </button>
    );
  }
  if (choices.tooLarge) return <button type="button" disabled title="Too large to open as an artifact.">Open as artifact</button>;
  if (choices.targets.length === 0) return <button type="button" onClick={() => onChoose({ kind: "new" })}>Open as artifact</button>;
  const choose = (choice: CodeChoice) => {
    setOpen(false);
    onChoose(choice);
  };
  return (
    <span className="artifact-choice" ref={wrap}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((on) => !on)}>Open as artifact ▾</button>
      {open && (
        <span className="artifact-menu" role="menu" aria-label="Open as artifact">
          {choices.targets.map((target) => (
            <button key={target.id} type="button" role="menuitem" onClick={() => choose({ kind: "version", artifactId: target.id })}>
              New version of {target.title}
              <small>Becomes v{target.next}. Earlier versions are kept.</small>
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => choose({ kind: "new" })}>
            New artifact
            <small>Starts its own history at v1.</small>
          </button>
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 3: Styles**

Append to `src/styles.css`:

```css
/* A code block's controls: Open as artifact (and its menu) beside Copy. */
.md-code-actions { display: flex; align-items: center; gap: 2px; }
.md-code:has(.artifact-menu) { overflow: visible; }
.artifact-shown.on { color: var(--accent); }
.artifact-choice { position: relative; display: inline-flex; }
.artifact-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; width: 260px; padding: 4px; display: flex; flex-direction: column; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 12px 32px #0007; }
.md-code-head .artifact-menu button { display: flex; flex-direction: column; align-items: flex-start; width: 100%; padding: 6px 10px; border-radius: 6px; color: var(--text); font-size: 12px; text-align: left; }
.md-code-head .artifact-menu button:hover, .md-code-head .artifact-menu button:focus-visible { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.artifact-menu small { font-size: 11px; color: var(--muted); }
```

- [ ] **Step 4: Check and commit**

Run: `npm test` and `npm run build`. Expected: PASS (nothing uses `codeAction` yet; every existing reply looks the same).

```bash
git add src/Markdown.tsx src/ArtifactButton.tsx src/styles.css
git commit -m "feat: Open as artifact control for code blocks"
```

---

### Task 7: The panel

**Files:**
- Create: `src/ArtifactsPanel.tsx`
- Modify: `src/styles.css` (append)

**Interfaces:**
- Consumes: Tasks 1–3; `Backend.artifactSave`, `Backend.artifactOpenExternal` (Task 5); `Markdown`.
- Produces: `ArtifactsPanel` (props below), `type ArtifactTab`, `interface PanelView`, `DEFAULT_VIEW`.

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Backend } from "./backend";
import { Markdown } from "./Markdown";
import { KIND_LABEL, ago, exportName, newestFirst, pickVersion, type ArtifactFile, type ArtifactKind } from "./artifacts";
import { frameDocument } from "./artifactFrame";
import { compact, lineDiff } from "./lineDiff";

// The artifacts panel: beside the conversation, over it in a narrow thread,
// or over the whole deck in full window. See the spec, 2.3.

export type ArtifactTab = "preview" | "source" | "changes";

/** What the panel shows. A null `artifactId` or `n` means the newest. */
export interface PanelView {
  artifactId: string | null;
  n: number | null;
  tab: ArtifactTab;
  full: boolean;
  /** The list of the thread's artifacts, instead of one. */
  list: boolean;
}

export const DEFAULT_VIEW: PanelView = { artifactId: null, n: null, tab: "preview", full: false, list: false };

interface Props {
  file: ArtifactFile;
  view: PanelView;
  onView: (view: PanelView) => void;
  onClose: () => void;
  /** Over the conversation, for a narrow thread. */
  overlay: boolean;
  nameOf: (participantId: string) => string;
  colorOf: (participantId: string) => string;
  onOpenLink: (target: string, reveal?: boolean) => void;
  backend: Backend;
  /** Why changes here aren't being saved, if they aren't. */
  problem: string;
}

const TABS: { id: ArtifactTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "source", label: "Source" },
  { id: "changes", label: "Changes" },
];

const icon = (paths: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
);
const CORNERS = icon(<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>);
const COPY = icon(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>);
const SAVE = icon(<><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></>);
const EXTERNAL = icon(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>);
const KIND_ICON: Record<ArtifactKind, ReactNode> = {
  html: icon(<><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M10 13l-2 2 2 2" /><path d="M14 13l2 2-2 2" /></>),
  svg: icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" /></>),
  markdown: icon(<><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M8 13h8" /><path d="M8 17h6" /></>),
};

export function ArtifactsPanel({ file, view, onView, onClose, overlay, nameOf, colorOf, onOpenLink, backend, problem }: Props) {
  const root = useRef<HTMLElement>(null);
  const picked = pickVersion(file, view.artifactId, view.n);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState("");
  const [wandered, setWandered] = useState(false);
  /** Bumped to put an artifact back after it navigated its frame away. */
  const [reloads, setReloads] = useState(0);
  const loads = useRef(0);
  const frameKey = picked ? `${picked.artifact.id}:${picked.version.n}:${reloads}` : "";

  useEffect(() => { loads.current = 0; }, [frameKey]);
  useEffect(() => {
    setWandered(false);
    setFailed("");
  }, [picked?.artifact.id, picked?.version.n]);

  // Esc leaves full window; in a narrow thread, with focus in the panel, it closes the panel.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (view.full) {
        event.preventDefault();
        onView({ ...view, full: false });
      } else if (overlay && root.current?.contains(document.activeElement)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, overlay, onView, onClose]);

  const set = (change: Partial<PanelView>) => onView({ ...view, ...change });
  const classes = ["artifacts-panel", overlay && !view.full ? "overlay" : "", view.full ? "full-window" : ""].filter(Boolean).join(" ");

  if (!picked || view.list) {
    return (
      <aside ref={root} className={classes} aria-label="Artifacts">
        <div className="artifacts-head">
          <div>
            <strong>Artifacts</strong>
            <span className="artifacts-meta">{file.artifacts.length === 1 ? "1 in this thread" : `${file.artifacts.length} in this thread`}</span>
          </div>
          {picked && <button className="icon small" onClick={() => set({ list: false })} aria-label="Back to the artifact" title="Back">‹</button>}
          <button className="icon small" onClick={onClose} aria-label="Close artifacts" title="Close">×</button>
        </div>
        <div className="artifacts-body">
          {file.artifacts.length === 0 ? (
            <p className="artifacts-empty">Nothing here yet. Click Open as artifact on a code block in any reply.</p>
          ) : (
            <div className="artifacts-list">
              {newestFirst(file).map((artifact) => {
                const latest = artifact.versions[artifact.versions.length - 1];
                return (
                  <button key={artifact.id} aria-current={artifact.id === picked?.artifact.id ? "true" : undefined} onClick={() => set({ artifactId: artifact.id, n: null, list: false })}>
                    <span className="artifacts-kind">{KIND_ICON[artifact.kind]}</span>
                    <span className="artifacts-row">
                      <strong>{artifact.title}</strong>
                      <span className="artifacts-meta">{KIND_LABEL[artifact.kind]} · v{latest.n} · {latest.by ? nameOf(latest.by) : "someone"} · {ago(latest.at, Date.now())}</span>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {problem && <div className="artifacts-foot"><span role="alert">{problem}</span></div>}
      </aside>
    );
  }

  const { artifact, version } = picked;
  const total = artifact.versions.length;
  const previous = artifact.versions.find((v) => v.n === version.n - 1);
  const who = version.by ? nameOf(version.by) : "someone";
  const name = exportName(artifact, version.n);
  const copy = () => {
    navigator.clipboard?.writeText(version.source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };
  const run = (action: Promise<unknown>) => { action.catch((error) => setFailed(`Couldn't do that: ${String(error)}`)); };
  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      setWandered(true);
      setReloads((n) => n + 1);
    }
  };
  const note = problem || failed || (wandered ? "This artifact tried to open another page. It was put back." : "");

  return (
    <aside ref={root} className={classes} aria-label={`Artifact: ${artifact.title}`}>
      <div className="artifacts-head">
        <div>
          <button className="artifacts-title" onClick={() => set({ list: true })} title="All artifacts in this thread">{artifact.title} ▾</button>
          <span className="artifacts-meta">{KIND_LABEL[artifact.kind]} · v{version.n} of {total} · by {who}</span>
        </div>
        <button className="icon small" onClick={() => set({ full: !view.full })} aria-label={view.full ? "Back to the thread" : "Full window"} title={view.full ? "Back to the thread (Esc)" : "Full window (Esc to go back)"}>
          {view.full ? "▣" : CORNERS}
        </button>
        {!view.full && <button className="icon small" onClick={onClose} aria-label="Close artifacts" title="Close">×</button>}
      </div>
      <div className="artifacts-bar">
        <div className="artifacts-tabs" role="tablist" aria-label="View">
          {TABS.map((tab) => (
            <button key={tab.id} role="tab" aria-selected={view.tab === tab.id} onClick={() => set({ tab: tab.id })}>{tab.label}</button>
          ))}
        </div>
        <span className="spacer" />
        <button className="icon small" disabled={version.n <= 1} onClick={() => set({ artifactId: artifact.id, n: version.n - 1 })} aria-label="Older version" title="Older version">‹</button>
        <span className="artifacts-version">v{version.n}</span>
        <button className="icon small" disabled={version.n >= total} onClick={() => set({ artifactId: artifact.id, n: version.n + 1 })} aria-label="Newer version" title="Newer version">›</button>
        <span className="artifacts-sep" aria-hidden="true" />
        <button className="icon small" onClick={copy} aria-label="Copy source" title={copied ? "Copied" : "Copy source"}>{copied ? "✓" : COPY}</button>
        <button className="icon small" onClick={() => run(backend.artifactSave(name, version.source))} aria-label="Save to folder" title="Save to folder…">{SAVE}</button>
        <button className="icon small" onClick={() => run(backend.artifactOpenExternal(name, version.source))} aria-label="Open in browser" title="Open in browser">{EXTERNAL}</button>
      </div>
      <div className="artifacts-body" role="tabpanel">
        {view.tab === "preview" && (artifact.kind === "markdown" ? (
          <div className="artifact-doc"><Markdown text={version.source} onOpen={onOpenLink} /></div>
        ) : (
          <iframe key={frameKey} title={`${artifact.title}, version ${version.n}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={frameDocument(artifact.kind, version.source)} onLoad={onFrameLoad} />
        ))}
        {view.tab === "source" && <Source text={version.source} />}
        {view.tab === "changes" && (previous ? <Changes before={previous.source} after={version.source} /> : <p className="artifacts-empty">First version. Nothing to compare yet.</p>)}
      </div>
      <div className="artifacts-foot">
        <span className="dot" style={version.by ? { background: colorOf(version.by) } : undefined} aria-hidden="true" />
        <span>v{version.n} by {who} · {ago(version.at, Date.now())}</span>
        <span className="spacer" />
        {note ? <span role="alert">{note}</span> : artifact.kind !== "markdown" && <span title="It can't reach your files, the network or the app.">Runs sandboxed</span>}
      </div>
    </aside>
  );
}

function Source({ text }: { text: string }) {
  return (
    <pre className="artifact-source">
      {text.split("\n").map((line, i) => <span key={i} className="line"><span className="n">{i + 1}</span>{line || " "}</span>)}
    </pre>
  );
}

function Changes({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => compact(lineDiff(before, after)), [before, after]);
  return (
    <pre className="artifact-changes">
      {rows.map((row, i) => ("skipped" in row ? (
        <span key={i} className="gap">⋯ {row.skipped} unchanged {row.skipped === 1 ? "line" : "lines"}</span>
      ) : (
        <span key={i} className={`line ${row.sign === "+" ? "add" : row.sign === "-" ? "del" : "same"}`}>
          <span className="sign">{row.sign === "-" ? "−" : row.sign}</span>
          {row.text || " "}
        </span>
      )))}
    </pre>
  );
}
```

- [ ] **Step 2: Styles**

Append to `src/styles.css`:

```css
/* Artifacts: code from replies, opened on request, beside the conversation. */
.artifacts-panel { flex: none; width: min(440px, 46%); min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--panel); }
.artifacts-panel.overlay { position: absolute; top: 0; right: 0; bottom: 0; z-index: 30; width: min(440px, 100%); box-shadow: -12px 0 32px #0005; }
.artifacts-backdrop { position: absolute; inset: 0; z-index: 29; border: 0; border-radius: 0; background: #0003; }
.artifacts-panel.full-window { position: fixed; top: var(--deck-top, 0px); left: 0; right: 0; bottom: 0; z-index: 35; width: auto; border: 0; box-shadow: none; background: var(--bg); }
.artifacts-head { display: flex; align-items: flex-start; gap: 6px; padding: 12px 8px 12px 16px; border-bottom: 1px solid var(--line); }
.artifacts-head > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.artifacts-title { align-self: flex-start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 6px; margin-left: -6px; font-weight: 600; background: transparent; border-color: transparent; }
.artifacts-meta { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.artifacts-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--line); }
.artifacts-tabs { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line); }
.artifacts-tabs button { padding: 2px 10px; font-size: 12px; background: transparent; border-color: transparent; color: var(--muted); }
.artifacts-tabs button[aria-selected="true"] { background: var(--panel-2); border-color: var(--line); color: var(--text); }
.artifacts-version { min-width: 22px; text-align: center; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.artifacts-sep { width: 1px; height: 18px; margin: 0 2px; background: var(--line); }
.artifacts-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.artifacts-body iframe { flex: 1; width: 100%; border: 0; background: #fff; }
.artifact-doc { padding: 16px 20px; }
.artifact-source, .artifact-changes { flex: 1; margin: 0; padding: 10px 0; box-sizing: border-box; background: #0b1016; color: #d5dde6; font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
.artifact-source .line, .artifact-changes .line { display: flex; white-space: pre; }
.artifact-source .n { width: 34px; flex: none; padding-right: 12px; text-align: right; color: #5b6875; user-select: none; }
.artifact-changes .sign { width: 22px; flex: none; text-align: center; user-select: none; }
.artifact-changes .line.add { color: #86efac; background: rgba(34, 197, 94, 0.12); }
.artifact-changes .line.del { color: #fca5a5; background: rgba(239, 68, 68, 0.12); }
.artifact-changes .line.same { color: var(--muted); }
.artifact-changes .gap { display: block; padding: 2px 22px; color: var(--muted); }
.artifacts-foot { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-top: 1px solid var(--line); font-size: 11px; color: var(--muted); }
.artifacts-empty { margin: auto; padding: 24px; max-width: 32ch; text-align: center; color: var(--muted); }
.artifacts-list { padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.artifacts-list button { display: flex; align-items: center; gap: 12px; width: 100%; padding: 9px 10px; text-align: left; background: transparent; border-color: transparent; }
.artifacts-list button:hover { background: var(--panel-2); }
.artifacts-list button[aria-current="true"] { background: var(--panel-2); border-color: var(--line); }
.artifacts-kind { width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); }
.artifacts-row { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.thread-counts .on { border-color: var(--accent); color: var(--text); }
```

- [ ] **Step 3: Check and commit**

Run: `npm run build`
Expected: PASS.

```bash
git add src/ArtifactsPanel.tsx src/styles.css
git commit -m "feat: artifacts panel with preview, source, changes and full window"
```

---

### Task 8: The panel in the thread

**Files:**
- Modify: `src/ChatPane.tsx`; `src/App.tsx` only if `--deck-top` isn't set yet

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Make sure `--deck-top` is set**

Run: `grep -n "deck-top" src/App.tsx`. If it prints a line, skip this step. Otherwise, in `src/App.tsx`, after the `focusPane` function, add:

```ts
  // Where the deck starts, for things that expand to the full window (the
  // Preview pane, the artifacts panel). Kept current as the title bar wraps.
  const deckTopWatch = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || deckTopWatch.current) return;
    const set = () => document.documentElement.style.setProperty("--deck-top", `${body.getBoundingClientRect().top}px`);
    set();
    deckTopWatch.current = new ResizeObserver(set);
    deckTopWatch.current.observe(body);
  });
  useEffect(() => () => deckTopWatch.current?.disconnect(), []);
```

- [ ] **Step 2: Imports and state**

In `src/ChatPane.tsx`, add with the other local imports:

```ts
import { ArtifactButton, type CodeChoice } from "./ArtifactButton";
import { ArtifactsPanel, DEFAULT_VIEW, type PanelView } from "./ArtifactsPanel";
import { EMPTY_ARTIFACTS, MAX_SOURCE, addArtifact, addVersion, codeChoices, kindOf, pickVersion, readArtifacts, type ArtifactFile } from "./artifacts";
```

Add `Speaker` to the `./types` type import if it isn't there. Above `export function ChatPane`, add:

```ts
/** Below this width the artifacts panel covers the conversation instead of sitting beside it. */
const NARROW_PX = 760;
```

After the `menuRequest` effect (the block that starts `const lastMenu = useRef(menuRequest?.n ?? 0);` and ends `}, [menuRequest]);`), add:

```ts
  // Artifacts: code from replies, opened on request, saved beside the thread.
  // A file that can't be read is never written over. See artifacts.ts.
  const [artifacts, setArtifacts] = useState<ArtifactFile>(EMPTY_ARTIFACTS);
  const [artifactsLoaded, setArtifactsLoaded] = useState(false);
  const [artifactProblem, setArtifactProblem] = useState("");
  const [panel, setPanel] = useState<PanelView | null>(null);
  const artifactsReadable = useRef(false);
  const artifactSaves = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (profileMode) return;
    let live = true;
    artifactsReadable.current = false;
    setArtifactsLoaded(false);
    backend.artifactsLoad(pane.id).then(
      (raw) => {
        if (!live) return;
        setArtifacts(readArtifacts(raw));
        artifactsReadable.current = true;
        setArtifactProblem("");
        setArtifactsLoaded(true);
      },
      () => {
        if (!live) return;
        setArtifactProblem("Artifacts couldn't be read, so changes here won't be saved.");
        setArtifactsLoaded(true);
      },
    );
    return () => { live = false; };
  }, [backend, pane.id, profileMode]);

  const changeArtifacts = (next: ArtifactFile) => {
    setArtifacts(next);
    if (!artifactsReadable.current) return;
    artifactSaves.current = artifactSaves.current
      .then(() => backend.artifactsSave(pane.id, next))
      .then(() => setArtifactProblem(""), (error) => setArtifactProblem(`Couldn't save artifacts: ${String(error)}`));
  };

  const showVersion = (artifactId: string, n: number) => setPanel((view) => ({ ...(view ?? DEFAULT_VIEW), artifactId, n, list: false }));

  /** A person chose what to do with a code block in a finished reply. */
  const openFromCode = (message: { seq: number; speaker: Speaker }, code: { language: string; text: string }, choice: CodeChoice) => {
    if (choice.kind === "show") {
      showVersion(choice.artifactId, choice.n);
      return;
    }
    const version = { source: code.text, by: message.speaker.kind === "bot" ? message.speaker.id : null, seq: message.seq, at: Date.now() };
    if (choice.kind === "version") {
      const added = addVersion(artifacts, choice.artifactId, version);
      if (added.n === 0) return;
      changeArtifacts(added.file);
      showVersion(choice.artifactId, added.n);
      return;
    }
    const kind = kindOf(code.language, code.text);
    if (!kind || code.text.length > MAX_SOURCE) return;
    const added = addArtifact(artifacts, `art-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, kind, version);
    changeArtifacts(added.file);
    showVersion(added.artifact.id, 1);
  };

  const shownVersion = panel && !panel.list ? pickVersion(artifacts, panel.artifactId, panel.n) : null;
  /** The control for a code block in a finished bot reply, or nothing. */
  const artifactAction = (message: { seq: number; speaker: Speaker }, code: { language: string; text: string }) => {
    if (!artifactsLoaded) return null;
    const choices = codeChoices(artifacts, message.seq, code.language, code.text);
    if (!choices) return null;
    const showing = Boolean(shownVersion && choices.opened && shownVersion.artifact.id === choices.opened.artifactId && shownVersion.version.n === choices.opened.n);
    return <ArtifactButton choices={choices} showing={showing} onChoose={(choice) => openFromCode(message, code, choice)} />;
  };

  // In a narrow thread the panel covers the conversation.
  const chatBody = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = chatBody.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
```

- [ ] **Step 3: Code blocks in finished bot replies**

In the bot bubble (`<div className="bubble bot completed">`), change `<Markdown text={entry.message.text} onOpen={openTarget} />` to:

```tsx
                <Markdown text={entry.message.text} onOpen={openTarget} codeAction={(code) => artifactAction(entry.message, code)} />
```

Leave the summary (`entry.summary.summary`) and the streaming reply (`partial`) as they are: a summary isn't a reply, and a reply still being written may hold half a block.

- [ ] **Step 4: The toggle**

Change `<div className="thread-counts">{changes.length > 0 &&` to:

```tsx
<div className="thread-counts">{artifacts.artifacts.length > 0 && <button className={panel ? "ghost small on" : "ghost small"} aria-pressed={panel !== null} onClick={() => setPanel((view) => (view ? null : DEFAULT_VIEW))}>Artifacts · {artifacts.artifacts.length}</button>}{changes.length > 0 &&
```

- [ ] **Step 5: The panel in the thread body**

Change `<div className="chat-body">` to `<div className="chat-body" ref={chatBody}>`. Just before that element's closing `</div>` (the one right after the `transcript-pills` block and before `{!profileMode && <div className="composer"`), add:

```tsx
      {!profileMode && panel && narrow && !panel.full && <button type="button" className="artifacts-backdrop" aria-label="Close artifacts" onClick={() => setPanel(null)} />}
      {!profileMode && panel && (
        <ArtifactsPanel
          file={artifacts}
          view={panel}
          onView={setPanel}
          onClose={() => setPanel(null)}
          overlay={narrow}
          nameOf={(id) => names.get(id) ?? id}
          colorOf={color}
          onOpenLink={openTarget}
          backend={backend}
          problem={artifactProblem}
        />
      )}
```

- [ ] **Step 6: Check in the browser preview**

Run: `npm test` and `npm run build`. Expected: PASS. Then in http://localhost:1431/, in a thread:

1. Add a Scripted bot whose line is a fenced block: ` ```html ` / `<title>Welcome email</title><h1>Your next idea. Ready to run.</h1>` / ` ``` `. Send a message. Expected: the block's header shows "Open as artifact" beside Copy. A ` ```js ` block shows only Copy.
2. Click it. Expected: the panel opens beside the transcript on "Welcome email", meta "HTML · v1 of 1 · by <bot>", the page rendered, foot "v1 by <bot> · just now · Runs sandboxed"; the block's control reads "Showing v1"; the bar reads "Artifacts · 1", pressed.
3. Change the bot's line to a different HTML block and send again. Expected: "Open as artifact ▾" with "New version of Welcome email / Becomes v2. Earlier versions are kept." and "New artifact". Pick the first. Expected: v2 of 2; ‹ shows v1 and the first block reads "Showing v1"; Changes on v2 shows − and + lines; on v1 "First version. Nothing to compare yet."
4. Source tab shows numbered lines. Copy source puts the text on the clipboard. Save to folder downloads `welcome-email-v2.html`. Open in browser opens a tab.
5. Full window. Expected: the panel covers rail and deck below the title bar; Esc returns. Then narrow the thread pane (drag a divider or add panes) below 760 px. Expected: the panel covers the transcript with a backdrop; clicking the backdrop closes it.
6. Click the title. Expected: the list, newest first; pick one to go back. Reload the app. Expected: artifacts and versions are still there. In the console, `localStorage.setItem("apex-deck.demo.artifacts.<thread id>", "{broken")`, reload, open an artifact. Expected: the foot says "Artifacts couldn't be read, so changes here won't be saved." and the stored value is still `{broken`.
7. Put `<script>fetch("https://example.com").then(()=>document.body.append("NET"),()=>document.body.append("BLOCKED"))</script><a href="https://example.com">go</a>` in an artifact. Expected: "BLOCKED" shows; clicking "go" puts the artifact back and the foot says "This artifact tried to open another page. It was put back."
8. Fork the thread (⋯ › Fork). Expected: the fork has the same artifacts. Delete a thread. Expected: its artifacts key is gone from localStorage.

- [ ] **Step 7: Commit**

```bash
git add src/ChatPane.tsx src/App.tsx
git commit -m "feat: artifacts panel inside the thread"
```

---

### Task 9: README and the desktop check

**Files:**
- Modify: `README.md`
- Create: `docs/artifacts-check.md`

- [ ] **Step 1: README**

Beside the description of threads in `README.md`, add:

```markdown
- **Artifacts.** On a bot's reply, Open as artifact on an HTML, SVG or Markdown code block shows it rendered in a panel beside the thread, sandboxed. Later blocks can become new versions; Source and Changes show the text and what changed. Saved with the thread.
```

- [ ] **Step 2: Desktop check**

Run `npm run tauri dev` and repeat Task 8 Step 6 with a real Claude Code or Codex bot asked for an HTML page in a fenced block. Then, in the web inspector with the artifact frame selected as the console context, run `typeof window.__TAURI_INTERNALS__` (expected `"undefined"`) and `fetch("http://localhost:1420/")` (expected to reject). Check that `rooms/<hex id>.artifacts.json` exists in the data folder (Settings › General › Show in Finder), is deleted with its thread, and is copied by a fork. Write each result in one line in `docs/artifacts-check.md`.

- [ ] **Step 3: Full checks and commit**

Run: `npm test`, `npm run build`, and from `src-tauri` `cargo test --workspace -- --test-threads=1`.
Expected: all PASS.

```bash
git add README.md docs/artifacts-check.md
git commit -m "docs: artifacts"
```
