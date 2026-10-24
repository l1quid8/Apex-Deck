// One commit for the whole build.
//
// The app and the background service are stamped by different toolchains:
// vite.config.ts bakes __APP_BUILD__ into the UI bundle, and
// crates/apex-daemon/build.rs bakes APEX_BUILD_COMMIT into the service binary.
// Both used to ask git for HEAD themselves, at whatever moment they happened
// to compile. When a branch moved mid-build, the two answered differently and
// the app told the Human "Different builds" for a single, self-consistent
// package (0.9.0 r2: UI 6c5a1f1, service 2f43c91, no Rust changed between them).
//
// A packaging run now resolves the commit once here and exports it, so both
// stampers copy the same value instead of asking git again.

/// The stamp both sides must agree on.
/// @param {{env?: Record<string,string|undefined>, git?: ((args: string[]) => string|null)|null}} options
export function readStamp({ env = process.env, git = null } = {}) {
  const fromEnv = (env.APEX_BUILD_COMMIT ?? '').trim();
  const commit = fromEnv || (git ? git(['rev-parse', '--short=12', 'HEAD']) : null) || 'unknown';

  const dirtyEnv = env.APEX_BUILD_DIRTY;
  const dirty = dirtyEnv !== undefined
    ? dirtyEnv === 'true'
    : commit !== 'unknown' && Boolean(git && git(['status', '--porcelain', '--untracked-files=no']));

  return { commit, dirty };
}

/// The environment a build must inherit so every artifact carries `stamp`.
export function stampEnv(stamp, base = process.env) {
  return { ...base, APEX_BUILD_COMMIT: stamp.commit, APEX_BUILD_DIRTY: String(stamp.dirty) };
}
