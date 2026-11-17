import type { Backend } from "./backend";
import type { Message, RevertPlan } from "./types";
import { goBackAlways, goBackAsks, goBackRequest, initialFiles, type GoBack, type RevertScope } from "./revertConfirm";

type HistoryBackend = Pick<Backend, "roomRevertPlan" | "roomRevert">;

/** The bot whose reply is being retried, or null for a user's message. */
export function retryBot(message: Message) {
  return message.speaker.kind === "bot" ? message.speaker.id : null;
}

export function planHistoryChange(backend: HistoryBackend, room: string, message: Message) {
  return backend.roomRevertPlan(room, message.seq, retryBot(message));
}

export function historyConfirmation(kind: GoBack, plan: RevertPlan) {
  return {
    ask: goBackAsks(goBackAlways(kind), plan),
    scope: "both" as const,
    ticked: initialFiles(plan),
  };
}

export async function applyHistoryChange(
  backend: HistoryBackend, room: string, message: Message,
  kind: GoBack, scope: RevertScope, plan: RevertPlan, ticked: readonly string[],
) {
  const request = goBackRequest(kind === "retry" ? "both" : scope, plan, ticked);
  const bot = retryBot(message);
  const failed = await backend.roomRevert(room, message.seq, bot, request.chat, request.files);
  return { request, bot, failed };
}
