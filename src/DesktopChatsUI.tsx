// Chats on the desktop: the rail's Chats section, New chat, and the open chat itself.
// Conversation rendering is shared with Work threads in ChatPane.

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { HostConnectionStore } from "./hostConnections";
import type { Access, ParticipantConfig } from "./types";
import { type ChatEntry, type ChatProfile } from "./chatCatalog.ts";
import { deliveryId, type DesktopChats } from "./desktopChats.ts";
import { ageWords } from "./sidebarModel.ts";
import { DOT_WORDS, dotState } from "./hostFacts.ts";
import { Glyph } from "./SidebarIcons";
import "./desktop-chat.css";

const noStore = { subscribe: () => () => {}, get: () => null };
function useDot(store: HostConnectionStore | null, local: boolean) {
  const source = store ?? noStore;
  const state = useSyncExternalStore(source.subscribe, source.get);
  return state ? dotState(state.status) : local ? "on" : "idle";
}
const words = (error: unknown) => error instanceof Error ? error.message : String(error);

// ---- The rail ---------------------------------------------------------------------------------

function ChatRow({ row, chats, open, onOpen }: { row: ChatEntry; chats: DesktopChats; open: boolean; onOpen(): void }) {
  const dot = useDot(chats.connectionOf(row.hostId), row.hostId === "local");
  const name = chats.machineName(row.hostId);
  return <div role="button" tabIndex={0} className={["pane-row", "flat", "chat-row", open && "focused", dot === "off" && "chat-row-off"].filter(Boolean).join(" ")}
    onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onOpen(); } }}
    title={`${row.title} · ${name}${dot === "off" ? " (not connected)" : ""}`}>
    <span className={`hdot ${dot}`} role="img" aria-label={`${name}: ${DOT_WORDS[dot]}`} />
    <span className="pane-row-clip"><span className="pane-row-title">{row.title}</span></span>
    {row.promotedTo && <span className="chat-row-tag" title="Moved to a Work thread">Moved</span>}
    <span className="chat-row-side">{name} · {row.updatedAt ? ageWords(Date.now() - row.updatedAt) : "New"}</span>
  </div>;
}

export function ChatRail({ chats, openKey, onOpen, onNew }: { chats: DesktopChats; openKey: string | null; onOpen(row: ChatEntry): void; onNew(): void }) {
  const [open, setOpen] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const able = chats.machines.some((machine) => chats.rooms[machine.id] !== false);
  return <>
    <div className="rail-sec" data-sec="chats">
      <button className="rail-sec-toggle" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        Chats <Glyph name={open ? "chevDown" : "chevRight"} size={12} />
      </button>
      <button type="button" className="icon chat-new" aria-label="New chat" title="New chat" disabled={!able} onClick={onNew}>+</button>
    </div>
    {open && <>
      {chats.rows.length === 0 && <p className="muted rail-empty">No chats yet.</p>}
      {chats.rows.map((row) => <ChatRow key={deliveryId({ hostId: row.hostId, room: row.id })} row={row} chats={chats} open={openKey === deliveryId({ hostId: row.hostId, room: row.id })} onOpen={() => onOpen(row)} />)}
      {chats.archived.length > 0 && <button type="button" className="ghost chat-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((was) => !was)}>
        Archived chats ({chats.archived.length})
      </button>}
      {showArchived && chats.archived.map((row) => <ChatRow key={deliveryId({ hostId: row.hostId, room: row.id })} row={row} chats={chats} open={openKey === deliveryId({ hostId: row.hostId, room: row.id })} onOpen={() => onOpen(row)} />)}
    </>}
  </>;
}

// ---- New chat ---------------------------------------------------------------------------------

export function NewChatDialog({ chats, onClose, onStarted }: { chats: DesktopChats; onClose(): void; onStarted(row: ChatEntry): void }) {
  const choices = chats.machines.filter((machine) => chats.rooms[machine.id] !== false);
  const [hostId, setHostId] = useState(() => choices.find((m) => chats.online(m.id))?.id ?? choices[0]?.id ?? "");
  const [profiles, setProfiles] = useState<ChatProfile[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setProfiles(null); setPicked([]); setProblem("");
    if (!hostId) return;
    if (!chats.online(hostId)) { setProblem(`${chats.machineName(hostId)} isn't connected.`); return; }
    chats.profiles(hostId).then((list) => {
      if (!live) return;
      setProfiles(list);
      const first = list.find((item) => item.ok);
      setPicked(first ? [first.profile.id] : []);
    }, (error) => { if (live) setProblem(words(error)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  const start = async () => {
    if (!picked.length || busy) return;
    setBusy(true); setProblem("");
    try { onStarted(await chats.create(hostId, picked)); }
    catch (error) { setProblem(words(error)); setBusy(false); }
  };
  return createPortal(
    <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="confirm new-chat" role="dialog" aria-modal="true" aria-labelledby="new-chat-title">
        <strong id="new-chat-title">New chat</strong>
        <p className="muted">Talk only: the bots can't read or change files, run commands or search the web.</p>
        <label className="new-chat-field">Machine
          <select value={hostId} onChange={(event) => setHostId(event.target.value)}>
            {choices.map((machine) => <option key={machine.id} value={machine.id}>{chats.machineName(machine.id)}{chats.online(machine.id) ? "" : " (not connected)"}</option>)}
          </select>
        </label>
        <fieldset className="new-chat-bots">
          <legend>Bots</legend>
          {profiles === null && !problem && <p className="muted">Asking {chats.machineName(hostId)} for its bots…</p>}
          {profiles?.length === 0 && <p className="muted">No saved bots on {chats.machineName(hostId)}.</p>}
          {profiles?.map((item) => <label key={item.profile.id} className={item.ok ? "" : "muted"} title={item.reason ?? undefined}>
            <input type="checkbox" disabled={!item.ok} checked={picked.includes(item.profile.id)}
              onChange={(event) => setPicked((all) => event.target.checked ? [...all, item.profile.id] : all.filter((id) => id !== item.profile.id))} />
            {item.profile.display_name}{!item.ok && item.reason ? ` — ${item.reason}` : ""}
          </label>)}
        </fieldset>
        {problem && <p className="chat-problem" role="status">{problem}</p>}
        <div className="confirm-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!picked.length || busy} onClick={() => void start()}>{busy ? "Starting…" : "Start chat"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---- Move to a Work thread -------------------------------------------------------------------

const ACCESS: { id: Access; text: string }[] = [{ id: "read", text: "Read-only" }, { id: "ask", text: "Ask" }, { id: "edits", text: "Edit" }, { id: "full", text: "Full" }];
const folderTail = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Pick a folder on the chat's machine and what each bot may do there. A move sent earlier and never
 *  confirmed can only be finished as it was, or started over once the machine has fenced it off. */
export function MoveToWorkDialog({ row, bots, chats, onClose, onMoved }: { row: ChatEntry; bots: ParticipantConfig[]; chats: DesktopChats; onClose(): void; onMoved(work: ChatEntry): void }) {
  const dot = useDot(chats.connectionOf(row.hostId), row.hostId === "local");
  const online = dot === "on";
  const name = chats.machineName(row.hostId);
  const left = chats.promoteTicket(row);
  const [folder, setFolder] = useState("");
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [state, setState] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !state.busy) { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose, state.busy]);
  const run = (work: () => Promise<ChatEntry | null>) => {
    setState({ busy: true, error: "" });
    work().then((done) => { setState({ busy: false, error: "" }); if (done) onMoved(done); }, (error) => setState({ busy: false, error: words(error) }));
  };
  const choose = () => chats.pickFolder(row.hostId).then((path) => { if (path) setFolder(path); }, (error) => setState({ busy: false, error: words(error) }));
  const level = (bot: ParticipantConfig) => left ? left.access[bot.id] ?? "read" : access[bot.id] ?? "ask";
  return createPortal(
    <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !state.busy) onClose(); }}>
      <div className="confirm move-to-work" role="dialog" aria-modal="true" aria-labelledby="move-to-work-title">
        <strong id="move-to-work-title">Move to a Work thread</strong>
        {left
          ? <p className="muted">A move to <b>{folderTail(left.cwd)}</b> on {name} was sent, but {name} never confirmed it. Finish it with the same choices, so it can't make a second thread or change what the bots may do.</p>
          : <p className="muted">Pick a folder on <b>{name}</b>. The Work thread starts with this chat's messages and the same bots. This chat stays listed, read-only, with a link to it.</p>}
        <div className="move-to-work-folder">
          {left ? <code title={left.cwd}>{left.cwd}</code> : <>
            <code title={folder || undefined}>{folder || "No folder picked"}</code>
            <button type="button" disabled={!online || state.busy} onClick={() => void choose()}>{folder ? "Change…" : "Choose folder…"}</button>
          </>}
        </div>
        <fieldset className="move-to-work-bots">
          <legend>What each bot may do in the folder</legend>
          {bots.map((bot) => <div key={bot.id} className="move-to-work-bot">
            <span>{bot.display_name}</span>
            {left ? <span className="muted">{ACCESS.find((choice) => choice.id === level(bot))?.text ?? level(bot)}</span>
              : <span className="segmented" role="radiogroup" aria-label={`${bot.display_name} access`}>{ACCESS.map((choice) => (
                <button key={choice.id} type="button" role="radio" aria-checked={level(bot) === choice.id} className={level(bot) === choice.id ? "seg on" : "seg"} disabled={state.busy}
                  onClick={() => setAccess((now) => ({ ...now, [bot.id]: choice.id }))}>{choice.text}</button>
              ))}</span>}
          </div>)}
        </fieldset>
        {!online && <p className="chat-problem" role="status">{name} isn't connected. {left ? "Finish the move" : "Pick a folder"} once it's back.</p>}
        {state.error && <p className="chat-problem" role="alert">{state.error}</p>}
        <div className="confirm-actions">
          <button disabled={state.busy} onClick={onClose}>Cancel</button>
          {left && <button disabled={state.busy || !online} onClick={() => run(() => chats.promoteOver(row))}>Start over</button>}
          {left
            ? <button className="primary" disabled={state.busy || !online} onClick={() => run(() => chats.promote(row, left.cwd, left.access))}>{state.busy ? "Moving…" : "Finish the move"}</button>
            // Every bot is named, so a bot left on the default still gets the access shown beside it.
            : <button className="primary" disabled={state.busy || !online || !folder} onClick={() => run(() => chats.promote(row, folder, Object.fromEntries(bots.map((bot) => [bot.id, level(bot)]))))}>{state.busy ? "Moving…" : folder ? `Move to ${folderTail(folder)}` : "Pick a folder"}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
