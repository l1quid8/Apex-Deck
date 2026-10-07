import { useEffect, useRef, useState } from "react";
import { registerPlugin } from "@capacitor/core";
const native = registerPlugin<{ probe(input: { op: string; mode?: string; address?: string }): Promise<{ id?: string; route?: string; rttMs?: number }> }>("IrohSpike");

/** Debug-only native echo harness. Not an authenticated production transport. */
export function IrohSpike() {
  const [id, setId] = useState("");
  const [address, setAddress] = useState("");
  const [mode, setMode] = useState("automatic");
  const [status, setStatus] = useState("Start to get the phone ID, then approve it on the beta relay.");
  const [running, setRunning] = useState(false);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!running) return;
    const g = generation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function ping() {
      try {
        const result = await native.probe({ op: "ping" });
        if (!stopped && g === generation.current) setStatus(`${result.route}: ${result.rttMs?.toFixed(0)} ms`);
      } catch (e) {
        if (!stopped) { setStatus(String(e)); setRunning(false); }
      }
      if (!stopped) timer = setTimeout(ping, 1000);
    }
    void ping();
    return () => { stopped = true; clearTimeout(timer); };
  }, [running]);
  useEffect(() => () => { generation.current++; void native.probe({ op: "stop" }); }, []);
  async function action(op: "start" | "connect" | "stop") {
    setBusy(true);
    setRunning(false);
    generation.current++;
    try {
      const result = await native.probe({ op, mode, address });
      if (result.id) { setId(result.id); setStatus("Phone ready. Approve this ID on the relay before connecting."); }
      else if (op === "connect") { setStatus(result.route ?? "Connected"); setRunning(true); }
      else setStatus("Stopped");
    } catch (e) { setStatus(String(e)); }
    finally { setBusy(false); }
  }
  return <main style={{ padding: "calc(env(safe-area-inset-top) + 24px) 20px", overflow: "auto", height: "100dvh" }}>
    <h2>Remote connection test</h2>
    <p>Echo tests only. Existing machines and conversations are unaffected.</p>
    <label>Mode <select value={mode} disabled={busy || running} onChange={e => { setMode(e.target.value); setId(""); }}>
      <option value="automatic">Automatic</option><option value="direct">Direct only</option>
    </select></label>
    <p>Direct only requires a reachable IP and UDP port. It never uses the relay.</p>
    <button disabled={busy} onClick={() => void action("start")}>Start endpoint</button>
    <p style={{ overflowWrap: "anywhere", userSelect: "text" }}>{id}</p>
    {id && <button onClick={() => void navigator.clipboard.writeText(id)}>Copy phone ID</button>}
    <p><label>Host address from spike listener<br /><textarea value={address} onChange={e => setAddress(e.target.value)} rows={7} style={{ width: "100%" }} /></label></p>
    <button disabled={busy || !id || !address} onClick={() => void action("connect")}>Connect and ping</button>{" "}
    <button disabled={busy} onClick={() => void action("stop")}>Stop</button>
    <p role="status">{status}</p>
  </main>;
}
