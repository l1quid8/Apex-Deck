# Task 8a — shared composer review fixes

Base: `ab166a12` on `feat/adaptive-panes`. Implements revision 15's Task 8a and Review Focus 33–36. The plan remains untracked and untouched.

- Finder-drop subscribers hit-test the real chat clipped to the pane map, plus the dock only for its target. A drop switches to its receiving thread before copying; hidden/off-screen panes cannot claim dock drops.
- ComposerDock measures its minimum occupied height at each width and reports borrowed height. Placement chooses levels and default zoom at the resting height, fits their rectangles to the actual height, and keeps the 56px floor. Drag and zoom calculations receive the same borrowed height.
- Height-only refits skip slot transitions and map/Focus snapshot markers. Focus movement, divider and layout transitions retain their existing behavior.
- Add bot floats above the dock's composer box. Inline composers retain the existing replacement form. The floating form keeps the editor controls in layout, so opening it takes no map height; its height is bounded by map/window space.
- To shows status, project and agent count and reveals the target on click. Tab chips read their style from the portaled composer. App uses the tested dockTarget function, and owns the refusal notice.

Verification ledger:
- Watched the new placement regression fail before implementation (changed level), then pass. The target test initially failed on the missing module, then passed.
- Durable App scenarios cover both 1512×945 and 1100×650: drops on other/active transcripts and dock; nine-line drafts in Even grid, Horizontal and Focus left; stable horizontal positions and level; clearing restores height; Add bot leaves map height unchanged; bounded floating dialog; To reveals target; tab corners; Ctrl-wheel retains target; chip refit after a 200px resize.
- The real BrowserView/PaneMap harness grows and shrinks the map with borrowed height: native views receive bounds updates without hide calls, and neither motion marker is set. Existing scroll, Focus transition, divider and title-drag checks pass.
- Focused App/quick-add/assistant integration rerun: 27 passed. Dock draft/target/placement checks: 13 passed. BrowserView Focus checks: passed. TypeScript and diff whitespace checks: passed.
- Initial full-suite run found two old assertions that assumed an exact prop sequence or inline-only Add bot; both were corrected and passed a focused rerun. Heavy parallel Electron load also exposed insufficient waits in the new App scenario; it now waits for state and disables hidden-window throttling in the helper.
- Final full suite: 3,546 tests; 3,541 passed, 0 failed, 5 skipped (172.6 s). This includes the pre-existing untracked adversarial-rounds tests; they are not part of this commit. Final TypeScript and whitespace checks pass.
- Final self-review: checked drop clipping, shared target fallback, resting/default zoom calculation, borrowed-aware drag/zoom, refit snapshot suppression, portal CSS ancestry and inline opt-out. Jigga remains the independent reviewer.

Observed the actual Electron dev window after launching the repository-prescribed development command. The updated To line is rendered. The existing service/build mismatch warning remains. No messages were sent through the user's service. No merge, push or installer.

Review handoff: Jigga should review this diff and verify native Finder drop routing against the actual preload. Automated tests replace only the drop bridge; they do not claim an OS Finder drag occurred.
