import type { ReactNode } from "react";
import type { DetailsSection } from "./detailsLayout";

export interface DetailsHost {
  slot: HTMLElement | null;
  open: boolean;
  collapsed: Partial<Record<DetailsSection, boolean>>;
  toggle: (section: DetailsSection) => void;
  show: (section?: DetailsSection) => void;
  close: () => void;
}
interface Props {
  host: DetailsHost;
  title: string;
  cwd: string;
  bots: ReactNode;
  form: ReactNode;
  room: ReactNode;
  changes: ReactNode;
}
/** Thread-owned controls rendered into the app's single details slot. */
export function ThreadDetails({ host, title, cwd, bots, form, room, changes }: Props) {
  const section = (id: DetailsSection, label: string, body: ReactNode) => <section className="details-section" id={`details-${id}`}>
    <button className="details-heading" aria-expanded={!host.collapsed[id]} aria-controls={`details-${id}-body`} onClick={() => host.toggle(id)}>{label}<span aria-hidden="true">{host.collapsed[id] ? "+" : "−"}</span></button>
    {!host.collapsed[id] && <div id={`details-${id}-body`} className="details-section-body">{body}</div>}
  </section>;
  return <>
    <header className="details-head"><div><strong>{title}</strong><p className="muted" title={cwd}>{cwd || "No workspace folder"}</p></div><button className="icon" aria-label="Close thread details" onClick={host.close}>×</button></header>
    {section("bots", "Bots", bots)}
    {form && section("form", "Add or edit model", form)}
    {section("room", "Room", room)}
    {section("changes", "Changes", changes)}
  </>;
}
