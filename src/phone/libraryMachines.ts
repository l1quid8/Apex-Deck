import type { Backend, LibraryItem } from "../backend";
import type { PhoneHost } from "../phoneBackend";
import type { RemoteAccess } from "../phoneRules";
import { listLibrary, loadOutcome, machineNote } from "../library.ts";
import { canSeeLibrary, libraryErrorLine } from "./libraryRules.ts";

/** One paired machine as the phone's Library sees it. */
export interface PhoneLibraryMachine {
  id: string;
  name: string;
  backend: Backend;
  connection: PhoneHost["connection"];
  access: () => RemoteAccess | null | undefined;
}

/**
 * Lists one machine's pictures. The access check runs once the connection is ready,
 * just before library_list is sent, so a machine that changed access since hello is refused.
 */
export function listPhoneLibrary(machine: PhoneLibraryMachine, ms = 20000): Promise<LibraryItem[]> {
  const source = {
    libraryList: () => canSeeLibrary(machine.access())
      ? machine.backend.libraryList()
      : Promise.reject(new Error("needs Full access to all threads")),
    host: { connection: machine.connection },
  };
  return listLibrary(source, ms);
}

/** The line shown for a machine whose pictures couldn't be listed. Access problems get the plain fix. */
export function phoneLibraryNote(name: string, error: unknown): string | null {
  const message = String((error as Error)?.message ?? error);
  const outcome = /connection to the host was lost/i.test(message) ? { kind: "offline" as const } : loadOutcome(error);
  if (outcome.kind === "failed") return libraryErrorLine(error, name);
  return machineNote(name, outcome);
}
