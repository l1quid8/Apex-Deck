# Windows 11 desktop parity

Status: audited design for review; existing-branch integration in progress.
Reference: Mac desktop on main `daa6522d` (0.9.9), compared with Windows
`87c6b7fd` (0.9.7). Recheck these refs before packaging or acceptance.

## Intent

The user requested all current Mac desktop features, UI and UX on Windows 11.
Use the existing Mac screens and interactions as the reference. Keep one shared
renderer. Windows should receive current features without a second UI that
drifts behind main. Existing Windows reliability fixes must survive the update.

An installer build, a passing test suite, and an installed end-to-end result are
separate milestones. Do not describe the shared-UI catch-up as full parity.

## Confirmed baseline

- Main and the latest Windows installer source diverged: 339 main-only commits
  and 14 Windows-only commits at inspection. The latter include automatic
  updates, startup recovery, launcher quoting and gateway usage telemetry.
- Current Mac UI includes adaptive thread panes, routed multi-thread composer,
  appearance settings, browser, assistants, projects, settings and popouts. Those
  renderer components are shared; they need Windows acceptance, not a redesign.
- Windows already has a LocalSystem approval broker, per-user named pipes,
  protected journals, process Jobs, daemon logon task and remote phone pairing.
- Windows's existing automatic updater is on the Windows branch, absent from
  main. Preserve its protected transaction and signature checks.
- Windows calls are hidden by platform gates. GPT-Live already has a
  helper-independent path, but Local and Meta use the speech helper. Desktop
  local speech currently supports Apple Silicon; the daemon also has a Linux
  CPU implementation. There is no Windows speech manifest/runtime.
- Native computer use is a signed Swift Mac app with a Mac-only engine adapter
  and Unix transport. A copied `.app` is not a Windows implementation.
- Talk-only/all-agent workflows and some gateway CLI providers require an OS
  isolation boundary that is not implemented on Windows. Ordinary Work bot
  execution does not prove these workflows work.
- Generated interfaces are intentionally enabled only for the verified Mac
  ARM64 Electron/Chromium build. Windows currently receives the plain fallback.
- Standalone CLI distribution is Mac ARM64 only; Windows packages omit apex.exe.
- API-key storage falls back to a private JSON file outside macOS; it does not
  currently provide Windows-native credential storage.
- The Phone simulator requires Xcode/simctl on a Mac. This is separate from
  pairing an iPhone with the Windows daemon.

## Scope and observable results

### 1. Integrate the current UI and preserve Windows behavior

Merge the existing Windows updater/startup work into an isolated branch based on
current main. Preserve the latest composer/access controls alongside telemetry.
Repair confirmed integration failures and establish deterministic Windows UI
fixtures. Require type-checking and actual Windows checks before integration.

The installed candidate must preserve chats, drafts, settings and credentials
through upgrade; show the latest panes/composer/themes; run approved Work chat
actions; stop owned processes; and reconnect after a cold relaunch. Test native
window resize, Snap, scaling, menus, keyboard focus and file paths on Windows.

### 2. Finish shell and capability parity

Use Windows File/Help equivalents for Settings, About, Updates and Quit. Replace
user-facing local-host names such as "This Mac" with the correct platform label,
without renaming saved host IDs or wire fields. Determine capability from the
selected host and call engine rather than the viewer's OS alone. A restored
unsupported tool must select a visible fallback instead of leaving an empty body.

Use the Mac UI unchanged for supported capabilities. Do not reveal controls
until their real backend works. Remote Mac simulator access should depend on
the selected host's simulator capability; Windows must not promise a local
Apple simulator. Keep local iPhone simulation on a connected Mac host.

### 3. Calls and speech

Restore helper-independent GPT-Live calling first, using existing explicit
provider/account selection and call privacy behavior. A cloud call must never
silently replace a selected local call.

Port the existing CPU speech path for Windows x64 with a pinned, hash-verified
runtime, dependencies and model manifest. Keep downloads/install separate from
calls. Preserve existing STT, TTS, turn detection, samples, voice choices,
interrupt/Stop, transcript routing, assistant calls and mute state. Test
microphone denial, device changes, suspend/resume and shutdown. Explicitly
report unsupported voice/engine combinations; do not silently substitute voices.
GPU acceleration is optional follow-up, not a prerequisite for functional CPU
parity. Windows-hosted phone voice uses the same runtime after desktop proof.

### 4. Protected agent workflows

Implement and verify a Windows process/isolation boundary for all supported
tool-free Chat, assistant, curator and gateway CLI turns. Reuse existing broker
identity, signed approvals and Job ownership. Preserve provider/model and usage
semantics. Do not remove fail-closed checks to make a provider appear supported.

Before enabling a provider, demonstrate that an untrusted child cannot mutate
Deck state, obtain protected approval secrets, approve its own action, or escape
the promised file/network restrictions. The exact Windows sandbox mechanism and
CLI compatibility are implementation decisions to settle with an isolated
technical spike and adversarial checks. If no mechanism meets the contract,
report the unsupported combination and the failing evidence.

### 5. Windows Unified Computer Use

Implement a Windows-native helper with UI Automation for semantic access and
Windows screenshot/input primitives. Reuse the existing tool schemas, turn
registry, per-app grants, snapshot-bound actions, foreground-input requirements,
privacy exclusions, Stop/revocation and browser relay semantics.

Use authenticated per-user named-pipe transport and a protected installed helper
whose provenance is checked before launch and before issuing grants. Bind app
identity to executable/process identity and lifetime, not only its window title
or PID. Keep the helper in the logged-in user's session. Do not grant an
elevated UI-control bypass for ordinary calls. Handle multi-monitor coordinates,
mixed DPI, minimized/locked desktops and secure-desktop rejection explicitly.

The existing Windows same-account limitation remains disclosed until evidence
supports a narrower statement. Do not claim equivalent Mac security guarantees
merely because the Windows service is elevated.

### 6. Generated interface acceptance

Run the existing generated-interface lifecycle, authority, privacy and network
acceptance against the exact packaged Windows Electron/Chromium/architecture.
Adapt instrumentation to Windows and prove its positive controls work before
accepting blocked-network results. Add a Windows runtime allowlist entry only
after that evidence passes. Preserve the existing text fallback until then.

### 7. Distribution and secrets

Build and bundle apex.exe, provide a Windows launcher/PATH setup and provider
sign-in handoff, and test it without a Unix shell assumption. Use Windows-native
credential protection with migration that preserves existing keys and retains
recoverable data until a successful native write/read-back.

Keep the Windows updater already implemented. Validate signature/hash/version
rejection, install, service recovery and interrupted-update behavior. Existing
Azure trusted refs stay unchanged during candidate development; unsigned
candidates remain manual-install builds with automatic updates disabled. A
signed production release requires the trusted signing path to succeed and a
Windows installed acceptance run; publication and merging are separate actions.

Ship/test x64 first, matching the existing installer. Add native Windows ARM64
artifacts only after their dependencies and native helpers pass the same gates.
Running the x64 build under ARM emulation is compatibility evidence, not native
ARM64 acceptance. Record that distinction in receipts.

## Verification and release gates

1. npx tsc --noEmit; meaningful focused regressions; complete Node suite.
2. Windows Rust checks/tests, installer clean-install/upgrade, authority and
   standard-user rejection tests. Keep Mac/Linux results separately visible.
3. An installed Windows 11 x64 checklist covering every surface above, including
   fresh protected chat approvals, rejection/replay/revocation and cold relaunch.
4. All-agent Chat and gateway cases, voice local/cloud/cancel paths, browser and
   native UCU, remote pairing, CLI, generated cards and updater rejection paths.
5. Capture build commit, version, architecture, installer checksum, signing
   identity, service identity and installed cold-relaunch provenance.

Current main has known failing Windows UI fixtures and a Windows test caller
that missed run_command's data-directory argument; Linux attach fixtures and a
Mac mobile-bridge constructor test also fail. Establish the baseline, repair
affected fixtures without weakening production authorization, and report any
remaining failures explicitly. A green installer job alone cannot close parity.

## Constraints and builder decisions

- Preserve other agents' dirty work. Develop in the existing sibling worktree
  convention on feat/windows-desktop-parity; no branch switch in shared checkout.
- Obey AGENTS.md build locations. Build Windows installers on Windows CI. Do not
  start a development app or a DMG build from this worktree.
- Keep the current Mac design as the visual reference. No new appearance system,
  unrelated refactor, or forced reset of existing Windows user data.
- The user requested parity, not a security relaxation or silent cloud migration.
- The builder chooses the Windows backend libraries after dependency/license
  verification and compatibility spikes; preserve the observable contracts above.
- Do not request passwords in chat. If Windows login/admin input is needed for
  installed acceptance, hand that step to the user through the native UI.

The implementation should proceed in the sequence above with bounded checkpoints.
Each checkpoint must distinguish integrated source, automated verification,
installer availability, and observed installed behavior. Remaining native ports
require review of this design before new product architecture is implemented.
