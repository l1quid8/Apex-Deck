import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { runElectronScenario } from "./helpers/electron-test.mjs";

// The pop-out header at the window's 360px minimum width (desktop/main.mjs
// createPopout), rendered in real Chromium with the real stylesheets. The
// markup mirrors PopoutApp's chat header, with ChatPane's Artifacts and
// Changes counts portalled into .pane-counts as they are in the window.
// 88px of the bar belongs to the macOS traffic lights, so at 360px the
// title must truncate and the controls must still fit — above all Return
// to Deck, the only way back.
function measure() {
  const rect = (el) => el.getBoundingClientRect().toJSON();
  const bar = document.querySelector(".popout-bar");
  const title = bar.querySelector(".popout-title");
  const counts = [...bar.querySelectorAll(".thread-counts button")];
  return {
    innerWidth: window.innerWidth,
    bar: { clientWidth: bar.clientWidth, scrollWidth: bar.scrollWidth, rect: rect(bar) },
    title: { rect: rect(title), clientWidth: title.clientWidth, scrollWidth: title.scrollWidth },
    sub: rect(bar.querySelector(".popout-sub")),
    counts: counts.map((button) => ({
      label: button.getAttribute("aria-label"),
      rect: rect(button),
      icon: getComputedStyle(button.querySelector(".count-icon")).display,
      words: getComputedStyle(button.querySelector(".count-label")).display,
    })),
    details: rect(bar.querySelector(".popout-btn")),
    menu: rect(bar.querySelector('[aria-label="Thread menu"]')),
    back: rect(bar.querySelector(".popout-return")),
  };
}

test("pop-out bar fits its 360px minimum width with both counts populated", { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "popout-bar-layout-"));
  const html = `<html><body><div class="popout"><header class="popout-bar">
    <span class="popout-title" title="A very long thread title that must truncate · Muck is working…">A very long thread title that must truncate</span>
    <span class="popout-sub">Muck is working…</span>
    <span class="pane-counts"><div class="thread-counts">
      <button class="ghost small" aria-pressed="false" aria-label="Artifacts · 3" title="Artifacts"><svg class="count-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M9 14l-2 2 2 2m6-4 2 2-2 2" /></svg><span class="count-label">Artifacts · </span>3</button>
      <button class="ghost small" aria-label="Changes · 12" title="Changes"><svg class="count-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 4v8M8 8h8M8 18h8" /></svg><span class="count-label">Changes · </span>12</button>
    </div></span>
    <span class="spacer"></span>
    <button class="popout-btn" aria-pressed="false" title="Thread details">Details</button>
    <button class="popout-btn" aria-label="Thread menu" aria-haspopup="menu">⋯</button>
    <button class="popout-return" title="Put this back in the Deck window">Return to Deck</button>
  </header></div>
  <script type="module">import '/src/styles.css'; import '/src/popout.css'; window.ready = true;</script></body></html>`;
  // Its own dependency cache, as in chat-attach-component.test.mjs: parallel
  // Vite servers race on a shared one.
  const server = await createServer({
    cacheDir: path.join(temp, "vite-cache"),
    server: { port: 0 },
    logLevel: "error",
    plugins: [{
      name: "popout-bar-layout-test",
      configureServer(server) {
        server.middlewares.use("/__popout_bar_layout_test", async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__popout_bar_layout_test", html));
        });
      },
    }],
  });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__popout_bar_layout_test`;
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:800,height:600,titleBarStyle:'hiddenInset',webPreferences:{contextIsolation:true,sandbox:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      try {
        await win.loadURL(${JSON.stringify(url)});
        for(let i=0;i<200;i++){ if(await run("!!window.ready")) break; await new Promise(r=>setTimeout(r,20)); }
        assert.equal(await run("!!window.ready"),true,'fixture must render');
        const at=async width=>{
          win.setContentSize(width,600);
          await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          return run('('+${JSON.stringify(measure.toString())}+')()');
        };
        for(const width of [360,480,800]){
          const s=await at(width);
          const seen=width+'px: '+JSON.stringify(s);
          assert.ok(s.innerWidth<=width,'content is no wider than asked: '+seen);
          assert.ok(s.bar.scrollWidth<=s.bar.clientWidth+1,'bar does not overflow: '+seen);
          for(const [name,r] of [['Title',s.title.rect],['Status',s.sub],['Details',s.details],['Thread menu',s.menu],['Return to Deck',s.back],...s.counts.map(c=>[c.label,c.rect])]){
            assert.ok(r.width>0 && r.left>=0 && r.right<=s.innerWidth+0.5,name+' fits the window: '+seen);
          }
          if(width<800){
            // Two rows: title, status and counts above; the buttons below.
            for(const c of s.counts) assert.ok(c.rect.top<s.title.rect.bottom && c.rect.bottom>s.title.rect.top,c.label+' shares the title row: '+seen);
            assert.ok(s.back.top>=s.title.rect.bottom,'Return to Deck wraps below the title: '+seen);
          }
          if(width===360){
            assert.ok(s.title.scrollWidth>s.title.clientWidth,'long title truncates instead of pushing controls out: '+seen);
            for(const c of s.counts){
              assert.equal(c.words,'none',c.label+' drops its label at minimum width: '+seen);
              assert.notEqual(c.icon,'none',c.label+' keeps its icon at minimum width: '+seen);
            }
          }
          if(width===800){
            assert.ok(s.back.top<s.title.rect.bottom && s.back.bottom>s.title.rect.top,'wide bar stays one row: '+seen);
            for(const c of s.counts) assert.notEqual(c.words,'none',c.label+' keeps its label when wide: '+seen);
          }
        }
        console.log('Pop-out bar fits 360px, 480px and 800px with both counts populated');
        app.exit(0);
      }catch(error){console.error(error.stack);app.exit(1);}
    });
  `);
  try {
    const result = await runElectronScenario(electron, main, temp);
    assert.equal(result.code, 0, result.output);
  } finally {
    await server.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
