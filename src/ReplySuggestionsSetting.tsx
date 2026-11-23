import { useEffect, useState } from "react";
import type { Backend } from "./backend";
import { suggestionsMode, type SuggestionsMode } from "./replyDecision";

export function ReplySuggestionsSetting({ backend }: { backend: Backend }) {
  const [mode, setMode] = useState<SuggestionsMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true, changed = false;
    const sub = backend.onSettingsChanged?.(raw => {
      changed = true;
      if (live) setMode(suggestionsMode(raw));
    });
    void backend.call("settings_load").then(raw => {
      if (live && !changed) setMode(suggestionsMode(raw));
    }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; void sub?.then(off => off()).catch(() => {}); };
  }, [backend, revision]);
  async function save(next: SuggestionsMode) {
    setSaving(true); setError("");
    try {
      const result = await backend.call<{ mode: SuggestionsMode }>("settings_reply_suggestions_set", { mode: next });
      if (result.mode !== next) throw new Error("The Host did not confirm this change.");
      setMode(result.mode);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }
  return <div><select aria-label="Suggestions after a reply" disabled={saving || mode === null} value={mode ?? ""} onChange={e => void save(e.target.value as SuggestionsMode)}>
    {mode === null && <option value="">Loading…</option>}
    <option value="decision_card">Decision card</option><option value="next_steps">Next steps list</option><option value="off">Off</option>
  </select>{error && <span role="alert">{error} <button onClick={() => { setError(""); setRevision(n => n + 1); }}>Refresh</button></span>}</div>;
}
