# Unified Computer Use

Unified Computer Use lets Deck bots read and control granted Mac applications through one bundled, signed helper. It uses your existing model connections; there is no separate agent desktop or model subscription to install.

## Setup

1. Open **Settings → Unified Computer Use** and enable it.
2. Choose **Open Unified Computer Use**. Grant that exact helper Accessibility and Input Monitoring in macOS when requested. Screenshots also need Screen Recording. macOS may require quitting and reopening the helper after a grant.
3. Use an API, Claude Code or Codex bot with tools enabled in a Work thread. Ask it to use `apex-computer`, request an app by its bundle identifier, read the screen, and act on a fresh observation. Approve the requested app in the helper's native dialog. For a first task: “Open TextEdit, create a new document and type Hello Tyler. Do not save it.”
4. There is no per-bot switch: every supported bot in a Work thread can ask for these tools, including API, Claude, Codex and Muse bots. For an API model that accepts images, open the bot's settings, then Advanced, and turn on **This model can read images** so it receives screenshots. This setting describes the model; it grants no access. A bot without confirmed image support shows a notice in its work steps when it uses these tools, and carries on with accessibility text.

## App access

The helper asks before a bot first uses an app. **Allow Once** ends with that bot's turn. **Allow for This Work Thread** lets every supported bot in that thread use the app, including on follow-up turns, with no more prompts. It is held in memory for that thread only, and the app's identity is rechecked on every request and action. A read-only approval does not cover a turn that can control the app. Stop, revoking access (including removing a bot, changing its access, turning on Plan, closing the thread or turning the feature off) and restarting Deck's service or the helper all clear it.

The helper ships inside `Apex Deck.app/Contents/Resources/Unified Computer Use.app`. Approve the copy inside the installed Deck application, rather than an older prototype or a source-tree build. The macOS permission-list name is **Unified Computer Use**. Changing from the earlier Spike app requires new grants; the old app's grants do not establish permission for this one.

## Untethered computer use

For a bot you trust, open its settings and turn on **Untethered computer use**. It needs Full access and asks you to confirm once. An untethered bot:

- opens and controls any Mac app without the helper's per-app approval card, in every Work thread it joins;
- can send Cmd and Control shortcuts: the helper brings the app to the front first. Quit (Cmd-Q and variants) and Force Quit stay blocked.

These still apply: protected apps (System Settings, Keychain, Passwords, sign-in and security windows), password fields, app identity checks, Stop (Deck and the menu bar), Plan staying read-only, and macOS's own Accessibility and Screen Recording permissions. Lowering the bot's access or turning the switch off ends the current authority at once. Personal assistants keep their own Full-trust setting.

Every bot also benefits from two reliability changes: a call that arrives while another bot's action is running now waits up to eight seconds instead of failing with `action_busy`, and a screen reading that is too large is cut at a line boundary instead of failing with `engine_output_too_large`.

## Request it with !

In a Work thread, type `!` and select **Unified Computer Use**, or send
`!unified-computer-use Open TextEdit and type hello.` The existing tool picker
adds the token for you. This requests the bundled desktop tools from the addressed
bot; it does not enable the feature, clear Stop or grant app permissions. If the
feature is off or stopped, Deck explains which setting to change before sending.
The older `!apex-computer` spelling is also recognized.

## Models and apps

The native engine is model-neutral. API models need reliable tool calling, and screenshot use needs image input. Claude Code and Codex receive the same tool server through their existing Deck adapters. Gemini, Grok and custom CLI bots do not receive the native capability in this release. Talk-only Chat rooms and personal-assistant text-only inference also do not receive it.

`apex-computer` and `apex_computer` are reserved server names. An existing HTTP MCP server with either name can prevent Codex from starting; rename that external server if Codex reports a transport conflict. Deck does not fall back to trusting that server.

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
