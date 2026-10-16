# iOS composer panel verification

Implementation: Luna (`gpt-6-luna`), commit `293c240`, on `feat/ios-composer-panel` in the managed `ios-composer-panel` worktree. The primary checkout remains on `main` with its pre-existing untracked files preserved.

Parent review covered destination capture before picker activation, draft migration during attachment reads, duplicate filenames, URL cleanup, Plan acknowledgement/refusal/retry, focus restoration, drag handling, touch targets, and theme selectors. Luna corrected findings before final verification.

## Fresh parent checks

- `npx tsc --noEmit`: passed.
- Focused model/component tests: 12 passed.
- `npm test`: 1,465 passed, zero failures/skips.
- `git diff --check`: passed.
- `npm run iphone:sync`: passed.
- Signed Debug simulator build: passed; iPhone 17 Pro, iOS 26.5, device `27376220-F731-42FE-B32F-FAC37F820153`.
- `codesign --verify --deep --strict`: passed. All 13 files from `dist-phone` match the built app's `public` directory by SHA-256.

## Native observations

- Existing pairing still connected after installation.
- Compact panel opens from +; handle tap expands; downward handle drag collapses. Compact body scrolling reaches Project, Machine, and Plan without changing detent.
- Classic, Liquid, and Frost remain readable. Final build corrects grouped-row corners and the handle's gray hover background.
- Photos opens the iOS private picker. Cancel returns to the panel without adding a file.
- A temporary typed draft survived opening the panel without a send. It was discarded on app relaunch; no test message or attachment was sent to the host.
- Original Frost selection restored. Final expanded panel remains open in the simulator.

Physical camera capture and software-keyboard geometry still need a real-device check. This simulator used a hardware keyboard. Attachment/Plan failure and navigation cases were exercised in the production helpers/component fixture; no artificial failure was injected into the user's paired Mac session. Native Reduce Transparency was previously tested for the shared theme system; this change extends the same opaque selectors and was reviewed in source.

## Artifacts

- Signed simulator app: `/tmp/apex-ios-composer-sim-build/Build/Products/Debug-iphonesimulator/App.app`
- Native screenshots: `/Users/tylercaldwell/Downloads/apex-deck/release/ios/composer-panel-preview/{liquid-expanded,frost-expanded}.png`
- Logs: `/tmp/apex-ios-composer-{sync,build,tests}.log`

The feature is committed on its task branch. No merge, push, DMG rebuild, or TestFlight upload was performed.
