# Workspace Dashboard and Tasks implementation plan

**Goal:** Apply the approved compact sidebar mockup to Dashboard and Tasks, with trustworthy activity and collapsible Dashboard groups.
**Spec:** The conversation-approved main-pane assistant and regular right sidebar. Dashboard and Tasks remain workspace tools across screens. Memory/settings and assistant configuration do not move into this sidebar.
**Architecture:** Keep existing live pane and task stores, panel navigation and review controls. Use chat lifecycle state for activity, preserve output-based terminal status, and add presentation state for collapsed Dashboard groups. Add an opt-in compact Tasks view that opens existing task details.
**Tech stack:** Existing React/TypeScript, CSS theme tokens and Node tests.

## Constraints
- Continue the existing `feat/workspace-dashboard-tasks` task branch in the canonical checkout, following AGENTS.md. Preserve unrelated untracked mockups and assets.
- No backend changes, synthetic product data, automatic task approval, application replacement or new Electron dev session.
- Use the approved mockup's quiet headings, separated rows and readable status labels; retain search and status/project grouping.
- Remember collapsed status/project groups when switching tabs/screens and reopening the panel.
- Keep existing task ownership, error/recovery states and explicit review/approval controls.

## Tasks
1. Reproduce and correct chat activity. The live app shows a Thinking thread under Idle; source expires Working 1.5 seconds after output. Add a lifecycle regression covering silent work, waits, completion and queued work; preserve terminal behavior.
2. Add Dashboard heading, compact project/status rows and keyboard-operable collapsible group buttons. Verify collapse across updates, filtering, grouping and remount; verify attention notes preserve project context and row navigation.
3. Add `view="sidebar"` to ApexAgentTasks and use it in the regular sidebar. Verify row selection and Back do not dispatch work, and existing detail actions remain intact.
4. Run relevant component/status checks, `npx tsc --noEmit`, the JavaScript suite and `git diff --check`. Review a browser preview if available; distinguish preview from installed-app verification.
5. Dashboard items have a right-click/keyboard menu for New Pane, External Pane and a selected pane. Reuse each existing session; selected panes exchange layout positions. Use the source section's layout, retain host/project identity, explain unavailable external panes, and support the same actions in popped-out Dashboards. Keep menus outside the scroll/blur container and close them when the Dashboard is hidden.

## Review focus
- An active but silent turn must remain Working, including queue/worker handoff.
- A genuine open approval/question takes precedence over busy work.
- Collapsed groups keep their preference when rows disappear/reappear; project names must not collide with status keys.
- Compact task browsing never sends/approves a task or binds the main assistant composer.
- Storage-disabled browsers and unavailable project hosts show usable states.
