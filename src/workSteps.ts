import type { ReplySteps, RoomEvent, StepsIndex, StepsIndexEntry, TodoItem, WorkStep } from "./types.ts";

/** One bot's work so far in a turn. `structured` turns true on the first work_step event. */
export interface TurnSteps { steps: WorkStep[]; todo: TodoItem[]; structured: boolean }

export const emptyTurnSteps: TurnSteps = { steps: [], todo: [], structured: false };

const sameStep = (a: WorkStep, b: WorkStep) =>
  (Object.keys(a) as (keyof WorkStep)[]).length === (Object.keys(b) as (keyof WorkStep)[]).length &&
  (Object.keys(a) as (keyof WorkStep)[]).every((k) => a[k] === b[k]);

const sameTodo = (a: readonly TodoItem[], b: readonly TodoItem[]) =>
  a.length === b.length && a.every((item, i) => item.text === b[i].text && item.status === b[i].status);

/** Upsert by key; `todo` replaces. `structured` turns true on the first work_step. Same object back when nothing changes. */
export function applyStepEvent(turn: TurnSteps, event: RoomEvent): TurnSteps {
  if (event.type === "todo") {
    return sameTodo(turn.todo, event.items) ? turn : { ...turn, todo: event.items };
  }
  if (event.type !== "work_step") return turn;
  const at = turn.steps.findIndex((s) => s.key === event.step.key);
  let step = event.step;
  if (at < 0) return { ...turn, steps: [...turn.steps, step], structured: true };
  const old = turn.steps[at];
  // A replacement without output keeps the earlier output, as the daemon's saved record does.
  if (!step.output && old.output) step = { ...step, output: old.output, ...(old.output_cut ? { output_cut: true } : {}) };
  if (sameStep(old, step)) return turn.structured ? turn : { ...turn, structured: true };
  const steps = turn.steps.slice();
  steps[at] = step;
  return { ...turn, steps, structured: true };
}

export interface StepNode { step: WorkStep; children: StepNode[] }

/** Top-level steps in order, each Helper step holding its own steps. A step whose parent is unknown stays top-level. */
export function stepTree(steps: readonly WorkStep[]): StepNode[] {
  const nodes = new Map<string, StepNode>();
  for (const step of steps) nodes.set(step.key, { step, children: [] });
  const top: StepNode[] = [];
  for (const step of steps) {
    const node = nodes.get(step.key)!;
    const parent = step.parent !== null && step.parent !== step.key ? nodes.get(step.parent) : undefined;
    (parent ? parent.children : top).push(node);
  }
  return top;
}

/** "83 steps" / "1 step"; counts every step including helpers'. */
export function stepsCountLabel(count: number): string {
  return `${count} ${count === 1 ? "step" : "steps"}`;
}

/**
 * An older daemon rejects `room_steps` as an unknown command. Same test as
 * answerStore uses for answers_load: callers catch the rejection and check this.
 */
export const isUnknownStepsCommand = (error: unknown): boolean =>
  /unknown variant [`'"]?room_steps|unknown command.*room_steps/i.test(error instanceof Error ? error.message : String(error));

const KINDS = ["command", "read", "search", "list", "edit", "web", "tool", "helper", "thinking", "other"];
const STATUSES = ["running", "done", "failed", "stopped"];
const TODO_STATUSES = ["pending", "in_progress", "completed"];

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || str(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);

function readStep(value: unknown): WorkStep | null {
  const o = obj(value);
  if (!o) return null;
  if (!str(o.key) || !strOrNull(o.parent) || !str(o.kind) || !KINDS.includes(o.kind) || !str(o.label)) return null;
  if (!strOrNull(o.folder) || !str(o.detail) || !strOrNull(o.output) || !str(o.status) || !STATUSES.includes(o.status)) return null;
  if (!numOrNull(o.exit_code) || !numOrNull(o.duration_ms)) return null;
  const step = {
    key: o.key, parent: o.parent, kind: o.kind, label: o.label, folder: o.folder, detail: o.detail,
    output: o.output, status: o.status, exit_code: o.exit_code, duration_ms: o.duration_ms,
  } as WorkStep;
  if (o.output_cut === true) step.output_cut = true;
  return step;
}

function readTodo(value: unknown): TodoItem | null {
  const o = obj(value);
  if (!o || !str(o.text) || !str(o.status) || !TODO_STATUSES.includes(o.status)) return null;
  return { text: o.text, status: o.status as TodoItem["status"] };
}

const count = (v: unknown): v is number => num(v) && v >= 0 && Number.isInteger(v);

/** Read what `room_steps` returned with no seq. Null when missing or damaged; a single damaged reply entry is dropped. */
export function readStepsIndex(value: unknown): StepsIndex | null {
  const o = obj(value);
  const replies = obj(o?.replies);
  if (!o || !replies || !count(o.version)) return null;
  const out: Record<string, StepsIndexEntry> = {};
  for (const [seq, raw] of Object.entries(replies)) {
    const e = obj(raw);
    if (!e || !str(e.by) || !count(e.count) || !count(e.helpers) || !count(e.offset) || !count(e.len)) continue;
    out[seq] = { by: e.by, count: e.count, helpers: e.helpers, offset: e.offset, len: e.len };
  }
  return { version: o.version, replies: out };
}

/** Read what `room_steps` returned for one reply. Null when missing or damaged; a single damaged step or to-do item is dropped rather than failing the record. */
export function readReplySteps(value: unknown): ReplySteps | null {
  const o = obj(value);
  if (!o || !str(o.by) || !count(o.seq) || !Array.isArray(o.steps) || !Array.isArray(o.todo) || !count(o.dropped)) return null;
  return {
    by: o.by,
    seq: o.seq,
    steps: o.steps.map(readStep).filter((s): s is WorkStep => s !== null),
    todo: o.todo.map(readTodo).filter((t): t is TodoItem => t !== null),
    dropped: o.dropped,
  };
}

/**
 * Keeps a pane's saved-steps index fresh. One call in flight at a time; a request
 * made meanwhile runs once more afterwards. An older daemon that doesn't know
 * `room_steps` switches it off for good; any other failure just hides the lines
 * until the next refresh.
 */
export function createStepsIndexLoader(call: () => Promise<unknown>, apply: (index: StepsIndex | null) => void) {
  let unsupported = false;
  let running = false;
  let again = false;
  const refresh = async (): Promise<void> => {
    if (unsupported) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        try {
          apply(readStepsIndex(await call()));
        } catch (error) {
          apply(null);
          if (isUnknownStepsCommand(error)) { unsupported = true; again = false; }
        }
      } while (again);
    } finally {
      running = false;
    }
  };
  return { refresh, unsupported: () => unsupported };
}
