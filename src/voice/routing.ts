import type { CallScope, VoiceCandidate } from "./types.ts";
type Candidate = Pick<
  VoiceCandidate,
  "hostId" | "roomId" | "participantId" | "name" | "aliases" | "roomTitle"
>;
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,!?]+$/, "")
    .trim();
const words = (s: string) =>
  [...s.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].normalize("NFKC").toLowerCase(),
    end: m.index! + m[0].length,
  }));
/** Where "in Voice calls" (or "on the Voice calls thread") ends in `rest` when `title` is "Voice calls"; 0 if it isn't there. */
function threadEnd(rest: string, title: string) {
  const said = words(rest),
    name = words(title).map((w) => w.word);
  if (!name.length || !["in", "on", "from"].includes(said[0]?.word ?? "")) return 0;
  for (const from of said[1]?.word === "the" ? [1, 2] : [1]) {
    if (!name.every((w, i) => said[from + i]?.word === w)) continue;
    const after = said[from + name.length];
    const end = after && (after.word === "thread" || after.word === "chat")
      ? after.end : said[from + name.length - 1].end;
    // A longer, misheard title must not turn into a message to a shorter title.
    const tail = rest.slice(end);
    if (!words(tail).length || /^\s*(?:[,;!?]|\.(?:\s|$))/.test(tail)) return end;
  }
  return 0;
}
/** Separate an unresolved target from a request only at an explicit boundary. */
function threadQuery(rest: string) {
  const target = rest.replace(/^(?:in|on|from)\b\s*(?:the\b\s*)?/i, "");
  const boundary = /[,;]|[.!?](?=\s|$)/.exec(target);
  return {
    query: (boundary ? target.slice(0, boundary.index) : target).replace(/(?:^|\s+)(?:thread|chat)\s*$/i, "").trim(),
    text: boundary ? target.slice(boundary.index + boundary[0].length).replace(/^[\s,.:;!?]+/, "").trim() : "",
  };
}
function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 3) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}
function suggestThreads<T extends Candidate>(query: string, candidates: T[]): T[] {
  const said = words(query).map((w) => w.word);
  if (!said.length) return candidates;
  const ranked = candidates.map((candidate) => {
    const title = words(candidate.roomTitle ?? "").map((w) => w.word);
    const score = said.reduce((sum, word) => sum + Math.max(0, ...title.map((w) => wordSimilarity(word, w))), 0) / said.length;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score);
  const threshold = Math.max(0.6, (ranked[0]?.score ?? 0) - 0.15);
  const likely = ranked.filter((r) => r.score >= threshold).slice(0, 5).map((r) => r.candidate);
  // Similarity only orders suggestions. It never authorizes a call.
  return likely.length ? likely : candidates;
}
export function resolveCallCommand<T extends Candidate>(
  text: string,
  candidates: readonly T[],
  /** The call's chat: its agents answer before same-named agents in other chats. */
  here?: Pick<CallScope, "hostId" | "roomId">,
):
  | { kind: "text"; text: string }
  | { kind: "end" }
  | { kind: "switch"; candidate: T; text: string }
  | { kind: "ambiguous"; candidates: T[]; text: string; threadQuery?: string }
  | { kind: "unknown"; text: string } {
  const raw = text.trim();
  if (normalize(raw) === "stop listening") return { kind: "end" };
  const command = /^call\s+(.+)$/i.exec(raw);
  if (!command) return { kind: "text", text: raw };
  const matches = candidates.flatMap((candidate) =>
    [candidate.name, ...candidate.aliases].flatMap((name) => {
      const n = normalize(name);
      const c = normalize(command[1]);
      return n && c.startsWith(n) && (c.length === n.length || /^[\s,.:;!?]/.test(c.slice(n.length)))
        ? [{ candidate, length: n.length }]
        : [];
    }),
  );
  const longest = Math.max(0, ...matches.map((m) => m.length));
  const found = [
    ...new Set(
      matches.filter((m) => m.length === longest).map((m) => m.candidate),
    ),
  ];
  const rest = command[1]
    .slice(longest)
    .replace(/^[\s,.:;!?]+/, "")
    .trim();
  // "call Jigga in Voice calls" picks that thread's Jigga; otherwise this chat's comes first.
  const ends = found.map((c) => (c.roomTitle ? threadEnd(rest, c.roomTitle) : 0));
  const end = Math.max(0, ...ends);
  if (found.length && !end && /^(?:in|on|from)\b/i.test(rest)) {
    const { query, text } = threadQuery(rest);
    return { kind: "ambiguous", candidates: suggestThreads(query, found), text, threadQuery: query };
  }
  const local = found.filter((c) => c.hostId === here?.hostId && c.roomId === here?.roomId);
  const picked = end ? found.filter((_, i) => ends[i] === end) : local.length ? local : found;
  const message = end ? rest.slice(end).replace(/^[\s,.:;!?]+/, "").trim() : rest;
  return picked.length === 1
    ? { kind: "switch", candidate: picked[0], text: message }
    : picked.length
      ? { kind: "ambiguous", candidates: picked, text: message }
      : { kind: "unknown", text: raw };
}
