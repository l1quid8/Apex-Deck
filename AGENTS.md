# Repository instructions for all agents

## Branches, builds, and shared checkout

- Only start the production build for .dmg release here `/Users/tylercaldwell/Downloads/apex-deck/release`
- Only start the development build from release here `/Users/tylercaldwell/Downloads/apex-deck`, using `APEX_DECK_DATA_DIR="$HOME/Library/Application Support/dev.apexdeck.app" npm run desktop:dev`.
- Before changing files or switching branches, run `git status` and preserve others' work.
- Create the task branch here with `git switch -c <type>/<name>`.
- Run `npx tsc --noEmit` and require it to pass before merging or reporting that a change is merged.
- After an authorized merge, delete the merged task branch.

These instructions apply to every bot.
