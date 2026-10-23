import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DaemonClient } from "../../src/daemon/client.ts";
import { socketLink } from "./link.mjs";
const wait = async (fn) => {
  const deadline = Date.now() + 20000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error("Voice test timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
test(
  "real daemon routes correlated CLI and API turns with history and no group fanout",
  { timeout: 60000 },
  async (t) => {
    const data = fs.mkdtempSync("/tmp/avc-");
    const child = spawn(
      process.env.APEX_DAEMON_BIN ?? path.resolve("target/debug/apex-daemon"),
      ["serve", "--exit-on-stdin-close", "--data-dir", data],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (b) => (errors += b));
    await wait(
      () =>
        fs.existsSync(path.join(data, "daemon.sock")) ||
        child.exitCode !== null,
    );
    assert.equal(child.exitCode, null, errors);
    const apiBodies = [];
    const server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (b) => (raw += b));
      request.on("end", () => {
        if (!raw) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data: [{ id: "test" }] }));
          return;
        }
        apiBodies.push(JSON.parse(raw));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: { content: "The API voice turn sees this thread." },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\ndata: " +
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const c = new DaemonClient(() =>
      socketLink(path.join(data, "daemon.sock")),
    );
    t.after(async () => {
      c.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
      fs.rmSync(data, { recursive: true, force: true });
    });
    await c.start();
    const events = [];
    c.on("room-event", (p) => events.push(p.event));
    assert.equal(
      (await c.call("voice_capabilities", {})).voice_turn_correlation_v1,
      true,
    );
    const cli = {
      id: "cli",
      display_name: "CLI",
      access: "read",
      effort: null,
      persona: "Test agent.",
      backend: {
        kind: "cli",
        program: "/bin/sh",
        args: ["-c", 'printf "CLI spoke in the selected thread.\\n"'],
      },
    };
    const api = {
      ...cli,
      id: "api",
      display_name: "API",
      backend: {
        kind: "open_ai_compatible",
        base_url: `http://127.0.0.1:${server.address().port}/v1`,
        model: "test",
        api_key_env: null,
      },
    };
    await c.call("room_create", {
      id: "voice",
      cwd: null,
      options: { policy: "everyone", max_bot_hops: 3 },
      participants: [cli, api],
    });
    const post = (id, text, target) =>
      c.call("room_post_to", {
        id: "voice",
        text,
        targets: [target],
        client_turn_id: id,
        max_bot_hops: 0,
      });
    await post("v1", "Remember the test phrase lunar apricot.", "cli");
    await wait(() =>
      events.some(
        (e) =>
          e.type === "voice_event" &&
          e.client_turn_id === "v1" &&
          e.event.type === "participant_idle",
      ),
    );
    assert.equal(apiBodies.length, 0, "everyone policy must not fan out voice");
    await post("v1", "Remember the test phrase lunar apricot.", "cli");
    assert.equal(
      events.filter(
        (e) => e.type === "message_added" && e.message.speaker.kind === "human",
      ).length,
      1,
      "same request posts once",
    );
    await post("v2", "What test phrase is in our history?", "api");
    await wait(() =>
      events.some(
        (e) =>
          e.type === "voice_event" &&
          e.client_turn_id === "v2" &&
          e.event.type === "participant_idle",
      ),
    );
    assert.ok(JSON.stringify(apiBodies[0]).includes("lunar apricot"));
    assert.ok(JSON.stringify(apiBodies[0]).includes("This is a voice call"));
    assert.ok(
      events.some(
        (e) =>
          e.type === "voice_event" &&
          e.client_turn_id === "v2" &&
          e.event.type === "delta",
      ),
    );
    assert.equal(
      await c.call("room_stop_request", {
        id: "voice",
        participant: "api",
        client_turn_id: "v1",
      }),
      "mismatch",
    );
    assert.equal(
      await c.call("room_stop_request", {
        id: "voice",
        participant: "cli",
        client_turn_id: "v1",
      }),
      "already-ended",
    );
    await assert.rejects(post("v1", "changed text", "cli"), /reused/);
  },
);
