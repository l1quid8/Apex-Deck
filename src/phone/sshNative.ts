// The ApexSsh native plugin as sshRun needs it, and the one setup run the app
// holds. The run lives here, above every screen, so closing the sheet can't
// stop it partway through pairing or leave a sign-in behind.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import { ConnectFailure, runSetup, type ConnectStage, type SetupDeps, type SshSession, type SshStream } from "./sshRun.ts";
import type { SetupEvent, SshRequest } from "./sshSetup.ts";

type SshNote = { stream: number; line?: string; end?: number };

interface Native {
  connect(options: { host: string; port: number; user: string; password?: string; key?: string; passphrase?: string; known?: string }): Promise<{ handle: number; fingerprint: string }>;
  exec(options: { handle: number; command: string; stdin?: string; timeoutS?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  open(options: { handle: number; command: string }): Promise<{ stream: number }>;
  write(options: { stream: number; text: string }): Promise<void>;
  closeStream(options: { stream: number }): Promise<void>;
  disconnect(options: { handle: number }): Promise<void>;
  saveSignIn(options: { id: string; text: string }): Promise<void>;
  readSignIn(options: { id: string }): Promise<{ text: string }>;
  forgetSignIn(options: { id: string }): Promise<void>;
  addListener(eventName: "ssh", listener: (note: SshNote) => void): Promise<PluginListenerHandle>;
}

export interface SshPlugin {
  connect(request: SshRequest, known: string | null): Promise<SshSession>;
  keep(id: string, request: SshRequest): Promise<void>;
  /** Asks for Face ID. */
  saved(id: string): Promise<Pick<SshRequest, "password" | "passphrase" | "key">>;
  forget(id: string): Promise<void>;
}

const signInId = (setup: { host: string; port: number; user: string }) => `${setup.user}@${setup.host}:${setup.port}`;
export { signInId };

function wrap(native: Native): SshPlugin {
  const streams = new Map<number, { onLine(line: string): void; onEnd(code: number): void }>();
  const notes = new Map<number, SshNote[]>();
  void native.addListener("ssh", (note) => {
    const heard = streams.get(note.stream);
    if (!heard) { notes.set(note.stream, [...(notes.get(note.stream) ?? []), note]); return; }
    if (note.line !== undefined) heard.onLine(note.line);
    if (note.end !== undefined) { streams.delete(note.stream); heard.onEnd(note.end); }
  });
  return {
    async connect(request, known) {
      let opened;
      try {
        opened = await native.connect({ host: request.host, port: request.port, user: request.user, password: request.password || undefined, key: request.key?.text, passphrase: request.passphrase || undefined, known: known ?? undefined });
      } catch (failure) {
        const { code, message } = failure as { code?: string; message?: string };
        const stage: ConnectStage = code === "key" || code === "signin" ? code : "reach";
        throw new ConnectFailure(stage, message ?? "SSH didn't connect.", stage === "key" ? message : undefined);
      }
      const { handle, fingerprint } = opened;
      return {
        fingerprint,
        exec: (command, options = {}) => native.exec({ handle, command, stdin: options.stdin, timeoutS: options.timeoutS }),
        async open(command): Promise<SshStream> {
          const { stream } = await native.open({ handle, command });
          return {
            listen(onLine, onEnd) {
              streams.set(stream, { onLine, onEnd });
              for (const note of notes.get(stream) ?? []) {
                if (note.line !== undefined) onLine(note.line);
                if (note.end !== undefined) onEnd(note.end);
              }
              notes.delete(stream);
            },
            write: (text) => native.write({ stream, text }),
            close: () => native.closeStream({ stream }),
          };
        },
        close: () => native.disconnect({ handle }),
      };
    },
    keep: (id, request) => native.saveSignIn({ id, text: JSON.stringify({ password: request.password, passphrase: request.passphrase, key: request.key }) }),
    async saved(id) { return JSON.parse((await native.readSignIn({ id })).text); },
    forget: (id) => native.forgetSignIn({ id }),
  };
}

let shared: SshPlugin | null = null;

/** The native SSH plugin, or null outside the iPhone app. */
export function sshPlugin(): SshPlugin | null {
  if (!shared && Capacitor.isPluginAvailable("ApexSsh")) shared = wrap(registerPlugin<Native>("ApexSsh"));
  return shared;
}

/** The one setup run, and whoever is watching it. Late watchers hear it from the start. */
export interface SetupRuns {
  start(request: SshRequest): void;
  current(): boolean;
  /** Replays what happened so far. Returns how to stop watching; the run goes on. */
  watch(heard: (event: SetupEvent) => void): () => void;
  cancel(): void;
  clear(): void;
}

export function setupRuns(deps: () => SetupDeps): SetupRuns {
  let run: { cancel(): void; events: SetupEvent[]; watchers: Set<(event: SetupEvent) => void> } | null = null;
  return {
    start(request) {
      const watchers = new Set<(event: SetupEvent) => void>();
      const events: SetupEvent[] = [];
      const started = runSetup(request, deps(), (event) => {
        events.push(event);
        watchers.forEach((heard) => heard(event));
      });
      run = { cancel: started.cancel, events, watchers };
    },
    current: () => run !== null,
    watch(heard) {
      const now = run;
      if (!now) return () => {};
      now.events.forEach(heard);
      now.watchers.add(heard);
      return () => now.watchers.delete(heard);
    },
    cancel: () => run?.cancel(),
    clear() { run = null; },
  };
}
