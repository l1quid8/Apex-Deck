import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  downloadVerified,
  VoiceRuntimeManager,
} from "../desktop/voiceRuntime.mjs";
test("failed hash cannot activate or overwrite verified cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-voice-runtime-"));
  try {
    await assert.rejects(
      downloadVerified(
        { url: "https://example.test/file", sha256: "a".repeat(64), size: 3 },
        path.join(root, "file"),
        { fetch: async () => new Response("bad") },
      ),
      /hash/i,
    );
    await assert.rejects(fs.stat(path.join(root, "file")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("absent runtime is off and unsupported platforms never install", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-voice-runtime-"));
  try {
    const r = new VoiceRuntimeManager({
      root,
      source: root,
      platform: "linux",
      arch: "x64",
    });
    assert.equal((await r.status()).installed, false);
    assert.equal((await r.status()).supported, false);
    await assert.rejects(r.start(1), /Apple Silicon/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("stale install owner can be recovered without removing live locks", async () => {
  const { acquireInstallLock } = await import("../desktop/voiceRuntime.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-voice-lock-"));
  const lock = path.join(root, "install.lock");
  try {
    await fs.mkdir(lock);
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: 999999999 }),
    );
    const release = await acquireInstallLock(lock);
    await assert.rejects(acquireInstallLock(lock), /already running/);
    await release();
    const next = await acquireInstallLock(lock);
    await next();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
