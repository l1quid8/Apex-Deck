# Mac channel icons and local installer rebuild

User request: retain only the intended Stable, Nightly and Dev entries in Spotlight, preserve archived builds, reuse the iOS Nightly icon colors on Mac, give Dev a monochrome icon, and rebuild clearly labeled Stable/Nightly installers under `/Users/tylercaldwell/Downloads/apex-deck/release`.

Use latest fetched `origin/main` (b8fee741) in an isolated task worktree. Preserve the dirty main checkout. Reuse the tracked iOS Nightly PNG via an ICNS conversion and the existing approved monochrome branding kit for Dev; leave Stable unchanged. Add only Nightly's `mac.icon` override and Dev's pre-sign icon/display-name overrides. Retain all bundle IDs, filenames, services and trust identities.

A second agent reviewed this plan and confirmed existing channel-aware packaging should be reused. Do not invoke publication commands. Run Stable/Nightly sequentially, preserve previous root installers, and copy only verified final artifacts to the requested release root. Pin the real source commit into each UI and daemon; Nightly also gets a positive increasing local build number. Verify types, scoped packaging/channel tests, signatures, channel stamps, DMG integrity and package readbacks.

Spotlight changes are separate reversible exclusions of archived, staging, Trash and protected runtime paths, with intended launchers kept visible. Never mutate signed bundle contents, delete unique builds, rename protected roots, or disable indexing for a volume. Verify the actual search results. Installed icon updates require the normal signed installation process; rebuilding an installer alone is not installation.
