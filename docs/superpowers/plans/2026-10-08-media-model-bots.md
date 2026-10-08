# Pick-any-model bots: image and video (Venice first)

**Goal:** a custom-provider bot can use an image or video model as its model. Pick it in the bot's model menu, type, and get back whatever that model makes. No commands, no tools.

**Scope for v1:** Venice image models (generate + edit) and Venice video models (Seedance 2.5 first, the rest of the video list works through the same path). Text bots are unchanged. Other providers keep text-only until they get their own adapter.

## What the user sees

1. **Model menu shows every model, grouped Text / Image / Video.** Each row keeps its readable name. Image rows show the price per picture, video rows show "price on send".
2. **The settings panel follows the model kind.**
   - Text: unchanged (reasoning slider, ctx, price per million).
   - Image: aspect ratio, resolution / quality where the model lists them. No reasoning slider, no ctx bar.
   - Video: length, resolution, shape (from the model's own lists), sound on/off. Defaults: shortest length the model allows that is at least 5 s, 720p, 16:9, sound on.
3. **Send shows the price** for media bots: `Send · ~$0.04`. Video prices come from Venice's quote endpoint, refreshed when settings change. Anything over **$1** asks once ("This video costs about $1.80. Make it?").
4. **While a video is being made** the bot's work line shows `Making video · 0:53 of ~2:25` using Venice's own timing numbers. Stop cancels it.
5. **The result lands in the chat as a playable picture or video**, and in the Library. The reply line says what was sent: model, settings, cost.
6. **Attachments just work.** Image bot + attached picture → edit that picture. Seedance text-to-video + attached picture → switches to its image-to-video sibling automatically.
7. **"Keep going" prompts.** Media models have no memory, so each reply records the full description it used. A new message is sent as *previous description + "Change: <new message>"* when **Build on last** is on. That's a small chip by the composer, on by default for media bots, off after a fresh topic is started with it unticked.
8. **Clear errors:** no key, key refused, out of balance (402), content refused (422), model needs consent (409), each with a one-line "what to do".

## How it's built

### 1. Model list knows the kind (Rust, `apex-adapters/src/api_info.rs`)
- Stop dropping non-text entries at `api_info.rs:45`. Add `kind: Text | Image | Video` to `ApiModel`, plus `media: Option<MediaSpec>` read from `model_spec.constraints` (aspect ratios, resolutions, durations, qualities, audio, `model_type`) and image `pricing` (flat or per resolution / quality).
- Ask Venice for `?type=all` (it sends text only by default). Embeddings, music, speech, upscale etc. stay filtered out.
- Keep the 10-minute cache. Mirror the new fields in `src/types.ts` `ApiModel`.

### 2. Media participant (Rust, new `apex-adapters/src/media.rs`)
`OpenAiCompatParticipant::respond_with_progress` checks the model's kind first and hands image/video turns to `media.rs`. Same key lookup (`keys::lookup`), same `Reply` (text + `cost_micros`), so usage and balance meters keep working.
- **Image:** `POST /image/generate` (or `/image/edit` with the attached picture as base64). Save the bytes into the room's attachment folder, import into the Library, reply with the file line + cost from the model's listed price.
- **Video:** `POST /video/quote` → `POST /video/queue` → poll `POST /video/retrieve` every 5 s, emitting `Progress::Activity` with elapsed / expected time. Handle both answers Venice can give when done (raw mp4 or JSON with `download_url`), download straight away (links expire), then `POST /video/complete` to clean up. Cost = the quote.
- **Stop:** dropping the turn stops polling and calls `/video/complete`. Venice may still bill a job that already started; the stop message says so.
- **Prompt building:** previous description from the thread's last media reply + the new message when Build on last is on. Respect the model's prompt character limit.
- **Settings** (length, resolution, shape, audio, aspect) live on the bot like reasoning does today, and are sent only when the model lists them (Venice rejects unknown fields).

### 3. Library takes video (`apex-host/src/reply_images.rs`)
`import` and `list` accept mp4 / mov / webm. Library grid shows a poster frame with a play badge.

### 4. Chat shows media (`src/ChatPane.tsx`)
Attachment lines ending in an image or video extension render inline: picture, or a `<video controls>` player. Phone gets the same in the iPhone wrapper.

### 5. Settings + composer (`src/BotSettings.tsx`, `src/ChatPane.tsx`)
- Grouped model menu with Text / Image / Video headers, filter box as today.
- Kind-specific controls (above). Picking a media model hides reasoning and ctx.
- Send label with price, the over-$1 confirm, the Build on last chip.
- New command `api_quote` through `commandBackend.ts` → `command.rs` for video prices.

### 6. Tests
- Parse real trimmed Venice entries (Flux 2 Pro, Seedance 2.5 US) into the right kind and specs.
- Fake-server tests for image generate, image edit, and the full video quote → queue → processing ×2 → done flow (both done shapes), plus 402 / 422 / 409 / expired-link errors and Stop.
- UI tests for the grouped menu, kind-specific settings, Send price and the confirm.
- **Live checks cost real money**, so they wait for your OK: one cheap image (about $0.03) and one shortest, lowest-resolution Seedance clip, quoted first.

### 7. Helpers keep working after the reply (Claude Code bots)
A bot's helper agents (Claude Code's background Agent tool) were killed when its turn ended: Deck closed the program's input and force-quit it 5 seconds later (`claude_session.rs`). Probed 2026-10-08: with its input left open, Claude Code starts a follow-up turn by itself when a helper finishes, and reports running helpers in `background_tasks_changed` events.
- `events.rs` counts running helper agents from those events (background shells such as dev servers don't count, since they can run for ever).
- `claude_session.rs`: a `result` with helpers still running keeps the input open and the reply going. The work line shows `2 helpers still working · 3 min`, refreshed every 30 s, which also keeps the 15-minute silence limit from stopping it. The follow-up turn's text is added to the reply.
- Limit: 30 minutes of waiting, then the reply is handed in with a note saying so. Stop ends it at any time.
- Codex bots: not covered; Codex has its own helper model and needs a separate check.

## Order of work
1. Model list kinds + specs (Rust + types). 2. Image path end to end. 3. Video path end to end. 4. Chat + Library playback. 5. Settings, Send price, confirm, Build on last. 6. Phone playback. 7. Screenshots offscreen before install.

Helpers: one Haiku on the Rust media path + tests, one on the UI, me on the model list, review and wiring. Null reviews before install.

## Decisions (Human, 2026-10-08)
1. Ask before anything over **$1**: yes.
2. **Build on last** on by default: yes.
3. Video defaults: **5 s, 720p, 16:9, sound on** (Seedance 2.5 quotes $1.44 for that, so default clips ask first).
4. Live test spend under $1: yes. Spent $0.54 (one Flux 2 Pro picture $0.03, one 4 s 480p silent Seedance 2.5 clip $0.51).

## Not in v1
- Image and video for OpenAI, Grok and OpenRouter (each needs its own adapter).
- Music, speech and upscale models.
- One bot that both chats and makes media (the tool approach can sit on top later).
- Hetzner: same code, installed separately when you say so.
