# Accessibility and usability review

Reviewed the integrated prototype in Chromium at 1440×900, 1100×500, and 390×844. This is a prototype review, not a complete assistive technology audit.

## Findings

### Major — keyboard reorder drops focus after each move

**Reproduction:** At 1440×900, focus the first pane's `Move …` handle and press `Alt+ArrowRight`. The pane order changes, but `document.activeElement` becomes `BODY` because `render()` replaces the focused pane. A keyboard user cannot continue moving or resizing that pane without tabbing through the page to find it again. This also interrupts a sequence of keyboard actions after a single move.

**Recommendation:** Preserve the focused pane ID and control (and, where relevant, selection) before rendering, then restore focus to the corresponding new control after rendering. Verify both arrow-key reorder and span changes this way. WCAG 2.1.1 and 2.4.3.

### Moderate — pane action controls are undersized for touch

**Reproduction:** At 390×844, inspect the pane header controls. The move-earlier, move-later, one-column, and two-column buttons render at 23×23 CSS pixels. They remain separate targets, so phone users have to tap very small adjacent controls; the rendered size also falls just below WCAG 2.2 AA's 24×24 minimum target-size criterion.

**Recommendation:** Give each control at least a 24×24 CSS-pixel target with adequate spacing; preferably use 44×44 targets on touch layouts while keeping the visible glyph compact. Check the phone layout for header crowding after enlarging them. WCAG 2.5.8.

## Observed behavior

- At 390×844, the document had no horizontal overflow (`scrollWidth` equaled the 390-pixel viewport).
- At 1100×500, the document grew to about 710 pixels tall; the composer began below the initial viewport and remained reachable by page scrolling. This follows the plan's scroll-on-short-windows behavior.
- Keyboard focus indicators are defined for buttons and thread rows. I did not run a screen reader, so announcement quality is not verified.

