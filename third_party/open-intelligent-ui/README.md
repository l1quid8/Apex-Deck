# OpenIntelligentUI reuse in Apex Deck

Upstream: https://github.com/CopilotKit/OpenIntelligentUI

Pinned commit: `8391a94c1c3939c679e40ddd7bfc08a9ef690e70`

Git tree: `ee0c531c3301e7d28ca6d6872197acd4b0b53517`

The GitHub commit API returned this exact commit and tree on 2026-10-14.
`manifest.json` records the upstream and vendored paths, original byte lengths,
and SHA-256 checksums for all eight verbatim files. The files below their original
paths are unchanged upstream snapshots; `design-system.css` is Deck's adaptation.
The complete original MIT license, including Atai Barkai's copyright and
permission notice, is in `LICENSE`. No dependency code is copied from Websandbox,
CopilotKit, Idiomorph, Leaflet, or the upstream import map's libraries.

## Active reuse

`desktop/generated-ui/frame-content.mjs` loads `design-system.css` at runtime and
uses it in its fixed child document. That file derives the upstream `THEME_CSS`,
`SVG_CLASSES_CSS`, and `FORM_STYLES_CSS` without their CDN import map, streaming
stagger extension, or design-skill text. Deck overrides surface/text/border colors
with six public hex-color tokens, adds visible keyboard focus and internal
scrolling, and suppresses motion for reduced-motion preferences. The module
rejects CSS URL/import references before composition. No URL fonts or other
resources are included in the adapted CSS.

The same module adapts upstream `buildFinalFrameContent`: trusted CSP is first in
the fixed head, followed by the local design system, then completed card CSS and
markup, then behavior. Its fixed bootstrap uses upstream `MEASUREMENT_JS`'s body
scroll height plus computed margins, ResizeObserver, resize/load events and
short initial polling. Reports use Deck's bound message protocol and are
coalesced; internal overflow remains scrollable. Upstream `clampReportedHeight`
finite-number validation is reused with Deck's 200–800px bounds.

The adapter retains renderer.tsx's completed-content lifecycle and once-per-final
sandbox behavior injection. Deck changes the lifecycle authority to Electron
main: only a completed validated card approved for its revision can initialize
once; Stop/revision/unmount disposal belongs to the main host. There is no partial
preview, morphing, expression queue, React/CopilotKit hook, Websandbox evaluation,
exported executable HTML, or remount that silently reruns a card.

`crates/apex-core/src/view.rs` contains the adapted task-first guidance, local
calculator/data/control rules, theme use, accessible responsive output, and SVG
layout math from prompt.py and the three playbooks. Its examples cover a validated
unit-cost calculator with Reset, an explicitly labeled sample chart with working
Reverse/Reset controls, and an accessible static SVG flowchart. Deck replaces the
tool/streaming schema with one completed `apex-ui` envelope and combines function
declaration plus setup into one classic JS string. Jev/A2UI routing, imports/CDNs,
live maps/photos, Websandbox sendPrompt/openLink, and automatic follow-ups are
removed. Local discussion text can only be staged for trusted human review.

## Trust and release status

No model string enters the trusted wrapper HTML or a serialized wrapper script.
The wrapper assigns its one fixed bootstrap-only srcdoc before model code is
available. After the host verifies frame/process ownership, structured `init`
delivers the card to that same opaque-origin child. The child appends CSS through
style.textContent, assigns the body fragment, and executes the one JS string
through script.textContent exactly once. Literal `</script>` model strings are
never serialized into host markup.

The iframe has only `sandbox="allow-scripts"`, an empty connection allowlist,
and denied privileged features. Both documents use deny-all resource policy;
only local inline code/styles and data images are admitted, with child/nested
frames and workers denied in the child. There is no eval, import map, map animator,
network forwarder, file accessor, prompt sender, or external-link bridge.
Bound messages authenticate source window plus protocol/run/digest, validate exact
keys/types and byte limits, and reject transferred ports. An initial trusted bind
and bootstrap acknowledgment allow main to inspect child PIDs before initialization.

Immutable picker/prototype guards and capture listeners block file-input/label
activation and drop/paste before generated listeners. They are defense in depth:
host-level file chooser interception, permissions, navigation, isolated-process
termination, Connection-Allowlist inheritance and independent network observation
still require verification in the exact packaged Electron/Chromium runtime.
The Node VM adapter tests prove script composition/bridge behavior, not Chromium
sandbox enforcement. Generated execution and bot guidance stay OFF until every
release gate in the design passes. Existing bot call sites use `ANSWERS_SYSTEM`;
the local selector defaults to Unsupported and no production call site selects
Verified. This change adds no daemon-trusted client capability.

Packaging includes the adapted CSS and this attribution with the in-app code,
and preserves the full MIT text in
`Resources/third-party-notices/OpenIntelligentUI-MIT-LICENSE.txt`.
