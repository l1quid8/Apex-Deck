# Voice pipeline integration (lead review and state machine)

Found while reviewing the sidecar and client commits, each with a test that failed first:

- Stall recovery reset credits and sent past the player's five-second buffer, which raised "Voice playback overloaded" and ended the call. The sidecar now waits; a cancel frees it. No audio is lost.
- A start of speech with under 6 voiced frames produced no later event, so a paused reply would hang. It now sends `transcriptRejected` reason `tooShort`.
- The low-energy check read the last frame, which is the silence that ended the speech. It now uses the utterance peak.
- The echo filter matched any recent agent text with no agent audio playing, so answering "yes" to "say yes or cancel" was rejected. It now applies only to speech that started over agent audio.
- `voiceLog` lines never reached the log file, and audio lines were written per frame. They are now persisted, with `audioChunk` sampled about once a second and per-chunk lines removed.
- Overflow events sent as `transcriptRejected` mid-speech would have resumed a paused reply. They are log-only.
- Meta's `speechEnd` set "waiting" with no turn, which left working dots stuck after noise. Status now stays "hearing" until the verdict.

## State machine

`src/voice/callFlow.ts` owns live call status for the Local and Meta engines. Inputs: speech start, rejected, confirmed; turn start and end; spoken, playing, drained, dropped, flushed; attention. Every change logs `stateTransition` with its cause. GPT-Live keeps its own event-to-status mapping and uses a CSS wave, because its audio does not pass through the playback worklet.

## Not proven

No installed-app run. Ten long replies, first-word capture on interruption, 30 minutes muted, and route/sleep recovery are all untested in the real app.
