import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import { identityFor, withPairedMachine } from "../src/phone/pairing.ts";
import { goodHost, goodPort, hostPort, parseHost, readKey, sshFormError, sshRequest, sshTarget } from "../src/phone/sshSetup.ts";

const require = createRequire(import.meta.url);

const field = (text) => [0, 0, (text.length >> 8) & 255, text.length & 255].map((byte) => String.fromCharCode(byte)).join("") + text;
const COUNT = "\0\0\0\x01";
const PUBLIC_KEY = "p".repeat(32);
const CHECK = "\x01\x02\x03\x04";
const PARTS = {
  "ssh-ed25519": { public: [PUBLIC_KEY], private: [PUBLIC_KEY, "s".repeat(64), "me@mac"] },
  "ssh-rsa": { public: ["\x01\0\x01", "n".repeat(256)], private: ["n".repeat(256), "\x01\0\x01", "d", "i", "q", "r", ""] },
};
const PUBLIC = (type, parts = PARTS[type].public) => field(field(type) + parts.map(field).join(""));
const pad = (body) => {
  let padded = body;
  for (let next = 1; padded.length % 8; next += 1) padded += String.fromCharCode(next);
  return padded;
};
const PRIVATE = (type = "ssh-ed25519", parts = PARTS[type].private, check = CHECK + CHECK) => pad(check + field(type) + parts.map(field).join(""));
const SEALED = "z".repeat(136);
const KDF_OPTIONS = field("saltsaltsaltsalt") + "\0\0\0\x10";
const pem = (blob) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa(blob)}\n-----END OPENSSH PRIVATE KEY-----\n`;
/** The header of an OpenSSH key file, up to the private block. */
const header = (cipher, type = "ssh-ed25519") => "openssh-key-v1\0" + field(cipher) + field(cipher === "none" ? "none" : "bcrypt") + field(cipher === "none" ? "" : KDF_OPTIONS) + COUNT + PUBLIC(type);
/** An OpenSSH key file with the given cipher and key type. The layout is real, the key isn't. */
const keyFile = (cipher, type) => pem(header(cipher, type) + field(cipher === "none" ? PRIVATE(type) : SEALED));

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

test("a key file cut short or put together wrongly is refused", () => {
  const magic = "openssh-key-v1\0" + field("none") + field("none") + field("");
  const locked = (options, sealed = SEALED, tail = "") => "openssh-key-v1\0" + field("aes256-ctr") + field("bcrypt") + field(options) + COUNT + PUBLIC("ssh-ed25519") + field(sealed) + tail;
  const parts = PARTS["ssh-ed25519"].private;
  const bad = {
    "no key count": magic,
    "no public key": magic + COUNT,
    "a key type and nothing else": magic + COUNT + field(field("ssh-ed25519")),
    "no private block": header("none"),
    "an empty private block": header("none") + field(""),
    "cut inside the private block": header("none") + "\0\0\0\x10abc",
    "two keys": magic + "\0\0\0\x02" + PUBLIC("ssh-ed25519") + field(PRIVATE()),
    "no keys": magic + "\0\0\0\0" + PUBLIC("ssh-ed25519") + field(PRIVATE()),
    "no cipher named": "openssh-key-v1\0" + field("") + field("none") + field("") + COUNT + PUBLIC("ssh-ed25519") + field(PRIVATE()),
    "a cipher with no kdf": "openssh-key-v1\0" + field("aes256-ctr") + field("none") + field("") + COUNT + PUBLIC("ssh-ed25519") + field(PRIVATE()),
    "a key type that isn't a name": magic + COUNT + field(field("\x01\x02") + field("x")) + field(PRIVATE()),
    "unlocked, but the check numbers differ": header("none") + field(PRIVATE(undefined, undefined, CHECK + "\x05\x06\x07\x08")),
    "bytes left after an unlocked key": header("none") + field(PRIVATE()) + "x",
    "a public part cut inside its length": magic + COUNT + field(field("ssh-ed25519") + "\0") + field(PRIVATE()),
    "a public key of the wrong size": magic + COUNT + PUBLIC("ssh-ed25519", ["p".repeat(31)]) + field(PRIVATE()),
    "an empty public key": magic + COUNT + PUBLIC("ssh-ed25519", [""]) + field(PRIVATE()),
    "an RSA key missing its modulus": magic + COUNT + PUBLIC("ssh-rsa", ["\x01\0\x01"]) + field(PRIVATE("ssh-rsa")),
    "extra bytes after the public key": magic + COUNT + field(field("ssh-ed25519") + field(PUBLIC_KEY) + "x") + field(PRIVATE()),
    "a private block of only check numbers": header("none") + field(CHECK + CHECK),
    "a private block of a different type": header("none") + field(PRIVATE("ssh-rsa")),
    "a private key of the wrong size": header("none") + field(PRIVATE(undefined, [parts[0], "s".repeat(63), parts[2]])),
    "a private block for another public key": header("none") + field(PRIVATE(undefined, ["q".repeat(32), parts[1], parts[2]])),
    "a private block with no comment": header("none") + field(PRIVATE(undefined, parts.slice(0, 2))),
    "padding that doesn't count up": header("none") + field(`${PRIVATE().slice(0, -1)}\xff`),
    "a private block that isn't whole blocks": header("none") + field(PRIVATE() + "\x01"),
    "locked, no kdf options": locked(""),
    "locked, kdf options cut short": locked(field("saltsaltsaltsalt")),
    "locked, no rounds to run": locked(field("saltsaltsaltsalt") + "\0\0\0\0"),
    "locked, a kdf nothing can run": locked(KDF_OPTIONS).replace("bcrypt", "scrypt"),
    "locked, a private block far too small": locked(KDF_OPTIONS, "z".repeat(8)),
    "locked, a private block that isn't whole blocks": locked(KDF_OPTIONS, "z".repeat(137)),
    "locked, a tail on a cipher with no tag": locked(KDF_OPTIONS, SEALED, "t".repeat(16)),
    "locked, a cipher's auth tag missing": header("chacha20-poly1305@openssh.com") + field(SEALED),
  };
  for (const [what, blob] of Object.entries(bad)) assert.throws(() => readKey("x", pem(blob)), /isn't an OpenSSH private key/, what);
});

test("a locked key may carry an auth tag after its private block", () => {
  assert.equal(readKey("id", pem(header("chacha20-poly1305@openssh.com") + field(SEALED) + "t".repeat(16))).locked, true);
});

test("a kind of key that can't sign from the phone is named, not called junk", () => {
  const magic = "openssh-key-v1\0" + field("none") + field("none") + field("");
  assert.throws(() => readKey("x", pem(magic + COUNT + field(field("sk-ssh-ed25519@openssh.com") + field(PUBLIC_KEY)) + field(PRIVATE()))), /sk-ssh-ed25519@openssh\.com keys won't work here/);
});

test("a host must be a real name or address", () => {
  for (const good of ["server.example.com", "server.example.com.", "h", "apex-terminal", "203.0.113.10", "2001:db8::1", "::1", "::ffff:203.0.113.10", "1:2:3:4:5:6:7:8"]) assert.equal(goodHost(good), true, good);
  for (const bad of ["", "bad host", "::::", ":::", "1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "12345::", "::g", "::ffff:999.0.0.1", "999.1.1.1", "1.2.3", "-bad.example.com", "bad-.example.com", "a..b", "[x]", "a:b:c", "x".repeat(64), `${"a.".repeat(127)}aa`]) assert.equal(goodHost(bad), false, bad);
});

test("Connect says what's missing, in form order", () => {
  assert.match(sshFormError(form({ host: "bad host" })), /host won't work/);
  assert.match(sshFormError(form({ host: "::::" })), /host won't work/);
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

test("the same machine again keeps its one entry", () => {
  const mac = paired("local", "Studio", "mac", "a");
  const server = paired("h-old", "Apex-Terminal", "server", "b");
  const again = identityFor([mac, server], preview("Apex-Terminal", "b"));
  assert.equal(again.name, "Apex-Terminal");
  assert.equal(withPairedMachine([mac, server], paired(again.id, again.name, again.kind, "b")).length, 2);
});

test("a code with the same name as an address entry never takes its place", () => {
  const server = { id: "h-old", name: "Studio", kind: "server", url: "ws://x:7420", token: "t" };
  const mac = { id: "local", name: "Studio", kind: "mac", url: "ws://y:7420", token: "t" };
  for (const entry of [server, mac]) {
    const made = identityFor([entry], preview("Studio", "b"));
    assert.equal(made.name, "Studio 2");
    assert.equal(made.kind, entry.kind === "mac" ? "server" : "mac");
    const list = withPairedMachine([entry], paired(made.id, made.name, made.kind, "b"));
    assert.deepEqual(list[0], entry);
    assert.equal(list.length, 2);
  }
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
