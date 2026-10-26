// The phone's chat pieces, as in mockups/local-chat-jigga.html: the flat Chats list, and the
// bodies of the New chat, Bots, Where this chat runs, Move to a Work thread and old-history
// sheets. PhoneApp wraps each body in its own Sheet. Nothing here writes a reply itself.

import { useEffect, useState, type ReactNode } from "react";
import { Avatar } from "../Avatar";
import { legacyAppearance } from "../identicon";
import { ageWords } from "../sidebarModel";
import type { LinkView } from "../phoneRules";
import type { Access, FolderListing, ParticipantConfig } from "../types";
import { botNames, type ChatEntry, type ChatProfile, type LegacyChat } from "./chatCatalog";
import { startingBots } from "./chatRoutes";
import { ArrowLeft, Check, ChevronRight, Folder, Lock, MessageSquare, Plus } from "./icons";

const words = (error: unknown) => String(error).replace(/^Error: /, "");
const look = (config: Pick<ParticipantConfig, "id" | "appearance">) => config.appearance ?? legacyAppearance(config.id);

/** One machine as the chat sheets see it. `chats` is false on a machine that can't hold chats yet, with `why`. */
export interface ChatMachineView { id: string; name: string; status: LinkView["status"]; chats: boolean; why: string }

const statusWords = (machine: ChatMachineView) => machine.status === "online" ? "Connected" : machine.status === "offline" ? "Can't be reached · messages wait" : "Connecting… · messages wait";

function Dot({ status }: { status: LinkView["status"] }) {
  const tone = status === "online" ? "ok" : status === "offline" ? "off" : "wait";
  return <i className={`ph-chat-dot ${tone}`} aria-hidden="true" />;
}

// ---- The Chats list --------------------------------------------------------------------------

export function ChatRows(props: {
  rows: ChatEntry[]; archivedCount: number; showArchived: boolean; folded: boolean; now: number;
  machines: ChatMachineView[]; machineIcon(hostId: string, size?: number): ReactNode;
  /** Messages still on the phone for a chat, and how many bots are answering in it. */
  waiting(row: ChatEntry): number; working(row: ChatEntry): number;
  onFold(): void; onOpen(row: ChatEntry): void; onMenu(row: ChatEntry): void; onArchived(): void;
}) {
  const machine = (id: string) => props.machines.find((item) => item.id === id);
  return (
    <section className="ph-tl-machine ph-chats" aria-label="Chats">
      <div className="ph-tl-heading">
        <button type="button" className="ph-tl-p ph-tl-section" aria-expanded={!props.folded} onClick={props.onFold}>
          <MessageSquare size={14} /><span className="ph-tl-pname">Chats</span>
          {props.folded && <span className="ph-tl-count" aria-label={`${props.rows.length} chats`}>{props.rows.length}</span>}
          <span className="ph-tl-chev"><ChevronRight size={15} /></span>
        </button>
      </div>
      {!props.folded && props.rows.map((row) => {
        const where = machine(row.hostId);
        const waiting = props.waiting(row);
        const busy = props.working(row) > 0;
        const off = !where || where.status !== "online";
        return (
          <button key={`${row.hostId}/${row.id}`} type="button" className="ph-tl-thread" aria-haspopup="menu"
            aria-label={`${row.title}. ${botNames(row)} on ${where?.name ?? "a machine this phone no longer has"}`}
            onContextMenu={(event) => { event.preventDefault(); props.onMenu(row); }} onClick={() => props.onOpen(row)}>
            {waiting ? <i className="ph-tl-dot wait" role="img" aria-label="Waiting to send" /> : busy ? <i className="ph-tl-dot work" role="img" aria-label="A bot is answering" /> : null}
            <span className="ph-tl-l1"><span className="ph-tl-name">{row.title}</span><span className="ph-tl-age">{row.archived ? "Archived" : row.updatedAt ? ageWords(props.now - row.updatedAt) : "New"}</span></span>
            <span className="ph-tl-l2">
              <span className="ph-chat-stack" aria-hidden="true">{row.bots.slice(0, 3).map((bot) => { const face = legacyAppearance(bot.id); return <Avatar key={bot.id} seed={face.seed} color={face.color} size="sm" />; })}</span>
              {waiting ? <><span className="ph-tl-warn">Waiting</span><span>·</span></> : null}
              <span className="ph-tl-where">{botNames(row)}</span><span>·</span>
              {where && <Dot status={where.status} />}{props.machineIcon(row.hostId, 12)}<span className="ph-chat-host">{where?.name ?? "Unpaired"}</span>
              {off && !waiting && where ? <><span>·</span><span className="ph-tl-warn">{where.status === "offline" ? "Can't be reached" : "Connecting…"}</span></> : null}
            </span>
          </button>
        );
      })}
      {!props.folded && props.rows.length === 0 && <p className="ph-tl-none">No chats yet. Tap + to start one.</p>}
      {!props.folded && props.archivedCount > 0 && <button type="button" className="ph-tl-archived" onClick={props.onArchived}>{props.showArchived ? "Hide archived" : `Show ${props.archivedCount} archived`}</button>}
    </section>
  );
}

// ---- New ---------------------------------------------------------------------------------------

/** The + menu: a chat, or a Work thread in a folder. */
export function NewMenuBody(props: { chatLine: string | null; workLine: string | null; onChat(): void; onWork(): void }) {
  return (
    <div className="ph-list">
      <button type="button" className="ph-srow" disabled={props.chatLine === null} onClick={props.onChat}>
        <span className="ph-srow-icon"><MessageSquare size={18} /></span>
        <span className="ph-grow"><strong>New chat</strong><small>{props.chatLine ?? "Pair a machine with an up-to-date Deck to chat."}</small></span><ChevronRight size={16} />
      </button>
      <button type="button" className="ph-srow" disabled={props.workLine === null} onClick={props.onWork}>
        <span className="ph-srow-icon"><Folder size={18} /></span>
        <span className="ph-grow"><strong>New Work thread</strong><small>{props.workLine ?? "Needs Full access from this phone."}</small></span><ChevronRight size={16} />
      </button>
    </div>
  );
}

function useProfiles(hostId: string | null, load: (hostId: string) => Promise<ChatProfile[]>) {
  const [state, setState] = useState<{ hostId: string; list: ChatProfile[] | null; error: string } | null>(null);
  useEffect(() => {
    if (!hostId) { setState(null); return; }
    let live = true;
    setState({ hostId, list: null, error: "" });
    load(hostId).then((list) => { if (live) setState({ hostId, list, error: "" }); }).catch((error) => { if (live) setState({ hostId, list: null, error: words(error) }); });
    return () => { live = false; };
    // The list belongs to the chosen machine; asking again on every render would spam it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);
  return state?.hostId === hostId ? state : null;
}

function ProfileRow({ item, picked, onToggle }: { item: ChatProfile; picked: boolean; onToggle(): void }) {
  const face = look(item.profile);
  return (
    <div className="ph-bot-entry"><div className="ph-bot-row">
      <span className="ph-bot-info"><Avatar seed={face.seed} color={face.color} size="md" />
        <span className="ph-bot-label"><strong>{item.profile.display_name}</strong><small className={item.ok ? undefined : "ph-amber"}>{item.ok ? profileLine(item.profile) : item.reason ?? "Can't join a chat on this machine."}</small></span>
      </span>
      <button type="button" className="ph-bot-action" role="checkbox" aria-checked={picked} disabled={!item.ok} aria-label={`${picked ? "Leave out" : "Add"} ${item.profile.display_name}`} onClick={onToggle}>
        {picked ? <Check size={18} /> : <Plus size={18} />}
      </button>
    </div></div>
  );
}

const TOOL_NAMES: Record<string, string> = { claude_code: "Claude", codex: "Codex", gemini: "Antigravity", grok: "Grok", muse: "Muse Code" };
export function profileLine(config: ParticipantConfig): string {
  const backend = config.backend;
  const provider = backend.kind === "agent" ? TOOL_NAMES[backend.tool] ?? backend.tool : backend.kind === "open_ai_compatible" ? "API" : backend.kind;
  const model = backend.kind === "agent" ? backend.model : backend.kind === "open_ai_compatible" ? backend.model : null;
  return [provider, model, config.effort, config.speed === "fast" ? "Fast" : null].filter(Boolean).join(" · ");
}

export function NewChatBody(props: {
  machines: ChatMachineView[]; start: { hostId: string; picked: string[] } | null;
  /** The group last picked on a machine, applied once its bot list is in. */
  saved(hostId: string): string[];
  machineIcon(hostId: string, size?: number): ReactNode;
  loadProfiles(hostId: string): Promise<ChatProfile[]>;
  onStart(hostId: string, profiles: string[]): Promise<void>;
}) {
  const [hostId, setHostId] = useState<string | null>(props.start?.hostId ?? null);
  const [picked, setPicked] = useState<string[]>(props.start?.picked ?? []);
  // Until the person taps a bot, the picks follow the machine's list as it arrives.
  const [edited, setEdited] = useState(false);
  const [result, setResult] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  const profiles = useProfiles(hostId, props.loadProfiles);
  const machine = props.machines.find((item) => item.id === hostId) ?? null;
  // Once the list arrives: the saved group (or the first bot that can join) if nothing was tapped yet,
  // else the taps, minus any bot this machine says can't join.
  useEffect(() => {
    if (!profiles?.list || !hostId) return;
    const list = profiles.list;
    if (!edited) setPicked(startingBots(list, props.saved(hostId)));
    else setPicked((now) => now.filter((id) => list.some((item) => item.ok && item.profile.id === id)));
    // The saved group is read when the list arrives; a later tap is the person's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles?.list]);
  const choose = (id: string) => { if (id !== hostId) { setHostId(id); setPicked([]); setEdited(false); setResult({ busy: false, error: "" }); } };
  const ready = machine?.chats && machine.status === "online" && picked.length > 0 && !result.busy;
  return <>
    <div className="ph-section">Machine</div>
    <div className="ph-list">{props.machines.map((item) => (
      <button key={item.id} type="button" className="ph-srow" aria-pressed={item.id === hostId} disabled={!item.chats} onClick={() => choose(item.id)}>
        <span className="ph-srow-icon">{props.machineIcon(item.id, 18)}</span>
        <span className="ph-grow"><strong>{item.name}</strong><small>{item.chats ? <><Dot status={item.status} /> {statusWords(item)}</> : item.why}</small></span>
        {item.id === hostId && <Check size={18} />}
      </button>
    ))}</div>
    {machine && <>
      <div className="ph-section">Bots on {machine.name}</div>
      {profiles?.error && <p className="ph-sheet-text ph-red" role="alert">{profiles.error}</p>}
      {!profiles?.list && !profiles?.error && <p className="ph-sheet-text">Asking {machine.name} for its bots…</p>}
      {profiles?.list && profiles.list.length === 0 && <p className="ph-sheet-text">{machine.name} has no bots set up yet. Add one in Deck on that machine.</p>}
      {profiles?.list && <div className="ph-bot-list">{profiles.list.map((item) => (
        <ProfileRow key={item.profile.id} item={item} picked={picked.includes(item.profile.id)} onToggle={() => { setEdited(true); setPicked((now) => now.includes(item.profile.id) ? now.filter((id) => id !== item.profile.id) : [...now, item.profile.id]); }} />
      ))}</div>}
      <p className="ph-sheet-text ph-quiet"><Lock size={13} /> Talk only: bots in a chat can't see or change your files.</p>
    </>}
    {result.error && <p className="ph-sheet-text ph-red" role="alert">{result.error}</p>}
    <button type="button" className="primary ph-wide" disabled={!ready} onClick={() => {
      if (!hostId) return;
      setResult({ busy: true, error: "" });
      props.onStart(hostId, picked).catch((error) => setResult({ busy: false, error: words(error) }));
    }}>{result.busy ? "Starting…" : machine && machine.status !== "online" ? `${machine.name} isn't connected` : picked.length ? `Start with ${picked.length} ${picked.length === 1 ? "bot" : "bots"}` : "Pick at least one bot"}</button>
  </>;
}

// ---- Bots in a chat ----------------------------------------------------------------------------

export function ChatBotsBody(props: {
  machine: ChatMachineView; bots: ParticipantConfig[]; working: string[];
  /** Why this phone can't change bots on that machine, or "" when it can. */
  locked: string;
  loadProfiles(hostId: string): Promise<ChatProfile[]>;
  onOpen(botId: string): void; onAdd(profile: string): Promise<void>; onRemove(botId: string): Promise<void>;
}) {
  const profiles = useProfiles(props.machine.id, props.loadProfiles);
  const [state, setState] = useState<{ busy: string; error: string }>({ busy: "", error: "" });
  const online = props.machine.status === "online" && !props.locked;
  const run = (key: string, action: Promise<void>) => { setState({ busy: key, error: "" }); action.then(() => setState({ busy: "", error: "" }), (error) => setState({ busy: "", error: words(error) })); };
  const extra = (profiles?.list ?? []).filter((item) => !props.bots.some((bot) => bot.id === item.profile.id));
  return <>
    <div className="ph-bot-list">{props.bots.map((bot) => { const face = look(bot); return (
      <div className="ph-bot-entry" key={bot.id}><div className="ph-bot-row">
        <button type="button" className="ph-bot-info" onClick={() => props.onOpen(bot.id)}>
          <Avatar seed={face.seed} color={face.color} size="md" working={props.working.includes(bot.id)} />
          <span className="ph-bot-label"><strong>{bot.display_name}</strong><small>{profileLine(bot)} · Talk only</small></span>
        </button>
        <button type="button" className="ph-bot-action remove" aria-label={`Remove ${bot.display_name}`} disabled={!online || props.bots.length < 2 || state.busy !== ""} onClick={() => run(bot.id, props.onRemove(bot.id))}><span aria-hidden="true">−</span></button>
      </div></div>
    ); })}</div>
    {extra.length > 0 && <>
      <div className="ph-section">Add from {props.machine.name}</div>
      <div className="ph-bot-list">{extra.map((item) => (
        <ProfileRow key={item.profile.id} item={item} picked={false} onToggle={() => { if (online && !state.busy) run(item.profile.id, props.onAdd(item.profile.id)); }} />
      ))}</div>
    </>}
    {state.error && <p className="ph-sheet-text ph-red" role="alert">{state.error}</p>}
    {props.locked ? <p className="ph-sheet-text ph-amber">{props.locked}</p>
      : !online && <p className="ph-sheet-text ph-amber">{props.machine.name} isn't connected. Bots can change once it's back.</p>}
    <p className="ph-sheet-text ph-quiet">Bots are set up on each machine, so this list shows the ones on {props.machine.name}.</p>
  </>;
}

/** The locked Access row in a chat bot's sheet. */
export function TalkOnlyRow({ name, onMove }: { name: string; onMove?: () => void }) {
  return <>
    <div className="ph-section">Access</div>
    <p className="ph-sheet-text ph-quiet"><Lock size={13} /> Talk only: {name} can't see or change your files here.{onMove && <> <button type="button" className="ph-plain ph-inline" onClick={onMove}>Move to a Work thread</button> to give it access.</>}</p>
  </>;
}

// ---- Where this chat runs ----------------------------------------------------------------------

export function ChatWhereBody(props: {
  machines: ChatMachineView[]; current: string; machineIcon(hostId: string, size?: number): ReactNode;
  /** `pending` answers how to treat replies still running on the old machine, once asked. */
  onPick(hostId: string, pending?: "wait" | "stop"): Promise<void>;
}) {
  const [state, setState] = useState<{ busy: string; error: string; ask?: string }>({ busy: "", error: "" });
  const go = (hostId: string, pending?: "wait" | "stop") => {
    setState({ busy: hostId, error: "" });
    props.onPick(hostId, pending).then(() => setState({ busy: "", error: "" }), (error) => setState({ busy: "", error: words(error), ask: error instanceof Error && error.name === "ChatPendingAnswersError" ? hostId : undefined }));
  };
  return <>
    <p className="ph-sheet-text">The whole group moves with the chat. A bot that isn't set up on the new machine stays behind, and this phone tells you which.</p>
    <div className="ph-list">{props.machines.map((item) => (
      <button key={item.id} type="button" className="ph-srow" aria-pressed={item.id === props.current} disabled={!item.chats || state.busy !== ""} onClick={() => { if (item.id !== props.current) go(item.id); }}>
        <span className="ph-srow-icon">{props.machineIcon(item.id, 18)}</span>
        <span className="ph-grow"><strong>{item.name}</strong><small>{state.busy === item.id ? "Moving…" : item.chats ? <><Dot status={item.status} /> {statusWords(item)}</> : item.why}</small></span>
        {item.id === props.current && <Check size={18} />}
      </button>
    ))}</div>
    {state.error && <p className="ph-sheet-text ph-red" role="alert">{state.error}</p>}
    {state.ask && <>
      <button type="button" className="primary ph-wide" onClick={() => go(state.ask!, "wait")}>Wait for answers, then move</button>
      <button type="button" className="ph-wide" onClick={() => go(state.ask!, "stop")}>Stop them and move</button>
    </>}
  </>;
}

// ---- Move to a Work thread ---------------------------------------------------------------------

const ACCESS: { id: Access; text: string }[] = [{ id: "ask", text: "Ask first" }, { id: "read", text: "Read only" }, { id: "full", text: "Full" }];

export function MoveToWorkBody(props: {
  machine: ChatMachineView; bots: ParticipantConfig[];
  /** Why this machine can't take the move from a phone, or "" when it can. */
  blocked: string;
  /** A move sent earlier whose answer never came back. It can only be finished as it was, or started over. */
  unconfirmed: { cwd: string; access: Record<string, Access> } | null;
  listFolder(path: string | null): Promise<FolderListing>;
  onMove(cwd: string, access: Record<string, Access>): Promise<void>;
  onStartOver(): Promise<void>;
}) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [state, setState] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  const open = (path: string | null) => props.listFolder(path).then(setListing, (error) => setState({ busy: false, error: words(error) }));
  useEffect(() => { if (!props.blocked && props.machine.status === "online") void open(null); }, [props.blocked, props.machine.status]);
  const folder = listing?.path ?? "";
  const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
  if (props.blocked) return <p className="ph-sheet-text">{props.blocked}</p>;
  const left = props.unconfirmed;
  if (left) {
    const leftName = left.cwd.split(/[\\/]/).filter(Boolean).pop() ?? left.cwd;
    return <>
      <p className="ph-sheet-text">A move to <b>{leftName}</b> on {props.machine.name} was sent, but {props.machine.name} never confirmed it. Finish it with the same choices, so it can't make a second thread or change what the bots may do.</p>
      <p className="ph-path">{left.cwd}</p>
      <div className="ph-bot-list">{props.bots.map((bot) => { const face = look(bot); const level = left.access[bot.id] ?? "read"; return (
        <div className="ph-bot-entry" key={bot.id}><div className="ph-bot-row">
          <span className="ph-bot-info"><Avatar seed={face.seed} color={face.color} size="sm" /><span className="ph-bot-label"><strong>{bot.display_name}</strong><small>{ACCESS.find((choice) => choice.id === level)?.text ?? level}</small></span></span>
        </div></div>
      ); })}</div>
      {props.machine.status !== "online" && <p className="ph-sheet-text ph-amber">{props.machine.name} isn't connected. Finish the move once it's back.</p>}
      {state.error && <p className="ph-sheet-text ph-red" role="alert">{state.error}</p>}
      <button type="button" className="primary ph-wide" disabled={state.busy || props.machine.status !== "online"} onClick={() => {
        setState({ busy: true, error: "" });
        props.onMove(left.cwd, left.access).then(() => setState({ busy: false, error: "" }), (error) => setState({ busy: false, error: words(error) }));
      }}>{state.busy ? "Moving…" : `Finish the move to ${leftName}`}</button>
      <button type="button" className="ph-wide" disabled={state.busy || props.machine.status !== "online"} onClick={() => {
        setState({ busy: true, error: "" });
        props.onStartOver().then(() => setState({ busy: false, error: "" }), (error) => setState({ busy: false, error: words(error) }));
      }}>Start over</button>
    </>;
  }
  return <>
    <p className="ph-sheet-text">Pick a folder on <b>{props.machine.name}</b>. The Work thread starts with this chat's messages and the same bots. This chat keeps a link to it.</p>
    {props.machine.status !== "online" && <p className="ph-sheet-text ph-amber">{props.machine.name} isn't connected. Folders show once it's back.</p>}
    {listing && <p className="ph-path">{listing.path}</p>}
    {listing && <div className="ph-list">
      {listing.parent !== null && <button type="button" className="ph-srow" onClick={() => { void open(listing.parent); }}><span className="ph-srow-icon"><ArrowLeft size={18} /></span><span className="ph-grow"><strong>Up</strong></span></button>}
      {listing.folders.map((child) => (
        <button key={child} type="button" className="ph-srow" onClick={() => { void open(`${listing.path.replace(/[\\/]$/, "")}/${child}`); }}>
          <span className="ph-srow-icon"><Folder size={18} /></span><span className="ph-grow"><strong>{child}</strong></span><ChevronRight size={16} />
        </button>
      ))}
    </div>}
    <div className="ph-section">What each bot may do in the folder</div>
    <div className="ph-bot-list">{props.bots.map((bot) => { const face = look(bot); return (
      <div className="ph-bot-entry" key={bot.id}><div className="ph-bot-row">
        <span className="ph-bot-info"><Avatar seed={face.seed} color={face.color} size="sm" /><span className="ph-bot-label"><strong>{bot.display_name}</strong></span></span>
        <div className="ph-segment ph-seg-sm" role="radiogroup" aria-label={`${bot.display_name} access`}>{ACCESS.map((choice) => (
          <button key={choice.id} type="button" role="radio" aria-checked={(access[bot.id] ?? "ask") === choice.id} onClick={() => setAccess((now) => ({ ...now, [bot.id]: choice.id }))}>{choice.text}</button>
        ))}</div>
      </div></div>
    ); })}</div>
    {state.error && <p className="ph-sheet-text ph-red" role="alert">{state.error}</p>}
    <button type="button" className="primary ph-wide" disabled={!listing || state.busy || props.machine.status !== "online"} onClick={() => {
      setState({ busy: true, error: "" });
      // Every bot is named, so a bot left on the default still gets the access shown beside it.
      const chosen = Object.fromEntries(props.bots.map((bot) => [bot.id, access[bot.id] ?? "ask"]));
      props.onMove(folder, chosen).then(() => setState({ busy: false, error: "" }), (error) => setState({ busy: false, error: words(error) }));
    }}>{state.busy ? "Moving…" : listing ? `Move to ${name}` : "Pick a folder"}</button>
  </>;
}

// ---- The old Local chat's history --------------------------------------------------------------

export function LegacyImportBody(props: {
  chats: LegacyChat[]; machines: ChatMachineView[]; machineIcon(hostId: string, size?: number): ReactNode;
  onCopy(hostId: string): Promise<void>; onLater(): void; onDiscard(): void;
}) {
  const able = props.machines.filter((item) => item.chats && item.status === "online");
  const [hostId, setHostId] = useState<string | null>(able[0]?.id ?? null);
  const [state, setState] = useState<{ busy: boolean; error: string; confirm: boolean }>({ busy: false, error: "", confirm: false });
  const count = props.chats.length;
  return <>
    <p className="ph-sheet-text">This phone still has {count === 1 ? "a conversation" : `${count} conversations`} from the old Local chat screen with real replies in {count === 1 ? "it" : "them"}. Copy {count === 1 ? "it" : "them"} into Chats on a machine to keep {count === 1 ? "it" : "them"}. The bots don't answer the old messages again.</p>
    <ul className="ph-sheet-text">{props.chats.map((chat) => <li key={chat.id}>{chat.title} · {chat.messages.length} messages</li>)}</ul>
    {able.length === 0 && <p className="ph-sheet-text ph-amber">No machine that can hold chats is connected right now. Nothing is lost: this phone asks again next time.</p>}
    <div className="ph-list">{able.map((item) => (
      <button key={item.id} type="button" className="ph-srow" aria-pressed={item.id === hostId} onClick={() => setHostId(item.id)}>
        <span className="ph-srow-icon">{props.machineIcon(item.id, 18)}</span><span className="ph-grow"><strong>{item.name}</strong></span>{item.id === hostId && <Check size={18} />}
      </button>
    ))}</div>
    {state.error && <p className="ph-sheet-text ph-red" role="alert">{state.error}</p>}
    <button type="button" className="primary ph-wide" disabled={!hostId || state.busy} onClick={() => {
      if (!hostId) return;
      setState({ busy: true, error: "", confirm: false });
      props.onCopy(hostId).catch((error) => setState({ busy: false, error: words(error), confirm: false }));
    }}>{state.busy ? "Copying…" : "Copy into Chats"}</button>
    <button type="button" className="ph-wide" onClick={props.onLater}>Not now</button>
    {state.confirm
      ? <button type="button" className="ph-wide ph-red" onClick={props.onDiscard}>Delete the old conversations for good</button>
      : <button type="button" className="ph-plain ph-wide" onClick={() => setState((now) => ({ ...now, confirm: true }))}>Discard old chat…</button>}
  </>;
}
