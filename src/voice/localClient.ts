import { decodeAudio, encodeAudio } from "./audioProtocol.ts";
import type { HelperEvent, VoiceRuntime } from "./types.ts";
export interface LocalVoiceClient {
  send(message: Record<string, unknown>): void;
  audio(pcm: Int16Array, generation: number): void;
  close(): void;
}
export function connectLocalVoice(
  runtime: VoiceRuntime,
  event: (e: HelperEvent) => void,
  audio: (pcm: Int16Array, generation: number) => void,
  failure: (e: Error) => void,
): Promise<LocalVoiceClient> {
  if (
    runtime.protocolVersion !== 1 ||
    !Number.isInteger(runtime.port) ||
    runtime.port < 1 ||
    runtime.port > 65535
  )
    return Promise.reject(Error("Incompatible voice runtime"));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}`);
    ws.binaryType = "arraybuffer";
    let sequence = 0;
    let closed = false;
    let opened = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(Error("Voice connection timed out"));
    }, 10000);
    ws.onopen = () => {
      clearTimeout(timer);
      opened = true;
      ws.send(JSON.stringify({ type: "auth", token: runtime.token }));
      resolve({
        send: (m) => {
          if (ws.readyState !== WebSocket.OPEN)
            throw Error("Voice disconnected");
          ws.send(JSON.stringify(m));
        },
        audio: (pcm, generation) => {
          if (ws.bufferedAmount > 32000) {
            failure(Error("Voice capture overloaded"));
            return;
          }
          if (ws.readyState === WebSocket.OPEN)
            ws.send(encodeAudio(generation, ++sequence, pcm));
        },
        close: () => {
          closed = true;
          ws.close();
        },
      });
    };
    ws.onmessage = (m) => {
      if (closed) return;
      try {
        if (m.data instanceof ArrayBuffer) {
          const f = decodeAudio(m.data);
          audio(f.pcm, f.generation);
        } else {
          if (m.data.length > 65536) throw Error("Voice control too large");
          event(JSON.parse(m.data));
        }
      } catch (e) {
        failure(e instanceof Error ? e : Error(String(e)));
      }
    };
    ws.onerror = () => {
      if (!opened) {
        clearTimeout(timer);
        reject(Error("Cannot connect to local voice"));
      } else if (!closed) failure(Error("Voice connection failed"));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (!opened) reject(Error("Local voice disconnected"));
      else if (!closed)
        failure(
          Error("Local voice disconnected. Start a new call to reconnect."),
        );
    };
  });
}
