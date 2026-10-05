// The window's side of mods: which are installed and enabled, one worker per
// enabled mod, and what they've drawn. Settings → Mods edits the list; chat
// panes draw the panes; App draws modal panes, toasts and status chips.

import { invoke } from "@tauri-apps/api/core";

import type { ProposedAction, RoomEvent } from "../types";
import type { ModNode } from "./runtime";

export type Grant = "process" | "network" | "files" | "session";
export const GRANTS: { id: Grant; label: string }[] = [
  { id: "process", label: "Run programs on this Mac" },
  { id: "network", label: "Make network requests" },
  { id: "files", label: "Read file details and write files" },
  { id: "session", label: "See and change your messages, and see and block bots' tool calls" },
];

export interface UserConfigField {
  /** directory and file are strings Deck asks for with a picker. */
  type: "string" | "number" | "boolean" | "directory" | "file";
  title?: string;
  description?: string;
  default?: unknown;
  options?: string[];
  /** Turning the mod on waits until this has a value. */
  required?: boolean;
}

export interface ModEntry {
  /** Deck's installed copy, which is what runs. */
  dir: string;
  /** The folder it was installed from, for reinstalling. */
  source?: string;
  name: string;
  description: string;
  enabled: boolean;
  grants: Grant[];
  options: Record<string, unknown>;
  userConfig: Record<string, UserConfigField>;
}

export interface ModPane {
  mod: string;
  id: string;
  title: string;
  focus: boolean;
  closeOnEscape: boolean;
  tree: ModNode | null;
}

export interface ModRun {
  state: "loading" | "ready" | "failed";
  error: string;
  commands: { name: string; description: string }[];
  status: string | null;
}

export interface ModToast { id: number; mod: string; text: string; tone: "info" | "error" }

export interface ModSnapshot {
  mods: ModEntry[];
  runs: Record<string, ModRun>;
  panes: ModPane[];
  toasts: ModToast[];
  /** The chat pane that last ran a mod command: docked panes show there. */
  hostPane: string | null;
  /** Mods whose status badge the person removed; running one of its commands brings it back. */
  hiddenStatus: string[];
}

const KEY = "deck.mods";

interface ModSource { dir: string; manifest: any; hooks: any; files: Record<string, string> }

function loadList(): ModEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

let snapshot: ModSnapshot = { mods: [], runs: {}, panes: [], toasts: [], hostPane: null, hiddenStatus: [] };
const listeners = new Set<() => void>();
const workers = new Map<string, Worker>();
const pendingCommands = new Map<number, (result: { text?: string }) => void>();
const pendingEvents = new Map<number, (result: unknown) => void>();
/** The turn each bot is on, per thread, and how it ended so far. */
const turns = new Map<string, { turnId: string; reason: "answer" | "error" | "aborted"; text: string; error?: string }>();
let commandIds = 0;
let eventIds = 0;
let turnIds = 0;
let toastIds = 0;
let started = false;

function set(next: Partial<ModSnapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function setRun(name: string, patch: Partial<ModRun>) {
  const run = snapshot.runs[name] ?? { state: "loading", error: "", commands: [], status: null };
  set({ runs: { ...snapshot.runs, [name]: { ...run, ...patch } } });
}

function saveList(mods: ModEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(mods));
  set({ mods });
}

export const modHost = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: () => snapshot,

  /** Start every enabled mod. Called once by App. */
  start() {
    if (started) return;
    started = true;
    set({ mods: loadList() });
    for (const mod of snapshot.mods) if (mod.enabled) void boot(mod);
  },

  /** Copy a folder into Deck's mods folder and add it, disabled. Installing
   *  a mod that's already added replaces its files and keeps its settings. */
  async add(from: string): Promise<ModEntry> {
    const dir = await invoke<string>("mod_install", { source: from });
    const entry = { ...entryFrom(await invoke<ModSource>("mod_read", { dir })), source: from };
    const old = snapshot.mods.find((m) => m.name === entry.name);
    const next = old ? { ...entry, enabled: old.enabled, grants: old.grants, options: old.options } : entry;
    saveList(old ? snapshot.mods.map((m) => (m.name === entry.name ? next : m)) : [...snapshot.mods, next]);
    if (old?.enabled) { stop(next.name); void boot(next); }
    return next;
  },

  remove(name: string) {
    stop(name);
    saveList(snapshot.mods.filter((m) => m.name !== name));
  },

  setEnabled(name: string, enabled: boolean, grants?: Grant[]) {
    const mods = snapshot.mods.map((m) => (m.name === name ? { ...m, enabled, grants: grants ?? m.grants } : m));
    saveList(mods);
    stop(name);
    const mod = mods.find((m) => m.name === name);
    if (enabled && mod) void boot(mod);
  },

  setOptions(name: string, options: Record<string, unknown>) {
    saveList(snapshot.mods.map((m) => (m.name === name ? { ...m, options } : m)));
  },

  /** Read the folder again and restart the mod. */
  async reload(name: string) {
    const mod = snapshot.mods.find((m) => m.name === name);
    if (!mod) return;
    stop(name);
    if (mod.enabled) await boot(mod);
  },

  /** The mod and command name for `/name args`, if a mod registered it. */
  commandFor(body: string): { mod: string; name: string; args: string } | null {
    const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(body.trim());
    if (!match) return null;
    for (const [mod, run] of Object.entries(snapshot.runs)) {
      if (run.state === "ready" && run.commands.some((c) => c.name === match[1])) return { mod, name: match[1], args: (match[2] ?? "").trim() };
    }
    return null;
  },

  allCommands(): { mod: string; name: string; description: string }[] {
    return Object.entries(snapshot.runs).flatMap(([mod, run]) => (run.state === "ready" ? run.commands.map((c) => ({ mod, ...c })) : []));
  },

  /** Run a mod command typed by the person in chat pane `pane`. */
  run(pane: string, command: { mod: string; name: string; args: string }, columns: number): Promise<{ text?: string }> {
    const worker = workers.get(command.mod);
    if (!worker) return Promise.resolve({ text: `${command.mod} isn't running` });
    set({ hostPane: pane, hiddenStatus: snapshot.hiddenStatus.filter((m) => m !== command.mod) });
    const id = ++commandIds;
    return new Promise((done) => {
      pendingCommands.set(id, done);
      worker.postMessage({
        type: "command",
        id,
        event: { command: command.name, args: command.args, origin: { kind: "composer" }, presentation: { columns, surface: "desktop" } },
      });
    });
  },

  press(pane: ModPane, fn: number, args: unknown[]) {
    workers.get(pane.mod)?.postMessage({ type: "press", pane: pane.id, fn, args });
  },

  resize(pane: ModPane, columns: number) {
    workers.get(pane.mod)?.postMessage({ type: "resize", pane: pane.id, columns });
  },

  /** The person closed a pane. */
  close(pane: ModPane) {
    set({ panes: snapshot.panes.filter((p) => !(p.mod === pane.mod && p.id === pane.id)) });
    workers.get(pane.mod)?.postMessage({ type: "closed", pane: pane.id });
  },

  /** `prompt.submit` through every mod allowed to see messages, in list order.
   *  Resolves with the text to send, or `deny` when a mod refused it. */
  async promptSubmit(thread: string, text: string): Promise<{ text: string; deny?: string }> {
    for (const mod of sessionMods()) {
      const out = (await ask(mod, "prompt.submit", { text, thread, surface: "desktop" }, 3000)) as { text?: unknown; deny?: unknown } | null;
      if (out && typeof out.deny === "string") return { text, deny: `${mod}: ${out.deny}` };
      if (out && typeof out.text === "string") text = out.text;
    }
    return { text };
  },

  /** `tool.call` for an action a bot asked approval for. Deck can only stop a
   *  call that waits on approval, so that's when mods hear it. Resolves with
   *  the first mod's `deny`, or null to leave the card to the person. */
  async toolCall(thread: string, bot: string, action: ProposedAction): Promise<string | null> {
    const e = { tool: action.title, kind: action.kind, title: action.title, input: action.detail, risky: Boolean(action.risky), thread, bot };
    for (const mod of sessionMods()) {
      const out = (await ask(mod, "tool.call", e, 5000)) as { deny?: unknown } | null;
      if (out && typeof out.deny === "string") return `${mod}: ${out.deny}`;
    }
    return null;
  },

  /** Turn starts and ends in any thread, told to mods allowed to see them. Nothing waits on the answer. */
  roomEvent(thread: string, event: RoomEvent) {
    const bot = event.type === "message_added" ? (event.message.speaker.kind === "bot" ? event.message.speaker.id : null) : "id" in event && typeof event.id === "string" ? event.id : null;
    if (!bot || !snapshot.mods.some((m) => m.enabled && m.grants.includes("session"))) return;
    const key = `${thread}:${bot}`;
    switch (event.type) {
      case "turn_started": {
        const turnId = `turn-${++turnIds}`;
        turns.set(key, { turnId, reason: "aborted", text: "" });
        tell("turn.start", { turnId, text: "", thread, bot });
        break;
      }
      case "message_added":
      case "passed":
      case "failed": {
        const turn = turns.get(key);
        if (turn) Object.assign(turn, event.type === "failed" ? { reason: "error", error: event.error } : { reason: "answer", text: event.type === "message_added" ? event.message.text : "" });
        break;
      }
      case "participant_idle": {
        const turn = turns.get(key);
        if (!turn) break;
        turns.delete(key);
        tell("turn.complete", { ...turn, thread, bot });
        break;
      }
    }
  },

  /** A line from Deck about a mod, such as a refusal, shown as a toast. */
  notice(text: string) {
    toast(text.split(":")[0], text);
  },

  hideStatus(mod: string) {
    if (!snapshot.hiddenStatus.includes(mod)) set({ hiddenStatus: [...snapshot.hiddenStatus, mod] });
  },

  dismissToast(id: number) {
    set({ toasts: snapshot.toasts.filter((t) => t.id !== id) });
  },
};

/** Running mods allowed to hook the session, in the list's order. */
function sessionMods(): string[] {
  return snapshot.mods.filter((m) => m.enabled && m.grants.includes("session") && snapshot.runs[m.name]?.state === "ready" && workers.has(m.name)).map((m) => m.name);
}

/** One mod's answer to an event, or null if it fails or takes longer than `ms`. */
function ask(mod: string, name: string, event: unknown, ms: number): Promise<unknown> {
  const worker = workers.get(mod);
  if (!worker) return Promise.resolve(null);
  const id = ++eventIds;
  return new Promise((done) => {
    const timer = setTimeout(() => {
      pendingEvents.delete(id);
      toast(mod, `${mod} took over ${ms / 1000}s on ${name}; Deck went on without it`, "error");
      done(null);
    }, ms);
    pendingEvents.set(id, (result) => { clearTimeout(timer); done(result); });
    worker.postMessage({ type: "event", id, name, event });
  });
}

function tell(name: string, event: unknown) {
  for (const mod of sessionMods()) workers.get(mod)?.postMessage({ type: "event", id: 0, name, event });
}

function entryFrom(source: ModSource): ModEntry {
  const manifest = source.manifest ?? {};
  const name = String(manifest.name ?? source.dir.split("/").filter(Boolean).pop() ?? "mod");
  const userConfig = (manifest.userConfig ?? {}) as Record<string, UserConfigField>;
  return { dir: source.dir, name, description: String(manifest.description ?? ""), enabled: false, grants: [], options: {}, userConfig };
}

/** The options a mod's register(on, options) gets: its defaults, then the person's values. */
export function optionsOf(mod: ModEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(mod.userConfig)) if (field.default !== undefined) out[key] = field.default;
  return { ...out, ...mod.options };
}

/** Claude Code installs a mod under ~/.claude/mods/<name>/, and a mod's path
 *  settings often default there. When that path doesn't exist but Deck's copy
 *  has the same file, point the setting at the copy. */
async function withInstalledPaths(mod: ModEntry): Promise<Record<string, unknown>> {
  const options = optionsOf(mod);
  const prefix = `~/.claude/mods/${mod.name}/`;
  const home = await invoke<string | null>("mod_env_get", { name: "HOME" }).catch(() => null);
  const exists = (path: string) => invoke("mod_fs_stat", { path }).then(() => true, () => false);
  for (const [key, value] of Object.entries(options)) {
    if (typeof value !== "string" || !value.startsWith(prefix) || !home) continue;
    const local = `${mod.dir}/${value.slice(prefix.length)}`;
    if (!(await exists(home + value.slice(1))) && (await exists(local))) options[key] = local;
  }
  return options;
}

/** Why the mod can't be turned on yet, or "" when it can. */
export function enableBlocker(mod: ModEntry): string {
  const options = optionsOf(mod);
  for (const [key, field] of Object.entries(mod.userConfig)) {
    const value = options[key];
    // "auto" finds things with Linux tools, so on a Mac it can't stand in for a value.
    const unset = value === undefined || value === "" || (value === "auto" && /Mac/.test(navigator.platform));
    if (field.required && unset) return `Set ${field.title ?? key} first${value === "auto" ? "; auto can't find it on macOS" : ""}.`;
  }
  return "";
}

function toast(mod: string, text: string, tone: ModToast["tone"] = "info") {
  const id = ++toastIds;
  set({ toasts: [...snapshot.toasts, { id, mod, text, tone }].slice(-4) });
  setTimeout(() => modHost.dismissToast(id), tone === "error" ? 9000 : 5000);
}

function stop(name: string) {
  workers.get(name)?.terminate();
  workers.delete(name);
  const { [name]: _gone, ...runs } = snapshot.runs;
  set({ runs, panes: snapshot.panes.filter((p) => p.mod !== name) });
}

const needs: Record<string, Grant | null> = {
  "process.run": "process",
  "http.fetch": "network",
  "fs.write": "files",
  "fs.stat": "files",
  "env.get": null,
  "store.get": null,
  "store.set": null,
  "clipboard.write": null,
};

async function serve(mod: ModEntry, method: string, args: any): Promise<unknown> {
  if (!(method in needs)) throw new Error(`Deck has no ${method}`);
  const grant = needs[method];
  if (grant && !mod.grants.includes(grant)) throw new Error(`${mod.name} wasn't allowed to ${GRANTS.find((g) => g.id === grant)!.label.toLowerCase()}; turn it on in Settings → Mods`);
  const storeKey = `deck.mod.${mod.name}.${args?.key}`;
  switch (method) {
    case "process.run": return invoke("mod_process_run", { argv: args.argv, cwd: args.cwd, stdin: args.stdin, timeoutMs: args.timeoutMs });
    case "http.fetch": return invoke("mod_http_fetch", { url: args.url, method: args.method, headers: args.headers, body: args.body });
    case "fs.write": return invoke("mod_fs_write", { path: args.path, text: args.text });
    case "fs.stat": return invoke("mod_fs_stat", { path: args.path, resolve: args.resolve });
    case "env.get": return invoke("mod_env_get", { name: args.name });
    case "store.get": {
      const raw = localStorage.getItem(storeKey);
      return raw === null ? undefined : JSON.parse(raw);
    }
    case "store.set": localStorage.setItem(storeKey, JSON.stringify(args.value ?? null)); return null;
    case "clipboard.write": await navigator.clipboard.writeText(String(args.text)); return null;
  }
  return null;
}

async function boot(mod: ModEntry) {
  setRun(mod.name, { state: "loading", error: "", commands: [], status: null });
  let source: ModSource;
  try {
    source = await invoke<ModSource>("mod_read", { dir: mod.dir });
  } catch (error) {
    setRun(mod.name, { state: "failed", error: String(error) });
    return;
  }
  const modules: string[] = Array.isArray(source.hooks?.modules) ? source.hooks.modules : [];
  if (!modules.length) {
    setRun(mod.name, { state: "failed", error: "hooks/hooks.json names no modules" });
    return;
  }
  const options = await withInstalledPaths(mod);
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: `mod:${mod.name}` });
  workers.set(mod.name, worker);
  worker.onerror = (event) => setRun(mod.name, { state: "failed", error: event.message || "The mod's worker stopped" });
  worker.onmessage = async (event: MessageEvent) => {
    if (workers.get(mod.name) !== worker) return;
    const m = event.data;
    const current = snapshot.mods.find((x) => x.name === mod.name) ?? mod;
    switch (m.type) {
      case "ready": setRun(mod.name, { state: "ready" }); break;
      case "failed": setRun(mod.name, { state: "failed", error: m.message }); worker.terminate(); workers.delete(mod.name); break;
      case "error": toast(mod.name, `${mod.name}: ${m.message}`, "error"); break;
      case "call":
        try {
          worker.postMessage({ type: "reply", id: m.id, value: await serve(current, m.method, m.args) });
        } catch (error) {
          worker.postMessage({ type: "reply", id: m.id, error: error instanceof Error ? error.message : String(error) });
        }
        break;
      case "command": {
        const run = snapshot.runs[mod.name];
        const commands = [...(run?.commands ?? []).filter((c) => c.name !== m.spec.name), { name: m.spec.name, description: m.spec.description ?? "" }];
        setRun(mod.name, { commands });
        break;
      }
      case "eventResult": pendingEvents.get(m.id)?.(m.result); pendingEvents.delete(m.id); break;
      case "commandResult": pendingCommands.get(m.id)?.(m.result); pendingCommands.delete(m.id); break;
      case "open": {
        const rest = snapshot.panes.filter((p) => !(p.mod === mod.name && p.id === m.pane.id));
        const old = snapshot.panes.find((p) => p.mod === mod.name && p.id === m.pane.id);
        set({ panes: [...rest, { mod: mod.name, ...m.pane, tree: old?.tree ?? null }] });
        break;
      }
      case "close": set({ panes: snapshot.panes.filter((p) => !(p.mod === mod.name && p.id === m.id)) }); break;
      case "tree": set({ panes: snapshot.panes.map((p) => (p.mod === mod.name && p.id === m.id ? { ...p, tree: m.tree } : p)) }); break;
      case "status": setRun(mod.name, { status: m.text ? String(m.text) : null }); break;
      case "toast": toast(mod.name, m.text); break;
    }
  };
  worker.postMessage({ type: "load", name: mod.name, files: source.files, modules, options });
}
