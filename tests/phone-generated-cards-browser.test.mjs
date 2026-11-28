import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { build } from "vite";
import electron from "electron";
import { runElectronScenario } from "./helpers/electron-test.mjs";

// Exercise the trusted React component and real DOM geometry. Its native boundary is recorded.
const entry = `
  import React from "react";
  import { createRoot } from "react-dom/client";
  import { PhoneGeneratedCard } from "/src/phone/PhoneGeneratedCard.tsx";
  const card = {schemaVersion:1,kind:"generated",cardId:"counter",title:"Counter",html:"<button>widget</button>",js:"",css:"",summary:"Count",fallback:"Fallback"};
  const root = createRoot(document.querySelector("#root"));
  window.renderCard = hostId => root.render(React.createElement(PhoneGeneratedCard, {
    card, hostId, threadId:"thread", messageId:"reply", onDiscuss:text => window.draft = text
  }));
  window.renderCard("host");
`;
const bridge = `
  export const Capacitor = {getPlatform: () => "ios", isPluginAvailable: () => true};
  window.mounts = [];
  window.disposals = [];
  window.layouts = [];
  export const registerPlugin = () => ({
    capability: async () => ({enabled:true}),
    mount: async request => {window.mounts.push(request)},
    dispose: async ({runId}) => {window.disposals.push(runId)},
    layout: async request => {window.layouts.push(request)},
    addListener: async (_, cb) => {window.emitCard = cb;return {remove: async () => {}}}
  });
`;

async function scenario() {
  const { app, BrowserWindow } = require("electron");
  const assert = require("node:assert/strict");
  const path = require("node:path");
  await app.whenReady();
  const win = new BrowserWindow({show:false, webPreferences:{offscreen:true}});
  const read = code => win.webContents.executeJavaScript(code);
  async function until(expression) {
    for (let i = 0; i < 200; i++) {
      if (await read(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error("Timed out waiting for " + expression);
  }
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    await until("mounts.length === 1");
    assert.equal(await read("document.body.textContent.includes('Fallback')"), false);
    await read("renderCard('host')");
    await read("new Promise(resolve => setTimeout(resolve, 250))");
    assert.equal(await read("mounts.length"), 1, "ordinary rerenders preserve the run");
    await read("emitCard({runId:mounts[0].runId,type:'discuss',text:'Before scroll'})");
    await until("document.querySelector('pre')?.textContent === 'Before scroll'");
    await read("emitCard({runId:mounts[0].runId,type:'preview',image:'data:image/jpeg;base64,AAAA'})");
    await until("Boolean(document.querySelector('.generated-snapshot'))");
    await read("document.querySelector('main').scrollTop=40");
    await until("layouts.some(layout => layout.scrollTop === 40)");
    const [mount, layout] = await read("[mounts[0], layouts.find(layout => layout.scrollTop === 40)]");
    assert.equal(layout.runId, mount.runId);
    assert.equal(layout.bounds.y + layout.scrollTop, mount.bounds.y + mount.scrollTop);
    assert.deepEqual(layout.viewport, mount.viewport);
    assert.ok(layout.clip.y >= layout.viewport.y);
    await read("document.querySelector('main').scrollTop=900");
    await until("disposals.includes(mounts[0].runId)");
    await read("document.querySelector('main').scrollTop=0");
    await until("mounts.length === 2");
    assert.equal(await read("document.querySelector('.generated-discuss')"), null);
    await read("emitCard({runId:mounts[0].runId,type:'preview',image:''})");
    assert.ok(await read("Boolean(document.querySelector('.generated-snapshot'))"), "a disposed run cannot erase the preview");
    await read("emitCard({runId:mounts[1].runId,type:'preview',image:''})");
    await until("!document.querySelector('.generated-snapshot')");
    assert.notEqual(await read("mounts[0].runId"), await read("mounts[1].runId"));
    await read("emitCard({runId:mounts[0].runId,type:'discuss',text:'Old'});emitCard({runId:mounts[1].runId,type:'discuss',text:'Current'})");
    await until("document.querySelector('pre')?.textContent === 'Current'");
    assert.equal(await read("window.draft"), undefined);
    await read("document.querySelector('button').click()");
    assert.equal(await read("window.draft"), "Current");
    await read("emitCard({runId:mounts[1].runId,type:'suspended'})");
    await until("disposals.includes(mounts[1].runId)");
    await read("emitCard({runId:'',type:'resumed'})");
    await until("mounts.length === 3");
    await read("emitCard({runId:mounts[2].runId,type:'fault'})");
    await until("document.querySelector('.generated-fallback')");
    await read("document.querySelector('button').click()");
    await until("mounts.length === 4");
    await read("renderCard(undefined)");
    await until("disposals.includes(mounts[3].runId)");
    assert.equal(await read("document.querySelector('button')"), null);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

test("phone chat disposes hidden or unauthorized cards and accepts discussion only for the current run", {timeout:60000}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apex-phone-card-"));
  try {
    const output = await build({configFile:false, logLevel:"error",
      plugins:[{
        name:"phone-card-fixture",
        enforce:"pre",
        resolveId(id) { if (id.endsWith("phone-fixture")) return "\0phone-fixture"; if (id === "@capacitor/core") return "\0" + id; },
        load(id) { if (id === "\0phone-fixture") return entry; if (id === "\0@capacitor/core") return bridge; },
      }],
      build:{write:false, lib:{entry:"phone-fixture", name:"PhoneFixture", formats:["iife"]}},
      define:{"process.env.NODE_ENV":JSON.stringify("production")},
    });
    const chunk = (Array.isArray(output) ? output[0] : output).output.find(item => item.type === "chunk");
    await writeFile(path.join(temp, "fixture.js"), chunk.code);
    await writeFile(path.join(temp, "index.html"), '<main class="ph-chat" style="height:420px;overflow:auto;scrollbar-width:none"><div id="root"></div><div style="height:1200px"></div></main><script src="fixture.js"></script>');
    const main = path.join(temp, "main.cjs");
    await writeFile(main, "(" + scenario.toString() + ")()");
    const result = await runElectronScenario(electron, main, temp, {attempts:1,timeoutMs:30000});
    assert.equal(result.code, 0, result.output);
  } finally {
    await rm(temp, {recursive:true,force:true});
  }
});
