# iPhone 1.1 (16)

Source: `bb454f3`, merged into `main` after independent TypeScript and full JavaScript verification (1,465 passing). The composer pointer fixture was made independent of layout-animation timing; product assertions and real pointer input remain.

Includes the compact/expanded composer panel, Camera/Photos/Files access, image previews, acknowledged Plan switching, and one Project shortcut with machine choices in its submenu. The Where this runs sheet now groups Project and Machine choices, highlights the current machine, and uses shorter guidance. The unavailable no-project placeholder was removed.

Signed Release archive: `/Users/tylercaldwell/Downloads/apex-deck/release/ios/Apex-Deck_1.1_16.xcarchive`. Bundle `dev.apexdeck.phone`, version `1.1`, build `16`. Strict/deep signature verification passes; all 13 web assets match `dist-phone` by SHA-256.

Apple returned `Upload succeeded` and Xcode export exited 0 on October 15, 2026 at 22:33 PDT. Processing completed. The signed-in TestFlight app showed version 1.1, Build 16, 16.5 MB, with an Install button. App Store Connect lists it as Ready to Submit with internal group beta; this is available internal testing, not a claim of external beta review approval.

At the user's request, all 15 older active builds were explicitly expired after retaining Build 15 until Build 16 was available. Fresh read-back across both version sections confirms Build 16 is the only active build. The 16 expired historical builds are 1.1 builds 3–15 and 1.0 builds 1010.16.1, 2, and 1 (Build 1 was already expired). The external group had previously used Build 9; it is now expired along with the other older builds. No external beta review was submitted in this task.

Verification screenshot: `/Users/tylercaldwell/Downloads/apex-deck/release/ios/logs-1.1-16/testflight-builds-verified.png`.

Logs, export options, and asset manifest are under `/Users/tylercaldwell/Downloads/apex-deck/release/ios/`. An initial export failed before upload because Apple's rsync launched the incompatible Homebrew rsync server from PATH. Export succeeded with system tools first in PATH; the same verified archive was reused.

The merged task branch was deleted. Its managed worktree remains detached because Codex refused archival while it is protected by a pinned task/workspace. The separate ios-sim-upgrade worktree and the primary checkout's four pre-existing untracked files were preserved. Git remotes and the macOS DMG were not changed.
