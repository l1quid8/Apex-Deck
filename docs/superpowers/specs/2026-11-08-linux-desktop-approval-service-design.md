# Linux desktop background approval service

Status: proposal for the user; no service implementation is authorized yet.

## Intent and current milestone

Produce a portable desktop AppImage first, then add an explicitly installed background service that can authorize protected desktop commands. The AppImage includes the production Linux daemon; it does not install a broker, change Linux authorization policy, or make blocked protected commands succeed. Window startup is distinct from chat/approval acceptance.

The current Unix broker authenticates only macOS peers; Linux peers are rejected. A plain systemd user unit would keep a daemon alive but would not supply a protected approval authority. Existing Linux SSH/phone authorization policy must remain unchanged by desktop packaging. The portable milestone can open the UI and connect to the local engine; creating/posting protected chats or changing protected settings remains blocked. It is an evaluation build, not a fully usable local approval client.

## Recommended shape

1. Keep the portable AppImage for trying/opening Deck. Offer a separate, explicit administrator installation for protected features. No automatic elevation on app launch.
2. The installer verifies a publisher-signed release manifest and its hashes before extracting anything privileged. Copy the verified UI and daemon to a versioned root-owned `/opt/apex-deck/<version>/` tree; pin the executable, `app.asar`, preloads, shared runtime files and native libraries. Reject writable paths, escaping symlinks and unexpected files. A self-supplied checksum is not publisher authentication.
3. Run a small root-owned systemd `apex-deck-provenance.service`. Only it owns signing keys and the protected journal, under `/var/lib/apex-deck-provenance/`, with records separated by real desktop UID and canonical host data directory. Its socket lives in a root-owned `/run/apex-deck/` directory. It exposes the existing bounded receipt/journal operations, with no arbitrary shell or file API.
4. Install a root-owned systemd `apex-deck-daemon@.service` template that runs the background engine as the registered desktop user, never root. Use the stable installed daemon path rather than an AppImage mount. Start at login and restart on failure; lingering after logout is a separate explicit option. A root-controlled session activation mechanism and UID registration must be specified before implementation; a writable user service must not be treated as authority.
5. Open the protected installed UI for protected actions. The portable copy must show an installation/repair explanation rather than silently retrying without receipts. Quitting Deck leaves the engine running. Missing/stopped authority fails closed.

All path/unit names above are builder proposals, not prior user decisions. Proposed acceptance targets: Ubuntu 22.04/24.04 with systemd, native x64/ARM64, an ordinary desktop account, and a working Chromium sandbox. These are not claims of completed Linux acceptance. Other distributions need their own acceptance before being advertised.

## Linux identity and security limit

The broker obtains the connecting PID/UID from `SO_PEERCRED`, holds a process reference and validates process generation to avoid PID reuse, then checks the installed executable and immutable application resources against root-owned pins. Validate code/resources and launch constraints at each relevant trust transition; role separation must prevent the daemon from issuing UI receipts. Reject development switches, environment injection and user-writable code paths. Reuse exact-command, data-directory and UID binding, signed responses, durable one-use receipt consumption, and explicit revocation.

This narrows the boundary but does **not** reproduce macOS dynamic code-signature attestation. An unrestricted same-account process can potentially inject into, debug, or automate the trusted UI. `SO_PEERCRED` identifies an account/process, not a human; a pinned executable alone does not prove what code is executing. X11 permits additional UI injection. Root remains outside the threat model.

Recommended product choice: disclose a Linux safety limit comparable to the existing Windows limit before enabling protected local approvals. This requires the user's explicit acceptance of that limitation. If the user instead requires the macOS guarantee against unrestricted same-UID workers, stop this design here and design a separate worker-identity/MAC-policy boundary; do not claim that root-owned files or a systemd unit solve it. Existing below-Full bubblewrap confinement remains required and is not weakened.

## Lifecycle and recovery

- Installation registers the UID explicitly, preserves existing data and keys, and refuses unsafe legacy authority imports. Ordinary Linux host data is not automatically promoted to trusted approval history.
- Updates stage a separately verified version, atomically switch the protected installation, refresh pins and restart the daemon. Old pins are revoked; outstanding receipts cannot cross the version change. Keep a verified rollback version without rolling back consumed receipts or revocations.
- Uninstall stops/disables units and removes executable/service files. Keep authority records unless the user explicitly requests their deletion. Never reset trust to repair an installation.
- No AppImage auto-update claim in this milestone. A future updater must use the same verified installer transaction; it cannot overwrite the protected installation as the desktop user.

## Required acceptance before calling approvals supported

Test a clean install, real desktop UI submission, approval, rejection, restart persistence, crash recovery, logout/login behavior, upgrade and rollback on both architectures. Verify exact UID/data-folder separation and replay rejection after restart. From a same-UID script, reject direct socket issuance, substituted executables, modified ASAR/preload, debug/override launches, forged JSON and stale receipts. Test revoked grants, missing broker, wrong installed version, unsafe permissions and replacement races. Verify Mac/Windows authorization remains unchanged and Linux SSH/phone routes retain their existing policy. Record the remaining same-account injection/UI-automation limitation explicitly even when these checks pass.

## Decision requested after the packaging milestone

Approve the explicit protected installer plus systemd broker/engine design **with the disclosed Linux same-account limitation**, or require stronger isolated worker identities before local approvals are enabled. No background approval code is included in the AppImage packaging change.

Before service implementation, the follow-on implementation plan must settle three concrete details: (1) derive registered UIDs from kernel credentials, isolate concurrent users, and specify login activation plus logout/linger behavior; (2) define the independently verified installer bootstrap and publisher key provisioning/rotation, without trusting a manifest's own supplied key; (3) define a crash-safe update transaction that rejects old live UI processes and mixed broker/daemon versions while preserving journal monotonicity. Approval of this proposal authorizes that planning; these details must be made reviewable before service code is written.

References: [existing provenance boundary](../../security/provenance-boundary.md), [Linux confinement design](2026-10-30-linux-bot-confinement-design.md), [Linux socket peer credentials](https://man7.org/linux/man-pages/man7/unix.7.html), [electron-builder AppImage behavior](https://www.electron.build/v26/docs/appimage/).
