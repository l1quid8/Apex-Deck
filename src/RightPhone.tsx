import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, PointerEvent } from "react";
import type { PhoneApi } from "./backend";
import type { PhoneControl, PhoneDevice, PhoneGeometry, PhoneInput, PhoneStatus } from "./types";
import { POLL_MS, TYPE_FLUSH_MS, TYPE_MAX, clampToPicture, gesture, holderLine, keyAction, pasteText, toPicture } from "./phoneModel";

/** The latest picture of the phone's screen, ready for an <img>. */
interface Shown { src: string; width: number; height: number; geometry?: PhoneGeometry }
/** A message for the alert line. A good poll clears only the ones a poll caused. */
interface Problem { text: string; fromPoll: boolean }

const wordsOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The Phone tab: one simulated iPhone that the person and the bots share. Watch it, tap it, drag it, type on it. */
export function RightPhone({ phone, visible, initial }: { phone?: PhoneApi; visible: boolean; initial?: PhoneStatus }) {
  const [status, setStatus] = useState<PhoneStatus | null>(initial ?? null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [menu, setMenu] = useState<"controls" | "devices" | null>(null);
  const [devices, setDevices] = useState<PhoneDevice[]>([]);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [notice, setNotice] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const panel = useRef<HTMLDivElement | null>(null);
  const controlsButton = useRef<HTMLButtonElement | null>(null);
  const deviceButton = useRef<HTMLButtonElement | null>(null);
  const latest = useRef<PhoneStatus | null>(initial ?? null);
  const apiRef = useRef(phone);
  const seq = useRef(0);
  // A `view` call is waiting for its answer. Shared across polling runs, so hiding and showing the tab never adds a second.
  const asking = useRef(false);
  const press = useRef<{ x: number; y: number; at: number } | null>(null);
  const typed = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The person's inputs go one after another, so typed text always lands before the key that follows it.
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (apiRef.current === phone) return;
    apiRef.current = phone;
    latest.current = initial ?? null;
    seq.current = 0;
    setStatus(initial ?? null);
    setShown(null);
    setProblem(null);
    setDevices([]);
    queue.current = Promise.resolve();
    busy.current = false;
    setPending(false);
    press.current = null;
    typed.current = "";
    if (typeTimer.current !== null) clearTimeout(typeTimer.current);
    typeTimer.current = null;
  }, [phone, initial]);
  const acceptStatus = (next: PhoneStatus) => {
    const old = latest.current?.geometry;
    const current = next.geometry;
    if (old && current && (old.generation !== current.generation || old.display !== current.display || old.orientation !== current.orientation || old.width !== current.width || old.height !== current.height)) {
      press.current = null;
      if (typeTimer.current !== null) clearTimeout(typeTimer.current);
      typeTimer.current = null;
      typed.current = "";
    }
    latest.current = next;
    setStatus(next);
    if (!next.on || next.transitioning || next.width === 0 || next.height === 0) {
      setShown(null);
      press.current = null;
    }
    if (!next.on || next.transitioning) {
      seq.current = 0;
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
          if ((view.status.geometry?.generation ?? 0) < (latest.current?.geometry?.generation ?? 0)) return;
          acceptStatus(view.status);
          if (view.status.on && !view.status.transitioning && view.frame) {
            seq.current = view.frame.seq;
            setShown({ src: `data:image/jpeg;base64,${view.frame.image}`, width: view.frame.width, height: view.frame.height, geometry: view.status.geometry });
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

  useEffect(() => {
    if (!phone?.devices || !visible) return;
    let live = true;
    void phone.devices().then((list) => { if (live) setDevices(list); }, (cause) => { if (live) setProblem({ text: wordsOf(cause), fromPoll: false }); });
    return () => { live = false; };
  }, [phone, visible]);

  useEffect(() => {
    if (!menu) return;
    const close = () => { setMenu(null); (menu === "devices" ? deviceButton : controlsButton).current?.focus(); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const outside = (event: globalThis.PointerEvent) => { const target = event.target as Node;
      const active = panel.current?.querySelector(menu === "devices" ? ".phone-device-menu" : ".phone-controls-menu");
      if (!active?.contains(target) && !controlsButton.current?.contains(target) && !deviceButton.current?.contains(target)) setMenu(null); };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); };
  }, [menu]);

  if (!phone) return <p className="muted right-panel-empty">The phone needs the Deck app on a Mac.</p>;
  const api = phone;
  const input = (value: PhoneInput, geometry?: PhoneGeometry) => geometry ? api.input(value, geometry) : api.input(value);

  const act = (work: () => Promise<PhoneStatus>) => {
    queue.current = queue.current.then(() => apiRef.current === api ? work() : null).then(
      (next) => { if (next && apiRef.current === api) { acceptStatus(next); setProblem(null); } },
      (cause) => { if (apiRef.current === api) setProblem({ text: wordsOf(cause), fromPoll: false }); },
    );
  };
  const sendTyped = () => {
    if (typeTimer.current !== null) clearTimeout(typeTimer.current);
    typeTimer.current = null;
    const text = typed.current;
    typed.current = "";
    const geometry = shown?.geometry;
    if (text) act(() => input({ kind: "type", text }, geometry));
  };
  const afterTyping = (work: () => Promise<PhoneStatus>) => { sendTyped(); act(work); };
  // Where a pointer is on the phone's screen. With `toEdge`, a point off the picture counts as its nearest edge.
  const pointAt = (event: PointerEvent<HTMLImageElement>, toEdge: boolean) => {
    if (!shown) return null;
    const find = toEdge ? clampToPicture : toPicture;
    return find(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), shown.width, shown.height);
  };
  const forgetPress = () => { press.current = null; };
  const control = (command: PhoneControl) => {
    if (busy.current || latest.current?.transitioning) return;
    sendTyped();
    busy.current = true;
    setPending(true);
    press.current = null;
    setNotice("");
    queue.current = queue.current.then(async () => {
      if (apiRef.current !== api) return;
      try {
        const reply = await api.control(command);
        if (apiRef.current !== api) return;
        acceptStatus(reply.status);
        setNotice(reply.message);
        setProblem(null);
      } catch (cause) { if (apiRef.current === api) setProblem({ text: wordsOf(cause), fromPoll: false }); }
      finally { if (apiRef.current === api) { busy.current = false; setPending(false); } }
    });
  };
  const blocked = pending || Boolean(status?.transitioning) || Boolean(status?.starting);
  const inputBlocked = () => busy.current || latest.current?.transitioning || latest.current?.inputReady === false;
  const geometry = shown?.geometry;
  const currentGeometry = status?.geometry;
  const folded = currentGeometry?.display === 1;
  const orientation = status?.orientation ?? currentGeometry?.orientation ?? 1;
  const rotate = () => control({ kind: "rotate", orientation: ({ 1: 3, 3: 2, 2: 4, 4: 1 } as Record<number, number>)[orientation] ?? 1 });
  const icon = (name: string) => <PhoneIcon name={name} />;
  const tool = (label: string, name: string, work: () => void, extra = "") => <button type="button" className={`phone-tool ${extra}`} aria-label={label} title={label} disabled={blocked} onClick={work}>{icon(name)}<span className={extra ? "" : "phone-sr"}>{label}</span></button>;
  const row = (label: string, content: React.ReactNode) => <div className="phone-setting"><span>{label}</span>{content}</div>;
  const action = (label: string, command: PhoneControl) => <button type="button" className="phone-menu-action" disabled={blocked} onClick={() => control(command)}>{label}</button>;
  const applyLocation = () => {
    const a = Number(latitude), b = Number(longitude);
    if (!latitude.trim() || !longitude.trim() || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) { setProblem({ text: "Enter latitude from -90 to 90 and longitude from -180 to 180.", fromPoll: false }); return; }
    control({ kind: "location", latitude: a, longitude: b });
  };

  const words = problem?.text ?? (status?.transitioning ? null : status?.problem) ?? null;
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
  return <div className="right-phone phone-designed" ref={panel}>
    <div className="phone-device-head">
      <button type="button" ref={deviceButton} className="phone-device-trigger" aria-label="Choose simulator" aria-expanded={menu === "devices"} disabled={blocked} onClick={() => setMenu(menu === "devices" ? null : "devices")}>
        {icon("phone")}<span><strong>{status.model ?? status.device ?? "iPhone"}</strong><small>{status.runtime ? `iOS ${status.runtime}` : "Apple Simulator"}</small></span>{icon("chevron")}
      </button><i className="phone-connected" title="Running" />
    </div>
    <div className="phone-toolbar" role="toolbar" aria-label="Simulator controls">
      {tool("Home", "home", () => afterTyping(() => input({ kind: "button", button: "home" })))}
      {tool("Lock", "lock", () => afterTyping(() => input({ kind: "button", button: "lock" })))}
      <i className="phone-divider" />
      {(status.displays ?? 0) > 1 && tool(folded ? "Unfold" : "Fold", "fold", () => control({ kind: "fold", folded: !folded }), "phone-fold")}
      {tool("Rotate", "rotate", rotate)}
      <span className="phone-push" />
      {tool("Screenshot", "camera", () => control({ kind: "screenshot" }))}
      <button type="button" className="phone-tool phone-controls-trigger" ref={controlsButton} title="Controls" aria-label="Controls" aria-expanded={menu === "controls"} disabled={blocked} onClick={() => setMenu(menu === "controls" ? null : "controls")}>{icon("controls")}<span>Controls</span></button>
    </div>
    {menu === "devices" && <div className="phone-popover phone-device-menu" aria-label="Simulators">
      <h4>Choose simulator</h4><p className="muted">Each device keeps its apps and data.</p>
      {devices.length === 0 && <p className="muted">No installed simulators found.</p>}
      {devices.map((d) => <button type="button" className="phone-menu-action" key={`${d.runtime}/${d.deviceType}`} disabled={blocked} onClick={() => { setMenu(null); control({ kind: "selectDevice", runtime: d.runtime, deviceType: d.deviceType }); }}>{d.model}<small>iOS {d.version}</small></button>)}
    </div>}
    <div className="phone-popover phone-controls-menu" hidden={menu !== "controls"} aria-label="Phone controls">
      <h4>Display</h4>
      {row("Appearance", <div className="phone-segmented">{["light", "dark"].map((value) => <button type="button" key={value} disabled={blocked} aria-pressed={status.appearance === value} onClick={() => control({ kind: "appearance", value })}>{value === "light" ? "Light" : "Dark"}</button>)}</div>)}
      {row("Text size", <div className="phone-stepper"><button type="button" aria-label="Decrease text size" disabled={blocked} onClick={() => control({ kind: "textSize", value: "decrement" })}>−</button><button type="button" title="Reset text size" disabled={blocked} onClick={() => control({ kind: "textSize", value: "large" })}>{status.textSize ?? "Default"}</button><button type="button" aria-label="Increase text size" disabled={blocked} onClick={() => control({ kind: "textSize", value: "increment" })}>+</button></div>)}
      {row("Increase contrast", <button type="button" className="phone-toggle" aria-label="Increase contrast" aria-pressed={status.contrast === true} disabled={blocked} onClick={() => control({ kind: "contrast", enabled: !status.contrast })} />)}
      {row("Status bar", <div className="phone-segmented"><button type="button" disabled={blocked} onClick={() => control({ kind: "statusBar", clean: false })}>Live</button><button type="button" disabled={blocked} onClick={() => control({ kind: "statusBar", clean: true })}>9:41</button></div>)}
      <h4>Capture</h4>
      <div className="phone-capture-pair">{action("Screenshot", { kind: "screenshot" })}{action(status.recording ? "Stop recording" : "Record screen", { kind: "recording", active: !status.recording })}</div>
      <h4>Hardware</h4>
      {row("Orientation", <select aria-label="Orientation" value={orientation} disabled={blocked} onChange={(e) => control({ kind: "rotate", orientation: Number(e.target.value) })}><option value={1}>Portrait</option><option value={3}>Landscape left</option><option value={4}>Landscape right</option><option value={2}>Upside down</option></select>)}
      {row("Volume", <div className="phone-segmented"><button type="button" aria-label="Volume down" disabled={blocked} onClick={() => control({ kind: "volume", direction: "down" })}>−</button><button type="button" aria-label="Volume up" disabled={blocked} onClick={() => control({ kind: "volume", direction: "up" })}>+</button></div>)}
      {row("Face ID", <div className="phone-segmented"><button type="button" disabled={blocked} onClick={() => control({ kind: "biometric", matched: true })}>Match</button><button type="button" disabled={blocked} onClick={() => control({ kind: "biometric", matched: false })}>Fail</button></div>)}
      <h4>Location</h4>
      <div className="phone-location"><label>Latitude<input type="number" min={-90} max={90} step="any" placeholder="−90 to 90" value={latitude} onChange={(e) => setLatitude(e.target.value)} /></label><label>Longitude<input type="number" min={-180} max={180} step="any" placeholder="−180 to 180" value={longitude} onChange={(e) => setLongitude(e.target.value)} /></label></div>
      <div className="phone-location-actions"><button type="button" disabled={blocked} onClick={() => control({ kind: "location", latitude: null, longitude: null })}>Reset</button><button type="button" disabled={blocked} onClick={applyLocation}>Apply location</button></div>
      <hr /><button type="button" className="phone-menu-action phone-power" disabled={blocked} onClick={() => afterTyping(() => api.stop())}>Turn off</button>
    </div>
    {alert}
    {notice && <p role="status" className="phone-notice">{notice}</p>}
    <div className="phone-stage">
      {status.recording && <button type="button" className="phone-recording" disabled={blocked} onClick={() => control({ kind: "recording", active: false })}>● Stop recording</button>}
      {blocked && <div className="phone-changing" role="status">Updating simulator…</div>}
    {shown && <div className="right-phone-picture"><img className="right-phone-screen" src={shown.src} tabIndex={blocked || status.inputReady === false ? -1 : 0} aria-disabled={blocked || status.inputReady === false} draggable={false}
      style={{ width: `min(100cqw, calc(100cqh * ${shown.width / shown.height}))` }}
      alt="Phone screen. Click to tap, drag to swipe, type while it's selected."
      onPointerDown={(event) => {
        // Only the main button presses the screen.
        if (event.button !== 0 || inputBlocked()) return;
        event.currentTarget.focus();
        const at = pointAt(event, false);
        press.current = at && { x: at.x, y: at.y, at: Date.now() };
        // Keep the pointer until it is let go, so a release off the screen still arrives here.
        if (at) event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        // The time is read now, not when the input gets its turn behind an earlier one.
        if (inputBlocked()) { forgetPress(); return; }
        const at = Date.now();
        const start = press.current;
        press.current = null;
        const end = start && pointAt(event, true);
        if (start && end) afterTyping(() => input(gesture(start, { x: end.x, y: end.y, at }), geometry));
      }}
      onPointerCancel={forgetPress}
      onLostPointerCapture={forgetPress}
      onPaste={(event: ClipboardEvent<HTMLImageElement>) => {
        event.preventDefault();
        if (inputBlocked()) return;
        const { pieces, dropped } = pasteText(event.clipboardData.getData("text/plain"));
        sendTyped();
        for (const text of pieces) act(() => input({ kind: "type", text }, geometry));
        // Said after the typing, so its own success doesn't clear the note.
        const note = `Left out ${dropped} character${dropped === 1 ? "" : "s"} the phone can't type.`;
        if (dropped) queue.current = queue.current.then(() => setProblem({ text: note, fromPoll: false }));
      }}
      onKeyDown={(event: KeyboardEvent<HTMLImageElement>) => {
        if (inputBlocked()) { event.preventDefault(); return; }
        const action = keyAction(event);
        if (!action) return;
        event.preventDefault();
        if ("text" in action) {
          typed.current += action.text;
          if (typeTimer.current !== null) clearTimeout(typeTimer.current);
          if (typed.current.length >= TYPE_MAX) sendTyped();
          else typeTimer.current = setTimeout(sendTyped, TYPE_FLUSH_MS);
        } else {
          sendTyped();
          act(() => input({ kind: "key", key: action.key }, geometry));
        }
      }} /></div>}
    </div>
    <div className="phone-geometry">{blocked ? "Changing display…" : currentGeometry ? `Display ${currentGeometry.display} · ${status.pointWidth ?? "?"} × ${status.pointHeight ?? "?"} pt · ${status.pixelWidth ?? status.width} × ${status.pixelHeight ?? status.height} px` : `${status.width} × ${status.height} px`}</div>
    {status.lastCapture && <p className="phone-capture-path" title={status.lastCapture}>Saved: {status.lastCapture}</p>}
    <div className="phone-driver"><p role="status" className="right-phone-state">{holderLine(status)}</p>{status.holder.kind === "human" && <button type="button" onClick={() => afterTyping(() => api.giveBack())}>Give back</button>}</div>
    <details className="phone-help"><summary>Keyboard help</summary><p>Typing and pasting work while the screen is selected. Plain keyboard characters only.</p></details>
  </div>;
}


function PhoneIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    phone: <><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 5h4m-3 14h2" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    home: <circle cx="12" cy="12" r="7" />,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    fold: <path d="m3 5 9-2 9 2v14l-9 2-9-2ZM12 3v18M8 9l-3 3 3 3m8-6 3 3-3 3" />,
    rotate: <><path d="M4 8a9 9 0 0 1 15-3l2 2m0-5v5h-5" /><rect x="7" y="8" width="10" height="13" rx="2" /></>,
    camera: <><path d="M4 6h4l2-3h4l2 3h4a1 1 0 0 1 1 1v13H3V7a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="4" /></>,
    controls: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 3v6m8 0v6m-7 0v6" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
