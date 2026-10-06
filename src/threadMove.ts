// Bringing a thread to where it should run: a thread moved before it
// started, or a fork to another project or machine. The snapshot is
// imported there first, and the old copy goes only after that worked.

import type { Backend } from "./backend";
import type { RoomSnapshot } from "./types";

/** The host doesn't know `command`: an apex-daemon older than it. */
export function unsupported(error: unknown, command: string): boolean {
  return new RegExp(`unknown variant [\`'"]?${command}|unknown command.*${command}|unsupported.*${command}`, "i").test(String(error));
}

type Room = Pick<Backend, "roomImport" | "roomCreate" | "roomDelete">;

/**
 * Put thread `id` from `snapshot` on `to`, in folder `cwd`. On the same host
 * the room is replaced in one step; on another, the old copy is deleted after
 * the new one exists. An older helper without room_import can still take a
 * thread with no history: a fresh room with the same bots and options. On the
 * same host that room is deleted first, so if the new one can't be made it is
 * made again in `fromCwd`, where the thread still is.
 */
export async function placeThread({ from, to, id, snapshot, cwd, fromCwd, sameHost, hostName }: {
  from: Room; to: Room; id: string; snapshot: RoomSnapshot; cwd: string; fromCwd: string; sameHost: boolean; hostName: string;
}): Promise<"imported" | "recreated"> {
  let how: "imported" | "recreated" = "imported";
  try {
    await to.roomImport(id, snapshot, cwd, sameHost);
  } catch (error) {
    if (!unsupported(error, "room_import")) throw error;
    if (snapshot.transcript.length > 0) {
      throw new Error(`${hostName}'s apex-daemon is too old to take a thread's history. Update it there (docs/daemon-ubuntu.md).`);
    }
    if (sameHost) {
      try {
        await to.roomDelete(id);
        await to.roomCreate(id, snapshot.participants, snapshot.options, cwd);
      } catch (failed) {
        await to.roomCreate(id, snapshot.participants, snapshot.options, fromCwd).catch(() => {});
        throw failed;
      }
    } else {
      await to.roomCreate(id, snapshot.participants, snapshot.options, cwd);
    }
    how = "recreated";
  }
  if (!sameHost) await from.roomDelete(id).catch(() => {});
  return how;
}

/** A message in this history carried a file: its "Attached …:" line names a path on the old machine. */
export function historyHasAttachments(transcript: { text: string }[]): boolean {
  return transcript.some((m) => /^Attached (image|file|folder): /m.test(m.text));
}
