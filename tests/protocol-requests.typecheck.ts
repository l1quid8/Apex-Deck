// Compiled with the renderer. These calls are never executed.
import type { Backend } from "../src/backend";
import type { Transport } from "../src/commandBackend";
import type { DaemonClient } from "../src/daemon/client";

declare const backend: Backend;
declare const transport: Transport;
declare const client: DaemonClient;

backend.call("devices_list");
transport.call("voice_server_open", { room: "room" });
client.call<string>("read_attachment", { path: "file" });
client.call<{ data: string; total: number }>("read_attachment", { path: "file", offset: 0 });

// @ts-expect-error The optional response type cannot loosen the request.
backend.call<string>("read_attachment", { id: "file" });
// @ts-expect-error A required argument cannot be skipped by a transport wrapper.
transport.call("voice_server_open");
// @ts-expect-error The framing client must recognize the command.
client.call("not_a_daemon_command", {});
