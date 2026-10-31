# Unified Computer Use

Unified Computer Use lets Deck bots read and control granted Mac applications through one bundled, signed helper. It uses your existing model connections; there is no separate agent desktop or model subscription to install.

## Setup

1. Open **Settings → Unified Computer Use** and enable it.
2. Choose **Open Unified Computer Use**. Grant that exact helper Accessibility and Input Monitoring in macOS when requested. Screenshots also need Screen Recording. macOS may require quitting and reopening the helper after a grant.
3. Use an API, Claude Code or Codex bot with tools enabled. Ask it to use `apex-computer`, request an app by its bundle identifier, read the screen, and act on a fresh observation. Approve the requested app in the helper's native dialog.
4. For an API vision model, open the bot's settings and enable **Unified Computer Use: this model can read screenshots**. Leave it off for text-only models.

The helper ships inside `Apex Deck.app/Contents/Resources/Unified Computer Use.app`. Approve the copy inside the installed Deck application, rather than an older prototype or a source-tree build. The macOS permission-list name is **Unified Computer Use**. Changing from the earlier Spike app requires new grants; the old app's grants do not establish permission for this one.

## Models and apps

The native engine is model-neutral. API models need reliable tool calling, and screenshot use needs image input. Claude Code and Codex receive the same tool server through their existing Deck adapters. Other CLI providers have not been validated for this connection.

Text-only notice: **This model can’t read screenshots and relies on accessibility text. Some controls may be missing or interpreted incorrectly, making computer use less reliable.**

App coverage depends on the application's accessibility support. A successful package or unit test does not establish that every app or model works. Screenshots are bounded, in-memory captures of the granted app's selected window, not continuous screen recording.

## Permissions and Stop

Reading requires an app grant too. Read-only and Plan turns cannot open, focus or mutate an app. Control permissions belong to the bot's current host-authorized turn; an old background worker cannot reuse its token in a later turn. A disconnected or ended turn loses its capability.

Only one bot controls the desktop at a time. Actions use observations tied to the app and retained native controls. If the screen changes or you use the keyboard or mouse, the bot must observe again. A refusal does not return screen content.

Use **Stop** in Deck's Unified Computer Use settings, the normal thread Stop button, or the helper's independent menu bar control. Stop blocks reads as well as input and invalidates the affected turn. After a global Stop, choose **Resume** in settings before sending a new message. System permission/security applications, password fields and the controller's own surfaces are protected. This is not a sandbox against an unrestricted shell running as your macOS user.

## Privacy

The helper builds observations and screenshots in memory. It does not use upstream's disk-backed refmaps, screenshot temporary files or clipboard helpers. Deck redacts computer tool arguments/results from its work feed, approval details and provider diagnostics.

App content is still sent to the model you chose, including its cloud provider. Claude/Codex transcripts and the model's own replies may retain or repeat content. Grant only the apps appropriate to the task.

## Dependency and optional decisions helper

The embedded Agent Desktop core/macOS engine is pinned at `5261b5287b5208e7c4bf3713df6f66faaaf2c4cc`. Its Apache-2.0 license and provenance ship inside the helper. Deck retains its own capture, permissions, turn isolation, privacy and cancellation controls. See `computer-helper/engine/PROVENANCE.md` for adaptations.

Upstream JEV/CLEF decision automation is optional and is not enabled in this release. Its `scripts/jev/policy.mjs` accepts `TYPESAFE_BASE_URL` and `TYPESAFE_MODEL`, but sends a structured decisions protocol. A generic OpenAI-compatible chat endpoint does not imply compatibility. The normal Deck tools require no extra decisions connector or credentials.

## Release verification

The release handoff records the exact commit, DMG hash, signature results, focused checks and any native behaviors not exercised on the final packaged helper. The DMG includes the app and a native upgrade installer. Use the included installer to update the protected application, backend and provenance service together; dragging only the app does not update an existing protected service. Installing or replacing the running Deck is a separate human action; packaging does not alter it.
