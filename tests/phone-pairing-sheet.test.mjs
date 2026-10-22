import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ALREADY_PAIRING, createPairingGate, openIncomingLinks, reserveLocal, settlePairing } from "../src/phone/incomingLinks.ts";
import { RELAY, startPairing } from "../src/phone/pairing.ts";

// PairSheet is mounted on a small host that runs its effects. One gate is shared
// by the camera button, paste, and incoming links, and a failure releases that
// gate while the error is still on screen. PhoneApp uses the same split.

const require = createRequire(import.meta.url);
const { transform } = require("sucrase");

const HOST = "ab".repeat(32);
const now = 1_800_000_000;
function link(fields = {}) {
  const wire = { v: 1, host: HOST, name: "Tyler's Mac Studio", relay: RELAY, addrs: ["192.168.1.20:41641"], inv: "BwcHBwcHBwcHBwcHBwcHBw", secret: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk", exp: now + 300, ...fields };
  return `apexdeck://pair?p=${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
}
const LINK_A = link();
const LINK_B = link({ host: "cd".repeat(32), name: "Other Mac" });
const flush = () => new Promise((resolve) => setImmediate(resolve));

const source = fs.readFileSync(new URL("../src/phone/PairSheet.tsx", import.meta.url), "utf8");
const compiled = transform(source.replace(/^import .*$/gm, "").replace(/^export /gm, ""), {
  transforms: ["typescript", "jsx"], jsxRuntime: "classic", production: true,
}).code;
const Fragment = function Fragment() {};
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child != null && child !== false && child !== true);
  return { type, key: props?.key, props: props ?? {}, children: flat };
}
let currentSlot = null;
function useState(initial) {
  const slot = currentSlot;
  const index = slot.cursor++;
  if (!Object.prototype.hasOwnProperty.call(slot.states, index)) {
    slot.states[index] = typeof initial === "function" ? initial() : initial;
  }
  return [slot.states[index], (value) => {
    slot.states[index] = typeof value === "function" ? value(slot.states[index]) : value;
  }];
}
function useRef(initial) {
  const slot = currentSlot;
  const index = slot.cursor++;
  if (!Object.prototype.hasOwnProperty.call(slot.states, index)) slot.states[index] = { current: initial };
  return slot.states[index];
}
function useEffect(fn, deps) {
  const slot = currentSlot;
  const index = slot.cursor++;
  const old = slot.effects[index];
  const changed = !old || deps == null || old.deps == null || deps.length !== old.deps.length || deps.some((dep, i) => dep !== old.deps[i]);
  if (changed) slot.effects[index] = { fn, deps, pending: true, cleanup: old?.cleanup };
  else old.pending = false;
}
const React = { createElement, Fragment };
const { PairSheet } = new Function("React", "useState", "useEffect", "useRef", "startPairing", "writeClipboard", `${compiled}\nreturn { PairSheet };`)(React, useState, useEffect, useRef, startPairing, async () => true);

function createHost() {
  const slots = new Map();
  function flushEffects(slot) {
    for (const effect of slot.effects) {
      if (!effect?.pending) continue;
      effect.pending = false;
      effect.cleanup?.();
      effect.cleanup = effect.fn() || undefined;
    }
  }
  function renderNode(node, path) {
    if (node == null || node === false || node === true || typeof node === "string" || typeof node === "number") return node;
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}/${index}`));
    if (node.type === Fragment) return renderNode(node.children, path);
    if (typeof node.type === "function") {
      const id = `${path}|${node.key ?? ""}|${node.type.name || "anon"}`;
      let slot = slots.get(id);
      if (!slot) slot = { states: [], effects: [], cursor: 0 };
      slot.seen = true;
      slot.cursor = 0;
      slots.set(id, slot);
      const previous = currentSlot;
      currentSlot = slot;
      const tree = node.type(node.props);
      flushEffects(slot);
      currentSlot = previous;
      return renderNode(tree, `${id}/out`);
    }
    return { ...node, children: renderNode(node.children, path) };
  }
  return {
    draw(type) {
      for (const slot of slots.values()) slot.seen = false;
      const tree = renderNode({ type, key: "", props: {} }, "root");
      for (const id of [...slots.keys()]) {
        const slot = slots.get(id);
        if (slot.seen) continue;
        for (const effect of slot.effects) effect?.cleanup?.();
        slots.delete(id);
      }
      return tree;
    },
    unmount() {
      for (const slot of slots.values()) {
        for (const effect of slot.effects) effect?.cleanup?.();
      }
      slots.clear();
    },
  };
}
function text(node) {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text(node.children);
}
function find(node, pred) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, pred);
      if (found) return found;
    }
    return null;
  }
  if (pred(node)) return node;
  return find(node.children, pred);
}
const button = (tree, label) => find(tree, (node) => node.type === "button" && text(node) === label);

function fakeApp() {
  let listener = null;
  return {
    emit(url) { listener?.({ url }); },
    addListener(_event, cb) {
      listener = cb;
      return Promise.resolve({ async remove() { if (listener === cb) listener = null; } });
    },
    getLaunchUrl() { return Promise.resolve(undefined); },
  };
}
function fakePlugin(mode) {
  const calls = [];
  return {
    calls,
    pair(url) {
      calls.push(url);
      if (mode() === "fail") return Promise.reject(new Error("no route"));
      return new Promise(() => {});
    },
    pairCancel() { return Promise.resolve(); },
    listen() { return () => {}; },
  };
}

function mount(plugin, app, scan) {
  const host = createHost();
  function Desk() {
    const [notice, setNotice] = useState("");
    const [pairing, setPairing] = useState(null);
    const [pasted, setPasted] = useState("");
    const gate = useRef(null);
    const seq = useRef(0);
    const linkResolve = useRef(null);
    if (!gate.current) gate.current = createPairingGate((message) => setNotice(message));
    useEffect(() => {
      const opened = openIncomingLinks(app, (url) => new Promise((resolve) => {
        linkResolve.current = resolve;
        setPairing({ link: url, name: "Mac", attempt: ++seq.current });
      }), {
        refuse: (message) => setNotice(message),
        invalid: (message) => setNotice(message),
        broken: (message) => setNotice(message),
      }, gate.current);
      return () => opened.close();
    }, []);
    const beginLocal = (url) => {
      if (!reserveLocal(gate.current, url)) return;
      linkResolve.current = null;
      setPairing({ link: url, name: "Mac", attempt: ++seq.current });
    };
    return createElement("div", null,
      createElement("button", { type: "button", onClick: () => beginLocal(scan.url) }, "Scan QR code"),
      createElement("form", { onSubmit: (event) => { event.preventDefault(); beginLocal(pasted); } },
        createElement("input", { "aria-label": "Or paste the pairing link", value: pasted, onChange: (event) => setPasted(event.target.value) }),
        createElement("button", { type: "submit" }, "Pair with link"),
      ),
      createElement("p", { role: "status" }, notice),
      pairing && createElement(PairSheet, {
        key: pairing.attempt,
        plugin,
        link: pairing.link,
        label: "iPhone",
        onFailed: () => {
          linkResolve.current = settlePairing(gate.current, pairing.link, "failed", linkResolve.current);
        },
        onPaired: () => {
          linkResolve.current = settlePairing(gate.current, pairing.link, "paired", linkResolve.current);
        },
        onClose: (why) => {
          const outcome = why === "failed" ? "failed" : "cancelled";
          linkResolve.current = settlePairing(gate.current, pairing.link, outcome, linkResolve.current);
          setPairing(null);
        },
      }),
    );
  }
  return { unmount: () => host.unmount(), draw: () => host.draw(Desk) };
}

test("camera, paste and links share one sheet, and a failure can be retried while it is still showing", async () => {
  const phone = fs.readFileSync(new URL("../src/phone/PhoneApp.tsx", import.meta.url), "utf8");
  assert.match(phone, /onFailed=\{\(\) => settle\("failed", false\)\}/);
  assert.match(phone, /reserve=\{\(link\) => reserveLocal/);
  assert.match(phone, /giveBack=\{\(link\) => gateRef\.current!\.release\(link, "failed"\)\}/);
  assert.match(phone, /pairWith\(link\.url, \{ kind: link\.kind \}, true\)/);

  const mode = { value: "hang" };
  const plugin = fakePlugin(() => mode.value);
  const scan = { url: LINK_A };

  const camera = fakeApp();
  const duringCamera = mount(plugin, camera, scan);
  try {
    let tree = duringCamera.draw();
    button(tree, "Scan QR code").props.onClick();
    tree = duringCamera.draw();
    assert.match(text(tree), /Reaching the machine/);
    assert.deepEqual(plugin.calls, [LINK_A]);
    camera.emit(LINK_B);
    await flush();
    tree = duringCamera.draw();
    assert.match(text(tree), /Reaching the machine/, "the camera sheet stays");
    assert.match(text(tree), new RegExp(ALREADY_PAIRING));
    assert.deepEqual(plugin.calls, [LINK_A], "the link does not start a second attempt");
  } finally {
    duringCamera.unmount();
  }

  const linked = fakeApp();
  const duringLink = mount(plugin, linked, scan);
  try {
    let tree = duringLink.draw();
    linked.emit(LINK_A);
    tree = duringLink.draw();
    await flush();
    tree = duringLink.draw();
    assert.match(text(tree), /Reaching the machine/);
    const before = plugin.calls.length;
    scan.url = LINK_B;
    button(tree, "Scan QR code").props.onClick();
    tree = duringLink.draw();
    assert.match(text(tree), /Reaching the machine/, "the link sheet stays");
    assert.match(text(tree), new RegExp(ALREADY_PAIRING));
    assert.equal(plugin.calls.length, before, "the camera does not replace the link sheet");
    find(tree, (node) => node.type === "input").props.onChange({ target: { value: link({ name: "Pasted Mac" }) } });
    tree = duringLink.draw();
    find(tree, (node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    tree = duringLink.draw();
    assert.match(text(tree), /Reaching the machine/);
    assert.equal(plugin.calls.length, before, "paste does not replace the link sheet");
    assert.match(text(tree), new RegExp(ALREADY_PAIRING));
  } finally {
    duringLink.unmount();
  }

  mode.value = "fail";
  const failing = fakeApp();
  const retry = mount(plugin, failing, { url: LINK_A });
  try {
    retry.draw();
    failing.emit(LINK_A);
    let tree = retry.draw();
    await flush();
    tree = retry.draw();
    assert.match(text(tree), /Pairing didn't finish: no route/);
    assert.equal(button(tree, "OK").type, "button", "the error is still on screen");
    const before = plugin.calls.length;
    failing.emit(LINK_A);
    await flush();
    tree = retry.draw();
    assert.equal(plugin.calls.length, before + 1, "the same link starts again without pressing OK");
    assert.equal(plugin.calls.at(-1), LINK_A);
    assert.match(text(tree), /Reaching the machine/);
  } finally {
    retry.unmount();
  }
});
