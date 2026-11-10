# Task 16 — desktop drop snapshot boundary

Implemented the authorized desktop/backend portion only. Multi-composer file state, chips, send planning and two-host delivery belong to the integration lane.

`DropSnapshot` is exported from `src/backend.ts`:

```ts
type DropSnapshot =
  | { kind: 'file'; name: string; bytes: Uint8Array }
  | { kind: 'folder'; name: string }
  | { kind: 'too-big'; name: string };
```

`Backend.snapshotDrop?(path)` delegates through Electron's shell on both local and remote thread backends. It reads the dropped file on this Mac; no host command or remote path read is involved. The browser-demo implementation rejects because there is no native dropped file.

The preload keeps a private map of real dropped paths and timestamps. It records paths before calling subscribers, lazily removes entries older than 60 seconds, and rejects other paths with `Only a file dropped on this window can be read.` Synthetic Files give no disk path and cannot add permission. Main's `shell:snapshotDrop` delegates to `snapshotFile(path, 20 * 1024 * 1024)`. That function stats first, returns folder/too-big before any content read, and otherwise reads once into owned bytes.

## Verification

- Real temp-file regression observed red before `snapshotFile` existed, then passed. It checks an actual folder without a trailing slash, a sparse 21 MB file with no content read, one small-file read, source overwrite/delete immutability, and a missing-path rejection naming the path.
- Preload and shell regressions observed red before the bridge existed, then passed. They cover arbitrary and synthetic paths, registration before subscriber callbacks, expiry after 60 seconds, renewed permission on another drop, and local/remote shell routing.
- The combined file/preload/shell run passed **18/18**: `~/.cache/jigga-review/task8c/task16-green-bridge.log`.
- A real Electron test with the production preload and the production main handler extracted from `desktop/main.mjs` passed **1/1**. DevTools `Input.dispatchDragEvent` with `data.files` produced a real path through `webUtils.getPathForFile`; its captured bytes matched the temp file. Overwrite/delete left the returned bytes unchanged. `/etc/hosts` and a synthetic DOM File were refused, and the native drop did not reach DOM drop handlers. `task8c/task16-electron.log`.
- `npx tsc --noEmit` passed at the Task 16 boundary (`task8c/task16-tsc.log`). A later integration run temporarily found App's new `tagThreads` prop before the ChatPane lane added its matching type; that is not a desktop-boundary error.

The Electron probe does not prove a multi-composer chip was sent or that a remote host saved the bytes. Those are integration/e2e assertions. No application daemon, production build, installer, commit or merge was started by this lane.
