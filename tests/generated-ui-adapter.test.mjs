import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { createHash } from "node:crypto";

const adapter = () => import("../desktop/generated-ui/frame-content.mjs");
const runId = "01234567-89ab-4def-8123-456789abcdef";
const revisionDigest = "a".repeat(64);
const base = { protocolVersion: 1, runId, revisionDigest };
const card = { schemaVersion: 1, kind: "generated", cardId: "counter", title: "Counter", summary: "A local count.", html: '<output id="count">0</output>', css: "output { display: block; }", js: 'globalThis.order.push("js"); globalThis.payload = "</script><script>unexpected()</script>";', fallback: "Count starts at zero." };
const scriptOf = (html) => html.match(/<script>([\s\S]*?)<\/script>/)[1];

function wrapperHarness(build) {
  const listeners = new Map();
  const toChild = [];
  const toMain = [];
  const child = { postMessage: (data, target) => toChild.push({ data, target }) };
  const frame = { contentWindow: child, addEventListener: (type, fn) => listeners.set(`frame:${type}`, fn), style: {} };
  let command;
  let now = 0;
  const context = vm.createContext({ TextEncoder, console, performance: { now: () => now }, document: { getElementById: () => frame }, window: { addEventListener: (type, fn) => listeners.set(type, fn), generatedUIHost: { postMessage: (data) => toMain.push(data), onCommand: (fn) => { command = fn; } } } });
  vm.runInContext(scriptOf(build({ runId, revisionDigest })), context);
  listeners.get("frame:load")();
  return { frame, child, toChild, toMain, context, setNow: (value) => { now = value; }, load: () => listeners.get("frame:load")(), command: (data) => command(data), message: (data, extras = {}) => listeners.get("message")({ source: child, data, ports: [], ...extras }) };
}

function childHarness(srcdoc) {
  const events = new Map();
  const eventStates = new WeakMap();
  const nodes = new WeakMap();
  const order = [];
  const messages = [];
  const styles = [];
  const scriptErrors = [];
  const intervals = [];
  const resizeObservers = [];
  let now = 100;
  let context;
  class NativeEvent {
    constructor(type, { target = null, ...data } = {}) {
      eventStates.set(this, { type, target, defaultPrevented: false, immediateStopped: false });
      Object.assign(this, data);
    }
    get target() { return eventStates.get(this).target; }
    preventDefault() { const state = eventStates.get(this); if (!state.inPassiveListener) state.defaultPrevented = true; }
    stopImmediatePropagation() { eventStates.get(this).immediateStopped = true; }
  }
  const matchesElement = (element, selector) => {
    const node = nodes.get(element);
    return selector.split(", ").some((part) => part === "label" ? node.tagName === "LABEL" : part === 'input[type="file"]' && node.tagName === "INPUT" && node.type === "file");
  };
  class Element {
    constructor(tagName, { type = "", parent = null, control = null } = {}) { nodes.set(this, { tagName, type, parent, control, children: [] }); }
    click() {}
    matches(selector) {
      return matchesElement(this, selector);
    }
    closest(selector) {
      for (let element = this; element; element = nodes.get(element).parent) if (matchesElement(element, selector)) return element;
      return null;
    }
    querySelector(selector) { return nodes.get(this).children.find((element) => matchesElement(element, selector)) ?? null; }
  }
  class Input extends Element {
    constructor(options = {}) { super("INPUT", options); }
    get type() { return nodes.get(this).type; }
    showPicker() {}
  }
  class Label extends Element {
    constructor(options = {}) { super("LABEL", options); }
    get control() { return nodes.get(this).control; }
  }
  const listen = (where, type, fn, capture = false) => {
    const key = `${where}:${type}`;
    const listeners = events.get(key) ?? [];
    listeners.push({ fn, capture: typeof capture === "boolean" ? capture : capture.capture === true, passive: typeof capture === "object" && capture.passive !== undefined ? capture.passive : type === "touchstart" });
    events.set(key, listeners);
  };
  const dispatch = (event) => {
    const state = eventStates.get(event);
    // DOM capture reaches Window before Document, regardless of registration
    // order between those two targets; same-target listeners keep their order.
    for (const [where, capture] of [["window", true], ["document", true], ["document", false], ["window", false]]) {
      for (const listener of events.get(`${where}:${state.type}`) ?? []) {
        if (listener.capture !== capture) continue;
        state.inPassiveListener = listener.passive;
        try { listener.fn(event); } finally { state.inPassiveListener = false; }
        if (state.immediateStopped) return;
      }
    }
  };
  const head = { appendChild: (node) => { styles.push(node); order.push("css"); } };
  const body = { scrollHeight: 199.2, appendChild: (node) => {
    if (node.tagName !== "SCRIPT") return;
    // A DOM script append reports evaluation failures as Window error events;
    // appendChild itself does not throw for a script syntax/runtime failure.
    try { vm.runInContext(node.textContent, context); } catch (error) {
      scriptErrors.push(error);
      dispatch(new NativeEvent("error", { target: window, error, message: error.message }));
    }
  }, querySelectorAll: () => [], set innerHTML(value) { this.html = value; order.push("html"); }, get innerHTML() { return this.html; } };
  const parent = { postMessage: (data) => messages.push(data) };
  const commands = [];
  class Document { open() { events.clear(); } write() { events.clear(); } writeln() { events.clear(); } execCommand(name) { commands.push(name); return true; } }
  const document = Object.assign(new Document(),{ head, body, documentElement: { style: { setProperty() {} } }, createElement: (tag) => ({ tagName: tag.toUpperCase(), textContent: "" }), addEventListener: (type, fn, capture) => listen("document", type, fn, capture), querySelectorAll: () => [] });
  const window = { addEventListener: (type, fn, capture) => listen("window", type, fn, capture) };
  class Navigator { get mediaDevices() { return { enumerateDevices: async () => [{kind:'videoinput',deviceId:'canary'}] }; } }
  const navigator = new Navigator();
  context = vm.createContext({ Document, document, window, parent, Navigator, navigator, TextEncoder, Event: NativeEvent, Element, HTMLElement: Element, HTMLInputElement: Input, HTMLLabelElement: Label, MutationObserver: class { observe() {} }, ResizeObserver: class { constructor(callback) { resizeObservers.push(callback); } observe() {} }, getComputedStyle: () => ({ marginTop: "10", marginBottom: "4" }), setInterval: callback => { intervals.push(callback); return intervals.length; }, setTimeout: () => 1, clearInterval() {}, performance: { now: () => now }, order, console });
  vm.runInContext(scriptOf(srcdoc), context);
  return { order, messages, styles, scriptErrors, commands, body, context, parent, dispatch, intervals, resizeObservers, setNow: value => { now = value; }, createEvent: (type, data) => new NativeEvent(type, data), eventState: (event) => eventStates.get(event), input: (options) => new Input(options), label: (options) => new Label(options), event: (data, extras = {}) => dispatch(new NativeEvent("message", { source: parent, data, ports: [], ...extras })) };
}

test('startup polling and resize observations report a stable height only once, then report a real change', async () => {
  const { buildWrapperDocument } = await adapter();
  const child = childHarness(wrapperHarness(buildWrapperDocument).frame.srcdoc);
  child.body.scrollHeight = 396; // 410 including body margins.
  child.event({ ...base, type: 'bind' });
  child.event({ ...base, type: 'init', card });
  for (let index = 1; index <= 45; index++) {
    child.setNow(100 + index * 200);
    child.intervals[0]();
    child.resizeObservers[0]();
    child.dispatch(child.createEvent('resize'));
  }
  assert.deepEqual(child.messages.filter(message => message.type === 'resize').map(message => message.height), [410]);
  child.body.scrollHeight = 416;
  child.setNow(10000);
  child.resizeObservers[0]();
  assert.deepEqual(child.messages.filter(message => message.type === 'resize').map(message => message.height), [410, 430]);
});

test('fixed child removes device enumeration before model code and seals both recovery paths', async () => {
  const {buildWrapperDocument}=await adapter();
  const harness=wrapperHarness(buildWrapperDocument);
  const child=childHarness(harness.frame.srcdoc);
  assert.equal(vm.runInContext('navigator.mediaDevices',child.context),undefined);
  assert.equal(vm.runInContext('Object.getOwnPropertyDescriptor(Navigator.prototype,"mediaDevices").get',child.context),undefined);
  assert.equal(vm.runInContext('Reflect.deleteProperty(navigator,"mediaDevices")',child.context),false);
  assert.equal(vm.runInContext('Reflect.defineProperty(Navigator.prototype,"mediaDevices",{value:{enumerateDevices(){return "leak"}}})',child.context),false);
  assert.equal(vm.runInContext('Object.setPrototypeOf(navigator,{mediaDevices:{enumerateDevices(){return "leak"}}}); navigator.mediaDevices',child.context),undefined);
});

test('model cannot rewrite the document to erase trusted file and message listeners', async () => {
  const {buildWrapperDocument}=await adapter();
  const harness=wrapperHarness(buildWrapperDocument);
  for(const method of ['open','write','writeln']) {
    const child=childHarness(harness.frame.srcdoc);
    assert.throws(()=>vm.runInContext(`document.${method}('<input type="file">')`,child.context),/rewriting is disabled/);
    assert.throws(()=>vm.runInContext(`Document.prototype.${method}.call(document,'<input type="file">')`,child.context),/rewriting is disabled/);
    assert.equal(vm.runInContext(`Reflect.deleteProperty(document,'${method}')`,child.context),false);
    assert.equal(vm.runInContext(`Reflect.defineProperty(Document.prototype,'${method}',{value:()=>{}})`,child.context),false);
    const file=child.input({type:'file'});
    const drop=child.createEvent('drop',{target:file,dataTransfer:{files:[{}]}});
    child.dispatch(drop);
    assert.equal(child.eventState(drop).defaultPrevented,true);
    assert.equal(child.eventState(drop).immediateStopped,true);
  }
});

test("pinned files match the source receipt and full MIT notice", () => {
  const root = new URL("../third_party/open-intelligent-ui/", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.commit, "8391a94c1c3939c679e40ddd7bfc08a9ef690e70");
  assert.equal(manifest.files.length, 8);
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(new URL(file.vendoredPath, root));
    assert.equal(bytes.length, file.bytes, file.sourcePath);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.sourcePath);
  }
  const license = fs.readFileSync(new URL("LICENSE", root), "utf8");
  assert.match(license, /Copyright \(c\) Atai Barkai/);
  assert.match(license, /The above copyright notice and this permission notice/);
});

test("wrapper never interpolates model strings and creates the same fixed child bootstrap", async () => {
  const { buildWrapperDocument, ADAPTER_VERSION, SECURITY_POLICY_VERSION } = await adapter();
  const first = wrapperHarness(buildWrapperDocument);
  const html = buildWrapperDocument({ runId, revisionDigest, card });
  assert.ok(!html.includes(card.html));
  assert.ok(!html.includes(card.js));
  assert.ok(ADAPTER_VERSION && SECURITY_POLICY_VERSION);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /connectionallowlist="\(\)"/i);
  assert.ok(!html.includes("allow-same-origin"));
  const second = wrapperHarness((args) => buildWrapperDocument({ ...args, runId: "11111111-2222-4333-8444-555555555555" }));
  assert.equal(first.frame.srcdoc, second.frame.srcdoc);
  assert.match(first.frame.srcdoc, /connect-src 'none'/);
  assert.match(first.frame.srcdoc, /frame-src 'none'/);
  assert.ok(!first.frame.srcdoc.includes("unsafe-eval"));
});

test("wrapper rejects spoofed, stale, extra-key, port-bearing and invalid messages", async () => {
  const { buildWrapperDocument } = await adapter();
  const harness = wrapperHarness(buildWrapperDocument);
  const bootstrap = { ...base, type: "bootstrap" };
  harness.message(bootstrap, { source: {} });
  harness.message(bootstrap, { ports: [{}] });
  harness.message({ ...bootstrap, runId: "stale" });
  harness.message({ ...bootstrap, extra: true });
  assert.equal(harness.toMain.length, 0);
  harness.message(bootstrap);
  harness.message(bootstrap);
  assert.equal(harness.toMain.length, 1);
  harness.command({ ...base, type: "init", card });
  harness.message({ ...base, type: "ready" });
  harness.message({ ...base, type: "resize", height: Infinity });
  harness.message({ ...base, type: "resize", height: 1200 });
  harness.message({ ...base, type: "discuss", text: "x".repeat(4001) });
  harness.message({ ...base, type: "sendPrompt", text: "send this" });
  assert.deepEqual(harness.toMain.map((item) => item.type), ["bootstrap", "ready", "resize"]);
  assert.equal(harness.toMain[2].height, 800);
});

test("wrapper faults once on three malformed overlimit windows before further serialization or forwarding", async () => {
  const { buildWrapperDocument } = await adapter();
  const harness = wrapperHarness(buildWrapperDocument);
  harness.message({ ...base, type: "bootstrap" });
  harness.command({ ...base, type: "init", card });
  harness.message({ ...base, type: "ready" });
  vm.runInContext('const stringify = JSON.stringify; globalThis.serializations = 0; JSON.stringify = (value) => { serializations++; return stringify(value); };', harness.context);
  for (let second = 1; second <= 3; second++) {
    harness.setNow(second * 1000);
    for (let index = 0; index < 31; index++) harness.message({ malformed: true });
    assert.equal(harness.toMain.filter((item) => item.type === "fault").length, second === 3 ? 1 : 0, `window ${second}`);
  }
  assert.equal(harness.context.serializations, 90);
  assert.deepEqual({ ...harness.toMain.at(-1) }, { ...base, type: "fault", code: "message-flood" });
  const sentBefore = harness.toChild.length;
  harness.command({ ...base, type: "ping", nonce: "challenge" });
  harness.command({ ...base, type: "theme", tokens: { accent: "#fff" } });
  harness.message({ ...base, type: "pong", nonce: "challenge" });
  harness.message({ ...base, type: "discuss", text: "Ignore the fault" });
  assert.equal(harness.toChild.length, sentBefore);
  assert.equal(harness.toMain.length, 3);
  assert.equal(harness.context.serializations, 90);
});

test("wrapper counts oversized and port-bearing child storms but excludes foreign senders", async () => {
  const { buildWrapperDocument } = await adapter();
  for (const [data, extras] of [[{ oversized: "x".repeat(8193) }, {}], [{ malformed: true }, { ports: [{}] }]]) {
    const harness = wrapperHarness(buildWrapperDocument);
    for (let index = 0; index < 61; index++) harness.message(data, { ...extras, source: {} });
    assert.equal(harness.toMain.length, 0);
    for (let index = 0; index < 60; index++) harness.message(data, extras);
    assert.equal(harness.toMain.length, 0);
    harness.message(data, extras);
    assert.deepEqual(harness.toMain.map((message) => ({ ...message })), [{ ...base, type: "fault", code: "message-flood" }]);
    const sentBefore = harness.toChild.length;
    harness.load();
    assert.equal(harness.toChild.length, sentBefore);
  }
});

test("wrapper coalesces resize to ten per second and never forwards a child fault", async () => {
  const { buildWrapperDocument } = await adapter();
  const harness = wrapperHarness(buildWrapperDocument);
  harness.message({ ...base, type: "bootstrap" });
  harness.command({ ...base, type: "init", card });
  harness.message({ ...base, type: "ready" });
  harness.message({ ...base, type: "fault", code: "message-flood" });
  for (let index = 0; index < 20; index++) {
    harness.setNow(index * 50);
    harness.message({ ...base, type: "resize", height: 200 + index });
  }
  assert.equal(harness.toMain.filter((item) => item.type === "resize").length, 10);
  assert.equal(harness.toMain.filter((item) => item.type === "fault").length, 0);
});

test("child installs markup and CSS before executing exact script text once", async () => {
  const { buildWrapperDocument } = await adapter();
  const wrapper = wrapperHarness(buildWrapperDocument);
  const child = childHarness(wrapper.frame.srcdoc);
  child.event({ ...base, type: "bind" });
  child.event({ ...base, type: "init", card }, { source: {} });
  assert.equal(child.order.length, 0);
  child.event({ ...base, type: "init", card });
  child.event({ ...base, type: "init", card });
  assert.deepEqual(child.order.slice(0, 3), ["css", "html", "js"]);
  assert.equal(child.order.filter((item) => item === "js").length, 1);
  assert.equal(child.context.payload, "</script><script>unexpected()</script>");
  assert.equal(child.body.html, card.html);
  assert.equal(child.styles[0].textContent, card.css);
  // Main accepts resize only after ready, so the initial height must follow it.
  assert.deepEqual(child.messages.map((message) => message.type), ["bootstrap", "ready", "resize"]);
  assert.equal(child.messages[2].height, 214);
  child.event({ ...base, type: "ping", nonce: "trusted-challenge" });
  child.event({ ...base, type: "ping", nonce: "wrong", revisionDigest: "b".repeat(64) });
  assert.equal(child.messages.at(-1).nonce, "trusted-challenge");
});

test("child withholds ready and pong after synchronous script syntax or runtime failure", async () => {
  const { buildWrapperDocument } = await adapter();
  for (const js of ["const = broken", 'window.addEventListener("error", (event) => event.stopImmediatePropagation(), true); throw new Error("Broken controls");']) {
    const child = childHarness(wrapperHarness(buildWrapperDocument).frame.srcdoc);
    child.event({ ...base, type: "bind" });
    child.event({ ...base, type: "init", card: { ...card, js } });
    assert.equal(child.scriptErrors.length, 1);
    assert.deepEqual(child.messages.map((message) => message.type), ["bootstrap"]);
    child.event({ ...base, type: "ping", nonce: "must-not-answer" });
    child.event({ ...base, type: "init", card });
    assert.deepEqual(child.messages.map((message) => message.type), ["bootstrap"]);
  }
});

test("child window capture blocks dropped and pasted files before later model listeners", async () => {
  const { buildWrapperDocument } = await adapter();
  const child = childHarness(wrapperHarness(buildWrapperDocument).frame.srcdoc);
  child.event({ ...base, type: "bind" });
  child.event({ ...base, type: "init", card: { ...card, js: `globalThis.delivered = [];
    window.addEventListener("drop", (event) => globalThis.delivered.push(event.dataTransfer.files[0]), true);
    window.addEventListener("paste", (event) => globalThis.delivered.push(event.clipboardData.files[0]), true);` } });
  for (const type of ["dragenter", "dragover", "drop", "paste"]) {
    const event = child.createEvent(type, { dataTransfer: { files: ["private-drop.txt"] }, clipboardData: { files: ["private-paste.txt"] } });
    child.dispatch(event);
    assert.equal(child.eventState(event).defaultPrevented, true, type);
    assert.equal(child.eventState(event).immediateStopped, true, type);
  }
  assert.deepEqual(Array.from(child.context.delivered), []);
});

test("model code cannot write the clipboard through copy/cut handlers or execCommand", async () => {
  const { buildWrapperDocument } = await adapter();
  const child = childHarness(wrapperHarness(buildWrapperDocument).frame.srcdoc);
  child.event({ ...base, type: "bind" });
  child.event({ ...base, type: "init", card: { ...card, js: `globalThis.written = [];
    window.addEventListener("copy", (event) => globalThis.written.push("copy"), true);
    window.addEventListener("cut", (event) => globalThis.written.push("cut"), true);
    Reflect.apply = () => "hostile apply"; String.prototype.toLowerCase = () => "bold";` } });
  for (const type of ["copy", "cut"]) {
    const event = child.createEvent(type, { clipboardData: { setData() { throw new Error("model data reached the clipboard"); } } });
    child.dispatch(event);
    assert.equal(child.eventState(event).defaultPrevented, true, type);
    assert.equal(child.eventState(event).immediateStopped, true, type);
  }
  assert.deepEqual(Array.from(child.context.written), []);
  for (const command of ["copy", "CUT", "Paste"]) {
    assert.throws(() => vm.runInContext(`document.execCommand(${JSON.stringify(command)})`, child.context), /clipboard is unavailable/, command);
    assert.throws(() => vm.runInContext(`Document.prototype.execCommand.call(document, ${JSON.stringify(command)})`, child.context), /clipboard is unavailable/, command);
  }
  // The name is read once: one that says "copy" on a second reading reaches the native command as "bold".
  assert.equal(vm.runInContext(`document.execCommand({ n: 0, toString() { return this.n++ ? "copy" : "bold"; } })`, child.context), true);
  assert.deepEqual(child.commands, ["bold"]);
  assert.equal(vm.runInContext(`Reflect.deleteProperty(document, "execCommand")`, child.context), false);
  assert.equal(vm.runInContext(`Reflect.defineProperty(Document.prototype, "execCommand", { value: () => true })`, child.context), false);
});

test("child file guards use saved native event methods despite prototype and instance overrides", async () => {
  const { buildWrapperDocument } = await adapter();
  const child = childHarness(wrapperHarness(buildWrapperDocument).frame.srcdoc);
  child.event({ ...base, type: "bind" });
  child.event({ ...base, type: "init", card: { ...card, js: `globalThis.overridden = 0;
    globalThis.delivered = [];
    Event.prototype.preventDefault = () => globalThis.overridden++;
    Event.prototype.stopImmediatePropagation = () => globalThis.overridden++;
    Function.prototype.call = () => { throw new Error("Hostile call override"); };
    window.addEventListener("drop", (event) => globalThis.delivered.push(event.dataTransfer.files[0]), true);
    window.addEventListener("paste", (event) => globalThis.delivered.push(event.clipboardData.files[0]), true);` } });
  for (const type of ["drop", "paste", "click"]) {
    const event = child.createEvent(type, { target: child.input({ type: "file" }), dataTransfer: { files: ["private-drop.txt"] }, clipboardData: { files: ["private-paste.txt"] } });
    event.preventDefault = () => child.context.overridden++;
    event.stopImmediatePropagation = () => child.context.overridden++;
    child.dispatch(event);
    assert.equal(child.eventState(event).defaultPrevented, true, type);
    assert.equal(child.eventState(event).immediateStopped, true, type);
  }
  assert.equal(child.context.overridden, 0);
  assert.deepEqual(Array.from(child.context.delivered), []);
});

test("child file activation does not invoke hostile event target or element getters", async () => {
  const { buildWrapperDocument } = await adapter();
  const child = childHarness(wrapperHarness(buildWrapperDocument).frame.srcdoc);
  const input = child.input({ type: "file" });
  const label = child.label({ control: input });
  child.event({ ...base, type: "bind" });
  child.event({ ...base, type: "init", card: { ...card, js: `globalThis.activated = 0;
    for (const type of ["click", "keydown", "pointerdown", "mousedown", "touchstart"]) window.addEventListener(type, () => activated++, true);
    Object.defineProperty(Event.prototype, "target", { get() { throw new Error("Hostile Event prototype getter"); } });
    for (const name of ["closest", "matches", "querySelector"]) Element.prototype[name] = () => { throw new Error("Hostile DOM prototype method"); };
    Object.defineProperty(HTMLLabelElement.prototype, "control", { get() { throw new Error("Hostile label prototype getter"); } });` } });
  for (const target of [input, label]) {
    for (const property of ["closest", "type", "control", "querySelector"]) Object.defineProperty(target, property, { get() { throw new Error(`Hostile ${property} getter`); } });
    for (const type of ["click", "keydown", "pointerdown", "mousedown", "touchstart"]) {
      const event = child.createEvent(type, { target });
      Object.defineProperty(event, "target", { get() { throw new Error("Hostile event target getter"); } });
      child.dispatch(event);
      assert.equal(child.eventState(event).defaultPrevented, true, type);
      assert.equal(child.eventState(event).immediateStopped, true, type);
    }
  }
  assert.equal(child.context.activated, 0);
  assert.throws(() => input.click(), /disabled/);
  assert.throws(() => input.showPicker(), /disabled/);
  assert.throws(() => vm.runInContext('window.showOpenFilePicker()', child.context), /disabled/);
});
