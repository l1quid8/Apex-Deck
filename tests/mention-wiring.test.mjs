import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { mentionFor, mentionable, slug } from "../src/slug.ts";

const { transform } = createRequire(import.meta.url)("sucrase");
const chatPane = fs.readFileSync(new URL("../src/ChatPane.tsx", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

/** The agent form's Name field, from its `<label>` to `</label>`. */
function nameField() {
  const start = chatPane.indexOf("<label>\n            Name\n");
  assert.ok(start > 0, "the agent form has a Name field");
  const end = chatPane.indexOf("</label>", start);
  return chatPane.slice(start, end + "</label>".length);
}

/** Render the real Name field with a stand-in for React; returns the hint's words. */
function mentionHint(draft, editing) {
  const compiled = transform(`return (${nameField()});`, { transforms: ["typescript", "jsx"], jsxRuntime: "classic" }).code;
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
  const tree = new Function("React", "draft", "set", "editing", "slug", "mentionFor", "mentionable", compiled)(React, draft, () => {}, editing, slug, mentionFor, mentionable);
  const hint = tree.children.find((child) => child?.props?.className === "hint");
  return hint ? hint.children.flat().join("") : null;
}

test("the Mention as hint follows the name while you rename a bot", () => {
  assert.equal(mentionHint({ name: "Atlas" }, "jigga"), "Mention as @atlas");
  assert.equal(mentionHint({ name: "Jigga" }, "jigga"), "Mention as @jigga");
  assert.equal(mentionHint({ name: "Opus 2" }, null), "Mention as @opus-2");
  assert.equal(mentionHint({ name: "" }, "jigga"), null);
  assert.equal(mentionHint({ name: "-_-" }, "jigga"), "A name needs a letter or a number.", "never its old name");
});

test("chats name bots by mention, never by the id they are saved under", () => {
  assert.ok(!/@\{p\.id\}/.test(chatPane), "the agent card shows the mention");
  assert.ok(!/Change settings for @\$\{editing\}/.test(chatPane), "the form title shows the mention");
  assert.ok(!/is already in this chat/.test(chatPane), "clashes are worded by clashMessage");
  assert.ok(!/handleFor\(/.test(chatPane), "no mention is ever made from an id, which may be an old name");
  assert.ok(/botIdentity\(/.test(chatPane), "saving a bot picks its id and checks its name with botIdentity");
  assert.ok(!/(exampleRows|replyText|quoteTarget|queuedSticky|askerOf|uniqueName)\([^;]*map\(\(p\) => p\.id\)/.test(chatPane), "mention helpers get bots with names, not bare ids");
});

test("each chat renames its own copy when an agent is renamed in the Agents tab", () => {
  assert.ok(/copyRenamer\(/.test(chatPane), "a chat renames its copies one at a time, in order");
  assert.ok(/onCopyRenamed\?\.\(seq, outcome\)/.test(chatPane), "and reports what happened");
  assert.ok(/savedToAgents\(profiles, p\)/.test(chatPane), "Save to Agents checks the name like the Agents tab does");
  assert.ok(!/onProfilesChange=\{setProfiles\}/.test(app) && /onProfilesChange=\{saveAgents\}/.test(app), "a rename saved to Agents from a chat reaches the other chats too");
  assert.ok(/renamedAgents\(profiles, next\)/.test(app), "the Agents tab's saves are checked for renames");
  assert.ok(/copyRenames=\{copyRenames\}/.test(app), "threads hear about renames");
  assert.ok(/setCopyRenames\(\(list\) => latestRenames\(list, renamed\)\)/.test(app), "the latest rename of each agent is kept, none dropped");
  assert.ok(/onCopyRenamed=\{onCopyRenamed\}/.test(app), "and report back for the note");
});

test("the phone shows, picks and tags bots by mention", () => {
  const phone = fs.readFileSync(new URL("../src/phone/PhoneApp.tsx", import.meta.url), "utf8");
  assert.ok(!/@\{config\.id\}/.test(phone), "the bot list shows the mention");
  assert.ok(/choose\(pick\.handle\)/.test(phone), "picking from the @ list writes the pick's mention");
  assert.ok(!/tagFromBar\([^,()]+, [^,()]+\)/.test(phone), "tapping a bot tags it by mention, knowing who else is here");
  assert.ok(!/queuedSticky\([^;]*map\(\(p\) => p\.id\)/.test(phone), "queued tags are read by mention");
});
