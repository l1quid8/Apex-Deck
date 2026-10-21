import type { ServerVoiceStatus, VoiceState } from "../voice/types.ts";
export function voiceSize(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.round(bytes / 1e6)} MB`;
}
export function voiceCallView(input: {
  state: VoiceState;
  agent: string;
  machine: string;
  weak: boolean;
  attention: boolean;
  setup?: ServerVoiceStatus;
  canSetUp: boolean;
}) {
  const { state, agent, machine, weak, attention, setup, canSetUp } = input;
  const active = !["off", "error", "setup"].includes(state.status);
  const statuses: Record<VoiceState["status"], string> = {
    off: "",
    setup: "Set up voice",
    warming: `Starting voice on ${machine}…`,
    listening: state.muted ? "Muted" : "Listening",
    hearing: "Hearing you",
    waiting: `${agent} is thinking`,
    speaking: `${agent} is speaking`,
    "needs-attention": state.error ?? `${agent} needs you in the thread`,
    error: state.error ?? "The call ended",
  };
  let status = statuses[state.status];
  if (weak && !state.muted && ["listening", "hearing"].includes(state.status))
    status = "Weak connection — some words may be lost";
  return {
    status,
    mic: {
      label: active
        ? "Call controls"
        : agent
          ? `Call ${agent}`
          : "Start a voice call",
      active,
    },
    bar: active
      ? `On call with ${agent}${attention ? " · needs you" : ""}`
      : null,
    setup:
      setup && !setup.installed
        ? {
            title: `Voice calls on ${machine}`,
            body: `Calls in this machine's threads listen and speak on ${machine}, so they work with your Mac off. Setup downloads about ${voiceSize(setup.downloadBytes)} to ${machine} once.`,
            button:
              !canSetUp || setup.installing
                ? null
                : setup.failed
                  ? "Try again"
                  : "Set up voice",
            progress: setup.installing
              ? `${setup.installing.stage} · ${voiceSize(setup.installing.downloaded)} of ${voiceSize(setup.installing.total)}`
              : null,
            note: !canSetUp
              ? "Only a phone with Full access can set this up. Change it on the Mac in Settings → Paired devices."
              : setup.failed
                ? `Setup stopped: ${setup.failed}`
                : null,
          }
        : null,
  };
}
