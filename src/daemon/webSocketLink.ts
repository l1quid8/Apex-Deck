// A WebSocket link for DaemonClient. The daemon treats one text message as
// one protocol frame (crates/apex-daemon/src/websocket.rs). No Electron.

import type { Connect, Link } from "./client.ts";

export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", cb: (event: { data?: unknown }) => void): void;
}

/** The browser's WebSocket, as a SocketLike. */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    addEventListener: (type, cb) => {
      ws.addEventListener(type, (event) => cb(type === "message" ? { data: (event as MessageEvent).data } : {}));
    },
  };
}

/**
 * Connect to one machine's apex-daemon. Each call opens a new socket.
 * A message that isn't text is ignored; the daemon only sends text frames.
 */
export function webSocketConnect(url: string, open: (url: string) => SocketLike = browserSocket): Connect {
  return () => new Promise((resolve, reject) => {
    let socket: SocketLike;
    try {
      socket = open(url);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    let onLine: (line: string) => void = () => {};
    let onClose: ((reason: string) => void) | null = null;
    const fail = (reason: string) => {
      if (settled) {
        onClose?.(reason);
        onClose = null;
        return;
      }
      settled = true;
      reject(new Error(reason));
    };
    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      const link: Link = {
        send: (line) => socket.send(line),
        close: () => socket.close(),
        onLine: (cb) => { onLine = cb; },
        onClose: (cb) => { onClose = cb; },
      };
      resolve(link);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data) onLine(event.data);
    });
    socket.addEventListener("error", () => fail("Could not reach the machine."));
    socket.addEventListener("close", () => fail("The connection to the host was lost."));
  });
}
