// Chats on the desktop: the rail's Chats section, New chat, and the open chat itself.
// A chat is talk-only: no folder, git, Plan, access, Revert, Fork or voice. Bots keep their
// model, reasoning and Speed. Every message goes through the outbox in desktopChats.ts.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { HostConnectionStore } from "./hostConnections";
import type { Message, ParticipantConfig, RoomEvent, RoomSnapshot, RoomState, Speed } from "./types";
import { botNames, type ChatEntry, type ChatProfile } from "./chatCatalog.ts";
import { chatDeliveryStatus, type ChatOutboxMessage } from "./chatDelivery.ts";
import { deliveryId, sendBlock, type DesktopChats } from "./desktopChats.ts";
import { ageWords } from "./sidebarModel.ts";
import { DOT_WORDS, dotState } from "./hostFacts.ts";
import { Glyph } from "./SidebarIcons";
import { ThreadName } from "./ThreadName";
import { Markdown } from "./Markdown";
import { createRoomRecovery, representedRoomEvent } from "./roomRecovery.ts";
import { AGENT_EFFORTS, AGENT_MODELS, API_EFFORTS, effortLabel, effortsFor } from "./models";
import { SPEED_OPTIONS, supportsSpeed } from "./speed";
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

// ---- One bot's settings -----------------------------------------------------------------------

function BotControls({ bot, disabled, onChange, onRemove }: { bot: ParticipantConfig; disabled: boolean; onChange(change: { model?: string | null; effort?: string | null; speed?: Speed | null }): void; onRemove(): void }) {
  const agent = bot.backend.kind === "agent" ? bot.backend : null;
  const api = bot.backend.kind === "open_ai_compatible" ? bot.backend : null;
  const groups = agent ? AGENT_MODELS[agent.tool] ?? [] : [];
  const model = agent?.model ?? api?.model ?? "";
  const models = groups.flatMap((group) => group.models);
  const efforts = agent ? effortsFor(AGENT_EFFORTS[agent.tool] ?? [], groups, model) : api ? API_EFFORTS : [];
  return <div className="chat-bot" aria-label={bot.display_name}>
    <strong className="chat-bot-name">{bot.display_name}</strong>
    {agent && <select aria-label={`${bot.display_name} model`} disabled={disabled} value={model} onChange={(event) => onChange({ model: event.target.value || null })}>
      <option value="">Default model</option>
      {model && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
      {models.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
    </select>}
    {api && <span className="muted chat-bot-model" title="Model">{api.model}</span>}
    {efforts.length > 0 && <select aria-label={`${bot.display_name} reasoning`} disabled={disabled} value={bot.effort ?? ""} onChange={(event) => onChange({ effort: event.target.value || null })}>
      <option value="">Default reasoning</option>
      {bot.effort && !efforts.includes(bot.effort) && <option value={bot.effort}>{effortLabel(bot.effort)}</option>}
      {efforts.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
    </select>}
    {supportsSpeed(bot.backend) && <select aria-label={`${bot.display_name} speed`} disabled={disabled} value={bot.speed ?? ""} onChange={(event) => onChange({ speed: (event.target.value || null) as Speed | null })}>
      {SPEED_OPTIONS.map((option) => <option key={option.value} value={option.value} title={option.title}>{option.text === "Default" ? "Default speed" : option.text}</option>)}
    </select>}
    <button type="button" className="ghost chat-bot-remove" disabled={disabled} aria-label={`Remove ${bot.display_name}`} title="Remove from this chat" onClick={onRemove}>×</button>
  </div>;
}

// ---- The open chat ----------------------------------------------------------------------------

interface Live { participants: ParticipantConfig[]; transcript: Message[]; working: Record<string, string> }

export function ChatView({ row, chats, onOpenWork, onClose }: { row: ChatEntry; chats: DesktopChats; onOpenWork(row: ChatEntry, workId: string): void; onClose(): void }) {
  const key = deliveryId({ hostId: row.hostId, room: row.id });
  const backend = chats.backendOf(row.hostId);
  const dot = useDot(chats.connectionOf(row.hostId), row.hostId === "local");
  const online = dot === "on";
  const machine = { id: row.hostId, name: chats.machineName(row.hostId) };
  const [room, setRoom] = useState<Live | null>(null);
  const [problem, setProblem] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<ChatProfile[] | null>(null);
  const rowRef = useRef(row);
  rowRef.current = row;
  const endRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const nameRef = useRef((id: string) => id);
  const draft = drafts[key] ?? "";

  // The room's state, then its live events. Reloaded when the chat or its machine's connection changes.
  useEffect(() => {
    setRoom(null); setProblem("");
    if (!backend || !online) return;
    let live = true, stop = () => {};
    const apply = (state: RoomState) => {
      const snapshot: RoomSnapshot = state.snapshot;
      setRoom({ participants: snapshot.participants, transcript: snapshot.transcript, working: Object.fromEntries((state.active ?? []).map((id) => [id, ""])) });
      chats.remember(rowRef.current, snapshot);
    };
    const event = (raw: RoomEvent) => {
      const e: RoomEvent = raw.type === "voice_event" ? raw.event : raw;
      setRoom((current) => {
        if (!current) return current;
        switch (e.type) {
          case "message_added": {
            const working = { ...current.working };
            if (e.message.speaker.kind === "bot") delete working[e.message.speaker.id];
            return current.transcript.some((m) => m.seq === e.message.seq) ? { ...current, working } : { ...current, transcript: [...current.transcript, e.message], working };
          }
          case "turn_started": return { ...current, working: { ...current.working, [e.id]: "" } };
          case "delta": return { ...current, working: { ...current.working, [e.id]: (current.working[e.id] ?? "") + e.text } };
          case "participant_idle": case "passed": { const { [e.id]: _, ...working } = current.working; return { ...current, working }; }
          case "failed": { const { [e.id]: _, ...working } = current.working; return { ...current, working }; }
          case "participants_changed": return { ...current, participants: e.participants };
          case "participant_changed": return { ...current, participants: current.participants.map((p) => p.id === e.participant.id ? e.participant : p) };
          default: return current;
        }
      });
      if (e.type === "failed") setProblem(`${nameRef.current(e.id)} couldn't reply: ${e.error}`);
    };
    const recovery = createRoomRecovery<RoomState, RoomEvent>({
      load: () => backend.roomState ? backend.roomState(row.id) : backend.call<RoomState>("room_state", { id: row.id }),
      apply, event, represented: representedRoomEvent,
      fail: (error) => { if (live) setProblem(words(error)); },
    });
    backend.onRoomEvent((id, e) => {
      if (!live || id !== row.id) return;
      if (!recovery.capture(e)) event(e);
    }).then((unlisten) => { if (!live) { unlisten(); return; } stop = unlisten; void recovery.refresh(); }).catch((error) => { if (live) setProblem(words(error)); });
    return () => { live = false; recovery.dispose(); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, online]);

  // While the machine is off, the outbox's saved copy shows instead.
  const kept = chats.delivery?.snapshot().chats[key];
  const shown: Live | null = room ?? (kept ? { participants: kept.snapshot.participants, transcript: kept.snapshot.transcript, working: {} } : null);
  const outbox: ChatOutboxMessage[] = kept?.outbox ?? [];
  const inTranscript = new Set(shown?.transcript.flatMap((m) => m.clientMessageId ? [m.clientMessageId] : []) ?? []);
  const waiting = outbox.filter((item) => !inTranscript.has(item.id) && item.accepted !== "done");
  const notes = new Map(outbox.filter((item) => inTranscript.has(item.id)).map((item) => [item.id, item]));
  const nameOf = (id: string) => shown?.participants.find((p) => p.id === id)?.display_name ?? row.bots.find((b) => b.id === id)?.name ?? id;
  nameRef.current = nameOf;
  const streamed = shown ? Object.values(shown.working).reduce((sum, text) => sum + text.length + 1, 0) : 0;
  useEffect(() => { if (stuck.current) endRef.current?.scrollIntoView({ block: "end" }); }, [shown?.transcript.length, waiting.length, streamed, key]);
  useEffect(() => { stuck.current = true; }, [key]);

  const block = sendBlock(row, machine, chats.rooms[row.hostId]) ?? chats.deliveryProblem;
  const send = () => {
    const text = draft.trim();
    if (!text || block) return;
    try { chats.send(row, text); setDrafts((all) => ({ ...all, [key]: "" })); setProblem(""); stuck.current = true; }
    catch (error) { setProblem(words(error)); }
  };
  const act = (work: Promise<unknown>) => work.catch((error) => setProblem(words(error)));
  const editBot = (bot: ParticipantConfig, change: { model?: string | null; effort?: string | null; speed?: Speed | null }) => act(chats.updateBot(row, bot, change).then((saved) => {
    if (saved) setRoom((current) => current ? { ...current, participants: current.participants.map((p) => p.id === saved.id ? saved : p) } : current);
  }));
  const openAdd = () => act(chats.profiles(row.hostId).then((list) => {
    const have = new Set(Object.values(row.profiles));
    setAdding(list.filter((item) => item.ok && !have.has(item.profile.id)));
  }));

  // Talk-only: web links open, file paths don't (a chat has no folder).
  const openLink = (target: string) => { if (/^https?:\/\//i.test(target)) backend?.openTarget(target, null, false).catch((error) => setProblem(words(error))); };
  const bubble = (m: Message) => {
    const note = m.clientMessageId ? notes.get(m.clientMessageId) : undefined;
    const status = note ? chatDeliveryStatus(note, machine) : null;
    const who = m.speaker.kind === "human" ? "You" : nameOf(m.speaker.id);
    return <article key={`m${m.seq}`} className={`chat-msg ${m.speaker.kind}`}>
      <small className="chat-msg-who">{who}{m.lateReplyFrom ? ` · late reply from ${m.lateReplyFrom}` : ""}</small>
      <Markdown text={m.text} onOpen={openLink} />
      {status && (status.kind === "interrupted" || status.kind === "fenced") && <p className="chat-msg-status">
        {status.line}{status.canRetry && <button type="button" className="ghost" onClick={() => chats.retry(row, note!.id)}>Retry</button>}
      </p>}
    </article>;
  };

  return <section className="desktop-chat" aria-label={`Chat: ${row.title}`}>
    <header className="desktop-chat-head">
      <ThreadName className="desktop-chat-title" title={row.title} label="Chat name" onRename={(title) => void act(chats.updateMeta(row, { title }))} />
      <span className="desktop-chat-machine"><span className={`hdot ${dot}`} role="img" aria-label={DOT_WORDS[dot]} />Chat · {machine.name}</span>
      <span className="desktop-chat-acts">
        {!row.promotedTo && <button type="button" className="ghost" disabled={!online} onClick={() => void act(chats.updateMeta(row, { archived: !row.archived }))}>{row.archived ? "Unarchive" : "Archive"}</button>}
        <button type="button" className="icon" aria-label="Close chat" title="Close" onClick={onClose}>×</button>
      </span>
    </header>
    {row.promotedTo && <p className="desktop-chat-banner">Moved to a Work thread. This chat is kept as it was. <button type="button" className="ghost" onClick={() => onOpenWork(row, row.promotedTo!)}>Open the Work thread</button></p>}
    {!online && <p className="desktop-chat-banner">{machine.name} isn't connected. Messages wait here and go when it's back.</p>}
    {shown && <div className="desktop-chat-bots">
      {shown.participants.map((bot) => <BotControls key={bot.id} bot={bot} disabled={!online || !!row.promotedTo} onChange={(change) => void editBot(bot, change)} onRemove={() => void act(chats.removeBot(row, bot.id))} />)}
      {!row.promotedTo && <button type="button" className="ghost chat-bot-add" disabled={!online} onClick={() => void openAdd()}>+ Add bot</button>}
      {adding && <span className="chat-bot-picker">
        {adding.length === 0 ? <span className="muted">No other bots on {machine.name}.</span> : adding.map((item) => <button key={item.profile.id} type="button" onClick={() => { setAdding(null); void act(chats.addBot(row, item.profile.id)); }}>{item.profile.display_name}</button>)}
        <button type="button" className="ghost" onClick={() => setAdding(null)}>Cancel</button>
      </span>}
    </div>}
    <div className="desktop-chat-log" onScroll={(event) => { const el = event.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {!shown && !problem && <p className="muted">{online ? "Opening…" : `Open this chat while ${machine.name} is connected to see it.`}</p>}
      {shown && !row.promotedTo && shown.transcript.length === 0 && waiting.length === 0 && <p className="muted">Say hello to {botNames({ bots: shown.participants.map((p) => ({ id: p.id, name: p.display_name })) })}.</p>}
      {shown?.transcript.map(bubble)}
      {waiting.map((item) => { const status = chatDeliveryStatus(item, machine); return <article key={`o${item.id}`} className="chat-msg human pending">
        <small className="chat-msg-who">You</small>
        <Markdown text={item.text} onOpen={openLink} />
        <p className="chat-msg-status">{status.line}{status.canRetry && <button type="button" className="ghost" onClick={() => chats.retry(row, item.id)}>Retry</button>}</p>
      </article>; })}
      {shown && Object.entries(shown.working).map(([id, text]) => <article key={`w${id}`} className="chat-msg bot working">
        <small className="chat-msg-who">{nameOf(id)} · replying…</small>
        {text ? <Markdown text={text} onOpen={openLink} /> : <p className="muted">Thinking…</p>}
      </article>)}
      <div ref={endRef} />
    </div>
    {problem && <p className="chat-problem" role="status">{problem}</p>}
    <footer className="desktop-chat-composer">
      <textarea aria-label="Message" rows={3} value={draft} disabled={!!row.promotedTo}
        placeholder={block ?? (online ? `Message ${shown ? botNames({ bots: shown.participants.map((p) => ({ id: p.id, name: p.display_name })) }) : "the bots"}` : `Waits for ${machine.name}`)}
        onChange={(event) => { const text = event.target.value; setDrafts((all) => ({ ...all, [key]: text })); }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      <button type="button" className="primary" disabled={!draft.trim() || !!block} onClick={send}>Send</button>
    </footer>
  </section>;
}
