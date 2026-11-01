import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from "react";
import { sameServer } from "./previewAddress";
import { normalise } from "./RightBrowser";
import { browserCaller, buttonName, chosenTab, dialogChoices, finishClipboard, holderName, inputQueue, keyAction, modifierBits, pagePoint, tabForAddress, tabName, type BrowserTab, type PageEvent } from "./browserTabs";
import "./shared-browser.css";

const MAC = navigator.platform.toLowerCase().includes("mac");
/** The tab last shown on each machine, for coming back to it. */
const lastTab = new Map<string, string>();
const PROBLEMS: Record<string, string> = {
  tab_held_by_bot: "A bot has this tab. Take over to use it.",
  browser_selection_unavailable: "That selection couldn't be read, so nothing was copied or cut.",
};
type Frame = { seq: number; image?: string; width?: number; height?: number; tab?: BrowserTab };

export interface SharedBrowserProps {
  call: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  hostName: string;
  /** The machine's lasting identity, when its name might not be unique. Remount for a different one. */
  hostId?: string;
  visible: boolean;
  /** The thread in front, which tabs can be handed to. */
  thread?: { id: string; title: string } | null;
  roomName: (id: string) => string | undefined;
  assistantName: string;
  /** Start on the assistant's tab. */
  assistantFirst?: boolean;
  /** An address to show, once. `anyPage` is for a server that just started: any page of it will do. */
  open?: { url: string; anyPage?: boolean } | null;
  onOpened?: () => void;
  onStopAll?: () => void;
}

/** One browser for the person, the assistant and bots: every view here is a live tab on `hostName`. */
export function SharedBrowser({ call, hostName, hostId = hostName, visible, thread, roomName, assistantName, assistantFirst = false, open, onOpened, onStopAll }: SharedBrowserProps) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [wanted, pick] = useState<string | null>(() => lastTab.get(hostId) ?? null);
  const setWanted = useCallback((id: string) => { lastTab.set(hostId, id); pick(id); }, [hostId]);
  const [image, setImage] = useState<{ tab: string; src: string; width: number; height: number } | null>(null);
  const [address, setAddress] = useState("");
  const [reply, setReply] = useState("");
  const [problem, setProblem] = useState("");
  const editing = useRef(false);
  const area = useRef<HTMLDivElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const addressBox = useRef<HTMLInputElement>(null);
  const live = useRef({ call }); live.current = { call: browserCaller(hostId, call) };
  const current = chosenTab(tabs, wanted, assistantFirst);
  const tab = tabs.find((item) => item.id === current) ?? null;
  const currentRef = useRef(current); currentRef.current = current;
  const human = tab?.control.kind === "human";
  const held = tab?.control.kind === "bot" || tab?.control.kind === "assistant";
  const anyBot = tabs.some((item) => item.control.kind === "bot");

  const fail = useCallback((cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)), []);
  const refresh = useCallback(async () => {
    const reply = await live.current.call<{ tabs: BrowserTab[] }>("browser_tabs");
    setTabs(reply.tabs); setProblem("");
    return reply.tabs;
  }, []);

  useEffect(() => {
    if (!visible) return;
    let done = false;
    const tick = () => { if (!done) refresh().catch(fail); };
    tick();
    const timer = setInterval(tick, 1500);
    return () => { done = true; clearInterval(timer); };
  }, [visible, call, refresh, fail]);

  useEffect(() => {
    if (!open) return;
    onOpened?.();
    void (async () => {
      const found = tabForAddress(await refresh(), open.url, sameServer, !!open.anyPage);
      if (found) { setWanted(found.id); return; }
      const made = await live.current.call<BrowserTab>("browser_tab_open", { url: open.url });
      setWanted(made.id);
      await refresh();
    })().catch(fail);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The picture: asks for the next frame as soon as the last one arrived.
  useEffect(() => {
    if (!visible || !current) return;
    let done = false, after = 0;
    void (async () => {
      while (!done) {
        try {
          const frame = await live.current.call<Frame>("browser_tab_frame", { tab: current, after });
          if (done) return;
          if (frame.image) { after = frame.seq; setImage({ tab: current, src: `data:image/jpeg;base64,${frame.image}`, width: frame.width ?? 1280, height: frame.height ?? 800 }); }
          const summary = frame.tab;
          if (summary) setTabs((list) => list.map((item) => item.id === summary.id ? summary : item));
        } catch (cause) {
          if (!done) fail(cause);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    })();
    return () => { done = true; };
  }, [visible, current, call, fail]);

  useEffect(() => { setReply(tab?.dialog?.defaultPrompt ?? ""); }, [current, tab?.dialog?.type, tab?.dialog?.message, tab?.dialog?.defaultPrompt]);
  useEffect(() => { if (!editing.current) setAddress(tab?.url && tab.url !== "about:blank" ? tab.url : ""); }, [tab?.url, current]);

  // Fit a free or person-held tab to the view; a bot's coordinates stay put while it works.
  useEffect(() => {
    const el = area.current;
    if (!el || !visible || !current || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const box = el.getBoundingClientRect();
        if (box.width < 50 || box.height < 50) return;
        live.current.call("browser_tab_resize", { tab: current, width: Math.round(box.width), height: Math.round(box.height), scale: Math.min(2, window.devicePixelRatio || 1) }).catch(() => {});
      }, 200);
    };
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    fit();
    return () => { clearTimeout(timer); watch.disconnect(); };
  }, [visible, current, human, call]);

  const input = useRef<ReturnType<typeof inputQueue<BrowserTab & { copied?: string; cut?: string }>> | null>(null);
  input.current ??= inputQueue(async (deliver, events) => {
    const answer = await finishClipboard(await deliver(events), deliver, navigator.clipboard && ((text) => navigator.clipboard.writeText(text)));
    setTabs((list) => list.map((item) => item.id === answer.id ? answer : item));
  }, () => setProblem(""), fail);
  const send = useCallback((...events: PageEvent[]) => {
    const id = currentRef.current, browser = live.current.call;
    if (id) input.current?.add(`${hostId}\0${id}`, (batch) => browser("browser_tab_input", { tab: id, events: batch }), ...events);
  }, [hostId]);

  const point = (event: { clientX: number; clientY: number }) => {
    const box = area.current?.getBoundingClientRect();
    return box && image ? pagePoint(event.clientX, event.clientY, box, image.width, image.height) : null;
  };
  const mouse = (action: "down" | "up" | "move") => (event: ReactMouseEvent) => {
    if (held) return;
    if (action === "move" && !human) return;
    const at = point(event);
    if (!at) return;
    if (action === "down") keys.current?.focus({ preventScroll: true });
    send({ kind: "mouse", action, ...at, button: action === "move" ? "none" : buttonName(event.button), buttons: event.buttons, clicks: action === "move" ? 0 : event.detail || 1, modifiers: modifierBits(event) });
  };
  const wheel = (event: ReactWheelEvent) => {
    if (held) return;
    const at = point(event);
    if (at) send({ kind: "wheel", ...at, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY), modifiers: modifierBits(event) });
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (held || event.nativeEvent.isComposing) return;
    const action = keyAction(event, MAC);
    if (action.type === "deck" || action.type === "paste") return;
    event.preventDefault();
    if (action.type === "address") { addressBox.current?.focus(); addressBox.current?.select(); return; }
    send(...action.events);
  };
  const keyUp = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (held || event.nativeEvent.isComposing || event.metaKey) return;
    send({ kind: "key", action: "up", key: event.key, code: event.code, vk: event.keyCode, text: "", modifiers: modifierBits(event), commands: [] });
  };

  const act = (work: Promise<unknown>) => { work.then(() => refresh()).catch(fail); };
  const go = (value: string) => {
    const url = normalise(value);
    if (!url) return;
    editing.current = false;
    keys.current?.focus({ preventScroll: true });
    send({ kind: "navigate", url });
  };
  const upload = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
    act(live.current.call("browser_tab_upload", { tab: current, name: file.name, data: btoa(binary) }));
  };
  const name = (item: BrowserTab) => holderName(item, roomName, assistantName);
  const question = tab?.dialogOpen ? tab.dialog : null;
  const choices = dialogChoices(question);
  let asker = "";
  try { asker = new URL(question?.url ?? "").host; } catch { /* A blank page has no name to give. */ }
  const shared = !!thread && !!tab?.rooms.includes(thread.id);

  return <div className="shared-browser">
    <div className="shared-browser-tabs" role="tablist" aria-label={`Browser tabs on ${hostName}`}>
      {tabs.map((item) => <div key={item.id} className={`shared-browser-tab${item.id === current ? " active" : ""}`}>
        <button role="tab" aria-selected={item.id === current} title={item.url} onClick={() => setWanted(item.id)}>
          <span className="shared-browser-tab-name">{tabName(item)}</span>
          {name(item) && <span className={`shared-browser-owner is-${item.control.kind}`}>{name(item)}</span>}
        </button>
        {!item.assistant && <button className="shared-browser-tab-close" aria-label={`Close ${tabName(item)}`} onClick={() => act(live.current.call("browser_tab_close", { tab: item.id }))}>×</button>}
      </div>)}
      <button className="shared-browser-new" aria-label="New tab" title="New tab" onClick={() => live.current.call<BrowserTab>("browser_tab_open").then((made) => { setWanted(made.id); return refresh(); }).catch(fail)}>+</button>
      <span className="shared-browser-machine" title={`Pages run on ${hostName}, and localhost means that machine.`}>{hostName}</span>
    </div>
    <form className="shared-browser-bar" onSubmit={(event) => { event.preventDefault(); go(address); }}>
      <button type="button" className="icon small" disabled={!tab || held} aria-label="Back" onClick={() => send({ kind: "back" })}>‹</button>
      <button type="button" className="icon small" disabled={!tab || held} aria-label="Forward" onClick={() => send({ kind: "forward" })}>›</button>
      <button type="button" className="icon small" disabled={!tab || held} aria-label="Reload" onClick={() => send({ kind: "reload" })}>↻</button>
      <input ref={addressBox} aria-label="Address" placeholder="Search or type an address" value={address} disabled={!tab || held} onFocus={() => { editing.current = true; }} onBlur={() => { editing.current = false; }} onChange={(event) => setAddress(event.target.value)} />
    </form>
    {tab && <div className="shared-browser-control">
      <span>{held ? `${name(tab)} has this tab` : human ? "You have this tab" : "Nobody has this tab"}</span>
      {held && <button type="button" className="primary" onClick={() => act(live.current.call("browser_tab_control", { tab: tab.id, take: true }))}>Take over</button>}
      {tab.control.kind === "bot" && <button type="button" onClick={() => act(live.current.call("browser_tab_stop", { tab: tab.id }))}>Stop this bot</button>}
      {human && (tab.rooms.length > 0 || tab.assistant) && <button type="button" onClick={() => act(live.current.call("browser_tab_control", { tab: tab.id, take: false }))}>Hand back</button>}
      {thread && !tab.assistant && <button type="button" title={shared ? `Bots in ${thread.title} can no longer reach this tab` : `Bots in ${thread.title} can use this tab. It doesn't hand them your control.`} onClick={() => act(live.current.call("browser_tab_share", { tab: tab.id, thread: thread.id, share: !shared }))}>{shared ? "Remove from this thread" : "Share with this thread"}</button>}
      {anyBot && onStopAll && <button type="button" className="shared-browser-stop" onClick={onStopAll}>Stop all</button>}
    </div>}
    {problem && <p role="alert" className="shared-browser-problem">{PROBLEMS[problem] ?? problem}</p>}
    {tab?.dialogOpen && <div className="shared-browser-dialog" role="alertdialog" aria-label="Page dialog">
      {question && <p className="shared-browser-question"><strong>{asker || "This page"} says</strong>{question.message}</p>}
      {!question && <span>This page is showing a dialog.</span>}
      {!human && <span>Take over to answer it. Bots leave it alone.</span>}
      {human && <>{choices.answer && <input aria-label="Dialog answer" value={reply} onChange={(event) => setReply(event.target.value)} />}<button type="button" className="primary" onClick={() => send({ kind: "dialog", accept: true, ...(choices.answer ? { text: reply } : {}) })}>{choices.ok}</button>{choices.cancel && <button type="button" onClick={() => send({ kind: "dialog", accept: false })}>{choices.cancel}</button>}</>}
    </div>}
    {tab?.fileChooser && human && <label className="shared-browser-dialog">This page is asking for a file (6 MB at most). <input type="file" aria-label="File for the page" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} /></label>}
    <div ref={area} className={`shared-browser-page${held ? " is-held" : ""}`} onMouseDown={mouse("down")} onMouseUp={mouse("up")} onMouseMove={mouse("move")} onWheel={wheel} onContextMenu={(event) => event.preventDefault()}>
      {image?.tab === current ? <img src={image.src} alt={tab ? tabName(tab) : "Page"} draggable={false} /> : <p className="muted">{tabs.length ? "Loading the page…" : "No tabs yet. Press + to open one."}</p>}
      <textarea ref={keys} className="shared-browser-keys" aria-label="Keyboard for the page" autoCapitalize="off" autoCorrect="off" spellCheck={false} value="" readOnly={held}
        onChange={() => {}} onKeyDown={keyDown} onKeyUp={keyUp}
        onPaste={(event) => { event.preventDefault(); const text = event.clipboardData.getData("text/plain"); if (text && !held) send({ kind: "text", text }); }}
        onCompositionEnd={(event) => { if (event.data && !held) send({ kind: "text", text: event.data }); }} />
    </div>
  </div>;
}
