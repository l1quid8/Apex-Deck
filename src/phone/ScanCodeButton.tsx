import { useEffect, useRef } from "react";

import { CAMERA_HOLD } from "./incomingLinks.ts";

const words = (error: unknown) => String(error).replace(/^Error: /, "");

/**
 * The camera control on Machines. It takes the shared pairing slot before the
 * scanner opens, and keeps that slot when the code starts pairing.
 */
export function ScanCodeButton({ scan, reserve, adopt, giveBack, onCode, onError, auto, onAuto }: {
  scan: () => Promise<string>;
  reserve(link: string): boolean;
  adopt(link: string): boolean;
  giveBack(link: string): void;
  /** The code, after this scan has kept the slot. False from the caller means it was not a pairing link. */
  onCode(text: string): boolean;
  onError(message: string): void;
  /** Open the camera once, as the first thing, when no machine is saved and no link is waiting. */
  auto?: boolean;
  onAuto?: () => void;
}) {
  const opened = useRef(false);
  const run = () => {
    if (!reserve(CAMERA_HOLD)) return;
    scan().then((text) => {
      const trimmed = String(text ?? "").trim();
      if (!adopt(trimmed)) return;
      if (!onCode(trimmed)) giveBack(trimmed);
    }, (error: unknown) => {
      giveBack(CAMERA_HOLD);
      const why = words(error);
      if (why === "cancelled") return;
      onError(why === "denied" ? "Apex Deck can't use the camera. Allow it in Settings → Apex Deck, or paste the pairing link instead." : `Couldn't scan: ${why}`);
    });
  };
  useEffect(() => {
    if (!auto || opened.current) return;
    opened.current = true;
    onAuto?.();
    run();
  }, [auto]);
  return <button type="button" className="primary ph-wide" onClick={run}>Scan QR code</button>;
}
