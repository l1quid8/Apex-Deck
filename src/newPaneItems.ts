// What the + New menu offers, worked out apart from the interface so the
// filtering can be tested.

import type { AgentInfo, AppSection } from "./types";

export interface NewMenuItem {
  key: string;
  label: string;
  /** The program in mono, or a few words. */
  detail: string;
  kind: "terminal" | "chat";
  /** Agent key for a terminal; undefined means a plain shell. */
  agent?: string;
  /** False for a tool that is not on this computer; shown dimmed. */
  installed: boolean;
}

/** `enabled` says whether a provider is switched on in Providers (see providers.ts). */
export function newMenuItems(section: AppSection, agents: AgentInfo[], enabled: (key: string) => boolean, query: string): NewMenuItem[] {
  const items: NewMenuItem[] =
    section === "threads"
      ? [{ key: "chat", label: "Group chat", detail: "new thread", kind: "chat", installed: true }]
      : section === "code"
        ? [
            ...agents
              .filter((agent) => enabled(agent.key))
              .map((agent) => ({ key: agent.key, label: agent.label, detail: agent.found ? agent.program : "not installed", kind: "terminal" as const, agent: agent.key, installed: agent.found })),
            { key: "shell", label: "Terminal", detail: "your shell", kind: "terminal", installed: true },
          ]
        : [];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = items.filter((item) => words.every((word) => `${item.label} ${item.detail}`.toLowerCase().includes(word)));
  // Installed tools first, keeping their order; missing ones last.
  return [...matching.filter((item) => item.installed), ...matching.filter((item) => !item.installed)];
}
