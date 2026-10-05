import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { Backend } from "./backend";
import { connection } from "./connection";
import { pathPrompt, pathProblem } from "./typedPath";

/** Asks for a path on a host on another machine, and checks it's there before closing. */
export function PathPrompt({ backend }: { backend: Backend }) {
  const request = useSyncExternalStore(pathPrompt.subscribe, pathPrompt.get);
  const { host } = useSyncExternalStore(connection.subscribe, connection.get);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setText("");
    setProblem("");
    setChecking(false);
    input.current?.focus();
  }, [request]);
  if (!request) return null;
  const what = request.kind === "directory" ? "Folder" : "File";
  const cancel = () => pathPrompt.answer(null);
  const choose = async () => {
    const wrong = pathProblem(text);
    if (wrong) return setProblem(wrong);
    setChecking(true);
    const [there] = await backend.pathsExist([text.trim()], null).catch(() => [false]);
    setChecking(false);
    if (!there) return setProblem(`Nothing is at ${text.trim()} on ${host}.`);
    pathPrompt.answer(text);
  };
  return (
    <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <form className="confirm path-prompt" role="dialog" aria-modal="true" aria-labelledby="path-prompt-title"
        onSubmit={(event) => { event.preventDefault(); void choose(); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
        <strong id="path-prompt-title">{what} on {host}</strong>
        <p className="muted">{request.title}. Type its full path on {host}.</p>
        <input ref={input} className="mono" value={text} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          placeholder={request.kind === "directory" ? "/home/me/project" : "/home/me/file"} aria-label={`${what} path on ${host}`}
          aria-invalid={problem ? true : undefined} aria-describedby={problem ? "path-prompt-problem" : undefined}
          onChange={(event) => { setText(event.target.value); setProblem(""); }} />
        {problem && <span id="path-prompt-problem" className="error" role="alert">{problem}</span>}
        <div className="confirm-actions">
          <button type="button" onClick={cancel}>Cancel</button>
          <button type="submit" className="primary" disabled={checking}>{checking ? "Checking…" : "Choose"}</button>
        </div>
      </form>
    </div>
  );
}
