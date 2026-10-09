# Optional glass skins for Apex Deck

Implement the reviewed v4 mockup as an optional appearance feature in the real application. Classic remains the default and retains the current appearance. The glass kit and HTML mockups are read-only references. Work is isolated in /Users/tylercaldwell/Downloads/apex-deck-glass-v4 on feat/glass-themes-v4.

Settings > Appearance contains Classic, Smoked, Tide, Dusk, Rose, Frost and Liquid; hue, glow, frost, surface opacity, corner radius and backdrop controls; compact/roomy density, light mode and flat comparison. Changes persist through the existing settings.json API. Imported and saved skins remain selectable after restart. Users can import/export JSON and copy an AI prompt describing the supported contract. Do not present the mockup's keyword simulation as an actual AI generator.

A skin is bounded data: format apex-glass-playground, versions 1 or 2, name, optional author, and appearance {hue:0..360, glow:0..100, blur:0..40, opacity:30..100, radius:4..30, backdrop:0..100, density:0.72|1, light:boolean, flat:boolean}. Version 1 may omit backdrop (default 50). Reject unknown keys, strings in numeric fields, nonfinite values, invalid flags and files above 32000 UTF-8 bytes. No uploaded CSS, script or external assets.

Existing chat/Stop/queue/approval logic remains authoritative. Glass surfaces use actual bot colors and real activity: working glows in the bot color, waiting amber, idle no glow. Reduced motion stops animated sheen. Approval surfaces stay opaque, readable at >=12px and independent of imported theme tokens. Preserve existing responsive behavior and make Appearance usable at 375px.

Validation: behavior tests for theme validation, persistence and controls; full npm test; npm run build; Electron/browser screenshots and interaction smoke at desktop and narrow widths; independent code review.
