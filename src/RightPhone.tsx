import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type { PhoneApi } from "./backend";
import type { PhoneStatus } from "./types";
import { POLL_MS, TYPE_FLUSH_MS, clampToPicture, gesture, holderLine, keyAction, toPicture } from "./phoneModel";

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
  const acceptStatus = (next: PhoneStatus) => {
    setStatus(next);
    if (!next.on) {
      seq.current = 0;
      setShown(null);
      press.current = null;
      if (typeTimer.current !== null) clearTimeout(typeTimer.current);
      typeTimer.current = null;
      typed.current = "";
    }
  };

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
          acceptStatus(view.status);
          if (view.status.on && view.frame) {
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

  // Hiding or closing the tab drops typing that has not been sent yet, and any press that was still going.
  useEffect(() => () => {
    if (typeTimer.current !== null) clearTimeout(typeTimer.current);
    typeTimer.current = null;
    typed.current = "";
    press.current = null;
  }, [phone, visible]);

  if (!phone) return <p className="muted right-panel-empty">The phone needs the Deck app on a Mac.</p>;
  const api = phone;

  const act = (work: () => Promise<PhoneStatus>) => {
    queue.current = queue.current.then(work).then(
      (next) => { acceptStatus(next); setProblem(null); },
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
  const afterTyping = (work: () => Promise<PhoneStatus>) => { sendTyped(); act(work); };
  // Where a pointer is on the phone's screen. With `toEdge`, a point off the picture counts as its nearest edge.
  const pointAt = (event: PointerEvent<HTMLImageElement>, toEdge: boolean) => {
    if (!shown) return null;
    const find = toEdge ? clampToPicture : toPicture;
    return find(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), shown.width, shown.height);
  };
  const forgetPress = () => { press.current = null; };

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
      {status.holder.kind === "human" && <button onClick={() => afterTyping(() => api.giveBack())}>Give back</button>}
      <button onClick={() => afterTyping(() => api.input({ kind: "button", button: "home" }))}>Home</button>
      <button onClick={() => afterTyping(() => api.input({ kind: "button", button: "lock" }))}>Lock</button>
      <button onClick={() => afterTyping(() => api.stop())}>Turn off</button>
    </div>
    {alert}
    {shown && <div className="right-phone-picture"><img className="right-phone-screen" src={shown.src} tabIndex={0} draggable={false}
      style={{ width: `min(100cqw, calc(100cqh * ${shown.width / shown.height}))` }}
      alt="Phone screen. Click to tap, drag to swipe, type while it's selected."
      onPointerDown={(event) => {
        // Only the main button presses the screen.
        if (event.button !== 0) return;
        event.currentTarget.focus();
        const at = pointAt(event, false);
        press.current = at && { x: at.x, y: at.y, at: Date.now() };
        // Keep the pointer until it is let go, so a release off the screen still arrives here.
        if (at) event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        // The time is read now, not when the input gets its turn behind an earlier one.
        const at = Date.now();
        const start = press.current;
        press.current = null;
        const end = start && pointAt(event, true);
        if (start && end) afterTyping(() => api.input(gesture(start, { x: end.x, y: end.y, at })));
      }}
      onPointerCancel={forgetPress}
      onLostPointerCapture={forgetPress}
      onKeyDown={(event: KeyboardEvent<HTMLImageElement>) => {
        const action = keyAction(event);
        if (!action) return;
        event.preventDefault();
        if ("text" in action) {
          typed.current += action.text;
          if (typeTimer.current !== null) clearTimeout(typeTimer.current);
          if (typed.current.length >= 500) sendTyped();
          else typeTimer.current = setTimeout(sendTyped, TYPE_FLUSH_MS);
        } else {
          sendTyped();
          act(() => api.input({ kind: "key", key: action.key }));
        }
      }} /></div>}
    <p className="right-phone-state">Typing works while the screen is selected. Plain keyboard characters only.</p>
  </div>;
}
