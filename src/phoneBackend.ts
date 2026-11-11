// One connection from the phone to a machine's apex-daemon, by WebSocket or over iroh.
// The Mac being asleep does not close the others: each machine has its own client.

import { serverVoiceLink } from "./voice/serverClient.ts";
import type { ServerVoiceLink } from "./voice/types.ts";
import type { Backend } from "./backend";
import type { Shell } from "./commandBackend.ts";
import { commandBackend } from "./commandBackend.ts";
import { DaemonClient, type Connect, type Welcome } from "./daemon/client.ts";
import { daemonTransport } from "./daemon/transport.ts";
import { guardHostWrites } from "./hostBackends.ts";
import { hostConnectionStore, type HostConnectionStore } from "./hostConnections.ts";
import { guardPhoneCommands } from "./phone/commandGuard.ts";
import { isPaired, type Machine, type RemoteAccess } from "./phoneRules.ts";

import type { ParticipantConfig } from "./types.ts";
import { createPersonaDrafter, type PersonaDrafter } from "./phone/personaDrafter.ts";

export interface PhoneHost {
  machine: Machine;
  voice: ServerVoiceLink;
  supports(capability: string): boolean;
  backend: Backend;
  connection: HostConnectionStore;
  /** What the machine lets this phone do, from its latest welcome; null over WebSocket or before one. */
  access(): RemoteAccess | null;
  start(): Promise<Welcome>;
  /** Ask the machine for any answer within `ms`; a quiet link is dropped and dialed again. */
  check(ms: number): Promise<"answered" | "replaced" | "offline">;
  close(): void;
  personaDrafter(
    profiles: () => ParticipantConfig[],
    editingId: string | null,
    disabledProviders?: () => readonly string[],
  ): PersonaDrafter;
}

/** `onWelcome` hears each welcome, for the addresses a paired machine sends with it. */
export function openPhoneHost(machine: Machine, connect: Connect, shell: Shell, onWelcome: (welcome: Welcome) => void = () => {}): PhoneHost {
  // A QR-paired machine knows this phone by its key; there's no token.
  const client = new DaemonClient(connect, isPaired(machine) ? {} : { token: machine.token });
  const connection = hostConnectionStore(machine.id, machine.name);
  connection.setRetry(() => client.retryNow());
  client.onStatus((status) => {
    if (status.kind === "connected") {
      connection.setHelper(client.helperVersion, client.helperBuild);
      if (client.welcome) onWelcome(client.welcome);
    }
    connection.setStatus(status);
  });
  connection.setFinishResync(() => client.finishResync());
  const backend = guardHostWrites({
    ...commandBackend(guardPhoneCommands(daemonTransport(client)), shell),
    host: { id: machine.id, name: machine.name, connection },
  }, connection);
  return {
    machine,
    voice: serverVoiceLink(client),
    supports: capability => client.hasCapability(capability),
    backend,
    connection,
    access: () => client.welcome?.access ?? null,
    start: () => client.start(),
    check: (ms) => client.check(ms),
    close: () => client.close(),
    personaDrafter: (profiles, editingId, disabledProviders) =>
      createPersonaDrafter({
        call: (cmd, args) => backend.call(cmd, args),
        personaDraft: (writer, idea, taken) => backend.personaDraft(writer, idea, taken),
        profiles,
        disabledProviders: disabledProviders ?? (() => []),
        editingId,
        machine: machine.name,
      }),
  };
}
