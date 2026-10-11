# Image delivery to bots

The composer still saves attachment paths in message text, so thumbnails and the
Library use the same files. The adapters now load images from unseen messages
and send image inputs alongside that text. This includes new images produced
by other bots, so participants can inspect generated pictures in group chat:

| Bot | Image input |
| --- | --- |
| Claude Code | Stream-JSON user content with base64 image source blocks |
| Codex | App-server `turn/start` image inputs containing data URLs |
| OpenAI-compatible API chat, including Venice chat | Chat-completions `image_url` content parts containing data URLs |
| Grok | ACP image content blocks in a private `.json` prompt file |
| Gemini | Staged image references expanded by the CLI's headless `@path` processor; staging folder added to include-directories |

Venice image editing and video generation reuse the same MIME/base64 loader.
Existing paths remain in text history. Earlier image bytes are not automatically
resent on later turns; attach the image again for a follow-up that needs visual
inspection, especially with API bots that cannot open local files.

The native inputs support PNG, JPEG, GIF and WebP, with at most 10 images,
20 MB per image and 32 MB combined per turn. Other formats, missing files and
oversized images produce a clear error rather than silently sending only a path.
The selected model/provider must support image input. Arbitrary custom CLI
commands have no defined image protocol and reject image turns explicitly.

Grok/Gemini staging directories are private on Unix and removed when the turn
finishes or is cancelled. Image payloads are never passed in command arguments.

Regression tests capture requests sent to stand-in Claude, Codex, Grok and
Gemini processes plus a local HTTP server, checking native input and cleanup.
These tests verify Deck's transport; they do not establish live inference with
every provider/version. Gemini was not installed during implementation.

Protocol references:

- [Grok prompt-file JSON parser](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/headless/cli.rs)
- [ACP image content schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)
- [Gemini headless input processing](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/nonInteractiveCli.ts)
- [Gemini image loading](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/fileUtils.ts)
- Codex schema verified against the installed CLI's `app-server generate-json-schema` output.
