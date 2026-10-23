// What a launch of the packaged app does about the protected copy.
//
// The provenance broker trusts a peer only when every component of the peer's
// executable path is root-owned and not group- or world-writable
// (crates/apex-provenance/native/peer.m), and /Applications is group-writable.
// So the app people launch from the Dock can never be trusted, even with the
// same CDHashes; only the copy scripts/install-provenance.sh puts under
// /Library/Application Support/Apex Deck Provenance/TrustedUI is. Launching the
// /Applications copy used to rewrite the LaunchAgent to its own daemon, which
// replaced the trusted daemon and took protected assistants, tasks and
// conversations out of reach.
//
// Everything here is pure: the disk and the open/quit effects are passed in, so
// tests never look at the real /Library, /Applications or ~/Library.

import fs from 'node:fs';
import path from 'node:path';

/** Where the protected tree is installed. A constant: no env var or argument may move it. */
export const TRUSTED_ROOT = '/Library/Application Support/Apex Deck Provenance';
/** The protected copy of the app itself. */
export const TRUSTED_APP = path.join(TRUSTED_ROOT, 'TrustedUI', 'Apex Deck.app');
/** The daemon inside a bundle; the LaunchAgent runs this one. */
export const daemonIn = (app) => path.join(app, 'Contents', 'Resources', 'bin', 'apex-daemon');
/** The daemon of the protected copy: the only one the broker will trust. */
export const TRUSTED_DAEMON = daemonIn(TRUSTED_APP);

/**
 * The `.app` a path sits in: Electron hands out
 * `…/Apex Deck.app/Contents/Resources/app.asar`, and the bundle is what
 * ownership and versions are about. A path in no bundle is its own bundle.
 */
export function bundlePath(appPath) {
  const full = path.resolve(appPath);
  const parts = full.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].endsWith('.app')) return parts.slice(0, i + 1).join(path.sep) || path.sep;
  }
  return full;
}

/**
 * Whether every component of `target` is root-owned and closed to group and
 * world writes — the same rule peer.m applies before it trusts a peer.
 */
export function rootProtected(target, files = fs) {
  for (let at = path.resolve(target); ; at = path.dirname(at)) {
    let stat;
    try { stat = files.lstatSync(at); } catch { return false; }
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) return false;
    if (at === path.dirname(at)) return true;
  }
}

/** `CFBundleShortVersionString` from a bundle's Info.plist, which Electron writes as XML, or null. */
export function bundleVersion(app, files = fs) {
  try {
    const text = String(files.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'));
    const found = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    return found ? found[1] : null;
  } catch {
    return null;
  }
}

/** Whether `app` is the protected copy the broker would trust. */
export function isProtectedCopy(app, files = fs, trustedApp = TRUSTED_APP) {
  let resolved;
  let trusted;
  try {
    resolved = files.realpathSync(app);
    trusted = files.realpathSync(trustedApp);
  } catch {
    return false;
  }
  return resolved === trusted && rootProtected(resolved, files);
}

const unxml = (text) => String(text)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** The daemon a LaunchAgent plist runs: the first of its ProgramArguments, or null. */
export function plistDaemonBin(plist) {
  if (typeof plist !== 'string') return null;
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  const first = args && /<string>([\s\S]*?)<\/string>/.exec(args[1]);
  return first ? unxml(first[1]) : null;
}

const isDirectory = (app, files) => {
  try { return files.statSync(app).isDirectory(); } catch { return false; }
};

/**
 * What this launch should do, and which daemon the LaunchAgent should run.
 *
 * `kind`:
 * - `run` — carry on: a dev build, another platform, an isolated data folder,
 *   or this *is* the protected copy.
 * - `handoff` — open the protected copy and quit, touching no daemon and no
 *   LaunchAgent.
 * - `notice` — carry on, but show `notice` instead of quietly downgrading.
 *
 * `daemon` is the protected daemon whenever one is installed and trusted, and
 * always when the LaunchAgent already runs it: an existing protected agent is
 * never rewritten to a path the broker would refuse.
 */
export function launchPlan({ packaged, platform, dataDir, bundle, version, daemon, plist = null, files = fs, trustedApp = TRUSTED_APP }) {
  const running = bundlePath(bundle);
  const current = plistDaemonBin(plist);
  const installed = isDirectory(trustedApp, files);
  const protectedInstall = installed && rootProtected(trustedApp, files);
  const sameVersion = protectedInstall && version != null && bundleVersion(trustedApp, files) === version;
  const keepsProtectedAgent = current === TRUSTED_DAEMON;
  const agentDaemon = keepsProtectedAgent || sameVersion ? TRUSTED_DAEMON : daemon;
  const base = { app: trustedApp, daemon: agentDaemon };
  if (!packaged || platform !== 'darwin' || dataDir) return { kind: 'run', ...base, daemon };
  if (isProtectedCopy(running, files, trustedApp)) return { kind: 'run', ...base };
  if (sameVersion) {
    return {
      kind: 'handoff',
      ...base,
      notice: {
        message: 'Protected assistant data needs the trusted Apex Deck install',
        detail: `The protected copy at ${trustedApp} could not be opened from this copy. Open it from Finder, or ask for the trusted install to be re-pinned (scripts/repin-provenance.sh).`,
      },
    };
  }
  const detail = !installed
    ? `Apex Deck's protected copy isn't installed at ${trustedApp}, so assistants, tasks and conversations kept in the protected store can't be opened. Ask for the trusted install to be run (scripts/install-provenance.sh, then scripts/repin-provenance.sh), then open Apex Deck again.`
    : !protectedInstall
      ? `The copy at ${trustedApp} is not owned by root with group and world writes closed, so the protected service will not trust it. Re-run the trusted install (scripts/install-provenance.sh, then scripts/repin-provenance.sh).`
      : `The protected copy at ${trustedApp} is version ${bundleVersion(trustedApp, files) ?? 'unknown'}, and this app is version ${version ?? 'unknown'}. Ask for the trusted install to be updated and re-pinned (scripts/repin-provenance.sh), then open Apex Deck again.`;
  return {
    kind: 'notice',
    ...base,
    notice: { message: 'Protected assistant data needs the trusted Apex Deck install', detail },
  };
}
