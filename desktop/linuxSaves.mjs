// Saves from the broker-launched Linux window.
//
// The engine refuses access-raising saves from the local socket on Linux.
// Sending every session save through the broker would spend its replay
// journal (one entry per receipt, never evicted) on layout changes, so a
// session save first goes out as `session_save_layout`. The engine refuses
// that, under its write lock, only when it would change the agent profiles;
// this module then resends the original save with a broker receipt.
// Settings and the other raising saves always carry a receipt.

import { linuxAttestedCommands } from './provenance.mjs';

/** apex-host `storage::LAYOUT_SAVE_CHANGES_PROFILES`; a test keeps them equal. */
export const LAYOUT_REFUSAL = "This save changes agent profiles, which needs the installed window's receipt on this Linux host.";
const MAX_PENDING = 64;
const MAX_REPLY = 16 * 1024;

/**
 * `attest(frame)` resolves to the receipted frame; `send(contentsId, gen, line)`
 * writes to the engine; `reply(contentsId, gen, line)` answers the window.
 */
export function createLinuxSaves({ attest, send, reply }) {
  const pending = new Map();
  const key = (contentsId, gen, id) => `${contentsId}\u0000${gen}\u0000${id}`;
  const fail = (contentsId, gen, id, error) => reply(contentsId, gen, JSON.stringify({ id, err: error?.message ?? String(error) }));

  async function attested(contentsId, gen, frame) {
    let signed;
    try { signed = await attest(frame); } catch (error) { fail(contentsId, gen, frame.id, error); return; }
    send(contentsId, gen, JSON.stringify(signed));
  }

  return {
    /** Route one frame from the window. Returns false if it isn't one of these saves. */
    outgoing(contentsId, gen, frame) {
      if (frame?.cmd === 'session_save') {
        if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
        pending.set(key(contentsId, gen, frame.id), frame);
        send(contentsId, gen, JSON.stringify({ ...frame, cmd: 'session_save_layout' }));
        return true;
      }
      if (linuxAttestedCommands.has(frame?.cmd)) { void attested(contentsId, gen, frame); return true; }
      return false;
    },
    /** Look at one engine line for the window. Returns true if it was handled here. */
    incoming(contentsId, gen, line) {
      if (!pending.size || typeof line !== 'string' || line.length > MAX_REPLY) return false;
      let message; try { message = JSON.parse(line); } catch { return false; }
      if (!message || typeof message !== 'object' || message.id === undefined || !('ok' in message || 'err' in message)) return false;
      const k = key(contentsId, gen, message.id), frame = pending.get(k);
      if (!frame) return false;
      pending.delete(k);
      if (message.err !== LAYOUT_REFUSAL) return false;
      void attested(contentsId, gen, frame);
      return true;
    },
    /** The window's link closed: its saves will get no answer. */
    forget(contentsId) { for (const k of pending.keys()) if (k.startsWith(`${contentsId}\u0000`)) pending.delete(k); },
  };
}
