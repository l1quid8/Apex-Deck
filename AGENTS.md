# Repository instructions for all agents

## Branches, builds, and shared checkout

- Only start the production build for .dmg release here `/Users/tylercaldwell/Downloads/apex-deck/release`
- Only start the development build from release here `/Users/tylercaldwell/Downloads/apex-deck`, using `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
- Before changing files or switching branches, run `git status` and preserve others' work.
- Create the task branch in its own worktree with `git switch -c <type>/<name>`.
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

## How a change gets built and tested

1. **Choose the work.** Summarize what is underway and awaiting test in one line. The user decides how much starts and when. Write one sentence describing what the user should see when the change works.
2. **Build and test.** For a feature, have a second agent review a short plan before coding. Include a mockup if a screen changes. Build in the task worktree, test the expected behavior, and record the output.
3. **Open a pull request.** Submit the change on GitHub so the project’s automated checks run.
4. **Review the risk.** A different model reviews the change and test evidence. Give an alert timer a short review and a permission change a deeper one. Fix findings and rerun the affected checks.
5. **Merge and hand off.** After review passes and checks are green, the merge owner merges into GitHub’s `main` and updates the Mac. Mark each item **Awaiting your test** on the open-work list. One build can cover several items. For each, name the build to open, what to try, and what should happen.
6. **Test and release.** The user tests when ready. Reserve the app or phone only while a step needs exclusive use. Record each result against the build number and source commit. Clear that exact build for release once all its items pass. Keep failures open, fix or revert the change, and return a new build for testing.

## Host architecture

Give each new host subsystem its own module and state. Keep command admission and subsystem wiring in Host. Put event reduction and persistence alongside the subsystem that owns them.
