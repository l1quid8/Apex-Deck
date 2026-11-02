import type { ReactNode } from "react";

import { Camera, Terminal } from "./icons";

/** QR code or Remote SSH, shown only when this phone can pair from a code. */
export function AddHowPicker({ pairing, how, onHow }: {
  pairing: boolean;
  how: "qr" | "ssh" | "address";
  onHow(how: "qr" | "ssh"): void;
}): ReactNode {
  if (!pairing) return null;
  return (
    <div className="ph-segment" role="radiogroup" aria-label="How to add it">
      <button type="button" role="radio" aria-checked={how === "qr"} onClick={() => onHow("qr")}><Camera size={16} />QR code</button>
      <button type="button" role="radio" aria-checked={how === "ssh"} onClick={() => onHow("ssh")}><Terminal size={16} />Remote SSH</button>
    </div>
  );
}
