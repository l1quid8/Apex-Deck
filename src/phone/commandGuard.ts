import type { Transport } from "../commandBackend.ts";
import { requireFaceId } from "./biometric.ts";

// Mirror apex-daemon authority::access_effect. These commands may carry access
// in snapshots/profiles as well as explicit levels: never inspect args to skip
// authentication. The wire-boundary drift test checks all daemon Raises arms.
const raisingCommands = new Set([
  "room_add_participant", "room_update_participant", "room_create", "room_import",
  "room_fork", "chat_promote", "room_mount", "folder_accept", "session_save",
  "settings_save", "monitor_watch_save",
]);

/** Guard the shared command path so typed methods and raw calls obey one rule. */
export function guardPhoneCommands(transport: Transport, machineName: string): Transport {
  return {
    ...transport,
    async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      if (typeof cmd !== "string") throw new Error("Invalid phone command. Nothing was sent.");
      if (!raisingCommands.has(cmd)) return transport.call<T>(cmd, args);
      // Capture precisely the JSON intent before yielding to native UI. The
      // caller must not change a nested profile/folder during authentication.
      const intent = args === undefined ? undefined : JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
      // Each invocation owns its attempt. No shared promise, cached success or
      // reuse interval can release a different intent after this one succeeds.
      if (!await requireFaceId(`Allow ${cmd.replaceAll("_", " ")} on ${machineName}.`)) {
        throw new Error("Biometric authentication is required. Nothing was sent.");
      }
      return transport.call<T>(cmd, intent);
    },
  };
}
