# iOS composer panel design

The user chose Claude's composer menu from the supplied screenshots and asked for a plan followed by Luna implementation. Replace only the iPhone composer's current “Add to message” sheet; retain the other project, machine, tool, and bot sheets.

## Experience

- Open from the existing + button into a compact bottom panel, initially 48% of the available phone-frame height. Expand to 88% using its handle or an upward drag. Drag down from expanded collapses; drag down from compact dismisses. Only the handle/header owns these gestures; scrolling rows must scroll content.
- Header: circular Close on the left, centered “Add to message”, Photos on the right, and a real Expand/Collapse button in the handle. No introductory paragraph or prominent absolute path.
- First region is a horizontal media rail: a Camera tile, a Photos tile, and thumbnails of images already selected for the current draft. No fabricated recent-library images and no background photo-library permission. Camera/Photos/Files use system pickers and actual selected files.
- Rounded action groups: Files and Tools; Project and Machine with their current values and chevrons; Plan mode with an accessible switch. Existing attachment filenames, remove controls, and a short “Sends with your next message” caption remain available. Copy folder path is removed from this panel; keep its existing thread-details entry.
- Compact mode prioritizes media and attachments; all groups are reachable by scrolling without requiring expansion. Expanded mode exposes more context in one view.
- Match the selected Apex appearance, including Classic, Liquid, and Frost. Use the existing `--phone-sheet`/panel, text, line, and accent variables. Opaque fallback must work with native Reduce Transparency. Respect Reduce Motion and safe areas. No animated backdrop or blur per thumbnail.
- Controls have at least 44×44 CSS-pixel hit areas; ordinary labels are 16px, secondary labels 13px. Cards use 16px corners, 12px gaps, and 16px horizontal panel padding. Preserve readable focus and disabled states.

## Behavior and safety

- All three pickers share the current attachment read/draft pipeline. Capture the destination draft before opening the picker; navigation, draft-to-thread migration, cancellation, read failure, or removing one attachment must not lose text or send files elsewhere. Clear each input after reading so the same file can be chosen again.
- Create/revoke object URLs only for selected image previews, clean them up when removed or unmounted, and do not start host uploads until Send. No native plugin or new dependency is needed for the pickers.
- Project/Machine delegate to `openSheet("project")` and `openSheet("where")`, retaining the existing move/fork protections. Tools delegates to `openSheet("tools")`. None of these actions sends a message.
- Plan mode uses the host's existing `roomSetPlan` for an existing thread. Await its acknowledgement, show pending/error/disabled reasons, and respect access/connection restrictions. For a not-yet-created draft, remember its Plan preference locally and apply it after room creation and before the first post; a refused Plan change must leave the message unsent and its draft intact. Stop-planning and incoming `plan_changed` events stay authoritative for existing rooms.
- On close, restore focus to + without reopening the keyboard. Opening the panel dismisses the software keyboard. Trap keyboard focus within the dialog, support Escape/backdrop close, and keep underlying chat inert. A new opening starts compact. The destination changing while the panel is open closes it.
- No fake Permission/Research/Memory/Skills/Goal controls. No new account/security permissions, photo-library indexing, broader shell access, TestFlight upload, DMG build, remote deploy, merge, or push in this task.

## Acceptance

The compact and expanded panel must be inspected in the actual simulator with Classic, Liquid, and Frost. Files, Tools, Plan, Project, and Machine must use real app callbacks. Tests must cover drag-vs-scroll separation, attachment cancellation/destination races, Plan failure, and focus restoration. A parent review and TypeScript check precede integration; Luna reports its commits and evidence without claiming a merge or release.
