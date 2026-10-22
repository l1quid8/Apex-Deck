import type { ReactNode } from "react";

/** QR or address, shown only when this phone can pair from a code. */
export function AddHowPicker({ pairing, how, onHow }: {
  pairing: boolean;
  how: "qr" | "address";
  onHow(how: "qr" | "address"): void;
}): ReactNode {
  if (!pairing) return null;
  return (
    <div className="ph-segment" role="radiogroup" aria-label="How">
      <button type="button" role="radio" aria-checked={how === "qr"} onClick={() => onHow("qr")}>QR code</button>
      <button type="button" role="radio" aria-checked={how === "address"} onClick={() => onHow("address")}>Address and token</button>
    </div>
  );
}
