import { parseComposer } from './commands.ts';
import { mentionedWords, mentionTarget } from './recipients.ts';
import { fileReference, type DraftDoc, type Token } from './sliceDraft.ts';

export interface ThreadInfo {
  paneId: string;
  hostId: string;
  title: string;
  open: boolean;
  agents: { id: string; handle: string; name: string }[];
  defaultAgentIds: string[];
}

export interface Slice {
  paneId: string;
  hostId: string;
  text: string;
  routing: string;
  files: string[];
  command: 'compact' | 'curate' | 'curate_undo' | null;
  to: string[] | null;
  group: boolean;
}

/** Line indexes are zero-based. A duplicate lists every offending chip, so
 * two copies on line zero are reported as lines: [0, 0]. */
export type Problem =
  | { kind: 'duplicate'; paneId: string; lines: number[] }
  | { kind: 'unresolved' | 'untagged' | 'ambiguous'; line: number }
  | { kind: 'empty' | 'no-agents' | 'command-with-text' | 'file-to-command'; paneId: string }
  | { kind: 'unknown-agent'; paneId: string; name: string }
  | { kind: 'command-not-allowed'; paneId: string; command: string }
  | { kind: 'file-reading'; fileId: string };

export interface PlanFile {
  label: string;
  name: string;
  reading: boolean;
}

interface Entry {
  tokens: Token[];
  group: boolean;
}

const nonempty = (tokens: Token[]) => tokens.some((token) => token.kind === 'file' || (token.kind === 'text' && token.text.trim() !== ''));
const people = (thread: ThreadInfo) => thread.agents.map((agent) => ({ id: agent.id, display_name: agent.handle }));

function unknownMentions(routing: string, thread: ThreadInfo): string[] {
  const roster = people(thread);
  return [...new Set(mentionedWords(routing))].filter((name) => name !== 'all' && name !== 'everyone' && mentionTarget(`@${name}`, roster).length === 0);
}

function trimmed(tokens: Token[]): Token[] {
  const result = [...tokens];
  while (result[0]?.kind === 'text') {
    const text = result[0].text.trimStart();
    if (text) { result[0] = { kind: 'text', text }; break; }
    result.shift();
  }
  while (result.at(-1)?.kind === 'text') {
    const last = result[result.length - 1] as Extract<Token, { kind: 'text' }>;
    const text = last.text.trimEnd();
    if (text) { result[result.length - 1] = { kind: 'text', text }; break; }
    result.pop();
  }
  return result;
}

function render(tokens: Token[], files: Map<string, PlanFile>, routing: boolean): string {
  return tokens.map((token) => {
    if (token.kind === 'text') return token.text;
    if (token.kind === 'thread') return '';
    if (routing) return ' ';
    const file = files.get(token.fileId);
    return file ? fileReference(file.label, file.name) : '[Missing attachment]';
  }).join('').trim();
}

/** Plan only: no file reads, queue mutations or default-recipient changes. */
export function planSend(input: {
  doc: DraftDoc;
  threads: Map<string, ThreadInfo>;
  overrides: Map<string, string>;
  files: Map<string, PlanFile>;
}): { slices: Slice[]; problems: Problem[] } {
  const { doc, threads, overrides, files } = input;
  const problems: Problem[] = [];
  const entries = new Map<string, Entry[]>();
  const duplicates = new Map<string, number[]>();
  const reading = new Set<string>();
  const hasTags = doc.some((line) => line.some((token) => token.kind === 'thread'));

  doc.forEach((line, index) => {
    const tags: Extract<Token, { kind: 'thread' }>[] = [];
    const parts: Token[][] = [[]];
    for (const token of line) {
      if (token.kind === 'thread') {
        tags.push(token);
        parts.push([]);
      } else parts[parts.length - 1].push(token);
    }
    if (!tags.length) {
      if (hasTags && nonempty(line)) problems.push({ kind: 'untagged', line: index });
      return;
    }

    const counts = new Map<string, number>();
    let unresolved = false;
    for (const tag of tags) {
      counts.set(tag.paneId, (counts.get(tag.paneId) ?? 0) + 1);
      if (!entries.has(tag.paneId)) entries.set(tag.paneId, []);
      const thread = threads.get(tag.paneId);
      if (!thread?.open || thread.hostId !== tag.hostId) unresolved = true;
    }
    for (const [paneId, count] of counts) {
      if (count > 1) duplicates.set(paneId, [...(duplicates.get(paneId) ?? []), ...Array<number>(count).fill(index)]);
    }
    for (const token of line) {
      if (token.kind !== 'file') continue;
      const file = files.get(token.fileId);
      if (!file) unresolved = true;
      else if (file.reading) reading.add(token.fileId);
    }
    // Missing attachment metadata is unresolved too: never silently omit a chip.
    if (unresolved) problems.push({ kind: 'unresolved', line: index });

    const first = parts[0];
    const last = parts[parts.length - 1];
    if (parts.slice(1, -1).every((part) => !nonempty(part))) {
      // Trim the two sides separately, like the approved mockup, while leaving
      // every token boundary within either side intact.
      const body: Token[] = [];
      if (nonempty(first)) body.push(...trimmed(first));
      if (nonempty(first) && nonempty(last)) body.push({ kind: 'text', text: ' ' });
      if (nonempty(last)) body.push(...trimmed(last));
      tags.forEach((tag) => entries.get(tag.paneId)!.push({ tokens: body, group: tags.length > 1 }));
    } else if (!nonempty(first) && nonempty(last)) {
      tags.forEach((tag, at) => entries.get(tag.paneId)!.push({ tokens: parts[at + 1], group: false }));
    } else if (nonempty(first) && !nonempty(last)) {
      tags.forEach((tag, at) => entries.get(tag.paneId)!.push({ tokens: parts[at], group: false }));
    } else problems.push({ kind: 'ambiguous', line: index });
  });

  for (const [paneId, lines] of duplicates) problems.push({ kind: 'duplicate', paneId, lines });
  for (const fileId of reading) problems.push({ kind: 'file-reading', fileId });

  const slices: Slice[] = [];
  for (const [paneId, own] of entries) {
    const thread = threads.get(paneId);
    if (!thread) continue;
    const commandEntries = own.filter((entry) => 'command' in parseComposer(render(entry.tokens, files, true)));
    const chosen = commandEntries.length ? commandEntries : own;
    const routing = chosen.map((entry) => render(entry.tokens, files, true)).filter(Boolean).join('\n\n');
    const text = chosen.map((entry) => render(entry.tokens, files, false)).filter(Boolean).join('\n\n');
    const referenced = [...new Set(chosen.flatMap((entry) => entry.tokens.flatMap((token) => token.kind === 'file' ? [token.fileId] : [])))];
    const parsed = parseComposer(routing);
    let command: Slice['command'] = null;
    if ('command' in parsed) {
      const name = parsed.command.name;
      if (name === 'compact' || name === 'curate' || name === 'curate_undo') command = name;
      else problems.push({ kind: 'command-not-allowed', paneId, command: name === 'unknown' ? parsed.command.typed : name });
      if (own.some((entry) => !entry.group && !commandEntries.includes(entry) && nonempty(entry.tokens))) {
        problems.push({ kind: 'command-with-text', paneId });
      }
      if (referenced.length) problems.push({ kind: 'file-to-command', paneId });
    }
    if (!text && !referenced.length) problems.push({ kind: 'empty', paneId });
    if (!thread.agents.length) problems.push({ kind: 'no-agents', paneId });

    const mentions = mentionedWords(routing);
    for (const name of unknownMentions(routing, thread)) problems.push({ kind: 'unknown-agent', paneId, name });
    const override = overrides.get(paneId);
    const to = mentions.length || commandEntries.length || !override ? null : [override];
    if (to && !thread.agents.some((agent) => agent.id === override)) {
      problems.push({ kind: 'unknown-agent', paneId, name: override! });
    }
    slices.push({ paneId, hostId: thread.hostId, text, routing, files: referenced, command, to, group: chosen.length > 0 && chosen.every((entry) => entry.group) });
  }
  return { slices, problems };
}

/** The optional draft file map and planning problems explain in-progress reads,
 * including group files suppressed by commands. Unused files never count. */
export function summaryLine(slices: Slice[], threads: Map<string, ThreadInfo>, files?: Map<string, PlanFile>, problems: Problem[] = []): string {
  const fileIds = [...new Set(slices.flatMap((slice) => slice.files))];
  const readingIds = new Set([...fileIds, ...problems.flatMap((problem) => problem.kind === 'file-reading' ? [problem.fileId] : [])]);
  for (const id of readingIds) {
    const file = files?.get(id);
    if (file?.reading) return `Reading ${file.name}…`;
  }
  const counts = new Map<string, number>();
  let commands = 0;
  let unavailable = 0;
  for (const slice of slices) {
    if (slice.command) {
      commands++;
      continue;
    }
    const thread = threads.get(slice.paneId);
    if (!thread?.open || !thread.agents.length || unknownMentions(slice.routing, thread).length || slice.to?.some((id) => !thread.agents.some((agent) => agent.id === id))) {
      unavailable++;
      continue;
    }
    const typed = mentionTarget(slice.routing, people(thread));
    const ids = typed === 'everyone' ? thread.agents.map((agent) => agent.id) : typed.length ? typed : slice.to ?? thread.defaultAgentIds;
    for (const id of new Set(ids)) {
      const name = thread.agents.find((agent) => agent.id === id)?.name;
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const recipients = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ');
  const parts = [`To ${slices.length} ${slices.length === 1 ? 'thread' : 'threads'}`];
  if (recipients) parts.push(recipients);
  if (unavailable) parts.push(`${unavailable} can't receive`);
  if (commands) parts.push(`${commands} ${commands === 1 ? 'command' : 'commands'}`);
  if (fileIds.length) parts.push(`${fileIds.length} ${fileIds.length === 1 ? 'file' : 'files'}`);
  return parts.join(' · ');
}
