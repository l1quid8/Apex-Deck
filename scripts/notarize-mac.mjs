// Apple notarization for the Mac desktop app, its disk image and the CLI archive.
//
// Credentials only ever come from the environment, using the same variables and
// the same order as electron-builder's own notarize step (which notarizes and
// staples the .app), so one setup serves both:
//   1. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//   2. APPLE_API_KEY (path to the .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER
//   3. APPLE_KEYCHAIN_PROFILE (+ optional APPLE_KEYCHAIN), made once with
//      `xcrun notarytool store-credentials`. Recommended: nothing secret is in
//      the environment or on a command line.
// APEX_DECK_NOTARIZE=0 skips notarization, =1 makes missing credentials an error.
// Nothing here prints a credential, an Apple ID or a team id.
import { spawnSync } from 'node:child_process';

const SETUP = 'see docs/notarization.md';

export function notarizeCredentials(env) {
  const { APPLE_ID: appleId, APPLE_APP_SPECIFIC_PASSWORD: password, APPLE_TEAM_ID: teamId } = env;
  if (appleId || password) {
    const missing = [['APPLE_ID', appleId], ['APPLE_APP_SPECIFIC_PASSWORD', password], ['APPLE_TEAM_ID', teamId]]
      .filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Apple ID notarization also needs ${missing.join(', ')} (${SETUP})`);
    return { mode: 'Apple ID', args: ['--apple-id', appleId, '--password', password, '--team-id', teamId] };
  }
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = env;
  if (key || keyId || issuer) {
    const missing = [['APPLE_API_KEY', key], ['APPLE_API_KEY_ID', keyId], ['APPLE_API_ISSUER', issuer]]
      .filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`API key notarization also needs ${missing.join(', ')} (${SETUP})`);
    return { mode: 'App Store Connect API key', args: ['--key', key, '--key-id', keyId, '--issuer', issuer] };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return {
      mode: 'keychain profile',
      args: ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : [])],
    };
  }
  return null;
}

/// Decide whether this build is notarized. Throws only on a misconfiguration
/// (a partial credential set, or APEX_DECK_NOTARIZE=1 when it cannot happen).
export function notarizePlan(identity, env) {
  const setting = env.APEX_DECK_NOTARIZE ?? '';
  if (!['', '0', '1'].includes(setting)) throw new Error('APEX_DECK_NOTARIZE must be 0, 1 or unset');
  if (setting === '0') return { notarize: false, reason: 'APEX_DECK_NOTARIZE=0' };
  const required = setting === '1';
  if (identity === '-') {
    if (required) throw new Error('APEX_DECK_NOTARIZE=1 needs a Developer ID identity; ad hoc builds cannot be notarized');
    return { notarize: false, reason: 'ad hoc signing cannot be notarized' };
  }
  const credentials = notarizeCredentials(env);
  if (!credentials) {
    if (required) throw new Error(`APEX_DECK_NOTARIZE=1 but no Apple notarization credentials are set (${SETUP})`);
    return { notarize: false, reason: `no Apple notarization credentials in the environment (${SETUP})` };
  }
  return { notarize: true, ...credentials };
}

export function notarizeMessage(plan) {
  return plan.notarize ? `notarizing with ${plan.mode}` : `skipping notarization: ${plan.reason}`;
}

export function submitArgs(file, plan) {
  return ['notarytool', 'submit', file, ...plan.args, '--wait', '--output-format', 'json'];
}

/// notarytool prints one JSON object; anything but Accepted fails the build.
export function parseSubmission(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('notarytool returned no readable result'); }
  if (typeof result?.id !== 'string' || typeof result?.status !== 'string') throw new Error('notarytool returned no submission id or status');
  return { id: result.id, status: result.status, accepted: result.status === 'Accepted' };
}

function xcrun(args, options = {}) {
  const result = spawnSync('/usr/bin/xcrun', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
  if (result.error) throw result.error;
  return result;
}

/// Submit one zip, dmg or pkg and wait for Apple. Stapling is for files that can
/// carry a ticket (dmg, pkg, app); a zip of bare binaries is checked online.
export function notarizeFile(file, plan, { staple = false, log = console.log } = {}) {
  log(`notarize: submitting ${file}`);
  const submitted = xcrun(submitArgs(file, plan));
  const submission = parseSubmission(submitted.stdout);
  if (!submission.accepted) {
    log(`notarize: Apple answered ${submission.status} for submission ${submission.id}; its log follows`);
    xcrun(['notarytool', 'log', submission.id, ...plan.args], { stdio: ['ignore', 'inherit', 'inherit'] });
    throw new Error(`notarization was not accepted (${submission.status}); release was not produced`);
  }
  if (submitted.status !== 0) throw new Error('notarytool failed; release was not produced');
  log(`notarize: accepted (submission ${submission.id})`);
  if (staple) {
    for (const step of ['staple', 'validate']) {
      const stapled = xcrun(['stapler', step, file], { stdio: ['ignore', 'inherit', 'inherit'] });
      if (stapled.status !== 0) throw new Error(`stapler ${step} failed for ${file}`);
    }
  }
  return submission;
}
