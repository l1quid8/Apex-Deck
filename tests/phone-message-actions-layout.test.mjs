import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import electron from "electron";
import { createServer } from "vite";
import { runElectronScenario } from "./helpers/electron-test.mjs";

register(new URL("./helpers/tsx-loader.mjs", import.meta.url), { parentURL: import.meta.url });
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MessageActions } = await import("../src/phone/MessageActions.tsx");
const noop = () => {};

function measureRows() {
  return [...document.querySelectorAll(".ph-said")].map(row => {
    const bounds = row.getBoundingClientRect();
    const items = [...row.querySelectorAll(".msg-action,.message-time")].filter(el => el.getClientRects().length).map(el => {
      const r = el.getBoundingClientRect();
      return { cls: el.className, left: r.left, right: r.right, mid: (r.top + r.bottom) / 2, width: r.width, clipped: el.scrollWidth > el.clientWidth + 1 };
    });
    return { name: row.dataset.case, left: bounds.left - 9, right: bounds.right + 9, items };
  });
}

test("phone tools and timestamp share one line, including expanded and Copied states", { timeout: 150000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-action-layout-"));
  const rows = [];
  for (const mine of [false, true]) for (const expanded of [false, true]) for (const copied of [false, true]) {
    const message = { seq: rows.length, speaker: mine ? { kind: "human" } : { kind: "bot", id: "null" }, text: "A message.", at: new Date(2026, 8, 30, 12, 59).getTime() };
    const actions = renderToStaticMarkup(React.createElement(MessageActions, {
      message, who: "Null", shown: message.text, expanded, copied, onToggle: noop, onCopy: noop, onQuote: noop,
      pinned: true, pinning: false, onPin: noop, busy: false, onGoBack: noop, onFork: noop, asking: false,
    }));
    rows.push(`<div class="ph-said${mine ? " mine" : ""}" data-case="${mine ? "human" : "bot"} ${expanded ? "open" : "closed"} ${copied ? "copied" : "copy"}"><div class="ph-msg">A message.</div>${actions}</div>`);
  }
  const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div class="ph-app"><div class="phone-frame"><div class="ph-content ph-chat">${rows.join("")}</div></div></div><script type="module">import '/src/styles.css'; import '/src/glass-theme.css'; import '/src/clay-theme.css'; import '/src/phone/phone.css'; import '/src/phone/phone-themes.css'; window.ready = true;</script></body></html>`;
  const server = await createServer({
    cacheDir: path.join(temp, "vite-cache"), server: { port: 0 }, logLevel: "error",
    plugins: [{ name: "phone-action-layout", configureServer(server) {
      server.middlewares.use("/__phone-action-layout", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml("/__phone-action-layout", html));
      });
    } }],
  });
  try {
    await server.listen();
    const url = `http://localhost:${server.httpServer.address().port}/__phone-action-layout`;
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(main, `
      const {app,BrowserWindow}=require('electron');
      const assert=require('node:assert/strict');
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,width:440,height:1000,webPreferences:{contextIsolation:true,sandbox:true}});
        const run=code=>win.webContents.executeJavaScript(code);
        try{
          await win.loadURL(${JSON.stringify(url)});
          for(let i=0;i<200 && !await run('!!window.ready');i++) await new Promise(r=>setTimeout(r,20));
          assert.equal(await run('!!window.ready'),true,'fixture renders');
          for(const width of [320,360,375,402,440]){
            win.setContentSize(width,1000);
            await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
            const rows=await run('('+${JSON.stringify(measureRows.toString())}+')()');
            for(const row of rows){
              const where=width+'px '+row.name+' '+JSON.stringify(row.items);
              assert.ok(Math.max(...row.items.map(i=>i.mid))-Math.min(...row.items.map(i=>i.mid))<1,'all tools and time share one line: '+where);
              assert.equal(row.items.length,row.name.includes('open')?(row.name.startsWith('human')?7:8):4,'only the requested tools are exposed: '+where);
              for(const item of row.items){
                assert.ok(item.left>=row.left-.5 && item.right<=row.right+.5,'item fits phone: '+where);
                assert.equal(item.clipped,false,'labels and timestamp stay readable: '+where);
                if(item.cls.includes('msg-action')) assert.ok(item.width>=32,'tap target stays at least 32px: '+where);
              }
            }
          }
          app.exit(0);
        }catch(error){console.error(error.stack);app.exit(1);}
      });
    `);
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
