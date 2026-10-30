import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import { identityFor, withPairedMachine } from "../src/phone/pairing.ts";
import { goodPort, hostPort, parseHost, readKey, sshFormError, sshRequest, sshTarget } from "../src/phone/sshSetup.ts";

const require = createRequire(import.meta.url);

/** An OpenSSH key file with the given cipher and key type. Only the header is real. */
function keyFile(cipher, type = "ssh-ed25519") {
  const field = (text) => [0, 0, 0, text.length].map((byte) => String.fromCharCode(byte)).join("") + text;
  const blob = "openssh-key-v1\0" + field(cipher) + field(cipher === "none" ? "none" : "bcrypt") + field("") + "\0\0\0\x01" + field(field(type) + "public") + field("private");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa(blob)}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

const form = (over = {}) => ({ label: "", host: "203.0.113.10", user: "demo", port: "22", password: "pw", key: null, passphrase: "", keep: false, ...over });
const endpoint = (fill) => fill.repeat(64);
const paired = (id, name, kind, fill) => ({ id, name, kind, transport: "iroh", hostEndpointId: endpoint(fill), addrs: [], pairedAt: 1 });
const preview = (name, fill) => ({ name, host: endpoint(fill), addrs: [], exp: 0 });

test("the host box takes what people paste", () => {
  assert.deepEqual(parseHost("  https://root@server.example.com:2222/path "), { host: "server.example.com", port: "2222" });
  assert.deepEqual(parseHost("203.0.113.10"), { host: "203.0.113.10" });
  assert.deepEqual(parseHost("[2001:db8::1]:2200"), { host: "2001:db8::1", port: "2200" });
  assert.deepEqual(parseHost("2001:db8::1"), { host: "2001:db8::1" });
  assert.deepEqual(parseHost("host:abc"), { host: "host", port: "abc" });
});

test("ports outside 1 to 65535 are refused", () => {
  for (const good of ["1", "22", "65535"]) assert.equal(goodPort(good), true);
  for (const bad of ["0", "65536", "", "abc", "-1", "2.2"]) assert.equal(goodPort(bad), false);
  assert.equal(hostPort("2001:db8::1", "22"), "[2001:db8::1]:22");
});

test("a key file says whether it needs a passphrase", () => {
  assert.deepEqual({ ...readKey("id_ed25519", keyFile("aes256-ctr")), text: "" }, { name: "id_ed25519", text: "", type: "ed25519", locked: true });
  assert.equal(readKey("id", keyFile("none")).locked, false);
  assert.equal(readKey("id", keyFile("none", "ssh-rsa")).type, "rsa");
});

test("anything but an OpenSSH private key is refused", () => {
  const bad = ["ssh-ed25519 AAAA me@mac", "PuTTY-User-Key-File-3: ssh-ed25519", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----", "",
    "-----BEGIN OPENSSH PRIVATE KEY-----\n@@@\n-----END OPENSSH PRIVATE KEY-----", `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa("openssh-key-v1\0\0\0\0\xff")}\n-----END OPENSSH PRIVATE KEY-----`];
  for (const text of bad) assert.throws(() => readKey("x", text), /isn't an OpenSSH private key/);
});

test("Connect says what's missing, in form order", () => {
  assert.match(sshFormError(form({ host: "" })), /host and user/);
  assert.match(sshFormError(form({ user: " " })), /host and user/);
  assert.match(sshFormError(form({ port: "70000" })), /Port 70000/);
  assert.match(sshFormError(form({ host: "h:abc" })), /Port abc/);
  assert.match(sshFormError(form({ password: "" })), /private key or type a password/);
  const key = { name: "id", text: "k", type: "ed25519", locked: true };
  assert.match(sshFormError(form({ password: "", key })), /locked with a passphrase/);
  assert.equal(sshFormError(form({ password: "", key, passphrase: "p" })), null);
  assert.equal(sshFormError(form({ password: "", key: { ...key, locked: false } })), null);
  assert.equal(sshFormError(form()), null);
});

test("a port in the host box beats the Port box", () => {
  assert.deepEqual(sshTarget({ host: "h:2200", port: "22" }), { host: "h", port: "2200", fromHost: true });
  const request = sshRequest(form({ host: "https://h:2200", label: " VPS ", user: " demo " }));
  assert.deepEqual([request.host, request.port, request.label, request.user], ["h", 2200, "VPS", "demo"]);
});

test("a QR code needs no Mac/Server pick or Id", () => {
  assert.deepEqual(identityFor([], preview("Studio", "a")), { kind: "mac", id: "local", name: "Studio" });
  const mac = paired("local", "Studio", "mac", "a");
  assert.deepEqual(identityFor([mac], preview("Apex-Terminal", "b")), { kind: "server", id: `h-${"b".repeat(12)}`, name: "Apex-Terminal" });
});

test("machines sharing a name both pair, because the name can't be typed any more", () => {
  const mac = paired("local", "Ubuntu", "mac", "a");
  const one = identityFor([mac], preview("ubuntu", "b"));
  assert.equal(one.name, "ubuntu 2");
  const two = paired(one.id, one.name, one.kind, "b");
  const next = identityFor([mac, two], preview("Ubuntu", "c"));
  assert.equal(next.name, "Ubuntu 3");
  const list = withPairedMachine([mac, two], paired(next.id, next.name, next.kind, "c"));
  assert.equal(list.length, 3);
});

test("the same machine again keeps its one entry, and its old address entry is replaced", () => {
  const mac = paired("local", "Studio", "mac", "a");
  const server = paired("h-old", "Apex-Terminal", "server", "b");
  const again = identityFor([mac, server], preview("Apex-Terminal", "b"));
  assert.equal(again.name, "Apex-Terminal");
  assert.equal(withPairedMachine([mac, server], paired(again.id, again.name, again.kind, "b")).length, 2);
  const direct = { id: "h-old", name: "Apex-Terminal", kind: "server", url: "ws://x:7420", token: "t" };
  const moved = identityFor([mac, direct], preview("Apex-Terminal", "b"));
  assert.equal(moved.name, "Apex-Terminal");
  const list = withPairedMachine([mac, direct], paired(moved.id, moved.name, moved.kind, "b"));
  assert.deepEqual(list.map((machine) => [machine.id, machine.hostEndpointId]), [["local", endpoint("a")], ["h-old", endpoint("b")]]);
});

test("the picker offers QR code and Remote SSH only", () => {
  const source = fs.readFileSync(new URL("../src/phone/AddHow.tsx", import.meta.url), "utf8");
  const code = transform(source.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true }).code;
  const AddHowPicker = new Function("require", "Camera", "Terminal", `${code}; return AddHowPicker;`)(require, () => null, () => null);
  const html = renderToStaticMarkup(React.createElement(AddHowPicker, { pairing: true, how: "ssh", onHow() {} }));
  assert.match(html, /QR code/);
  assert.match(html, /aria-checked="true"[^>]*>Remote SSH/);
  assert.doesNotMatch(html, /Address and token|Mac|Server/);
});
