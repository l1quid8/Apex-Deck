# VPS automatic release updates implementation plan

> **For agentic workers:** implement the independent compatibility and maintenance
> pieces in parallel; root implements the updater and installation. Use focused
> tests before implementation and an independent final review.

**Goal:** Enable safe published-release updates on the existing VPS.

**Architecture:** A root-owned Python/systemd updater builds tagged source under
the daemon user, verifies carried compatibility and maintenance behavior, and
performs a journaled executable replacement with health checks and rollback.

**Tech stack:** Python standard library, Rust/Tokio, Git, systemd.

**Spec:** `docs/superpowers/specs/2026-10-29-vps-auto-update-design.md`.

## Constraints and review focus

- Preserve unrelated checkout files and deployed Allow behavior.
- No stable-version downgrade, prerelease, missing tag or empty test filter.
- Busy, unknown state, or maintenance-admission races must defer installation.
- Failed startup and process interruption must preserve a recoverable old binary.
- Verify live process identity, not only the executable on disk.

## Tasks

- [x] Compatibility helper and actual Allow/new-thread regression fixture.
  Files: `scripts/vps_update_compat.py`, `scripts/vps-update-allow-test.rs`,
  `tests/test_vps_update_compat.py`. Test known source shapes and refusal/idempotence.
- [x] Maintenance gate with focused concurrency/idle tests and carried release patch.
  Files: host maintenance module and limited admission hooks; release patch asset.
- [x] Updater with injectable system adapter, systemd units and operating notes.
  Files: `scripts/vps_update.py`, `tests/test_vps_update.py`,
  `packaging/systemd/apex-deck-update@.{service,timer}`, `docs/daemon-ubuntu.md`.
  Test version floors, busy deferral, failed build/compatibility, rollback and recovery.
- [x] Independent review, focused Linux checks, TypeScript check, install and live
  timer/status read-back. Save transaction evidence and report exact running build.

Completed deployment, bootstrap recovery, final review fixes and verification:
`docs/reviews/2026-10-29-vps-auto-update.md` and its linked JSON evidence.
