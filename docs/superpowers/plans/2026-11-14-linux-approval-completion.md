# Linux protected approval completion

Continue the approved Linux desktop approval service design. The user's request
authorizes implementation in the existing `linux-appimage` worktree, with no
merge or push. Preserve all existing changes and shared main checkout contents.

## Constraints

- Kernel peer identity and installed paths alone must never grant authority.
- A broker-owned launch must bind its role before the first instruction, monitor
  exec transitions including nonleader thread exec, revoke before the new image
  executes, and kill clients when the monitor dies.
- Verify the complete independently signed installation, exact launch inputs,
  real desktop identity, enrollment scope, active epoch and lifecycle state.
- Explicit administrator enrollment includes same-account disclosure and linger
  consent. Do not infer approval from sudo environment or caller JSON.
- Authenticate discovery and health with a fresh challenge, signed identity,
  scope, manifest and epoch; refuse fallback on installed-service failures.
- Activation remains closed until all these prerequisites are connected.
- Disposable Linux fixtures are permitted; host services and production trust
  are not provisioned by this task. Installed graphical acceptance remains a
  separate evidence requirement.

## Tasks

1. Preserve baseline; implement native trusted launch supervision, exercise exec,
   fork, clone, exit and monitor death, and connect role checks in the broker.
2. Connect administrator enrollment and installed service lifecycle with atomic
   activation and fresh authenticated health. Test interrupted transitions.
3. Connect desktop discovery/handoff to enrolled scope, reject forged or replayed
   identities and preserve portable evaluation when no installation exists.
4. Run native Linux provenance/security fixtures, relevant desktop tests,
   workspace checks and TypeScript, then review the combined change. Report
   exactly which acceptance operations were observed.

## Progress

Baseline hashes recorded outside the source tree in
`cleanup-notes/linux-approvals-20261114/continuation/`. Existing branch is
`feat/linux-appimage`; no branch changes or commits are authorized.
