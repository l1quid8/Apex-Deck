// Settings › Connection log: the phone's diagnostic log (phoneTrace.ts), newest at the bottom, with
// Copy so it can be pasted into a chat. Copy only runs when the person taps it.

import { useEffect, useState } from "react";
import { phoneTrace, traceText } from "./phoneTrace";

export function ConnectionLog({ covered }: { covered: boolean }) {
  const trace = phoneTrace();
  const [lines, setLines] = useState(trace.lines());
  const [copied, setCopied] = useState("");
  useEffect(() => trace.subscribe(() => setLines(trace.lines())), [trace]);
  const text = traceText(lines);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => setCopied("Copied"), () => setCopied("Couldn't copy"));
  };
  return (
    <main className="ph-content" inert={covered}>
      <h2>Connection log</h2>
      <p className="ph-intro">When the app leaves and comes back, each machine's connection, and how long each thread takes to load. Thread names and times only, no messages.</p>
      <div className="ph-log-actions">
        <button type="button" className="ph-log-btn" onClick={copy} disabled={!lines.length}>Copy log</button>
        <button type="button" className="ph-log-btn" onClick={() => { trace.clear(); setCopied(""); }} disabled={!lines.length}>Clear</button>
        {copied && <small role="status">{copied}</small>}
      </div>
      <pre className="ph-log">{text || "Nothing yet."}</pre>
    </main>
  );
}
