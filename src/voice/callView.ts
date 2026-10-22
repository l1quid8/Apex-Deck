import type { VoiceState } from "./types.ts";
/** Where a running call shows: a bar over the chat box, the mic grown into a pill, or a capsule in the thread's top bar. */
export type CallLook = "bar" | "pill" | "capsule";
export const DEFAULT_CALL_LOOK: CallLook = "pill";
export const CALL_LOOKS: { id: CallLook; label: string }[] = [
  { id: "bar", label: "Bar" },
  { id: "pill", label: "Pill" },
  { id: "capsule", label: "Top bar" },
];
export const readCallLook = (raw: unknown): CallLook =>
  raw === "bar" || raw === "pill" || raw === "capsule" ? raw : DEFAULT_CALL_LOOK;
export type WaveMode = "you" | "bot" | "dots" | "flat";
/** `status` sits beside the bot's name; `hint` is a whole sentence for the chat box. */
export type CallLine = {
  status: string;
  hint: string;
  wave: WaveMode;
  tone: "ok" | "warn" | "muted";
};
export function callLine(state: VoiceState, name: string): CallLine {
  const line = (status: string, hint: string, wave: WaveMode, tone: CallLine["tone"] = "ok") => ({ status, hint, wave, tone });
  if (state.status === "error") {
    const text = state.error ?? "Call failed";
    return line(text, text, "flat", "warn");
  }
  if (state.status === "warming")
    return state.reconnecting
      ? line("Reconnecting…", "Reconnecting to the voice helper…", "flat", "warn")
      : line("Starting…", "Starting the call…", "flat");
  if (state.status === "needs-attention") {
    const text = state.error ?? "Needs you in the thread";
    return line(text, text, "flat", "warn");
  }
  if (state.muted)
    return line(
      `Muted · ${name} can still talk`,
      `You're muted · ${name} can still talk`,
      state.status === "speaking" ? "bot" : "flat",
      "muted",
    );
  switch (state.status) {
    case "hearing":
      return line("Hearing you…", "Hearing you…", "you");
    case "waiting":
      return line("Working…", `${name} is working…`, "dots");
    case "speaking":
      return line("Talking · speak to interrupt", `${name} is talking · speak to interrupt`, "bot");
    default:
      return line("Listening", "Listening… or type here", "flat");
  }
}
/** The composer's one round button: the mic while the box is empty, Send once it has something.
 *  In a Pill call the pill holds the mic's place, so Send shows beside it. */
export function composerButton(input: { hasContent: boolean; canCall: boolean; live: boolean; look: CallLook }) {
  const { hasContent, canCall, live, look } = input;
  if (live && look === "pill") return { mic: true, send: hasContent };
  if (live) return { mic: !hasContent, send: hasContent };
  const mic = canCall && !hasContent;
  return { mic, send: !mic };
}
export function callClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
const ACCENTS: Record<string, string> = { a: "US", b: "UK", e: "Spanish", f: "French", h: "Hindi", i: "Italian", j: "Japanese", p: "Portuguese", z: "Chinese" };
/** Kokoro voice ids read as a name and accent: "am_michael" → "Michael · US". */
export function voiceLabel(id: string) {
  const m = /^([a-z])[a-z]_([a-z0-9]+)$/.exec(id);
  if (!m || !ACCENTS[m[1]]) return id;
  return `${m[2][0].toUpperCase()}${m[2].slice(1)} · ${ACCENTS[m[1]]}`;
}
