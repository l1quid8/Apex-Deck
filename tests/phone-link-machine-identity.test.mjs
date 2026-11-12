import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "sucrase";
import { routePairingLink } from "../src/phone/incomingLinks.ts";
import { identityFor, parsePairingLink, RELAY, withPairedMachine } from "../src/phone/pairing.ts";

// Run the actual Machines incoming-link effect and pairWith validation, without
// rendering the unrelated settings cards or making a native connection.
const source = readFileSync(new URL("../src/phone/PhoneApp.tsx", import.meta.url), "utf8");
const start = source.indexOf("function Machines(");
const end = source.indexOf('  return (\n    <main className="ph-content"', start);
assert.ok(start > 0 && end > start);
const compiled = transform(`${source.slice(start, end)} return null; }`, { transforms: ["typescript"] }).code;
const Machines = new Function("useState", "useEffect", "defaultAddHow", "identityFor", "parsePairingLink", "withPairedMachine", "words", `${compiled}; return Machines;`)(
  (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  (effect) => effect(), () => "qr", identityFor, parsePairingLink, withPairedMachine, String,
);
const mac = { id: "local", name: "Mac", kind: "mac", transport: "iroh", hostEndpointId: "ab".repeat(32), addrs: [], pairedAt: 1 };
const home = { ...mac, id: "h-home", name: "STREAMVAULT", kind: "server", hostEndpointId: "cd".repeat(32) };

function receive(list, fields) {
  const wire = { v: 1, host: "ef".repeat(32), name: "Apex-Terminal", os: "linux", relay: RELAY, addrs: [], inv: "invite", secret: "secret", exp: Date.now() / 1000 + 300, ...fields };
  const url = `apexdeck://pair?p=${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
  let next;
  Machines({ machines: list, missing: [], pairing: true, incoming: { ...routePairingLink(), id: 1, url },
    onIncomingHandled() {}, onIncomingFailed() { assert.fail("link rejected"); },
    onError(message) { assert.fail(message); }, reserve() { assert.fail("link already holds the slot"); },
    onPair(request) {
      next = withPairedMachine(list, { id: request.id, kind: request.kind, name: request.name, transport: "iroh", hostEndpointId: wire.host, addrs: wire.addrs, pairedAt: 2 });
    },
  });
  return next;
}

for (const os of ["linux", "", "macos"]) {
  test(`incoming ${os || "legacy"} machine link preserves the existing Mac and home server`, () => {
    const next = receive([mac, home], { os });
    assert.equal(next.length, 3);
    assert.equal(next[0], mac);
    assert.equal(next[1], home);
    assert.equal(next[2].kind, "server");
    assert.equal(next[2].id, `h-${"ef".repeat(6)}`);
  });
}

test("a link for the already paired Mac updates that Mac without adding a server", () => {
  const next = receive([mac, home], { host: mac.hostEndpointId, os: "macos", name: "Mac", addrs: ["192.0.2.1:41641"] });
  assert.equal(next.length, 2);
  assert.equal(next[0].id, "local");
  assert.equal(next[0].hostEndpointId, mac.hostEndpointId);
  assert.deepEqual(next[0].addrs, ["192.0.2.1:41641"]);
  assert.equal(next[1], home);
});

test("the first Mac link still creates the local Mac", () => {
  const next = receive([], { os: "macos", name: "Mac" });
  assert.equal(next[0].kind, "mac");
  assert.equal(next[0].id, "local");
});
