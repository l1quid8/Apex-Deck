# Task 8d — reading position, resting height and preview motion

Implemented from Task 8d in `~/.cache/jigga-review/plan-revision-17.md`; the repository plan still contains revision 16. No branch switch, commit, merge, application launch or installer build was performed. Existing selection changes in PaneMap and the other lanes' edits were preserved.

## Behavior and root causes

- Refit scroll now preserves the first line for visible, off-screen and pinned active panes. Only an active group that was wholly visible can request the nearest fitting line. The pure `refitScroll` helper has explicit growth, clearing and bottom-pane coverage.
- The fitted record, scroll effect and Focus bookkeeping skip intermediate renders whose measured map size differs from the render's `area`. Such a render previously combined a new borrowed height with an old map height and scrolled for a level that was never actually displayed.
- Motion markers stay on while their respective slots have running animations. A late `transitionend` cannot restart settled motion. Divider resizing uses the short motion window because it has no release glide.
- The dock's loaded single-composer rest excludes WorkBar's start tray and its parent row gap (`data-dock-extra`). The first Send therefore removes borrowed tray height rather than changing the canonical rest.
- The Focus BrowserView fixture waits for reset's new arrangement object before waiting for motion to settle. The title-drag restore budget begins after the drop glide ends.

## Red evidence

- New real-App first-Send assertions failed before the fix: Horizontal level `7 → 8` at 1512×945 and `5 → 4` at 1100×650. `task8c/task8d-red-app.log`.
- The saved review's real-App Focus-left probe at 1100×650 moved on seven of nine typed lines; clearing moved the top pane from Thread 8 to Thread 5. `task8c/task8d-baseline-focus-small.log`.
- The new pure refit test failed before the helper existed. Its bottom-pane case uses the 56 px row floor at 150 px height, so keeping the line actually leaves that active pane clipped.
- The motion regression failed because a delayed `transitionend` restarted `data-moving`. It also samples actual reordered slot animations with a 60 ms main-thread hold. `task8c/task8d-red-motion.log`.

## Frozen verification source

Shared-source runs were interrupted by concurrent Vite HMR, including null-node errors and a mid-typing reload. Those runs are not counted as acceptance. A frozen source fixture is at `~/.cache/jigga-review/task8d-frozen/`, with its required `shared/` and `phone.html` entry dependencies copied too. Initial attempts with those dependencies omitted produced startup/optimization errors and are excluded.

The frozen Task 8d production hashes (SHA-256) are:

| File | Hash |
| --- | --- |
| ComposerDock.tsx | `f7d8ffa301a0993429a7e0667d79b4c5bf33454143f0206082fef728407882ad` |
| PaneMap.tsx | `298286222e7418e89829c924609d9413882c98e0b12e8dc08c1b40a0912a9fe3` |
| paneArrangement.ts | `748bc1d12a25825598d911e7b0de531862de2490313c2fd96b95b4906dc4679b` |
| WorkBar.tsx | `58459186609727bf82bd07401c5773ce1f9f86bc7a7481b4ff6aa37d1c5c5fd2` |

An additional integration check found the structurally shorter multi composer could lower this same canonical rest. The dock now learns rest only from the single composer and uses that height as a minimum while multi mode is visible. The isolated regression first failed at `187.6 → 81 px`, then checks multi growth and return to single. That later ComposerDock hash is `4db0921693244e6f2692a09c7b14759ed28d41c2c3510aa931eecbefacd73eaf`; no other file in the table changed for that addition.

## Scope of evidence

The checks use real App/ChatPane/ComposerDock/PaneMap in Electron with browser-demo data. The native BrowserView boundary is stubbed in its dedicated fixture. No message was sent through the user's service. Full-suite integration, packaged/native user acceptance and the multi-file two-host send path remain separate gates owned by the integration lane.

Final bounded check results and screenshots are recorded below.
