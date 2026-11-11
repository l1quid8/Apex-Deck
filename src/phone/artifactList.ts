// Artifacts on the phone: the list, and the words around one version.
//
// The Mac decides what is an artifact and writes the file (artifacts.ts); the phone
// only reads it. Reading needs ReadOnly on the thread — the host's authority table
// allows "artifacts_load" at ReadOnly and "artifacts_save" at Full — so a phone that
// may see a conversation may see the artifacts it made, and this sheet never writes.
//
// These rules are plain functions so they can be tested on their own.

import { KIND_LABEL, ago, newestFirst, type Artifact, type ArtifactFile, type ArtifactVersion } from "../artifacts.ts";

export interface ArtifactRow {
  id: string;
  title: string;
  /** "HTML", "SVG" or "Markdown". */
  kind: string;
  /** "1 version" or "3 versions": what the row's second line counts. */
  versions: string;
  /** "just now", "4m ago": when its newest version arrived. */
  when: string;
  /** Where it came from, when a bot read it from a file in the workspace. */
  path: string | null;
}

/** The sheet's list: most recently changed first, which is the order the Mac's panel starts in. */
export function artifactRows(file: ArtifactFile, now: number): ArtifactRow[] {
  return newestFirst(file).map((artifact) => ({
    id: artifact.id,
    title: artifact.title,
    kind: KIND_LABEL[artifact.kind],
    versions: `${artifact.versions.length} version${artifact.versions.length === 1 ? "" : "s"}`,
    when: ago(latestAt(artifact), now),
    path: artifact.path ?? null,
  }));
}

/** What the list says when the thread has none: not "loading", and not an error. */
export function artifactListNote(count: number): string {
  return count === 0 ? "No artifacts yet. When a reply's code or a file an agent writes can be shown, it's kept here." : "";
}

function latestAt(artifact: Artifact): number {
  const versions = artifact.versions;
  return versions.length === 0 ? 0 : versions[versions.length - 1].at;
}

/** One version's line: "Version 2 of 3 · HTML · 6.2 KB · 4m ago". */
export function versionWords(artifact: Artifact, version: ArtifactVersion, now: number): string {
  return [`Version ${version.n} of ${artifact.versions.length}`, KIND_LABEL[artifact.kind], sizeWords(version.source.length), ago(version.at, now)].join(" · ");
}

/** Source size in rounded KB, with one decimal under 10 KB: "840 B", "6.2 KB", "1.4 MB". */
export function sizeWords(characters: number): string {
  const bytes = Math.max(0, Math.round(characters));
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * How a version draws on a small screen. Markdown is text; the other two run in
 * the Mac's double sandbox, so a version made of a page still can't reach the
 * phone, its files or the network (artifactFrame.ts, frameDocument).
 */
export function versionLook(kind: Artifact["kind"]): "frame" | "text" {
  return kind === "markdown" ? "text" : "frame";
}
