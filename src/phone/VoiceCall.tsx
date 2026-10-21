import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import type { PhoneVoice } from "./phoneVoice.ts";
import type {
  ServerVoiceLink,
  ServerVoiceStatus,
  VoiceCandidate,
} from "../voice/types.ts";
import { preferenceFor, voicePreferenceKey } from "../voice/settings.ts";
import { voiceCallView } from "./voiceCallView.ts";
import "./voice-call.css";
export function VoiceCall({
  voice,
  hostId,
  roomId,
  machine,
  link,
  canSetUp,
  disabled,
  addressed,
  Sheet,
}: {
  voice: PhoneVoice;
  hostId: string;
  roomId: string;
  machine: string;
  link: ServerVoiceLink;
  canSetUp: boolean;
  disabled: boolean;
  addressed?: string[] | null;
  Sheet: React.ComponentType<{
    title: string;
    onClose(): void;
    children: React.ReactNode;
  }>;
}) {
  const [, redraw] = useState(0),
    [shown, setShown] = useState(false),
    [setup, setSetup] = useState<ServerVoiceStatus>(),
    [problem, setProblem] = useState("");
  useEffect(() => voice.subscribe(() => redraw((n) => n + 1)), [voice]);
  const state = voice.controller.getState(),
    candidates = voice.candidates(hostId, roomId),
    activeScope = !["off", "error", "setup"].includes(state.status) ? state.scope : undefined,
    callCandidates = activeScope
      ? voice.candidates(activeScope.hostId, activeScope.roomId)
      : candidates,
    selected =
      callCandidates.find(
        (c) => c.participantId === activeScope?.participantId,
      ) ??
      (addressed?.length === 1
        ? candidates.find((c) => c.participantId === addressed[0])
        : candidates.length === 1
          ? candidates[0]
          : undefined);
  const view = voiceCallView({
    state,
    agent: selected?.name ?? "",
    machine,
    ...voice.view(),
    setup: ["off", "setup", "error"].includes(state.status) ? setup : undefined,
    canSetUp,
  });
  const refresh = () =>
    link
      .status()
      .then(setSetup)
      .catch((e) => setProblem(String(e)));
  useEffect(() => {
    if (!shown || !setup?.installing) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [shown, !!setup?.installing, link]);
  const start = async (c: VoiceCandidate) => {
    setProblem("");
    await voice.controller.start(c);
    if (voice.controller.getState().status === "setup") await refresh();
  };
  useEffect(() => {
    setShown(false);
    setSetup(undefined);
    setProblem("");
  }, [hostId, roomId]);
  const tap = async () => {
    if (view.mic.active) {
      setShown((value) => !value);
      return;
    }
    setShown(true);
    const status = await link.status();
    setSetup(status);
    if (status.installed && selected) await start(selected);
  };
  const saveVoice = (c: VoiceCandidate, value: string) => {
    const s = voice.settings(),
      key = voicePreferenceKey(
        c.hostId,
        c.profileId,
        c.roomId,
        c.participantId,
      );
    voice.save({
      ...s,
      preferences: {
        ...s.preferences,
        [key]: {
          ...preferenceFor(s, c.hostId, c.profileId, c.roomId, c.participantId),
          voice: value,
        },
      },
    });
  };
  return (
    <>
      <button
        type="button"
        className={`ph-call-mic${view.mic.active ? " active" : ""}`}
        aria-label={view.mic.label}
        disabled={disabled}
        onClick={() =>
          void tap().catch((e) => {
            setProblem(String(e));
            setShown(true);
          })
        }
      >
        <svg
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <rect x="9" y="2" width="6" height="13" rx="3" />
          <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-4 0h8" />
        </svg>
      </button>
      {shown &&
        createPortal(
          <Sheet
            title={view.setup?.title ?? "Voice call"}
            onClose={() => setShown(false)}
          >
            <div className="ph-voice-sheet">
              {problem && <p role="alert">{problem}</p>}
              {view.setup ? (
                <>
                  <p>{view.setup.body}</p>
                  {view.setup.progress && (
                    <p role="status">{view.setup.progress}</p>
                  )}
                  {view.setup.note && <p>{view.setup.note}</p>}
                  {view.setup.button && (
                    <button
                      type="button"
                      onClick={() =>
                        void link
                          .install()
                          .then(refresh)
                          .catch((e) => setProblem(String(e)))
                      }
                    >
                      {view.setup.button}
                    </button>
                  )}
                  {setup?.installing && canSetUp && (
                    <button
                      type="button"
                      onClick={() => void link.cancelInstall().then(refresh)}
                    >
                      Cancel setup
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="ph-voice-status" role="status">
                    <i className="ph-voice-dot" />
                    {view.status || "Choose an agent to call"}
                  </p>
                  {!view.mic.active &&
                    candidates.map((c) => (
                      <button
                        type="button"
                        className="ph-voice-row"
                        key={c.participantId}
                        onClick={() => void start(c)}
                      >
                        {c.name}
                      </button>
                    ))}
                  {view.mic.active &&
                    state.candidates?.map((candidate) => (
                      <button
                        type="button"
                        className="ph-voice-row"
                        key={JSON.stringify([
                          candidate.hostId,
                          candidate.roomId,
                          candidate.participantId,
                        ])}
                        onClick={() =>
                          void voice.controller
                            .switchAgent(candidate)
                            .catch((error) => setProblem(String(error)))
                        }
                      >
                        {candidate.name}
                      </button>
                    ))}
                  {view.mic.active && (
                    <div className="ph-voice-actions">
                      <button
                        type="button"
                        onClick={() => voice.controller.mute(!state.muted)}
                      >
                        {state.muted ? "Unmute" : "Mute"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void voice.controller.end()}
                      >
                        End call
                      </button>
                    </div>
                  )}
                  {selected && (
                    <>
                      <label className="ph-voice-row">
                        Voice for {selected.name}
                        <select
                          value={
                            preferenceFor(
                              voice.settings(),
                              selected.hostId,
                              selected.profileId,
                              selected.roomId,
                              selected.participantId,
                            ).voice
                          }
                          onChange={(e) => saveVoice(selected, e.target.value)}
                        >
                          {(state.voices.length
                            ? state.voices
                            : ["am_michael"]
                          ).map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={!view.mic.active}
                        onClick={() =>
                          voice.controller.preview(
                            preferenceFor(
                              voice.settings(),
                              selected.hostId,
                              selected.profileId,
                              selected.roomId,
                              selected.participantId,
                            ).voice,
                          )
                        }
                      >
                        Preview
                      </button>
                    </>
                  )}
                  <label className="ph-voice-row">
                    Pause · {voice.settings().silenceMs} ms
                    <input
                      type="range"
                      min="100"
                      max="2000"
                      step="100"
                      value={voice.settings().silenceMs}
                      onChange={(e) =>
                        voice.save({
                          ...voice.settings(),
                          silenceMs: Number(e.target.value),
                        })
                      }
                    />
                    <small>Applies to the next call</small>
                  </label>
                </>
              )}
              <button
                type="button"
                className="ph-plain ph-wide"
                onClick={() => setShown(false)}
              >
                Hide
              </button>
            </div>
          </Sheet>,
          document.querySelector(".ph-app") ?? document.body,
        )}
    </>
  );
}
export function PhoneCallBar({
  voice,
  onOpen,
  hidden = false,
}: {
  voice: PhoneVoice;
  hidden?: boolean;
  onOpen(hostId: string, roomId: string): void;
}) {
  const [, redraw] = useState(0);
  useEffect(() => voice.subscribe(() => redraw((n) => n + 1)), [voice]);
  const state = voice.controller.getState(),
    s = state.scope;
  if (hidden || !s || ["off", "setup", "error"].includes(state.status))
    return null;
  const agent =
    voice
      .candidates(s.hostId, s.roomId)
      .find((c) => c.participantId === s.participantId)?.name ??
    s.participantId;
  return (
    <button
      type="button"
      className="ph-call-bar"
      onClick={() => onOpen(s.hostId, s.roomId)}
    >
      On call with {agent}
      {voice.view().attention ? " · needs you" : ""}
    </button>
  );
}
