import type { VoiceState } from "./types.ts";

type LiveStatus = Extract<VoiceState["status"], "listening" | "hearing" | "waiting" | "speaking" | "needs-attention">;
export interface CallFlowHooks {
  publish(status: LiveStatus): void;
  /** Pauses or resumes playback without losing its place. */
  hold(value: boolean): void;
  log(event: string, detail: Record<string, unknown>): void;
  holdLimitMs?: number;
}
export const AGENT_FAILED_SPEECH = "That reply failed. The details are in the thread.";
/** A verdict can go missing (a helper restart, a dropped Meta turn); a reply never stays paused for good. */
const HOLD_LIMIT_MS = 20000;

/** The one place a live call's status comes from. Each event changes one fact; the status follows from the facts. */
export function createCallFlow(hooks: CallFlowHooks) {
  let hearing = false,
    turn = false,
    speaking = false,
    attending = false,
    held = false,
    owed = 0,
    shown: LiveStatus = "listening",
    timer: ReturnType<typeof setTimeout> | undefined;
  const status = (): LiveStatus =>
    attending ? "needs-attention" : hearing ? "hearing" : speaking ? "speaking" : turn ? "waiting" : "listening";
  const publish = (cause: string) => {
    const next = status();
    if (next !== shown) hooks.log("stateTransition", { from: shown, to: next, cause });
    shown = next;
    hooks.publish(next);
  };
  const release = (resume: boolean) => {
    clearTimeout(timer);
    timer = undefined;
    if (held && resume) hooks.hold(false);
    held = false;
  };
  const pause = () => {
    if (held) return;
    held = true;
    hooks.hold(true);
  };
  const settle = () => {
    if (owed === 0) speaking = false;
  };
  return {
    speechStart() {
      if (hearing) return;
      hearing = true;
      if (speaking || owed > 0) pause();
      timer = setTimeout(() => {
        hooks.log("holdTimeout", {});
        hearing = false;
        release(true);
        publish("holdTimeout");
      }, hooks.holdLimitMs ?? HOLD_LIMIT_MS);
      publish("speechStart");
    },
    speechRejected(reason: string) {
      hooks.log("speechRejected", { reason });
      if (!hearing) return;
      hearing = false;
      release(true);
      publish("speechRejected");
    },
    /** The words were real. True when a reply is in the way: the caller stops it, and that flush clears any pause. */
    speechConfirmed() {
      const busy = speaking || turn || owed > 0;
      hearing = false;
      release(false);
      publish("speechConfirmed");
      return busy;
    },
    turnStart() {
      turn = true;
      attending = false;
      publish("turnStart");
    },
    turnEnd() {
      turn = false;
      publish("turnEnd");
    },
    spoken() {
      owed++;
      // A reply that turns up mid-sentence waits for the verdict like one already playing.
      if (hearing) pause();
    },
    playing() {
      speaking = true;
      if (hearing) pause();
      publish("playing");
    },
    drained() {
      owed = Math.max(0, owed - 1);
      settle();
      publish("drained");
    },
    dropped() {
      owed = Math.max(0, owed - 1);
      settle();
      publish("dropped");
    },
    flushed() {
      owed = 0;
      speaking = false;
      // The player drops its pause when it flushes.
      held = false;
      publish("flushed");
    },
    attention(value: boolean) {
      attending = value;
      publish("attention");
    },
    reset() {
      release(false);
      hearing = turn = speaking = attending = false;
      owed = 0;
      shown = "listening";
    },
    get status() {
      return status();
    },
  };
}
