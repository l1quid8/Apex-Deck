import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as naming from "../src/slug.ts";
import { mentionTarget } from "../src/recipients.ts";

// The daemon checks the same list (apex_core::mention), so the two rules can't drift.
const shared = JSON.parse(fs.readFileSync(new URL("../shared/mention-names.json", import.meta.url), "utf8"));
const bot = ({ id, name }) => ({ id, display_name: name });

test("a bot's mention follows its current name, as the daemon reads it", () => {
  for (const c of shared.names) assert.equal(naming.mentionFor(bot(c)), c.mention, JSON.stringify(c));
});

test("messages reach bots by their current name; an old id still works unless a bot is named that", () => {
  for (const c of shared.routing) assert.deepEqual(mentionTarget(c.text, c.bots.map(bot)), c.to, c.text);
});

const atlas = { id: "jigga", display_name: "Atlas" };
const nul = { id: "null", display_name: "Null" };

test("a name another bot already answers to is refused, and so are @all and @everyone", () => {
  assert.deepEqual(naming.mentionClash({ id: "new", display_name: "atlas" }, [atlas, nul]), { mention: "atlas", by: atlas });
  assert.equal(naming.mentionClash({ id: "jigga", display_name: "Atlas" }, [atlas, nul]), null, "a bot never clashes with itself");
  assert.equal(naming.mentionClash({ id: "new", display_name: "Jigga" }, [atlas, nul]), null, "an old id is not a name");
  assert.deepEqual(naming.mentionClash({ id: "new", display_name: "All" }, [atlas]), { mention: "all", by: null });
  assert.deepEqual(naming.mentionClash({ id: "new", display_name: "Everyone" }, []), { mention: "everyone", by: null });
});

test("the refusal says who already has the name, in the chat's words or the Agents tab's", () => {
  assert.equal(naming.clashMessage({ mention: "atlas", by: atlas }, "chat"), "Atlas in this chat already answers to @atlas. Pick a different name.");
  assert.equal(naming.clashMessage({ mention: "atlas", by: atlas }, "agents"), "Your agent Atlas already answers to @atlas. Pick a different name.");
  assert.equal(naming.clashMessage({ mention: "all", by: null }, "chat"), "@all already means everyone in the chat. Pick a different name.");
});

test("a new bot whose natural id a renamed bot still holds gets the next free one", () => {
  assert.equal(naming.freeId("jigga", ["null"]), "jigga");
  assert.equal(naming.freeId("jigga", ["jigga", "null"]), "jigga-2");
  assert.equal(naming.freeId("jigga", ["jigga", "jigga-2"]), "jigga-3");
});

test("a new bot gets the id its name gives, or the next free one when a renamed bot holds it", () => {
  const chat = (bot, others, agents = []) => naming.botIdentity(bot, { editing: null, others, agents, place: "chat" });
  assert.deepEqual(chat({ id: "jigga", display_name: "Jigga" }, [atlas, nul]), { id: "jigga-2" });
  assert.deepEqual(chat({ id: "ada", display_name: "Ada" }, [atlas, nul]), { id: "ada" });
  assert.deepEqual(chat({ id: "atlas", display_name: "Atlas" }, [atlas, nul]), { error: "Atlas in this chat already answers to @atlas. Pick a different name." });
  // A bot that still has its first name is not renamed: a second "Jigga" is a clash, not a jigga-2.
  assert.deepEqual(chat({ id: "jigga", display_name: "Jigga" }, [{ id: "jigga", display_name: "Jigga" }]), { error: "Jigga in this chat already answers to @jigga. Pick a different name." });
});

test("in a chat, a new bot never takes the id of an agent with another name, but does share one with its namesake", () => {
  const chat = (agents) => naming.botIdentity({ id: "jigga", display_name: "Jigga" }, { editing: null, others: [nul], agents, place: "chat" });
  assert.deepEqual(chat([atlas]), { id: "jigga-2" }, "Atlas in the Agents tab keeps the id jigga");
  assert.deepEqual(chat([{ id: "jigga", display_name: "Jigga" }]), { id: "jigga" }, "the Agents tab's Jigga, as before");
});

test("an edited bot keeps its id, and can't take a name another bot answers to", () => {
  const edit = (name, place = "chat") => naming.botIdentity({ id: "jigga", display_name: name }, { editing: "jigga", others: [atlas, nul], agents: [], place });
  assert.deepEqual(edit("Nova"), { id: "jigga" });
  assert.deepEqual(edit("null"), { error: "Null in this chat already answers to @null. Pick a different name." });
  assert.deepEqual(edit("Null", "agents"), { error: "Your agent Null already answers to @null. Pick a different name." });
});
