# Phone controls implementation and verification

Implemented on `feat/duo-simulator-controls`. No merge or release package was requested.

The approved `phone-controls-v1.html` layout is implemented in `RightPhone`: device identity/picker, compact toolbar, grouped Controls disclosure, measured display geometry, capture paths, ownership footer and keyboard help. Human controls and bot commands use the same typed Rust dispatcher.

## Native verification

Environment: Xcode 27.1 (27A9275), iOS 27.1, shared iPhone Duo. Xcode, Device Hub and Simulator GUI processes were closed during the native checks; their background simulator services remained available.

Verification used the source Phone component against an isolated newly built daemon, controlling the authorized shared Duo. The installed app's daemon was not replaced or restarted. This is source/native validation, not installed-release validation.

- Folded framebuffer: 1398 × 2034 pixels, 466 × 678 points; unfolded: 2853 × 2007 pixels, 951 × 669 points.
- Repeated fold/unfold and absolute portrait/landscape rotation passed, including the folded Home screen. Rotation is confirmed against Apple's physical-device readback; an app may keep its UI in portrait. Controls track the requested orientation independently, while touch follows the framebuffer. The inner panel's physical HID orientation is converted to its control orientation.
- Taps and typing passed on both screens. Fresh captures showed `foldqa` and `innerqa` in Search; test text was then cleared.
- Appearance, text size and contrast were read back from simctl. Status bar override/reset and location override/reset completed. Volume and biometric events were delivered; an enrolled Face ID authentication workflow was not tested.
- Native PNG screenshots were saved for each active panel, with framebuffer dimensions in the filenames. Recording stopped and retained its movie before folding; the movie decoded with ffmpeg. Apple rounds odd framebuffer dimensions down to even H.264 dimensions.
- Cold boot and the device picker reused the existing Duo UDID and its apps/data. Bot commands for the catalog, unfold, portrait, landscape-left, screenshot and done passed.

Local evidence: [folded input](/tmp/phone-input-folded-text.jpg), [unfolded input](/tmp/phone-input-inner-text.jpg), [cleared input](/tmp/phone-final-ui-cleared.jpg), [native controls](/tmp/apex-phone-controls-native-results.json), [repeated poses](/tmp/phone-rotation-final.json), [device and CLI results](/tmp/phone-coldboot-final.json).

## Reliability and review

A fresh code review found startup/switch synchronization, legacy device adoption, mismatched frame/geometry snapshots, timeout input gating and recording dropouts. These were corrected and covered by focused checks. Pose changes suspend gestures, invalidate earlier geometry and recording, and require usable destination frames before input resumes. Failed transitions keep gesture input blocked while recovery controls remain available.

The native HID service stays alive for the simulator session. Folding emits a gradual hinge sweep. After a controlled pose change the capture stream favors its destination: Xcode can retain a visible old framebuffer on the inactive panel, so choosing the first lit panel is insufficient. The regression fixture includes both panels remaining visible.

The attributed Apache-2.0 helper source and license are bundled in the daemon, compiled with the selected simulator SDK and cached by source/SDK identity. The license is also installed beside the helper. These private Apple interfaces are qualified here on Xcode 27.1; missing interfaces return an unsupported error without driving Device Hub or switching screen power.

## Checks

- `npx tsc --noEmit`: passed.
- Full frontend suite: 2,522 passed, 3 skipped, 0 failures.
- Final focused UI/backend checks: 136 passed (included in the full suite).
- Rust phone checks: 74 passed, 1 ignored real-simulator manual test; CLI checks: 7 passed.
- Native daemon build with `remote`: passed.

Ten Luna helper tasks ran in waves of three: native lifecycle, UI behavior, CLI/API parity, device reuse, capture geometry, frontend checks, Rust checks, helper packaging, UI connection lifecycle, and shutdown cleanup. Review fixes preserve cleanup after failed movie finalization, idempotent bot Stop, model/runtime identity on reuse, atomic capture metadata, API-change queues, and the destination-display preference after a temporary dark frame.

A rotation after restarting hit the 25-second frame-confirmation timeout while installed and isolated streams both captured the shared simulator. Physical orientation read back correctly; a recovery retry and the full seven-pose sequence then passed. During the timeout, gestures stayed blocked and recovery controls remained available.

Computer use also verified a tap and `zz` typing through the source Phone component itself, in addition to the native input checks. Evidence: [UI typing](/tmp/phone-final-ui-typing.jpg) and [cleared query](/tmp/phone-final-ui-cleared.jpg). PNG dimensions match their filenames; the movie saved on folding decoded successfully with ffmpeg. Xcode, Device Hub and Simulator GUI processes were checked closed again after these actions.

Apex iOS app layout, pairing, draft/scroll retention, other simulator models and installed-release behavior remain separate validation scopes.

Final computer-use read-back: Rotate completed on the folded screen without blocking input; Unfold reached the inner portrait panel; Rotate reached the inner 951 × 669-point landscape panel. The Controls menu showed Landscape left, all grouped controls, and Escape returned focus to its trigger. The shared Duo is left unfolded with an empty Search query.
