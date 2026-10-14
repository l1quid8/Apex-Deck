# Generated UI card (design)

Status: implemented for review on `feat/generated-ui-cards`; see [verification handoff](../reviews/2026-10-14-generated-ui-cards.md). Extends Interactive answers M1 with `kind: "generated"`. Execution and generated-card bot guidance stay disabled until the release gates below pass.

## Goal and boundary

Reuse OpenIntelligentUI's renderer and generation prompts to let Deck's existing bots answer with a purpose-built calculator, chart, explorer, or flowchart. Keep Threads, the `apex-ui` envelope, and existing comparison cards. Local controls compute inside the card without another model call.

Generated code gets only its own answer payload, public theme tokens, and values the person enters into it. It cannot query Deck's rooms, DOM, storage, files, clipboard, keys, daemon, or bots, and cannot initiate network traffic, including loopback, DNS, WebRTC, fonts, images, and analytics. This is a browser sandbox boundary, not protection against a Chromium exploit. No credentials or file-upload controls; no generated state persistence or `answers.json` entries. The iPhone and browser-only clients show text in v1.

## Reuse, pinned and adapted

Vendor a narrow subset of [CopilotKit/OpenIntelligentUI][upstream] at **`8391a94c1c3939c679e40ddd7bfc08a9ef690e70`** (reviewed 2026-10-14), with a source-path manifest and notes describing Deck's changes. Implementers must reuse these pieces rather than recreate their presentation and generation logic:

| Upstream source | Reuse in Deck | Required adaptation |
|---|---|---|
| [Renderer][renderer], `apps/app/src/components/generative-ui/open-generative-ui/renderer.tsx` | Lifecycle, resize validation/clamping, HTML-before-behavior execution | Replace CopilotKit hooks and Websandbox calls with Deck's isolated host; mount only a completed, approved card. |
| [Frame content][frame], adjacent `frame-content.ts` | `buildFinalFrameContent` document composition and `MEASUREMENT_JS` resize reporting | Replace CSP, remove importmap and trip/map script, and put the measurement bridge behind Deck's validated protocol. |
| [Design system][theme], `packages/design-system/src/index.ts` | Local theme variables, SVG and form styles | Adapt to Deck tokens; include only audited CSS with no URL imports. |
| [System prompt][prompt], `apps/agent/src/prompt.py`; [master playbook][playbook], [advanced visualization][advanced], [SVG diagrams][svg] | Task-based choice of presentation, working controls, diagram layout, truthful data and accessible output | Convert tool/streaming instructions to the completed Deck envelope. Remove Jev/A2UI routing, CDN/library imports, live maps/photos, and automatic follow-up sending. |

Their [streaming schema][upstream-schema] is an adaptation reference, not Deck's wire contract. Deck uses body-fragment `html`, `css`, and a single `js` string; execute `js` once after markup and styles mount, combining upstream's function-declaration and invocation phases. An empty `js` supports static SVG diagrams. No partial HTML preview, Idiomorph, runtime `eval`, Websandbox dependency, executable HTML export, or upstream `sendPrompt`/`openLink` bridge in v1. Use built-in HTML, SVG, canvas, and browser JavaScript; later libraries require a separate local-bundle design.

Upstream currently permits CDNs and external images in its final CSP; its preview shell does not have that final CSP. Its presentation cleanup is not a security sanitizer, and its follow-up bridge can send a user turn. None of those behaviors establishes Deck's boundary. [Sources: frame builder][frame], [host functions][upstream-bridge], [follow-up bridge][prompt-bridge].

Preserve the full [MIT license][license], including the Atai Barkai copyright and permission notice, beside copied code and prompt text and in packaged third-party notices. Track licenses of any copied dependencies separately. This reuse does not require their Next.js app, Python agent, hosted router, or MCP service.

## Card contract and compatibility

A single completed `apex-ui` fence contains this discriminated union member:

```json
{"schemaVersion":1,"kind":"generated","cardId":"counter","title":"Counter","summary":"Adjust a count locally.","html":"<label>Count <output id=\"count\">0</output></label><button id=\"add\">Add one</button><button id=\"reset\">Reset</button>","css":"button { margin: 0.5rem; }","js":"let n = 0; const out = document.getElementById('count'); document.getElementById('add').onclick = () => { out.textContent = String(++n); }; document.getElementById('reset').onclick = () => { n = 0; out.textContent = '0'; };","fallback":"Starts at zero. Add one increments the count; Reset returns it to zero. Changes last only while this interface is running."}
```

All nine keys are required; generated cards reject every unknown key and wrong type. `cardId` uses the existing 1–40 character ID rule; title is 1–80 characters, summary 1–280, fallback 1–4,000 (nonblank, rendered as plain text). `html` is a nonblank body fragment; `css` and `js` may be empty. Preserve code strings exactly. Limits are **UTF-8 bytes** unless marked characters: decoded `html` ≤49,152, `css` ≤16,384, `js` ≤32,768, combined code ≤65,536; serialized fence source ≤131,072 bytes **and** ≤131,072 JavaScript UTF-16 code units. Embedded data assets count toward these limits.

Today's `src/interactiveAnswers/schema.ts` ignores unknown fields and rejects sources over **16,000 UTF-16 code units**. Correct that assumption in the implementation: add a bounded outer parse, then dispatch by kind to separate validators. Preserve the comparison validator and its 16,000-character cap; apply the larger cap and strict keys only to generated cards. Extend `CardRead`, `ThreadCard`, `cardVersions`, and `withCardSummaries` by kind; generated cards never enter the comparison evaluator or saved-input store. Validate again in Electron main before creating a host.

Updated phone/search/Markdown/PDF paths show title, summary, and fallback without executing code or printing the JSON; JSON export retains the original reply. Unsupported older clients keep their existing unsupported-card behavior, so the bot's prose must contain the essential answer. Invalid or oversized cards never execute; bounded safe text can accompany the validation reason, otherwise show a generic fallback without parsing oversized input.

## Concrete execution host

Electron main owns **one live generated `WebContentsView` per Deck window**, with a fresh nonpersistent `session.fromPartition("generated-<random-run-id>", {cache:false})` per run. The iframe inherits this host's session; it does not have its own partition. The normal chat renderer never hosts generated code.

The view displays a trusted wrapper with a sandboxed `<iframe sandbox="allow-scripts">`, no other sandbox tokens, no `allow-same-origin`, and a deny-all Permissions Policy for exposed privileged features. Create one fixed bootstrap-only `srcdoc`, verify its process ownership, then send the validated payload through structured messages into that same child document. Its bootstrap mounts body markup and a style node, then executes `js` once through a script node using `textContent`; never replace/navigate `srcdoc` after the check or interpolate model strings into the wrapper. Model markup/styles/scripts execute only inside the opaque-origin child. Deck's Run, Stop, fallback, version, and Discuss controls stay in trusted chat chrome. Main validates native view bounds against the window, the card's visible rectangle, and trusted controls; CSS clipping of a placeholder is insufficient. Hide the view whenever geometry is stale or overlays open, and detach it when offscreen; height is clamped to 200–800 px with internal scrolling.

Set `sandbox:true`, `contextIsolation:true`, `webSecurity:true`; disable Node integration in main frames, subframes and workers, webviews, plugins, WebGL, spellcheck, and DevTools. Use a dedicated tiny wrapper preload with a `process.isMainFrame` guard, no Deck preload or session preload scripts, and no exposed filesystem/daemon/shell API. Its fixed channels accept only known run-bound messages. All existing Deck IPC handlers must reject a generated-host sender, including subframes.

Create bootstrap-only wrapper and child frames first. Before supplying model code, main verifies that the view and every generated child-frame renderer PID are distinct from all other Deck renderer PIDs. Recheck on frame/process changes; unexpected sharing or navigation tears the run down. A separate WebContents/session alone is not a process-isolation proof. [Electron host preferences][preferences], [WebContentsView][view], [renderer termination caveat][termination].

## Network, navigation and permissions

Install all controls before the first load:

- In this session only, intercept `https` with `session.protocol.handle`: serve the exact `https://generated-ui.invalid/<random-run-id>` wrapper from memory as a `Response`; reject every other URL. No local HTTP server, disk resolver, `net.fetch`, or forwarding handler. The session request filter denies everything except that exact wrapper bootstrap and non-network `about:srcdoc`/permitted data image resources. Also put this session in offline emulation as a backstop. [Electron protocol][protocol], [session controls][session].
- The wrapper response carries **`Connection-Allowlist: ()`**, with no redirect/WebRTC opt-in or reporting endpoint, plus `X-DNS-Prefetch-Control: off`. The srcdoc child must inherit the empty connection policy; also set the iframe's `connectionAllowlist="()"`. This is the selected DNS/WebRTC enforcement mechanism. CSP, request filtering, opaque origins, offline emulation, or WebRTC IP-handling settings alone do not cover all network channels. Support in the exact Electron response/iframe path is a required gate, not an assumption. [Chromium connection boundary][connections], [policy inheritance][connection-spec].
- Supply CSP from trusted code before model content. The wrapper response sets `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src about:; child-src about:; worker-src 'none'; object-src 'none'; media-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'`. The fixed child head adds the same policy with `frame-src 'none'; child-src 'none'`. Srcdoc inherits the wrapper policy, so both must permit local inline code/styles and data images; the child's policy can only tighten it. The wrapper contains only trusted bytes. No `unsafe-eval`, remote sources, reporting URLs, or model-selected policy. Model script text goes into a child script node, never a serialized host script; test literal `</script>` payloads.
- Deny `will-frame-navigate`, `will-navigate`, redirects, `setWindowOpenHandler`, webview attachment, and downloads. Only the main-owned bootstrap and known initial srcdoc creation are admitted; do not allow every `about:`/`data:` navigation. Never call Deck's external-browser forwarding handlers or `shell.openExternal` for this host. Verify iframe navigations with `will-frame-navigate`, not just the main-frame event. [Electron navigation events][navigation].
- Explicitly deny permission requests, checks, device grants, media/display capture, clipboard, filesystem pickers, drag/drop files, and external protocols. No user-selected file may enter the generated frame; enforce and test file selection separately from ordinary permission denial. There is no frame API for opening links, reading drafts, sending turns, or choosing a host URL.

The lockfile and installed dependency currently identify **Electron 44.5.1**. Record the actual packaged Electron and Chromium versions in test evidence. If empty Connection-Allowlists, policy inheritance, permission denial, or renderer isolation fail on a build, that build shows fallback and keeps Run and generated-card guidance disabled. Do not silently relax the boundary or apply process-wide networking switches to Deck's normal daemon transport.

## Messages, execution and disposal

Each hop binds `{protocolVersion:1, runId, revisionDigest, type}` to the known wrapper WebContents and frame identity. The wrapper checks `event.source === iframe.contentWindow`; opaque origins use `"null"`, so origin alone is not authentication. Main verifies sender WebContents **and sender frame**, active run, exact keys/types, size, and rate. Drop unknown, stale, wrong-frame, or wrong-run messages; reject transferred ports. Runtime bridge payloads are capped at 8 KiB UTF-8 (the trusted initialization payload uses the card-source cap) and 30 messages/s; coalesce resize to 10/s and stop persistent flooding.

| Direction | Allowed message | Effect |
|---|---|---|
| child → wrapper → main | `ready` | Ends the 2-second initialization deadline after synchronous initialization finishes. |
| main → wrapper → child | `ping {nonce}` | One unpredictable challenge per second, measured by a monotonic main-process clock. |
| child → wrapper → main | `pong {nonce}` | Answers only the current challenge; timeout after 5 seconds without a valid reply. |
| child → wrapper → main | `resize {height}` | Finite numeric height, clamped by trusted code. |
| child → wrapper → main | `discuss {text}` | Stages ≤4,000 characters of untrusted plain text outside the frame. |
| main → wrapper → child | `theme {tokens}` | Fixed allowlist of color values only; no paths, identifiers, URLs, or Deck state. |

A heartbeat proves event-loop liveness, not code safety. A frame cannot click trusted **Discuss**: the person sees the staged text and clicks that Deck control to append it to the draft; Send is still a separate human action. No automatic send or replace-draft capability.

While streaming, show the existing preparing placeholder and create no execution host. **UX revision requested by the human:** the newest complete valid generated bot card opens automatically after its entire slot has stayed visible for 250 ms in the focused, connected desktop chat. Nominate only one card per thread; human/invalid cards and repeated identities in one reply are not automatic candidates. Main independently requires a visible, foreground, non-minimized owner before allocation and again before payload delivery. Bind every admission to window, thread/message/card identity and **SHA-256 of the complete validated payload plus adapter/security-policy version**; never use the existing 32-bit comparison fingerprint or `cardId` alone as execution authority. A changed revision disposes the old host and opens a newly validated host; historical revisions remain text-only. There is no persisted approval or runtime state. A stopped, failed or frozen instance never automatically retries; **Restart** is available explicitly. Older distinct cards offer **Open interface**. Keep fallback in a collapsed **Text version** below the stable viewport, with ordinary text on unsupported clients. Discuss still requires the trusted preview action, and Send remains separate.

The watchdog runs in **Electron main**, not in either renderer. On missing ready/pong, Stop, crash, frame navigation, revision replacement, rewind/fork/move, thread/host/window switch, offscreen unmount, sleep, or quit: invalidate message authority first while retaining process-ownership records, cancel timers/listeners, discard staged text, terminate the view's exclusive renderer processes, close its WebContents without honoring beforeunload, detach the view, revoke the in-memory document, unregister its protocol and request/permission handlers, and clear session storage/connections. Sessions have no destroy API: cap runs at 32 per application lifetime, then show fallback until Deck restarts rather than accumulate partitions indefinitely. Use `forcefullyCrashRenderer()` for the host renderer; a separate runaway child renderer requires explicit termination of its verified exclusive OS PID on macOS. Immediately before each kill, recheck live ownership against every frame in every other WebContents; never kill a shared or stale PID. Ignore late messages, confirm all generated PIDs exited, and show fallback. An explicit Restart starts empty; mounting a new eligible card also creates a fresh validated session. Availability is bounded by the timeout; this is not a hard CPU/memory quota.

## Bot guidance and release gates

Adapt the pinned prompt material into `crates/apex-core/src/view.rs` with fixture-backed examples. Offer generated UI for tasks that benefit from working custom controls or diagrams; retain comparison for numeric option tradeoffs and prose for simple answers. Require a self-contained envelope, useful summary/fallback, exact size limits, local assets, validated inputs, defaults/reset, accessible labels/focus, responsive SVG/layout, reduced motion, and honest sample-data labels. Remove the existing universal ban on code only for supported generated cards. Guidance is not enforcement; enable it only for clients/builds whose generated-runtime capability is verified. Remote Mac/Hetzner bot transport stays existing Deck transport; the daemon never executes the card.

Before Run or bot guidance ships, require review of reproducible tests in the **actual packaged Electron runtime**, with version/PID records and independent network observations:

1. **Contract and compatibility:** unknown/missing keys and types, each field/combined/raw limit including Unicode/JSON escapes, comparison regressions, partial/cancelled streams, revision approvals and SHA binding, phone/browser fallback, search, Markdown/PDF escaping and nonexecution, original JSON export.
2. **Network:** controlled HTTP(S), loopback IPv4/IPv6, literal-IP and external endpoints; fetch/XHR/beacon, WebSocket/WebTransport, dynamic import, CSS URLs/imports, images/fonts, DNS-prefetch/preconnect, SVG references, redirects/navigation, WebRTC STUN/TURN/data channels and workers/nested frames. Observe listener receipts, unique authoritative DNS queries and UDP/TCP traffic; a rejected JavaScript promise or empty Electron request log is insufficient. Include a positive-control fixture proving the capture detects traffic. Test empty-policy inheritance through the exact intercepted-HTTPS wrapper and srcdoc child.
3. **Escape and authority:** parent/top DOM, cookies/storage/IndexedDB, preload/Node/IPC, daemon and Deck custom protocols, files/pickers/drop, clipboard, devices/media, forms/popups/downloads, external-link forwarding and misleading `postMessage`/port floods. No Deck data access, browser launch, file delivery, automatic draft change or send.
4. **Recovery and UX:** `while(true){}` before ready and after ready, promise/microtask loops, allocation pressure and message storms. From trusted Stop and the watchdog, terminate both same-process and out-of-process generated-frame cases, verify PIDs exit and chat/daemon remain usable. Exercise stale-frame callbacks, multiple windows, resize/scroll clipping, overlays, lifecycle disposal, Discuss preview, keyboard/reset, and representative calculator, chart and Intelligent UI flowchart outputs from both Claude and Codex.

Land contract/fallback and the pinned adapter first with execution disabled; then land the isolated host and tests. Enable Run and client-capability-based generation guidance only after all gates pass. Any failed gate or Electron/Chromium upgrade keeps generated execution disabled until it is reverified. These are implementation acceptance criteria; this document update is not evidence that the sandbox has passed them.

[upstream]: https://github.com/CopilotKit/OpenIntelligentUI/tree/8391a94c1c3939c679e40ddd7bfc08a9ef690e70
[renderer]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/renderer.tsx
[frame]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/frame-content.ts
[theme]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/packages/design-system/src/index.ts
[prompt]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/agent/src/prompt.py
[playbook]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/agent/skills/master-playbook/SKILL.md
[advanced]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/agent/skills/advanced-visualization/SKILL.md
[svg]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/agent/skills/svg-diagrams/SKILL.md
[upstream-schema]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/components/generative-ui/open-generative-ui/schema.ts
[upstream-bridge]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/lib/sandbox/sandbox-functions.ts
[prompt-bridge]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/apps/app/src/lib/sandbox/prompt-bridge.tsx
[license]: https://github.com/CopilotKit/OpenIntelligentUI/blob/8391a94c1c3939c679e40ddd7bfc08a9ef690e70/LICENSE
[preferences]: https://www.electronjs.org/docs/latest/api/structures/web-preferences
[view]: https://www.electronjs.org/docs/latest/api/web-contents-view
[termination]: https://www.electronjs.org/docs/latest/api/web-contents#contentsforcefullycrashrenderer
[protocol]: https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler
[session]: https://www.electronjs.org/docs/latest/api/session
[connections]: https://developer.chrome.com/blog/connection-allowlist-announcement
[connection-spec]: https://wicg.github.io/connection-allowlists/
[navigation]: https://www.electronjs.org/docs/latest/api/web-contents#event-will-frame-navigate
