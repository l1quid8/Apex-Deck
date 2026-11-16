#!/usr/bin/env node
// Prune Cargo's build folder of artifacts nobody has touched for a while.
//
//   node scripts/clean-target.mjs                 # remove files older than 7 days
//   node scripts/clean-target.mjs --days 3
//   node scripts/clean-target.mjs --dry-run       # only measure and list
//   node scripts/clean-target.mjs --target DIR    # another target folder
//   node scripts/clean-target.mjs --force         # even while cargo or rustc is running
//
// Why: several agents build this workspace with different feature sets and
// profiles, and every combination leaves its own copies under target/. The
// folder reached 457 GB on 2026-11-15. Cargo rebuilds anything missing, so
// removing stale files is safe when no build is running; the folder's lock
// file and CACHEDIR.TAG are always kept. Like `cargo sweep --time N`, but
// without installing anything.
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KEEP = new Set(['.cargo-lock', 'CACHEDIR.TAG', '.rustc_info.json']);
/** Folders cargo makes inside a profile folder; they stay even when emptied. */
const CARGO_DIRS = new Set(['deps', 'build', 'incremental', '.fingerprint', 'examples']);

export function parseArgs(argv) {
  const opts = { days: 7, dryRun: false, force: false, target: resolve('target') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--days') { opts.days = Number(argv[++i]); if (!Number.isFinite(opts.days) || opts.days < 0) throw new Error('--days needs a number of days, 0 or more'); }
    else if (a === '--target') { opts.target = resolve(argv[++i] || ''); if (!argv[i]) throw new Error('--target needs a folder'); }
    else throw new Error(`Unknown argument ${a}`);
  }
  return opts;
}

/** Whether a cargo, rustc or rustdoc process is running for this user. */
export function buildRunning(env = process.env) {
  if (env.CLEAN_TARGET_TEST_BUSY) return env.CLEAN_TARGET_TEST_BUSY === '1';
  if (process.platform === 'win32') {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
    return /^"(cargo|rustc|rustdoc)\.exe"/mi.test(out);
  }
  try { execFileSync('pgrep', ['-x', 'cargo|rustc|rustdoc'], { stdio: 'ignore' }); return true; }
  catch (e) { if (e.status === 1) return false; throw e; }
}

/**
 * Remove every file under `target` whose modification time is before `cutoff`
 * (a Date), then any directory that became empty. Returns what was done.
 */
export function sweep(target, cutoff, { dryRun = false } = {}) {
  const result = { scanned: 0, removed: 0, freed: 0, kept: 0, emptyDirs: 0, errors: [] };
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { result.errors.push(`${dir}: ${e.code}`); return false; }
    let empty = true;
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (walk(p, depth + 1)) {
          if (!dryRun) { try { rmdirSync(p); result.emptyDirs++; } catch { empty = false; } } else result.emptyDirs++;
        } else empty = false;
        continue;
      }
      result.scanned++;
      let st;
      try { st = lstatSync(p); } catch (e) { result.errors.push(`${p}: ${e.code}`); empty = false; continue; }
      if ((depth <= 1 && KEEP.has(entry.name)) || st.mtime >= cutoff) { result.kept++; empty = false; continue; }
      result.removed++; result.freed += st.size;
      if (!dryRun) { try { rmSync(p, { force: true }); } catch (e) { result.errors.push(`${p}: ${e.code}`); empty = false; } }
    }
    // Never remove the target folder, a profile folder (target/debug, target/<triple>/release)
    // or the folders cargo expects inside one (deps, build, incremental, .fingerprint):
    // only what cargo creates per crate underneath them.
    return empty && depth >= 3 && !CARGO_DIRS.has(basename(dir));
  };
  walk(target, 0);
  return result;
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;

function main(argv) {
  const opts = parseArgs(argv);
  if (!existsSync(opts.target)) throw new Error(`${opts.target} does not exist; nothing to clean`);
  if (!opts.dryRun && !opts.force && buildRunning()) {
    throw new Error('cargo, rustc or rustdoc is running; a build would lose files from under it. Wait, or pass --force.');
  }
  const cutoff = new Date(Date.now() - opts.days * 86_400_000);
  console.log(`${opts.dryRun ? 'Measuring' : 'Removing'} files under ${opts.target} not modified since ${cutoff.toISOString().slice(0, 10)}…`);
  const r = sweep(opts.target, cutoff, { dryRun: opts.dryRun });
  console.log(`${opts.dryRun ? 'would remove' : 'removed'} ${r.removed.toLocaleString()} of ${r.scanned.toLocaleString()} files (${gb(r.freed)}), ${r.emptyDirs.toLocaleString()} empty folders; kept ${r.kept.toLocaleString()}`);
  for (const e of r.errors.slice(0, 10)) console.error(`  ${e}`);
  if (r.errors.length > 10) console.error(`  … and ${r.errors.length - 10} more`);
  return r.errors.length ? 1 : 0;
}

// A URL pathname is /D:/a/... on Windows and percent-encodes spaces, so compare file paths.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { console.error(`clean-target: ${e.message}`); process.exit(1); }
}
