// One mod's Web Worker: runs the runtime and speaks to the window by message.

import { loadMod, type LoadedMod } from "./runtime";

let mod: LoadedMod | null = null;
let calls = 0;
const waiting = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void }>();
const post = (message: unknown) => (self as unknown as Worker).postMessage(message);

self.onmessage = async (event: MessageEvent) => {
  const m = event.data;
  switch (m.type) {
    case "load":
      try {
        mod = loadMod({
          files: m.files,
          modules: m.modules,
          options: m.options,
          name: m.name,
          host: {
            call: (method, args) => new Promise((done, fail) => {
              const id = ++calls;
              waiting.set(id, { done, fail });
              post({ type: "call", id, method, args });
            }),
            command: (spec) => post({ type: "command", spec }),
            open: (pane) => post({ type: "open", pane }),
            close: (id) => post({ type: "close", id }),
            tree: (id, tree) => post({ type: "tree", id, tree }),
            status: (text) => post({ type: "status", text }),
            toast: (text) => post({ type: "toast", text }),
            error: (message) => post({ type: "error", message }),
          },
        });
        await mod.dispatch("session.start", {});
        post({ type: "ready" });
      } catch (error) {
        post({ type: "failed", message: error instanceof Error ? error.message : String(error) });
      }
      break;
    case "reply": {
      const call = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error !== undefined) call?.fail(new Error(m.error));
      else call?.done(m.value);
      break;
    }
    case "command": {
      const out = await mod?.dispatch("command.run", m.event);
      post({ type: "commandResult", id: m.id, result: out ?? {} });
      break;
    }
    case "event": {
      const out = await mod?.dispatch(m.name, m.event);
      if (m.id) post({ type: "eventResult", id: m.id, result: out ?? null });
      break;
    }
    case "press":
      await mod?.press(m.pane, m.fn, m.args);
      break;
    case "resize":
      mod?.resize(m.pane, m.columns);
      break;
    case "closed":
      await mod?.closed(m.pane);
      break;
  }
};
