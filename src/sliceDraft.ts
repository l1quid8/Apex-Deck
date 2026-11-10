import { attachmentName } from "./attachments.ts";

export type Token =
  | { kind: "text"; text: string }
  | { kind: "thread"; paneId: string; hostId: string }
  | { kind: "file"; fileId: string };

export type DraftDoc = Token[][];

/** Replace the single composer's thread query without losing its line boundaries. */
export function singleToMultiDoc(text: string, start: number, end: number, picked: {paneId:string;hostId:string}): DraftDoc {
  const before: DraftDoc = text.slice(0,start).split('\n').map(line=>line?[{kind:'text',text:line}]:[]);
  before[before.length-1].push({kind:'thread',...picked});
  const after=text.slice(end).split('\n');
  if(after[0])before[before.length-1].push({kind:'text',text:after[0]});
  for(const line of after.slice(1))before.push(line?[{kind:'text',text:line}]:[]);
  return before;
}

/** Offsets count text characters; each chip occupies one character. */
export interface Caret { line: number; offset: number }

export interface RemovedSlice {
  lines: { index: number; tokens: Token[] }[];
  replaced: { index: number; tokens: Token[] }[];
  /** Extra result rows created when preserving separate split ownership. */
  inserted?: number[];
}

export interface DraftNames {
  thread(id: string): string;
  file(id: string): { label: string; name: string } | null;
}

export const DRAFT_MIME = "application/x-apex-deck-draft+json";

export function addThreadLine(doc: DraftDoc, ref: { paneId: string; hostId: string }): { doc: DraftDoc; caret: Caret | null } {
  return {
    doc: [...doc, [{ kind: "thread", paneId: ref.paneId, hostId: ref.hostId }]],
    caret: doc.length === 0 ? { line: 0, offset: 1 } : null,
  };
}

const hasContent = (tokens: Token[]) => tokens.some((token) => token.kind !== "text" || token.text.trim() !== "");

function lineOwnership(tokens: Token[]) {
  const tags = tokens.flatMap((token, index) => token.kind === "thread" ? [{ index, paneId: token.paneId }] : []);
  const parts = tags.map((tag, index) => tokens.slice(index ? tags[index - 1].index + 1 : 0, tag.index));
  parts.push(tokens.slice((tags.at(-1)?.index ?? -1) + 1));
  const adjacent = parts.slice(1, -1).every((part) => !hasContent(part));
  const mode = adjacent ? "group"
    : !hasContent(parts[0]) && hasContent(parts.at(-1)!) ? "leading"
    : hasContent(parts[0]) && !hasContent(parts.at(-1)!) ? "trailing"
    : "ambiguous";
  return { tags, mode };
}

/** Remove a destination together with only the content unambiguously owned by it. */
export function removeThread(doc: DraftDoc, paneId: string): { doc: DraftDoc; removed: RemovedSlice | null } {
  const ownership = doc.map(lineOwnership);
  const matches = ownership.map((line) => line.tags.some((tag) => tag.paneId === paneId));
  // Removing only some occurrences would leave the destination selected and
  // make the apparent Undo disagree with what was actually removed.
  if (!matches.some(Boolean) || ownership.some((line, index) => matches[index] && line.mode === "ambiguous")) {
    return { doc, removed: null };
  }
  const removed: RemovedSlice = { lines: [], replaced: [] };
  const next: DraftDoc = [];
  doc.forEach((tokens, index) => {
    if (!matches[index]) { next.push(tokens); return; }
    const { tags, mode } = ownership[index];
    if (tags.every((tag) => tag.paneId === paneId)) {
      removed.lines.push({ index, tokens });
      return;
    }
    const discarded = new Set<number>();
    tags.forEach((tag, tagIndex) => {
      if (tag.paneId !== paneId) return;
      const start = mode === "trailing" ? (tags[tagIndex - 1]?.index ?? -1) + 1 : tag.index;
      const end = mode === "leading" ? tags[tagIndex + 1]?.index ?? tokens.length : tag.index + 1;
      for (let at = start; at < end; at++) discarded.add(at);
    });
    const remaining = tokens.filter((_, at) => !discarded.has(at));
    // A removal can collapse split tags into a group or leave tags at both
    // ends. Keep each surviving owner's words separate in those cases.
    if (mode !== "group" && lineOwnership(remaining).mode !== mode && tags.filter(tag => tag.paneId !== paneId).length > 1) {
      const rows = tags.flatMap((tag, tagIndex) => {
        if (tag.paneId === paneId) return [];
        const start = mode === "trailing" ? (tags[tagIndex - 1]?.index ?? -1) + 1 : tag.index;
        const end = mode === "leading" ? tags[tagIndex + 1]?.index ?? tokens.length : tag.index + 1;
        return [tokens.slice(start, end)];
      });
      rows.forEach((row, rowIndex) => {
        if (rowIndex) (removed.inserted ??= []).push(next.length);
        next.push(row);
      });
    } else next.push(remaining);
    removed.replaced.push({ index, tokens });
  });
  return { doc: next, removed };
}

export function restoreRemoved(doc: DraftDoc, removed: RemovedSlice): DraftDoc {
  const next = [...doc];
  for (const index of [...(removed.inserted ?? [])].sort((a, b) => b - a)) next.splice(index, 1);
  for (const line of [...removed.lines].sort((a, b) => a.index - b.index)) next.splice(line.index, 0, line.tokens);
  for (const line of removed.replaced) next[line.index] = line.tokens;
  return next;
}

export function threadIds(doc: DraftDoc): string[] {
  return [...new Set(doc.flatMap((line) => line.flatMap((token) => token.kind === "thread" ? [token.paneId] : [])))];
}

export function fileIds(doc: DraftDoc): string[] {
  return [...new Set(doc.flatMap((line) => line.flatMap((token) => token.kind === "file" ? [token.fileId] : [])))];
}

export function fileReference(label: string, name: string): string {
  return `[${label}: ${attachmentName(name)}]`;
}

/** For people and the clipboard. Outgoing sends use fileReference instead. */
export function readableText(doc: DraftDoc, names: DraftNames): string {
  return doc.map((line) => line.map((token) => {
    if (token.kind === "text") return token.text;
    if (token.kind === "thread") return `#${names.thread(token.paneId)}`;
    const file = names.file(token.fileId);
    return file ? `[${file.label}: ${file.name}]` : "[Missing attachment]";
  }).join("")).join("\n");
}

export function encodeClipboard(doc: DraftDoc, draftId: string, names: DraftNames): { plain: string; json: string } {
  return { plain: readableText(doc, names), json: JSON.stringify({ version: 1, draftId, doc }) };
}

export function decodeClipboard(json: string, draftId: string, known: { thread(id: string): boolean; file(id: string): boolean }): DraftDoc | null {
  try {
    const payload = JSON.parse(json);
    if (!payload || payload.version !== 1 || payload.draftId !== draftId || !Array.isArray(payload.doc)) return null;
    const doc: DraftDoc = [];
    for (const line of payload.doc) {
      if (!Array.isArray(line)) return null;
      const tokens: Token[] = [];
      for (const token of line) {
        if (!token || typeof token !== "object") return null;
        if (token.kind === "text" && typeof token.text === "string") tokens.push({ kind: "text", text: token.text });
        else if (token.kind === "thread" && typeof token.paneId === "string" && typeof token.hostId === "string" && known.thread(token.paneId)) {
          tokens.push({ kind: "thread", paneId: token.paneId, hostId: token.hostId });
        } else if (token.kind === "file" && typeof token.fileId === "string" && known.file(token.fileId)) tokens.push({ kind: "file", fileId: token.fileId });
        else return null;
      }
      doc.push(tokens);
    }
    return doc;
  } catch {
    return null;
  }
}
