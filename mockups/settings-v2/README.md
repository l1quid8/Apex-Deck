# Settings preview

Standalone clickable prototype for the queued Settings usability project. No production app code or live settings are used.

Run from this folder with `python3 -m http.server 8894 --bind 127.0.0.1`, then open http://127.0.0.1:8894/ in a local browser.

## Direction

Simplification changes grouping, not feature availability. Routine controls remain visible; the existing features remain reachable through named expandable groups and search. Dark means a true black canvas/sidebar (`#000000`) and neutral near-black panels (`#101010`), not blue-gray. Light is unaffected. System follows the OS color-scheme signal.

## Prototype behavior

Working: fourteen sections, grouped navigation, search-to-control with disclosure expansion, Light/Dark/System, accent picker and validated hex, density, tab-local switches/selects, built-in/saved skin gallery selection, mock saved-skin deletion, named skin saving, JSON display/copy/file import/paste import, copy-AI-prompt, surface sliders with outputs, background pattern/count/match/color/size controls, shuffle/reset, empty-thread color/rainbow/shape controls, Calls engine-specific controls, save-error/retry, keyboard search/Escape, responsive navigation.

No provider/host/phone/permission/key configuration is read or changed. Those action buttons open explanatory prototype dialogs. Skin JSON transfer uses only sample/local preview state; the complete product visual-effect engine is not duplicated. Surface/pattern/ripple values are interactive controls but don't redraw every product effect. Voice samples and model choice dialogs do not call providers. Saved choices reset on reload.

## Existing control coverage

Audited against `src/AppearanceSettings.tsx`, `src/themes.ts`, `src/SettingsPage.tsx`, `src/HostsSettings.tsx`, `src/PhonesSettings.tsx`, `src/ComputerUseSettings.tsx`, `src/ModelGatewaySettings.tsx`, `src/ModsSettings.tsx` and the existing shortcut list. Product option lists that are dynamic must continue to use their existing registry; this preview shows sample entries and does not propose removing unshown registry values.

| Existing feature/control | Prototype location | Interaction/evidence |
|---|---|---|
| Theme / Appearance shortcut | Appearance, primary navigation | Opens the same canonical page |
| Built-in Classic, Smoked, Tide, Dusk, Rose, Frost, Liquid, Clay | Appearance → Skins · built-in & saved | All eight preview tiles and selection |
| Saved skin previews, selection and Delete | Same group → Your saved skins | Sample saved entries; tab-local select/delete |
| Current selected skin | Appearance → Current skin | Selection updates label |
| Accent picker and exact hex | Appearance → Accent color | Both inputs update accent; invalid hex flagged |
| Clay Terracotta/Sage/Slate | Appearance → Tune surfaces & accent, with Clay selected | Conditional preset controls retained |
| Clay solid/serif behavior and excluded glass controls | Same group and Background group | Explicit conditional explanation; controls return on other skins |
| Glow 0–100% | Tune surfaces & accent | Full range, output updates |
| Frost 0–40px | Same | Full range, output updates |
| Surface opacity 30–100% | Same | Full range, output updates |
| Corners 4–30px | Same | Full range, output updates |
| Backdrop strength 0–100% | Same | Full range, output updates |
| Reading density Compact/Roomy | Appearance → Reading density | Comfortable labels the original Roomy setting; Compact changes row spacing |
| Light surfaces | Appearance → Light/Dark/System | Replaced by explicit modes, preserving the underlying capability |
| Flat surfaces | Tune surfaces & accent, non-Clay | Tab-local switch |
| Background patterns: Blobs, Aurora, Halo, Corners, Horizon, Mesh, Stripes, Rings, Dots, Spotlight, None | Background patterns & glows | All eleven selectable pattern tiles |
| Flat-surface background explanation / enabling glass through background editing | Same group | Message retained; editing background clears flat state |
| Match accent | Same group | Switch reveals per-glow inputs |
| Glow count 1–8, fewer/more | Same group | Bounded stepper |
| Per-glow picker and exact hex | Same, Match accent off | One pair for each glow |
| Accent-derived glow swatches | Same, Match accent on | Non-editable swatches with explanation |
| Glow size 50–200% | Same group | Full-range slider |
| Shuffle colors, Reset background | Same group | Both update preview control state |
| Empty-thread Show field | Empty-thread field | Tab-local switch |
| Rainbow / One color | Same group | Reveals correct enabled inputs |
| Field color picker and exact hex | Same group | Disabled for Rainbow / field off |
| Rainbow speed 0–3, step 0.1 | Same group | Full range; disabled for single color / field off |
| Third-click Diamond/Circle, unavailable Apex logo | Same group | All choices represented; logo remains disabled |
| Skin name, Save skin | Save, import & share skins | Name validation and tab-local gallery addition |
| Export current skin JSON | Same group | Populates JSON transfer text field |
| Import JSON file, 32,000-byte limit | Same group | Local file picker and basic format/size validation |
| Text transfer, Copy JSON, Import pasted JSON | Same group | Tab-local JSON transfer |
| Describe look, Copy AI prompt | Same group | Copies a prompt, no provider call |
| Skin safety statement / notices | Appearance footer and transfer group | Status/error text; no behavior-modifying skin code |
| Run buttons on code blocks | General | Existing switch retained |
| New artifacts Open pane / Just notify | General | Both options retained |
| Saved in / Show in Finder | Data & storage → Saved work location | Prototype Show folder dialog |
| Voice for calls / sample | Calls → selected engine, advanced voice samples | Sample select; Play sample is explanatory only |
| Remembered models / Clear | Data & storage → Maintenance | Clear suggestions dialog |
| Older records / Review import | Data & storage → Older records | Review import dialog |
| Version, check updates, restart when ready | About & updates | Check and state-aware restart preview actions |
| Local/GPT-Live engine | Calls | Working engine-specific sections; inactive preferences retained |
| GPT-Live voice/model, local default voice, pause before reply | Calls | Representative choices; production registry must remain complete |
| Call controls Bar/Pill/Top bar | Calls | All three retained |
| OpenAI API key Add/Replace/Remove/Save/Cancel workflow | Models & providers → Provider keys | Add/Replace/Remove buttons; full credential editor intentionally mocked, never accepts real credentials |
| All 14 provider/tool visibility entries | Models & providers → All tools & provider visibility | All existing tool categories represented |
| Enable all / Hide uninstalled tools | Same group | Prototype explanation dialogs |
| Provider/image API-key status and usage | Provider keys group | Sample rows for existing image and API key categories |
| Thread Who answers | New threads | Addressed last / Everyone at once / Everyone in turn |
| Model-to-model rounds 0–10/unlimited | New threads | Complete range represented in a select |
| Access Read/Ask/Edits/Full | New threads | All four options |
| Confirm before steering | New threads | Existing switch retained |
| All 13 chip styles | Appearance → Agent chips & details | Complete style list; illustrative preview |
| Show effort / Show usage | Same group | Both switches retained |
| Terminal font 10–20px | Terminal | All integer sizes |
| Scrollback 1,000/5,000/10,000/50,000 | Terminal | All four retained |
| Host add/status/retry/edit/remove | Computers and Manage saved computer | Sample status plus action dialogs |
| Phone pairing/remote on-off/status | Phones | Pair dialog and remote toggle |
| Phone access tier and revoke | Device access & network settings | Tier selection and Revoke dialog |
| Endpoint ID, UDP port, advertised addresses, Save | Same group | Sample identity/port, input and Save dialog |
| UCU enable/status/refresh/setup/stop/resume | Unified Computer Use and Access, status & recovery | Switch plus prototype actions |
| UCU per-thread approval and revoke | Access and Access, status & recovery | New direction represented, sample grants only |
| Cursor visibility, optional labels and duration | Cursor indicator | Interactive tab-local controls, Swift helper implemented |
| Cursor style presets (default/simple/ring-only/custom) | Cursor indicator → style | Preset buttons, simple disables ripple/highlight, ring-only truly hides arrow (Swift renderer), atomic save, helper ack surfaced |
| Cursor size 0.5–4.0 | Cursor indicator → Preview & size | Slider, upstream range validated, Swift scaling 44pt * size, failure surfaces |
| Fill/accent/outline colors | Cursor indicator → Colors | Color inputs, hex validation #FFF/#FFFFFF, fallback to accent, Swift uses fill/rim/accent with validation |
| Ripple and target-highlight toggles | Cursor indicator → Effects | Two toggles, Swift renderer skips layers when false; ring-only forces both true |
| Motion/travel and dwell timing, bow/overshoot/tremor | Cursor indicator → Customize cursor | Sliders: travel min/max 30–600, dwell 0–300, bow 0–3, overshoot 0–0.15, tremor 0–4, budget 700ms validated in Rust + Swift, dwell affects auto-hide |
| Action labels off by default | Cursor indicator → labels toggle | Checkbox, false default, atomic save + helper unified/set-action-labels ack, error surfaced on RPC failure |
| Custom PNG cursor image + reset | Cursor indicator → Custom PNG | File picker, PNG signature check, ≤2MiB, ≤1024 per side, persisted in app data /computer-cursor/ (hash name, not temp), Swift validates file existence/size/PNG magic via validateImageFile, degrade to default, reset uses unified/reset-cursor-overlay |
| Permission/model/privacy explanations | Mac permissions & privacy | Retained; no global model-specific enable gate |
| Gateway endpoint on-off/URL copy/listen/port/save | Model gateway, Network configuration and Endpoint actions | Sample values, switch and action dialogs |
| Gateway API keys/providers/refresh | Endpoint actions & provider readiness | Both key and provider functions represented |
| Key creation name/scopes/daily requests/spend cap | Key limits, scopes & issued access | Full fields/ranges represented; no real key issued |
| One-time key reveal/copy key/copy setup/Done | Same group | Explicit prototype flow dialog |
| Issued key usage, last use, revoke | Same group | Sample row and revoke dialog |
| Gateway private-tool exclusion | Gateway footer | Preserved explanation |
| Mod add/on-off/reload/reinstall/remove | Extensions and Manage extension & permissions | All actions represented |
| Mod requested grants and enable with permissions | Same group | All four capability categories; no live permission mutation |
| Mod option field types / file or folder picker | Same group → configuration | Options flow dialog; schema-driven editor not reimplemented |
| All existing keyboard shortcut actions | Shortcuts | Complete grouped action list; no rebinding added |

## Verification

- JavaScript syntax parsed after expansion.
- Live Brave screenshot: body/sidebar computed `rgb(0, 0, 0)`, panel `rgb(16, 16, 16)` in Dark mode.
- Appearance groups and exact controls inspected through the browser accessibility tree.
- Search selects advanced controls and expands the matching group.
- Light/Dark/System, Calls engine swapping, save failure/retry and narrow layout were verified in the first pass and rechecked after relevant edits.

The adjacent implementation plan now requires no feature removal and a true-black Dark palette. Production settings implementation remains queued behind Unified Computer Use.
