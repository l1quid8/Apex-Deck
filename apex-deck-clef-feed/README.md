# Clef observation feed

Temporary read-only Apex Deck mod. In Settings → Mods, add this folder,
grant only “Run programs on this Mac”, and enable it. Type `/clef` to
open the side panel; the status badge menu can open or close it too.
No restart is required. Remove it in Settings → Mods when finished.

Reads the configured local data directory using only `/usr/bin/stat`
and `/bin/cat`, with a five-second timeout. Polls never overlap.
The log is checked every two seconds; observer settings and thread names
every ten seconds. No network calls or routing hooks are registered.
Agreement with Deck is not a correctness score. Awaiting-human scores
are deliberately omitted. Thinking observations are excluded from routing totals
and the routing feed. A separate Thinking recommendations section shows the
latest picks, confidence, agent, backup level, log-only status, errors and stale checks.

Message snippets require a human message with an `at` timestamp within
five minutes before the observation; otherwise the row shows “message #N”.
Missing snippets retry for two minutes.
If Deck truncates command output, the panel reports an error rather than
silently displaying incomplete totals. Polling reads the entire log when
its size changes; this is intended for the temporary observation trial.

Run tests:

```sh
node --experimental-strip-types --test tests/*.test.mjs
```

The runtime tests use the parent Apex Deck checkout.
