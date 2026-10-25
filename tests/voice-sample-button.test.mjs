import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";
import { voiceLabel } from "../src/voice/callView.ts";

const source = fs.readFileSync(new URL("../src/voice/VoiceSampleButton.tsx", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export function", "function");
const compiled = transform(source, { transforms: ["typescript", "jsx"], production: true }).code;
function render(status) {
  const controller = { subscribe: () => () => {}, getState: () => ({ status }) };
  const Component = new Function("React", "useEffect", "useRef", "useState", "useSyncExternalStore", "voiceLabel", "voiceController", "warmVoice", compiled + ";return VoiceSampleButton;")(
    React, useEffect, useRef, useState, useSyncExternalStore, voiceLabel, controller, () => {},
  );
  return renderToStaticMarkup(React.createElement(Component, { voice: "bf_emma" }));
}
test("config sample button is disabled with an explanation throughout an active call", () => {
  for (const status of ["warming", "listening", "waiting", "speaking"]) {
    const html = render(status);
    assert.match(html, /disabled=""/);
    assert.match(html, /call.*preview/i);
  }
});
test("config sample button remains available when off or after a call error", () => {
  for (const status of ["off", "error"]) assert.doesNotMatch(render(status), /disabled=""/);
});
