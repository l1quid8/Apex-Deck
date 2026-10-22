import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { runElectronScenario } from "./helpers/electron-test.mjs";

test("desktop calls wait for an explicit singleton thread choice", { timeout: 150000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-voice-ui-"));
  const coordinatorId = "\0desktop-voice-coordinator";
  const coordinator = `
    let state = { status: "off", muted: false, voices: ["am_michael"] };
    const listeners = new Set();
    const emit = () => listeners.forEach((fn) => fn());
    export const local = { hostId: "h", roomId: "local", participantId: "j", profileId: "j", name: "Jigga", aliases: [], roomTitle: "iOS review" };
    const elsewhere = { ...local, roomId: "voice", roomTitle: "Voice calls" };
    export const settings = { enabled: true, look: "pill", silenceMs: 100, preferences: {} };
    window.starts = [];
    window.switched = [];
    export const voiceController = {
      getState: () => state,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      start: async (scope) => { window.starts.push(scope); state = { ...state, status: "listening", scope, startedAt: Date.now() }; emit(); },
      switchAgent: async (scope) => { window.switched.push(scope); state = { ...state, status: "listening", scope, candidates: undefined, threadQuery: undefined, error: undefined }; emit(); },
      end: async () => { state = { ...state, status: "off", scope: undefined }; emit(); },
    };
    export const voiceRegistration = () => ({ settings, save() {} });
    export const warmVoice = () => {};
    window.askThread = () => {
      state = { ...state, status: "needs-attention", error: "Choose which thread to call.", threadQuery: "voise call", candidates: [elsewhere] };
      emit();
    };
  `;
  const html = `<html><body><div id="root"></div><script type="module">
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { VoiceCallControls } from "/src/voice/VoiceCallControls.tsx";
    import { local, settings } from "fixture:desktop-voice-coordinator";
    window.apexDeck = { voice: { status: async () => ({ downloadBytes: 0 }), onProgress: () => () => {} } };
    createRoot(document.getElementById("root")).render(React.createElement(VoiceCallControls, { candidates: [local], settings }));
  </script></body></html>`;
  const server = await createServer({
    cacheDir: path.join(temp, "cache"),
    server: { port: 0 },
    logLevel: "error",
    plugins: [{
      name: "desktop-voice-fixture",
      transform(code, id) {
        if (id.split("?")[0].endsWith("/src/voice/VoiceCallControls.tsx"))
          return code.replace('from "./coordinator.ts"', 'from "fixture:desktop-voice-coordinator"');
      },
      resolveId(id) {
        if (id === "fixture:desktop-voice-coordinator") return coordinatorId;
      },
      load(id) { if (id === coordinatorId) return coordinator; },
      configureServer(s) {
        s.middlewares.use("/__desktop_voice_ui", async (_q, r) => {
          r.setHeader("Content-Type", "text/html");
          r.end(await s.transformIndexHtml("/__desktop_voice_ui", html));
        });
      },
    }],
  });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__desktop_voice_ui`;
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `
    const { app, BrowserWindow } = require("electron");
    const assert = require("node:assert/strict");
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, width: 900, height: 700 });
      const run = (script) => win.webContents.executeJavaScript(script);
      const wait = async (script) => {
        for (let i = 0; i < 100; i++) {
          if (await run(script)) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw Error("Timed out " + script);
      };
      try {
        await win.loadURL(${JSON.stringify(url)});
        await wait('!!document.querySelector(".voice-mic")');
        assert.equal(await run('document.querySelector(".voice-mic").getAttribute("aria-label")'), "Call an agent");
        await run('document.querySelector(".voice-mic").click()');
        await wait('!!document.querySelector(".voice-pill")');
        assert.equal(await run('window.starts.length'), 1, "one ordinary local agent starts immediately");
        assert.equal(await run('!!document.querySelector(".voice-pick")'), false);
        await run('window.askThread()');
        await wait('document.querySelector(".voice-pick")?.getAttribute("aria-label") === "Which thread?"');
        assert.equal(await run('document.querySelector(".voice-pop-head").textContent'), "Which thread?");
        assert.equal(await run('document.querySelector(".voice-pick").textContent.includes("voise call")'), true, "the heard thread is visible");
        assert.equal(await run('document.querySelectorAll(".voice-pick-row").length'), 1);
        assert.equal(await run('document.querySelector(".voice-pick-row").title'), "Voice calls");
        assert.equal(await run('document.querySelector(".voice-pick-row span").textContent'), "Voice calls");
        assert.equal(await run('document.querySelector(".voice-pick").textContent.includes("call Jigga in Voice calls")'), true);
        assert.equal(await run('window.switched.length'), 0, "an uncertain singleton waits for a choice");
        await run('document.querySelector(".voice-pick-row").click()');
        await wait('window.switched.length === 1 && !document.querySelector(".voice-pick")');
        assert.deepEqual(await run('({ hostId: window.switched[0].hostId, roomId: window.switched[0].roomId, participantId: window.switched[0].participantId })'), { hostId: "h", roomId: "voice", participantId: "j" });
        assert.equal(await run('window.starts.length'), 1, "choosing another thread moves the active call");
        app.exit(0);
      } catch (e) {
        console.error(e.stack);
        app.exit(1);
      }
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
