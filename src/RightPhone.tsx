import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { PhoneApi } from "./backend";
import type { PhoneStatus } from "./types";
import { POLL_MS, TYPE_FLUSH_MS, gesture, holderLine, keyAction, toPicture } from "./phoneModel";

/** The latest picture of the phone's screen, ready for an <img>. */
interface Shown { src: string; width: number; height: number }
/** A message for the alert line. A good poll clears only the ones a poll caused. */
interface Problem { text: string; fromPoll: boolean }

const wordsOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The Phone tab: one simulated iPhone that the person and the bots share. Watch it, tap it, drag it, type on it. */
export function RightPhone({ phone, visible, initial }: { phone?: PhoneApi; visible: boolean; initial?: PhoneStatus }) {
  const [status, setStatus] = useState<PhoneStatus | null>(initial ?? null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const seq = useRef(0);
  // A `view` call is waiting for its answer. Shared across polling runs, so hiding and showing the tab never adds a second.
  const asking = useRef(false);
  const press = useRef<{ x: number; y: number; at: number } | null>(null);
  const typed = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The person's inputs go one after another, so typed text always lands before the key that follows it.
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!phone || !visible) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (asking.current) { timer = setTimeout(ask, POLL_MS); return; }
      asking.current = true;
      try {
        const view = await phone.view(seq.current);
        if (live) {
          setStatus(view.status);
          if (view.frame) {
            seq.current = view.frame.seq;
            setShown({ src: `data:image/jpeg;base64,${view.frame.image}`, width: view.frame.width, height: view.frame.height });
          }
          setProblem((current) => current?.fromPoll ? null : current);
        }
      } catch (cause) {
        if (live) setProblem({ text: wordsOf(cause), fromPoll: true });
      } finally {
        asking.current = false;
        if (live) timer = setTimeout(ask, POLL_MS);
      }
    };
    void ask();
    return () => { live = false; clearTimeout(timer); };
  }, [phone, visible]);

  // Hiding or closing the tab drops typing that has not been sent yet.
  useEffect(() => () => {
    if (typeTimer.current !== null) clearTimeout(typeTimer.current);
    typeTimer.current = null;
    typed.current = "";
  }, [phone, visible]);

  if (!phone) return <p className="muted right-panel-empty">The phone needs the Deck app on a Mac.</p>;
  const api = phone;

  const act = (work: () => Promise<PhoneStatus>) => {
    queue.current = queue.current.then(work).then(
      (next) => { setStatus(next); setProblem(null); },
      (cause) => setProblem({ text: wordsOf(cause), fromPoll: false }),
    );
  };
  const sendTyped = () => {
    if (typeTimer.current !== null) clearTimeout(typeTimer.current);
    typeTimer.current = null;
    const text = typed.current;
    typed.current = "";
    if (text) act(() => api.input({ kind: "type", text }));
  };
  const pointAt = (event: PointerEvent<HTMLImageElement>) => shown
    ? toPicture(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), shown.width, shown.height)
    : null;

  const words = problem?.text ?? status?.problem ?? null;
  const alert = words ? <p role="alert" className="right-phone-alert">{words}</p> : null;

  if (!status) return <div className="right-phone">{alert}</div>;
  if (!status.on && !status.starting) {
    return <div className="right-phone">
      <h3>Phone</h3>
      <p className="muted">One simulated iPhone that you and the bots share. The first start takes about a minute.</p>
      <div className="right-phone-actions"><button onClick={() => act(() => api.start())}>Turn on</button></div>
      {alert}
    </div>;
  }
  if (!status.on) {
    return <div className="right-phone">
      <h3>Phone</h3>
      <p role="status" className="right-phone-state">{holderLine(status)}</p>
      {alert}
    </div>;
  }
  return <div className="right-phone">
    <p role="status" className="right-phone-state">{holderLine(status)}</p>
    <div className="right-phone-actions">
      {status.holder.kind === "human" && <button onClick={() => act(() => api.giveBack())}>Give back</button>}
      <button onClick={() => act(() => api.input({ kind: "button", button: "home" }))}>Home</button>
      <button onClick={() => act(() => api.input({ kind: "button", button: "lock" }))}>Lock</button>
      <button onClick={() => act(() => api.stop())}>Turn off</button>
    </div>
    {alert}
    {shown && <img className="right-phone-screen" src={shown.src} tabIndex={0} draggable={false}
      alt="Phone screen. Click to tap, drag to swipe, type while it's selected."
      onPointerDown={(event) => {
        event.currentTarget.focus();
        const at = pointAt(event);
        press.current = at && { x: at.x, y: at.y, at: Date.now() };
      }}
      onPointerUp={(event) => {
        const start = press.current;
        press.current = null;
        const end = pointAt(event);
        if (start && end) act(() => api.input(gesture(start, { x: end.x, y: end.y, at: Date.now() })));
      }}
      onKeyDown={(event: KeyboardEvent<HTMLImageElement>) => {
        const action = keyAction(event);
        if (!action) return;
        event.preventDefault();
        if ("text" in action) {
          typed.current += action.text;
          if (typeTimer.current !== null) clearTimeout(typeTimer.current);
          typeTimer.current = setTimeout(sendTyped, TYPE_FLUSH_MS);
        } else {
          sendTyped();
          act(() => api.input({ kind: "key", key: action.key }));
        }
      }} />}
    <p className="right-phone-state">Typing works while the screen is selected. Plain keyboard characters only.</p>
  </div>;
}
