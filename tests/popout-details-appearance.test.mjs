import test from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { runElectronScenario } from "./helpers/electron-test.mjs";
import * as themes from "../src/themes.ts";

const popout = readFileSync(new URL("../src/PopoutApp.tsx", import.meta.url), "utf8");
const popoutCss = readFileSync(new URL("../src/popout.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../src/popoutModel.ts", import.meta.url), "utf8");

// Below 900px Deck makes .changes cover its container; only an ancestor
// .thread-details keeps it inside its section (styles.css). Pop-outs open
// 760px wide, so both Details spots must carry Deck's own panel class.
test("both pop-out Details spots use Deck's thread-details panel, not a hand-made column", () => {
  assert.match(popout, /className=\{`right-details-slot thread-details \$\{overlay \? "overlay" : "docked"\}`\}/);
  assert.match(popout, /className="right-details-slot thread-details full"/);
  assert.doesNotMatch(popout, /popout-details-col/);
  assert.doesNotMatch(popoutCss, /\.popout-details-col/);
  // The Details tab fills its window: Deck's own .full rule is scoped under
  // .body, which a pop-out is not inside, so the pop-out carries the fill.
  assert.match(popoutCss, /\.popout-body > \.thread-details\.full\s*\{[^}]*flex:\s*1 1 0/);
  assert.match(popoutCss, /\.popout-body > \.thread-details\.full\s*\{[^}]*width:\s*auto/);
});

test("pop-out styles use Deck's own theme tokens, and Details shows its on state", () => {
  // The --color-*/--border-radius-*/--font-sans names belong to chat answer
  // cards; Deck never defines them, so every use computed to nothing.
  assert.doesNotMatch(popoutCss, /--color-|--border-radius-|--font-sans/);
  assert.match(popoutCss, /\.popout\s*\{[^}]*background:\s*var\(--bg\)/);
  assert.match(popoutCss, /\.popout-bar\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)/);
  // Pressed reads as Deck's toggles do: an accent border, not the hover fill.
  assert.match(popoutCss, /\.popout-btn\[aria-pressed="true"\]\s*\{[^}]*border-color:\s*var\(--accent\)/);
});

test("applyAppearance paints a root like Deck's and cleans up after itself", () => {
  assert.equal(typeof themes.applyAppearance, "function");
  const props = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
    },
  };
  const smoked = themes.BUILTIN_SKINS.find((skin) => skin.id === "smoked").appearance;
  const cleanup = themes.applyAppearance(root, smoked);
  assert.equal(root.dataset.deckTheme, "glass");
  assert.equal(root.dataset.deckLight, "false");
  assert.equal(props.get("--deck-hue"), "168");
  cleanup();
  assert.equal(root.dataset.deckTheme, undefined);
  assert.equal(props.size, 0);
  // Classic sets the mode but no variables, exactly as the main window does.
  const stop = themes.applyAppearance(root, themes.DEFAULT_APPEARANCE);
  assert.equal(root.dataset.deckTheme, "classic");
  assert.equal(props.size, 0);
  stop();
});

test("the owner sends its appearance with every pop-out and pushes changes; both windows share one hook", () => {
  assert.match(model, /appearance\?: AppearanceValues/);
  assert.equal((model.match(/appearance\?: AppearanceValues/g) ?? []).length, 2); // Snapshot and update.
  const paneSnapshot = app.slice(app.indexOf("const popOutPane"), app.indexOf("const popOutTab"));
  const tabSnapshot = app.slice(app.indexOf("const popOutTab"), app.indexOf("const popoutLive"));
  assert.match(paneSnapshot, /appearance,/);
  assert.match(tabSnapshot, /appearance,/);
  assert.match(app, /title: pane\.title,\s+appearance,/);
  assert.match(app, /const patch: PopoutUpdate = \{ title: tabTitle\(tab\), appearance \}/);
  assert.match(app, /useAppearance\(appearance\)/);
  assert.doesNotMatch(app, /themeVariables\(appearance\)/);
  assert.match(popout, /useAppearance\(appearance\)/);
  assert.match(popout, /snap\.appearance/);
  assert.match(popout, /patch\.appearance !== undefined/);
});

// The fixture markup mirrors PopoutApp's two Details spots; the contract
// above pins PopoutApp to these same classes, so the rendered page and the
// window cannot drift apart.
const DETAILS = `
  <header class="details-head"><div><strong>A thread</strong><p class="muted">/tmp/project</p></div><button class="icon" aria-label="Close thread details">×</button></header>
  <section class="details-section"><button class="details-heading">Bots</button><div class="details-section-body">
    <article class="details-bot"><strong>Claude</strong><p>Saved bot</p></article>
    <form class="add-form"><label>Name <input></label><label>Model <select></select></label></form>
  </div></section>
  <section class="details-section"><button class="details-heading">Changes</button><div class="details-section-body">
    <aside class="changes"><header class="changes-head"><div>Changes</div></header><div class="changes-list"><div class="change">src/file.ts</div></div></aside>
  </div></section>`;

const BAR = `<header class="popout-bar"><span class="popout-title">A thread</span><span class="spacer"></span><button class="popout-btn" aria-pressed="true">Details</button><button class="popout-return">Return to Deck</button></header>`;

function measure() {
  const slot = document.querySelector(".right-details-slot");
  const bot = slot.querySelector(".details-bot");
  const changes = slot.querySelector(".changes");
  const back = document.querySelector(".popout-return");
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === el || el.contains(top);
  };
  return {
    innerWidth: window.innerWidth,
    slot: slot.getBoundingClientRect().toJSON(),
    slotBg: getComputedStyle(slot).backgroundColor,
    changes: changes.getBoundingClientRect().toJSON(),
    changesPosition: getComputedStyle(changes).position,
    formDirection: getComputedStyle(slot.querySelector(".add-form")).flexDirection,
    botHit: hit(bot),
    backHit: hit(back),
    pressedBorder: getComputedStyle(document.querySelector('.popout-btn[aria-pressed="true"]')).borderTopColor,
    plainBorder: getComputedStyle(back).borderTopColor,
  };
}

test("at 760x560 Changes stays in its section in both Details spots, and a sent skin applies live", { timeout: 200000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "popout-details-appearance-"));
  const paneHtml = `<div class="popout">${BAR}<div class="popout-body"><div class="popout-chat-row"><div class="popout-chat-main"><p>Chat messages show here.</p></div><div tabindex="-1" class="right-details-slot thread-details docked">${DETAILS}</div></div></div></div>`;
  const tabHtml = `<div class="popout">${BAR}<div class="popout-body"><div tabindex="-1" class="right-details-slot thread-details full">${DETAILS}</div></div></div>`;
  const html = `<html><body>${paneHtml}<script type="module">
    import '/src/styles.css'; import '/src/glass-theme.css'; import '/src/popout.css';
    import { applyAppearance, BUILTIN_SKINS } from '/src/themes.ts';
    window.applySkin = (id) => { window.__stopSkin?.(); window.__stopSkin = applyAppearance(document.documentElement, BUILTIN_SKINS.find((s) => s.id === id).appearance); };
    window.ready = typeof applyAppearance === 'function';
  </script></body></html>`;
  const server = await createServer({
    cacheDir: path.join(temp, "vite-cache"),
    server: { port: 0 },
    logLevel: "error",
    plugins: [{
      name: "popout-details-appearance-test",
      configureServer(server) {
        server.middlewares.use("/__popout_details_appearance_test", async (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml("/__popout_details_appearance_test", html));
        });
      },
    }],
  });
  await server.listen();
  const url = `http://localhost:${server.httpServer.address().port}/__popout_details_appearance_test`;
  const main = path.join(temp, "main.cjs");
  fs.writeFileSync(main, `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:760,height:560,titleBarStyle:'hiddenInset',webPreferences:{contextIsolation:true,sandbox:true}});
      const run=code=>win.webContents.executeJavaScript(code);
      const frame=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const check=(label,s)=>{
        const seen=label+': '+JSON.stringify(s);
        assert.ok(s.innerWidth<=760,'content is no wider than asked: '+seen);
        assert.equal(s.changesPosition,'static','Changes stays in its section instead of covering the panel: '+seen);
        assert.ok(s.changes.left>=s.slot.left-1 && s.changes.right<=s.slot.right+1,'Changes is inside the panel: '+seen);
        assert.equal(s.botHit,true,'the bot list is not covered: '+seen);
        assert.equal(s.backHit,true,'Return to Deck is not covered: '+seen);
        assert.notEqual(s.slotBg,'rgba(0, 0, 0, 0)','the panel has a background of its own: '+seen);
        assert.equal(s.formDirection,'column','the add-bot form is one column: '+seen);
        assert.notEqual(s.pressedBorder,s.plainBorder,'Details on state stands out from a plain button: '+seen);
        assert.ok(Number(s.pressedBorder.match(/\\d+/g)[1])>150,'Details on border is the mint accent, not the line color: '+seen);
      };
      try {
        await win.loadURL(${JSON.stringify(url)});
        for(let i=0;i<200;i++){ if(await run("!!window.ready")) break; await new Promise(r=>setTimeout(r,20)); }
        assert.equal(await run("!!window.ready"),true,'fixture must render with applyAppearance');
        win.setContentSize(760,560); await frame();
        await new Promise(r=>setTimeout(r,250)); // Let the buttons' 140ms border transition settle.
        check('popped thread', await run('('+${JSON.stringify(measure.toString())}+')()'));
        // At 760px the real window floats Details (detailsOverlay), so check that seat too.
        await run("document.querySelector('.right-details-slot').className = 'right-details-slot thread-details overlay'");
        await frame();
        check('popped thread, floating', await run('('+${JSON.stringify(measure.toString())}+')()'));
        await run('document.body.innerHTML = '+${JSON.stringify(JSON.stringify(tabHtml))});
        await frame();
        const tab = await run('('+${JSON.stringify(measure.toString())}+')()');
        check('popped Details tab', tab);
        assert.ok(tab.slot.width>600,'the Details tab panel fills the window: '+JSON.stringify(tab));
        // A skin sent while the window is already open re-applies at once.
        await run("window.applySkin('smoked')"); await frame();
        let root = await run("({theme: document.documentElement.dataset.deckTheme, light: document.documentElement.dataset.deckLight, hue: getComputedStyle(document.documentElement).getPropertyValue('--deck-hue').trim()})");
        assert.deepEqual(root, {theme:'glass', light:'false', hue:'168'}, 'smoked skin applied: '+JSON.stringify(root));
        await run("window.applySkin('frost')"); await frame();
        root = await run("({theme: document.documentElement.dataset.deckTheme, light: document.documentElement.dataset.deckLight, hue: getComputedStyle(document.documentElement).getPropertyValue('--deck-hue').trim()})");
        assert.deepEqual(root, {theme:'glass', light:'true', hue:'218'}, 'changing the skin while open re-applies: '+JSON.stringify(root));
        const glassy = await run('('+${JSON.stringify(measure.toString())}+')()');
        assert.notEqual(glassy.slotBg,'rgba(0, 0, 0, 0)','panel stays painted under glass: '+JSON.stringify(glassy));
        console.log('Details contained at 760x560 in both spots; skins apply live');
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
