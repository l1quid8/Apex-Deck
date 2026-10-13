import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerStore, readAnswers } from "../src/interactiveAnswers/answerStore.ts";

const KEY = "4:hosting";
const PRINT = "0a1b2c3d";
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** A host that keeps one thread's settings the way answer_save does, and writes down every save. */
function host(cards = {}, { loadError, saveError } = {}) {
  const saves = [];
  const file = { version: 1, cards: structuredClone(cards) };
  return {
    saves,
    file,
    answersLoad: async () => { if (loadError) throw new Error(loadError); return Object.keys(file.cards).length ? structuredClone(file) : null; },
    answerSave: async (room, key, fingerprint, inputs, revision) => {
      saves.push({ room, key, fingerprint, inputs, revision });
      if (saveError) throw new Error(saveError);
      const current = file.cards[key];
      if (current && current.revision !== revision) return { conflict: structuredClone(current) };
      const saved = { fingerprint, inputs: structuredClone(inputs), revision: (current?.revision ?? 0) + 1, at: 1 };
      file.cards[key] = saved;
      return { saved: structuredClone(saved) };
    },
  };
}
const entry = (inputs, revision = 1, fingerprint = PRINT) => ({ fingerprint, inputs, revision, at: 0 });

test("loaded settings apply only to the card they were set on", async () => {
  const store = createAnswerStore(host({ [KEY]: entry({ budget: 100 }, 2) }), "t", 1);
  await store.load();
  assert.deepEqual(store.values(KEY, PRINT), { budget: 100 });
  assert.equal(store.values(KEY, "ffffffff"), null);
  assert.equal(store.values("5:hosting", PRINT), null);
  assert.equal(store.status(KEY), undefined);
});

test("a dragged slider saves once, with the last value and the revision it changed", async () => {
  const backend = host({ [KEY]: entry({ budget: 100, priority: "ease" }, 2) });
  const store = createAnswerStore(backend, "t", 5);
  await store.load();
  for (const budget of [110, 120, 130]) store.set(KEY, PRINT, { budget, priority: "ease" });
  assert.deepEqual(store.values(KEY, PRINT), { budget: 130, priority: "ease" }, "shows at once");
  await wait(); await store.flush();
  assert.deepEqual(backend.saves, [{ room: "t", key: KEY, fingerprint: PRINT, inputs: { budget: 130, priority: "ease" }, revision: 2 }]);
  store.set(KEY, PRINT, { budget: 140, priority: "ease" });
  await store.flush();
  assert.equal(backend.saves[1].revision, 3, "the next save names the revision the last one made");
});

test("closing a thread saves what's waiting at once", async () => {
  const backend = host();
  const store = createAnswerStore(backend, "t", 10_000);
  await store.load();
  store.set(KEY, PRINT, { budget: 300 });
  await store.flush();
  assert.deepEqual(backend.saves.map((s) => [s.inputs, s.revision]), [[{ budget: 300 }, 0]]);
});

test("another window saved first: its settings show and this change isn't saved over them", async () => {
  const backend = host({ [KEY]: entry({ budget: 100, priority: "ease" }, 2) });
  const store = createAnswerStore(backend, "t", 1);
  await store.load();
  backend.file.cards[KEY] = entry({ budget: 100, priority: "cost" }, 3); // the other window changed priority
  store.set(KEY, PRINT, { budget: 150, priority: "ease" }); // this one changed budget
  await wait(); await store.flush();
  assert.deepEqual(backend.saves.map((s) => [s.inputs, s.revision]), [[{ budget: 150, priority: "ease" }, 2]]);
  assert.deepEqual(store.values(KEY, PRINT), { budget: 100, priority: "cost" });
  assert.equal(store.status(KEY), "Another window changed this card, so your last change wasn't saved.");
  // The next change starts from the newer settings and saves.
  store.set(KEY, PRINT, { budget: 150, priority: "cost" });
  await store.flush();
  assert.deepEqual(backend.saves.at(-1), { room: "t", key: KEY, fingerprint: PRINT, inputs: { budget: 150, priority: "cost" }, revision: 3 });
  assert.equal(store.status(KEY), undefined);
});

test("a change made while a refused save was on its way isn't saved over the other window either", async () => {
  const backend = host({ [KEY]: entry({ budget: 100 }, 2) });
  let answer;
  const slow = { ...backend, answerSave: (...args) => new Promise((resolve) => { answer = () => resolve(backend.answerSave(...args)); }) };
  const store = createAnswerStore(slow, "t", 1);
  await store.load();
  backend.file.cards[KEY] = entry({ budget: 400 }, 3);
  store.set(KEY, PRINT, { budget: 150 });
  await wait(); // the save is on its way
  store.set(KEY, PRINT, { budget: 175 });
  answer();
  await wait(); await store.flush();
  assert.equal(backend.saves.length, 1);
  assert.deepEqual(store.values(KEY, PRINT), { budget: 400 });
});

test("a failed save keeps the change on screen and says why", async () => {
  const store = createAnswerStore(host({}, { saveError: "The Mac is offline." }), "t", 1);
  await store.load();
  store.set(KEY, PRINT, { budget: 150 });
  await wait(); await store.flush();
  assert.deepEqual(store.values(KEY, PRINT), { budget: 150 });
  assert.equal(store.status(KEY), "Couldn't save: The Mac is offline.");
});

test("settings that couldn't be read are never written over, and an old helper is named", async () => {
  const backend = host({}, { loadError: "Could not read saved data: expected value" });
  const store = createAnswerStore(backend, "t", 1);
  await store.load();
  store.set(KEY, PRINT, { budget: 150 });
  await wait(); await store.flush();
  assert.equal(backend.saves.length, 0);
  assert.deepEqual(store.values(KEY, PRINT), { budget: 150 }, "the change still shows");
  assert.equal(store.status(KEY), "Saved settings couldn't be read, so changes here won't be kept.");
  const old = createAnswerStore(host({}, { loadError: "unknown variant `answers_load`, expected one of `session_load`" }), "t", 1);
  await old.load();
  assert.equal(old.status(KEY), "This machine's apex-daemon is too old to keep card settings.");
});

test("listeners hear about their own card until they stop", async () => {
  const store = createAnswerStore(host(), "t", 1);
  await store.load();
  let heard = 0;
  const stop = store.subscribe(KEY, () => heard++);
  store.set("9:other", PRINT, { budget: 1 });
  store.set(KEY, PRINT, { budget: 2 });
  stop();
  store.set(KEY, PRINT, { budget: 3 });
  assert.equal(heard, 1);
  await store.flush();
  assert.deepEqual(Object.keys(store.entries()).sort(), [KEY, "9:other"].sort());
});

test("damaged saved entries are left out", () => {
  assert.deepEqual(readAnswers(null), { version: 1, cards: {} });
  assert.deepEqual(readAnswers({ cards: {
    good: { fingerprint: PRINT, inputs: { budget: 5, priority: "ease", bad: { x: 1 } }, revision: 2, at: 9 },
    noPrint: { inputs: {}, revision: 1 },
    zero: { fingerprint: PRINT, inputs: {}, revision: 0 },
  } }), { version: 1, cards: { good: { fingerprint: PRINT, inputs: { budget: 5, priority: "ease" }, revision: 2, at: 9 } } });
});

test("flush retries a failed save even after its debounce timer fired", async () => {
  const backend = host({ [KEY]: entry({ budget: 100 }, 2) });
  let offline = true;
  const store = createAnswerStore({ ...backend, answerSave: (...args) => offline ? Promise.reject(Error('offline')) : backend.answerSave(...args) }, 't', 1);
  await store.load();
  store.set(KEY, PRINT, { budget: 300 });
  await wait();
  offline = false;
  await store.flush();
  assert.equal(backend.file.cards[KEY].inputs.budget, 300);
});

test("reloading after a failed save preserves the change's base revision so another window wins explicitly", async () => {
  const backend = host({ [KEY]: entry({ budget: 100 }, 2) });
  let offline = true;
  const store = createAnswerStore({ ...backend, answerSave: (...args) => offline ? Promise.reject(Error('offline')) : backend.answerSave(...args) }, 't', 1);
  await store.load();
  store.set(KEY, PRINT, { budget: 300 });
  await wait();
  backend.file.cards[KEY] = entry({ budget: 200 }, 3);
  await store.load();
  assert.deepEqual(store.values(KEY, PRINT), { budget: 300 });
  offline = false;
  await store.flush();
  assert.equal(backend.saves.at(-1).revision, 2);
  assert.deepEqual(store.values(KEY, PRINT), { budget: 200 });
  assert.match(store.status(KEY), /Another window/);
});

test("registered stores flush pending card edits before application quit or project forks", async () => {
  const { retainAnswerStore, flushAnswerStores } = await import('../src/interactiveAnswers/answerStore.ts');
  const backend = host();
  const store = createAnswerStore(backend, 't', 10_000);
  await store.load();
  const release = retainAnswerStore(store);
  try {
    store.set(KEY, PRINT, { budget: 300 });
    await flushAnswerStores();
    assert.equal(backend.file.cards[KEY].inputs.budget, 300);
  } finally { release(); }
});

test("an older load completing after a successful save cannot replace the newer saved input", async () => {
  const backend=host({[KEY]:entry({budget:100},2)});
  let finish;
  let delayed=false;
  const store=createAnswerStore({...backend,answersLoad:async()=>{
    const file=await backend.answersLoad();
    if(delayed)await new Promise(resolve=>{finish=resolve;});
    return file;
  }},'t',10_000);
  await store.load();
  delayed=true;
  const loading=store.load();
  await wait();
  store.set(KEY,PRINT,{budget:300});
  await store.flush();
  finish();await loading;
  assert.deepEqual(store.values(KEY,PRINT),{budget:300});
});

test("clearing or rewinding a thread discards removed cached settings and queued edits", async () => {
  const { discardAnswerSettingsAfter }=await import('../src/interactiveAnswers/answerStore.ts');
  const backend=host({[KEY]:entry({budget:100},2),'2:hosting':entry({budget:75})});
  const store=createAnswerStore(backend,'t',10_000);await store.load();
  store.set(KEY,PRINT,{budget:300});
  discardAnswerSettingsAfter(store,4);
  await store.flush();
  assert.equal(store.values(KEY,PRINT),null);
  assert.deepEqual(store.values('2:hosting',PRINT),{budget:75});
  assert.equal(backend.saves.length,0);
  discardAnswerSettingsAfter(store,0);
  assert.deepEqual(store.entries(),{});
});

test("fork preparation flushes only its source thread, so an unrelated offline card cannot block it", async () => {
  const { retainAnswerStore, flushAnswerStores }=await import('../src/interactiveAnswers/answerStore.ts');
  const ready=host(),offline=host({}, {saveError:'offline'});
  const one=createAnswerStore(ready,'source',10_000),two=createAnswerStore(offline,'other',10_000);
  await one.load();await two.load();
  const releases=[retainAnswerStore(one),retainAnswerStore(two)];
  try {
    one.set(KEY,PRINT,{budget:300});two.set(KEY,PRINT,{budget:200});
    await flushAnswerStores(ready,'source');
    assert.equal(ready.saves.length,1);assert.equal(offline.saves.length,0);
  } finally { releases.forEach(release=>release());await two.flush(); }
});

test("application flush waits for every save even if another card already failed", async () => {
  const { retainAnswerStore, flushAnswerStores }=await import('../src/interactiveAnswers/answerStore.ts');
  const failed=createAnswerStore(host({}, {saveError:'offline'}),'failed',10_000);
  const backend=host();let finish;
  const slow=createAnswerStore({...backend,answerSave:(...args)=>new Promise(resolve=>{finish=()=>resolve(backend.answerSave(...args));})},'slow',10_000);
  await failed.load();await slow.load();
  const releases=[retainAnswerStore(failed),retainAnswerStore(slow)];
  failed.set(KEY,PRINT,{budget:100});slow.set(KEY,PRINT,{budget:300});
  let complete=false;
  const flushing=flushAnswerStores().catch(()=>{}).then(()=>{complete=true;});
  try { await wait();assert.equal(complete,false,'one failure must not let quit outrun another save'); }
  finally {finish();await flushing;releases.forEach(release=>release());}
  assert.equal(backend.file.cards[KEY].inputs.budget,300);
});
