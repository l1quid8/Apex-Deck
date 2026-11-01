# ADR: Unified Computer Use runs in the background

**Status:** Built on `fix/ucu-background-no-pointer`; see Build outcome. Signed live acceptance is still owed.
**Date:** 2026-11-01
**Deciders:** Tyler. Review: Muck, who owns the background work.
**Base:** `fix/ucu-activity-gate` `3cc1d53d` (on main `0c444f22`)

## Requirement

Tyler keeps using his own mouse and keyboard while a bot works. This replaces a hands-off foreground test, and replaces fixing the activity guard, as the goal.

These four rules are the test for every tool:

1. A bot never moves Tyler's pointer, changes the frontmost app, or raises a window.
2. No bot input goes through the global event stream.
3. Tyler's input in his own apps never blocks a bot. His input in the target app stops the bot at once.
4. Anything unsupported is refused with a named code. Nothing silently focuses, restores or falls back.

There is one exception, and it has to be disclosed: starting an app that isn't running can bring it forward (see Measurements).

## What takes over today

| Tool | What it does now | Effect on Tyler | Where |
|---|---|---|---|
| `scroll` | Headed wheel: moves the real pointer, then posts to the global HID stream | **Takes the pointer.** Added by `056e99a7` | `engine/src/lib.rs:314`, `mouse_scroll.rs:20-38` |
| `click_point` | Posts mouse events to the session tap | **Takes the pointer** | `Input.swift:260-271` |
| `press_key` | Posts keys to the session tap | Global. A key lands in Tyler's app if he switches apps after the check | `Input.swift:111-112` |
| `request_app` | `activates = true` on every writable call, even if already running | Tries to take focus | `Server.swift:354` |
| `type_text` | Per-process keys, but requires the app in front | Forces foreground | `EngineSession.swift:169-190` |
| `get_screenshot` | Requires frontmost and on-screen | Forces foreground | `Screenshot.swift:59,70,76,109`, `Server.swift:277` |
| Activity guard | Any real key, click or scroll anywhere spoils the reading | Tyler working elsewhere blocks the bot | `Input.swift:25`, `Latch.swift` |
| Cursor overlay | Draws at the target's screen position | Draws over Tyler's window when the target is covered | `EngineCheck.validate`, `Server.swift:296,392` |

`click` is already AX-only and meets the rules.

## Measurements

macOS 27.2, 2026-11-01, on throwaway targets only: a scratch TextEdit file, Chrome for Testing 153 with a throwaway profile, and a small `WKWebView` app. Tyler's Brave and Apex Terminal were not touched. Another app was frontmost throughout.

Each step recorded the frontmost app, pointer and window order before and after. The final Chromium and WebKit runs also sampled the front app every 50 ms and counted real mouse clicks: no front changes, zero clicks. Sample sizes are small, usually one to four runs per cell.

| Operation | AppKit (TextEdit) | Chromium | WebKit |
|---|---|---|---|
| Read the tree, covered window | Yes | Yes, once built; see the limit below | Yes, even with rendering paused |
| AX press | Menu item: see below | Yes, `isTrusted=true` | Yes, `isTrusted=true` |
| Screenshot click: app-scoped hit test, then AX press | Not run | Yes | Yes |
| `AXSelectedText` write | Yes | **Silent no-op:** API says success | **Silent no-op:** API says success |
| `AXValue` write | Settable, not run | Yes, fires a trusted `input` event | Yes, fires a trusted `input` event |
| `AXFocused` in the page | API succeeds | Yes | Yes |
| Scroll by AX | Scrollbar value: yes | `AXScrollToVisible`: yes | `AXScrollToVisible`: yes |
| Plain keys, per process | Yes | **Unreliable: landed 7 of 11** | Yes, 2 of 2 |
| Cmd shortcut, per process | No effect | Not run | Not run |
| Menu command by AX | **Silent no-op:** item reports disabled, API says success | Not run | Not run |
| Wheel, per process or SkyLight | No effect | No effect | Not run |
| Pixel click, per process or SkyLight | No effect | No effect | Not run |
| Screenshot, covered | Fresh | Fresh | Fresh, even with rendering paused |
| Screenshot, minimized | Fresh | **Stale frame** | Not run |
| Screenshot, hidden app | Fresh | Not run | Not run |
| AX write, minimized | Yes | Press and value: yes | Not run |
| AX write, hidden app | Yes | Not run | Not run |
| Plain key, minimized | No effect | Not run | Not run |

Other results:

- **New tab task:** on Chromium, AX press on New Tab, then an `AXValue` write to the address bar, then Return by process navigated the page with another app in front. That is deepgeek's task from `0c444f22`, on the scratch browser.
- **Hit testing:** the system-wide lookup returned Tyler's window, and the app-scoped lookup returned the covered button. A blank page point returned `AXWebArea`, which has nothing to press, so a refusal is possible.
- **Chromium limit:** two windows that Chromium had already marked hidden before their web tree existed showed only the browser's own controls, and no web content. Turning accessibility on did not help. Four fresh windows that were covered from the first frame reported `visible` and worked. A window whose tree was built kept it after minimizing. The exact trigger is not established.
- **Bot events and the guard:** per-process posts never reached the session tap (0 seen), so the bot's own input can't be mistaken for Tyler's.
- **`AXRaise`** did not change stacking from the background.
- **Restoring a minimized window** put it above Tyler's windows without changing the frontmost app. That breaks rule 1, so a bot must never restore.
- **Launching:** `open -g` was quiet for TextEdit, but Chrome took the front anyway.
- **Enabling Chromium accessibility:** `AXEnhancedUserInterface` returned `-25208` and the tree still appeared.

Not measured: real Brave, Electron, Safari web apps, windows on another Space, React-controlled inputs, contenteditable editors, native sheets and file pickers. CUA reports that [Electron pauses accessibility updates when occluded and off-Space SwiftUI windows lose their tree](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md).

An early Chromium run showed pointer, stacking and front changes. The window was partly visible at that point and Tyler appears to have clicked it, so those changes aren't attributed to any tool. SkyLight is not cleared by that run; its steps coincided with the stacking changes.

## Decision

**Run in the same session, with accessibility first and no global input. Background is the only mode.** Physical pointer and session-tap paths are deleted from the helper, not kept as a fallback.

Delivery ladder:

1. **Semantic AX:** read, press, value and selection writes, focus inside the app, scrollbars, `AXScrollToVisible`.
2. **Process-targeted keys:** `CGEventPostToPid` only, reported as `delivered_unverified`, and never retried automatically.
3. **Refuse** with a named code. The model chooses another route or tells Tyler.

A foreground takeover tool can come later as a separate, explicit, approved action. It is not in this work.

### Rejected

| Option | Why |
|---|---|
| Global CG events | Breaks rules 1 and 2 |
| SkyLight `SLEventPostToPid` for clicks | My clicks through it did nothing. Private API. [CUA](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md) needs extra tricks for Chromium, and [a separate report](https://github.com/code-yeongyu/oh-my-openagent/issues/8925) describes background clicks reordering windows |
| Focus without raise | It posts a defocus record to Tyler's frontmost app, so it touches his focus by design. Private API |
| Auto-restore a minimized window | Measured: it covers Tyler's work |
| Treating API success as proof | `AXSelectedText` and disabled menu items both returned success and did nothing |

### Tool contract

| Tool | Background behaviour | Refusal or note |
|---|---|---|
| `request_app` | Never activates a running app. Starts a stopped app with `activates = false` and reports `launch_took_focus` if the front changed | The grant popup says starting an app may bring it forward |
| `read_screen` | No frontmost requirement. Reports `visibility`: frontmost, covered, minimized or hidden | `web_content_unavailable` when a browser window has no web area, never a reading that looks empty |
| `get_screenshot` | Allowed when covered | `minimized_stale_image` for every minimized or hidden window. Nothing tells us which apps keep their frame current, so the text reading is the route there |
| `click` | Unchanged | Refuse `element_disabled`, because a disabled item fails silently |
| `click_point` | App-scoped hit test, then the nearest pressable ancestor in the same window, through the same guarded press path | `pixel_target_has_no_control`; canvas and custom-drawn views end here |
| `type_text` | `AXSelectedText`, read back; if unchanged, compute the new value and write `AXValue`, read back | Secure fields stay refused. `type_verification_failed` |
| `press_key` | `AXConfirm` or `AXCancel` when advertised, else per process | Reply is `delivered_unverified`, read the screen. `shortcut_needs_foreground` for Cmd and Control combos |
| `scroll` | Scrollbars by AX, through the engine's headless path | `scroll_not_supported_use_reveal` |
| `reveal` (new) | `AXScrollToVisible` on a numbered control | The web route for scrolling |

Stop can interrupt between `AXSelectedText` chunks. An `AXValue` write is one atomic call, so Stop can only prevent it, not cut it off partway.

### Human priority

Tyler can only affect the target if his input can reach it, so the guard becomes target-aware. Each latch learns its target process.

| Tyler does this | Effect |
|---|---|
| Types, clicks or scrolls in another app | Nothing. The bot continues |
| Types or clicks while the target is frontmost | Spoils the reading and interrupts a running action, as now |
| Switches to the target or clicks it | `didActivateApplication` counts as input, so the running action stops at its next check |
| Clicks a window of the target without activating it, such as a Cmd-click | Same. The click's window names its owner |
| Scrolls over a covered target without clicking it | Not detected. The live control recheck before every action covers this |

Stop, the turn checks and the "input watcher unavailable" refusal are unchanged. This replaces the earlier rule not to scope activity by app: it relies on the frontmost app for keys and on activation for clicks, not on per-event targets.

The overlay shows only when the target is actually on top at that point. Otherwise Deck's work steps are the record.

## Isolated execution

This is separate from same-session control. It's the only route to a real pointer and keyboard for apps with no usable accessibility data, such as canvas apps, games and drag-heavy tools.

| Option | Isolates Tyler's input? | Cost and limits | Verdict |
|---|---|---|---|
| Another Space or a virtual display | **No.** One pointer, one keyboard focus | Virtual display needs a private API and a display change. Not tested | Not an isolation option |
| Second macOS user on this Mac | Not usefully | Needs a separate session with a usable display. Not tested | No |
| **macOS VM** (Apple Virtualization) | **Yes** | [Two macOS guests at once](https://eclecticlight.co/2026/04/29/virtualisation-on-apple-silicon-macs-is-different/), own disk and memory, own app installs, logins and permissions. Tyler's signed-in sessions aren't there | **Best later option** |
| **Second Mac** | **Yes** | Hardware cost. Deck's machines feature may carry it, but that isn't checked | Best if reliability matters more than cost |
| Linux VM or server | **Yes** | Browsers and Linux apps only, no Mac apps | Web only; Pomerado already covers much of this |

**Recommendation:** don't build this now. In a VM, physical input can't compete with Tyler, so the deleted foreground paths would belong there, in a helper running inside the guest. Decide once the same-session refusal logs show which apps need it.

## What we can promise

- **Works in the background:** browser and web-page buttons, checkboxes and form fields, native text editing, reading text, and screenshots of covered windows.
- **Works but needs checking:** plain keys and Return. Chromium missed 4 of 11 here.
- **Doesn't work in the background:** pixel clicks with no accessible control under them, including canvas and custom-drawn surfaces, wheel scrolling, Cmd shortcuts, and menu commands that need the app to be active. Drags and hover menus have no route in this design and weren't tested.
- **Unknown until tested:** native buttons (CUA reports they work; not measured here), real Brave, Electron, Safari web apps, rich-text editors, file pickers, and windows on another Space.

This does not cover every app or every minimized window, and it doesn't match full computer use. Refusals are how we find the gaps.

## Consequences

- **Tyler can't watch the bot.** Bots act on windows he can't see, so work steps become his main record. The live-trading risk on Apex Terminal gets worse: protect those controls before anyone uses thread access there. Use Allow Once until then.
- **Coverage drops on purpose.** Some foreground flows that passed earlier will now refuse.
- **`AXValue` replaces the whole field**, so the read-back matters.
- Once the session-tap and physical paths are gone, the engine never runs in headed mode. The bridge can assert that.

## First implementation path

Build on `fix/ucu-activity-gate`, and agree overlap with Muck first because this touches `AX.swift`, `EngineSession.swift` and `Input.swift`. No packaging or install until the live check passes in a signed build.

1. **Stop taking over.** Bridge: headless for every action. Delete the session-tap paths in `Input.swift` and the engine wheel use. `request_app` stops activating. `press_key` posts per process.
2. **Make actions work unfocused.** New `type_text` ladder, app-scoped `click_point`, `reveal`, refusal codes, `element_disabled`.
3. **Make reads and screenshots work unfocused.** `read_screen` already falls back to a background capture. Fix `ax.capture` returning a window-less reading on minimized apps, drop the frontmost requirement from screenshots, add `visibility`, `minimized_stale_image` and `web_content_unavailable`.
4. **Rescope the guard.** Target-aware latches and activation as input. Overlay rule.
5. **Live acceptance in the signed helper.** While Tyler works normally in another app, a bot opens a new Brave tab, goes to the IANA page by address bar and verifies it. A sampler records the pointer, frontmost app and window order throughout. Pass means zero bot-caused changes and no human-activity refusals. Repeat once on a real target app.

Keep tests to the existing Swift and engine suites, with focused cases for the guard, the `type_text` read-back and `click_point` refusals. The probe in `/tmp/ucu-bg` becomes the one live check. No new test files beyond that.

## Build outcome

Muck did not start this, so Jigga built it. Run through the real tool path on a scratch Chromium window fully covered by other apps, 2026-11-01. The sampler never saw the target take the front.

| Step | Result on a covered window |
|---|---|
| `request_app`, `read_screen` | Yes, reports `visibility: covered` |
| `type_text` on a numbered field, then by focus | Yes, read back. Page field needed the `AXValue` rung |
| `click`, `reveal`, `click_point` on a control | Yes |
| `click_point` on empty page | `pixel_target_has_no_control` |
| `press_key Cmd-T` | `shortcut_needs_foreground`, reading kept |
| `get_screenshot` | Yes |
| New Tab press, address typed | Yes, read back through `AXSelectedText` |
| **Return in the address bar** | **Unreliable. 0 of 7 through the helper. Raw probes landed 1 of 15** |

Found while building:

- **A covered page can go blind.** A page reloaded while Chromium reports it `hidden` has no web tree, and `AXManualAccessibility`, `AXEnhancedUserInterface`, `AXMain` and `AXRaise` don't bring it back. The bot gets `web_content_unavailable`. A page opened by navigation in such a window is expected to do the same, though that wasn't reached because Return missed. The earlier 7 of 11 key result and the new tab task were on windows that were at least partly visible, or were not recorded either way.
- **`AXConfirm`** did nothing on the Chromium address bar, and the bar doesn't advertise it.
- **No suggestion list.** Chromium exposed no suggestion rows to press in place of Return on a covered window.
- **A covered page reports new values late**, over 0.4 seconds, so the final read-back waits up to 2 seconds.
- **Readings can race a retitle.** The engine compares titles, so a page changing its title during a reading gave `engine_window_not_found`. Readings now retry twice.
- **The web check needs the engine.** Only the engine switches a browser's page tree on, so `web_content_unavailable` is decided from its reading.
- **Test windows can take the front.** Closing and creating Chromium windows over the debug port took the front twice. The tool-path runs never did.

Not settled: whether a partly visible window behaves better, and how real Brave behaves. Partly visible needs a window on Tyler's screen, so the signed acceptance run is the place to find out. Acceptance step 5 can't pass on a fully covered Chromium window until Return is solved; the likely answer is an address-free route, or a named refusal for that case.

## Review outcome

Muck reviewed this on 2026-11-01 and owns the build.

| Question | Outcome |
|---|---|
| Delete the physical paths? | **Yes.** Muck agreed. No disabled foreground tool stays in the code |
| Screenshots of minimized windows? | **Refuse.** Muck proposed refusing Chromium only. This refuses every minimized or hidden window, because there is no reliable way to tell which apps stay current |
| Start a stopped app? | Not answered. Default stands: allow it, disclose it in the grant popup, report `launch_took_focus` |
| Hover-scroll gap? | Not answered. Default stands: the live control recheck is enough |
| Chromium with no web tree? | Not answered. Default stands: refuse by name |
| Isolated desktop | Deferred. Muck agreed |

Points from the review that this ADR does not adopt:

- **Keys stay on the ladder.** The review's "AX actions only, no CG key events" would remove rung 2. Return by process is what navigated the measured new-tab task, so the acceptance task needs it unless the address bar advertises `AXConfirm`. Only session-tap posting is deleted.
- **Window identity stays on the window number.** `windowNumber()` in `AX.swift` already gets the CoreGraphics number through `_AXUIElementGetWindow`, the call the engine uses. Don't resolve windows by title or frame: macOS shortened Brave's title from 286 to 62 characters, and two windows can share a frame.
- **Guard scoping stays on frontmost plus activation**, not per-event target PIDs, because macOS only reported a reliable target for clicks.
- **Web scrolling stays on `reveal`.** A scroll action on `scrollarea` hasn't been measured; `AXScrollToVisible` has.
- **Base directly on `3cc1d53d`.** Cherry-picking it would duplicate the commit.
