# Continue a direct work request after a premature final reply

## User outcome

When a person asks a single work agent to perform a concrete action, an announcement such as “I’ll run the tests now” should lead to the promised action without another user message. A plan request is complete when the agent supplies the requested plan. A worker awaiting permission stays under the existing approval flow.

## Parallel handoff

1. **Luna — eligibility and intent.** Implement a pure decision function in `apex-core` taking the original direct request and the proposed final reply. Return the unfinished step only for an explicit commitment supported by that request. Cover ordinary completions, optional offers, informational requests, quoted examples, restrictions and ambiguous language. Prefer leaving ambiguous replies alone. Supply unit tests and document the language coverage.
2. **Luna — execution.** Trace the host’s direct room post through participant dispatch, progress handling and settlement. Capture eligibility when the human addresses one worker. Inspect the recorded progress before deciding to continue. Preserve the same participant, working directory, access, approvals, usage and cancellation. Give the participant one internal continuation and keep the user transcript accurate. A later stop, new user instruction or outstanding approval takes precedence. If the second response only promises the step again, name the outstanding action and end the turn.
3. **Luna — acceptance.** Exercise the normal direct posting entry point with a scripted participant. Observe invocation count, work events, terminal reply and human messages independently. Cover a promised action that executes on the second invocation, another empty promise, planning or explanatory replies, and user intervention. Use synchronization for interruption tests. Record which scenarios were exercised.

## Integration and release

Review all three changes together, with particular attention to provider resume inputs, duplicate execution, usage accounting, streaming and cancellation at the follow-up boundary. Run the apex-core tests and `npx tsc --noEmit`. Commit only the handoff plan and scoped feature changes, merge to main and publish to origin. Production smoke test: address one work agent with a concrete test command, confirm that a promise-only response leads to the actual test result, and verify that the thread contains just the original human request. Repeat with Plan enabled and with Stop during the turn.

## Implemented scope and smoke test

The runtime checks the first wave of a direct text post in a Work room. It accepts an explicit English commitment ending in the same authorized action, including a step from a coordinated request. It declines uncertain matches, command/tool replays, and turns that entered the approval or question flow. Providers that omit work events give the host less evidence. The additional invocation uses the same participant and turn lease. Both invocations count toward reported usage.

For a controlled production check, use a disposable Work thread and ask one worker to run `git status --short`. If it ends its first response with “I’ll run `git status --short` now,” expect a Continuing activity, one command result and one human message. If the worker executes immediately, that verifies the ordinary path only. The deterministic Rust test exercises the premature-stop path with a scripted participant.
