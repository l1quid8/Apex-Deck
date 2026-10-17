# Landing texture for Apex Deck — implementation handoff

Status: Phase 1 implemented on feat/landing-texture (diamond, rainbow/picker). Phase 2 logo SDF not yet done. Defaults chosen: enabled, rainbow, diamond every 3rd tap. Target repo: `/Users/tylercaldwell/Downloads/apex-deck`
Branch: `feat/landing-texture` (create per `AGENTS.md`; run `git status` first and preserve others' work — the shared checkout is usually dirty).

## Goal

Add an original, clean-room recreation of the Claude.app "mouse-touch" landing
background to Apex Deck: a field of tiny glyphs lit by drifting wind noise.
Fast pointer moves warm the field; clicks send expanding ripples. Two changes
from the reference behavior:

1. The heart-shaped ripple (every 3rd click in the original) becomes a
   **diamond**, with an optional **Apex Deck logo silhouette** variant.
2. Color is user-selectable: **rainbow mode** or a **single color** from a picker.

## Legal / clean-room constraint (read first)

- Implement from the behavioral spec below only. Do **not** copy, port, or
  de-minify Anthropic's bundle, shaders, or glyph sequences verbatim.
  Reference REA notes (behavior + constants, for reference only):
  `/Users/tylercaldwell/Downloads/REA/evidence/claude-landing-texture/README.md`
- Do not import or ship `c9d397622-Ddkc2XHN.js` or any Claude.app asset.
- All shader/JS code, glyph sequences, and variable names must be original to
  this repo. Matching *behavior* (timings, thresholds) is the spec; matching
  *code* is out of scope.

## Reference behavior to recreate (from REA)

| Area | Spec |
|---|---|
| Grid | Cells 6.5×13 CSS px, glyph ~9px monospace, rest light 0.03 |
| Glyphs | Each cell cycles a 42-char sequence at a per-cell pace (~1.2 steps/s × pace); roused cells cycle +6 steps faster. Invent Apex sequences, e.g. drawn from `APEXDECK01<>/\\|+-` — do not reuse the reference strings. |
| Wind | 4-octave value/gradient noise gusts drifting at a per-session heading (~18–42°, speed 42–64 px/s). Calm ellipse (250×80 CSS px, centered ~45% height) thins the field behind foreground content. |
| Move (warm) | Mouse/pen only. Speed low-pass τ=80ms. Wake segment emitted every ≥18px and ≥35ms, max 48, lifetime 2.4s, radius 50+40·age px, decay exp(−age/0.65). Force = smoothstep(speed, 60..800 px/s) · len/(len+90); drop if <0.04 (slow drift does nothing). Warmth saturates as `1−exp(−1.5·Σ)`. Moves warm only — no push, no front. |
| Click (ripple) | Button 0 only, ignored on interactive elements. Max 6 live taps, lifetime 3.6s. Front radius `620·(1−exp(−age/1.3))` px, width 85+60·age. Cells near the front glow and cycle faster. Sample hand effects at `p + 24·noise(p/95)` so fronts are never perfect geometry. |
| Easter egg | Every 3rd tap uses the shaped front (diamond or logo, see below) instead of a circle. Taps 1–2 stay circular. |
| Power | ~40ms frames, ~10ms while a ripple is live, 83ms backoff. Settles after 180s idle (fade over 8s), resumes over 3s on interaction. Pauses when document hidden or window unfocused. |
| Kill switches | Disabled under `prefers-reduced-motion` (render one static frame or nothing), `prefers-contrast`, and `forced-colors`. Fails soft (no canvas, no error) if WebGL2 is unavailable or software-rendered. |

## The shaped ripple: diamond first, logo second

The original heart works by dividing radial distance by a direction function:
`reach = d / shape(dir)`, so the front arrives at different radii per angle.
Keep that interface — one function `shapeReach(dx, dy, shape): number` used by
both the shader and the tests — and swap the shape:

### Phase 1 — diamond (ship this first)

A diamond (rotated square) has boundary `|x| + |y| = R`, so the shaped reach
is just Manhattan distance. No approximation, no texture:

```glsl
// GLSL and TS must agree exactly; unit-test the TS version.
float shapeReach(vec2 p, float d) {
  // circle: return d;
  return abs(p.x) + abs(p.y); // diamond
}
```

Optional polish: mix circle→diamond over the first ~0.2s of the tap so the
front "forms" instead of popping: `reach = mix(d, manhattan, smoothstep(0.0, 0.2, age))`.

### Phase 2 — Apex Deck logo silhouette (only after Phase 1 lands)

Do **not** use a polar radius lookup `r(θ)` for the logo: the brand mark
(`branding/macos/Vectors/BrandMark.svg`, a pixel-art "A") is concave with a
counter, so it is not star-shaped from its centroid and a single radius per
angle loses the legs/counter.

Use a signed distance field (SDF) texture instead:

1. Build-time (script under `scripts/`, run once, output committed): rasterize
   `branding/macos/PNG/BrandMark-256.png` alpha to a 128×128 SDF
   (exact EDT or jump-flooding), normalize to [−1, 1], write
   `public/branding/brandmark-sdf.png` (or a `.json` Float32 array if PNG
   quantization bands visibly).
2. In the shader, for a logo tap: `sdf = texture(brandSdf, (p − tapCenter)/tapScale + 0.5)`;
   the front is where `sdf ≈ frontThreshold(age)`, with the threshold sweeping
   outward over the tap lifetime, scaled so max reach ≈ 620px like the circle.
   Glow = gaussian around that isoline, same width formula (85+60·age).
3. Silhouette uses alpha only. The mark's mint/cyan split is a later nicety:
   if wanted, tint by the sign of `p.y − tapCenter.y` (mint above, cyan below).

Both shapes sit behind the same tap record: `{ x, y, at, shape: "circle" | "diamond" | "logo" }`.

## Color: rainbow or picker

Settings (below) choose `mode: "rainbow" | "single"`, `color` (hex),
`rainbowSpeed` (0–3, default 1).

- Rainbow: `hue = mod(px*0.55 + py*0.35 + t*45*rainbowSpeed, 360)`, HSL ~90% /
  52% (+16 lightness at full glow). Rainbow speed is read as a uniform; 0 = frozen gradient.
- Single: base = picked color; glow brightens toward white:
  `mix(base, vec3(1.0), 0.55 * glow)`. No hard-coded blue.
- Suggested default (confirm with Tyler, see Open questions): single color,
  brand mint `#3DEF91` with the glow pulled toward cyan `#1ED7EE`
  (both from `branding/macos/Brand-Colors.json`), rainbow as the opt-in.
- Alpha in both modes: `0.15 + light*0.85`, cells below light 0.04 skipped.

## Where it mounts (Apex Deck specifics)

Scope v1 to the empty/new-thread surface only — not behind a live transcript
(readability + battery). Known anchor points (verify line numbers on the branch):

- `src/App.tsx` — `<div className="app">` (~line 2003) and `<main className="canvas">` (~2098).
  If a full-window backdrop is later wanted, this is the mount; not v1.
- `src/ChatPane.tsx` — empty states `.empty.agents-empty` (~2878) and `.empty` (~2902).
  This is the v1 mount.

Rules:

- One `<canvas>` per mounted surface, `aria-hidden="true"`, `pointer-events: none`,
  absolutely positioned inset-0 behind content (`z-index` below, parent `position: relative`).
- Pointer listeners go on the parent pane, never the canvas. `pointerdown` is
  ignored when `event.target.closest('button, a, input, textarea, select, [role="button"]')`.
- Cleanup on unmount: cancel rAF, remove listeners, lose the GL context
  (`WEBGL_lose_context`) — Deck mounts/unmounts panes aggressively.
- Resize via `ResizeObserver` on the parent; cap device pixels (reference cap
  ~21M; also cap DPR at 2) and recompute the cell grid on resize only.
- iPhone/Capacitor: `pointermove` warmth is mouse/pen only (matches reference);
  taps still ripple. No separate touch path in v1.

## Renderer decision

Build WebGL2 (two passes, like the reference behavior describes — original
shaders, written for this spec):

1. Wind pass: fullscreen triangle → offscreen framebuffer at 1×2 samples/cell.
   Output r=strength, gb=direction, a=calm·shown.
2. Glyph pass: one instanced/bufferless quad per cell (`drawArrays(TRIANGLES, 0, 6*cells)`),
   glyph atlas (printable ASCII subset actually used by the sequences)
   rasterized once on a 2D canvas → texture. Skip cells with no wind/warmth.

Why not Canvas 2D: the interactive card prototype proved the *interaction
model* in 2D, but a full-pane 2D loop over ~10–40k cells/frame is a battery
risk in Electron alongside xterm/CodeMirror. Decision gate: if the WebGL2
path slips, ship the 2D version behind the same component API **only** with
a hard cell-count cap and the 180s settle — and file the WebGL follow-up.
Component API must not leak the renderer choice.

Fallback ladder: WebGL2 unavailable/software → render nothing (surface keeps
its normal background). Never throw into the pane.

## Files to add / touch

| File | Change |
|---|---|
| `src/landing/LandingTexture.tsx` | New. React wrapper: canvas, lifecycle, ResizeObserver, pointer tracking, settings props. No rendering math beyond wiring. |
| `src/landing/engine.ts` | New. Pure TS: grid, wake/tap state, force curves, `shapeReach`, color math. No DOM/GL — this is what tests import. |
| `src/landing/shaders.ts` | New. Original GLSL string constants (wind + glyph passes, SDF branch compiled in Phase 2). |
| `src/landing/renderer.ts` | New. WebGL2 setup, atlas build, frame loop, power management (40/10/83ms, 180s settle, visibility/focus pause). |
| `src/settings.ts` | Add `landingTexture` to `AppSettings` + `DEFAULT_SETTINGS`, validated in `readSettings` using the existing drop-bad-values pattern (enum check, hex regex, clamp speed 0–3). Older files omit it → defaults. |
| `src/AppearanceSettings.tsx` | Controls, following existing patterns: enable toggle, mode select, `<input type="color">` (disabled in rainbow), rainbow-speed range (disabled in single), ripple-shape select (`diamond` / `logo` (Phase 2) / `circle`). Reuse the glow hex validation/error copy already in this file. |
| `src/ChatPane.tsx` | Mount `<LandingTexture>` in the two empty states only; pass settings through. Nothing else changes. |
| `src/themes.ts` | Only if the color should ride along with skins (`AppearanceValues`). Default answer: no — keep it in `AppSettings` for v1. Note the decision in the PR. |
| `tests/landing-texture.test.mjs` | New node tests (repo runs `node --experimental-strip-types --test tests/*.test.mjs`). |
| `scripts/build-brandmark-sdf.mjs` | Phase 2 only. One-off SDF generator; output committed under `public/branding/`. |

Settings shape:

```ts
export interface LandingTextureSettings {
  enabled: boolean;                 // default true
  mode: "rainbow" | "single";       // default: see Open questions
  color: string;                    // hex, default "#3DEF91"
  rainbowSpeed: number;             // 0..3, default 1
  rippleShape: "diamond" | "logo" | "circle"; // default "diamond"; "logo" Phase 2
}
```

## Implementation steps

1. **Engine + tests first.** `engine.ts` with wake emission, force curves,
   tap cadence (every 3rd tap shaped), `shapeReach`, grid sizing, color
   helpers. Tests green before any GL.
2. **Settings plumbing.** Type + defaults + `readSettings` validation + a
   round-trip test with a hand-corrupted settings object (bad enum, bad hex,
   NaN speed → defaults, rest of file intact).
3. **Renderer.** Atlas, wind pass, glyph pass, uniforms for wakes (max 48)
   and taps (max 6) as fixed-size arrays. Static-frame path for reduced motion.
4. **Component + mount.** Wire into ChatPane empty states; pointer handling
   per rules above; verify no listener/GL leaks across pane switches.
5. **Appearance UI.** Controls + live preview reuse (the settings preview
   already themes itself; the texture itself does not need a preview).
6. **Phase 2 (separate PR).** SDF script + texture + shader branch + enable
   the `logo` option in the shape select.

## Acceptance tests

Automated (`npm test`, must pass; also `npx tsc --noEmit` per `AGENTS.md`):

- `shapeReach`: diamond at cardinals = d, at 45° = d·√2; circle = d everywhere.
- Wake force: speed ≤60 → 0; 800 → 1 (before len factor); force <0.04 dropped;
  emission requires both ≥18px and ≥35ms; ring buffer never exceeds 48.
- Tap cadence: taps 1,2,4,5 circular; 3,6 shaped; buffer never exceeds 6.
- Front radius: 0 at age 0, asymptotes to 620; tap expires at 3.6s; wake at 2.4s.
- Settings: valid values round-trip; corrupt values fall back per-field.
- Color: rainbow hue wraps into [0,360); single-mode glow mix stays in gamut;
  speed 0 freezes hue over time.

Manual (dev build: `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`):

- [ ] Empty thread shows the field; opening a thread with messages removes it.
- [ ] Slow pointer drift = nothing; fast swipe = warm trail fading ~2.4s.
- [ ] Clicks 1–2 ripple as circles; click 3 is visibly a diamond (screenshot it).
- [ ] Clicking buttons/inputs in the empty state does **not** ripple.
- [ ] Rainbow ↔ single switches live; picker disables in rainbow and vice versa;
      values survive an app restart (settings.json).
- [ ] `prefers-reduced-motion` (macOS Accessibility) → static/absent, no loop.
- [ ] Leave it 3+ minutes: settles; next click resumes. Hide window: no CPU
      (Activity Monitor / Electron task manager before/after screenshot).
- [ ] Resize/drag between Retina and non-Retina displays: no stretch, no crash.
- [ ] `npm run desktop:smoke` still passes.

Perf budget: steady-state frame ≤4ms GPU+CPU on an M-series at 1512×982 CSS
px; if exceeded, lower fill/frame rate before merging — do not raise the budget silently.

## Risks / traps

- **Copying the reference**: behavior constants are fine; code, shader text,
  glyph strings, and the blue `[0.1,0.68,1]` are not. Keep them out.
- **Logo via polar LUT**: will look wrong (concave mark). SDF or don't ship Phase 2.
- **GL context leaks** across pane mounts: always lose-context on unmount;
  Electron caps live WebGL contexts (~16) and Deck opens many panes.
- **Uniform array limits**: 48 wakes × vec4 is fine, but declare fixed-size
  arrays and a count uniform; don't recompile shaders when counts change.
- **Settings-file compat**: `readSettings` must tolerate the field being
  absent, null, or hand-edited — same as `appearance` today.
- **Readability**: if anyone asks for it behind transcripts, that's a new
  decision with a contrast check, not a v1 stretch goal.

## Open questions for Tyler (don't guess — block Phase 1 merge on 1–2)

1. Default mode on first run: brand single-color (mint) or rainbow?
2. Default on or off for existing users upgrading?
3. Diamond cadence: every 3rd tap (recommended, keeps it an easter egg) or every tap?
4. Phase 2 logo: silhouette only, or mint-above/cyan-below two-tone?

## Non-goals

No Claude.app code/assets, no network, no telemetry on clicks, no settings
sync beyond the existing settings.json, no transcript-background variant,
no touch-move warmth on iPhone in v1.
