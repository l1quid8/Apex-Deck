// The phone's half of Backend: what belongs to the device in your hand.
// Closing it does not stop work on the Mac or a server. Reveal in Finder,
// a new window, and the desktop file dialogs are not here.

import type { Shell } from "./commandBackend.ts";
import type { PathRequest } from "./typedPath.ts";

export function phoneShell(options: {
  machineName: string;
  ask?: (request: PathRequest) => Promise<string | null>;
  openExternal?: (url: string) => void;
  download?: (name: string, contents: string) => Promise<string>;
}): Shell {
  const ask = options.ask ?? (async () => { throw new Error(`Choose a folder on ${options.machineName}.`); });
  const download = options.download ?? (async () => { throw new Error("A phone can't save that file."); });
  return {
    quitStopsWork: false,
    startupFolders: async () => [],
    pickFolder: () => ask({ kind: "directory", title: "Choose a folder" }),
    pickPath: (kind, title) => ask({ kind, title }),
    artifactSave: (name, contents) => download(name, contents).then((path) => path),
    artifactOpenExternal: async () => { throw new Error(`That file is on ${options.machineName}. A phone can't open it in another app.`); },
    exportThread: (name, contents) => download(name, contents),
    exportPdf: async () => { throw new Error("A phone can't make a PDF of the thread yet."); },
    openTarget: async (target) => {
      if (/^https?:\/\//i.test(target)) {
        if (!options.openExternal) throw new Error("A phone can't open that page.");
        options.openExternal(target);
        return;
      }
      throw new Error(`That file is on ${options.machineName}. A phone can't reveal it.`);
    },
    copyAttachment: async () => { throw new Error(`Send the file with the message. A phone doesn't copy paths from ${options.machineName}.`); },
    flagAttention: async () => {},
    requestCriticalAttention: async () => {},
    onFileDrop: async () => () => {},
    onQuitRequested: async () => () => {},
    quitHeard: async () => {},
    quitApp: async () => {},
  };
}
