# Testing a signed development snapshot on real threads

This workflow builds a signed app directory and matching daemon from the current
checkout. It does not create a DMG/PKG, run Installer, replace `/Applications`, or
replace the protected production app. It temporarily changes the provenance
broker's exact trust pins and switches the user's daemon service.

## Start or rebuild

Finish agent work, close terminal sessions, quit Apex Deck and Unified Computer
Use, and avoid sending work from phones or other clients during the switch.
Pause scheduled work that could start during the switch. Then, as your normal
user:

```sh
cd /Users/tylercaldwell/Downloads/apex-deck
npm run desktop:dev:start
```

Compilation and signing run without sudo. macOS administrator authorization is
required for the short protected activation step. Enter the password only in
your own Terminal's sudo prompt. Do not run the whole npm command with sudo.
The helper makes daemon IPC queries under your effective user ID and restores
root privileges before trust/service operations; the daemon still refuses
different-user IPC clients, including root.
The trusted snapshot uses an optimized, symbol-stripped dev profile in the
dedicated `target/trusted-dev` cache. Its first build compiles that cache;
subsequent builds reuse it. This keeps the signed daemon small enough for the
broker's per-request signature validation. Ordinary `target/debug` builds are
not replaced. No release profile, DMG or installer is produced.
Protected broker requests queue inside each client process for the full
request/response, matching the broker's serial transaction handling. This
avoids overflowing its socket backlog during a burst of catalog/thread reads;
it does not cache authority or replay requests.
The signed app starts against
`~/Library/Application Support/dev.apexdeck.app`; its UI and daemon carry the
same `COMMIT-dev-CONTENTHASH` source stamp. UI/backend edits require another
snapshot build/relaunch; this mode has no Vite hot reload. Run the same command
after closing the dev UI to rebuild and replace the active snapshot.

To build and inspect before changing any running service:

```sh
npm run desktop:dev:build
# After reviewing staging/trusted-dev/ready/manifest.json:
npm run desktop:dev:activate
```

Activation refuses if the checkout changed after that build. A failed build
leaves the running mode untouched. An activation error attempts to restore
production; if recovery cannot finish, its root-owned state is retained and the
error explains that `desktop:dev:stop` is required.

## Return to production

Finish work and quit the dev UI/helper first, then:

```sh
cd /Users/tylercaldwell/Downloads/apex-deck
npm run desktop:dev:stop
```

Open your installed Apex Deck normally. Stop is also the recovery command after
an interrupted switch. It restores the original pins and production service,
including the service's original disabled setting. It never restores an older
copy of your thread data or authority journal. Changes made in dev remain.

```sh
npm run desktop:dev:status
```

Status requires no administrator access and reports observed service PIDs and a
protected-read check. It does not consider a listening but degraded daemon
healthy. After a reboot, the enabled dev user LaunchAgent resumes; production
remains disabled until stop restores it. If neither starts, run stop to recover.

## Boundaries

- Your real data is live: posting, editing and deleting have real effects.
  Switching back is a code/service rollback, not a data rollback. Test
  incompatible data-schema changes in isolation instead.
- Primary trust pins are machine-wide. Other-account apps/daemons and standalone
  CLI sessions must finish before switching. Standalone pins are preserved.
- Activity checks include API turns, assistant events/tasks, runners, terminal
  sessions and daemon child processes. They are checks immediately before the
  switch, not an atomic admission lock against other clients sending new work.
- A registered CLI session may remain alive after its turn finishes, along with
  persistent MCP servers. These idle process groups are allowed only when the
  daemon reports their thread idle, PID birth/UID/group match the saved worker
  ownership, descendants stay inside that group, and the thread is still idle
  on an immediate recheck. Unidentified processes and active work still block.
- Some older daemons cannot return a large thread's activity because its full
  history exceeds the response limit. Unknown activity never counts as idle:
  interactive activation identifies those threads and requires you to type
  `idle` after checking them. Noninteractive activation refuses that condition.
- The native computer-use helper is reused from production and its signature
  is recorded in the manifest. This workflow tests new UI/daemon/CLI code;
  helper-source changes require the dedicated native build workflow.
- The broker binary, signing keys, journal, receipts, ownership locks, production
  app, browser profiles, and phone pairing identities are not replaced/reset.
  Do not run the old `repin-provenance.sh` for development; it recreates authority.
- While dev is active, quit before opening another production copy. Do not
  install a production update during dev mode. Stop refuses stale trust
  restoration if another operation changed the pins or production signatures.
- Build outputs use the ignored `staging/trusted-dev` directory: one ready app,
  one temporary build, and local logs. The protected `TrustedDev` slot contains
  one active app and recovery state. No release cleanup touches unrelated files.

If a build process is forcibly killed, `staging/trusted-dev/build.lock` can remain.
Read its PID and confirm that build process is gone before removing that exact
lock and rebuilding. Never delete authority files to work around a dev error.
