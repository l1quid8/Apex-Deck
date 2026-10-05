import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import { modHost, type ModPane } from "./mods/host";
import type { ModNode } from "./mods/runtime";
import { Markdown } from "./Markdown";

// Draws what a mod's ui.render returned. Sizes come in terminal cells, so
// widths are `ch` and heights are lines, in a monospace face.

const press = { surface: "desktop" };
const ch = (n: unknown) => (typeof n === "number" ? `${n}ch` : typeof n === "string" ? n : undefined);
const ln = (n: unknown) => (typeof n === "number" ? `${n * 1.45}em` : typeof n === "string" ? n : undefined);
const isFn = (v: unknown): v is { __fn: number } => typeof v === "object" && v !== null && "__fn" in v;

export function useMods() {
  return useSyncExternalStore(modHost.subscribe, modHost.snapshot);
}

function boxStyle(p: Record<string, any>): CSSProperties {
  const s: CSSProperties = {
    display: p.display === "none" ? "none" : "flex",
    flexDirection: p.flexDirection ?? "row",
    flexWrap: p.flexWrap,
    justifyContent: p.justifyContent,
    alignItems: p.alignItems,
    alignSelf: p.alignSelf,
    flexGrow: p.flexGrow,
    flexShrink: p.flexShrink,
    flexBasis: ch(p.flexBasis),
    width: ch(p.width),
    minWidth: ch(p.minWidth),
    height: ln(p.height),
    minHeight: ln(p.minHeight),
    columnGap: ch(p.columnGap ?? p.gap),
    rowGap: p.rowGap !== undefined ? ln(p.rowGap) : p.gap !== undefined ? ln(p.gap / 2) : undefined,
    backgroundColor: p.backgroundColor,
    position: p.position,
    top: ln(p.top),
    left: ch(p.left),
    overflow: p.overflow === "hidden" ? "hidden" : undefined,
  };
  const pad = (k: string) => p[k] ?? undefined;
  s.paddingTop = ln(pad("paddingTop") ?? p.paddingY ?? p.padding);
  s.paddingBottom = ln(pad("paddingBottom") ?? p.paddingY ?? p.padding);
  s.paddingLeft = ch(pad("paddingLeft") ?? p.paddingX ?? p.padding);
  s.paddingRight = ch(pad("paddingRight") ?? p.paddingX ?? p.padding);
  s.marginTop = ln(p.marginTop ?? p.marginY ?? p.margin);
  s.marginBottom = ln(p.marginBottom ?? p.marginY ?? p.margin);
  s.marginLeft = ch(p.marginLeft ?? p.marginX ?? p.margin);
  s.marginRight = ch(p.marginRight ?? p.marginX ?? p.margin);
  if (p.borderStyle) {
    s.border = `1px ${p.borderStyle === "double" ? "double" : p.borderStyle === "dashed" ? "dashed" : "solid"} ${p.borderColor ?? "var(--line, #333)"}`;
    s.borderRadius = p.borderStyle === "round" ? 6 : 2;
  }
  return s;
}

function textStyle(p: Record<string, any>): CSSProperties {
  return {
    color: p.inverse ? p.backgroundColor : p.color,
    backgroundColor: p.inverse ? p.color ?? "currentColor" : p.backgroundColor,
    fontWeight: p.bold ? 700 : undefined,
    fontStyle: p.italic ? "italic" : undefined,
    textDecoration: [p.underline && "underline", p.strikethrough && "line-through"].filter(Boolean).join(" ") || undefined,
    opacity: p.dimColor ? 0.6 : undefined,
    whiteSpace: p.wrap && p.wrap.startsWith("truncate") ? "pre" : "pre-wrap",
    overflow: p.wrap && p.wrap.startsWith("truncate") ? "hidden" : undefined,
    textOverflow: p.wrap && p.wrap.startsWith("truncate") ? "ellipsis" : undefined,
  };
}

function Field({ node, pane, kind }: { node: ModNode; pane: ModPane; kind: "Input" | "Select" }) {
  const p = node.p as Record<string, any>;
  const [value, setValue] = useState<string>(p.value ?? "");
  const focused = useRef(false);
  // Follow the mod's value unless the person is typing in it.
  useEffect(() => { if (!focused.current) setValue(p.value ?? ""); }, [p.value]);
  const call = (fn: unknown, v: string) => { if (isFn(fn)) modHost.press(pane, fn.__fn, [v, press]); };
  return (
    <label className="mod-field">
      {p.label && <span className="mod-field-label">{String(p.label).trimEnd()}</span>}
      {kind === "Select" ? (
        <select value={value} autoFocus={p.autoFocus} onChange={(e) => { setValue(e.target.value); call(p.onSelect, e.target.value); }}>
          {!((p.options ?? []) as { value: string }[]).some((o) => o.value === value) && <option value={value}>{value}</option>}
          {((p.options ?? []) as { value: string; label?: string }[]).map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
        </select>
      ) : (
        <input value={value} placeholder={p.placeholder} autoFocus={p.autoFocus} spellCheck={false}
          onFocus={() => (focused.current = true)} onBlur={() => (focused.current = false)}
          onChange={(e) => { setValue(e.target.value); call(p.onInput, e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); call(p.onSubmit, value); } }} />
      )}
    </label>
  );
}

function draw(node: ModNode | string, pane: ModPane, key: string | number, inText: boolean): ReactNode {
  if (typeof node === "string") return node;
  const p = node.p as Record<string, any>;
  const k = p.key ?? key;
  const kids = (asText: boolean) => node.c.map((child, i) => draw(child, pane, i, asText));
  switch (node.t) {
    case "Box":
      return <div key={k} className="mod-box" style={boxStyle(p)}>{kids(false)}</div>;
    case "Text":
      return <span key={k} className={inText ? undefined : "mod-text"} style={textStyle(p)}>{kids(true)}</span>;
    case "Button":
      return (
        <button key={k} type="button" className={p.variant === "primary" ? "mod-button primary" : p.plain ? "mod-button plain" : "mod-button"}
          style={{ opacity: p.dimColor ? 0.6 : undefined }} title={p.hotkey ? `Shortcut: ${p.hotkey}` : undefined}
          onClick={() => isFn(p.onPress) && modHost.press(pane, p.onPress.__fn, [press])}>
          {p.label ?? kids(true)}
        </button>
      );
    case "Input":
    case "Select":
      return <Field key={k} node={node} pane={pane} kind={node.t} />;
    case "Svg":
      return <img key={k} className="mod-svg" alt={p.alt ?? ""} width={p.width} height={p.height}
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(p.source ?? ""))}`} />;
    case "Link":
      return <a key={k} href={p.href} target="_blank" rel="noreferrer">{p.label ?? p.href}</a>;
    case "Code":
      return <pre key={k} className="mod-code">{String(p.source ?? "")}</pre>;
    case "Markdown":
      return <div key={k} className="mod-markdown" style={{ opacity: p.dimColor ? 0.6 : undefined }}><Markdown text={String(p.text ?? "")} onOpen={() => undefined} /></div>;
    default:
      // Client regions are drawn by a module of their own, which Deck doesn't run yet.
      return null;
  }
}

/** Every hotkey on a Button in the tree, with its handler. */
function hotkeys(node: ModNode | string | null, out = new Map<string, number>()) {
  if (!node || typeof node === "string") return out;
  if (node.t === "Button" && typeof node.p.hotkey === "string" && isFn(node.p.onPress)) out.set(node.p.hotkey.toLowerCase(), node.p.onPress.__fn);
  for (const child of node.c) hotkeys(child, out);
  return out;
}

export function ModPaneBody({ pane }: { pane: ModPane }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const probe = document.createElement("span");
    probe.textContent = "0000000000";
    probe.style.cssText = "position:absolute;visibility:hidden";
    el.appendChild(probe);
    const cell = probe.getBoundingClientRect().width / 10 || 8;
    probe.remove();
    const measure = () => modHost.resize(pane, Math.max(30, Math.floor((el.clientWidth - 24) / cell)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pane.mod, pane.id]);
  return <div ref={body} className="mod-pane-body">{pane.tree ? draw(pane.tree, pane, 0, false) : <span className="mod-text" style={{ opacity: 0.6 }}>Loading…</span>}</div>;
}

/** Docked panes, for a chat pane's side panel. */
const WIDTH_KEY = "deck.modDockWidth";
const savedWidths = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(WIDTH_KEY) ?? "{}"); } catch { return {}; } };

/** Asks App to open Settings at a section. */
export const OPEN_SETTINGS_EVENT = "deck:open-settings";

export function ModDock({ panes, overlay }: { panes: ModPane[]; overlay?: boolean }) {
  const [active, setActive] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [widths, setWidths] = useState(savedWidths);
  const [reloading, setReloading] = useState(false);
  const pane = panes[Math.min(active, panes.length - 1)];
  // Esc restores a maximized panel, unless a field or a dialog has the key.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== "Escape" || e.defaultPrevented || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (modHost.snapshot().panes.some((p) => p.focus)) return;
      setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);
  if (!pane) return null;
  const width = widths[pane.mod];

  /** Drag the left edge; the width is remembered for each mod. */
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    const right = panel.getBoundingClientRect().right;
    const host = panel.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    let next = panel.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      next = Math.round(Math.max(320, Math.min(host - 200, right - ev.clientX)));
      panel.style.width = `${next}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("mod-resizing");
      const all = { ...savedWidths(), [pane.mod]: next };
      localStorage.setItem(WIDTH_KEY, JSON.stringify(all));
      setWidths(all);
    };
    document.body.classList.add("mod-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reload = async () => {
    setReloading(true);
    try { await modHost.reload(pane.mod); } finally { setReloading(false); }
  };

  const classes = ["artifacts-panel", "mod-dock", overlay && !maximized ? "overlay" : "", maximized ? "maximized" : ""].filter(Boolean).join(" ");
  return (
    <aside className={classes} style={!maximized && !overlay && width ? { width } : undefined} aria-label="Mod panes">
      {!maximized && !overlay && (
        <div className="mod-resize" role="separator" aria-orientation="vertical" aria-label="Resize mod panel" title="Drag to resize. Double-click to reset."
          onPointerDown={startResize}
          onDoubleClick={() => { const all = savedWidths(); delete all[pane.mod]; localStorage.setItem(WIDTH_KEY, JSON.stringify(all)); setWidths(all); }} />
      )}
      <div className="mod-dock-head">
        <div className="mod-tabs" role="tablist">
          {panes.map((p, i) => (
            <button key={`${p.mod}:${p.id}`} role="tab" aria-selected={p === pane} className={p === pane ? "active" : undefined} onClick={() => setActive(i)}>{p.title}</button>
          ))}
        </div>
        <button type="button" className="ghost small" title={`Reload ${pane.mod}`} aria-label={`Reload ${pane.mod}`} disabled={reloading} onClick={reload}>{reloading ? "…" : "↻"}</button>
        <button type="button" className="ghost small" title={`${pane.mod} options`} aria-label={`${pane.mod} options`} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "mods" }))}>⚙</button>
        <button type="button" className="ghost small" title={maximized ? "Restore (Esc)" : "Maximize"} aria-label={maximized ? "Restore panel" : "Maximize panel"} aria-pressed={maximized} onClick={() => setMaximized((m) => !m)}>{maximized ? "⤡" : "⤢"}</button>
        <button type="button" className="ghost small" aria-label={`Close ${pane.title}`} title="Close" onClick={() => modHost.close(pane)}>✕</button>
      </div>
      <ModPaneBody pane={pane} />
    </aside>
  );
}

/** Focused panes (confirm dialogs), toasts and status chips, over the whole window. */
/** Mod status lines, drawn in the header of the thread hosting the mod. The
 *  chevron opens or closes the mod's pane, or removes the badge. */
export function ModStatuses({ paneId, columns }: { paneId: string; columns?: number }) {
  const mods = useMods();
  if (mods.hostPane !== paneId) return null;
  const statuses = Object.entries(mods.runs).filter(([name, r]) => r.status && !mods.hiddenStatus.includes(name));
  if (statuses.length === 0) return null;
  return <>{statuses.map(([name, r]) => <ModStatus key={name} paneId={paneId} name={name} status={r.status!} command={r.commands[0]?.name} columns={columns} open={mods.panes.some((p) => p.mod === name && !p.focus)} />)}</>;
}

function ModStatus({ paneId, name, status, command, columns, open }: { paneId: string; name: string; status: string; command?: string; columns?: number; open: boolean }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  const toggle = () => {
    setMenu(false);
    if (open) for (const p of modHost.snapshot().panes.filter((p) => p.mod === name && !p.focus)) modHost.close(p);
    else if (command) void modHost.run(paneId, { mod: name, name: command, args: "" }, columns ?? 100);
  };
  return (
    <span ref={ref} className="mod-status-wrap">
      <button type="button" className="mod-status" title={name} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
        {status} <span className="mod-status-chevron" aria-hidden>▾</span>
      </button>
      {menu && (
        <div className="mod-status-menu" role="menu">
          {command && <button type="button" role="menuitem" onClick={toggle}>{open ? `Close /${command} pane` : `Open /${command} pane`}</button>}
          <button type="button" role="menuitem" onClick={() => { setMenu(false); modHost.hideStatus(name); }}>Remove status badge</button>
        </div>
      )}
    </span>
  );
}

export function ModOverlays() {
  const mods = useMods();
  const modal = mods.panes.find((p) => p.focus);
  useEffect(() => {
    if (!modal) return;
    const keys = hotkeys(modal.tree);
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "Escape" && modal.closeOnEscape) { e.preventDefault(); modHost.close(modal); return; }
      const fn = keys.get(e.key.toLowerCase());
      if (fn !== undefined && !e.metaKey && !e.ctrlKey) { e.preventDefault(); modHost.press(modal, fn, [press]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);
  return (
    <>
      {modal && (
        <div className="mod-modal-backdrop">
          <div className="mod-modal" role="dialog" aria-modal="true" aria-label={modal.title}>
            <div className="mod-dock-head"><strong>{modal.title}</strong>
              <button type="button" className="ghost small" aria-label="Close" onClick={() => modHost.close(modal)}>✕</button>
            </div>
            <ModPaneBody pane={modal} />
          </div>
        </div>
      )}
      {mods.toasts.length > 0 && (
        <div className="mod-corner">
          {mods.toasts.map((t) => (
            <button key={t.id} type="button" className={`mod-toast ${t.tone}`} onClick={() => modHost.dismissToast(t.id)}>{t.text}</button>
          ))}
        </div>
      )}
    </>
  );
}
