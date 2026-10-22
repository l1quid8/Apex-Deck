import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { PtySummary } from "../backend";
import type { PhoneHost } from "../phoneBackend";
import { canSeeNewThread } from "../phoneRules";
import { nextTitle } from "../terminalTitle";
import { writeClipboard } from "../threadCopy";
import { age, appendTail, askLine, arrowCode, controlCode, dotState, fromPhone, groupForSheet, isYesNo, lastLine, nextDotChange, questionText, readTerminalCache, stripAnsi, stripOrder, swipeIntent, writeTerminalCache, type PhoneTerminal as PhoneTerminalInfo } from "./phoneTerminals";
import { copyLastOutput, endTerminal, renameTerminal, resizePhoneTerminal } from "./terminalActions";
import { Check, ChevronDown, Plus, X } from "./icons";

type View = { kind: "home" } | { kind: "terminal"; machineId: string; id: string };
type HostInfo = { host: PhoneHost; name: string; id: string; online: boolean; access: boolean };
type Props = {
  host: PhoneHost | null; hosts: PhoneHost[]; name: string; cwd: string | null; openSwitcher?: boolean; resumeSignal?: number; onSwitcherOpened?: () => void; onWaitingChange?: (waiting: boolean) => void; hidden?: boolean; canWriteClipboard?: (text: string) => Promise<boolean>;
  /** Bumped by the header's ‹ Code button: back to the terminal list. */
  homeSignal?: number;
  /** Whether a terminal is open, so the header can show ‹ Code instead of the Code title. */
  onViewingChange?: (viewing: boolean) => void;
};
const closedKey = (id: string) => `apex-deck.phone.closed-terminals.${id}`;
const dotText: Record<string, string> = { ask: "Needs an answer", run: "Running", idle: "Idle", fail: "Failed", ended: "Finished" };
/** The Code home lists this many of the machine's terminals; See all has the rest. */
const HOME_ROWS = 8;
/** age() says "now" for under a minute, which takes no "ago". */
const ago = (when: string) => when === "now" ? "just now" : `${when} ago`;

export function PhoneTerminal({ host, hosts, name, cwd, openSwitcher, resumeSignal, onSwitcherOpened, onWaitingChange, hidden, canWriteClipboard, homeSignal, onViewingChange }: Props) {
  const [summaries, setSummariesState] = useState<Record<string, PhoneTerminalInfo[]>>(() => readTerminalCache());
  const setSummaries = (update: SetStateAction<Record<string, PhoneTerminalInfo[]>>) => setSummariesState((current) => {
    const next = typeof update === "function" ? update(current) : update;
    writeTerminalCache(next);
    return next;
  });
  const [hostState, setHostState] = useState<Record<string, string>>({});
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>({ kind: "home" });
  const [lastTerminal, setLastTerminal] = useState<View | null>(null);
  const [sheet, setSheet] = useState<"list" | "menu" | null>(null);
  const [target, setTarget] = useState<PhoneTerminalInfo | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PhoneTerminalInfo[] | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [notice, setNotice] = useState("");
  const [input, setInput] = useState("");
  const [ctrl, setCtrl] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [, setClock] = useState(0);
  const termRoot = useRef<HTMLDivElement>(null);
  const sheetDialog = useRef<HTMLDivElement>(null);
  const [sheetPortal, setSheetPortal] = useState<HTMLElement | null>(null);
  const xtermHost = useRef<HTMLDivElement>(null);
  const selectedStrip = useRef<HTMLButtonElement>(null);
  const xterm = useRef<XTerminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const cursor = useRef(0);
  const buffered = useRef<{ cursor: number; data: string }[]>([]);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<{ x: number; y: number; active: boolean; id: number } | null>(null);
  const holdFired = useRef(false);
  const discoveryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const infos: HostInfo[] = hosts.map((item) => ({ host: item, id: item.machine.id, name: item.machine.name, online: item.connection.get().status.kind === "connected", access: canSeeNewThread(item.access()) }));
  const eligible = infos.filter((item) => item.online && item.access);
  const hostSignature = infos.map((item) => `${item.id}:${item.online}:${item.access}`).join("|");
  const all = Object.values(summaries).flat();
  const visible = all.filter((item) => !readClosed(item.machineId).has(item.id));
  const machine = infos.find((item) => item.id === (view.kind === "terminal" ? view.machineId : host?.machine.id)) ?? null;
  const terminalHostIssue = (info: HostInfo) => {
    const status = info.host.connection.get().status;
    if (status.kind === "reconnecting" || status.kind === "failed") return status.reason;
    if (status.kind === "connecting") return `Connecting to ${info.name}…`;
    if (status.kind === "resync") return "The connection is resynchronizing.";
    return hostErrors[info.id] || `${info.name} is offline`;
  };
  const folder = cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const project = view.kind === "terminal" ? (visible.find((item) => item.machineId === view.machineId && item.id === view.id)?.project ?? folder ?? name) : folder ?? name;
  /** This machine's terminals, for the Code home. */
  const here = visible.filter((item) => item.machineId === machine?.id);
  const listed = (at: View | null) => at?.kind === "terminal" && here.slice(0, HOME_ROWS).some((item) => item.id === at.id && item.machineId === at.machineId);
  /** Resume offers the last terminal while it's open and not already a row on the home. */
  const resumable = lastTerminal?.kind === "terminal" && visible.some((item) => item.id === lastTerminal.id && item.machineId === lastTerminal.machineId) && !listed(lastTerminal);
  const terminal = view.kind === "terminal" ? visible.find((item) => item.machineId === view.machineId && item.id === view.id) ?? null : null;
  const strip = terminal ? stripOrder(visible, terminal.machineId, terminal.project) : [];
  const groups = useMemo(() => groupForSheet(infos, visible, { machineId: machine?.id ?? "", project }), [summaries, hostState, view, machine?.id, project]);

  useEffect(() => { if (openSwitcher) { setQuery(""); setSheet("list"); onSwitcherOpened?.(); } }, [openSwitcher]);
  useEffect(() => { setSheetPortal(termRoot.current?.closest(".phone-frame") ?? null); }, []);
  useEffect(() => { sheetDialog.current?.focus(); }, [sheet, sheetPortal]);
  useEffect(() => { if (resumeSignal && view.kind === "home" && lastTerminal) setView(lastTerminal); }, [resumeSignal]);
  useEffect(() => { if (homeSignal) setView({ kind: "home" }); }, [homeSignal]);
  useEffect(() => { onViewingChange?.(view.kind === "terminal"); }, [view.kind]);
  useEffect(() => () => onViewingChange?.(false), []);
  const waiting = visible.some((item) => dotState(item) === "ask");
  useEffect(() => { onWaitingChange?.(waiting); }, [waiting]);
  // A terminal that goes quiet sends nothing to redraw its dot, so redraw when the next dot is due to change.
  const dotDue = nextDotChange(visible);
  useEffect(() => {
    if (dotDue === null) return;
    const timer = setTimeout(() => setClock((n) => n + 1), Math.max(0, dotDue - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [dotDue]);
  useEffect(() => { selectedStrip.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }, [terminal?.id]);

  function readClosed(machineId: string): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem(closedKey(machineId)) ?? "[]") as string[]); } catch { return new Set(); }
  }
  function closeLocally(item: PhoneTerminalInfo) {
    const closed = readClosed(item.machineId); closed.add(item.id);
    try { localStorage.setItem(closedKey(item.machineId), JSON.stringify([...closed])); } catch { /* memory still hides until navigation */ }
    setSummaries((allItems) => ({ ...allItems, [item.machineId]: (allItems[item.machineId] ?? []).filter((entry) => entry.id !== item.id) }));
  }
  const open = (item: PhoneTerminalInfo) => { const next: View = { kind: "terminal", machineId: item.machineId, id: item.id }; setView(next); setLastTerminal(next); setSheet(null); setTarget(null); setInput(""); };
  const closeTerminal = (item: PhoneTerminalInfo) => {
    const index = strip.findIndex((entry) => entry.id === item.id);
    const neighbor = strip[index + 1] ?? strip[index - 1];
    closeLocally(item);
    if (neighbor) open(neighbor); else setView({ kind: "home" });
  };
  const refreshHost = async (info: HostInfo, search?: string) => {
    if (!info.online) { setHostState((s) => ({ ...s, [info.id]: "offline" })); return; }
    if (!info.access) { setHostState((s) => ({ ...s, [info.id]: "needs-full" })); return; }
    try {
      const items = await info.host.backend.ptyList(search);
      const prior = new Map((readTerminalCache()[info.id] ?? []).map((item) => [item.id, item]));
      // A Mac from before terminal names sends no recent output. Output since an answer is
      // only kept when none was missed; otherwise the whole tail is checked for a question.
      const enriched = items.map((item: PtySummary) => { const before = prior.get(item.id); return { ...item, tail: item.tail ?? "", machineId: info.id, machineName: info.name, firstSeen: before?.firstSeen ?? Date.now(), answerTail: before?.cursor === item.cursor ? before.answerTail : undefined }; });
      if (search) setSearchResults((current) => [...(current ?? []).filter((item) => item.machineId !== info.id), ...enriched]);
      else setSummaries((current) => ({ ...current, [info.id]: enriched }));
      for (const item of items) { const key = `${info.id}:${item.id}`; const pending = discoveryTimers.current.get(key); if (pending) clearTimeout(pending); discoveryTimers.current.delete(key); }
      setHostState((s) => ({ ...s, [info.id]: "ready" }));
      setHostErrors((s) => ({ ...s, [info.id]: "" }));
    } catch (error) {
      const detail = String(error);
      const message = detail.toLowerCase();
      setHostErrors((s) => ({ ...s, [info.id]: detail }));
      setHostState((s) => ({ ...s, [info.id]: message.includes("unknown command") ? "old" : message.includes("limited to some threads") ? "needs-all-threads" : message.includes("access") || message.includes("permission") ? "needs-full" : "error" }));
    }
  };

  useEffect(() => {
    let live = true;
    const offs: (() => void)[] = [];
    for (const info of infos) {
      void refreshHost(info);
      if (!info.access || !info.online) continue;
      info.host.backend.onPtyData((id, data, eventCursor) => {
        if (!live) return;
        if (!(readTerminalCache()[info.id] ?? []).some((item) => item.id === id)) { const key = `${info.id}:${id}`; const old = discoveryTimers.current.get(key); if (old) clearTimeout(old); discoveryTimers.current.set(key, setTimeout(() => void refreshHost(info), 300)); return; }
        setSummaries((current) => {
          const items = current[info.id] ?? [];
          const existing = items.find((item) => item.id === id);
          if (!existing) return current;
          if (eventCursor <= existing.cursor) return current;
          return { ...current, [info.id]: items.map((item) => item.id === id ? { ...item, tail: appendTail(item.tail, data), answerTail: item.answerTail === undefined ? undefined : appendTail(item.answerTail, data), cursor: eventCursor, lastActivity: Date.now() } : item) };
        });
      }).then((off) => { if (live) offs.push(off); else off(); }).catch(() => {});
      info.host.backend.onPtyExit((id, code) => { if (!live) return; setSummaries((current) => ({ ...current, [info.id]: (current[info.id] ?? []).map((item) => item.id === id ? { ...item, state: "exited", exitCode: code, lastActivity: Date.now() } : item) })); }).then((off) => { if (live) offs.push(off); else off(); }).catch(() => {});
      info.host.backend.onPtyRenamed((id, newName) => { if (!live) return; setSummaries((current) => ({ ...current, [info.id]: (current[info.id] ?? []).map((item) => item.id === id ? { ...item, name: newName } : item) })); }).then((off) => { if (live) offs.push(off); else off(); }).catch(() => {});
    }
    const foreground = () => { if (document.visibilityState === "visible") eligible.forEach((info) => void refreshHost(info)); };
    document.addEventListener("visibilitychange", foreground);
    return () => { live = false; offs.forEach((off) => off()); document.removeEventListener("visibilitychange", foreground); };
  }, [hosts, hostSignature]);

  useEffect(() => {
    if (view.kind !== "terminal" || !terminal || !machine?.access || !machine.online || !xtermHost.current) return;
    let term = xterm.current;
    let fitAddon = fit.current;
    if (!term || !fitAddon) {
      const phoneColors = getComputedStyle(xtermHost.current);
      term = new XTerminal({ fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: 12, scrollback: 5000, disableStdin: true, cursorBlink: true, theme: { background: phoneColors.getPropertyValue("--panel-2").trim() || "#111318", foreground: phoneColors.getPropertyValue("--text").trim() || "#d9e0e8", cursor: phoneColors.getPropertyValue("--mint").trim() || "#51d7c5" } });
      fitAddon = new FitAddon(); term.loadAddon(fitAddon); term.open(xtermHost.current); term.write("\x1b[?25l");
      xterm.current = term; fit.current = fitAddon;
    }
    let live = true; let ready = false; buffered.current = [];
    // Every terminal fits the box; only a shell this phone started is resized to match. A Mac pane keeps its own size.
    const fitBox = () => { fitAddon.fit(); void resizePhoneTerminal(machine.host.backend, terminal.id, term.cols, term.rows).catch(() => {}); };
    const offPromise = machine.host.backend.onPtyData((id, data, eventCursor) => {
      if (!live || id !== terminal.id) return;
      if (!ready) buffered.current.push({ cursor: eventCursor, data });
      else if (eventCursor > cursor.current) { cursor.current = eventCursor; term.write(data); }
    });
    const attach = async () => {
      const off = await offPromise;
      try {
        const snapshot = await machine.host.backend.ptyAttach(terminal.id);
        if (!live) { off(); return; }
        term.reset(); fitBox(); term.write(snapshot.output);
        for (const event of buffered.current) if (event.cursor > snapshot.cursor) term.write(event.data);
        cursor.current = Math.max(snapshot.cursor, ...buffered.current.map((event) => event.cursor), 0);
        buffered.current = []; ready = true;
      } catch (error) { if (live) setNotice(String(error)); }
      if (!live) off();
      return off;
    };
    let off: (() => void) | undefined;
    void attach().then((fn) => { off = fn; });
    const observer = new ResizeObserver(fitBox);
    observer.observe(xtermHost.current);
    return () => { live = false; off?.(); observer.disconnect(); };
  }, [view.kind, view.kind === "terminal" ? view.machineId : "", view.kind === "terminal" ? view.id : "", !!terminal, machine?.online]);

  useEffect(() => {
    if (view.kind === "terminal") return;
    xterm.current?.dispose(); xterm.current = null; fit.current = null;
  }, [view.kind]);

  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); eligible.forEach((info) => void refreshHost(info)); return; }
    const timer = setTimeout(() => { setSearchResults([]); eligible.forEach((info) => void refreshHost(info, query.trim().slice(0, 100))); }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const newShell = async (info: HostInfo, baseTerminal?: PhoneTerminalInfo, nameOverride?: string) => {
    const path = baseTerminal?.cwd ?? (info.id === machine?.id ? cwd : null) ?? undefined;
    const taken = (summaries[info.id] ?? []).filter((item) => item.project === (baseTerminal?.project ?? project)).map((item) => item.name);
    const shellName = nameOverride ?? nextTitle("shell", taken);
    const id = `phone-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try { await info.host.backend.ptySpawn({ id, cwd: path, name: shellName, cols: 80, rows: 24 }); if (nameOverride && baseTerminal) { await info.host.backend.ptyKill(baseTerminal.id); closeLocally(baseTerminal); } await refreshHost(info); const created = { id, name: shellName, project: path?.split(/[\\/]/).filter(Boolean).at(-1) ?? baseTerminal?.project ?? null, cwd: path ?? null, tail: "", state: "running" as const, exitCode: null, lastActivity: Date.now(), cursor: 0, machineId: info.id, machineName: info.name, firstSeen: Date.now() }; setSummaries((prev) => ({ ...prev, [info.id]: [created, ...(prev[info.id] ?? []).filter((item) => item.id !== id)] })); open(created); }
    catch (error) { setNotice(String(error)); }
  };
  const sendText = async (text: string) => {
    if (!machine || !terminal || terminal.state !== "running") return;
    // Whatever it asked before this has been answered; only output from here on can ask again.
    setSummaries((current) => ({ ...current, [machine.id]: (current[machine.id] ?? []).map((item) => item.id === terminal.id ? { ...item, answerTail: "" } : item) }));
    try { await machine.host.backend.ptyWrite(terminal.id, text); } catch (error) { setNotice(String(error)); }
  };
  const sendInput = (event: FormEvent) => { event.preventDefault(); const text = input; setInput(""); void sendText(`${text}\r`); };
  const onBeforeInput = (event: React.FormEvent<HTMLInputElement>) => {
    if (!ctrl) return;
    const inputEvent = event.nativeEvent as InputEvent; const code = controlCode(inputEvent.data ?? "");
    if (!code) return;
    event.preventDefault(); setCtrl(false); void sendText(code);
  };
  const holdBind = (item: PhoneTerminalInfo) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => { holdFired.current = false; const point = { x: event.clientX, y: event.clientY }; hold.current = setTimeout(() => { holdFired.current = true; pointer.current = { ...point, active: false, id: event.pointerId }; setTarget(item); setSheet("menu"); }, 500); },
    onPointerUp: () => { if (hold.current) clearTimeout(hold.current); hold.current = null; },
    onPointerLeave: () => { if (hold.current) clearTimeout(hold.current); hold.current = null; },
  });
  const swipeStart = (event: ReactPointerEvent<HTMLDivElement>) => { pointer.current = { x: event.clientX, y: event.clientY, active: false, id: event.pointerId }; };
  const swipeMove = (event: ReactPointerEvent<HTMLDivElement>) => { const p = pointer.current; if (!p || p.id !== event.pointerId) return; const dx = event.clientX - p.x, dy = event.clientY - p.y; if (swipeIntent(dx, dy)) { p.active = true; setDragX(dx); } };
  const swipeEnd = (event: ReactPointerEvent<HTMLDivElement>) => { const p = pointer.current; if (!p || p.id !== event.pointerId) return; const dx = event.clientX - p.x; const intent = swipeIntent(dx, event.clientY - p.y); setDragX(0); pointer.current = null; if (!intent) return; const index = strip.findIndex((item) => item.id === terminal?.id); const next = strip[index + (intent === "left" ? 1 : -1)]; if (next && Math.abs(dx) > (xtermHost.current?.clientWidth ?? 1) * 0.25) setTimeout(() => open(next), 200); };

  const row = (item: PhoneTerminalInfo, current = false) => {
    const snippet = item.matched ?? lastLine(item.tail);
    const needle = query.trim();
    const at = needle ? snippet.toLowerCase().indexOf(needle.toLowerCase()) : -1;
    const snippetContent = at >= 0 ? <>{snippet.slice(0, at)}<mark>{snippet.slice(at, at + needle.length)}</mark>{snippet.slice(at + needle.length)}</> : snippet;
    return <button key={`${item.machineId}:${item.id}`} type="button" className="ph-term-row" onClick={() => { if (holdFired.current) { holdFired.current = false; return; } open(item); }} {...holdBind(item)}>
      <i className={`ph-term-dot ${dotState(item)}`} /><span className="ph-term-row-main"><b>{item.name}{fromPhone(item.id) && <small> · from this phone</small>}</b><small>{dotText[dotState(item)]}{snippet ? <> · {snippetContent}</> : ""}</small></span><span className="ph-term-age">{current ? <Check size={16} /> : age(item.lastActivity)}</span>
    </button>;
  };
  const sheetContent = <>
    {sheet === "list" && <div className="ph-sheet-back" onClick={() => setSheet(null)}><div className="ph-sheet" role="dialog" aria-modal="true" aria-label="Terminals" tabIndex={-1} ref={sheetDialog} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setSheet(null); }}><div className="ph-handle" /><div className="ph-sheet-title"><h3>Terminals</h3><button type="button" className="ph-icon" aria-label="Close" onClick={() => setSheet(null)}><X size={20} /></button></div><div className="ph-sheet-body"><div className="ph-term-sheet"><input className="ph-term-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names and output" />
      {(query ? searchResults ?? [] : visible).length === 0 && query && <p className="ph-term-muted">No terminal name or recent output matches “{query}”.</p>}
      {(query ? groupForSheet(infos, searchResults ?? [], { machineId: machine?.id ?? "", project }) : groups).map((group) => <div key={`${group.machine.id}:${group.project}`}><h4>{group.machine.name} · {group.project}</h4>{group.terminals.map((item) => row(item, view.kind === "terminal" && item.id === view.id))}</div>)}
      {infos.filter((info) => !info.access || !info.online || hostState[info.id] === "old" || hostState[info.id] === "needs-all-threads" || hostState[info.id] === "error").map((info) => <p className="ph-term-muted" role={!info.online || hostState[info.id] === "error" || hostState[info.id] === "old" || hostState[info.id] === "needs-all-threads" ? "status" : undefined} key={info.id}>{info.name}: {hostState[info.id] === "old" ? `Update Apex Deck on ${info.name} to see its terminals (${hostErrors[info.id]})` : hostState[info.id] === "needs-all-threads" ? `Allow this phone every thread on ${info.name} (${hostErrors[info.id]})` : hostState[info.id] === "error" ? `Couldn't load terminals: ${hostErrors[info.id]}` : !info.online ? `Couldn't load terminals: ${terminalHostIssue(info)}` : `Needs Full access on ${info.name}`}</p>)}
      {!query && machine && <button type="button" className="ph-list-add" onClick={() => void newShell(machine)}>New shell in {project}</button>}
      <p className="ph-term-foot">Shows terminals opened in Apex Deck. Terminal.app and iTerm windows aren't listed.</p></div></div></div></div>}
    {sheet === "menu" && target && <div className="ph-sheet-back" onClick={() => setSheet(null)}><div className="ph-sheet" role="dialog" aria-modal="true" aria-label={`${target.name} actions`} tabIndex={-1} ref={sheetDialog} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setSheet(null); }}><div className="ph-handle" /><div className="ph-sheet-title"><h3><i className={`ph-term-dot ${dotState(target)}`} /> {target.name}</h3><button type="button" className="ph-icon" aria-label="Close" onClick={() => { setSheet(null); setTarget(null); }}><X size={20} /></button></div><div className="ph-sheet-body"><div className="ph-term-sheet"><p className="ph-term-muted">{target.project} · {target.machineName} · {dotText[dotState(target)]}</p>
      {rename === target.id ? <form onSubmit={(event) => { event.preventDefault(); const targetHost = infos.find((info) => info.id === target.machineId); if (!targetHost) return; void renameTerminal(targetHost.host.backend, target.id, renameValue).then(() => { setSummaries((s) => ({ ...s, [target.machineId]: (s[target.machineId] ?? []).map((item) => item.id === target.id ? { ...item, name: renameValue } : item) })); setRename(null); setSheet(null); }).catch((error) => setNotice(String(error))); }}><input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /><button type="submit">Save</button></form> : <button className="ph-term-action" onClick={() => { setRenameValue(target.name); setRename(target.id); }}>Rename</button>}
      <button className="ph-term-action" onClick={() => { const buffer = xterm.current?.buffer.active; const count = Math.min(200, buffer?.length ?? 0); const text = terminal?.id === target.id && buffer ? Array.from({ length: count }, (_, index) => buffer.getLine(buffer.length - count + index)?.translateToString(true) ?? "").join("\n") : stripAnsi(target.tail); const copy = canWriteClipboard ?? ((value: string) => writeClipboard(value, navigator.clipboard)); void copyLastOutput(text, copy).then((ok) => setNotice(ok ? "Copied" : "Couldn't copy output")); setSheet(null); }}>Copy last output</button>
      <button className="ph-term-action danger" onClick={() => { const targetHost = infos.find((info) => info.id === target.machineId); if (!targetHost) return; void endTerminal(targetHost.host.backend, target.id).then(() => { setNotice(`Ended ${target.name}`); setSheet(null); }).catch((error) => setNotice(String(error))); }}>End terminal</button>
    </div></div></div></div>}
  </>;

  return <>
  <div className={view.kind === "terminal" ? "ph-term-root viewing" : "ph-term-root"} hidden={hidden} ref={termRoot}>
    {view.kind === "home" ? <>
      {/* The header says Code; this one line says where a new shell starts. */}
      <p className="ph-intro"><i className={`ph-dot${machine?.online ? " on" : " off"}`} />{folder ? `${folder} · ${machine?.name ?? name}` : machine?.name ?? name}</p>
      <div className="ph-section">Terminals<button type="button" className="ph-section-action" onClick={() => { setQuery(""); setSheet("list"); }}>See all</button></div>
      {machine && !machine.online ? <p className="ph-list-note" role="status">Couldn't load terminals: {terminalHostIssue(machine)}</p>
        : (machine && !machine.access) || eligible.length === 0 ? <p className="ph-list-note">Needs Full access on {machine?.name ?? name}.</p>
        : <>
          {machine && hostErrors[machine.id] && <p className="ph-list-note" role="status">Couldn't load terminals: {hostErrors[machine.id]}</p>}
          {here.length > 0 ? <>
            <div className="ph-list">
              {here.slice(0, HOME_ROWS).map((item) => row(item))}
              {machine && <button type="button" className="ph-list-add" onClick={() => void newShell(machine)}>New shell</button>}
            </div>
          </> : machine && !hostState[machine.id] ? <p className="ph-list-note" role="status">Loading terminals…</p>
            : <div className="ph-empty">
              <h3>No open terminals</h3>
              {machine && <><p>Start a shell in {project} on {machine.name}.</p><button type="button" className="primary ph-wide" onClick={() => void newShell(machine)}>New shell</button></>}
            </div>}
        </>}
      {resumable && lastTerminal && <button type="button" className="ph-term-resume" onClick={() => setView(lastTerminal)}>Resume last terminal</button>}
      {visible.length > 0 && <p className="ph-foot">Hold the Code tab to jump to any terminal.</p>}
    </> : <>
      <div className="ph-term-title-row"><h1 className="ph-term-title">Terminal</h1><button type="button" aria-label={`New shell in ${project}`} onClick={() => machine && void newShell(machine, terminal ?? undefined)}><Plus size={22} /></button></div>
      <button type="button" className="ph-term-project-button" onClick={() => { setQuery(""); setSheet("list"); }}>{project} · <b>{terminal?.name ?? "Terminal"}</b><ChevronDown size={12} /></button>
      <div className="ph-term-strip" role="tablist" aria-label="Open terminals">{strip.map((item) => <button key={item.id} ref={item.id === terminal?.id ? selectedStrip : undefined} type="button" role="tab" aria-selected={item.id === terminal?.id} className={item.id === terminal?.id ? "selected" : ""} {...holdBind(item)} onClick={() => { if (holdFired.current) { holdFired.current = false; return; } open(item); }}><i className={`ph-term-dot ${dotState(item)}`} />{item.name}{fromPhone(item.id) && <small>phone</small>}</button>)}</div>
      {terminal && <>
        <div className={`ph-term-status ${dotState(terminal)}`}>{dotState(terminal) === "ask" ? <><span>Asking: {askLine(questionText(terminal))}</span>{isYesNo(questionText(terminal)) &&<span><button onClick={() => void sendText("n\r")}>No</button><button onClick={() => void sendText("y\r")}>Yes</button></span>}</> : dotState(terminal) === "ended" || dotState(terminal) === "fail" ? <><span>Finished {ago(age(terminal.lastActivity))} · exit {terminal.exitCode ?? "?"}</span><span><button onClick={() => closeTerminal(terminal)}>Close</button><button onClick={() => machine && void newShell(machine, terminal, terminal.name)}>Start again</button></span></> : <span>Full permission · input enabled</span>}</div>
        <div className={`ph-term-swipe${dragX !== 0 ? " dragging" : ""}`} onPointerDown={swipeStart} onPointerMove={swipeMove} onPointerUp={swipeEnd} onPointerCancel={swipeEnd} style={{ transform: `translateX(${dragX / 4}px)` }}><div ref={xtermHost} className="ph-term-xterm" />{dragX !== 0 && (() => { const at = strip.findIndex((item) => item.id === terminal.id); const preview = strip[at + (dragX < 0 ? 1 : -1)]; return preview ? <div className={`ph-term-preview ${dragX < 0 ? "next" : "previous"}`}><b>{preview.name}</b><pre>{stripAnsi(preview.tail).split(/\r?\n/u).slice(-40).join("\n")}</pre></div> : null; })()}</div>
        {terminal.state === "running" && <><div className="ph-term-keys">{[["Esc", "\x1b"], ["Tab", "\t"], [ctrl ? "Ctrl ✓" : "Ctrl", "ctrl"], ["←", "D"], ["↓", "B"], ["↑", "A"], ["→", "C"]].map(([label, data]) => <button key={label} type="button" className={data === "ctrl" && ctrl ? "active" : ""} onClick={() => data === "ctrl" ? setCtrl((value) => !value) : void sendText(["A", "B", "C", "D"].includes(data) ? arrowCode(data as "A" | "B" | "C" | "D", !!xterm.current?.modes.applicationCursorKeysMode) : data)}>{label}</button>)}</div><form className="ph-term-command" onSubmit={sendInput}><input value={input} onChange={(event) => setInput(event.target.value)} onBeforeInput={onBeforeInput} placeholder="Type a command…" enterKeyHint="send" autoCapitalize="off" autoCorrect="off" spellCheck={false} /><button type="submit" aria-label="Send">↵</button></form></>}
      </>}
    </>}
    {notice && <button className="ph-term-notice" onClick={() => setNotice("")}>{notice} · dismiss</button>}
  </div>
  {sheetPortal && !hidden && sheet !== null ? createPortal(sheetContent, sheetPortal) : null}
  </>;
}
