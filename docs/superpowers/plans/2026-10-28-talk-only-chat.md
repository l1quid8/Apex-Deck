# Talk-only chats in the shared thread screen

Implement the approved mockup at /Users/tylercaldwell/Downloads/apex-deck/mockups/talk-only-chat-v1.html and the group-chat handoff. Work only on feat/local-chat-talk-only; do not package, merge, publish, or change the host race fix.

1. Add regression coverage for the talk-only composer policy, chat-specific backend routing, durable sends, cached reconnect, and matching four-level Move choices. Watch new tests fail first.
2. Replace DesktopChat's transcript with ChatPane. Retain rail/New chat/Move dialogs in DesktopChatsUI; add a small TalkOnlyChat host for header, menu, outbox status, drafts, Move and moved state. Keep machine+room identity and existing promotion/outbox APIs.
3. Add a default-off talkOnly switch to ChatPane and BotSettings. Hide files, tools, Plan/diff/image commands, calls, executable code actions, access edits and side panels. Preserve the Work rendering path, full message actions, models, reasoning, Speed, TLDR, mentions and text commands. Guard typed commands, paste and drop too.
4. Route chat participant edits through chat_* commands and durable sends through DesktopChats.send; read cached snapshots while offline. Fork into a new chat with copied history through chat_import, preserving profile mappings. Keep mutation guards for moved/pending-move chats.
5. Match both Move dialogs to Read-only, Ask, Edit, Full. Run tsc and all JS tests. Render desktop chat, normal Work and moved chat using fixture data; save captures and inspect them. Hand branch and limitations to Jigga for review.

Review focus: avoid duplicate sends/queues; no room creation for missing chats; remote machine collisions; reconnect preserves drafts/outbox; moved chat disables mutations while link/menu exports remain usable. No release build or native app restart.

Validation: `npx tsc --noEmit` passed; `npm test` passed 2,740 tests, skipped 3, failed 0. The renderer fixture exercised chat/Work/moved views, menu filtering, durable send entry, offline history, Fork, desktop Move labels and phone Edit submission. Captures: `/tmp/null-talk-only-captures/{chat,work,moved}.png`. Independent source review found an interactive-card write gap in moved chats; card read-only/execution controls and the answer-save guard now block it, with regressions passing and reviewer confirmation. Native provider/release validation remains with Jigga; no package, merge or publish was performed.
