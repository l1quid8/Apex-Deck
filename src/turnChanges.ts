import type { MadeChange } from "./ApprovalCard";
import type { Message } from "./types";

export interface TurnFile {
  path: string;
  added: number;
  removed: number;
}

function botIdOf(message: Message): string | null {
  return message.speaker.kind === "bot" ? message.speaker.id : null;
}

/** Group reported file changes under the first reply from the same bot that
 *  follows them. `ChangeRecord.seq` is the transcript length when the round
 *  began, so a change belongs to the first message from its author with
 *  `seq >= change.seq`. Model-agnostic: only author id and seq are used. */
export function turnFilesFor(
  messages: Message[],
  changes: MadeChange[],
  mounts: {seq:number; changeCount?:number}[] = [],
): Map<number, TurnFile[]> {
  const out = new Map<number, TurnFile[]>();
  const byAuthor = new Map<string, Message[]>();
  for (const message of messages) {
    const id = botIdOf(message);
    if (!id) continue;
    const list = byAuthor.get(id) ?? [];
    list.push(message);
    byAuthor.set(id, list);
  }
  for (const list of byAuthor.values()) list.sort((a, b) => a.seq - b.seq);

  // Attribute each change to its reply, aggregating by path.
  const buckets = new Map<number, Map<string, TurnFile>>();
  for (const [index, record] of changes.entries()) {
    const replies = byAuthor.get(record.by);
    if (!replies) continue;
    // A failed/pass turn must not transfer its edits to a later checkout's reply.
    const epoch = mounts.filter(mount => mount.changeCount == null ? record.seq >= mount.seq : index >= mount.changeCount).length;
    const reply = replies.find((message) => message.seq >= record.seq && mounts.filter(mount => message.seq >= mount.seq).length === epoch);
    if (!reply) continue;
    let bucket = buckets.get(reply.seq);
    if (!bucket) {
      bucket = new Map<string, TurnFile>();
      buckets.set(reply.seq, bucket);
    }
    const before = bucket.get(record.change.path);
    if (before) {
      before.added += record.change.added;
      before.removed += record.change.removed;
    } else {
      bucket.set(record.change.path, {
        path: record.change.path,
        added: record.change.added,
        removed: record.change.removed,
      });
    }
  }
  for (const [seq, bucket] of buckets) {
    out.set(seq, [...bucket.values()].sort((a, b) => a.path.localeCompare(b.path)));
  }
  return out;
}
