# GPT-Live calls — plan (Jigga → Muck builds, Null reviews, Human tests)

Rules: branch `feat/gpt-live-calls` in ~/Downloads/apex-deck (no worktree folders), local commits only,
no push, no installer. `npx tsc --noEmit` + daemon/app tests before handing to Null.

## Shape

GPT-Live is a second **call engine** next to the local Whisper→agent→Kokoro engine. Same call UI
(Bar/Pill/Top bar, mute, end, "Call who?", pop-out). Only the audio path changes:

```
mic ──WebRTC──► OpenAI Realtime (GPT-Live voice)
                   │ tool call: ask_agent({agent, request})
                   ▼
            existing ThreadVoiceBridge (src/voice/threadBridge.ts)
            → posts the request into the thread as a Human voice turn
            → Deck agent runs with its own history + tools (unchanged)
            → reply text returned as function_call_output
                   ▼
            GPT-Live speaks the result (may paraphrase; told to stay close)
```

The agent's reply is saved in the thread exactly as today. GPT-Live's own small talk is not saved
as an agent message (it shows in the call transcript only).

## Key rule: the API key never reaches the page

1. Settings → Calls: "OpenAI API key" box using the existing store
   (`ApiKeyStatus/ApiKeySave/ApiKeyRemove`, name `OPENAI_API_KEY`, `apex_adapters::keys`). Show saved/not saved,
   never echo the key.
2. New daemon command `VoiceRealtimeSession { room, participant? }` → daemon reads the key with
   `keys::lookup`, calls OpenAI's client-secret endpoint, returns only the short-lived secret + model + expiry.
   Session config (instructions, tools, voice) is set server-side here.
3. Page opens WebRTC with that short-lived secret. Look up the current endpoint, model id and voice
   names in OpenAI's Realtime docs — do not guess them; write what you used into this file.

## Tasks

1. **Engine setting** — `Calls → Engine: Local (default) | GPT-Live`. GPT-Live disabled with
   "Add an OpenAI key" hint when no key. Synced to pop-outs like the other call settings (b72b53f path).
2. **Daemon secret command** (Rust, `crates/apex-daemon/src/voice/realtime.rs` + command wiring).
   Errors are plain: no key / key rejected / network. Tests with a fake HTTP server; never log the key or secret.
3. **Instructions + tools** built per call: list the thread's agents (handle + one-line role);
   tool `ask_agent(agent, request)`; tool `stop_agent(agent)` mapping to existing per-reply Stop.
   Default target = the agent the call was started with ("Call Jigga"); spoken "ask Null…" picks another.
4. **Client engine** `src/voice/realtimeClient.ts` beside `localClient.ts`/`serverClient.ts`:
   WebRTC peer, mic track, remote audio element, data channel events. Tool calls go through
   `createThreadVoiceBridge().enqueue`; wait for `participant_idle`, send the agent's final reply text
   as the tool output, then `response.create`. Long agent work: GPT-Live says once that it's working,
   then stays quiet (no automatic "On it." spam — Human rule).
5. **Behaviour parity** — mute = mic track off only; end/switch call = close peer, never cancel agent
   work (same as `3d93e7d`); barge-in = GPT-Live audio stops, agent keeps going.
6. **Electron** — check CSP/connect-src allows the OpenAI realtime host for main + pop-out windows;
   mic permission path already covers pop-outs (`99a962c`).
7. **Phone** — out of scope for this round unless trivial; leave the setting hidden on iPhone.

## Done means

- tsc + all tests pass; fake-server tests for task 2; unit tests for tool-call → bridge → output.
- Dev build (AGENTS.md command) call with a real key: speak, GPT-Live answers, "ask <agent> to …"
  lands in the thread, agent uses tools, result spoken back; mute/end mid-task keep the agent working.
- Null reviews the branch, then the Human tests. Merge only on the Human's go.

## Implementation notes (2026-10-29, Muck)

OpenAI Realtime docs checked 2026-10-29 via web search + GitHub:
- **Endpoint for WebRTC**: `POST https://api.openai.com/v1/realtime/calls?model=<model>` with `Authorization: Bearer <ephemeral>` and `Content-Type: application/sdp`, body = offer SDP, response = answer SDP. Verified in minimal-realtime-kit research doc and OpenAI examples.
- **Ephemeral mint endpoint**: `POST https://api.openai.com/v1/realtime/sessions` with `Authorization: Bearer <api_key>`; returns `{ client_secret: { value, expires_at }, model, id }`.
- **Model**: used `gpt-realtime` as default GA model (also seen `gpt-realtime-2.1`, `gpt-realtime-mini` in docs). Daemon default `gpt-realtime`, overridable per request.
- **Voices**: `alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar` – current list per docs. Default `verse` for GPT-Live (sounds natural). Daemon validates against this list.
- **Data channel**: name `oai-events`, carries `session.update`, `response.create`, `conversation.item.create` with `function_call_output`.
- Code paths: daemon `voice/realtime.rs` mints ephemeral, never logs key or secret; client `realtimeClient.ts` does WebRTC + tool delegation via `ThreadVoiceBridge`.

## Owed by Human

An OpenAI API key with Realtime access, pasted into Settings → Calls (not into chat).
