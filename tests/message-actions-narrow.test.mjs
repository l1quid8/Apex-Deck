import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { runElectronScenario } from "./helpers/electron-test.mjs";

// Narrow threads, rendered in real Chromium with the real stylesheets. Three
// threads side by side in a 1512px window, with the side panel open, leave
// 299px panes, and a pane can be squeezed to a tenth of a split. The markup
// mirrors ChatPane: messageActions for the row under each message, and the
// live row for a reply still being written.
const icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4Z"></path></svg>';
const button = (cls, label, extra = "") => `<button type="button" class="msg-action ${cls}" title="${label}" aria-label="${label}"${extra}>${icon}</button>`;
const chevron = (expanded) => `<button type="button" class="msg-action action-disclosure" aria-label="${expanded ? "Hide" : "Show"} message actions" aria-expanded="${expanded}">${icon}</button>`;
const time = (text) => `<time class="message-time" datetime="2026-10-14T05:33:00.000Z">${text}</time>`;
const identicon = (state = "") => `<span class="identicon battery identicon-md ${state}" aria-hidden="true" style="--who: #2dd4bf;">${"<i></i>".repeat(25)}</span>`;
const botRow = (when, expanded) => `<div class="bot-row message-row" data-case="bot ${expanded ? "open" : "closed"} ${when}">${identicon()}
  <div class="bubble bot completed" style="--agent-color: #2dd4bf;"><span class="speaker">Muck</span>Done.</div>
  <span class="message-actions collapsed-actions">
    <span class="message-primary-actions">${button("quote", "Quote response from Muck")}${button("copy", "Copy message")}${button("read-aloud", "Read aloud", ' aria-pressed="false"')}${button("pin-action", "Pin response", ' aria-pressed="false"')}</span>
    ${expanded ? `<span class="message-action-items">${button("retry", "Retry")}${button("fork", "Fork from here")}</span>` : ""}
    ${chevron(expanded)}${time(when)}
  </span></div>`;
const humanRow = (when, expanded) => `<div class="message-row human-row" data-case="human ${expanded ? "open" : "closed"} ${when}">
  <span class="message-actions collapsed-actions">
    ${time(when)}${chevron(expanded)}
    ${expanded ? `<span class="message-action-items">${button("fork", "Fork from here")}${button("revert", "Revert to here")}</span>` : ""}
    <span class="message-primary-actions">${button("pin-action", "Pin your message", ' aria-pressed="false"')}${button("copy", "Copy message")}${button("quote", "Quote your message")}</span>
  </span>
  <div class="bubble human">Ok.</div></div>`;
// messageTime's two forms: within a week, and the longest older one.
const WHEN = ["Wednesday 12:59 PM", "September 30th, 2026 @ 12:59 PM"];
const finished = WHEN.flatMap((when) => [botRow(when, false), botRow(when, true), humanRow(when, false), humanRow(when, true)]).join("");
// A reply still being written: short so far, so its 260px floor sets its width.
const live = `<div class="bot-row">${identicon("working")}<div class="bubble bot writing" aria-busy="true" data-activity="working" style="--agent-color: #2dd4bf;">
  <span class="speaker">Muck</span><ul class="steps" aria-label="Steps so far"><li class="step current">Running: ls</li></ul>
  <div class="draft-text"><div class="md"><p>Ok.</p></div></div>
  <div class="working-line" role="status"><span class="working-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>Working</span><span class="working-time">4s</span></div>
</div></div>`;

// Every theme mode (classic, flat, glass for BW and White, clay), from a tenth of a split up to a roomy pane.
const THEMES = ["", "flat", "glass", "clay"];
const WIDTHS = [220, 260, 299, 320, 360, 440, 480, 760];

function contentBox() {
  const t = document.querySelector(".transcript");
  const box = t.getBoundingClientRect();
  const style = getComputedStyle(t);
  return { offsetWidth: t.offsetWidth, clientWidth: t.clientWidth, scrollWidth: t.scrollWidth, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight, content: [box.left + parseFloat(style.paddingLeft), box.left + t.clientWidth - parseFloat(style.paddingRight)] };
}

function measureRows() {
  return {
    rows: [...document.querySelectorAll(".transcript .message-row")].map((row) => {
      const actions = row.querySelector(":scope > .message-actions");
      const a = actions.getBoundingClientRect();
      const items = [...actions.querySelectorAll(".msg-action, .message-time")].map((el) => {
        const r = el.getBoundingClientRect();
        return { cls: el.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, clipped: el.scrollWidth > el.clientWidth + 1 };
      });
      return { name: row.dataset.case, human: row.classList.contains("human-row"), left: a.left, right: a.right, height: a.height, items };
    }),
  };
}

function measureLive() {
  const r = document.querySelector(".transcript .bubble.writing").getBoundingClientRect();
  return { bubble: { left: r.left, right: r.right, width: r.width } };
}

/** Render `body` in a thread at each theme and width; `checks` asserts on each measurement in Electron's main process. */
async function inThreads(name, body, measure, checks) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  // As in a thread: the pane sets .chat-body's width, and the transcript fills it.
  const html = `<html><body style="margin: 0"><div class="chat-body" style="height: 1400px"><div class="transcript">${body}</div></div>
  <script type="module">import '/src/styles.css'; import '/src/glass-theme.css'; import '/src/clay-theme.css'; window.ready = true;</script></body></html>`;
  // Its own dependency cache: parallel Vite servers race on a shared one.
  const server = await createServer({
    cacheDir: path.join(temp, "vite-cache"),
    server: { port: 0 },
    logLevel: "error",
    plugins: [{
      name: `${name}-test`,
      configureServer(server) {
        server.middlewares.use(`/__${name}`, async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(`/__${name}`, html));
        });
      },
    }],
  });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__${name}`;
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:900,height:1500,webPreferences:{offscreen:true,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      const run=code=>win.webContents.executeJavaScript(code);
      try {
        await win.loadURL(${JSON.stringify(url)});
        for(let i=0;i<200;i++){ if(await run("!!window.ready")) break; await new Promise(r=>setTimeout(r,20)); }
        assert.equal(await run("!!window.ready"),true,'fixture must render');
        for(const theme of ${JSON.stringify(THEMES)}){
          await run('(()=>{const r=document.documentElement; if('+JSON.stringify(theme)+') r.dataset.deckTheme='+JSON.stringify(theme)+'; else delete r.dataset.deckTheme; return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()');
          for(const width of ${JSON.stringify(WIDTHS)}){
            const s=await run('(()=>{document.querySelector(".chat-body").style.width="'+width+'px"; return {...('+${JSON.stringify(contentBox.toString())}+')(),...('+${JSON.stringify(measure.toString())}+')()};})()');
            const where=(theme||'classic')+' at '+width+'px (thread '+s.offsetWidth+' wide, '+s.clientWidth+' inside, content '+JSON.stringify(s.content)+', '+s.scrollHeight+' tall in '+s.clientHeight+')';
            assert.ok(s.scrollWidth<=s.clientWidth,where+': the thread must not scroll sideways ('+s.scrollWidth+' > '+s.clientWidth+')');
            const inside=(r)=>r.left>=s.content[0]-0.5 && r.right<=s.content[1]+0.5;
            (${checks.toString()})(s,width,theme,where,inside,assert);
          }
        }
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
}

test("the row under a message wraps inside a narrow pane and stays one line where it fits", { timeout: 200000 }, async () => {
  // The row is up to 362px wide with a week-old time; it stuck out of 299px
  // panes and every thread scrolled sideways, in every skin.
  await inThreads("message-actions-narrow", finished, measureRows, (s, width, theme, where, inside, assert) => {
    for (const row of s.rows) {
      const seen = where + ", " + row.name + ": " + JSON.stringify(row);
      assert.ok(inside(row), "actions stay inside the pane: " + seen);
      for (const item of row.items) {
        assert.ok(inside(item), item.cls + " stays inside the pane: " + seen);
        if (item.cls.includes("msg-action")) assert.ok(item.width >= 31.5 && item.height >= 31.5, item.cls + " keeps its 32px target: " + seen);
        else assert.ok(item.width > 0 && !item.clipped, "the time stays readable: " + seen);
      }
      if (row.human) {
        // Your rows mirror a bot's: every line ends at the bubble's right edge.
        // A line's items share a vertical center (align-items: center).
        const mid = (i) => Math.round((i.top + i.bottom) / 2);
        for (const line of new Set(row.items.map(mid))) {
          const end = Math.max(...row.items.filter((i) => mid(i) === line).map((i) => i.right));
          assert.ok(Math.abs(end - row.right) <= 1, "each line of your row ends at its right edge: " + seen);
        }
      }
      // A row stays inside its message's column, and on one line wherever that
      // column holds it. A Clay reply's column is the whole thread, with no
      // avatar gutter, so its closed row with a week-old date fits at 440px.
      const holds = width === 760 || (theme === "clay" && (width === 440 || width === 480) && row.name.startsWith("bot closed"));
      if (holds) assert.ok(row.height <= 33, "a row its column can hold stays on one line: " + seen);
    }
  });
});

test("a reply being written fits a narrow pane and keeps 260px where there is room", { timeout: 200000 }, async () => {
  // Its 260px floor, beside a 36px avatar and a 12px gap, needs 308px; any
  // narrower thread scrolled sideways for the whole turn. Clay has no avatar
  // gutter, so there it needs only 260px.
  await inThreads("live-reply-narrow", live, measureLive, (s, width, theme, where, inside, assert) => {
    const seen = where + ": " + JSON.stringify(s.bubble) + " in " + JSON.stringify(s.content);
    assert.ok(inside(s.bubble), "the reply stays inside the pane: " + seen);
    const room = (theme === "clay" ? 0 : 48) + 260;
    if (s.content[1] - s.content[0] >= room) assert.ok(Math.abs(s.bubble.width - 260) <= 0.5, "the reply keeps its 260px floor where there is room: " + seen);
  });
});
