// A message sent from the phone while its bots are still working waits on the
// phone, as on the desktop, instead of landing in the thread mid-reply. The
// desktop's ParticipantQueues does the waiting; this keeps it in step with
// what the thread's machine reports and words each queued line.

import type { ParticipantMessage, ParticipantQueues } from "./turnQueue";
import type { RoomEvent, TurnPolicy } from "./types";
import { hasMention } from "./recipients.ts";
import { splitTldr } from "./tldr.ts";

/** Keep a thread's queue in step with its machine: a bot that finishes lets what waits for it go. */
export function queueHears(queue: ParticipantQueues, event: RoomEvent) {
  switch (event.type) {
    case "turn_started": queue.started(event.id); break;
    case "participant_idle": queue.idle(event.id); break;
    // A failed reply holds what waits for that bot until the person resumes it, as on the desktop.
    case "failed": queue.error(event.id); break;
    // The machine has nothing running; a turn it dropped before it started sends no idle of its own.
    case "idle": for (const [id, state] of Object.entries(queue.state)) if (state === "working") queue.idle(id); break;
  }
}

/** Match the queue to who the machine says is working, after a reload or a reconnect. */
export function queueSync(queue: ParticipantQueues, active: readonly string[]) {
  for (const id of active) if (queue.state[id] !== "working") queue.started(id);
  for (const [id, state] of Object.entries(queue.state)) if (state === "working" && !active.includes(id)) queue.idle(id);
}

/**
 * Who an untagged message goes to while earlier ones still wait on the phone.
 * The thread only learns who was tagged last when a message is posted, so a
 * queued "@null" hasn't reached it yet; the untagged follow-up goes where the
 * last queued message goes, as it would once that one is posted. Null when the
 * thread's own answer stands: a tag in the text, a policy other than
 * last-tagged, or nothing queued.
 */
export function queuedSticky(text: string, ids: readonly string[], policy: TurnPolicy, items: readonly ParticipantMessage[]): string[] | null {
  if (policy !== "mention" || hasMention(text, [...ids])) return null;
  const last = [...items].reverse().find((item) => item.kind === "message");
  const to = last?.to.filter((id) => ids.includes(id)) ?? [];
  return to.length ? to : null;
}

export interface QueuedView {
  id: number;
  text: string;
  /** Who it is for: "Null", "Null and Jigga". */
  who: string;
  /** "Queued for Null", "Paused for Null and Jigga", "Waiting for Tyler's MacBook". */
  line: string;
  /** Some bot it is for is mid-reply, so it can be sent now by interrupting. */
  steerable: boolean;
  /** Held back by a Stop, a failed reply, or a dropped machine, so it needs Resume. */
  held: boolean;
}

const list = (names: string[]) => names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** How each queued message reads under the chat. */
export function queuedViews(
  items: readonly ParticipantMessage[], working: readonly string[], paused: readonly string[], lost: boolean,
  name: (id: string) => string, machine: string,
): QueuedView[] {
  return items.filter((item) => item.kind === "message").map((item) => {
    const who = list(item.to.map(name));
    const held = lost || item.to.some((id) => paused.includes(id));
    return {
      id: item.id,
      text: splitTldr(item.text).text,
      who,
      line: lost ? `Waiting for ${machine}` : held ? `Paused for ${who}` : `Queued for ${who}`,
      steerable: !lost && item.to.some((id) => working.includes(id)),
      held,
    };
  });
}

/** Put a message that didn't go back in the box, ahead of anything typed since. */
export function giveBack<F>(now: { text: string; files: F[] }, back: { text: string; files: F[] }): { text: string; files: F[] } {
  const text = now.text.trim() ? `${back.text}\n${now.text}` : back.text;
  return { text, files: [...back.files, ...now.files.filter((file) => !back.files.includes(file))] };
}
