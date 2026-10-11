# ApexAgent Chat, Tasks, Notifications

Approved design: Chat | Tasks | Notifications; needs-you cards and actions in Notifications; message reply and emoji reaction icons; + files, folders, tools, commands and mentions. Mac and iPhone share the surface. Reactions persist on their owning host.

Global constraints: preserve all preexisting dirty workspace changes; no VPS changes; no TestFlight upload or rebuild of existing build 5; no commits or pushes in this task. Quote only the chosen bounded message, keep same conversation lane. Preserve current task approval checks and draft destination.

1. Notifications: separate tab, count, actionable project findings, personal approvals/schedules/notices. Chat has messages and task links only. Test scoped actions, filters, drafts and old state.
2. Message actions: authenticated host-backed reaction toggle, persisted readback on restart, unknown message rejection; shared icons and bounded quote/reply. Test personal and monitor persistence and frontend failure behavior.
3. Composer: reuse existing + capabilities, correct-host attachments, supported command callbacks, mentions, tools; keyboard and phone-safe layout. Test failures and attachment send guard.
4. Integration: independent diff review, frontend suite, typecheck, production Mac/phone UI builds, Rust scoped tests; fixture screenshots at Mac and 375/393 phone widths. Integrate only changed paths after matching baseline hashes, preserve concurrent modifications.

Progress: three Luna helpers dispatched in isolated snapshot. Controller reviews final diff and verifies cross-feature behavior. No installation is implied by successful build checks.
