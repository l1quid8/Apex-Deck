# Generated UI card (design)

Status: draft, not built. Follows Interactive answers M1 (`comparison` card only).

## Goal

Let a bot answer with a small interactive interface it writes itself (calculator, chart, explorer), instead of only the fixed comparison table. The model-written code must not be able to reach the network or any Deck data.

## Non-goals

- No access to Deck state, files, rooms, keys, clipboard, or other bots.
- No network, including fonts, images, and analytics.
- No saved state in M1 of this card (no `answers.json` entry). Each render starts fresh.
- No phone rendering in v1. The phone shows the text fallback.

## Card shape

A new `kind: "generated"` next to `comparison`, inside the same `apex-ui` fence and the same `cardId` versioning.

```json
{"schemaVersion":1,"kind":"generated","cardId":"loan-calc","title":"Loan calculator",
 "summary":"Monthly payment for a fixed-rate loan.",
 "html":"<div id=app>...</div>","css":"...","js":"...",
 "fallback":"Payment = P*r/(1-(1+r)^-n). Example: ..."}
```

- `summary` and `fallback` are required plain text. They are what the phone, exports, search, and failed renders show.
- `html`, `css`, `js` are strings with a size cap (proposed 64 KB total).
- Schema validation stays strict: unknown keys are rejected, as in `src/interactiveAnswers/schema.ts`.

## Sandbox

The card renders in an `<iframe sandbox="allow-scripts">`.

- **No `allow-same-origin`.** The frame gets an opaque origin, so it can't read Deck's DOM, `localStorage`, cookies, or IPC bridge.
- **No other allow-flags.** That blocks forms, popups, top navigation, downloads, pointer lock, and modals.
- **Delivered with `srcdoc`**, built by Deck from the three strings. No URL is loaded, so there's no server to attack.
- **CSP inside the document**, injected by Deck as the first tag in `<head>` (model HTML can't precede it):
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`
  - `connect-src 'none'` blocks fetch, XHR, WebSocket, and beacons.
  - `img-src data:` blocks image-URL exfiltration (`new Image().src = ...`).
  - `'unsafe-inline'` is needed because the model's script is inline. That is acceptable only because the frame is isolated.
- **Electron side.** The window that hosts chat must not expose `window.electron` or similar to a frame with an opaque origin. Check that `contextIsolation` is on and that preload APIs are not injected into sub-frames (`nodeIntegrationInSubFrames: false`). Deny `will-navigate` and `setWindowOpenHandler` for the frame.
- **Session level backstop.** A `webRequest` filter on the iframe's session partition cancels any request that isn't `data:` or `about:srcdoc`. This is a second line in case the CSP is bypassed.
- **Resource limits.** Fixed height cap with internal scrolling, and a watchdog: if the frame doesn't send `ready` within 2 s, or stops answering a heartbeat for 5 s, Deck removes it and shows the fallback. Infinite loops freeze only that frame's process if it's out-of-process; verify with a test (see Risks).

## Messaging

One narrow channel: `postMessage` between the frame and a Deck wrapper, with `event.source` checked against the known frame.

| Direction | Message | Purpose |
|---|---|---|
| frame → Deck | `ready` | stop the load watchdog |
| frame → Deck | `resize {height}` | clamp to the cap, then apply |
| frame → Deck | `discuss {text}` | optional: put text in the message box, never send |
| Deck → frame | `theme {tokens}` | light/dark colors only |

Anything else is dropped. `discuss` text is capped, treated as untrusted plain text, and reaches the box only after the user clicks a Deck-drawn button, not from frame code on its own.

## Lifecycle

1. While streaming: "Preparing interactive answer…" as for comparison cards. Never run a half-received card.
2. On complete: validate, then show a Deck-drawn **"Run this interface"** control the first time per card. Auto-run can follow once the sandbox has soaked. This keeps a human in the loop for code they didn't write.
3. Revision under the same `cardId` replaces the live frame with version N+1. Old versions render as static fallback text, not live code.
4. Export (Markdown, PDF): `title`, `summary`, `fallback` only. JSON export keeps the reply as written.

## Bot instructions

Extend the card guidance so bots know the rules: single self-contained document, no external URLs, no `fetch`, `summary` and `fallback` always filled, keep it under the cap. The rules are advice; the sandbox is what enforces them.

## Tests

- Schema: oversize, unknown keys, missing `fallback`.
- Escape attempts, each run in a real frame and expected to fail: `fetch`, `XMLHttpRequest`, `WebSocket`, `new Image().src`, `<link href>`, `<meta http-equiv=refresh>`, `window.top.location`, `window.parent.document`, `window.open`, form submit, `import()`.
- Electron: frame has no preload globals; navigation and popups denied.
- Watchdog: `while(true){}` and a script that never calls `ready` both end in the fallback.
- Streaming: a partial card never mounts a frame.

## Risks and open questions

- **CSP is not an exfiltration proof by itself.** Known gaps include DNS prefetch and some navigation tricks in older engines. The `webRequest` backstop and the opaque origin cover these, but we should test on the shipped Electron version, not assume.
- **Process isolation.** If the frame shares a renderer process with chat, a CPU loop may freeze Deck. Options: Chromium out-of-process iframes (site isolation for `srcdoc` opaque origins is not guaranteed), or an Electron `<webview>`/`WebContentsView` with its own partition. Decide before building.
- **Prompt injection.** A card is model output and can be steered by hostile content in the thread. The sandbox limits damage to a misleading display; that is why the run control and the no-state rule matter.
- **Phone.** A WKWebView sandbox has different guarantees. Keep v1 desktop-only.
- **Saved state.** If a later version stores user input in `answers.json`, that data comes from model code, so it needs its own schema and size limits.

## Rollout

1. Schema and validator, with the text fallback path (ships invisible).
2. Sandboxed frame, wrapper, watchdog, and the escape tests.
3. Bot instructions and a "Run this interface" gate.
4. Human review of the escape tests before any bot is told about the card.
