import type { AppSection } from "./types";

const sections = [
  { id: "agents", label: "Agents" },
  { id: "code", label: "Code" },
  { id: "threads", label: "Threads" },
] as const;

export function SectionIcon({ section }: { section: AppSection }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {section === "agents" ? <><path d="M12 3v4M9 3h6M5 7h14v13H5zM2 11v5m20-5v5M9 17h6" /><path d="M9 11v2m6-2v2" /></> : section === "code" ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></> : <><path d="M4 4h14v11H9l-5 4V4Z" /><path d="M18 9h3v12l-4-3h-5v-3" /></>}
  </svg>;
}

/** `flags` says how many panes in a section want attention, and how urgently. */
export function SectionNavigation({ section, onChange, flags = {} }: { section: AppSection; onChange: (section: AppSection) => void; flags?: Partial<Record<AppSection, { count: number; worst: string | null }>> }) {
  return <nav className="section-navigation" aria-label="Main sections">
    {sections.map((item) => <button key={item.id} className={`section-button ${item.id} ${section === item.id ? "selected" : ""}`} aria-current={section === item.id ? "page" : undefined} onClick={() => onChange(item.id)}>
      <span><SectionIcon section={item.id} /></span>{item.label}
      {(flags[item.id]?.count ?? 0) > 0 && <span className={`flag-count ${flags[item.id]?.worst ?? ""}`} title={`${flags[item.id]?.count} want attention`}>{flags[item.id]?.count}</span>}
    </button>)}
  </nav>;
}
