// One direct connection from the phone to a machine's apex-daemon.
// The Mac being asleep does not close the others: each machine has its own client.

import type { Backend } from "./backend";
import type { Shell } from "./commandBackend.ts";
import { commandBackend } from "./commandBackend.ts";
import { DaemonClient, type Connect, type Welcome } from "./daemon/client.ts";
import { daemonTransport } from "./daemon/transport.ts";
import { guardHostWrites } from "./hostBackends.ts";
import { hostConnectionStore, type HostConnectionStore } from "./hostConnections.ts";
import type { DirectMachine } from "./phoneRules.ts";

export interface PhoneHost {
  machine: DirectMachine;
  backend: Backend;
  connection: HostConnectionStore;
  start(): Promise<Welcome>;
  close(): void;
}

export function openPhoneHost(machine: DirectMachine, connect: Connect, shell: Shell): PhoneHost {
  const client = new DaemonClient(connect, { token: machine.token });
  const connection = hostConnectionStore(machine.id, machine.name);
  connection.setRetry(() => client.retryNow());
  client.onStatus((status) => {
    if (status.kind === "connected") connection.setHelper(client.helperVersion);
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
    start: () => client.start(),
    close: () => client.close(),
  };
}
