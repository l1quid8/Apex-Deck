import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// ScanCodeButton is the camera control Machines renders. PhoneApp passes it the
// same gate incoming links use. Mounting all of PhoneApp pulls the terminal,
// so this mounts that control with React and leaves scan() unresolved.

register(new URL("./helpers/tsx-loader.mjs", import.meta.url), { parentURL: import.meta.url });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class HTMLElement {}
class Element {}
class Node {
  static ELEMENT_NODE = 1;
  static TEXT_NODE = 3;
}
class HTMLIFrameElement extends HTMLElement {}
class HTMLInputElement extends HTMLElement {}
class HTMLButtonElement extends HTMLElement {}
class SVGElement extends Element {}
Object.assign(globalThis, { HTMLElement, Element, Node, HTMLIFrameElement, HTMLInputElement, HTMLButtonElement, SVGElement, window: globalThis });

function element(tag = "DIV") {
  return {
    nodeType: 1,
    tagName: tag,
    nodeName: tag,
    style: {},
    childNodes: [],
    attributes: {},
    namespaceURI: "http://www.w3.org/1999/xhtml",
    setAttribute(key, value) { this.attributes[key] = String(value); },
    getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; },
    removeAttribute(key) { delete this.attributes[key]; },
    hasAttribute(key) { return Object.hasOwn(this.attributes, key); },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = this.childNodes.indexOf(ref);
      if (index < 0) this.childNodes.push(child);
      else this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    addEventListener(type, fn) { (this.listeners ||= []).push([type, fn]); },
    removeEventListener(type, fn) {
      if (this.listeners) this.listeners = this.listeners.filter(([heard, listener]) => heard !== type || listener !== fn);
    },
    getBoundingClientRect() { return { top: 0, left: 0, width: 10, height: 10, bottom: 10, right: 10 }; },
    focus() {},
    blur() {},
    contains() { return false; },
    ownerDocument: null,
  };
}

const document = {
  createElement(tag) {
    const node = element(String(tag).toUpperCase());
    node.ownerDocument = document;
    return node;
  },
  createElementNS(_namespace, tag) { return document.createElement(tag); },
  createTextNode(text) { return { nodeType: 3, nodeName: "#text", textContent: String(text), parentNode: null }; },
  addEventListener() {},
  removeEventListener() {},
  documentElement: null,
  body: null,
  defaultView: globalThis,
  activeElement: null,
};
document.body = document.createElement("body");
document.documentElement = document.createElement("html");
document.documentElement.appendChild(document.body);
globalThis.document = document;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

function findButton(node, label) {
  if (!node || node.nodeType === 3) return null;
  if (node.tagName === "BUTTON" && node.textContent === label) return node;
  for (const child of node.childNodes || []) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

async function click(node) {
  const { act } = await import("react");
  const event = {
    type: "click",
    target: node,
    currentTarget: document.body,
    preventDefault() {},
    stopPropagation() {},
    bubbles: true,
    button: 0,
    defaultPrevented: false,
  };
  await act(async () => {
    for (const [type, fn] of document.body.listeners || []) {
      if (type === "click") fn(event);
    }
  });
}

test("a link is refused while the camera control is open, and the scan still pairs", async () => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ScanCodeButton } = await import("../src/phone/ScanCodeButton.tsx");
  const { ALREADY_PAIRING, createPairingGate, openIncomingLinks, reserveLocal, takeScan } = await import("../src/phone/incomingLinks.ts");
  const { RELAY } = await import("../src/phone/pairing.ts");

  const host = "ab".repeat(32);
  const wire = { v: 1, host, name: "Tyler's Mac Studio", relay: RELAY, addrs: ["192.168.1.20:41641"], inv: "BwcHBwcHBwcHBwcHBwcHBw", secret: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk", exp: 1_800_000_300 };
  const scanned = `apexdeck://pair?p=${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
  const other = `apexdeck://pair?p=${Buffer.from(JSON.stringify({ ...wire, host: "cd".repeat(32), name: "Other Mac" })).toString("base64url")}`;

  let resolveScan;
  const scan = () => new Promise((resolve) => { resolveScan = resolve; });
  const notices = [];
  const paired = [];
  const gate = createPairingGate((message) => notices.push(message));
  const started = [];
  let listener;
  const app = {
    emit(url) { listener?.({ url }); },
    addListener(_event, cb) {
      listener = cb;
      return Promise.resolve({ async remove() { if (listener === cb) listener = null; } });
    },
    getLaunchUrl() { return Promise.resolve(undefined); },
  };
  const opened = openIncomingLinks(app, async (url) => {
    started.push(url);
    return "cancelled";
  }, { refuse() {}, invalid() {}, broken() {} }, gate);

  const root = createRoot(document.body);
  const props = {
    scan,
    reserve: (link) => reserveLocal(gate, link),
    adopt: (link) => takeScan(gate, link),
    giveBack: (link) => gate.release(link, "failed"),
    onCode: (text) => { paired.push(text); return true; },
    onError: (message) => notices.push(message),
  };
  try {
    await act(async () => { root.render(createElement(ScanCodeButton, props)); });
    const button = findButton(document.body, "Scan QR code");
    assert.ok(button, "the real Scan QR code button is mounted");
    await click(button);
    assert.equal(typeof resolveScan, "function", "scan() is in flight");
    app.emit(other);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [], "the link does not start underneath the camera");
    assert.deepEqual(notices, [ALREADY_PAIRING]);
    assert.deepEqual(paired, []);
    await act(async () => { resolveScan(scanned); });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(paired, [scanned], "the camera attempt carries on and pairs its code");
    app.emit(other);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, []);
    assert.deepEqual(notices, [ALREADY_PAIRING, ALREADY_PAIRING]);
  } finally {
    opened.close();
    await act(async () => { root.unmount(); });
  }
});
