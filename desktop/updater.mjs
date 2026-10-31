// Automatic updates for the packaged Mac and Windows apps.
//
// Deck reads apex-deck-update.json from the latest public GitHub release, and
// when it names a newer version for this Mac, downloads that release's .pkg
// into the cache. The package is ready only after two checks: the size and
// SHA-256 the manifest gives, then the app inside it, which must be signed by
// this app's own Developer ID team and carry the promised version. "Restart to
// update" hands it to the root update job through the provenance broker
// (desktop/provenance.mjs requestUpdate); that job checks everything again
// itself, so nothing decided here is trusted by root.
//
// Windows has its own feed, because a shipped Mac copy rejects the whole feed at
// the first entry that isn't a .pkg. Its installer is ready only once Windows
// finds a valid signature by the publisher that signed this running app, on the
// promised version. "Restart to update" checks that again, then starts the
// installer through Windows' own permission prompt; declining changes nothing.
//
// Effects (network, files, commands, the broker, timers) come in through the
// constructor, so the tests never touch any of them for real.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export const REPO = 'l1quid8/apex-deck';
export const MANIFEST_NAME = 'apex-deck-update.json';
export const FEED_URL = `https://github.com/${REPO}/releases/latest/download/${MANIFEST_NAME}`;
export const WINDOWS_MANIFEST_NAME = 'apex-deck-update-windows.json';
export const WINDOWS_FEED_URL = `https://github.com/${REPO}/releases/latest/download/${WINDOWS_MANIFEST_NAME}`;
/** Written by the update job; root-owned and readable by everyone. */
export const RESULT_FILE = '/Library/Application Support/Apex Deck Updates/last-update.json';
export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Waits before the second and third download attempts. */
export const RETRY_DELAYS_MS = [5_000, 30_000];
/** A request with no result after this long did not run. */
export const RESULT_WAIT_MS = 15 * 60 * 1000;
/** What went wrong, which may be a long command error; account notes travel apart and are never cut by it. */
export const RESULT_MESSAGE_LIMIT = 500;
/** One account's note is about 200 characters; this only stops an absurd account name. */
export const RESULT_NOTE_LIMIT = 1000;
/**
 * The account notes 0.9.1's installer folded into its message. That installer
 * runs the first update away from it, so its notes are found again here.
 */
const FOLDED_NOTE = /Apex Deck's background service in the account "[\s\S]*?" (?:didn't start again, so agents and phone connections there stay off until Apex Deck is opened in that account\.|was stopped for the update and stays off until this is sorted out\.)/g;
const PACKAGE_LIMIT = 4 * 1024 ** 3;
const MANIFEST_LIMIT = 64 * 1024;
const VERSION = /^\d+(?:\.\d+){1,3}$/;
const PACKAGE_NAME = { '.pkg': /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.pkg$/, '.exe': /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/ };
const ARCHES = new Set(['arm64', 'x64']);

/** [major, minor, patch, build] for a dotted version, or null. */
export function versionParts(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return null;
  const parts = value.split('.').map(Number);
  return [...parts, 0, 0, 0].slice(0, 4);
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
export function compareVersions(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The release manifest, checked field by field:
 * `{ schemaVersion: 1, version, notes?, packages: [{ arch, minimumSystemVersion, name, size, sha256 }] }`.
 * It decides only what to download; the package's own signature decides whether it installs.
 */
export function parseManifest(value, { extension = '.pkg' } = {}) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw new Error('The update feed is not one this version understands.');
  if (!versionParts(value.version)) throw new Error('The update feed names no valid version.');
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4000)) throw new Error('The update notes are malformed.');
  if (!Array.isArray(value.packages) || value.packages.length === 0 || value.packages.length > 8) throw new Error('The update feed lists no packages.');
  const packages = value.packages.map((entry) => {
    const ok = entry && ARCHES.has(entry.arch) && versionParts(entry.minimumSystemVersion)
      && typeof entry.name === 'string' && PACKAGE_NAME[extension].test(entry.name)
      && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= PACKAGE_LIMIT
      && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256);
    if (!ok) throw new Error('The update feed has a malformed package.');
    return { arch: entry.arch, minimumSystemVersion: entry.minimumSystemVersion, name: entry.name, size: entry.size, sha256: entry.sha256 };
  });
  return { version: value.version, notes: value.notes ?? '', packages };
}

/** The package for this Mac, or null when the release has none it can run. */
export function packageFor(manifest, { arch, osVersion }) {
  return manifest.packages.find((entry) => entry.arch === arch
    && versionParts(osVersion) && compareVersions(osVersion, entry.minimumSystemVersion) >= 0) ?? null;
}

/** Always a file of this repository's release for `version`: the feed never chooses the host. */
export function assetUrl(version, name, extension = '.pkg') {
  if (!versionParts(version) || !PACKAGE_NAME[extension].test(name)) throw new Error('Invalid update asset.');
  return `https://github.com/${REPO}/releases/download/v${version}/${name}`;
}

/** Why this copy never updates itself, or null when it can. */
export function disabledReason({ packaged, platform, dataDir, smoke, protectedCopy, team }) {
  if (!packaged) return 'Development builds don’t update themselves.';
  if (platform !== 'darwin' && platform !== 'win32') return 'Automatic updates aren’t available on this system.';
  if (smoke) return 'Updates are off during smoke runs.';
  if (dataDir) return 'Updates are off while Deck uses a separate data folder.';
  if (!team) return platform === 'win32'
    ? 'This build isn’t signed, so it can’t check who made an update.'
    : 'This build isn’t signed with a Developer ID, so it can’t check who made an update.';
  if (!protectedCopy) return 'Updates install from the protected copy of Apex Deck. Open that copy to update.';
  return null;
}

/** The Developer ID team in `codesign -d --verbose=2` output, or null for ad hoc. */
export function teamFrom(details) {
  return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(details))?.[1] ?? null;
}

/** SHA-256 of a file, streamed. */
export async function fileSha256(file, files = fs) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of files.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** The feed, through `fetch` (Electron's net.fetch follows GitHub's redirects). */
export function fetchManifest(fetchImpl) {
  return async (url) => {
    const response = await fetchImpl(url, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The update feed answered ${response.status}.`);
    const text = await response.text();
    if (text.length > MANIFEST_LIMIT) throw new Error('The update feed is too large.');
    return JSON.parse(text);
  };
}

/**
 * Download `url` to `file`, never past `size`; resolves the SHA-256 of what was written.
 * pipeline() owns the file stream, so a failed open or write (a missing folder,
 * a full disk) rejects here for the retries instead of escaping as an uncaught error.
 * It can't cancel the response's web stream itself, so the source cancels its own
 * reader when pipeline aborts: a read still waiting on the network ends at once.
 * Cancelling the body leaves Electron's request open, so the request is aborted too.
 */
export function fetchDownload(fetchImpl, files = fs) {
  return async (url, file, { size, onProgress = () => {} }) => {
    const request = new AbortController();
    const response = await fetchImpl(url, { cache: 'no-store', signal: request.signal });
    if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}.`);
    const hash = crypto.createHash('sha256');
    let received = 0;
    await pipeline(async function* ({ signal }) {
      const reader = response.body.getReader();
      // Cancel first, so a waiting read ends rather than failing with the abort.
      const stop = () => { reader.cancel(signal.reason).catch(() => {}); request.abort(); };
      signal.addEventListener('abort', stop, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          received += value.length;
          if (received > size) throw new Error('The download is larger than the release says.');
          hash.update(value);
          yield value;
          onProgress(received);
        }
      } finally {
        // Also on "larger than promised": the rest is never read.
        signal.removeEventListener('abort', stop);
        stop();
      }
    }, files.createWriteStream(file, { mode: 0o600 }));
    if (received !== size) throw new Error('The download stopped early.');
    return hash.digest('hex');
  };
}

/**
 * Unpack the package (running none of its scripts) and check its app: signed by
 * `team`, Apex Deck's identifier, and the version the feed promised.
 */
export function packageVerifier({ run, team, scratch, files = fs }) {
  return async (file, { version }) => {
    files.mkdirSync(scratch, { recursive: true });
    const dir = files.mkdtempSync(path.join(scratch, 'check-'));
    const expanded = path.join(dir, 'expanded');
    try {
      await run('/usr/sbin/pkgutil', ['--expand-full', file, expanded]);
      const app = path.join(expanded, 'Payload', 'Apex Deck.app');
      try {
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=identifier "dev.apexdeck.app" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`, app]);
      } catch {
        throw new Error('The update isn’t signed by the team that signed this app.');
      }
      const found = String(await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')])).trim();
      if (found !== version) throw new Error(`The package holds version ${found || 'unknown'}, not ${version}.`);
    } finally {
      files.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const SIGNATURE_SCRIPT = [
  '$file = $env:APEX_UPDATE_FILE',
  '$signature = Get-AuthenticodeSignature -LiteralPath $file',
  '[pscustomobject]@{ status = "$($signature.Status)"; subject = $signature.SignerCertificate.Subject; issuer = $signature.SignerCertificate.Issuer; version = (Get-Item -LiteralPath $file).VersionInfo.ProductVersion } | ConvertTo-Json -Compress',
].join('; ');
const INSTALL_SCRIPT = "Start-Process -FilePath $env:APEX_UPDATE_FILE -ArgumentList '/S','--force-run' -Verb RunAs -ErrorAction Stop";

/**
 * Run PowerShell with the file in the environment, so no path is ever parsed as
 * code. A PSModulePath inherited from PowerShell 7 stops Windows PowerShell from
 * loading its own signature commands.
 */
const powershell = (run, script, file, systemRoot = process.env.SystemRoot ?? 'C:\\Windows') => {
  const { PSModulePath: _inherited, ...env } = process.env;
  return run(
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...env, APEX_UPDATE_FILE: file }, windowsHide: true },
  );
};

/** The publisher behind a valid signature, or null. The issuing CA changes; its organization doesn't. */
export function windowsSignerFrom(output) {
  let found;
  try { found = JSON.parse(String(output)); } catch { return null; }
  const issuer = /(?:^|,\s*)O=([^,]+)/.exec(found?.issuer ?? '')?.[1];
  if (found?.status !== 'Valid' || typeof found.subject !== 'string' || !found.subject || !issuer) return null;
  return { subject: found.subject, issuer, version: typeof found.version === 'string' ? found.version.trim() : '' };
}

/** Who signed `file`, as Windows sees it. Null when it can't say: an unsigned copy never updates. */
export const windowsSigner = async (run, file) => windowsSignerFrom(await powershell(run, SIGNATURE_SCRIPT, file).catch(() => ''));

/** The installer must be validly signed by this app's own publisher, at the promised version. */
export function windowsVerifier({ run, signer }) {
  return async (file, { version }) => {
    const found = await windowsSigner(run, file);
    if (!found || found.subject !== signer?.subject || found.issuer !== signer?.issuer) {
      throw new Error('The update isn’t signed by the publisher that signed this app.');
    }
    if (found.version !== version) throw new Error(`The installer holds version ${found.version || 'unknown'}, not ${version}.`);
  };
}

/** Check again, then start the installer. Windows shows its permission prompt here. */
export function windowsInstaller({ run, verify }) {
  return async (ready) => {
    await verify(ready.package, { version: ready.version });
    try {
      await powershell(run, INSTALL_SCRIPT, ready.package);
    } catch {
      throw new Error('Windows didn’t start the update, so nothing was changed. Choose Yes when it asks for permission.');
    }
    return crypto.randomUUID();
  };
}

/** The installer's result as a short reason plus every account note, whole. */
export function resultParts(found) {
  let message = found.message == null ? '' : String(found.message);
  let notes;
  if (Array.isArray(found.notes)) notes = found.notes.filter((note) => typeof note === 'string' && note);
  else {
    notes = message.match(FOLDED_NOTE) ?? [];
    message = message.replace(FOLDED_NOTE, '').replace(/\s+/g, ' ').trim();
  }
  return { message: message.slice(0, RESULT_MESSAGE_LIMIT), notes: notes.map((note) => note.slice(0, RESULT_NOTE_LIMIT)) };
}

const message = (error) => (error instanceof Error ? error.message : String(error)) || 'Something went wrong.';

/**
 * The sentence Settings shows after a failed check or download. Chromium's
 * network errors ("net::ERR_NAME_NOT_RESOLVED", or a connection dropped
 * partway, even inside another message) mean GitHub never answered; the next check is CHECK_EVERY_MS away.
 */
const failure = (error) => (message(error).includes('net::ERR_')
  ? 'Couldn’t reach GitHub. Check your internet connection; Deck will try again later.'
  : `Couldn’t update: ${message(error)}`);

export class Updater {
  constructor({
    current, arch, osVersion, cacheDir, stateFile, resultFile = RESULT_FILE, disabled = null,
    feedUrl = FEED_URL, extension = '.pkg',
    fetchJson, download, verify, requestInstall,
    files = fs, now = () => Date.now(), timers = globalThis, onChange = () => {},
    retryDelays = RETRY_DELAYS_MS,
  }) {
    Object.assign(this, { current, arch, osVersion, cacheDir, stateFile, resultFile, feedUrl, extension, fetchJson, download, verify, requestInstall, files, now, timers, onChange, retryDelays });
    this.view = {
      current,
      state: disabled ? 'disabled' : 'idle',
      disabledReason: disabled,
      available: null,
      progress: null,
      error: null,
      checkedAt: null,
      dismissed: false,
      result: null,
    };
    this.ready = null;
    this.busy = null;
    this.timer = null;
  }

  status() {
    const { available, progress, result } = this.view;
    return { ...this.view, available: available && { ...available }, progress: progress && { ...progress }, result: result && { ...result } };
  }

  set(patch) {
    this.view = { ...this.view, ...patch };
    this.onChange(this.status());
  }

  readState() {
    try { return JSON.parse(this.files.readFileSync(this.stateFile, 'utf8')) ?? {}; } catch { return {}; }
  }

  writeState(state) {
    this.files.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    this.files.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    this.files.renameSync(temp, this.stateFile);
  }

  /** Say how the last "Restart to update" went, once; then check now and then. */
  start() {
    if (this.view.state === 'disabled') return;
    this.reconcile();
    this.pruneCache(null);
    this.schedule(FIRST_CHECK_MS);
  }

  stop() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(ms) {
    this.stop();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.check().finally(() => { if (!this.timer) this.schedule(CHECK_EVERY_MS); });
    }, ms);
  }

  reconcile() {
    const state = this.readState();
    const asked = state.requested;
    if (!asked || typeof asked.id !== 'string') return;
    let found = null;
    try { found = JSON.parse(this.files.readFileSync(this.resultFile, 'utf8')); } catch { /* not written yet */ }
    let result = null;
    if (found?.id === asked.id) {
      // An install can succeed and still have something to say, such as another account's service that didn't start again.
      const { message, notes } = resultParts(found);
      const told = { ...(message ? { message } : {}), ...(notes.length ? { notes } : {}) };
      result = found.outcome === 'installed' && this.current === asked.version
        ? { outcome: 'installed', version: asked.version, ...told }
        : { outcome: found.outcome === 'needs-attention' ? 'needs-attention' : 'failed', version: asked.version, message: 'The update did not install.', ...told };
    } else if (this.current === asked.version) {
      result = { outcome: 'installed', version: asked.version };
    } else if (this.now() - Number(asked.at) > RESULT_WAIT_MS) {
      result = { outcome: 'failed', version: asked.version, message: 'The update did not run. Nothing was changed.' };
    } else {
      return;
    }
    const { requested: _done, ...rest } = state;
    this.writeState(rest);
    this.set({ result });
  }

  dismissResult() {
    this.set({ result: null });
  }

  /** "Later": the ready banner goes; the update stays ready in Settings. */
  later() {
    if (this.view.state === 'ready') this.set({ dismissed: true });
  }

  /** Check the feed now. A check while one runs joins it. */
  check({ manual = false } = {}) {
    if (this.view.state === 'disabled') return Promise.resolve(this.status());
    if (this.busy) return this.busy;
    if (manual && this.view.state === 'ready') this.set({ dismissed: false });
    this.busy = this.run().finally(() => { this.busy = null; });
    return this.busy;
  }

  async run() {
    const ready = this.view.state === 'ready';
    const readyView = ready ? { available: this.view.available } : null;
    if (!ready) this.set({ state: 'checking', error: null });
    try {
      const raw = await this.fetchJson(this.feedUrl);
      if (raw === null) {
        if (!ready) this.set({ state: 'up-to-date', checkedAt: this.now() });
        return this.status();
      }
      const manifest = parseManifest(raw, { extension: this.extension });
      if (compareVersions(manifest.version, this.current) <= 0) {
        this.set({ state: 'up-to-date', checkedAt: this.now(), available: null });
        return this.status();
      }
      if (ready && this.ready?.version === manifest.version) {
        this.set({ checkedAt: this.now() });
        return this.status();
      }
      const entry = packageFor(manifest, { arch: this.arch, osVersion: this.osVersion });
      if (!entry) {
        this.set({ state: 'up-to-date', checkedAt: this.now(), available: null, error: `Version ${manifest.version} has no build for this computer.` });
        return this.status();
      }
      await this.fetchPackage(manifest, entry);
    } catch (error) {
      // A ready update stays ready when a later check, or a newer download, fails.
      if (ready) this.set({ state: 'ready', ...readyView, progress: null, checkedAt: this.now() });
      else this.set({ state: 'error', error: failure(error), progress: null, checkedAt: this.now() });
    }
    return this.status();
  }

  async fetchPackage(manifest, entry) {
    const folder = path.join(this.cacheDir, manifest.version);
    const file = path.join(folder, entry.name);
    const available = { version: manifest.version, notes: manifest.notes };
    let last = null;
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (attempt > 0) await new Promise((done) => this.timers.setTimeout(done, this.retryDelays[attempt - 1]));
      try {
        this.files.mkdirSync(folder, { recursive: true, mode: 0o700 });
        const cached = this.files.existsSync(file) && this.files.statSync(file).size === entry.size
          && await fileSha256(file, this.files) === entry.sha256;
        if (!cached) {
          const partial = `${file}.partial`;
          this.files.rmSync(partial, { force: true });
          this.set({ state: 'downloading', available, progress: { received: 0, total: entry.size }, error: null });
          const sha = await this.download(assetUrl(manifest.version, entry.name, this.extension), partial, {
            size: entry.size,
            onProgress: (received) => this.set({ progress: { received, total: entry.size } }),
          });
          if (sha !== entry.sha256) {
            this.files.rmSync(partial, { force: true });
            throw new Error('The download doesn’t match the release’s checksum.');
          }
          this.files.renameSync(partial, file);
        }
        this.set({ state: 'verifying', available, progress: null });
        try {
          await this.verify(file, { version: manifest.version });
        } catch (error) {
          this.files.rmSync(file, { force: true });
          throw error;
        }
        this.ready = { version: manifest.version, package: file, sha256: entry.sha256, size: entry.size };
        this.pruneCache(manifest.version);
        this.set({ state: 'ready', available, progress: null, error: null, dismissed: false, checkedAt: this.now() });
        return;
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }

  /** Remove downloads other than `keep`. */
  pruneCache(keep) {
    let entries = [];
    try { entries = this.files.readdirSync(this.cacheDir); } catch { return; }
    for (const name of entries) {
      if (name !== keep) this.files.rmSync(path.join(this.cacheDir, name), { recursive: true, force: true });
    }
  }

  /**
   * Hand the ready package to the update job. Resolves once the broker has
   * queued it; the caller quits Deck then. On failure the update stays ready.
   */
  async restart() {
    if (this.view.state !== 'ready' || !this.ready) throw new Error('No update is ready to install.');
    const ready = this.ready;
    this.set({ state: 'installing', error: null });
    try {
      const id = await this.requestInstall(ready);
      this.writeState({ ...this.readState(), requested: { id, version: ready.version, from: this.current, at: this.now() } });
      return id;
    } catch (error) {
      this.set({ state: 'ready', error: message(error) });
      throw error;
    }
  }
}
