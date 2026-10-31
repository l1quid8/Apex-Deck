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

const goodV4 = (host: string): boolean => {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};

const goodV6 = (host: string): boolean => {
  const tail = /^(.*:)(\d[\d.]*)$/.exec(host);
  if (tail?.[2].includes(".") && !goodV4(tail[2])) return false;
  const halves = (tail?.[2].includes(".") ? `${tail[1]}0:0` : host).split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return false;
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
};

/** An IP address, or a name of letters, digits and hyphens. All-number names are IP addresses. */
export function goodHost(host: string): boolean {
  if (host.includes(":")) return goodV6(host);
  if (/^[\d.]+$/.test(host)) return goodV4(host);
  const labels = host.replace(/\.$/, "").split(".");
  return host.length <= 253 && labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
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

/** How many parts follow the type in each kind of key. The private count includes the comment. */
const KEY_PARTS: Record<string, { public: number; private: number }> = {
  "ssh-ed25519": { public: 1, private: 3 },
  "ssh-rsa": { public: 2, private: 7 },
  "ecdsa-sha2-nistp256": { public: 2, private: 4 },
  "ecdsa-sha2-nistp384": { public: 2, private: 4 },
  "ecdsa-sha2-nistp521": { public: 2, private: 4 },
};
const ED25519_PUBLIC_BYTES = 32;
const ED25519_PRIVATE_BYTES = 64;
/** A private block comes in whole blocks of at least this, whatever the cipher. */
const BLOCK_BYTES = 8;
/** Smaller than the smallest private block, an ed25519 one with no comment. */
const MIN_SEALED_BYTES = 64;
const AUTH_TAG_BYTES = 16;

/** Reads the length-prefixed numbers and strings of a key file. Running off the end throws. */
function reader(bytes: string) {
  let at = 0;
  const count = (): number => {
    if (at + 4 > bytes.length) throw new Error(NOT_A_KEY);
    at += 4;
    return (bytes.charCodeAt(at - 4) * 2 ** 24) + (bytes.charCodeAt(at - 3) << 16) + (bytes.charCodeAt(at - 2) << 8) + bytes.charCodeAt(at - 1);
  };
  const field = (): string => {
    const size = count();
    if (at + size > bytes.length) throw new Error(NOT_A_KEY);
    at += size;
    return bytes.slice(at - size, at);
  };
  return { count, field, rest: () => bytes.slice(at) };
}

/** The unlocked private block: the check number twice, the key again, a comment, then padding of 1, 2, 3. */
function checkPrivateBlock(block: string, type: string, publicParts: string[], parts: number): void {
  const read = reader(block);
  if (block.length % BLOCK_BYTES || read.count() !== read.count() || read.field() !== type) throw new Error(NOT_A_KEY);
  const fields = Array.from({ length: parts }, read.field);
  const secret = fields.slice(0, -1);
  if (secret.some((part) => !part) || !publicParts.every((part) => secret.includes(part))) throw new Error(NOT_A_KEY);
  if (type === "ssh-ed25519" && secret[1].length !== ED25519_PRIVATE_BYTES) throw new Error(NOT_A_KEY);
  const padding = read.rest();
  for (let index = 0; index < padding.length; index += 1) {
    if (padding.charCodeAt(index) !== index + 1) throw new Error(NOT_A_KEY);
  }
  if (padding.length >= BLOCK_BYTES) throw new Error(NOT_A_KEY);
}

/** A locked block can't be read without the passphrase, but its size and how it was locked can. */
function checkLockedBlock(sealed: string, cipher: string, kdf: string, options: string, tail: string): void {
  const read = reader(options);
  const salt = read.field();
  const rounds = read.count();
  const whole = sealed.length >= MIN_SEALED_BYTES && sealed.length % BLOCK_BYTES === 0;
  if (kdf !== "bcrypt" || !salt || rounds === 0 || read.rest() || !whole) throw new Error(NOT_A_KEY);
  if (tail.length !== (/gcm|poly1305/.test(cipher) ? AUTH_TAG_BYTES : 0)) throw new Error(NOT_A_KEY);
}

/**
 * Read an imported file as an OpenSSH private key, without unlocking it. Its
 * header says whether it needs a passphrase. Checks the whole layout, and the
 * maths stays with the SSH library. Throws a sentence for the person for
 * anything else: a .pub, a PuTTY .ppk, an old PEM key, junk.
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
  const file = reader(bytes.slice(MAGIC.length));
  const cipher = file.field();
  const kdf = file.field();
  const options = file.field();
  if (!cipher || !kdf || (cipher === "none") !== (kdf === "none") || file.count() !== 1) throw new Error(NOT_A_KEY);
  const publicKey = reader(file.field());
  const sealed = file.field();
  const type = publicKey.field();
  if (!/^[a-z0-9][a-z0-9@.-]*$/.test(type)) throw new Error(NOT_A_KEY);
  const parts = KEY_PARTS[type];
  if (!parts) throw new Error(`${type} keys won't work here. Use an ed25519, RSA or ECDSA key.`);
  const publicParts = Array.from({ length: parts.public }, publicKey.field);
  if (publicKey.rest() || publicParts.some((part) => !part)) throw new Error(NOT_A_KEY);
  if (type === "ssh-ed25519" && publicParts[0].length !== ED25519_PUBLIC_BYTES) throw new Error(NOT_A_KEY);
  const locked = cipher !== "none";
  if (locked) {
    checkLockedBlock(sealed, cipher, kdf, options, file.rest());
  } else {
    if (file.rest()) throw new Error(NOT_A_KEY);
    checkPrivateBlock(sealed, type, publicParts, parts.private);
  }
  return { name, text, type: type.replace(/^ssh-/, ""), locked };
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
  if (!goodHost(host)) return "That host won't work. Use an IP address or a name like server.example.com.";
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
