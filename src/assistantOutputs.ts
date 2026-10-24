// Outputs: what an assistant made for you — a document, an export, a page — not
// what it changed in a repository. Code edits belong in Review, where the diff
// and the file list already live.
//
// Two recorded sources feed it, and nothing is inferred from prose:
//  1. The thread's artifacts (artifacts.ts): HTML, SVG and Markdown it wrote,
//     every version kept, which the app can open and preview.
//  2. The files its threads touched that are deliverables rather than code:
//     .json, .csv, .pdf, a config file. Only paths with a known deliverable
//     extension appear; anything else, source code included, is left alone.

import { fromReply, newestFirst, readArtifacts, type Artifact, type ArtifactFile, type ArtifactKind } from './artifacts';
import type { DiffFile } from './types';

/**
 * The artifacts room the assistant's own chat keeps its outputs in. The store
 * hex-encodes the room id into a filename, so any string is a valid key and
 * this needs no host change; `assistant:<id>` is the id its calls already use.
 */
export function assistantRoomId(assistantId: string): string {
  return `assistant:${assistantId}`;
}

/** A reply the assistant is making in its own chat, as far as outputs care. */
export interface OutputReply {
  id: string;
  role: string;
  text: string;
  at: number;
}

/** One of a reply's fenced code blocks, as markdownText.parseBlocks returns it. */
export interface ReplyCode {
  language: string;
  text: string;
}

/**
 * Promote a live reply's HTML or SVG into the assistant's artifacts, the way a
 * thread's replies are promoted. Only the kinds `fromReply` accepts become
 * outputs — a markdown fence is usually an example, not a deliverable — and a
 * reply is looked at once, tracked by id, so a re-render adds nothing twice.
 */
export function promoteReply(file: ArtifactFile, seen: Set<string>, reply: OutputReply, code: ReplyCode[], by: string, newId: string): { file: ArtifactFile; added: boolean } {
  if (reply.role !== 'assistant' || seen.has(reply.id)) return { file, added: false };
  seen.add(reply.id);
  if (code.length === 0) return { file, added: false };
  const out = fromReply(file, code, { source: '', by, seq: null, at: reply.at }, newId);
  return { file: out.file, added: Boolean(out.artifact) };
}

/** What a deliverable is, for its mark and its label. */
export type OutputKind = 'doc' | 'data' | 'view';

export interface AssistantOutput {
  id: string;
  /** What to show: the file's name, or an artifact's title when it has no path. */
  name: string;
  kind: OutputKind;
  /** The folder it sits in, relative to the one the task worked in; empty at the top. */
  folder: string;
  /** The file, as the record names it. Absent for a page that only ever lived in a reply. */
  path?: string;
  /** The folder the task worked in, so the file can be opened. */
  cwd?: string;
  threadId?: string;
  taskId?: string;
  /** Milliseconds since the epoch; 0 when the record doesn't say. */
  at: number;
  /** Present for a page, picture or document the app can open and keep versions of. */
  artifact?: Artifact;
}

/** Deliberate: code, archives and pictures are not in here, so they never show as an output. */
const KIND_BY_EXTENSION: Record<string, OutputKind> = {
  md: 'doc', markdown: 'doc', txt: 'doc', rtf: 'doc', pdf: 'doc',
  json: 'data', csv: 'data', tsv: 'data', yaml: 'data', yml: 'data', xml: 'data', config: 'data',
  html: 'view', htm: 'view', svg: 'view',
};

const KIND_BY_ARTIFACT: Record<ArtifactKind, OutputKind> = { markdown: 'doc', html: 'view', svg: 'view' };

export const OUTPUT_MARK: Record<OutputKind, string> = { doc: '▤', data: '{}', view: '◇' };
export const OUTPUT_LABEL: Record<OutputKind, string> = { doc: 'Document', data: 'Data', view: 'View' };

/** The output kind a path can be, from its extension; null for code and anything unknown. */
export function kindOfOutputPath(path: string): OutputKind | null {
  const ext = path.match(/\.([A-Za-z]+)$/)?.[1]?.toLowerCase();
  return ext ? KIND_BY_EXTENSION[ext] ?? null : null;
}

/** A path split for the row: its name, and the folder above it. */
export function outputName(path: string): { name: string; folder: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { name: path, folder: '' } : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}

const lastAt = (artifact: Artifact) => artifact.versions[artifact.versions.length - 1].at;

/** The text a row shows when opened: its newest version, cut to what a sidebar can render. */
export const MAX_PREVIEW = 8000;
export function previewSource(artifact: Artifact): string {
  const source = artifact.versions[artifact.versions.length - 1].source;
  return source.length > MAX_PREVIEW ? `${source.slice(0, MAX_PREVIEW)}\n…` : source;
}

/** Every artifact, newest first. */
export function outputsFromArtifacts(file: ArtifactFile, threadId: string, cwd?: string, taskId?: string): AssistantOutput[] {
  return newestFirst(file).map((artifact): AssistantOutput => {
    const where = artifact.path ? outputName(artifact.path) : null;
    return {
      id: `artifact:${artifact.id}`,
      name: where ? where.name : artifact.title,
      kind: KIND_BY_ARTIFACT[artifact.kind],
      folder: where ? where.folder : '',
      ...(artifact.path ? { path: artifact.path } : {}),
      ...(cwd ? { cwd } : {}),
      ...(taskId ? { taskId } : {}),
      threadId,
      at: lastAt(artifact),
      artifact,
    };
  });
}

/** The deliverable files among ones a thread changed; code and unknown types drop out. */
export function outputsFromChanges(files: DiffFile[], threadId: string, cwd?: string, taskId?: string): AssistantOutput[] {
  return files.flatMap((file): AssistantOutput[] => {
    const kind = kindOfOutputPath(file.path);
    if (!kind) return [];
    const where = outputName(file.path);
    return [{
      id: `file:${file.path}`,
      name: where.name,
      kind,
      folder: where.folder,
      path: file.path,
      ...(cwd ? { cwd } : {}),
      ...(taskId ? { taskId } : {}),
      threadId,
      at: 0,
    }];
  });
}

/**
 * Newest first, then by name. A path appears once: an artifact beats a bare file
 * row for it, because the artifact carries its versions and can be opened.
 */
export function mergeOutputs(...lists: AssistantOutput[][]): AssistantOutput[] {
  const byKey = new Map<string, AssistantOutput>();
  for (const list of lists) {
    for (const output of list) {
      const key = output.path ?? `${output.threadId ?? ''}/${output.name}`;
      const seen = byKey.get(key);
      if (!seen || (!seen.artifact && output.artifact)) byKey.set(key, output);
    }
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

export function outputsLine(list: AssistantOutput[]): string {
  if (list.length === 0) return 'No deliverables yet';
  return list.length === 1 ? '1 deliverable' : `${list.length} deliverables`;
}

/** What an output needs from a backend: the thread's artifacts, and what its folder changed. */
export interface OutputsBackend {
  artifactsLoad(room: string): Promise<unknown>;
  roomDiff(room: string): Promise<{ files: DiffFile[] }>;
}

export interface OutputsTask {
  id: string;
  owner?: { cwd?: string };
  destination?: { threadId: string | null } | null;
}

/** How many of this session's threads are worth asking; older ones are not this session. */
export const MAX_OUTPUT_THREADS = 8;

/**
 * Read this session's outputs: the assistant's own chat first, then each task
 * thread. A thread that can't be read contributes nothing rather than failing
 * the list; a folder that isn't a repository has no file rows, which is normal
 * for a task that only wrote a document.
 */
export async function loadOutputs(backend: OutputsBackend, tasks: OutputsTask[], assistantId?: string): Promise<AssistantOutput[]> {
  const seen = new Set<string>();
  const wanted: { threadId: string; cwd?: string; taskId: string }[] = [];
  for (const task of tasks) {
    const threadId = task.destination?.threadId ?? null;
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    wanted.push({ threadId, cwd: task.owner?.cwd, taskId: task.id });
    if (wanted.length >= MAX_OUTPUT_THREADS) break;
  }
  const room = assistantId ? assistantRoomId(assistantId) : null;
  const lists = await Promise.all([
    // What the assistant made in its own chat: the main place things get made.
    ...(room ? [backend.artifactsLoad(room).catch(() => null).then((raw) => (raw === null ? [] : outputsFromArtifacts(readArtifactsSafe(raw), room)))] : []),
    ...wanted.map(async ({ threadId, cwd, taskId }) => {
      const [raw, diff] = await Promise.all([
        backend.artifactsLoad(threadId).catch(() => null),
        backend.roomDiff(threadId).catch(() => null),
      ]);
      const artifacts = raw === null ? [] : outputsFromArtifacts(readArtifactsSafe(raw), threadId, cwd, taskId);
      return [...artifacts, ...outputsFromChanges(diff?.files ?? [], threadId, cwd, taskId)];
    }),
  ]);
  return mergeOutputs(...lists);
}

// Kept separate so a damaged file degrades to "no artifacts" instead of throwing.
function readArtifactsSafe(raw: unknown): ArtifactFile {
  try {
    return readArtifacts(raw);
  } catch {
    return { version: 1, artifacts: [] };
  }
}
