import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { voiceLabel } from "./callView.ts";
import { voiceController, warmVoice } from "./coordinator.ts";
import "./voice.css";

const play = (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M8 5.5v13l11-6.5z" />
  </svg>
);
const stop = (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <rect fill="currentColor" x="6" y="6" width="14" height="14" rx="1.5" />
  </svg>
);

/** Plays a short line in one voice, so it can be heard before it's picked. */
export function VoiceSampleButton({ voice }: { voice: string }) {
  const call = useSyncExternalStore(voiceController.subscribe, voiceController.getState, voiceController.getState);
  const inCall = call.status !== "off" && call.status !== "error";
  const unavailable = "Use the call’s preview button while a call is active.";
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState("");
  const run = useRef(0);
  const busy = useRef(false);
  busy.current = phase !== "idle";
  // Leaving the page stops this button's sample.
  useEffect(() => () => {
    run.current++;
    if (busy.current) void voiceController.stopSample();
  }, []);
  const click = () => {
    if (inCall) return;
    if (phase !== "idle") {
      void voiceController.stopSample();
      return;
    }
    const mine = ++run.current;
    setError("");
    setPhase("loading");
    voiceController
      .sample(voice, () => run.current === mine && setPhase("playing"))
      .catch((e) => run.current === mine && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => run.current === mine && setPhase("idle"));
  };
  const label = phase === "idle" ? `Play a sample of ${voiceLabel(voice)}` : "Stop the sample";
  return (
    <span className="voice-sample">
      <button type="button" className="voice-sample-btn" aria-label={label} title={inCall ? unavailable : label} disabled={inCall} onClick={click}
        onPointerEnter={inCall ? undefined : warmVoice} onFocus={inCall ? undefined : warmVoice}>
        {phase === "idle" ? play : stop}
      </button>
      <span className={"voice-sample-note" + (error ? " error" : "")} role="status">
        {inCall ? unavailable : error || (phase === "loading" ? "Loading voice…" : "")}
      </span>
    </span>
  );
}
