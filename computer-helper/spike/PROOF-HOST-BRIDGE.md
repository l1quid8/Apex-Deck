# Supervised installed-host Stop bridge

This is a proof-only connection to the already installed local Deck daemon. It
does not implement authenticated production computer sessions or the Task 4
lifecycle integration. The Task 4 Human gate still applies before broad rollout.

For the supervised model relay, the operator supplies all three environment
values before launching the relay:

```text
APEX_COMPUTER_PROOF_ROOM=pane-mvwz3alu-1
APEX_COMPUTER_PROOF_PARTICIPANT=dsfoe
APEX_COMPUTER_PROOF_HOST_SOCKET=/Users/tylercaldwell/Library/Application Support/dev.apexdeck.app/daemon.sock
```

The participant is its saved ID (`dsfoe`), not the display name (`Ds4`). Partial,
empty, malformed, relative-socket, or overlong configuration refuses locally.
With no proof environment, the original isolated spike behavior remains.

Before forwarding MCP initialization, the relay sends the unadvertised operator
method `spike/bind-proof` with those exact values to the helper. The helper
connects to the local Unix socket, completes protocol-1 `hello`, and stays
stopped. This operator binding is a local proof convention, not authentication;
it must not be presented as a production authorization boundary.

The Human still chooses **Start new isolated run** in the helper menu. No daemon
event starts or enables input. A separate native reader handles daemon events
independently of the action queue, AX reads, and relay output backpressure.

For the exact bound room:

- `participant_idle` or `failed` for the bound participant stops the helper.
- `stopped` or `idle` stops it room-wide; an explicit participant ID must match.
- A paused, completed, or ended runner snapshot stops it when its workers or
  checker include the bound participant. A null runner snapshot also stops it:
  the existing daemon emits that when Stop is pressed in a room with no runner.
- Host EOF, malformed/oversized frames, event sequence gaps, rejected/silent
  hello, and relay disconnect stop the helper.

Host frames are bounded to 32 MiB per line, matching the local daemon protocol.
Event bodies are read transiently and are never logged, persisted, or forwarded
to the model. The bridge uses native sockets and threads, without child scripts.
It never reconnects automatically. A terminal binding cannot be reenabled by
later events or by the menu; a fresh relay binding and Human menu Start are
required for the next supervised run.

The installed protocol also emits a null runner snapshot immediately before a
new Human post in a room with no runner. Therefore this one-turn proof binds
the relay during the chosen model turn, after that post, and the Human then
chooses menu Start. Do not prewarm a bound relay and reuse it across later posts:
the null snapshot intentionally fails closed. The production lifecycle work
must replace this ambiguous event convention with exact session/turn ownership.

The helper menu's **STOP** first latches Stop synchronously, then sends the
existing local `room_stop` command with exactly
`{"id":"pane-mvwz3alu-1","participant":"dsfoe"}`. This reaches the installed
host's normal cancellation and runner pause behavior for `/goal` and `/loop`.
Normal turn completion and host events only stop the helper; they do not echo
`room_stop`. The bridge sends at most one explicit menu Stop command per binding.

`spike/status` also reports `screenCaptureAccess` using the nonprompting
`CGPreflightScreenCaptureAccess()` check. It does not request permission or
capture an image.
