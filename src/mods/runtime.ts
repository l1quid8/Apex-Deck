// The mod runtime: loads a Claude Code mod (a plugin whose hooks/hooks.json
// names `modules`) and runs its `register(on)` against Deck as the "desktop"
// surface. It has no window or Electron access of its own: everything that
// reaches the machine or the screen goes through `host`, which the worker
// wires to postMessage. Pure, so tests drive it directly.

import { transform } from "sucrase";

/** A drawn element after serialization: handlers are replaced by ids. */
export interface ModNode {
  t: string;
  p: Record<string, unknown>;
  c: (ModNode | string)[];
}

export interface PaneInfo {
  id: string;
  title: string;
  focus: boolean;
  closeOnEscape: boolean;
}

/** What the runtime asks of the window. */
export interface RuntimeHost {
  /** Machine access: process.run, http.fetch, fs.*, env.get, store.*. */
  call(method: string, args: unknown): Promise<unknown>;
  command(spec: { name: string; description?: string }): void;
  open(pane: PaneInfo): void;
  close(id: string): void;
  tree(id: string, tree: ModNode | null): void;
  status(text: string | null): void;
  toast(text: string): void;
  error(message: string): void;
}

type Hook = ($: unknown, e: any, next: (e?: any) => Promise<unknown>) => unknown;
interface Registered { name: string; filter: Record<string, unknown> | null; fn: Hook }

const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

/** The surface's element table: each tag builds a plain node. */
const TAGS = ["Box", "Text", "Button", "Input", "Select", "Svg", "Link", "Code", "Markdown", "Client"] as const;

const FRAGMENT = Symbol("Fragment");

function flatten(children: unknown, out: (ModNode | string)[] = []): (ModNode | string)[] {
  if (children === null || children === undefined || children === false || children === true) return out;
  if (Array.isArray(children)) {
    for (const child of children) flatten(child, out);
    return out;
  }
  if (typeof children === "string" || typeof children === "number") {
    out.push(String(children));
    return out;
  }
  const node = children as { t: unknown; c: unknown };
  if (node.t === FRAGMENT) return flatten(node.c, out);
  out.push(node as ModNode);
  return out;
}

/** The JSX factory a mod's module is compiled against. */
export function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown {
  const all = { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) };
  if (type === FRAGMENT) return { t: FRAGMENT, p: {}, c: flatten(all.children) };
  if (typeof type === "function") return type(all);
  // A lowercase intrinsic (<div>) has no meaning on a surface; draw its text.
  return { t: "Box", p: {}, c: flatten(all.children) };
}

const kit = Object.freeze(Object.fromEntries(TAGS.map((tag) => [tag, (props: Record<string, unknown>) => {
  const { children, ...rest } = props ?? {};
  return { t: tag, p: rest, c: flatten(children) };
}])));

/** Resolve `spec` imported from `from` against the mod's files. */
export function resolve(files: Record<string, string>, from: string, spec: string): string | null {
  const base = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  const joined = base.join("/");
  for (const ext of EXTS) if (files[joined + ext] !== undefined) return joined + ext;
  // `./x.js` written for a `./x.ts` source.
  const bare = joined.replace(/\.(m?js|jsx)$/, "");
  for (const ext of EXTS) if (files[bare + ext] !== undefined) return bare + ext;
  return null;
}

export interface LoadedMod {
  /** Dispatch an event through the hooks registered for it. */
  dispatch(name: string, e: Record<string, unknown>): Promise<unknown>;
  /** Run a handler from the last tree drawn for `pane`. */
  press(pane: string, fn: number, args: unknown[]): Promise<void>;
  /** The pane's width changed. */
  resize(pane: string, columns: number): void;
  closed(pane: string): Promise<void>;
  commands(): string[];
  stop(): void;
}

export function loadMod(opts: {
  files: Record<string, string>;
  modules: string[];
  options: Record<string, unknown>;
  name: string;
  host: RuntimeHost;
}): LoadedMod {
  const { files, host } = opts;
  const hooks: Registered[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const atoms = new Map<string, unknown>();
  const panes = new Map<string, PaneInfo & { columns: number; handlers: Function[] }>();
  const commandNames: string[] = [];
  let stopped = false;
  let renderQueued = false;

  const report = (error: unknown) => host.error(error instanceof Error ? `${error.message}` : String(error));

  // ----- module loading -----
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const runtimeModule = {
    atom: (key: { plugin?: string; key: string }, init: unknown) => ({ __atom: `${key.plugin ?? opts.name}/${key.key}`, init }),
    derive: (sources: unknown[], compute: (...v: unknown[]) => unknown) => ({ __derived: true, sources, compute }),
    read: async (_$: unknown, a: any) => readAtom(a),
    update: async (_$: unknown, a: { __atom: string; init: unknown }, fn: (v: unknown) => unknown) => {
      const next = await fn(readAtom(a));
      atoms.set(a.__atom, next);
      queueRender();
      return next;
    },
    Fragment: FRAGMENT,
    h,
    jsx: (type: unknown, props: Record<string, unknown>) => h(type, props),
    jsxs: (type: unknown, props: Record<string, unknown>) => h(type, props),
  };
  function readAtom(a: any): unknown {
    if (a?.__derived) return a.compute(...a.sources.map(readAtom));
    return atoms.has(a.__atom) ? atoms.get(a.__atom) : a.init;
  }

  function requireFrom(from: string) {
    return (spec: string): unknown => {
      if (spec === "claude-code" || spec.startsWith("claude-code/")) return runtimeModule;
      if (spec === "react" || spec === "react/jsx-runtime") return runtimeModule;
      if (!spec.startsWith(".")) throw new Error(`${from} imports "${spec}", which a Deck mod can't load: only its own files and "claude-code"`);
      const path = resolve(files, from, spec);
      if (!path) throw new Error(`${from} imports "${spec}", which isn't in the mod's folder`);
      return load(path).exports;
    };
  }

  function load(path: string) {
    const hit = cache.get(path);
    if (hit) return hit;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(path, module);
    if (path.endsWith(".json")) {
      module.exports = JSON.parse(files[path]);
      return module;
    }
    const isTs = /\.(tsx?|mts)$/.test(path);
    const code = transform(files[path], {
      transforms: [...(isTs ? ["typescript" as const] : []), "jsx", "imports"],
      jsxPragma: "__h",
      jsxFragmentPragma: "__Fragment",
      production: true,
      filePath: path,
    }).code;
    const run = new Function("require", "module", "exports", "__h", "__Fragment", `${code}\n//# sourceURL=mod://${opts.name}/${path}`);
    run(requireFrom(path), module, module.exports, h, FRAGMENT);
    return module;
  }

  // ----- hooks -----
  // What the engine itself answers once every hook has called next: a prompt
  // goes on as it arrived; a tool call or turn goes on unchanged.
  const bottom = (name: string, e: Record<string, unknown>): unknown =>
    name === "ui.render" ? null : name === "prompt.submit" ? { text: e.text, context: e.context } : {};
  const matches = (hook: Registered, e: Record<string, unknown>) =>
    !hook.filter || Object.entries(hook.filter).every(([k, v]) => e[k] === v);

  async function dispatch(name: string, e: Record<string, unknown>): Promise<unknown> {
    const chain = hooks.filter((hook) => hook.name === name && matches(hook, e));
    const step = async (i: number, arg: Record<string, unknown>): Promise<unknown> => {
      const hook = chain[i];
      if (!hook) return bottom(name, arg);
      return hook.fn($, arg, (nextArg?: any) => step(i + 1, nextArg ?? arg));
    };
    return step(0, e);
  }

  // ----- the engine interface ($) -----
  const timer = (handle: ReturnType<typeof setTimeout>, repeat: boolean) => ({
    cancel: () => {
      timers.delete(handle);
      if (repeat) clearInterval(handle as never);
      else clearTimeout(handle);
    },
  });
  const guarded = (fn: () => unknown) => () => {
    if (stopped) return;
    try {
      const out = fn() as unknown;
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(report).finally(queueRender);
      else queueRender();
    } catch (error) {
      report(error);
    }
  };

  const $ = {
    clock: {
      now: async () => Date.now(),
      after: (ms: number, fn: () => unknown) => {
        const handle = setTimeout(() => {
          timers.delete(handle);
          guarded(fn)();
        }, Math.max(0, ms));
        timers.add(handle);
        return timer(handle, false);
      },
      every: (ms: number, fn: () => unknown) => {
        const handle = setInterval(guarded(fn), Math.max(50, ms));
        timers.add(handle);
        return timer(handle, true);
      },
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    },
    command: {
      register: async (spec: { name: string; description?: string }) => {
        if (!commandNames.includes(spec.name)) commandNames.push(spec.name);
        host.command(spec);
      },
    },
    env: { get: async (name: string) => (await host.call("env.get", { name })) as string | undefined },
    fs: {
      write: async (path: string, text: string) => { await host.call("fs.write", { path, text }); },
      stat: async (path: string, init?: { resolve?: boolean }) => host.call("fs.stat", { path, resolve: init?.resolve ?? false }),
    },
    http: {
      fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
        host.call("http.fetch", { url, method: init?.method ?? null, headers: init?.headers ?? null, body: init?.body ?? null }),
    },
    process: {
      run: async (argv: string[], init?: { cwd?: string; stdin?: string; timeoutMs?: number }) =>
        host.call("process.run", { argv, cwd: init?.cwd ?? null, stdin: init?.stdin ?? null, timeoutMs: init?.timeoutMs ?? null }),
    },
    store: {
      get: async (key: string) => host.call("store.get", { key }),
      set: async (key: string, value: unknown) => { await host.call("store.set", { key, value }); },
    },
    session: { surfaces: async () => ["desktop"], surface: async () => "desktop" },
    ui: {
      resolve: () => kit,
      open: async (args: { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean }) => {
        const pane = { id: args.id, title: args.title ?? args.id, focus: Boolean(args.focus), closeOnEscape: args.closeOnEscape !== false, columns: panes.get(args.id)?.columns ?? 80, handlers: [] };
        panes.set(args.id, pane);
        host.open({ id: pane.id, title: pane.title, focus: pane.focus, closeOnEscape: pane.closeOnEscape });
        queueRender();
        return { isPlaced: true };
      },
      close: async (args: { id: string }) => {
        if (!panes.has(args.id)) return;
        panes.delete(args.id);
        host.close(args.id);
        await dispatch("ui.close", { id: args.id });
      },
      status: (text: string | null) => host.status(text),
      toast: (text: string) => host.toast(String(text)),
      invalidate: () => queueRender(),
      // Desktop draws no Image, so there's nothing to swap a picture into.
      blit: async () => ({ deny: "Deck draws no Image element" }),
      copy: async (args: { text: string }) => { await host.call("clipboard.write", { text: args.text }); },
    },
  };

  // ----- rendering -----
  function serialize(node: ModNode | string, handlers: Function[]): ModNode | string {
    if (typeof node === "string") return node;
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.p)) {
      if (typeof v === "function") {
        handlers.push(v);
        p[k] = { __fn: handlers.length - 1 };
      } else if (k === "hover" || (v !== undefined && typeof v !== "symbol")) p[k] = v;
    }
    return { t: node.t, p, c: node.c.map((child) => serialize(child, handlers)) };
  }

  async function renderPane(id: string) {
    const pane = panes.get(id);
    if (!pane) return;
    try {
      const tree = await dispatch("ui.render", {
        surface: "desktop",
        component: "Pane",
        requestId: id,
        props: { title: pane.title, isFocused: true, bodyColumns: pane.columns, placement: "dock" },
      });
      if (!panes.has(id)) return;
      const handlers: Function[] = [];
      const root = tree == null ? null : flatten(tree);
      const node: ModNode | null = root === null ? null : root.length === 1 && typeof root[0] !== "string" ? (root[0] as ModNode) : { t: "Box", p: { flexDirection: "column" }, c: root };
      pane.handlers = handlers;
      host.tree(id, node && (serialize(node, handlers) as ModNode));
    } catch (error) {
      report(error);
    }
  }

  function queueRender() {
    if (renderQueued || stopped) return;
    renderQueued = true;
    setTimeout(() => {
      renderQueued = false;
      for (const id of panes.keys()) void renderPane(id);
    }, 16);
  }

  // ----- load -----
  for (const entry of opts.modules) {
    const path = resolve(files, "hooks/hooks.json", entry);
    if (!path) throw new Error(`hooks.json names ${entry}, which isn't in the mod's folder`);
    const mod = load(path).exports as { register?: Function; default?: Function };
    const register = mod.register ?? mod.default;
    if (typeof register !== "function") throw new Error(`${path} exports no register(on)`);
    register((name: string, filterOrFn: unknown, maybeFn?: Hook) => {
      const fn = (typeof filterOrFn === "function" ? filterOrFn : maybeFn) as Hook;
      const filter = typeof filterOrFn === "function" ? null : (filterOrFn as Record<string, unknown>);
      hooks.push({ name, filter, fn });
    }, opts.options);
  }

  return {
    dispatch: async (name, e) => {
      try {
        const out = await dispatch(name, e);
        queueRender();
        return out;
      } catch (error) {
        report(error);
        // A failed session hook leaves the event as it was; only a command shows the error.
        return name === "command.run" ? { text: `Error: ${error instanceof Error ? error.message : String(error)}` } : null;
      }
    },
    press: async (pane, fn, args) => {
      const handler = panes.get(pane)?.handlers[fn];
      if (!handler) return;
      try {
        await handler(...args);
      } catch (error) {
        report(error);
      }
      queueRender();
    },
    resize: (pane, columns) => {
      const p = panes.get(pane);
      if (p && p.columns !== columns) {
        p.columns = columns;
        queueRender();
      }
    },
    closed: async (pane) => {
      if (!panes.delete(pane)) return;
      await dispatch("ui.close", { id: pane }).catch(report);
    },
    commands: () => [...commandNames],
    stop: () => {
      stopped = true;
      for (const handle of timers) {
        clearTimeout(handle);
        clearInterval(handle as never);
      }
      timers.clear();
    },
  };
}
