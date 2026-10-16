import type { Backend } from "./backend";
import type { AgentInfo } from "./types";

/** Read the state needed to open Deck, refreshing available agents separately. */
export async function loadStartupState(backend: Backend, onAgents: (agents: AgentInfo[]) => void) {
  // Shell startup files and provider probes are not needed to restore chats.
  // Attach both outcomes now so late discovery failures are always handled.
  void (backend.machines ? backend.machines.discover() : backend.detectAgents())
    .then(onAgents, () => onAgents([]));
  const [folders, saved, savedSettings] = await Promise.all([
    backend.startupFolders().catch(() => []),
    backend.sessionLoad(),
    backend.settingsLoad().then(raw => ({ raw }), error => ({ error })),
  ]);
  return { folders, saved, savedSettings };
}
