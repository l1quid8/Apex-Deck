# Duo and standard Phone controls

The human requested direct Duo and standard simulator controls in Apex Deck, following the successful native HID investigation. Implement in the existing Rust phone host and React Phone tab. Xcode stays installed; Xcode, Simulator and Device Hub do not need to run. Do not merge or package a release during this task.

## Behavior

- Keep Home, Lock, Give back and power controls. Add Fold/Unfold for a detected multi-display device, absolute orientation, screenshots, recording, appearance, text size, contrast, status bar presets, volume, biometric match/failure, and location override/reset.
- A device picker lists installed iPhone/iPad model/runtime combinations and creates/reuses Deck-owned simulators. Preserve each device and its data when switching; do not erase personal simulators.
- Use one typed dispatcher for human buttons and `phone` commands. Preserve human-priority turn-taking. Report tool failures without pretending they succeeded.
- Duo pose uses a bundled, attributed guest HID source compiled by the installed Xcode. Never use screen power as a fold operation. Missing private interfaces produce an actionable unsupported error.
- Suspend input during pose changes, clear obsolete frames, wait for usable display geometry, and reject human gestures from an old display/rotation. Stop recording before changing device, screen or orientation and retain the saved movie.
- Display current model, active screen and pixel size. Save captures under the app data folder with display and size in the filename and show their paths. No real clipboard sharing.

## Implementation plan

1. Add typed controls and catalog parsing; test invalid parameters, unavailable runtimes and per-model device reuse. Add HID compiler/cache and third-party license.
2. Add shared control dispatch and transition settlement; test turn-taking, errors, stale geometry and recording cleanup. Extend bot parser/help and host command API.
3. Add toolbar and Controls disclosure using existing UI styles; test dispatch and transition input gating. Keep the screen flexible at narrow widths.
4. Run TypeScript, relevant Rust checks and frontend suite; verify folds, orientation, post-transition input, capture and standard controls live with Apple GUI apps closed. Review the whole scoped diff before committing.

## Review focus

Cold boot/slow transitions; black screens during transitions; stale queued taps; selecting an unavailable model; recording interrupted by folding or shutdown. The success condition is observed live behavior in Deck, in addition to unit checks.

## Approved visual direction

The human rejected the loose row of text buttons, approved the polished replacement, and requested implementation. The approved interaction is captured in `mockups/phone-controls-v1.html` (design preview only; no native controls are wired).

- Use Deck's existing theme variables and system UI type; the preview includes Clay, Light and Classic checks. No new product-wide palette.
- A compact device identity and runtime picker sits above one toolbar. Home, Lock, labelled Fold/Unfold, Rotate, Screenshot and Controls stay reachable without wrapping at the 278px sidebar width. Controls gains a visible text label when there is room.
- Group appearance, text size, contrast and status bar under Display; screenshot and recording under Capture; orientation, volume and Face ID under Hardware. Location and power sit below these groups. The popover scrolls within the sidebar and closes with Escape or an outside click.
- Keep the simulator image central. A quiet line beneath it shows the active display and measured point dimensions. Production must also expose framebuffer pixels for capture/input diagnostics.
- Show human/bot ownership in a separate footer with Give back. Keyboard help is a disclosure rather than a permanent paragraph.
- The prototype simulates display transitions, disables controls during them, and stops its mock recording before folding or rotating. Preview images are earlier actual Duo captures; these interactions do not operate the shared simulator.

Preview checks so far: 278px toolbar and menu have no horizontal overflow; images load; Escape restores trigger focus; fold/rotation update geometry and re-enable controls; record stops before a display change; text-size and contrast state updates are visible. `npx tsc --noEmit` passes. Native controls and end-to-end acceptance remain pending.
