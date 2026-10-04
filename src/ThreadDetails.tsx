import type { ReactNode } from "react";
import type { DetailsSection } from "./detailsLayout";

export interface DetailsHost {
  slot: HTMLElement | null;
  open: boolean;
  collapsed: Partial<Record<DetailsSection, boolean>>;
  toggle: (section: DetailsSection) => void;
  show: (section?: DetailsSection) => void;
  close: () => void;
  /** The thread the sidebar shows. Only that thread renders into the slot. */
  target: string | null;
}
interface Props {
  host: DetailsHost;
  title: string;
  cwd: string;
  /** "workspace-1 · 2 bots". */
  subtitle: string;
  bots: ReactNode;
  form: ReactNode;
  room: ReactNode;
  /** What the person chose "Always allow" for. */
  allowed: ReactNode;
  changes: ReactNode;
}
/** Thread-owned controls rendered into the app's single details slot. */
export function ThreadDetails({ host, title, cwd, subtitle, bots, form, room, allowed, changes }: Props) {
  const section = (id: DetailsSection, label: string, body: ReactNode) => <section className="details-section" id={`details-${id}`}>
    <button className="details-heading" aria-expanded={!host.collapsed[id]} aria-controls={`details-${id}-body`} onClick={() => host.toggle(id)}>{label}<span aria-hidden="true">{host.collapsed[id] ? "+" : "−"}</span></button>
    {!host.collapsed[id] && <div id={`details-${id}-body`} className="details-section-body">{body}</div>}
  </section>;
  return <>
    <header className="details-head"><div><strong>{title}</strong><p className="muted" title={cwd || "No workspace folder"}>{subtitle}</p></div><button className="icon" aria-label="Close thread details" onClick={host.close}>×</button></header>
    {section("bots", "Bots", bots)}
    {form && section("form", "Add or edit model", form)}
    {section("room", "Room", room)}
    {section("allowed", "Always allowed", allowed)}
    {section("changes", "Changes", changes)}
  </>;
}
