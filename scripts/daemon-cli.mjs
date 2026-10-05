#!/usr/bin/env node
// Drive apex-daemon by hand: say hello, run one command, print what comes back.
//
//   node scripts/daemon-cli.mjs [options] [command [json-args]]
//
//   --ssh HOST       run `ssh HOST apex-daemon --stdio --attach` (a daemon must be running there)
//   --bin PATH       the daemon binary (default: target/debug/apex-daemon when it exists, else apex-daemon)
//   --data-dir PATH  passed to the daemon
//   --in-process     without a running daemon, run the host for this one session
//   --since BOOT:SEQ resume after event SEQ of boot BOOT
//   --watch          keep printing events after the reply, until Ctrl-C
//
// Examples:
//   node scripts/daemon-cli.mjs agents_detect
//   node scripts/daemon-cli.mjs --ssh vps session_load
//   node scripts/daemon-cli.mjs --ssh vps room_post '{"id":"t1","text":"@claude hi"}' --watch
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const options = { ssh: null, bin: null, dataDir: null, inProcess: false, since: null, watch: false };
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    if (i + 1 >= argv.length) fail(`${arg} needs a value`);
    return argv[++i];
  };
  if (arg === "--ssh") options.ssh = value();
  else if (arg === "--bin") options.bin = value();
  else if (arg === "--data-dir") options.dataDir = value();
  else if (arg === "--in-process") options.inProcess = true;
  else if (arg === "--since") options.since = value();
  else if (arg === "--watch") options.watch = true;
  else if (arg === "-h" || arg === "--help") {
    console.log("usage: node scripts/daemon-cli.mjs [--ssh HOST] [--bin PATH] [--data-dir PATH] [--in-process] [--since BOOT:SEQ] [--watch] [command [json-args]]");
    process.exit(0);
  } else if (arg.startsWith("--")) fail(`unknown option ${arg}`);
  else positional.push(arg);
}

function fail(message) {
  console.error(`daemon-cli: ${message}`);
  process.exit(2);
}

const [command, rawArgs] = positional;
let args = {};
if (rawArgs !== undefined) {
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    fail(`the arguments are not JSON: ${error.message}`);
  }
}

const daemonArgs = ["--stdio", ...(options.inProcess ? [] : ["--attach"]), ...(options.dataDir ? ["--data-dir", options.dataDir] : [])];
const local = options.bin ?? (existsSync("target/debug/apex-daemon") ? "target/debug/apex-daemon" : "apex-daemon");
const [program, programArgs] = options.ssh
  ? ["ssh", [options.ssh, [options.bin ?? "apex-daemon", ...daemonArgs].map(quote).join(" ")]]
  : [local, daemonArgs];

function quote(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

const child = spawn(program, programArgs, { stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (error) => fail(`could not start ${program}: ${error.message}`));
child.on("exit", (code, signal) => {
  if (!finished) {
    console.error(`daemon-cli: the connection closed (${signal ?? `exit ${code}`})`);
    process.exit(1);
  }
});

let finished = false;
const send = (frame) => child.stdin.write(JSON.stringify(frame) + "\n");
const hello = { protocol: 1 };
if (options.since) {
  const [boot_id, seq] = options.since.split(":");
  hello.since = { boot_id, seq: Number(seq) };
}
send({ id: 0, cmd: "hello", args: hello });

createInterface({ input: child.stdout }).on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    console.error(`daemon-cli: not a frame: ${line}`);
    return;
  }
  if ("seq" in frame) {
    console.log(`#${frame.seq} ${frame.event} ${JSON.stringify(frame.payload)}`);
  } else if (frame.id === 0) {
    if ("err" in frame) return done(`hello refused: ${frame.err}`, 1);
    console.error(`hello: ${JSON.stringify(frame.ok)}`);
    if (command) send({ id: 1, cmd: command, args });
    else if (!options.watch) done(null, 0);
  } else if (frame.id === 1) {
    if ("err" in frame) return done(`error: ${frame.err}`, 1);
    console.log(JSON.stringify(frame.ok, null, 2));
    if (!options.watch) done(null, 0);
  } else if ("err" in frame) {
    done(`error: ${frame.err}`, 1);
  }
});

function done(message, code) {
  finished = true;
  if (message) console.error(message);
  child.stdin.end();
  child.kill();
  process.exit(code);
}
