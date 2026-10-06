// Host-scoped event subscriptions; the outer hooks integrate shared UI state.
import { recordApproval } from "./approvals";
import { recordPlan } from "./plans";
import { modHost } from "./mods/host";
import { createEventHub } from "./eventHub.ts";
const hub = createEventHub({
  approval: (host, room, event) => recordApproval(room, event, host),
  plan: (host, event) => { if (event.type === "plan_usage") recordPlan(event.provider, event.windows, event.partial, host); },
  roomEvent: (_host, room, event) => modHost.roomEvent(room, event),
  toolCall: (_host, room, event) => modHost.toolCall(room, event.id, event.action),
  notice: text => modHost.notice(text),
});
export const startHub = hub.start;
export const registerRoom = hub.registerRoom;
export const registerPty = hub.registerPty;
