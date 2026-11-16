# Global Apex Code Mode implementation plan

Goal: implement the approved General Auto / Off mockup for API, Claude Code and Codex agents.

Design: persist `apexCodeMode` (`auto` by default, or `off`) with app settings. A host-wide policy shared by adapters removes the tool and guidance when Off, rejects stale invocations, and interrupts active batches and pending approvals. Completed writes remain; ordinary tools retain their permissions. Phone edits explicitly target a connected machine, require Full access, and acknowledge the host save.

- [x] Add failing settings and adapter regressions for defaults, Off, stale calls and active approval cancellation.
- [x] Wire persistence and shared policy into API tool menus, execution and CLI MCP setup.
- [x] Add General controls, search catalog entry and authorized phone machine control.
- [x] Run TypeScript, JavaScript and Rust checks and record limitations. No installer or Git operations in this agent copy.
