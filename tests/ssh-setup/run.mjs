#!/usr/bin/env node
// Runs the phone's setup steps against a real Linux server in Docker. The
// transport here is OpenSSH instead of the iPhone's Citadel; every script,
// decision and message is the phone's own. Pairing stops at the link, which
// the iOS Simulator run covers end to end.
//
//   scripts: docker, a Linux build at target/linux-arm64/apex-daemon
//   node --experimental-strip-types tests/ssh-setup/run.mjs

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runSetup, ConnectFailure } from "../../src/phone/sshRun.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const binary = path.join(ROOT, "target/linux-arm64/apex-daemon");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-setup-"));
const keyFile = path.join(scratch, "id");
execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile]);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
docker("build", "-q", "-t", "apex-ssh-setup", path.join(ROOT, "tests/ssh-setup"));

function server() {
  const name = `apex-ssh-${crypto.randomUUID().slice(0, 8)}`;
  docker("run", "-d", "--name", name, "--privileged", "--cgroupns=host", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::22", "apex-ssh-setup");
  const port = Number(docker("port", name, "22").split(":").pop());
  for (const user of ["admin", "plain"]) {
    docker("exec", name, "sh", "-c", `mkdir -p /home/${user}/.ssh && echo '${fs.readFileSync(`${keyFile}.pub`, "utf8").trim()}' > /home/${user}/.ssh/authorized_keys && chown -R ${user} /home/${user}/.ssh`);
  }
  return { name, port, stop() { docker("rm", "-f", name); } };
}

function feedServer(file, version, tamper = false) {
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const feed = JSON.stringify({ schemaVersion: 1, version, daemons: [{ arch: "arm64", name: "apex-daemon-linux-arm64", sha256: tamper ? "0".repeat(64) : sha256 }] });
  const http_ = http.createServer((req, res) => res.end(req.url.endsWith(".json") ? feed : bytes));
  return new Promise((ready) => http_.listen(0, "0.0.0.0", () => ready({ url: `http://host.docker.internal:${http_.address().port}`, close: () => http_.close() })));
}

function transport(port) {
  const base = ["-i", keyFile, "-p", String(port), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"];
  return async (request) => {
    const target = `${request.user}@127.0.0.1`;
    const exec = (command, options = {}) => new Promise((resolve) => {
      const child = spawn("ssh", [...base, target, command], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.end(options.stdin ?? "");
    });
    const first = await exec("true");
    if (first.code !== 0) throw new ConnectFailure("signin", first.stderr);
    return {
      fingerprint: "SHA256:docker-test-key",
      exec,
      async open(command) {
        const child = spawn("ssh", [...base, target, command], { stdio: ["pipe", "pipe", "pipe"] });
        return {
          listen(onLine, onEnd) {
            let held = "";
            child.stdout.on("data", (chunk) => { held += chunk; const lines = held.split("\n"); held = lines.pop(); lines.forEach(onLine); });
            child.on("close", (code) => onEnd(code ?? -1));
          },
          write: async (text) => { child.stdin.write(text); },
          close: async () => { child.kill(); },
        };
      },
      close: async () => {},
    };
  };
}

async function setup(machine, user, password, releases) {
  const lines = [];
  let link = "";
  const deps = {
    connect: transport(machine.port), knownKey: () => null, rememberKey() {}, keep: async () => {}, save() {}, releases,
    pair(found) { link = found; return { done: Promise.reject(new Error("stopped at the link on purpose")), cancel() {} }; },
  };
  const request = { label: "Test box", host: "127.0.0.1", port: machine.port, user, password, key: { name: "id", text: "", type: "ed25519", locked: false }, passphrase: "", keep: false };
  const run = runSetup(request, deps, (event) => lines.push(event));
  await run.done;
  return { lines, link, request };
}

const texts = (lines) => lines.filter((line) => line.kind === "step").map((line) => line.text);
const stuck = (lines) => lines.find((line) => line.kind === "failed");
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; };
const inside = (machine, user, script) => { try { return execFileSync("docker", ["exec", "-u", user, machine.name, "sh", "-c", script], { encoding: "utf8" }).trim(); } catch (error) { return String(error.stdout ?? "").trim(); } };

const feed = await feedServer(binary, "0.9.8");
const box = server();
try {
  execFileSync("sleep", ["6"]);
  const admin = await setup(box, "admin", "admin-pass", feed.url);
  console.log(texts(admin.lines).join("\n"), stuck(admin.lines));
  check("admin: reaches the pairing link", admin.link.startsWith("apexdeck://pair?p="), JSON.stringify(stuck(admin.lines)));
  check("admin: installed for everyone", inside(box, "root", "/usr/local/bin/apex-daemon --version").includes("0.9.8"));
  check("admin: service on boot", inside(box, "root", "systemctl is-enabled apex-daemon@admin") === "enabled");
  check("admin: bubblewrap", inside(box, "root", "command -v bwrap").includes("bwrap"));
  check("admin: password left nothing in the process list", !inside(box, "root", "ps -ef").includes("admin-pass"));
  const again = await setup(box, "admin", "admin-pass", feed.url);
  const processes = inside(box, "root", "sleep 2; ps -eo cmd | grep '[a]pex-daemon'");
  check("again: already up to date, no second service", texts(again.lines).some((line) => line.includes("up to date")) && processes === "/usr/local/bin/apex-daemon serve", processes);
  check("admin: secrets wiped", again.request.password === "" && again.request.key === null);

  const other = server();
  execFileSync("sleep", ["6"]);
  const plain = await setup(other, "plain", "", feed.url);
  console.log(texts(plain.lines).join("\n"), stuck(plain.lines));
  check("plain: reaches the pairing link", plain.link.startsWith("apexdeck://pair?p="), JSON.stringify(stuck(plain.lines)));
  check("plain: installed for the user only", inside(other, "plain", "$HOME/.local/bin/apex-daemon --version").includes("0.9.8"));
  check("plain without lingering: a plain process outlives sign-out, cron restarts it", inside(other, "root", "sleep 3; pgrep -u plain -f 'apex-daemo[n] serve'") !== "" && inside(other, "root", "crontab -u plain -l").includes("@reboot"));
  check("plain: bubblewrap reported skipped", texts(plain.lines).includes("Bubblewrap skipped (needs admin)"));
  other.stop();

  const bad = await feedServer(binary, "0.9.9", true);
  const tampered = await setup(box, "admin", "admin-pass", bad.url);
  check("bad checksum stops at the install line", stuck(tampered.lines)?.label === "Download failed its check", JSON.stringify(stuck(tampered.lines)));
  check("bad checksum left the old binary", inside(box, "root", "/usr/local/bin/apex-daemon --version").includes("0.9.8"));
  bad.close();
} finally {
  box.stop();
  feed.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
