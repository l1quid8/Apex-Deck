# ApexAgent interactive UX mockup

Open `index.html` in a browser. Everything is simulated locally: no real tasks,
provider calls, service restarts, changes to files, or archived chats.

The export includes both **Focused** and **Docked** designs. Use the selector
beneath the app to compare them. Focused is the recommended starting point and
was selected in the user's design comparison. This is a review handoff, not
authorization to implement the design.

## Files

- `index.html`: complete standalone browser preview, with both layouts.
- `source.html`: editable HTML, CSS, and JavaScript fragment. Use this to inspect
  the product-specific design and interaction logic; the generated preview also
  contains its rendering runtime.

## Try the workflow

1. In Chat, click **Start review**. The sample task returns a result shortly.
2. Open **Tasks** and review the result. Open its linked worker chat.
3. Edit a proposed task's brief, worker, and linked chat before approving it.
4. Request changes to a result, then accept the revised result.
5. Answer the remote worker's question. Either choice is simulated.
6. Send a direct request from the composer. It creates a simulated worker task.
7. Open the scope picker, change projects, and edit the assistant profile.
8. In a proposed task's Advanced settings, use a $0.01 spend cap to see a pause.

## Design intent

The current ApexAgent interface divides a small floating window between the
conversation and a separately scrolling task form. The redesign gives Chat,
Tasks, and Activity their own views while keeping the composer visible.

Task cards show the brief, worker, linked chat, state, and next action. Task
details put the original request beside an editable assistant brief. Advanced
settings contain execution mode and spend limits. Worker questions return to
the user. Closing a worker pane preserves the task.

ApexAgent coordinates work. Shared Threads retain visible participants and
reply policy; the Docked design shows Jigga, Null, and Gronk in a shared chat.

## Important implementation distinctions

- All reports, costs, checks, diffs, and task transitions here are sample data.
- All-project scope is a proposed UX. It does not establish that remote project
  monitoring is currently supported by the installed services.
- Execution modes, profile updates, and spend-cap behavior need to be checked
  against the real daemon before implementation. A selectable mockup control
  is not evidence of backend support.
- The existing preference is to hand off direct user requests and ask first
  before starting work proposed by ApexAgent.

## Review prompt for Claude

Review this interactive ApexAgent mockup, starting with the Focused design.
Open index.html in a browser and inspect source.html for the interaction logic.
Compare it with the current Apex Deck implementation in
/Users/tylercaldwell/Downloads/apex-deck, especially src/ApexAgent.tsx,
src/ApexAgentTasks.tsx, src/apex-agent-panel.css, and src/assistant-tasks.css.

Evaluate whether it fixes the cramped chat/task split, hidden composer and
approval actions, duplicated assistant replies, and exposed technical fields.
Check the worker hand-off, approval, question, result-review, and change-request
flows. Keep shared multi-model Threads intact. Distinguish proposed UX from
implemented backend capabilities. Return prioritized feedback and a concrete
implementation plan. Review only; do not edit the native app yet.

The original inline mockup was tested through its primary interaction flows
and at desktop and narrow viewport sizes. This export preserves that design.
The exported page was also checked for sending a direct request and switching
between both layouts, with no browser console errors.
