# VPS automatic release updates

The VPS should follow published stable Apex Deck releases without interrupting
bots, losing Allow/new-thread support, or replacing a newer build with an older
one. The user authorized implementation and enabling the updater on this VPS.

Use a root-owned systemd timer and Python updater. There are currently no Linux
release downloads, so fetch the exact published Git tag over HTTPS and build it
as the service user in an independent build directory. Never follow `main`.
Strictly compare numeric stable versions against both the running daemon and a
root-owned successful-install high-water mark. Keep source commit, compatibility
patch hashes, executable SHA-256 and transaction results as evidence.

Carry the existing deployed Linux room-action compatibility change into staged
release source, with bounded transformations that refuse unknown source shapes.
Run an actual isolated public-command test for new threads, Allow, Always allow,
and the retained paired-phone/assistant receipt gates. This retains the existing
workaround; it does not resolve its previously identified same-user trust gap.

Add a daemon maintenance gate so no new work can overtake an idle update. Idle
checks include in-flight command/provider work, turn chains, pending reservations,
assistants, scheduler jobs, runners and terminals. Busy or unknown means defer.
The updater must release maintenance if any pre-install step fails.

Before installation retain the old executable. Replace atomically, restart the
systemd unit and verify the live protocol build identity, boot change and running
executable hash. Failed health checks restore the backup and restart it. Keep a
root-owned recovery journal so an interrupted transaction recovers before any new
update. Leave the existing pre-hotfix backup untouched.

Check every 30 minutes, retry busy candidates on the next timer tick, and log
skips/errors to journald and a root-owned JSON status file. No desktop packaging
or full Rust-suite rerun is in scope. Run focused updater/compatibility/maintenance
tests and the repository-required `npx tsc --noEmit`.
