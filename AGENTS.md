# Repository instructions for all agents

## Branches, builds, and shared checkout

- Only start the production build for .dmg release here `/Users/tylercaldwell/Downloads/apex-deck/release`
- Only start the development build from release here `/Users/tylercaldwell/Downloads/apex-deck`, using `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
- Before changing files or switching branches, run `git status` and preserve others' work.
- Create the task branch here with `git switch -c <type>/<name>`.
- Run `npx tsc --noEmit` and require it to pass before merging or reporting that a change is merged.
- After an authorized merge, delete the merged task branch.

## Preview links

Any time you give me a link to something running on this computer (a preview, a review page, a dashboard), give me a Tailscale link, never localhost. I work across several computers and my phone.

- Default is private: publish with `tailscale serve --bg <port>`.
- Public sharing: if I say the link is for someone else (a friend, a client, someone without Tailscale), or ask for it to be public, use `tailscale funnel --bg <port>`. Before running it, confirm with me in one line that the link will be public to anyone who has it. Never use Funnel without that confirmation.
- Serve public previews from an isolated folder containing only the intended preview and required assets. Never expose the repository root, directory listings, private thread snapshots, logs, credentials, or unrelated files.
- Never put anything with API keys, trading accounts, or client data behind Funnel. If the project contains those, explain the concern and suggest a sanitized Vercel preview instead.
- Run the preview server as a persistent background service that survives the agent session and restarts after failure. On macOS, prefer a user LaunchAgent. `tailscale serve --bg` and `tailscale funnel --bg` do not keep the underlying server alive.
- For static mockups, prefer a plain static server without development tooling or HMR. Make `/` open the intended preview directly.
- If a dev server rejects the host, allow `.ts.net` in its config.

Before sending a link:
1. Check the underlying server and `tailscale serve status` or `tailscale funnel status`.
2. Request the exact Tailscale URL and every required asset; confirm successful responses and the expected content.
3. Open that URL in a browser and verify visible rendering and the main interactions. HTTP 200 alone does not prove the preview works.
4. For PUBLIC links, also verify the page and assets through an independent external connection without Tailscale access. A request from this Mac alone does not prove public access.
5. If any verification is unavailable, state exactly what remains unverified; do not call the link fully verified.

When sending a Funnel link, label it PUBLIC, state that anyone with the link can access it, and include the shutdown command: `tailscale funnel reset`.

If a shared link fails, check server survival, proxy configuration, public reachability, and asset loading before reporting it fixed.

These instructions apply to every bot.

## Host architecture

Give each new host subsystem its own module and state. Keep command admission and subsystem wiring in Host. Put event reduction and persistence alongside the subsystem that owns them.
