import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function pickIdentity(output, env) {
  const override = env.APEX_DECK_SIGN_IDENTITY;
  if (override !== undefined && override !== '') {
    if (override !== '-' && !/^[a-fA-F0-9]{40}$/.test(override)) {
      throw new Error('APEX_DECK_SIGN_IDENTITY must be a 40-character identity hash or -');
    }
    return override;
  }
  const hashes = [...new Set([...output.matchAll(/^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"Developer ID Application:[^"\r\n]*"/gm)].map(match => match[1]))];
  if (hashes.length > 1) {
    throw new Error(`Multiple Developer ID identities: ${hashes.join(', ')}. Set APEX_DECK_SIGN_IDENTITY.`);
  }
  return hashes[0] ?? '-';
}

export function signingMessage(identity) {
  return identity === '-' ? 'signing ad hoc' : `signing with Developer ID ${identity}`;
}

function main() {
  const discovery = process.env.APEX_DECK_SIGN_IDENTITY
    ? null : spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = pickIdentity(discovery?.status === 0 ? discovery.stdout : '', process.env);
  console.log(signingMessage(identity));
  const args = ['--mac', ...process.argv.slice(2)];
  if (identity !== '-') args.push(`-c.mac.identity=${identity}`);
  const result = spawnSync(resolve('node_modules/.bin/electron-builder'), args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
