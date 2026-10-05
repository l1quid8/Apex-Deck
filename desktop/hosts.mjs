// Saved hosts: other machines running apex-daemon, reached with the system
// `ssh` and the keys, agent and ~/.ssh/config already set up for it. Deck
// never asks for or keeps a password.

import fs from 'node:fs';

/** This Mac's id; it's always there and never saved. */
export const LOCAL = 'local';
export const LOCAL_NAME = 'This Mac';

const COMMAND = /^[\w@%+=:,./~-]+$/;

/**
 * The host as it will be saved, or an Error with words to show. `taken`
 * holds the names of the other hosts.
 */
export function validHost({ name, ssh, command }, taken) {
  const destination = String(ssh ?? '').trim();
  // ssh would read a leading "-" as an option, and anything with spaces or
  // control characters is not one destination.
  if (!destination || destination.startsWith('-') || /[\s\p{Cc}]/u.test(String(ssh ?? '')) || /[;&|`$()<>'"\\]/.test(destination)) {
    throw new Error('Use an SSH destination such as me@vps.example.com, or a Host name from ~/.ssh/config.');
  }
  const daemon = command === undefined || command === null ? 'apex-daemon' : String(command).trim();
  if (!COMMAND.test(daemon)) throw new Error('The daemon command is a program name or path, such as apex-daemon or /usr/local/bin/apex-daemon.');
  const label = String(name ?? '').trim();
  if (!label) throw new Error('Give the host a name.');
  if (label.length > 40) throw new Error('Keep the name to 40 characters.');
  const lower = label.toLowerCase();
  if (lower === LOCAL_NAME.toLowerCase() || taken.some((other) => other.toLowerCase() === lower)) throw new Error(`There's already a host called ${label}.`);
  return { name: label, ssh: destination, command: daemon };
}

/** `ssh` arguments that run the daemon on `host` and attach to it. */
export function sshArgs(host) {
  return [
    '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15',
    '--', host.ssh, `${host.command} --stdio --attach`,
  ];
}

/**
 * The hosts to open windows on at launch: those that had one when Deck last
 * closed (`windows`), else the one last used, else This Mac.
 */
export function windowsAtLaunch(state) {
  const known = new Set([LOCAL, ...state.hosts.map((host) => host.id)]);
  const saved = Array.isArray(state.windows) ? state.windows : [state.last];
  const open = [...new Set(saved.filter((id) => known.has(id)))];
  return open.length > 0 ? open : [LOCAL];
}

const EMPTY = () => ({ version: 1, hosts: [], last: LOCAL });

/** hosts.json: `{version: 1, hosts, last}`. Unknown fields are kept; hosts that fail `validHost` are dropped with a warning. */
export function loadHosts(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { state: EMPTY(), warnings: [] };
    return { state: EMPTY(), warnings: [`${file} could not be read: ${e.message}`] };
  }
  let saved;
  try {
    saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not an object');
  } catch (e) {
    const aside = `${file}.unreadable-${Date.now()}`;
    fs.renameSync(file, aside);
    return { state: EMPTY(), warnings: [`${file} could not be read (${e.message}); it was moved to ${aside}.`] };
  }
  const warnings = [];
  const hosts = [];
  for (const host of Array.isArray(saved.hosts) ? saved.hosts : []) {
    try {
      if (typeof host?.id !== 'string' || !host.id || host.id === LOCAL) throw new Error('it has no id');
      hosts.push({ ...host, ...validHost(host, hosts.map((h) => h.name)) });
    } catch (e) {
      warnings.push(`Left out the saved host ${JSON.stringify(host?.name ?? host?.id ?? '')}: ${e.message}`);
    }
  }
  const last = hosts.some((h) => h.id === saved.last) ? saved.last : LOCAL;
  return { state: { ...saved, version: 1, hosts, last }, warnings };
}

export function saveHosts(file, state) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
