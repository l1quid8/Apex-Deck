// One connection from the phone to a machine's apex-daemon, by WebSocket or over iroh.
// The Mac being asleep does not close the others: each machine has its own client.

import type { Backend } from "./backend";
import type { Shell } from "./commandBackend.ts";
import { commandBackend } from "./commandBackend.ts";
import { DaemonClient, type Connect, type Welcome } from "./daemon/client.ts";
import { daemonTransport } from "./daemon/transport.ts";
import { guardHostWrites } from "./hostBackends.ts";
import { hostConnectionStore, type HostConnectionStore } from "./hostConnections.ts";
import { isPaired, type Machine, type RemoteAccess } from "./phoneRules.ts";

export interface PhoneHost {
  machine: Machine;
  backend: Backend;
  connection: HostConnectionStore;
  /** What the machine lets this phone do, from its latest welcome; null over WebSocket or before one. */
  access(): RemoteAccess | null;
  start(): Promise<Welcome>;
  close(): void;
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
    ...commandBackend(daemonTransport(client), shell),
    host: { id: machine.id, name: machine.name, connection },
  }, connection);
  return {
    machine,
    backend,
    connection,
    access: () => client.welcome?.access ?? null,
    start: () => client.start(),
    close: () => client.close(),
  };
}
