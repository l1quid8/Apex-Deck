// These shapes mirror the Rust types in crates/apex-core. The test file
// crates/apex-core/tests/wire_format.rs pins the JSON on the Rust side.

/** "ask" lets a bot edit and run commands, but only after you approve each one. */
export type Access = "read" | "ask" | "edits" | "full";

/** Something a bot wants to do and is waiting for a yes or no on. */
export interface ProposedAction {
  kind: "edit" | "command" | "other";
  /** One line, such as "Edit src/main.rs". */
  title: string;
  /** The diff, the command, or the tool's arguments. */
  detail: string;
}

/** An edit a bot made to a file. */
export interface FileChange {
  path: string;
  /** Lines starting with + were added and lines starting with - removed. Empty if not reported. */
  diff: string;
  added: number;
  removed: number;
}

export type AgentTool = "claude_code" | "codex" | "gemini";

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
  appearance?: { seed: string; color: string } | null;
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
}

export interface Compaction {
  summary: string;
  upto: number;
}

export type AppSection = "agents" | "code" | "threads";

export interface AppSession {
  version: 1;
  workspaces: Workspace[];
  /** Saved chats only; processes are started explicitly in Code. */
  panes: Pane[];
  profiles: ParticipantConfig[];
  disabledProviders?: string[];
  activeWorkspace: string | null;
  focusedPane: string | null;
  section: AppSection;
  /** The last ready-made layout chosen. Kept for files saved by older versions. */
  layout: Layout;
  /** How the threads of each workspace are arranged, by "workspace:section".
   *  Each value is a tree from layout.ts and is checked when it is read. */
  layouts?: Record<string, unknown>;
}

export type Speaker = { kind: "human" } | { kind: "bot"; id: string };

export interface Message {
  seq: number;
  speaker: Speaker;
  text: string;
}

export type RoomEvent =
  | { type: "message_added"; message: Message }
  | { type: "turn_started"; id: string }
  | { type: "delta"; id: string; text: string }
  /** What a participant is doing mid-turn, such as reading a file. */
  | { type: "activity"; id: string; text: string }
  /** A bot wants to do something. Its turn waits for `roomDecide` with this `request`. */
  | { type: "approval_requested"; id: string; request: string; action: ProposedAction }
  | { type: "approval_resolved"; id: string; request: string; approved: boolean }
  /** A bot changed a file. */
  | { type: "changed"; id: string; change: FileChange }
  /** Tokens a finished turn used, when the backend reports them. */
  | { type: "usage"; id: string; input_tokens: number | null; output_tokens: number | null }
  /** How full a participant's context window was on its latest request. */
  | { type: "context_usage"; id: string; used_tokens: number; window_tokens: number }
  /** How much of a provider account's plan is used. With `partial`, windows not listed keep their last value. */
  | { type: "plan_usage"; provider: AgentTool; windows: PlanWindow[]; partial: boolean }
  | { type: "passed"; id: string }
  | { type: "failed"; id: string; error: string }
  | { type: "hop_limit_reached"; limit: number }
  /** The models now see `summary` in place of the first `upto` messages. */
  | { type: "compacted"; id: string; summary: string; upto: number }
  | { type: "stopped" }
  | { type: "idle" };

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

export type PaneKind = "terminal" | "chat";

export interface Pane {
  id: string;
  workspaceId: string;
  kind: PaneKind;
  title: string;
  /** Agent key for terminal panes; undefined means a plain shell. */
  agent?: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Folder on disk. Empty in the browser demo. */
  path: string;
}

export type Layout = "top" | "left";

/** What a pane's dot shows. The last three ask for attention; see attention.ts. */
export type PaneStatus = "working" | "idle" | "exited" | "needs_input" | "failed" | "done";
