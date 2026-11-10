import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Pane, Workspace } from "./types";
import type { Signal } from "./attention";
import { label } from "./attention";
import { hostLabel } from "./previewAddress";
import { ProjectFolder, Glyph } from "./SidebarIcons";
import { ThreadName } from "./ThreadName";
import { headFit } from "./headFit";
import type { HeadPartId } from "./headFit";

/** Keep live call actions out of the counts slot, which narrow heads can hide.
 *  Below 240px they sit by the composer without taking the title's minimum room.
 *  Hosts with their own counts slot retain their existing capsule placement. */
export function PaneVoicePortal({ countsSlot, children }: { countsSlot: HTMLElement | null; children: ReactNode }) {
  const head = countsSlot?.closest<HTMLElement>("[data-adaptive-head]") ?? null;
  const [room, setRoom] = useState(false);
  useLayoutEffect(() => {
    if (!head) return;
    const measure = () => setRoom(head.clientWidth >= 240);
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(head);
    return () => resized.disconnect();
  }, [head]);
  if (!countsSlot) return null;
  const target = head ? room ? head.querySelector<HTMLElement>(".pane-voice") : null : countsSlot;
  return target ? createPortal(children, target) : <div className="pane-voice-fallback">{children}</div>;
}

export interface PaneHeadProps {
  pane: Pane;
  workspace: Workspace | undefined;
  status: string;
  attention: Signal | undefined;
  statusText: string;
  server: string | undefined;
  host: { id: string; name: string } | null;
  maximized: boolean;
  onMaximize(): void;
  onMenu(anchor: DOMRect, opener: HTMLElement): void;
  onClose(): void;
  onRename(title: string): void;
  renameRequest: number | undefined;
  onDragStart(event: PointerEvent): void;
  onOpenServer(): void;
  projectTitle?: string;
  projectTint?: string;
  hostTint?: string;
  program?: string;
  menuOpen?: boolean;
  menuDisabled?: boolean;
  modStatuses?: ReactNode;
  route?: { label: string; problem: boolean; disabled?: boolean; title?: string; onOpen(anchor: DOMRect): void };
}

/** The title gives up space first; secondary details leave before its controls. */
export function PaneHead({ pane, workspace, status, attention, statusText, server, host, maximized, onMaximize, onMenu, onClose, onRename, renameRequest, onDragStart, onOpenServer, projectTitle, projectTint, hostTint, program, menuOpen = false, menuDisabled = false, modStatuses, route }: PaneHeadProps) {
  const root = useRef<HTMLDivElement>(null);
  const statusLabel = attention ? attention.note || label(attention.kind) : status;
  const projectName = workspace ? `${workspace.name}${pane.mount && pane.mount !== workspace.path ? ` · ${pane.mount.replace(/\\/g, "/").split("/").filter(Boolean).at(-1)}` : ""}` : "";

  useLayoutEffect(() => {
    const head = root.current;
    if (!head) return;
    const fit = () => {
      const elements = [...head.querySelectorAll<HTMLElement>(":scope > [data-head-part]")];
      const parts: { id: HeadPartId; width: number }[] = [];
      for (const element of elements) {
        element.hidden = false;
        const id = element.dataset.headPart as HeadPartId;
        const width = id === "title" ? 56 : element.getBoundingClientRect().width;
        if (width > 0) parts.push({ id, width });
      }
      const voiceWidth = head.querySelector<HTMLElement>(":scope > .pane-voice")?.getBoundingClientRect().width ?? 0;
      const hidden = headFit(head.clientWidth - (voiceWidth > 0 ? voiceWidth + 4 : 0), parts);
      for (const element of elements) element.hidden = hidden.has(element.dataset.headPart as HeadPartId) || !parts.some(part => part.id === element.dataset.headPart);
      const title = head.querySelector<HTMLElement>(".pane-title");
      const text = title?.querySelector<HTMLElement>(".thread-name-text");
      if (!title || !text) return;
      const overflow = Math.ceil(text.getBoundingClientRect().width - title.clientWidth);
      title.classList.toggle("marquee", overflow > 2);
      title.style.setProperty("--title-shift", `${-overflow}px`);
      title.style.setProperty("--title-duration", `${(2.4 + Math.max(0, overflow) / 28).toFixed(2)}s`);
    };
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(head);
    const changed = new MutationObserver(fit);
    changed.observe(head, { childList: true, characterData: true, subtree: true });
    let disposed = false;
    void document.fonts?.ready.then(() => { if (!disposed) fit(); });
    return () => { disposed = true; resized.disconnect(); changed.disconnect(); };
  }, []);

  useEffect(() => {
    if (!maximized) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || menuOpen) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor")) return;
      if ([...document.querySelectorAll<HTMLElement>('[role="menu"]:not([hidden]), [role="dialog"]:not([hidden]), [aria-modal="true"]')].some(element => element.getClientRects().length > 0)) return;
      event.preventDefault();
      onMaximize();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [maximized, menuOpen, onMaximize]);

  return <div ref={root} className="pane-head pane-head-adaptive" data-adaptive-head="" title="Double-click for full screen"
    onPointerDown={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || root.current?.querySelector(".thread-name-input") || (event.target as Element).closest("button, input, textarea, select, [contenteditable='true']")) return;
      onDragStart(event);
    }}
    onDoubleClick={(event) => {
      if (event.metaKey || event.ctrlKey || root.current?.querySelector(".thread-name-input") || (event.target as Element).closest("button, input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      onMaximize();
    }}>
    <span data-head-part="dot" className={`dot ${status}`} title={statusLabel} />
    {workspace && <span data-head-part="project" className="pane-ws" title={projectTitle ?? workspace.path}>
      <ProjectFolder tint={projectTint} size={12} /><span className="nm">{projectName}</span>
    </span>}
    <span data-head-part="title" className="pane-head-title">
      <ThreadName className="pane-title" title={pane.title} onRename={onRename} renameRequest={renameRequest} label={pane.kind === "chat" ? "Thread name" : pane.kind === "preview" ? "Preview name" : "Terminal name"} editOnDoubleClick={false} tooltip="Double-click for full screen" />
    </span>
    {host && host.id !== "local" && <span data-head-part="host" className="pane-host" title={host.name}>
      <span className="tint" style={{ color: hostTint }}><Glyph name="globe" size={12} /></span><span className="hn">{host.name}</span>
    </span>}
    <span data-head-part="status" className="pane-head-status">
      {program && <span className="program-title">· {program}</span>}
      {attention ? <span className={`flag ${attention.kind}`} title={statusLabel}>{statusLabel}</span> : statusText && <span className="pane-folder">{statusText}</span>}
      {modStatuses}
      {route && <button type="button" disabled={route.disabled} title={route.title} className={`pane-route${route.problem ? ' problem' : ''}`} onClick={event => route.onOpen(event.currentTarget.getBoundingClientRect())}>→ {route.label} ▾</button>}
    </span>
    {(pane.kind === "terminal" || pane.kind === "chat") && server && <button data-head-part="server" className="server-chip" onClick={onOpenServer} title="Open in the Browser tab">{hostLabel(server)}</button>}
    {pane.kind === "chat" && <span className="pane-voice" />}
    {pane.kind === "chat" && <span data-head-part="counts" className="pane-counts" />}
    <button data-head-part="maximize" className="icon small" onClick={onMaximize} aria-label={maximized ? "Restore layout" : "Maximize pane"} title={maximized ? "Restore layout" : "Maximize"}>{maximized ? "▣" : "□"}</button>
    <span data-head-part="menu" className="pane-menu-wrap">
      <button className="icon small" disabled={menuDisabled} aria-label={`More actions for ${pane.title}`} aria-haspopup="menu" aria-expanded={menuOpen} title="More" onClick={(event) => onMenu(event.currentTarget.getBoundingClientRect(), event.currentTarget)}>⋯</button>
    </span>
    <button data-head-part="close" className="icon small" onClick={onClose} aria-label={`Close ${pane.title}`} title={pane.kind === "chat" ? "Close (the thread stays in the list)" : "Close"}>×</button>
  </div>;
}
