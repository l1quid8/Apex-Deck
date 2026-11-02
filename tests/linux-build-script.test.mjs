import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// linux-only: scripts/linux-build.sh drives docker. Windows has no such API, and the app refuses
// protected records there instead of pretending the check passed.
const LINUX_ONLY = process.platform === 'linux' ? {} : { skip: 'linux-only: scripts/linux-build.sh drives docker' };

const script = fileURLToPath(new URL('../scripts/linux-build.sh', import.meta.url));

test('a worktree build also mounts the main checkout .git so build.rs can read the commit', LINUX_ONLY, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'deck-linux-build-')));
  try {
    const repo = join(base, 'repo'), linked = join(base, 'linked'), tools = join(base, 'tools'), log = join(base, 'docker-args');
    mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(tools);
    copyFileSync(script, join(repo, 'scripts', 'linux-build.sh'));
    // A stand-in docker records each call's arguments, one per line.
    writeFileSync(join(tools, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$DOCKER_ARGS.$1"\n', { mode: 0o755 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.'); git('commit', '-qm', 'base');
    git('worktree', 'add', '-q', '--detach', linked);

    const mounts = root => {
      execFileSync('bash', [join(root, 'scripts', 'linux-build.sh'), 'amd64'], {
        env: { ...env, PATH: `${tools}:${env.PATH}`, DOCKER_ARGS: log }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const args = readFileSync(`${log}.run`, 'utf8').trimEnd().split('\n');
      return args.filter((_, i) => args[i - 1] === '-v');
    };
    const caches = ['apex-deck-cargo-registry-amd64:/root/.cargo/registry', 'apex-deck-linux-build-amd64:/target'];
    const common = join(repo, '.git');

    assert.deepEqual(mounts(repo), [`${repo}:/src:ro`, ...caches, `${repo}/target/linux-amd64:/out`]);
    assert.deepEqual(mounts(linked), [`${linked}:/src:ro`, `${common}:${common}:ro`, ...caches, `${linked}/target/linux-amd64:/out`]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
