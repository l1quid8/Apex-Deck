# Alfred: Apex Assistant upgrade

## Intent

Let the user talk or type to their existing personal assistant, Alfred, to understand screenshots, follow and direct work in existing shared chats, and operate supported apps through Apex Unified Computer Use. Keep one conversation rather than a task-management dashboard. The personal assistant was renamed from Jigga by the user; the coding participant named Jigga is a separate identity and must remain unchanged.

## Agreed experience

- Preserve the existing assistant record, history, memory, granted projects, schedules, identity/avatar, provider profile and rule settings. Names are data, not keys. Do not hardcode Alfred into all users' defaults or create a replacement assistant.
- Reuse the approved conversation-first preview in the originating Codex chat: familiar Deck composer, 60px centered session strip, avatar opens Details, secondary controls on hover/focus, true-black Dark mode, complete settings inventory behind named/collapsible groups.
- Screenshot attachments must become real multimodal content for capable providers, rather than bare file paths. Text-only destinations get an invocation warning and keep accessibility/text coordination available. Never pretend a provider sees images it cannot receive.
- Support the existing Local voice route and GPT-Live for this same assistant conversation. Saved engine/layout/voice settings must be clear; ending a call must not stop underlying work. Mute controls input without cancelling work or speech output.
- Alfred can inspect permitted existing project chats, read fresh progress and send authorized instructions to selected participants, retaining each chat's shared participants/history. Questions and hypothetical examples do not create work. Explicit actions continue inside existing grants without repeated confirmation. Materially ambiguous scope gets one concise clarification.
- UCU uses Apex's existing engine and model adapters, global enablement and per-conversation app access. Do not add another per-agent master checkbox. Reuse the current assistant browser/profile for background browsing. Do not move the user's pointer, steal focus, type into their foreground app, or silently switch to a foreground fallback.
- Optional native draggable window can stay above other apps, with compact new-conversation, mute/end and return-to-Deck controls. It shares transcript, draft, call, assistant identity and grants with Deck. Returning/docking or reopening must not duplicate a model turn or create a second microphone session.
- Preserve all existing agent settings: model/provider/effort, image capability, access/projects, preferences, budget/privacy/costs, local voices/call layouts, memory/notebooks, connections, rules, schedules, notices, avatar and removal/recovery. Explain scope and conflicting access ceilings in place. Unsupported runtime reset/compaction remains accurately described until implemented.

## Architecture and constraints

Build in the existing React/TypeScript, Electron, Rust host/adapters and signed UCU helper. Reuse existing attachment validation, voice coordinator/bridge, assistant registry/draft state, room routing, task lineage, grants and browser takeover controls. Do not copy the mockup's deterministic intent router into production: it is a demonstration, not a language-understanding engine.

Assistant id plus host id remains the authority boundary. Validate ownership, current project binding, room identity and capabilities in the host. A model-supplied room id, screenshot path, title or tool text is never authority. Untrusted room/tool content cannot grant access or authorize messages. Cancellation must revoke a running operation before any further mutation, and delivered/uncertain actions must never be blindly replayed after restart.

The UCU release continues independently in its current checkout. This feature branch must not merge, repackage, install or restart that release. Integrate the verified UCU version before final Alfred packaging. No broad dependency upgrades or redesign of unrelated global Settings.

## Verification and delivery

Use a small set of existing focused tests for actual boundaries and regressions, plus TypeScript and Rust checks appropriate to changed modules. No mirrored implementation tests or large new test-file collection. No live credential/provider calls during implementation. Once a candidate is authorized for installation, use controlled harmless installed-app exchanges to verify image understanding, voice, delegated chat follow-through and background operation; compilation or mockup simulation alone is not completion.

## Engineering decisions

Implement in order: attachment delivery, conversational chat coordination, assistant UCU capability, live voice, native floating presentation, then complete settings integration. Persist a single conversation and stable event ids; use existing durable room/task machinery rather than a new queue or bot-to-bot follow-up loop. Exact adapter/provider capability limits must be derived from code and surfaced honestly. Work may proceed in independent file scopes, but no parallel packaging or mutation of user chats during coding.
