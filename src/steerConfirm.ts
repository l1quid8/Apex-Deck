// Whether a steer asks first. Steering stops a bot mid-turn, which can
// leave work half-done, so the first steer asks unless you chose otherwise.

/** A thread's own choice: follow Settings, always ask, or never ask. */
export type ThreadSteer = "global" | "ask" | "never";

/** What the steer prompt can answer. Cancel keeps the message queued. */
export type SteerAnswer = "once" | "thread" | "always" | "cancel";

const key = (pane: string) => `apex-deck.steer.${pane}`;

/** The thread's saved choice; anything unreadable follows Settings. */
export function threadSteer(pane: string): ThreadSteer {
  try {
    const saved = localStorage.getItem(key(pane));
    return saved === "ask" || saved === "never" ? saved : "global";
  } catch {
    return "global";
  }
}

export function saveThreadSteer(pane: string, choice: ThreadSteer) {
  if (choice === "global") localStorage.removeItem(key(pane));
  else localStorage.setItem(key(pane), choice);
}

/** True when a steer should ask first. The thread's choice wins over Settings. */
export function steerAsks(confirmSteer: boolean, thread: ThreadSteer): boolean {
  return thread === "global" ? confirmSteer : thread === "ask";
}

/** What an answer changes: whether to steer, and which setting to save. */
export function steerAnswer(answer: SteerAnswer): { steer: boolean; thread?: ThreadSteer; confirmSteer?: boolean } {
  if (answer === "cancel") return { steer: false };
  if (answer === "thread") return { steer: true, thread: "never" };
  if (answer === "always") return { steer: true, confirmSteer: false };
  return { steer: true };
}
