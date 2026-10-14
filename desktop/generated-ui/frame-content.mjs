// Adapted from OpenIntelligentUI, commit 8391a94c1c3939c679e40ddd7bfc08a9ef690e70.
// See third_party/open-intelligent-ui/{LICENSE,README.md,manifest.json}.
import { readFileSync } from "node:fs";
import { WRAPPER_CSP } from "./policy.mjs";
export { WRAPPER_CSP } from "./policy.mjs";

export const ADAPTER_VERSION = "open-intelligent-ui-8391a94-deck-1";
export const SECURITY_POLICY_VERSION = "generated-ui-deny-all-1";
export const CHILD_CSP = WRAPPER_CSP.replace("frame-src about:; child-src about:", "frame-src 'none'; child-src 'none'");

const DESIGN_SYSTEM_CSS = readFileSync(new URL("../../third_party/open-intelligent-ui/design-system.css", import.meta.url), "utf8");
if (/@import|url\s*\(|<\/style/i.test(DESIGN_SYSTEM_CSS)) throw new Error("Generated UI design styles failed the local-source audit");

/** Upstream renderer.tsx finite-number validation, with Deck's 200–800px bounds. */
export function clampReportedHeight(height) {
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return Math.max(200, Math.min(Math.ceil(height), 800));
}

// This fixed script contains no model bytes. It runs before any card markup.
const CHILD_BOOTSTRAP_JS = String.raw`(() => {
  "use strict";
  const parentWindow = parent;
  const sendToParent = parentWindow.postMessage.bind(parentWindow);
  const create = document.createElement.bind(document);
  const appendHead = document.head.appendChild.bind(document.head);
  const appendBody = document.body.appendChild.bind(document.body);
  // Keep native event/DOM operations before model code can replace methods,
  // prototypes, or per-instance getters. Invoke them through this saved call.
  const call = Function.prototype.call.bind(Function.prototype.call);
  const nativePreventDefault = Event.prototype.preventDefault;
  const nativeStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
  const nativeEventTarget = Object.getOwnPropertyDescriptor(Event.prototype, "target").get;
  const nativeClosest = Element.prototype.closest;
  const nativeMatches = Element.prototype.matches;
  const nativeQuerySelector = Element.prototype.querySelector;
  const nativeLabelControl = Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype, "control").get;
  const encode = new TextEncoder();
  const keysAre = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const baseKeys = ["protocolVersion", "runId", "revisionDigest", "type"];
  const colorNames = { background: "--deck-background", surface: "--deck-surface", foreground: "--deck-foreground", muted: "--deck-muted", border: "--deck-border", accent: "--deck-accent" };
  const isColor = (value) => typeof value === "string" && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value);
  let authority = null;
  let initialized = false;
  let initializingBehavior = false;
  let initializationFailed = false;
  let initializationComplete = false;
  // Script-node syntax/runtime errors are reported as Window error events;
  // appendChild does not throw them. This capture listener precedes model code.
  window.addEventListener("error", () => { if (initializingBehavior) initializationFailed = true; }, true);
  function bound(message, extra = []) {
    return authority && keysAre(message, baseKeys.concat(extra)) && message.protocolVersion === 1 && message.runId === authority.runId && message.revisionDigest === authority.revisionDigest;
  }
  function emit(type, payload = {}) {
    if (authority) sendToParent({ protocolVersion: 1, runId: authority.runId, revisionDigest: authority.revisionDigest, type, ...payload }, "*");
  }

  // Defense in depth only: host permission/file-selection verification remains
  // a release gate. Generated JS is hostile and gets no trusted authority.
  const denyPicker = () => { throw new Error("File pickers are disabled in generated interfaces"); };
  for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
    Object.defineProperty(window, name, { value: denyPicker, writable: false, configurable: false });
  }
  const nativeClick = HTMLElement.prototype.click;
  Object.defineProperty(HTMLElement.prototype, "click", {
    configurable: false, writable: false,
    value: function() { if (call(nativeMatches, this, 'input[type="file"]')) return denyPicker(); return call(nativeClick, this); }
  });
  if (HTMLInputElement.prototype.showPicker) {
    const nativePicker = HTMLInputElement.prototype.showPicker;
    Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
      configurable: false, writable: false,
      value: function() { if (call(nativeMatches, this, 'input[type="file"]')) return denyPicker(); return call(nativePicker, this); }
    });
  }
  const blockEvent = (event) => {
    call(nativePreventDefault, event);
    call(nativeStopImmediatePropagation, event);
  };
  const blockFileActivation = (event) => {
    let target;
    try { target = call(nativeClosest, call(nativeEventTarget, event), 'input[type="file"], label'); } catch { return; }
    if (!target) return;
    const control = call(nativeMatches, target, "label") ? call(nativeLabelControl, target) : null;
    if (call(nativeMatches, target, 'input[type="file"]') || (control && call(nativeMatches, control, 'input[type="file"]')) || call(nativeQuerySelector, target, 'input[type="file"]')) blockEvent(event);
  };
  // Window is the first capture target. Register before any model listener;
  // a Document listener would run after a hostile Window capture listener.
  for (const type of ["click", "keydown", "pointerdown", "mousedown", "touchstart"]) window.addEventListener(type, blockFileActivation, { capture: true, passive: false });
  for (const type of ["dragenter", "dragover", "drop", "paste"]) window.addEventListener(type, blockEvent, { capture: true, passive: false });
  const disableFiles = () => { for (const input of document.querySelectorAll('input[type="file"]')) if (!input.disabled) input.disabled = true; };
  new MutationObserver(disableFiles).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "disabled"] });

  // MEASUREMENT_JS from upstream frame-content.ts: body scrollHeight plus
  // computed margins, ResizeObserver, window resize/load and a short poll.
  // Deck permits internal scrolling and the wrapper/main clamp the report.
  function installMeasurement() {
    const style = create("style");
    style.textContent = "html, body { height: auto !important; min-height: 0 !important; }";
    appendHead(style);
    let previous = -Infinity;
    function reportHeight() {
      const now = performance.now();
      if (now - previous < 100) return;
      previous = now;
      let height = document.body.scrollHeight;
      const computed = getComputedStyle(document.body);
      height += parseFloat(computed.marginTop) || 0;
      height += parseFloat(computed.marginBottom) || 0;
      if (Number.isFinite(height)) emit("resize", { height: Math.ceil(height) });
    }
    new ResizeObserver(reportHeight).observe(document.body);
    window.addEventListener("resize", reportHeight);
    window.addEventListener("load", reportHeight);
    const interval = setInterval(reportHeight, 200);
    setTimeout(() => clearInterval(interval), 3000);
    reportHeight();
  }
  Object.defineProperty(window, "generatedUI", { configurable: false, writable: false, value: Object.freeze({
    discuss(text) { if (initializationComplete && typeof text === "string" && text.trim() && text.length <= 4000) emit("discuss", { text }); }
  }) });
  window.addEventListener("message", (event) => {
    if (event.source !== parentWindow || event.ports.length) return;
    const message = event.data;
    if (!authority) {
      if (!keysAre(message, baseKeys) || message.type !== "bind" || message.protocolVersion !== 1 || typeof message.runId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.runId) || typeof message.revisionDigest !== "string" || !/^[a-f0-9]{64}$/.test(message.revisionDigest)) return;
      authority = { runId: message.runId, revisionDigest: message.revisionDigest };
      emit("bootstrap");
      return;
    }
    if (message && message.type === "init" && bound(message, ["card"]) && !initialized) {
      const card = message.card;
      const cardKeys = ["schemaVersion", "kind", "cardId", "title", "summary", "html", "css", "js", "fallback"];
      if (!keysAre(card, cardKeys) || card.schemaVersion !== 1 || card.kind !== "generated" || !cardKeys.slice(2).every((key) => typeof card[key] === "string") || !card.html.trim()) return;
      const htmlBytes = encode.encode(card.html).length, cssBytes = encode.encode(card.css).length, jsBytes = encode.encode(card.js).length;
      if (htmlBytes > 49152 || cssBytes > 16384 || jsBytes > 32768 || htmlBytes + cssBytes + jsBytes > 65536) return;
      initialized = true;
      // Reuse upstream final composition order: trusted head/design system,
      // generated CSS, complete markup, then one behavior phase.
      const style = create("style");
      style.textContent = card.css;
      appendHead(style);
      document.body.innerHTML = card.html;
      disableFiles();
      if (card.js) {
        const behavior = create("script");
        behavior.textContent = card.js;
        initializingBehavior = true;
        try { appendBody(behavior); } finally { initializingBehavior = false; }
      }
      if (initializationFailed) return;
      installMeasurement();
      initializationComplete = true;
      emit("ready");
    } else if (message && message.type === "ping" && bound(message, ["nonce"]) && initializationComplete && typeof message.nonce === "string" && message.nonce.length > 0 && message.nonce.length <= 128) {
      emit("pong", { nonce: message.nonce });
    } else if (message && message.type === "theme" && bound(message, ["tokens"]) && message.tokens && typeof message.tokens === "object" && !Array.isArray(message.tokens)) {
      const entries = Object.entries(message.tokens);
      if (entries.length <= Object.keys(colorNames).length && entries.every(([name, value]) => Object.hasOwn(colorNames, name) && isColor(value))) {
        for (const [name, value] of entries) document.documentElement.style.setProperty(colorNames[name], value);
      }
    }
  });
})();`;

/** Adapted buildFinalFrameContent: fixed head first, audited theme, fixed body/bootstrap. */
function buildFinalFrameContent() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CHILD_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${DESIGN_SYSTEM_CSS}</style></head><body><script>${CHILD_BOOTSTRAP_JS}</script></body></html>`;
}

/** Trusted wrapper bytes only. Payloads enter the child through structured messages. */
export function buildWrapperDocument({ runId, revisionDigest }) {
  if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || typeof revisionDigest !== "string" || !/^[a-f0-9]{64}$/.test(revisionDigest)) throw new TypeError("Invalid generated UI run binding");
  const binding = JSON.stringify({ protocolVersion: 1, runId, revisionDigest });
  const fixedChild = JSON.stringify(buildFinalFrameContent()).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{width:100%;height:100%;border:0;background:transparent}</style></head><body><iframe id="generated-frame" sandbox="allow-scripts" connectionallowlist="()" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; payment 'none'; fullscreen 'none'; web-share 'none'; local-fonts 'none'; screen-wake-lock 'none'; storage-access 'none'"></iframe><script>(() => {
  "use strict";
  const binding = ${binding};
  const frame = document.getElementById("generated-frame");
  const host = window.generatedUIHost;
  const clampHeight = ${clampReportedHeight.toString()};
  const baseKeys = ["protocolVersion", "runId", "revisionDigest", "type"];
  const keysAre = (value, extra) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === baseKeys.length + extra.length && baseKeys.concat(extra).every((key) => Object.hasOwn(value, key));
  const bound = (value, extra = []) => keysAre(value, extra) && value.protocolVersion === 1 && value.runId === binding.runId && value.revisionDigest === binding.revisionDigest;
  const byteLength = (value) => { try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return Infinity; } };
  let bootstrap = false, initialized = false, ready = false;
  let faulted = false, budgetStart = null, budgetCount = 0, overLimitWindows = 0, lastResize = -Infinity;
  function acceptChildEvent() {
    const now = performance.now();
    if (budgetStart === null) budgetStart = now;
    else if (now - budgetStart >= 1000) {
      // An empty or compliant intervening window breaks a sustained flood.
      const elapsedWindows = Math.floor((now - budgetStart) / 1000);
      if (elapsedWindows > 1 || budgetCount <= 30) overLimitWindows = 0;
      budgetStart += elapsedWindows * 1000;
      budgetCount = 0;
    }
    budgetCount++;
    if (budgetCount > 60 || (budgetCount === 31 && ++overLimitWindows >= 3)) {
      faulted = true;
      host.postMessage({ ...binding, type: "fault", code: "message-flood" });
      return false;
    }
    return budgetCount <= 30;
  }
  // Install listeners before creating the sole fixed child document.
  frame.addEventListener("load", () => { if (!faulted && !bootstrap) frame.contentWindow.postMessage({ ...binding, type: "bind" }, "*"); });
  window.addEventListener("message", (event) => {
    // Count even malformed, oversized, or port-bearing traffic from the child
    // before expensive serialization and validation. Foreign senders do not count.
    if (faulted || event.source !== frame.contentWindow || !acceptChildEvent() || event.ports.length || byteLength(event.data) > 8192) return;
    const message = event.data;
    if (!message || typeof message.type !== "string") return;
    if (message.type === "bootstrap" && bound(message) && !bootstrap) { bootstrap = true; host.postMessage(message); }
    else if (message.type === "ready" && bound(message) && initialized && !ready) { ready = true; host.postMessage(message); }
    else if (message.type === "pong" && bound(message, ["nonce"]) && initialized && typeof message.nonce === "string" && message.nonce.length > 0 && message.nonce.length <= 128) host.postMessage(message);
    else if (message.type === "resize" && bound(message, ["height"]) && initialized) { const height = clampHeight(message.height), now = performance.now(); if (height !== null && now - lastResize >= 100) { lastResize = now; host.postMessage({ ...message, height }); } }
    else if (message.type === "discuss" && bound(message, ["text"]) && initialized && typeof message.text === "string" && message.text.trim() && message.text.length <= 4000) host.postMessage(message);
  });
  host.onCommand((message) => {
    if (faulted || !bootstrap || !message || typeof message.type !== "string") return;
    if (message.type === "init" && bound(message, ["card"]) && !initialized && byteLength(message) <= 132096) { initialized = true; frame.contentWindow.postMessage(message, "*"); }
    else if (message.type === "ping" && bound(message, ["nonce"]) && initialized && typeof message.nonce === "string" && message.nonce.length > 0 && message.nonce.length <= 128) frame.contentWindow.postMessage(message, "*");
    else if (message.type === "theme" && bound(message, ["tokens"]) && byteLength(message) <= 8192) frame.contentWindow.postMessage(message, "*");
  });
  frame.srcdoc = ${fixedChild};
})();</script></body></html>`;
}
