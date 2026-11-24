# Windows Stable and Nightly interactive acceptance

Run on a disposable Windows 11 VM, signed in as the same ordinary user for both apps. Record the installer hashes, source commits, build numbers, Windows version and user SID. Use empty local project folders inside the VM. The scripted agent preset works offline.

## Default folders, upgrades and Nightly removal

1. Launch both apps from their own Start menu shortcuts with the default data folders. In each app, add a different local project folder. Under **Threads**, use the project's **New thread** action. Choose **Add agent**, **More options**, then **Scripted** (shown with “Canned replies for testing”). Give it a name and select **Add to chat**. Post a unique marker, such as `stable-initial-<run>` or `nightly-initial-<run>`. Wait for each marker to appear in its transcript. Record the title, marker and owning channel.
2. Quit both UIs completely. Relaunch both from their shortcuts. Open each saved thread and check its transcript. Search both apps for both markers. Each app must recover its own marker, and a search for the other channel's marker must yield no match.
3. Leave Stable open while upgrading Nightly to its higher build. In that same Stable window, post a new unique marker to the original thread and wait for it to appear. In the upgraded Nightly, open its original thread and post a different marker. Quit and relaunch both apps and check that both transcripts retain their respective messages. Record the results and installed versions.
4. Leave Stable open and record its main UI PID. Uninstall Nightly with its own uninstaller and keep the default user data. From the same Stable window, post a fresh marker to the original thread. Reinstall Nightly, confirm its earlier markers and post a fresh Nightly marker. In the still-open Stable window, post one more marker after the reinstall and verify its PID. Quit and relaunch both apps. Repeat the transcript and search checks from step 2 for the new markers.
5. Repeat step 3 with Nightly left open while upgrading Stable. Use fresh messages in both apps and repeat the relaunch and isolation checks. Save screenshots of the app versions and the recovered transcripts. Record each installer transition, the surviving window's PID, submitted markers, own-channel search hits and opposite-channel misses.

## Receipt evidence

Record the source commit and results of the verifier tests for a mismatched signing key and for a signature covering the other channel's domain. Record a separate same-channel control for each installed app using a fresh post that survives relaunch. An installed cross-channel receipt rejection is a separate observation and remains pending.
