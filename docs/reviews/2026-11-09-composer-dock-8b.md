# Task 8b — persistent rest height and quiet refits

Base: `26c82b20` on `feat/adaptive-panes`. Implements revision 16's Task 8b and Review Focus 37–39. The untracked plan and unrelated work are preserved.

- The dock keeps its smallest occupied height for the window's module lifetime, including across hiding, unmounting and width changes. Agent counts read `No agents yet`, `1 agent` or `N agents`.
- Placement retains whole-row snaps where rows fit, extending the final snap to the world's bottom when the 56px floor prevents them fitting.
- PaneMap records the scroll offset reached by a refit and suppresses the snapshot marker for that matching scroll event only. Ordinary scroll, divider, drag and Focus motion retain their guards.
- External insertion, Discuss, Use tool and examples request their caret through the layout effect, after mount restores the saved selection. They no longer depend on animation-frame ordering.
- The layout-picker test waits for dismissal after Shift+Tab. App drop probes use distinct file paths so sending the demo draft doesn't create duplicate React attachment keys.

Verification:

- Before implementation, the new floor test failed with 256 instead of 357; the forced caret race failed with 4 instead of 16; the scrolled BrowserView harness observed `moving=true`; the large App scenario re-tiled on return from Code (level 3 instead of 1).
- These cases pass with the fixes. BrowserView tests keep a live side preview on the second row during nine refits, require bounds updates and no hide calls, and retain existing native scroll, Focus switch, divider and drag checks.
- App scenarios at 1512×945 and 1100×650 cover long attached drafts across Code/Threads, repeated empty/long draft switches, width change then clear, Send restoring pane rectangles, height resize choosing geometry again, and End reaching the full final Horizontal pane with a long draft. Existing drops, typing, floating Add bot, reveal and tab-chip checks remain.
- The dock browser fixture forces the frame-before-mount caret race, checks all three agent-count labels and retains inline opt-out and popped-out refusal checks.
- Screenshots of the long attached draft after Code/Threads are captured outside the repository. The 1512×945 screenshot was inspected: four columns remain, the dock shows the long draft and files, and the To line identifies Thread 0.

Both full suite runs passed: 3,547 tests, 3,542 passed, 0 failed, 5 skipped on each (168.9 s and 175.2 s). This includes the pre-existing untracked adversarial-rounds tests; they are not included in this commit. The suite still emits generic React missing-key warnings in other scenarios. TypeScript and whitespace checks pass. Logs: `/tmp/null-8b-full-1.log`, `/tmp/null-8b-full-2.log`; screenshots: `/tmp/null-8b-shots/`.

Launched the repository-prescribed `desktop:dev` command from the root. Observed the actual Electron window at localhost:5173, its shared composer and the singular `hem · 1 agent` label. The service/build mismatch warning remains (`ac0326491ba9` service versus the modified app). Automated App scenarios use the demo backend; native BrowserView calls and Finder drops use boundary doubles. No messages were sent through the user's service. No merge, push or package is authorized by this task.
