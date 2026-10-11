import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const deckWindow = main.slice(main.indexOf("function createWindow(host, beside)"), main.indexOf("function createWindow(host, beside)") + 1300);
const titlebar = app.slice(app.indexOf('<header className="titlebar">'), app.indexOf("</header>", app.indexOf('<header className="titlebar">')));

test("main Deck window uses the native inset titlebar", () => {
  assert.match(deckWindow, /titleBarStyle:\s*['"]hiddenInset['"]/);
});

test("titlebar reserves room for traffic lights and keeps the surface unpainted", () => {
  assert.match(styles, /\.titlebar\s*\{[^}]*background:\s*transparent/);
  assert.match(styles, /\.titlebar\s*\{[^}]*padding:\s*8px 16px 8px 88px/);
});

test("titlebar can drag the window while controls remain interactive", () => {
  assert.match(styles, /\.titlebar\s*\{[^}]*-webkit-app-region:\s*drag/);
  assert.match(styles, /\.titlebar button,[\s\S]*?\{[^}]*-webkit-app-region:\s*no-drag/);
  assert.match(titlebar, /<SectionNavigation/);
  assert.match(titlebar, /className="titlebar-end"/);
});
