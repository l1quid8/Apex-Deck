// Add a machine over SSH: what the phone can check by itself before anything
// goes out, and the shape of the setup run. SSH is used once, to set up; chats
// then use the paired link.

/** Refuses a huge file before reading it. A private key is a few kilobytes. */
export const MAX_KEY_BYTES = 64 * 1024;

const NOT_A_KEY = "That file isn't an OpenSSH private key. Pick the private key (id_ed25519), not the .pub file.";
const MAGIC = "openssh-key-v1\0";

/**
 * SSH takes a bare host. Drops a pasted scheme, path or user@, keeps a port
 * from host:port or [v6]:port, and leaves a bare IPv6 address whole. Anything
 * after a single colon is the port, even `abc`, so goodPort turns it down.
 */
export function parseHost(raw: string): { host: string; port?: string } {
  const text = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "").replace(/^[^@[\]]*@/, "");
  const v6 = /^\[([0-9a-f:.]+)\](?::(.*))?$/i.exec(text);
  if (v6) return { host: v6[1], port: v6[2] };
  const withPort = /^([^:]+):([^:]*)$/.exec(text);
  if (withPort) return { host: withPort[1], port: withPort[2] };
  return { host: text };
}

export const goodPort = (port: string): boolean => /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;

export const hostPort = (host: string, port: string): string => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

export interface SshKey {
  /** The file's name, shown on the row. */
  name: string;
  /** The key file as imported. Held in memory only, and dropped with the form. */
  text: string;
  /** ed25519, rsa and so on, as the key names itself. */
  type: string;
  /** Encrypted with a passphrase. */
  locked: boolean;
}

/**
 * Read an imported file as an OpenSSH private key, without unlocking it.
 * Its header says whether it needs a passphrase. Throws a sentence for the
 * person for anything else: a .pub, a PuTTY .ppk, an old PEM key, junk.
 */
export function readKey(name: string, text: string): SshKey {
  const body = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text)?.[1];
  if (!body) throw new Error(NOT_A_KEY);
  let bytes: string;
  try {
    bytes = atob(body.replace(/\s/g, ""));
  } catch {
    throw new Error(NOT_A_KEY);
  }
  if (!bytes.startsWith(MAGIC)) throw new Error(NOT_A_KEY);
  let at = MAGIC.length;
  const field = (): string => {
    if (at + 4 > bytes.length) throw new Error(NOT_A_KEY);
    const size = (bytes.charCodeAt(at) * 2 ** 24) + (bytes.charCodeAt(at + 1) << 16) + (bytes.charCodeAt(at + 2) << 8) + bytes.charCodeAt(at + 3);
    at += 4;
    if (at + size > bytes.length) throw new Error(NOT_A_KEY);
    const value = bytes.slice(at, at + size);
    at += size;
    return value;
  };
  const cipher = field();
  field(); // kdf name
  field(); // kdf options
  at += 4; // number of keys
  const type = field(); // the public key, which opens with its type
  bytes = type;
  at = 0;
  const named = field().replace(/^ssh-/, "");
  return { name, text, type: named, locked: cipher !== "none" };
}

export interface SshForm {
  label: string;
  host: string;
  user: string;
  port: string;
  password: string;
  key: SshKey | null;
  passphrase: string;
  keep: boolean;
}

/** Where the form points, with a port typed into the host winning over the Port box. */
export function sshTarget(form: Pick<SshForm, "host" | "port">): { host: string; port: string; fromHost: boolean } {
  const parsed = parseHost(form.host);
  return { host: parsed.host, port: parsed.port ?? form.port, fromHost: parsed.port !== undefined };
}

/** What's wrong with the form, in the order a person fills it in. Null when Connect can go. */
export function sshFormError(form: SshForm): string | null {
  const { host, port } = sshTarget(form);
  if (!host || !form.user.trim()) return "Fill in the host and user.";
  if (!goodPort(port)) return `Port ${port || "(blank)"} won't work. Use a number from 1 to 65535.`;
  if (!form.key && !form.password) return "Import a private key or type a password.";
  if (form.key?.locked && !form.passphrase) return "This key is locked with a passphrase. Type it to unlock the key.";
  return null;
}

/** One step of the run. A failed step stops it, and nothing after it happens. */
export type SetupEvent =
  | { kind: "step"; id: string; text: string }
  /** Saved on the phone the moment the machine pairs, so closing the screen can't lose it. */
  | { kind: "paired"; name: string }
  | { kind: "failed"; id: string; label: string; message: string }
  | { kind: "done"; message: string };

export interface SshRequest {
  label: string;
  host: string;
  port: number;
  user: string;
  password: string;
  key: SshKey | null;
  passphrase: string;
  keep: boolean;
}

/** Runs setup on the server and reports each step. `cancel` stops it at any point. */
export type SshSetup = (request: SshRequest, onEvent: (event: SetupEvent) => void) => { cancel(): void };

export function sshRequest(form: SshForm): SshRequest {
  const { host, port } = sshTarget(form);
  return { label: form.label.trim(), host, port: Number(port), user: form.user.trim(), password: form.password, key: form.key, passphrase: form.passphrase, keep: form.keep };
}
