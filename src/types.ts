import type * as Wire from "./generated/protocol.ts";
import type { NextStep, ProposedAction, TodoItem } from "./generated/protocol.ts";
export type {
  Access, AgentTool, ChangeRecord, Compaction, FileChange, Geometry as PhoneGeometry, Key as PhoneKey,
  MediaSettings, NextStep, PlanRunState, PlanRunStep, PlanStepState, ProposedAction, QuestionEnd,
  QuestionOption, Speaker, Speed, StepKind, StepStatus, TodoItem, TodoStatus, ToolServer, TurnPolicy,
} from "./generated/protocol.ts";

/** The renderer uses deserialized defaults on these response objects. Request fields can be omitted. */
type RequiredFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
type OmitNull<T> = { [K in keyof T]: Exclude<T[K], null> };
export type ParticipantBackend = Required<Wire.Backend>;
export type ChatBotRequest = Wire.ChatBotRequest & { id?: string; display_name?: string };
export type ParticipantConfig = RequiredFields<Wire.ParticipantConfig, "persona" | "access" | "effort"> & { backend: ParticipantBackend };

/** A name and persona an AI wrote for a new agent from a short description (persona_draft). Nothing is saved until the person saves the form. */
export interface PersonaDraftResult {
  name: string;
  persona: string;
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
  image_input?: boolean | null;
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

/** Public benchmark scores for one bot's model, from the daemon's daily Epoch AI download. */
export interface ModelMetrics {
  /** Epoch's name for the model, such as "Claude Opus 5.5". */
  name: string;
  /** One row per reasoning level the bot offers, or a single "default" row. */
  rows: LevelRow[];
  current: string | null;
  /** Test id → the score on its pill. */
  pills: Record<string, PillValue>;
  /** Test id → top score across levels; only for tests run at two or more levels. */
  best: Record<string, number>;
  /** Test id, or "eci", → the best score today across every model Epoch lists. */
  top: Record<string, { value: number; model: string }>;
  /** Epoch Capabilities Index, one per model. */
  eci: number | null;
  /** US dollars per million tokens, input and output. */
  price: [number, number] | null;
  /** The scores are for the public model; this bot runs a local copy. */
  local_note: boolean;
  /** Unix seconds; 0 = never downloaded. */
  fetched_at: number;
  last_error: string | null;
}

export type LevelState = "measured" | "not_measured";

export interface LevelRow {
  effort: string;
  state: LevelState;
  /** Test id → score from 0 to 100, only for tests run at this level. */
  scores: Record<string, number>;
}

/** A pill's score and the level it was measured at, which can differ from the bot's own. */
export interface PillValue {
  value: number;
  from_level: string;
}

export type RoomOptions = Required<Wire.RoomOptions>;

export interface DiffFile { path: string; added: number; removed: number; patch: string; by: string[] }
export interface RevertFile { path: string; delete: boolean; conflict: boolean }
export interface SideEffect { seq: number; by: string; command: string }
/** What going back to a message would do to the folder. */
export interface RevertPlan { available: boolean; note: string | null; files: RevertFile[]; skipped: string[]; effects: SideEffect[] }
export interface ThreadDiff { files: DiffFile[]; note: string | null }
export type RoomSnapshot = Omit<Wire.RoomSnapshot, "participants" | "options" | "transcript" | "clientMessages" | "curations" | "plan_runs" | "allowed" | "usage"> & {
  participants: ParticipantConfig[];
  options: RoomOptions;
  transcript: Message[];
  clientMessages?: Record<string, RequiredFields<OmitNull<Wire.ClientMessageRecord>, "replySeqs">>;
  curations?: Curation[];
  plan_runs?: PlanRun[];
  allowed?: AllowedRule[];
  usage?: Record<string, TokenTotals>;
};
export type AllowedRule = OmitNull<Wire.AllowedRule>;
export type TokenTotals = OmitNull<Wire.TokenTotals>;
export type Curation = OmitNull<Wire.Curation>;

export interface CurationUndo { restored: number; sealed: number }
export type CurateReply = { by: string; unchecked?: number } & (
  | { status: "hidden"; count: number }
  | { status: "nothing" }
  | { status: "stopped" }
);

export type AppSection = "agents" | "code" | "threads" | "library";
export interface RoomState {
  /** Host checkpoint of in-flight and interrupted structured turn progress. */
  progress?: Record<string, ReplySteps>;
  streams?: Record<string, string>;
  activity?: Record<string, string>;
  /** Effective responders from the same checkpoint as snapshot. */
  untagged_responders?: string[];
  roomRevision?: number;
  hostNow?: number;
  /** From the protected room manifest; editable transcript files cannot set this. */
  legacy?: import("./legacyImport").LegacyMarker | null;
  cwd?: string | null;
  mounts?: import("./worktreeMount").MountBoundary[];
  recovery_seq?: number;
  snapshot: RoomSnapshot;
  active: string[];
  approvals: { id: string; request: string; action: ProposedAction }[];
  questions?: { id: string; request: string; questions: Question[] }[];
  next_steps?: { id: string; steps: NextStep[]; pending: boolean } | null;
  plan?: boolean;
  live?: boolean;
  runner?: import("./runner/types.ts").RunnerSnapshot | null;
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
  /** Host-issued revision for saved agents shared with CLI clients. */
  profileRevision?: number;
  /** Author of the accepted profile revision, independent of layout saves. */
  profileSavedBy?: string;
  disabledProviders?: string[];
  activeWorkspace: string | null;
  focusedPane: string | null;
  section: AppSection;
  /** The last ready-made layout chosen. Kept for files saved by older versions. */
  layout?: "top" | "left";
  /** How the panes of each workspace are arranged in Threads and in Code, by
   *  "workspace:section". Each value is a tree from layout.ts and is checked
   *  when it is read; panes that didn't load are taken out. */
  layouts?: Record<string, unknown>;
  /** Computed pane layouts, order and zoom, saved by "workspace:section". */
  arrangements?: Record<string, unknown>;
  threadDetailsOpen?: boolean;
  rightPanel?: import("./rightPanelModel").RightPanelState;
  threadDetailsCollapsed?: Partial<Record<import("./detailsLayout").DetailsSection, boolean>>;
  /** Which client saved this copy: the Mac app's "<tag>:<count>", or "phone". */
  savedBy?: string;
  /** Saved server id -> the daemon id that answers there. Written by the Mac
   *  for the phone (hostSession.ts macHostIds). */
  hostIds?: Record<string, string>;
}

export type Message = OmitNull<Wire.Message>;
export type Question = Required<Wire.Question>;
export type PlanRun = Required<Wire.PlanRun>;

/** These event payloads carry populated response fields or recursively annotated events. */
type RendererEvent =
  | { type: "voice_event"; client_turn_id: string; id: string; event: RoomEvent }
  | { type: "participant_changed"; participant: ParticipantConfig }
  | { type: "participants_changed"; participants: ParticipantConfig[] }
  | { type: "message_added"; message: Message }
  | { type: "work_step"; id: string; step: WorkStep }
  | { type: "question_requested"; id: string; request: string; questions: Question[] }
  | { type: "plan_run"; run: PlanRun }
  | { type: "plan_runs_reset"; runs: PlanRun[] }
  | { type: "allowed_changed"; allowed: AllowedRule[] }
  | { type: "curations_changed"; curations: Curation[] }
  | (Omit<Extract<Wire.RoomEvent, { type: "plan_usage" }>, "windows" | "reset_credits"> & { windows: PlanWindow[]; reset_credits?: ResetCredits })
  | Required<Extract<Wire.RoomEvent, { type: "editor_changed" | "question_resolved" | "next_steps" | "hop_limit_reached" }>>
  | RequiredFields<Extract<Wire.RoomEvent, { type: "usage" }>, "input_tokens" | "output_tokens">;

export type RoomEvent = { recovery_seq?: number } & (RendererEvent | Exclude<Wire.RoomEvent, { type: RendererEvent["type"] }>);

export type PlanWindow = Required<Wire.PlanWindow>;
export type ResetCredit = OmitNull<Wire.ResetCredit>;
export type ResetCredits = Omit<Wire.ResetCredits, "credits"> & { credits: ResetCredit[] };

export interface AgentInfo {
  key: string;
  label: string;
  program: string;
  found: boolean;
  /** Native executable for isolated assistant replies, independently of Threads' preference. */
  assistantProgram?: string;
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

export type FilePreview =
  | { kind: "text"; text: string; size: number; truncated: boolean; version: string; editable?: boolean }
  | { kind: "image"; mime: string; data: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too_large"; size: number };

export interface FileSearchHit { path: string; line: number; text: string }
export interface FileSearchResult { hits: FileSearchHit[]; truncated: boolean }

export interface Worktree { path: string; head: string | null; branch: string | null; main: boolean; locked: boolean; prunable: boolean; changes: number | null; task: boolean; copy?: { bot: string; thread: string; threadTitle: string; state: "working" | "folding" | "reconciling" | "needs_you" | "folded"; reason?: string | null } | null }
export interface WorktreeList { root: string; items: Worktree[]; checkCommand?: string | null }
export interface WorktreeAdd { branch: string; newBranch: boolean; base: string | null; folder: string | null }

export interface Pane {
  /** Last explicit metadata revision read from this pane's owning host. */
  hostMetadataRevision?: number;
  /** Keep a local rename visible until the owning host confirms it. */
  hostTitlePending?: string;
  hostArchivePending?: boolean;
  /** A worker destination created for a named assistant; only opt-in lists it. */
  assistantDraftFor?: {hostId:string;assistantId:string};
  /** This chat is mounted in another checkout of its project. */
  mount?: string;
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
  /** Includes queued work and waits, not only visible streaming replies. */
  busy?: boolean;
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
  /** Revision of the owning host's durable project name/removal record. */
  hostProjectRevision?: number;
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
  /** Pin action moves it to the top of its host's projects. */
  pinned?: true;
  /** Manual position within its host. Missing keeps the legacy pinned/insertion order. */
  sidebarOrder?: number;
  /** Its threads are folded away in the sidebar. */
  collapsed?: true;
}

export type Layout = "top" | "left";

/** What a pane's dot shows. The last three ask for attention; see attention.ts. */
export type PaneStatus = "working" | "idle" | "exited" | "needs_input" | "failed" | "done";

/** Mirrors crates/apex-core/src/work_steps.rs. */

export type WorkStep = RequiredFields<Wire.WorkStep, "parent" | "folder" | "output" | "exit_code" | "duration_ms">;

/** Everything recorded about the work behind one reply. */
export type TurnTimelineEntry = { kind: "text"; text: string } | { kind: "activity"; keys: string[] };
export type TurnOutcome = "failed" | "stopped" | "passed";
export interface ReplySteps { by: string; seq: number; steps: WorkStep[]; todo: TodoItem[]; dropped: number; timeline?: TurnTimelineEntry[]; timeline_cut?: boolean; outcome?: TurnOutcome }

/** One reply's place in a thread's steps file. */
export interface StepsIndexEntry { by: string; count: number; helpers: number; offset: number; len: number; todo_count?: number; todo_completed?: number }

/** The replies a thread has saved steps for; keys are reply seq numbers as strings. */
export interface StepsIndex { version: number; replies: Record<string, StepsIndexEntry> }
/** Who has the shared simulated iPhone. */
export type PhoneHolder = { kind: "free" } | { kind: "human"; secondsLeft: number } | { kind: "bot"; name: string };
export interface PhoneDevice { runtime: string; deviceType: string; model: string; version: string }
export type PhoneControl = Exclude<Wire.Control, { kind: "volume" | "location" }>
  | (Extract<Wire.Control, { kind: "volume" }> & { direction: "up" | "down" })
  | Required<Extract<Wire.Control, { kind: "location" }>>;
export interface PhoneControlReply { status: PhoneStatus; message: string; path: string | null }
export interface PhoneStatus { orientation?: number | null; pixelWidth?: number; pixelHeight?: number; pointWidth?: number; pointHeight?: number; transitioning?: boolean; inputReady?: boolean; geometry?: Wire.Geometry; displays?: number; model?: string | null; runtime?: string | null; appearance?: string | null; textSize?: string | null; contrast?: boolean | null; recording?: string | null; lastCapture?: string | null; on: boolean; starting: boolean; device: string | null; udid: string | null; holder: PhoneHolder; width: number; height: number; problem: string | null }
/** One picture of the phone's screen: a base64 JPEG. */
export interface PhoneFrame { seq: number; image: string; width: number; height: number }
export interface PhoneView { status: PhoneStatus; frame: PhoneFrame | null }
export type PhoneInput = Required<Wire.Input>;

export type { MainView, AssistantSection } from "./assistantWorkspaceModel";
