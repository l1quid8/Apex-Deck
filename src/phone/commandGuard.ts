import type { Transport } from "../commandBackend.ts";

// The phone no longer stops to ask Face ID before a command. Every action the phone can take —
// raising a bot's access, adding one to a thread, saving the thread list, deleting a thread — goes
// straight to the machine, and the app asks once for Face ID when it opens instead.
//
// What still decides whether a phone may do something is the machine: apex-daemon classifies each
// command in authority::access_effect and refuses anything this device's level doesn't cover
// (raisingCommands used to mirror that list here, so the read-only phone got a prompt it could not
// have satisfied anyway). A local prompt was never proof of anything — biometric.ts says as much:
// the result was never sent to the machine. So it added a step, not protection.
//
// tests/phone-command-guard.test.mjs still reads the daemon's Raises arms and checks each one reaches
// the wire intact, so a command the daemon treats as privileged can't be silently mangled on the way.

/** Guard the shared command path: one rule, the same for typed methods and raw calls. */
export function guardPhoneCommands(transport: Transport): Transport {
  return {
    ...transport,
    async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      // The command name reaches transport.call to be framed and sent. Anything that isn't a string
      // would be stringified into a command nobody asked for, so refuse it here.
      if (typeof cmd !== "string") throw new Error("Invalid phone command. Nothing was sent.");
      return transport.call<T>(cmd, args);
    },
  };
}
