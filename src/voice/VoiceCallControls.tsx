import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { popoverTop } from "../floating.ts";
import { voiceController, voiceRegistration } from "./coordinator.ts";
import { preferenceFor, voicePreferenceKey } from "./settings.ts";
import type { VoiceCandidate } from "./types.ts";
import "./voice.css";
export function VoiceCallControls({
  candidates,
  settings,
  disabled = false,
}: {
  candidates: VoiceCandidate[];
  settings?: import("./types").VoiceSettings;
  disabled?: boolean;
}) {
  const state = useSyncExternalStore(
    voiceController.subscribe,
    voiceController.getState,
  );
  const [picking, setPicking] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [progress, setProgress] = useState("");
  const [installing, setInstalling] = useState(false);
  const [download, setDownload] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = window.apexDeck?.voice;
    if (!r) return;
    void r.status().then((s) => setDownload(s.downloadBytes));
    return r.onProgress((p) =>
      setProgress(
        `${p.stage}${p.total ? " · " + Math.min(100, Math.round((p.downloaded / p.total) * 100)) + "%" : ""}`,
      ),
    );
  }, []);
  const scope = state.scope;
  const here =
    scope &&
    candidates.some(
      (c) => c.hostId === scope.hostId && c.roomId === scope.roomId,
    );
  const active = !["off", "error"].includes(state.status);
  const candidate = scope
    ? candidates.find(
        (c) =>
          c.participantId === scope.participantId &&
          c.hostId === scope.hostId &&
          c.roomId === scope.roomId,
      )
    : undefined;
  const showPanel =
    !collapsed && (picking || (here && active) || (here && state.status === "error"));
  useEffect(() => {
    if (["off", "error", "needs-attention"].includes(state.status))
      setCollapsed(false);
  }, [state.status]);
  const hidePanel = () => {
    setPicking(false);
    setCollapsed(true);
    button.current?.focus();
  };
  useLayoutEffect(() => {
    if (!showPanel) return;
    const place = () => {
      if (!button.current || !panel.current) return;
      const anchor = button.current.getBoundingClientRect();
      const box = panel.current.getBoundingClientRect();
      panel.current.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      panel.current.style.top = `${popoverTop(anchor, box.height, window.innerHeight)}px`;
    };
    place();
    const resize = new ResizeObserver(place);
    if (panel.current) resize.observe(panel.current);
    if (button.current) resize.observe(button.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [showPanel]);
  if (!window.apexDeck?.voice) return null;
  const start = () => {
    setCollapsed(false);
    if (candidates.length === 1) {
      const r = voiceRegistration(candidates[0]);
      r.save({ ...r.settings, enabled: true });
      void voiceController.start(candidates[0]);
    } else setPicking(!picking);
  };
  const choose = (c: VoiceCandidate) => {
    const r = voiceRegistration(c);
    r.save({ ...r.settings, enabled: true });
    setPicking(false);
    void (active ? voiceController.switchAgent(c) : voiceController.start(c));
  };
  const install = async () => {
    setInstalling(true);
    try {
      await window.apexDeck!.voice!.install();
      setProgress("Setup complete. Tap Start call.");
    } catch (e) {
      setProgress(String(e));
    } finally {
      setInstalling(false);
    }
  };
  const preference =
    scope && here
      ? preferenceFor(
          settings ?? voiceRegistration(scope).settings,
          scope.hostId,
          candidate?.profileId ?? scope.participantId,
          scope.roomId,
          scope.participantId,
        )
      : undefined;
  return (
    <div className="voice-call-controls">
      <button
        ref={button}
        type="button"
        className={`voice-mic${here && active ? " live" : ""}`}
        aria-label={here && active ? (showPanel ? "Hide voice call controls" : "Show voice call controls") : "Call an agent"}
        aria-expanded={!!showPanel}
        title={here && active ? (showPanel ? "Hide controls · call stays active" : "Show controls · call active") : "Call an agent"}
        disabled={disabled || !candidates.length}
        onClick={() => (here && active ? setCollapsed(!collapsed) : start())}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8" />
        </svg>
      </button>
      {showPanel && createPortal(
        <div
          ref={panel}
          className="voice-call-panel"
          role="region"
          aria-label="Agent voice call"
        >
          <div className="voice-call-heading">
            <strong>
              {candidate ? `Calling ${candidate.name}` : "Choose an agent"}
            </strong>
            <button type="button" onClick={hidePanel}>Hide call controls</button>
          </div>
          <span role="status">
            {state.error ??
              (state.status === "hearing"
                ? "Listening to you…"
                : state.status === "waiting"
                  ? "Agent working…"
                  : state.status === "speaking"
                    ? "Speaking · microphone open"
                    : state.status === "listening"
                      ? "Microphone open"
                      : state.status)}
          </span>
          {(picking || state.candidates) && (
            <div className="voice-recipients">
              {(state.candidates ?? candidates).map((c) => (
                <button
                  type="button"
                  key={JSON.stringify(c)}
                  onClick={() => choose(c)}
                >
                  {c.name} · {c.roomId}
                </button>
              ))}
            </div>
          )}
          {state.status === "setup" && (
            <>
              <p>
                Download local speech ({(download / 1e9).toFixed(2)} GB).
                Whisper listens and Kokoro speaks on this Mac; messages use your
                agent’s existing provider. Allow about{" "}
                {((download * 3) / 1e9).toFixed(1)} GB of free disk space.
              </p>
              <button
                type="button"
                onClick={() => void install()}
                disabled={installing}
              >
                Download local voice
              </button>
              {installing && (
                <button
                  type="button"
                  onClick={() => void window.apexDeck?.voice?.cancelInstall()}
                >
                  Cancel download
                </button>
              )}
              <span role="status">{progress}</span>
              {!installing &&
                progress.startsWith("Setup complete") &&
                scope && (
                  <button
                    type="button"
                    onClick={() => void voiceController.start(scope)}
                  >
                    Start call
                  </button>
                )}
            </>
          )}
          {here && active && state.status !== "setup" && (
            <>
              <button
                type="button"
                aria-pressed={state.muted}
                onClick={() => voiceController.mute(!state.muted)}
              >
                {state.muted ? "Unmute microphone" : "Mute microphone"}
              </button>
              <label>
                Agent voice{" "}
                <select
                  value={preference?.voice ?? "am_michael"}
                  disabled={!state.voices.length}
                  onChange={(e) => {
                    if (!scope) return;
                    const r = voiceRegistration(scope);
                    const key = voicePreferenceKey(
                      scope.hostId,
                      candidate?.profileId ?? scope.participantId,
                      scope.roomId,
                      scope.participantId,
                    );
                    r.save({
                      ...r.settings,
                      preferences: {
                        ...r.settings.preferences,
                        [key]: {
                          voice: e.target.value,
                          aliases: preference?.aliases ?? [],
                        },
                      },
                    });
                  }}
                >
                  {[
                    ...new Set([
                      preference?.voice ?? "am_michael",
                      ...state.voices,
                    ]),
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Spoken aliases{" "}
                <input
                  value={preference?.aliases.join(", ") ?? ""}
                  placeholder="e.g. Jiga, Jigga"
                  onChange={(e) => {
                    if (!scope) return;
                    const r = voiceRegistration(scope);
                    const key = voicePreferenceKey(
                      scope.hostId,
                      candidate?.profileId ?? scope.participantId,
                      scope.roomId,
                      scope.participantId,
                    );
                    r.save({
                      ...r.settings,
                      preferences: {
                        ...r.settings.preferences,
                        [key]: {
                          voice: preference?.voice ?? "am_michael",
                          aliases: e.target.value
                            .split(",")
                            .slice(0, 16)
                            .map((x) => x.trim().slice(0, 64)),
                        },
                      },
                    });
                  }}
                />
              </label>
              <button
                type="button"
                disabled={
                  !preference || !state.voices.includes(preference.voice)
                }
                onClick={() =>
                  preference && voiceController.preview(preference.voice)
                }
              >
                Preview voice
              </button>
              <span>
                Turn detection:{" "}
                {state.semantic ? "Smart Turn + silence" : "silence threshold"}
              </span>
              <label>
                Pause before reply{" "}
                <input
                  type="range"
                  min="300"
                  max="2000"
                  step="100"
                  value={
                    scope
                      ? (settings ?? voiceRegistration(scope).settings)
                          .silenceMs
                      : 700
                  }
                  onChange={(e) => {
                    if (scope) {
                      const r = voiceRegistration(scope);
                      r.save({
                        ...r.settings,
                        silenceMs: e.target.valueAsNumber,
                      });
                    }
                  }}
                />
                <span>
                  {scope
                    ? (settings ?? voiceRegistration(scope).settings).silenceMs
                    : 700}{" "}
                  ms · applies next call
                </span>
              </label>
            </>
          )}
          {here && (
            <button type="button" onClick={() => void voiceController.end()}>
              End call
            </button>
          )}
        </div>, document.body
      )}
    </div>
  );
}
