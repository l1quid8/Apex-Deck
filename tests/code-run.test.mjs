import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RUN_BYTES,
  MAX_RUN_LINES,
  OUTPUT_CAP,
  RUN_MARKER,
  EMPTY_OUTPUT,
  isRunnable,
  commandFrom,
  needsConfirm,
  shellLine,
  appendOutput,
} from "../src/codeRun.ts";

test("isRunnable accepts standard shell languages within limits", () => {
  for (const lang of ["sh", "bash", "zsh", "shell", "console", "fish", "BASH", " Sh "]) {
    assert.equal(isRunnable(lang, "echo hi"), true, `language ${lang} should be runnable`);
  }
});

test("isRunnable rejects non-shell languages", () => {
  for (const lang of ["javascript", "python", "json", "html", "css", "markdown", "rust", "c"]) {
    assert.equal(isRunnable(lang, "echo hi"), false, `language ${lang} should not be runnable`);
  }
});

test("isRunnable enforces size and line limits", () => {
  // Blank or whitespace-only is never runnable
  assert.equal(isRunnable("bash", ""), false);
  assert.equal(isRunnable("bash", "   \n\t  "), false);

  // Exceeding 50 lines
  const fiftyLines = Array.from({ length: 50 }, (_, i) => `echo ${i}`).join("\n");
  const fiftyOneLines = Array.from({ length: 51 }, (_, i) => `echo ${i}`).join("\n");
  assert.equal(isRunnable("bash", fiftyLines), true);
  assert.equal(isRunnable("bash", fiftyOneLines), false);

  // Exceeding 4096 bytes
  const smallText = "a".repeat(4096);
  const largeText = "a".repeat(4097);
  assert.equal(isRunnable("bash", smallText), true);
  assert.equal(isRunnable("bash", largeText), false);
});

test("isRunnable for untagged or text blocks requires all non-blank lines look like commands", () => {
  for (const lang of ["", "text", "txt", "plaintext"]) {
    assert.equal(isRunnable(lang, "git status"), true);
    assert.equal(isRunnable(lang, "npm test\ncargo build"), true);
    assert.equal(isRunnable(lang, "./scripts/deploy.sh --prod"), true);
    assert.equal(isRunnable(lang, "$ git diff\n$ npm run check"), true);
    assert.equal(isRunnable(lang, "!pytest -v"), true);
  }

  // Untagged prose or instructions rejected
  assert.equal(isRunnable("", "This is an explanation of what the script does."), false);
  assert.equal(isRunnable("text", "Please run the following commands to install dependencies."), false);
  assert.equal(isRunnable("", "make sure you check the logs before proceeding."), false);
  assert.equal(isRunnable("text", "find the file in your directory."), false);

  // Mixed commands and prose rejected
  assert.equal(isRunnable("", "npm install\nNow you should run the tests."), false);
});

test("commandFrom trims end and strips leading prompts", () => {
  assert.equal(commandFrom("bash", "npm test   \n"), "npm test");
  assert.equal(commandFrom("sh", "$ echo 1\n$ echo 2"), "echo 1\necho 2");
  assert.equal(commandFrom("sh", "! echo 1\n! echo 2"), "echo 1\necho 2");
  assert.equal(commandFrom("sh", "!echo 1\n!echo 2"), "echo 1\necho 2");
});

test("commandFrom drops output lines in console blocks", () => {
  const consoleBlock = `$ git status
On branch main
nothing to commit, working tree clean
$ npm test
PASS src/test.js
`;
  assert.equal(commandFrom("console", consoleBlock), "git status\nnpm test");

  const bangConsole = `! pytest
============================= test session starts ==============================
collected 2 items
! cargo test
running 1 test
`;
  assert.equal(commandFrom("console", bangConsole), "pytest\ncargo test");
});

test("needsConfirm arms for multiline commands, sudo, or rm -rf", () => {
  // Single line safe commands do not need confirmation
  assert.equal(needsConfirm("echo hi"), false);
  assert.equal(needsConfirm("echo hi\n"), false);
  assert.equal(needsConfirm("git status"), false);

  // Multiline commands require confirmation
  assert.equal(needsConfirm("echo 1\necho 2"), true);
  assert.equal(needsConfirm("cd src\nls -la"), true);

  // sudo requires confirmation
  assert.equal(needsConfirm("sudo apt-get update"), true);
  assert.equal(needsConfirm("echo hi | sudo tee /etc/hosts"), true);

  // rm -rf requires confirmation
  assert.equal(needsConfirm("rm -rf node_modules"), true);
  assert.equal(needsConfirm("rm -rf /tmp/build"), true);
  assert.equal(needsConfirm("rm -fr dist"), true);
});

test("shellLine wraps command in marker and base64 eval ending in newline", () => {
  const cmd = "echo \"Hello World!\"";
  const line = shellLine(cmd);

  assert.ok(line.startsWith(" "), "shell line must start with a space");
  assert.ok(line.endsWith("\n"), "shell line must end with a newline");
  assert.ok(line.includes("printf '\\033]777;apex-run\\007'"), "must include marker printf");
  assert.ok(line.includes("base64 -d"), "must include base64 decode");
  assert.ok(line.includes("exit $?"), "must include exit $?");

  // Base64 payload decodes accurately even with unicode and quotes
  const unicodeCmd = "echo '✨ emoji & \"quotes\"' \n echo done";
  const unicodeLine = shellLine(unicodeCmd);
  const match = unicodeLine.match(/printf %s '([^']+)'/);
  assert.ok(match, "must extract base64 payload");
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  assert.equal(decoded, unicodeCmd);
});

test("appendOutput drops pre-marker noise and sets started flag", () => {
  const noise = "Last login: Mon Oct 19 21:00:00 on ttys001\nuser@host:~$ ";

  // Only noise: does not start, stores nothing in output
  const beforeMarker = appendOutput(EMPTY_OUTPUT, noise);
  assert.equal(beforeMarker.started, false);
  assert.equal(beforeMarker.output, "");
  assert.equal(beforeMarker.truncated, false);
  assert.equal(beforeMarker.carry, "");

  // Marker arrives: output begins after marker
  const withMarker = appendOutput(beforeMarker, RUN_MARKER + "first line\n");
  assert.equal(withMarker.started, true);
  assert.equal(withMarker.output, "first line\n");
  assert.equal(withMarker.carry, "");
});

test("appendOutput handles RUN_MARKER split across chunks", () => {
  const part1 = "noise \x1b]777;apex-";
  const part2 = "run\x07Hello world\n";

  const step1 = appendOutput(EMPTY_OUTPUT, part1);
  assert.equal(step1.started, false);
  assert.equal(step1.output, "");
  assert.equal(step1.carry, "\x1b]777;apex-");

  const step2 = appendOutput(step1, part2);
  assert.equal(step2.started, true);
  assert.equal(step2.output, "Hello world\n");
  assert.equal(step2.carry, "");
});

test("appendOutput strips ANSI and OSC escape codes", () => {
  const raw = `${RUN_MARKER}\x1b[32mSuccess!\x1b[0m \x1b]0;Title\x07Done.\n`;
  const res = appendOutput(EMPTY_OUTPUT, raw);
  assert.equal(res.output, "Success! Done.\n");
});

test("appendOutput handles escape codes split across chunks", () => {
  // ANSI color code split: \x1b[3 and 2m
  const chunk1 = `${RUN_MARKER}Hello \x1b[3`;
  const res1 = appendOutput(EMPTY_OUTPUT, chunk1);
  assert.equal(res1.output, "Hello ");
  assert.equal(res1.carry, "\x1b[3");

  const chunk2 = "2mWorld\x1b[0m\n";
  const res2 = appendOutput(res1, chunk2);
  assert.equal(res2.output, "Hello World\n");
  assert.equal(res2.carry, "");

  // OSC sequence split
  const chunk3 = "Info: \x1b]0;Tab";
  const res3 = appendOutput(res2, chunk3);
  assert.equal(res3.carry, "\x1b]0;Tab");

  const chunk4 = " Title\x07Continued\n";
  const res4 = appendOutput(res3, chunk4);
  assert.equal(res4.output, "Hello World\nInfo: Continued\n");
  assert.equal(res4.carry, "");
});

test("appendOutput converts \\r\\n to \\n and handles lone \\r line rewinds", () => {
  const crlf = `${RUN_MARKER}line 1\r\nline 2\r\n`;
  assert.equal(appendOutput(EMPTY_OUTPUT, crlf).output, "line 1\nline 2\n");

  const rewound = `${RUN_MARKER}compiling 10%\rcompiling 50%\rcompiling 100%\n`;
  assert.equal(appendOutput(EMPTY_OUTPUT, rewound).output, "compiling 100%\n");

  const multiLineRewind = `${RUN_MARKER}line 1\nold 2\rnew 2\n`;
  assert.equal(appendOutput(EMPTY_OUTPUT, multiLineRewind).output, "line 1\nnew 2\n");
});

test("appendOutput rewinds correctly across chunk boundaries", () => {
  let state = appendOutput(EMPTY_OUTPUT, `${RUN_MARKER}step 1`);
  assert.equal(state.output, "step 1");

  state = appendOutput(state, "\rstep 2");
  assert.equal(state.output, "step 2");

  state = appendOutput(state, "\rstep 3\nfinal line\n");
  assert.equal(state.output, "step 3\nfinal line\n");
});

test("appendOutput handles \\r\\n split across chunk boundaries", () => {
  const step1 = appendOutput(EMPTY_OUTPUT, `${RUN_MARKER}line one\r`);
  assert.equal(step1.output, "line one");
  assert.equal(step1.carry, "\r");

  const step2 = appendOutput(step1, "\nline two\r\n");
  assert.equal(step2.output, "line one\nline two\n");
  assert.equal(step2.carry, "");
});

test("appendOutput handles lone \\r at end of chunk followed by overwrite", () => {
  const step1 = appendOutput(EMPTY_OUTPUT, `${RUN_MARKER}old line\r`);
  assert.equal(step1.output, "old line");
  assert.equal(step1.carry, "\r");

  const step2 = appendOutput(step1, "new line\n");
  assert.equal(step2.output, "new line\n");
  assert.equal(step2.carry, "");
});

test("appendOutput caps output and retains tail with truncated=true", () => {
  const cap = 20;
  const longText = `${RUN_MARKER}0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`;
  const res = appendOutput(EMPTY_OUTPUT, longText, cap);

  assert.equal(res.truncated, true);
  assert.equal(res.output.length, cap);
  assert.equal(res.output, "GHIJKLMNOPQRSTUVWXYZ");

  // Subsequent chunk keeps truncated flag
  const res2 = appendOutput(res, "123", cap);
  assert.equal(res2.truncated, true);
  assert.equal(res2.output.length, cap);
  assert.equal(res2.output, "JKLMNOPQRSTUVWXYZ123");
});
