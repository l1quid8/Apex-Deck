import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const popout = readFileSync(new URL("../src/PopoutApp.tsx", import.meta.url), "utf8");
const chatPane = readFileSync(new URL("../src/ChatPane.tsx", import.meta.url), "utf8");
const popoutCss = readFileSync(new URL("../src/popout.css", import.meta.url), "utf8");

test("task threads never pop out: the one door refuses them before any window opens", () => {
  // Menu and drag-out both end at popOutPane; the refusal sits there, ahead of bridge.open.
  const body = app.slice(app.indexOf("const popOutPane"), app.indexOf("const popOutTab"));
  assert.match(body, /popoutRefusal\(pane\)/);
  assert.match(body, /toast\(refusal\)/);
  assert.ok(body.indexOf("popoutRefusal(pane)") < body.indexOf("bridge.open"));
  assert.match(app, /onDropOutside:.*popOutPane\(id,/);
});

test("the owner sends found agents and settings with a popped thread, and keeps pushing them", () => {
  assert.match(app, /agents: agentsOn\(hostId\)/);
  assert.match(app, /chatConfig: chatConfigOf\(workspace, hostId\)/);
  assert.match(app, /pane\.kind === "chat" \? \{ chatConfig: chatConfigOf\(workspace, hostId\) \}/);
  assert.match(app, /tab\.kind === "details" \|\| tab\.kind === "tasks"/);
  assert.match(app, /newThread: settings\.newThread/);
  assert.match(app, /confirmSteer: settings\.confirmSteer/);
});

test("both pop-out chats get the live bundle, never an empty agent list", () => {
  assert.equal((popout.match(/agents=\{bundle\.agents\}/g) ?? []).length, 4); // Two ChatPanes, each inside its HostPane.
  assert.equal((popout.match(/profiles=\{bundle\.profiles\}/g) ?? []).length, 3); // Plus the Tasks tab.
  assert.doesNotMatch(popout, /snapshot\.chatConfig\?\.profiles/);
  assert.match(popout, /patch\.chatConfig !== undefined/);
});

test("saved Agents travel one change at a time, and attach mode stays on", () => {
  assert.match(popout, /changedProfiles\(bundle\.profiles, next\)/);
  assert.match(popout, /type: "profiles-upsert"/);
  assert.doesNotMatch(popout, /\{ type: "profiles",/);
  assert.match(app, /live\.upsertAgents\(action\.profiles\)/);
  assert.match(app, /setProfiles\(\(list\) => upsertProfiles\(list, changed\)\)/);
  assert.equal((popout.match(/^\s+attach$/gm) ?? []).length, 2);
});

test("popped threads follow the chat settings and renames that came with 0.8.0", () => {
  // Settings → General "Run buttons on code blocks": off in Deck means off in a pop-out,
  // and no Run button shows before the owner's bundle says which.
  const config = app.slice(app.indexOf("const chatConfigOf"), app.indexOf("const previewSourceOf"));
  assert.match(config, /codeRunButtons: settings\.codeRunButtons/);
  assert.match(popout, /codeRunButtons=\{bundle\.codeRunButtons\}/);
  const empty = popout.slice(popout.indexOf("const EMPTY_BUNDLE"), popout.indexOf("\n};", popout.indexOf("const EMPTY_BUNDLE")));
  assert.match(empty, /codeRunButtons: false/);
  // The empty thread's glyph field takes the same appearance-aware colour as in Deck.
  assert.match(config, /landingTexture: effectiveLandingTexture\(settings\.landingTexture \?\? DEFAULT_LANDING_TEXTURE, appearance\)/);
  // Save to Agents from a pop-out renames the agent's chat copies, as it does from Deck.
  const upsert = app.slice(app.indexOf("const upsertAgents"), app.indexOf("const upsertAgents") + 500);
  assert.match(upsert, /noteRenames\(profiles, changed\)/);
  assert.match(app, /const saveAgents = \(next: ParticipantConfig\[\]\) => \{\s*noteRenames\(profiles, next\);/);
});

test("a popped thread has its Details panel, counts, menu and rename in its own window", () => {
  assert.match(popout, /details=\{details\}/);
  assert.match(popout, /countsSlot=\{countsSlot\}/);
  assert.match(popout, /aria-pressed=\{paneDetails\.open\}/);
  assert.match(popout, /aria-label="Thread menu"/);
  for (const label of ["Rename", "Share as PDF", "Copy as Markdown", "Copy last reply", "Fork", "Export"]) {
    assert.match(popout, new RegExp(`label: "${label}"`));
  }
  assert.match(popout, /type: "rename", title: next/);
  assert.match(popout, /type: "seen", seq/);
  assert.match(popout, /type: "confirm-steer", confirm/);
  assert.match(chatPane, /countsSlot\?: HTMLElement \| null/);
  assert.equal((chatPane.match(/countsSlot !== undefined/g) ?? []).length, 3); // Lookup and refit skipped; slot chosen once.
});

test("fork runs in the owner and the pop-out waits for its real result", () => {
  assert.match(popout, /type: "fork", title: forkTitle, upto, at, requestId/);
  assert.match(popout, /forks\.current\.settle\(patch\.forkResult\)/);
  assert.match(app, /live\.forkThread\(pane, action\.title, action\.upto, action\.at\)/);
  assert.match(app, /requestId: action\.requestId, error:/);
  assert.match(app, /requestId: action\.requestId, title/);
});

test("the owner closes a pop-out whose thread is gone, without restoring it", () => {
  assert.match(app, /orphanedPopouts\(poppedOut, panes, listed\)/);
  assert.match(app, /setPoppedOut\(\(list\) => list\.filter\(\(p\) => !tokens\.has\(p\.token\)\)\)/);
  assert.match(app, /bridge\.close\(orphan\.token\)/);
  assert.match(app, /pane && !pane\.closed && !pane\.archived/);
});

test("the bar keeps thread controls whole at narrow widths", () => {
  assert.match(popoutCss, /\.popout-btn\s*\{[^}]*flex:\s*none/);
  assert.match(popoutCss, /\.popout-bar \.pane-counts\s*\{[^}]*flex:\s*none/);
  assert.match(popoutCss, /max-width:\s*520px[^}]*\.popout-bar \.count-label\s*\{\s*display:\s*none/);
  // Details sizing comes from Deck's .thread-details (320px in styles.css).
  assert.match(popout, /thread-details \$\{overlay \? "overlay" : "docked"\}/);
});
