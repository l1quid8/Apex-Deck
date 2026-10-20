export const MAX_RUN_BYTES = 4096;
export const MAX_RUN_LINES = 50;
export const OUTPUT_CAP = 65536;
export const RUN_MARKER = "\x1b]777;apex-run\x07";

const SHELL_LANGUAGES = new Set(["sh", "bash", "zsh", "shell", "console", "fish"]);
const UNTAGGED_LANGUAGES = new Set(["", "text", "txt", "plaintext"]);

const KNOWN_BINARIES = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "bun", "cargo", "rustc", "rustup",
  "node", "deno", "python", "python3", "pip", "pip3", "ruby", "gem", "bundle",
  "go", "docker", "docker-compose", "podman", "kubectl", "helm", "terraform",
  "aws", "gcloud", "az", "curl", "wget", "http", "ssh", "scp", "rsync",
  "cat", "echo", "ls", "cd", "pwd", "mkdir", "rm", "cp", "mv", "touch",
  "chmod", "chown", "grep", "rg", "find", "sed", "awk", "tail", "head",
  "less", "more", "tar", "zip", "unzip", "gzip", "gunzip", "brew", "apt",
  "apt-get", "dnf", "yum", "pacman", "systemctl", "journalctl", "service",
  "make", "cmake", "ninja", "kill", "pkill", "killall", "ps", "top", "htop",
  "df", "du", "which", "where", "env", "export", "source", "alias", "sleep",
  "wait", "true", "false", "test", "clear", "man", "whoami", "uname", "sudo",
  "su", "open", "code", "vim", "nvim", "nano", "vi", "emacs", "vitest",
  "jest", "pytest", "eslint", "prettier", "tsc", "vite", "gh", "tree", "jq",
  "yq", "base64", "sh", "bash", "zsh", "fish", "diff", "patch", "ln",
  "date", "sort", "uniq", "wc", "tr", "cut", "tee", "xargs", "ping",
]);

const PROSE_WORDS = new Set([
  "sure", "you", "your", "we", "our", "the", "this", "that", "these", "those",
  "is", "are", "was", "were", "been", "have", "has", "had", "to", "of", "in",
  "for", "with", "on", "at", "from", "by", "about", "into", "through", "after",
  "before", "should", "could", "would", "please", "can", "will", "and", "or",
  "not", "if", "then", "because", "explanation", "following", "instructions",
  "directory", "files",
]);

function isProseSentence(line: string): boolean {
  // Strip quoted strings first so commit messages or echo strings aren't treated as prose
  const unquoted = line.replace(/(["'])(?:(?=(\\?))\2[\s\S])*?\1/g, "");
  const words = unquoted.toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
  let proseCount = 0;
  for (const word of words) {
    if (PROSE_WORDS.has(word)) proseCount++;
  }

  // Ends in a sentence-terminating period (e.g. "word.", but not "." or path like ".js")
  const endsInSentencePeriod = /[a-zA-Z]{2,}\.\s*$/.test(unquoted);
  if (endsInSentencePeriod && proseCount >= 1) return true;
  if (proseCount >= 2) return true;
  return false;
}

function looksLikeCommandLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (isProseSentence(trimmed)) return false;

  // Prompts or bang commands
  if (trimmed.startsWith("$ ") || trimmed.startsWith("! ") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("/") || trimmed.startsWith("~/")) {
    return true;
  }
  if (trimmed.startsWith("!") && !trimmed.startsWith("!=")) {
    return true;
  }

  // Tokenize first word
  const firstToken = trimmed.split(/[\s=]/)[0];
  if (KNOWN_BINARIES.has(firstToken.toLowerCase())) {
    return true;
  }

  return false;
}

export function isRunnable(language: string, text: string): boolean {
  if (typeof text !== "string" || !text.trim()) {
    return false;
  }

  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_RUN_BYTES) {
    return false;
  }

  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > MAX_RUN_LINES) {
    return false;
  }

  const lang = (language || "").trim().toLowerCase();
  if (SHELL_LANGUAGES.has(lang)) {
    return true;
  }

  if (!UNTAGGED_LANGUAGES.has(lang)) {
    return false;
  }

  // Untagged or text blocks: every non-blank line must look like a command
  const nonBlank = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (nonBlank.length === 0) {
    return false;
  }

  return nonBlank.every((l) => looksLikeCommandLine(l));
}

export function commandFrom(language: string, text: string): string {
  const lang = (language || "").trim().toLowerCase();
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const stripPrompt = (line: string): string => {
    const t = line.trimStart();
    if (t.startsWith("$ ")) return t.slice(2);
    if (t.startsWith("! ")) return t.slice(2);
    if (t.startsWith("!") && !t.startsWith("!=")) return t.slice(1);
    return line;
  };

  if (lang === "console") {
    const kept = lines
      .filter((line) => {
        const t = line.trimStart();
        return t.startsWith("$ ") || t.startsWith("! ") || (t.startsWith("!") && !t.startsWith("!="));
      })
      .map(stripPrompt);
    return kept.join("\n").trimEnd();
  }

  return lines.map(stripPrompt).join("\n").trimEnd();
}

/** True when the first click should only arm: more than one line, sudo, or rm -rf. */
export function needsConfirm(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.split(/\r?\n/).length > 1) {
    return true;
  }
  if (/\bsudo\b/.test(command)) {
    return true;
  }
  if (
    command.includes("rm -rf") ||
    command.includes("rm -fr") ||
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/i.test(command) ||
    /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/i.test(command)
  ) {
    return true;
  }
  return false;
}

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}

/** The single line typed into the shell, ending in "\n". UTF-8 safe base64. */
export function shellLine(command: string): string {
  const b64 = toBase64(command);
  return ` printf '\\033]777;apex-run\\007'; eval "$(printf %s '${b64}' | base64 -d)"; exit $?\n`;
}

export interface RunOutput {
  started: boolean;
  output: string;
  truncated: boolean;
  carry: string;
}

export const EMPTY_OUTPUT: RunOutput = Object.freeze({
  started: false,
  output: "",
  truncated: false,
  carry: "",
});

/** Drop everything before RUN_MARKER; strip ANSI/OSC; "\r\n"→"\n"; lone "\r" rewinds to
 *  the start of the current line; keep the tail at `cap` chars with truncated=true.
 *  `carry` holds an incomplete escape (or partial marker) split across chunks. */
export function appendOutput(prev: RunOutput, chunk: string, cap: number = OUTPUT_CAP): RunOutput {
  let started = prev.started;
  let text = chunk;
  let carry = prev.carry;

  if (!started) {
    const combined = carry + chunk;
    const markerIndex = combined.indexOf(RUN_MARKER);
    if (markerIndex === -1) {
      let newCarry = "";
      for (let len = Math.min(combined.length, RUN_MARKER.length - 1); len >= 1; len--) {
        const tail = combined.slice(-len);
        if (RUN_MARKER.startsWith(tail)) {
          newCarry = tail;
          break;
        }
      }
      return {
        started: false,
        output: prev.output,
        truncated: prev.truncated,
        carry: newCarry,
      };
    }

    started = true;
    text = combined.slice(markerIndex + RUN_MARKER.length);
    carry = "";
  }

  const raw = carry + text;

  let cleanableText = raw;
  let newCarry = "";

  const lastEsc = raw.lastIndexOf("\x1b");
  if (lastEsc !== -1) {
    const tail = raw.slice(lastEsc);
    if (tail === "\x1b") {
      cleanableText = raw.slice(0, lastEsc);
      newCarry = tail;
    } else if (tail.startsWith("\x1b[")) {
      if (/^\x1b\[[0-9:;<=>?]*[ -/]*$/.test(tail)) {
        cleanableText = raw.slice(0, lastEsc);
        newCarry = tail;
      }
    } else if (tail.startsWith("\x1b]")) {
      if (!tail.includes("\x07") && !tail.includes("\x1b\\") && tail.length < 1024) {
        cleanableText = raw.slice(0, lastEsc);
        newCarry = tail;
      }
    }
  }

  let stripped = cleanableText
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");

  if (stripped.endsWith("\r")) {
    stripped = stripped.slice(0, -1);
    newCarry = "\r" + newCarry;
  }

  let completed = "";
  let currentLine = "";
  const lastNl = prev.output.lastIndexOf("\n");
  if (lastNl === -1) {
    currentLine = prev.output;
  } else {
    completed = prev.output.slice(0, lastNl + 1);
    currentLine = prev.output.slice(lastNl + 1);
  }

  const incoming = (currentLine + stripped).replace(/\r\n/g, "\n");
  const lines = incoming.split("\n");
  const processedLines = lines.map((line) => {
    const lastCr = line.lastIndexOf("\r");
    return lastCr === -1 ? line : line.slice(lastCr + 1);
  });

  let output = completed + processedLines.join("\n");
  let truncated = prev.truncated;

  if (output.length > cap) {
    output = output.slice(-cap);
    truncated = true;
  }

  return {
    started: true,
    output,
    truncated,
    carry: newCarry,
  };
}
