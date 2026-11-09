# Task 8: shared composer dock

Implementation on `feat/adaptive-panes`, following revision 14 of the adaptive panes build plan.

The main window now has one `ComposerDock` below its pane map. ChatPane retains ownership of its text, quotes, files, queue and controls, and portals only the current thread's composer into the dock. Focusing a terminal or preview retains the most recent eligible chat target. Popped-out threads are excluded, including their hidden main-window copies. Talk-only chats, pop-out windows and the Agents library do not opt into docking.

The editor saves selection direction, selection range, height and scroll position on detach. Mounting restores them and rebinds the textarea, composer-height, stacked-field and chip-row sizing observers. Quote, selected-text Add to chat, external file insertion, Revert, card Discuss, code output, review requests, attachments, tools, examples and mentions ask to reveal the composer before writing. A popped-out thread rejects that write; App also shows a visible toast because the rejected pane itself is hidden.

The workspace canvas now gives the map and dock a vertical flex container. The dock preserves the existing composer styling and positions menus, quotes, runner and voice controls relative to its composer subtree.

## Evidence

- Final full suite: `node --experimental-strip-types --test --test-force-exit --test-concurrency=4 tests/*.test.mjs`: **3,532 passed, 0 failed, 5 skipped**, exit 0. Includes the other thread's untracked adversarial tests; those files are not part of this commit.
- `npx tsc --noEmit` and `git diff --check`: pass. Four focused Electron/source integration tests: pass.
- New real-ChatPane Electron fixture: independent alpha/beta drafts; caret restoration; multiline height and selection across a 200px resize; long textarea scroll restoration; external insertion into a hidden composer; popped-out rejection with no hidden draft mutation; opt-out inline composers; Enter posts `hi` to an in-memory backend.
- Source contract: only the main pane map opts into docking.
- Extended the real TalkOnlyChat test to require the editor inside its section and no shared dock. Its existing send test and the real pop-out attach/lifecycle test still run.
- Real `npm run desktop:dev` launched from the repository root with the required data directory. Observed one dock below two panes. Typed distinct temporary drafts in “Group chat” and “Multiple thread pane management”, switched between them, and observed each restored. Cleared both temporary drafts. No live message was sent.
- The actual app still shows its pre-existing service/app build mismatch (`ac0326491ba9` service versus `472f1fb5…-dirty` app). Live sending and native pop-out acceptance are not claimed here; pop-out behavior is covered by fixtures.

## Review focus

Check target selection across terminal focus, maximize, project changes and popping out the focused thread. Check popup positioning and observer rebinding in the dock. The main-window ownership and external-composer actions are the integration risks; shared multi-thread sending is later work.

No merge, push or installer is part of this task.
