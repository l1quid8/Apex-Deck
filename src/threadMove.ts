// Bringing a thread to where it should run: a thread moved before it
// started, or a fork to another project or machine. The snapshot is
// imported there first, and the old copy goes only after that worked.

import type { Backend } from "./backend";
import type { RoomSnapshot } from "./types";

/** The host doesn't know `command`: an apex-daemon older than it. */
export function unsupported(error: unknown, command: string): boolean {
  return new RegExp(`unknown variant [\`'"]?${command}|unknown command.*${command}|unsupported.*${command}`, "i").test(String(error));
}

/** The thread can't go there and stays whole where it is; New thread there is offered instead. */
export class MoveRefused extends Error {}

/** An older helper can't put a thread in another folder on its machine without deleting it first, so it isn't asked to. */
export class FolderMoveUnsupported extends MoveRefused {
  constructor(hostName: string) {
    super(`${hostName}'s apex-daemon is too old to move a thread to another folder there.`);
  }
}

/** The machine still keeps a thread under this id: a copy an earlier move left there, whose delete never arrived. */
export class ThreadAlreadyThere extends MoveRefused {
  constructor(hostName: string) {
    super(`${hostName} still has an older saved copy of this thread, so it can't move there.`);
  }
}

type Room = Pick<Backend, "roomImport" | "roomCreate" | "roomDelete" | "artifactsLoad" | "artifactsSave" | "dataFolder" | "pathsExist">;

/** Whether `to` keeps a thread, or its artifacts, under `id`. Every apex-daemon saves them as "rooms/<hex id>.json" in its data folder. */
async function savedThere(to: Room, id: string): Promise<boolean> {
  const name = Array.from(new TextEncoder().encode(id), (b) => b.toString(16).padStart(2, "0")).join("");
  const room = `${await to.dataFolder()}/rooms/${name}`;
  return (await to.pathsExist([`${room}.json`, `${room}.artifacts.json`], null)).some(Boolean);
}

/**
 * Put thread `id` from `snapshot` on `to`, in folder `cwd`. On the same host
 * the room is replaced in one step and keeps its artifacts. On another, the
 * artifacts are saved there too, and only then is the old copy deleted. An
 * older helper without room_import can still take a thread with no history
 * or pins from another machine: a fresh room with the same bots and options.
 * It can't change a room's folder without deleting the room first, so a move
 * on its own machine throws FolderMoveUnsupported and nothing changes. A
 * machine that already keeps a thread under this id, left by an earlier move,
 * keeps it: ThreadAlreadyThere, before anything is made or deleted.
 */
export async function placeThread({ from, to, id, snapshot, cwd, sameHost, hostName }: {
  from: Room; to: Room; id: string; snapshot: RoomSnapshot; cwd: string; sameHost: boolean; hostName: string;
}): Promise<"imported" | "recreated"> {
  let how: "imported" | "recreated" = "imported";
  try {
    await to.roomImport(id, snapshot, cwd, sameHost);
  } catch (error) {
    if (/a thread with that id already exists/.test(String(error))) throw new ThreadAlreadyThere(hostName);
    if (!unsupported(error, "room_import")) throw error;
    if (sameHost) throw new FolderMoveUnsupported(hostName);
    if (snapshot.transcript.length > 0 || (snapshot.pins?.length ?? 0) > 0) {
      throw new Error(`${hostName}'s apex-daemon is too old to take a thread's history or pins. Update it there (docs/daemon-ubuntu.md).`);
    }
    // Its room_create opens a saved room of the same id as it is, with that room's bots and folder.
    if (await savedThere(to, id)) throw new ThreadAlreadyThere(hostName);
    await to.roomCreate(id, snapshot.participants, snapshot.options, cwd);
    how = "recreated";
  }
  if (sameHost) return how;
  try {
    const artifacts = await from.artifactsLoad(id);
    if (artifacts != null) await to.artifactsSave(id, artifacts);
  } catch (error) {
    // The copy there is new, so it goes; the thread stays whole where it was.
    await to.roomDelete(id).catch(() => {});
    throw error;
  }
  await from.roomDelete(id).catch(() => {});
  return how;
}

/** A message in this history carried a file: its "Attached …:" line names a path on the old machine. */
export function historyHasAttachments(transcript: { text: string }[]): boolean {
  return transcript.some((m) => /^Attached (image|file|folder): /m.test(m.text));
}
