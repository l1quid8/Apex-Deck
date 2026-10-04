# Preview pane: embedding check in a release build

Plan Task 1 (`docs/superpowers/plans/2026-10-04-preview-pane.md`), run 2026-10-04 on macOS.

Done automatically rather than by hand in the web inspector. A probe server on `localhost:5199` served a probe page and a page sending `X-Frame-Options: DENY`. A temporary hook in `src/main.tsx` (behind `VITE_PREVIEW_PROBE`, never committed) embedded both pages in frames with the Preview sandbox: `allow-scripts allow-same-origin allow-forms allow-modals allow-downloads`, `referrerpolicy="no-referrer"`. The probe page reported what it found back to the server. Built with `npm run tauri build -- --debug --no-bundle --config '{"identifier":"dev.apexdeck.probe"}'`, so the real app's saved data was not touched.

| Check | Result |
|---|---|
| App origin | `tauri://localhost` (the release origin, not the dev server) |
| A local `http://localhost` page loads inside the app | Yes. Its script ran and reported from inside the frame. |
| The page sees `window.__TAURI_INTERNALS__` | No, `undefined` |
| The page sees `window.__TAURI__` or `window.ipc` | No, both `undefined` |
| The page's own origin | `http://localhost:5199` (sandbox keeps its own origin, never the app's) |
| `top.location.href = …` from the page | Blocked, `SecurityError`; the app never navigated |
| A page sending `X-Frame-Options: DENY` | Its script never ran (frame stays blank) |

Decision: continue with the plan as written.
