// Guided desktop SSH setup. Tickets bind each approval to the exact checked
// destination. Nothing is saved until a real daemon hello passes verification.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { validHost } from './hosts.mjs';

const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
const RELEASES = 'https://github.com/l1quid8/Apex-Deck/releases';
const PROBE = command => `export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
printf 'os=%s\narch=%s\nhome=%s\n' "$(uname -s)" "$(uname -m)" "$HOME"
bin=$(command -v ${command} 2>/dev/null || true)
printf 'bin=%s\n' "$bin"
`;

export function setupFields(fields = {}) {
  const ssh = typeof fields.ssh === 'string' ? fields.ssh.trim() : '';
  const host = validHost({ ...fields, ssh, name: fields.name?.trim() || ssh.split('@').at(-1)?.slice(0, 40) }, []);
  if (fields.port !== undefined && (!Number.isInteger(fields.port) || fields.port < 1 || fields.port > 65535)) throw new Error('Use an SSH port from 1 to 65535.');
  return { ...host, ...(fields.port === undefined ? {} : { port: fields.port }) };
}

export function runCommand(program, args, { signal, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(program, args, { signal, timeout, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(new Error('Setup cancelled.'));
      if (error && (typeof error.code !== 'number' || error.killed)) return reject(new Error(error.killed ? 'SSH timed out. Check the address and try again.' : error.message));
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

export function installScript(asset, target) {
  return `set -eu
target=${quote(target)}
mkdir -p "$(dirname "$target")"
fresh=$(mktemp "$target.setup-XXXXXX")
trap 'rm -f "$fresh"' EXIT HUP INT TERM
if command -v curl >/dev/null 2>&1; then curl -fsSL --max-time 600 -o "$fresh" ${quote(asset.url)}; else wget -qO "$fresh" --timeout=600 ${quote(asset.url)}; fi
got=$(sha256sum "$fresh" | cut -d' ' -f1)
[ "$got" = ${quote(asset.sha256)} ] || { echo 'Download checksum did not match.' >&2; exit 3; }
chmod 0755 "$fresh"
"$fresh" --version >/dev/null
mv -f "$fresh" "$target"
trap - EXIT HUP INT TERM
`;
}

/** Keep an existing service; install a user service when the user manager
 * exists, otherwise start a detached process. Never replaces a running host. */
export function startScript(bin, os) {
  return `set -eu
bin=${quote(bin)}
endpoint=$("$bin" endpoint)
if [ -S "$endpoint" ]; then exit 0; fi
${os === 'Linux' ? `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
if systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  if [ ! -f "$HOME/.config/systemd/user/apex-daemon.service" ]; then
    printf '[Unit]\\nDescription=Apex Deck daemon\\n[Service]\\nExecStart=%s serve\\nRestart=on-failure\\n[Install]\\nWantedBy=default.target\\n' "$bin" > "$HOME/.config/systemd/user/apex-daemon.service"
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now apex-daemon.service >/dev/null
else
  mkdir -p "$HOME/.local/state/apex-deck"
  if command -v setsid >/dev/null 2>&1; then setsid nohup "$bin" serve </dev/null >>"$HOME/.local/state/apex-deck/daemon.log" 2>&1 &
  else nohup "$bin" serve </dev/null >>"$HOME/.local/state/apex-deck/daemon.log" 2>&1 & fi
fi` : `nohup "$bin" serve </dev/null >/dev/null 2>&1 &`}
n=0
while [ "$n" -lt 50 ]; do
  [ -S "$endpoint" ] && exit 0
  n=$((n+1)); sleep 0.2
done
echo 'The Deck host service did not start. Check its service log.' >&2
exit 1
`;
}

export async function linuxRelease(arch, signal) {
  const architecture = { x86_64: 'x86_64', aarch64: 'arm64', arm64: 'arm64' }[arch];
  if (!architecture) throw new Error(`Automatic install is unavailable for Linux ${arch}.`);
  const response = await fetch(`${RELEASES}/latest/download/apex-deck-update.json`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (!response.ok) throw new Error(`Couldn't read the Deck release list (${response.status}).`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('The release list is too large.');
  const feed = JSON.parse(text);
  const asset = Array.isArray(feed?.daemons) ? feed.daemons.find(entry => entry.arch === architecture) : null;
  if (!/^\d+\.\d+\.\d+$/.test(feed?.version) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset?.name) || !/^[a-f0-9]{64}$/.test(asset?.sha256)) throw new Error('No verified Linux download is available for this machine.');
  return { url: `${RELEASES}/download/v${feed.version}/${asset.name}`, sha256: asset.sha256 };
}

export function createConnectionSetup({ run = runCommand, remember, verify, save, release = linuxRelease, sshOptions = [] }) {
  const tickets = new Map();
  const active = state => {
    if (!tickets.has(state.ticket) || state.controller.signal.aborted) throw new Error('Setup cancelled.');
  };
  const get = ticket => {
    const state = tickets.get(ticket);
    if (!state) throw new Error('This setup expired. Check the connection again.');
    active(state);
    return state;
  };
  const cancel = ticket => {
    const state = tickets.get(ticket);
    if (!state) return;
    clearTimeout(state.timer);
    tickets.delete(ticket);
    state.controller.abort();
  };
  const args = (state, command) => ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', ...sshOptions, ...(state.host.port ? ['-p', String(state.host.port)] : []), '--', state.host.ssh, command];
  const exec = (state, command, timeout) => run('ssh', args(state, command), { signal: state.controller.signal, timeout });
  const inspect = async state => {
    const result = await exec(state, PROBE(state.host.command));
    active(state);
    if (result.code !== 0) throw new Error(result.stderr?.trim() || 'SSH sign-in failed. Check the username and authorized SSH key.');
    const info = Object.fromEntries(result.stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    if (!['Linux', 'Darwin'].includes(info.os)) throw new Error('SSH setup supports Linux servers and Macs.');
    if (info.bin) state.host.command = validHost({ ...state.host, command: info.bin }, []).command;
    else if (state.host.command !== 'apex-daemon') throw new Error('The custom daemon command was not found. Check its path in Advanced.');
    else if (info.os !== 'Linux') throw new Error('Install the Deck desktop app on the other Mac, then check this connection again. Automatic installation is available for Linux.');
    if (!info.bin && (!info.home?.startsWith('/') || /[\r\n]/.test(info.home))) throw new Error('The server did not report a usable home directory.');
    state.info = info;
    state.phase = info.bin ? 'ready' : 'install';
    return { kind: state.phase, ticket: state.ticket, name: state.host.name, os: info.os };
  };
  return {
    async check(fields) {
      if (tickets.size >= 8) throw new Error('Close another connection setup before starting a new one.');
      const state = { ticket: crypto.randomUUID(), host: setupFields(fields), controller: new AbortController(), phase: 'checking' };
      state.timer = setTimeout(() => cancel(state.ticket), 15 * 60 * 1000);
      state.timer.unref?.();
      tickets.set(state.ticket, state);
      try {
        try { return await inspect(state); }
        catch (error) {
          if (!/No .* host key is known .*strict checking/i.test(error.message)) throw error;
        }
        // Only an unknown key reaches here. Changed keys never offer Trust.
        const config = await run('ssh', ['-G', ...(state.host.port ? ['-p', String(state.host.port)] : []), '--', state.host.ssh], { signal: state.controller.signal });
        if (config.code) throw new Error(config.stderr || 'Could not read SSH configuration.');
        const value = key => config.stdout.match(new RegExp(`^${key} (.+)$`, 'm'))?.[1];
        const hostname = value('hostname'), port = value('port');
        if (!hostname || hostname.startsWith('-') || /[\s\r\n]/.test(hostname) || !/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('SSH configuration has no usable host and port.');
        if (value('proxyjump') && value('proxyjump') !== 'none' || value('proxycommand') && value('proxycommand') !== 'none') throw new Error('This SSH proxy needs a trusted host key first. Add its fingerprint to your SSH known_hosts, then retry.');
        const scan = await run('ssh-keyscan', ['-T', '10', '-t', 'ed25519', '-p', port, hostname], { signal: state.controller.signal });
        active(state);
        const key = scan.stdout.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === 'ssh-ed25519' && /^[A-Za-z0-9+/]+={0,2}$/.test(parts[2]));
        if (!key) throw new Error('Could not read the SSH fingerprint. Check the address or add its trusted key to SSH configuration.');
        const alias = value('hostkeyalias') || hostname;
        if (/[\s,\r\n]/.test(alias)) throw new Error('SSH HostKeyAlias is not supported by guided trust.');
        state.key = `${value('hostkeyalias') || port === '22' ? alias : `[${alias}]:${port}`} ${key[1]} ${key[2]}\n`;
        state.phase = 'trust';
        return { kind: 'trust', ticket: state.ticket, fingerprint: `SHA256:${crypto.createHash('sha256').update(Buffer.from(key[2], 'base64')).digest('base64').replace(/=+$/, '')}`, algorithm: 'ED25519' };
      } catch (error) { cancel(state.ticket); throw error; }
    },
    async trust(ticket) {
      const state = get(ticket);
      if (state.phase !== 'trust') throw new Error('Check this connection again before trusting it.');
      state.phase = 'checking';
      try { await remember(state.key); active(state); return await inspect(state); }
      catch (error) { cancel(ticket); throw error; }
    },
    async finish(ticket) {
      const state = get(ticket);
      if (!['ready', 'install'].includes(state.phase)) throw new Error('Check and trust the connection before continuing.');
      const install = state.phase === 'install';
      state.phase = 'finishing';
      try {
        if (install) {
          const asset = await release(state.info.arch, state.controller.signal);
          active(state);
          state.host.command = `${state.info.home}/.local/bin/apex-daemon`;
          // The saved command is used by a remote shell, so reject paths that
          // the normal host transport cannot safely execute.
          validHost(state.host, []);
          const result = await exec(state, installScript(asset, state.host.command), 660000);
          active(state);
          if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Deck could not be installed. No host was added.');
        }
        const started = await exec(state, startScript(state.host.command, state.info.os));
        active(state);
        if (started.code !== 0) throw new Error(started.stderr?.trim() || 'The Deck host service did not start. No host was added.');
        const identity = await verify(state.host);
        active(state);
        return await save({ ...state.host, daemonHostId: identity.daemonHostId });
      } finally { cancel(ticket); }
    },
    cancel,
    dispose() { for (const ticket of tickets.keys()) cancel(ticket); },
  };
}
