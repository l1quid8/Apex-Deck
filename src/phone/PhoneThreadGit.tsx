import { useEffect, useRef, useState } from "react";
import type { Backend } from "../backend";
import type { GitOutcome, GitState } from "../gitChanges";
import { ThreadGitActions, type ThreadGitAction } from "../ThreadGitActions";

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
      // Cancel and Ask agent to fix name the merge request; Push and Merge carry this folder's state.
      const flow = state.workflow;
      const key = flow && { root: flow.root, branch: flow.branch, repo: flow.repo, head: flow.head, generation: flow.generation };
      const action = kind === "cancel_merge" || kind === "ask_fix"
        ? (key ? { kind, expected: key } : null)
        : { kind, expected: { ...state, files: [] } };
      if (!action) throw new Error("Refresh the Git actions.");
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
