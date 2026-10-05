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
  /** The workspace file it was read from, as the bot named it; absent for code from a reply. */
  path?: string;
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
    const path = typeof a.path === "string" && a.path ? a.path : undefined;
    return [path ? { id: a.id, title, kind, versions, path } : { id: a.id, title, kind, versions }];
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

/** The kind a file can open as, from its extension; null when it can't. */
export function kindForPath(path: string): ArtifactKind | null {
  const ext = path.match(/\.([A-Za-z]+)$/)?.[1]?.toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "md" || ext === "markdown") return "markdown";
  return null;
}

/**
 * A file a bot wrote: a new artifact for a new path, else a new version of
 * the one already made from it. `added` is false when nothing changed.
 */
export function upsertFromFile(file: ArtifactFile, path: string, version: NewVersion, newId: string): { file: ArtifactFile; artifact: Artifact | null; added: boolean } {
  const kind = kindForPath(path);
  if (!kind || version.source.length > MAX_SOURCE) return { file, artifact: null, added: false };
  const existing = file.artifacts.find((a) => a.path === path);
  if (existing) {
    const next = addVersion(file, existing.id, version);
    const artifact = next.file.artifacts.find((a) => a.id === existing.id) ?? existing;
    return { file: next.file, artifact, added: next.file !== file };
  }
  const made = addArtifact(file, newId, kind, version);
  const artifact = { ...made.artifact, path };
  return { file: { version: 1, artifacts: [...file.artifacts, artifact] }, artifact, added: true };
}

/**
 * A finished reply's code: its last HTML or SVG block that isn't an artifact
 * yet becomes one. Markdown fences are usually examples, so they wait for a click.
 */
export function fromReply(file: ArtifactFile, code: { language: string; text: string }[], version: NewVersion, newId: string): { file: ArtifactFile; artifact: Artifact | null } {
  for (let i = code.length - 1; i >= 0; i--) {
    const choices = codeChoices(file, version.seq ?? -1, code[i].language, code[i].text);
    if (!choices || choices.kind === "markdown" || choices.tooLarge) continue;
    if (choices.opened) return { file, artifact: null };
    return addArtifact(file, newId, choices.kind, { ...version, source: code[i].text });
  }
  return { file, artifact: null };
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

const AUTO_OPEN_KEY = "apex-deck.artifacts.autoOpen";

/** Whether the pane opens by itself when a bot writes a file it can show. On unless turned off. */
export function artifactAutoOpen(): boolean {
  try { return localStorage.getItem(AUTO_OPEN_KEY) !== "off"; } catch { return true; }
}

export function setArtifactAutoOpen(on: boolean) {
  try { localStorage.setItem(AUTO_OPEN_KEY, on ? "on" : "off"); } catch { /* not saved */ }
}
