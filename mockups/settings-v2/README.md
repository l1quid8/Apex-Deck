# Settings preview

Standalone clickable prototype for the queued Settings usability project. No production app code or live settings are used.

Run from this folder with `python3 -m http.server 8894 --bind 127.0.0.1`, then open http://127.0.0.1:8894/ in a local browser.

Working interactions: fourteen settings sections, grouped/collapsible navigation, search-to-control including advanced disclosures, Light/Dark/System (live OS media query), accent choice, reading density, remembered switches/selects within the tab, Calls engine-specific controls, save-error/retry simulation, keyboard search and Escape, mobile navigation, informative mock-only dialogs.

Provider status, phone names, keys, permissions and thread grants are sample data. Buttons that would change real configuration display a prototype explanation. Choices reset on reload; this is not persistent app configuration. Skin choices illustrate the control but do not reproduce the full product skin engine.

Verified in the local Brave browser: mode selection, search expanding/focusing the background-effects control, Calls engine switching, and narrow viewport without horizontal overflow. All fourteen render functions also ran in a minimal DOM harness. No product tests or builds are needed for this isolated HTML artifact.
