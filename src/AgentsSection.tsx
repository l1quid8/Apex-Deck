import { ChatPane } from "./ChatPane";
import type { Backend } from "./backend";
import type { AgentInfo, ParticipantConfig } from "./types";

export function AgentsSection({ agents, backend, profiles, disabledProviders, onChange }: {
  agents: AgentInfo[]; backend: Backend; profiles: ParticipantConfig[]; disabledProviders: string[]; onChange: (profiles: ParticipantConfig[]) => void;
}) {
  return <section className="agents-section">
    <header className="section-intro">
      <span className="eyebrow">Your reusable thinking team</span>
      <h1>Your agents</h1>
      <p>Give each bot a name, a model, and a brief. Add it to any group chat.</p>
    </header>
    <ChatPane pane={{ id: "agent-library", workspaceId: "", kind: "chat", title: "Agents" }} cwd="" agents={agents} backend={backend} profiles={profiles} disabledProviders={disabledProviders} onProfilesChange={onChange} profileMode focused={false} onActivity={() => {}} />
  </section>;
}
