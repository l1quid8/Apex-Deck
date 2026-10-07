// A Link to a paired machine over iroh, through the ApexRemote plugin. The
// DaemonClient on top of it is the same one the WebSocket link uses.

import { FinalError, type Connect, type Link } from "./client.ts";
import { CLOSE, type RemoteMode, type RemotePlugin, type Route } from "../phone/remotePlugin.ts";

export interface IrohTarget {
  hostEndpointId: string;
  addrs: string[];
}

/** Why a connection ended, in words for the machine's card, and whether retrying can help. */
export function closeWords(code: number, reason: string, mode: RemoteMode): { line: string; final: boolean } {
  switch (code) {
    case CLOSE.NOT_PAIRED:
    case CLOSE.REVOKED:
      return { line: "Access removed — pair again on this machine", final: true };
    case CLOSE.WRONG_HOST:
      return { line: "A different machine answered at this address. Pair again on the right machine.", final: true };
    case CLOSE.UNREACHABLE:
    case CLOSE.TIMEOUT:
      return mode === "direct"
        ? { line: "Direct connection blocked. Direct only needs this machine's port reachable, which on a home Mac means a forwarded port. Switch to Automatic to use the relay.", final: false }
        : { line: `Can't reach this machine right now (${reason}).`, final: false };
    default:
      return { line: reason || "The connection closed.", final: false };
  }
}

/**
 * Connect to `target` over iroh. Each attempt is its own handle; events for
 * an older handle never reach a newer link. `onRoute` hears Direct or
 * Relayed as it changes.
 */
export function irohConnect(
  target: () => IrohTarget,
  plugin: RemotePlugin,
  mode: () => RemoteMode,
  onRoute: (route: Route | null) => void = () => {},
): Connect {
  return async () => {
    const { hostEndpointId, addrs } = target();
    const handle = await plugin.connect(hostEndpointId, addrs);
    return new Promise<Link>((resolve, reject) => {
      let open = false;
      let lineCb: ((line: string) => void) | null = null;
      let closeCb: (reason: string, final?: boolean) => void = () => {};
      const held: string[] = [];
      const shut = () => { void plugin.close(handle).catch(() => {}); };
      const link: Link = {
        send: (line) => { plugin.send(handle, line).catch(shut); },
        close: shut,
        onLine: (cb) => {
          lineCb = cb;
          held.splice(0).forEach(cb);
        },
        onClose: (cb) => { closeCb = cb; },
      };
      let ended = false;
      let stop = () => {};
      stop = plugin.listen(handle, (event) => {
        switch (event.type) {
          case "opened":
            open = true;
            resolve(link);
            return;
          case "route":
            onRoute(event.route);
            return;
          case "line":
            // A line can arrive before DaemonClient has its listener on.
            if (lineCb) lineCb(event.line);
            else held.push(event.line);
            return;
          case "closed": {
            ended = true;
            stop();
            onRoute(null);
            const words = closeWords(event.code, event.reason, mode());
            if (open) closeCb(words.line, words.final);
            else reject(words.final ? new FinalError(words.line) : new Error(words.line));
            return;
          }
        }
      });
      if (ended) stop();
    });
  };
}
