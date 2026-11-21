import { useEffect, useRef, useState } from "react";
import type { Backend } from "../backend";
import type { GitOutcome, GitState } from "../gitChanges";
import type { RemoteAccess } from "../phoneRules";
import { ThreadGitActions, type ThreadGitAction } from "../ThreadGitActions";

// Protected Git writes require a paired device with a Full, all-threads grant.
export const canUseThreadGit = (access: RemoteAccess | null) =>
  access?.tier === "full" && access.threads === "all";

export function PhoneThreadGit({ backend, room }: { backend: Backend; room: string }) {
  const [state, setState] = useState<GitState | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    let live = true;
    let reading = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (document.hidden || reading || writing.current) return;
      clearTimeout(timer);
      reading = true;
      const ticket = revision.current;
      let delay = 5000;
      try {
        const next = await backend.call<GitState>("room_git_status", { id: room });
        if (live && ticket === revision.current) setState(next);
        if (!next.workflow) delay = 30000;
      } catch {
        // Keep the last known Git state and any active error visible across transient poll failures.
      } finally {
        reading = false;
        if (live) timer = setTimeout(refresh, delay);
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [backend, room, busy]);

  async function perform(kind: ThreadGitAction) {
    if (!state || writing.current) return;
    writing.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      const action = { kind, expected: { ...state, files: [] } };
      const result = await backend.call<GitOutcome>("room_thread_git_action", { id: room, action });
      setState(result.state);
      setStatus(result.message);
    } catch (reason) {
      setError(String(reason));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return <div className="ph-thread-git"><ThreadGitActions state={state} blocked={busy} perform={perform} status={status} error={error} /></div>;
}
