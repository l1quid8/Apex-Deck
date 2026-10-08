export interface ToolServer { token: string; label: string; aliases: string[] }
// These shapes mirror the Rust types in crates/apex-core. The test file
// crates/apex-core/tests/wire_format.rs pins the JSON on the Rust side.

/** "ask" lets a bot edit and run commands, but only after you approve each one. */
export type Access = "read" | "ask" | "edits" | "full";

/** Something a bot wants to do and is waiting for a yes or no on. */
export interface ProposedAction {
  kind: "edit" | "command" | "tool" | "other" | "plan";
  /** One line, such as "Edit src/main.rs". */
  title: string;
  /** The diff, the command, or the tool's arguments. */
  detail: string;
  /** When Codex's hook denies it if nobody answers, in milliseconds since the epoch. Only MCP calls checked by Deck's hook have one. */
  expires_at?: number | null;
  /** It can spend money or publish. Missing means no. */
  risky?: boolean;
}

/** An edit a bot made to a file. */
export interface FileChange {
  path: string;
  /** Lines starting with + were added and lines starting with - removed. Empty if not reported. */
  diff: string;
  added: number;
  removed: number;
}

export type AgentTool = "claude_code" | "codex" | "gemini" | "grok";

export type ParticipantBackend =
  | { kind: "open_ai_compatible"; base_url: string; model: string; api_key_env: string | null }
  | { kind: "agent"; tool: AgentTool; model: string | null }
  | { kind: "cli"; program: string; args: string[] }
  | { kind: "scripted"; lines: string[] };

export interface ParticipantConfig {
  id: string;
  display_name: string;
  backend: ParticipantBackend;
  persona: string;
  access: Access;
  /** How hard the model should think, in the backend's own words. Null leaves its default. */
  effort: string | null;
  /** Auto keeps effort as the fallback; recommendations are log-only during the trial. */
  auto_effort?: boolean;
  appearance?: { seed: string; color: string } | null;
  /** Choices for a bot whose model makes pictures or videos (see media.ts). */
  media?: MediaSettings | null;
}

/** What an image or video bot makes. Unset choices use the defaults in media.ts. */
export interface MediaSettings {
  aspect_ratio?: string | null;
  resolution?: string | null;
  quality?: string | null;
  /** Video length such as "5s". */
  duration?: string | null;
  audio?: boolean | null;
  /** Send the last description with each new message. On when unset. */
  build_on_last?: boolean | null;
}

/** What a provider's image or video model takes and costs. Empty lists = not offered. */
export interface MediaSpec {
  aspect_ratios?: string[];
  default_aspect_ratio?: string | null;
  resolutions?: string[];
  default_resolution?: string | null;
  qualities?: string[];
  default_quality?: string | null;
  durations?: string[];
  audio?: boolean;
  audio_configurable?: boolean;
  prompt_limit?: number | null;
  /** Pictures: US dollars each when one price fits every setting. */
  price?: number | null;
  /** Pictures: US dollars each by "1K" or "1K/low" (resolution/quality). */
  prices?: Record<string, number>;
  /** Pictures: the model that edits an attached picture, and its price. */
  edit_model?: string | null;
  edit_price?: number | null;
  /** Video: the sibling that animates an attached picture. */
  image_model?: string | null;
  /** Video: only animates a picture, so one must be attached. */
  needs_image?: boolean;
}

/** A model a tool offers, for the model picker. */
export interface ModelChoice {
  /** The name passed to the tool, exactly as it expects it. */
  id: string;
  /** A friendlier name shown next to the id. */
  label?: string | null;
  /** Effort levels the model accepts. Missing means not known; empty means it has no effort setting. */
  efforts?: string[] | null;
  /** Something worth knowing before picking it. Only set by the built-in list. */
  note?: string;
}

/** A model an OpenAI-compatible server offers. Older servers only send the id. */
export interface ApiModel {
  id: string;
  label?: string | null;
  /** Levels the model accepts. Missing = not known; empty = no reasoning setting. */
  efforts?: string[] | null;
  /** The level the server uses when none is sent. */
  default_effort?: string | null;
  context_tokens?: number | null;
  /** US dollars per million tokens. */
  price_in?: number | null;
  price_cached_in?: number | null;
  price_out?: number | null;
  /** What the model makes. Missing = text. */
  kind?: "text" | "image" | "video";
  media?: MediaSpec | null;
}

export type TurnPolicy = "mention" | "everyone" | "round_robin";

export interface RoomOptions {
  policy: TurnPolicy;
  max_bot_hops: number;
}

export interface ChangeRecord {
  by: string;
  path: string;
  added: number;
  removed: number;
  seq: number;
}
export interface DiffFile { path: string; added: number; removed: number; patch: string; by: string[] }
export interface RevertFile { path: string; delete: boolean; conflict: boolean }
export interface SideEffect { seq: number; by: string; command: string }
/** What going back to a message would do to the folder. */
export interface RevertPlan { available: boolean; note: string | null; files: RevertFile[]; skipped: string[]; effects: SideEffect[] }
export interface ThreadDiff { files: DiffFile[]; note: string | null }
export interface RoomSnapshot {
  changes?: ChangeRecord[];
  baseline?: string | null;
  /** Facts every model sees on every turn; kept by /clear and /compact. */
  pins?: string[];
  participants: ParticipantConfig[];
  options: RoomOptions;
  transcript: Message[];
  /** The summary the models see in place of the first `upto` messages, after `/compact`. */
  compaction?: Compaction | null;
  /** What the person chose "Always allow" for. */
  allowed?: AllowedRule[];
  /** Tokens each bot has used in this thread. /clear keeps them; a fork starts without them. */
  usage?: Record<string, TokenTotals>;
  /** The thread's Plan switch: every bot plans and changes nothing. */
  plan?: boolean;
}

/** Something a bot may do without asking, because the person chose "Always allow". */
export interface AllowedRule {
  /** The bot it applies to. */
  by: string;
  kind: ProposedAction["kind"];
  /** The card's title when it was allowed. */
  title: string;
  /** What it covers: a tool's title, a command, a file's edit title, or a permission question. */
  what: string;
  /** When it was allowed, in Unix seconds. 0 or missing for rules saved before Deck recorded it. */
  allowed_at?: number;
  /** The card it came from could spend money or publish. */
  risky?: boolean;
}

/** Tokens a bot has used in one thread, over the turns that reported a count. */
export interface TokenTotals {
  input: number;
  output: number;
  turns: number;
  /** What those turns cost in millionths of a US dollar, when the provider says. */
  cost_micros?: number;
}

export interface Compaction {
  summary: string;
  upto: number;
}

export type AppSection = "agents" | "code" | "threads" | "library";
export interface RoomState {
  recovery_seq?: number;
  snapshot: RoomSnapshot;
  active: string[];
  approvals: { id: string; request: string; action: ProposedAction }[];
  questions?: { id: string; request: string; questions: Question[] }[];
  next_steps?: { id: string; steps: NextStep[]; pending: boolean } | null;
  plan?: boolean;
  live?: boolean;
}

export interface AppSession {
  version: 1;
  importedHostSessions?: string[];
  canvasVersion?: 1;
  workspaces: Workspace[];
  /** Saved threads, and each terminal as a descriptor (id, workspace, name,
   *  tool). Terminals come back Stopped: nothing is started on launch. */
  panes: Pane[];
  profiles: ParticipantConfig[];
  disabledProviders?: string[];
  activeWorkspace: string | null;
  focusedPane: string | null;
  section: AppSection;
  /** The last ready-made layout chosen. Kept for files saved by older versions. */
  layout: Layout;
  /** How the panes of each workspace are arranged in Threads and in Code, by
   *  "workspace:section". Each value is a tree from layout.ts and is checked
   *  when it is read; panes that didn't load are taken out. */
  layouts?: Record<string, unknown>;
  threadDetailsOpen?: boolean;
  threadDetailsCollapsed?: Partial<Record<import("./detailsLayout").DetailsSection, boolean>>;
  /** Which client saved this copy: the Mac app's "<tag>:<count>", or "phone". */
  savedBy?: string;
}

export type Speaker = { kind: "human" } | { kind: "bot"; id: string };

export interface Message {
  servers?: string[];
  seq: number;
  speaker: Speaker;
  text: string;
  /** When it was added, in ms since the epoch. Older saved messages have none. */
  at?: number;
}

export interface QuestionOption { label: string; description?: string }
export interface Question { header: string; question: string; options: QuestionOption[]; multi_select: boolean }
export interface NextStep { label: string; prompt: string }
export type QuestionEnd = "answered" | "skipped" | "dropped";

export type RoomEvent = { recovery_seq?: number } & (
  | { type: "participant_changed"; participant: ParticipantConfig }
  | { type: "participants_changed"; participants: ParticipantConfig[] }
  | { type: "message_added"; message: Message }
  | { type: "turn_started"; id: string }
  | { type: "participant_idle"; id: string }
  | { type: "editor_changed"; id: string | null }
  | { type: "tool_servers"; id: string; servers: ToolServer[] }
  | { type: "delta"; id: string; text: string }
  /** What a participant is doing mid-turn, such as reading a file. */
  | { type: "activity"; id: string; text: string }
  /** A bot wants to do something. Its turn waits for `roomDecide` with this `request`. */
  | { type: "approval_requested"; id: string; request: string; action: ProposedAction }
  | { type: "approval_resolved"; id: string; request: string; approved: boolean }
  /** A bot asked the person something. Its turn waits for `roomAnswer` with this `request`. */
  | { type: "question_requested"; id: string; request: string; questions: Question[] }
  | { type: "question_resolved"; id: string; request: string; end: QuestionEnd; answers: string[][] }
  /** Suggested next prompts after `id`'s reply; `pending` while worked out; empty and settled clears them. */
  | { type: "next_steps"; id: string; steps: NextStep[]; pending: boolean }
  /** The thread's Plan switch was turned on or off. */
  | { type: "plan_changed"; on: boolean }
  /** The thread's whole "Always allow" list, after it changed. */
  | { type: "allowed_changed"; allowed: AllowedRule[] }
  /** A bot changed a file. */
  | { type: "changed"; id: string; change: FileChange }
  /** Tokens a finished turn used, when the backend reports them. */
  | { type: "usage"; id: string; input_tokens: number | null; output_tokens: number | null; cost_micros?: number | null }
  /** How full a participant's context window was on its latest request. */
  | { type: "context_usage"; id: string; used_tokens: number; window_tokens: number }
  /** How much of a provider account's plan is used. With `partial`, windows not listed keep their last value. */
  | { type: "plan_usage"; provider: AgentTool; windows: PlanWindow[]; partial: boolean }
  | { type: "passed"; id: string }
  | { type: "failed"; id: string; error: string }
  /** The room cut off bots answering each other; `next` is who the last replies asked. */
  | { type: "hop_limit_reached"; limit: number; next: string[] }
  /** The models now see `summary` in place of the first `upto` messages. */
  | { type: "compacted"; id: string; summary: string; upto: number }
  | { type: "stopped" }
  | { type: "idle" });

/** One rate-limit window of a provider plan. */
export interface PlanWindow {
  /** The tool's own name, such as "five_hour" or "primary". */
  name: string;
  /** 0 to 100. */
  used_percent: number;
  window_minutes: number | null;
  /** Unix seconds. */
  resets_at: number | null;
}

export interface AgentInfo {
  key: string;
  label: string;
  program: string;
  found: boolean;
}

export type PaneKind = "terminal" | "chat" | "preview";

/** What the desktop side found at a Preview address before loading it. */
export type PreviewProbe = { kind: "ok" } | { kind: "refused" } | { kind: "unreachable"; reason: string };

/** What is in one folder on the host (apex-host's `folders::Folder`). */
export interface FolderListing {
  path: string;
  /** Null at the top. */
  parent: string | null;
  folders: string[];
  files: string[];
  /** The folder held more than the host sends, and the rest were left out. */
  truncated: boolean;
}

export interface Pane {
  id: string;
  workspaceId: string;
  kind: PaneKind;
  title: string;
  /** Agent key for terminal panes; undefined means a plain shell. */
  agent?: string;
  /** A Preview pane's address; "" before one is chosen. */
  url?: string;
  /** The terminal or thread whose server a Preview shows, when it was opened from one. */
  servedBy?: string;
  /** The deck a Preview is on. Missing means Code. */
  deck?: "code" | "threads";
  /** A thread taken off the deck. It stays saved and listed in the rail. */
  closed?: boolean;
  /** Kept at the top of its sidebar list. Does not change order on the deck. */
  pinned?: boolean;
  /** A sample thread: its room starts with scripted bots. */
  sample?: boolean;
  /** The seq of the newest message you saw at the bottom of this thread, or
   *  -1 after /clear. Missing in sessions saved before it existed: no divider. */
  lastSeenSeq?: number;
  /** A thread put away: closed, and listed only under Archived. */
  archived?: true;
  /** Marked unread; cleared when the thread is opened. */
  unread?: true;
  /** When its newest message arrived, in ms since the epoch, for Recents. */
  activeAt?: number;
  /** A fork: the thread it came from, on which machine, and how many messages it copied.
   *  `crossed` when the history came from another machine, whose attachments stayed there. */
  fork?: { from: string; title: string; host: string; at: number; crossed?: true };
}

/** What a thread reports to App through ChatPane's `onStatus`. */
export interface ThreadStatus {
  /** The muted words in the pane head when no flag shows, e.g. "2 bots · replying". */
  text: string;
  /** Display names of bots producing a reply right now (not counting ones stopped on a card). */
  replying: string[];
  /** Display names of bots stopped on an open approval card. */
  waiting: string[];
  /** Display names of every bot in the thread, for its hover card. */
  who?: string[];
  /** A bot has replied at least once, so Copy last reply has something to copy. */
  hasReply?: boolean;
  /** When the newest message arrived, in ms since the epoch. */
  lastAt?: number;
  /** A message was sent since the thread was made or forked: it stays where it runs. */
  started?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  /** Folder on disk. Empty in the browser demo. */
  path: string;
  /** A workspace removed from the list. Missing means `false`. Its threads stay saved. */
  hidden?: boolean;
  /** Saved host ID; absent means This Mac. */
  hostId?: string;
  /** Project copies share a family; defaults to the folder basename. */
  family?: string;
  /** Kept at the top of the sidebar's Projects. */
  pinned?: true;
  /** Its threads are folded away in the sidebar. */
  collapsed?: true;
}

export type Layout = "top" | "left";

/** What a pane's dot shows. The last three ask for attention; see attention.ts. */
export type PaneStatus = "working" | "idle" | "exited" | "needs_input" | "failed" | "done";
