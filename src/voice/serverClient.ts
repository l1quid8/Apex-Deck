import type { DaemonClient } from "../daemon/client.ts";
import { toBase64, fromBase64 } from "../daemon/transport.ts";
import { encodeAudio, decodeAudio } from "./audioProtocol.ts";
import { disconnected, type LocalVoiceClient } from "./localClient.ts";
import type {
  HelperEvent,
  ServerVoiceLink,
  ServerVoiceRuntime,
  VoiceFrame,
} from "./types.ts";
export const SEND_LIMIT = 96,
  RESUME_AT = 32;
export function serverVoiceLink(client: DaemonClient): ServerVoiceLink {
  const pending = new Map<number, VoiceFrame[]>(),
    closed = new Map<number, VoiceFrame>();
  const listeners = new Map<number, Set<(frame: VoiceFrame) => void>>();
  const lost = new Set<(reason: string) => void>();
  let connected = false;
  client.onVoice((frame) => {
    if (closed.has(frame.channel)) return;
    if ("closed" in frame) {
      closed.set(frame.channel, frame);
      if (closed.size > 64) closed.delete(closed.keys().next().value!);
      pending.delete(frame.channel);
    }
    const callbacks = listeners.get(frame.channel);
    if (callbacks?.size) callbacks.forEach((cb) => cb(frame));
    else if (!("closed" in frame)) {
      const frames = pending.get(frame.channel) ?? [];
      frames.push(frame);
      if (frames.length > 64) frames.shift();
      pending.set(frame.channel, frames);
      if (pending.size > 64) pending.delete(pending.keys().next().value!);
    }
  });
  client.onStatus((status) => {
    const next = status.kind === "connected";
    if (connected && !next) {
      // Channel numbers may be reused by a new daemon session.
      pending.clear();
      closed.clear();
      lost.forEach((cb) => cb("The connection to the machine was lost"));
    }
    connected = next;
  });
  return {
    status: () => client.call("voice_server_status"),
    install: () => client.call("voice_server_install"),
    cancelInstall: () => client.call("voice_server_install_cancel"),
    warm: (room) => client.call("voice_server_warm", { room }),
    open: (room) => client.call("voice_server_open", { room }),
    close: (channel, reason) =>
      client.call("voice_server_close", { channel, reason }),
    send: (frame) => client.sendVoice(frame),
    onLost: (cb) => {
      lost.add(cb);
      return () => {
        lost.delete(cb);
      };
    },
    attach: (channel, cb) => {
      const end = closed.get(channel);
      if (end) {
        cb(end);
        return () => {};
      }
      const callbacks = listeners.get(channel) ?? new Set();
      callbacks.add(cb);
      listeners.set(channel, callbacks);
      const buffered = pending.get(channel) ?? [];
      pending.delete(channel);
      buffered.forEach(cb);
      return () => {
        callbacks.delete(cb);
        if (!callbacks.size) listeners.delete(channel);
      };
    },
  };
}
export async function connectServerVoice(
  link: ServerVoiceLink,
  runtime: ServerVoiceRuntime,
  event: (event: HelperEvent) => void,
  audio: (pcm: Int16Array, generation: number) => void,
  failure: (error: Error) => void,
  weak: (weak: boolean) => void = () => {},
): Promise<LocalVoiceClient> {
  if (runtime.protocolVersion !== 1) throw Error("Incompatible voice runtime");
  let seq = 0,
    acked = 0,
    congested = false,
    ended = false,
    attaching = true;
  let initialError: Error | undefined;
  let detach = () => {},
    unlost = () => {};
  const fail = (error: Error) => {
    if (ended) return;
    ended = true;
    detach();
    unlost();
    if (attaching) initialError = error;
    else failure(error);
  };
  detach = link.attach(runtime.channel, (frame) => {
    if (ended || frame.channel !== runtime.channel) return;
    try {
      if ("closed" in frame) fail(disconnected(frame.closed));
      else if ("rx" in frame) {
        acked = Math.max(acked, Math.min(seq, frame.rx));
        if (congested && seq - acked < RESUME_AT) {
          congested = false;
          weak(false);
        }
      } else if ("ctl" in frame) event(frame.ctl as HelperEvent);
      else {
        const bytes = fromBase64(frame.bin);
        const decoded = decodeAudio(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        );
        audio(decoded.pcm, decoded.generation);
      }
    } catch (error) {
      fail(error instanceof Error ? error : Error(String(error)));
    }
  });
  if (!ended) unlost = link.onLost((reason) => fail(disconnected(reason)));
  attaching = false;
  if (initialError) {
    detach();
    unlost();
    throw initialError;
  }
  return {
    send(message) {
      if (ended || !link.send({ channel: runtime.channel, ctl: message }))
        throw Error("Voice disconnected");
    },
    audio(pcm, generation) {
      if (ended) return;
      if (congested || seq - acked >= SEND_LIMIT) {
        if (!congested) {
          congested = true;
          weak(true);
        }
        return;
      }
      if (
        !link.send({
          channel: runtime.channel,
          bin: toBase64(new Uint8Array(encodeAudio(generation, ++seq, pcm))),
        })
      )
        fail(disconnected("Voice disconnected"));
    },
    close(reason = "closed") {
      if (ended) return;
      ended = true;
      detach();
      unlost();
      void link.close(runtime.channel, reason).catch(() => {});
    },
  };
}
