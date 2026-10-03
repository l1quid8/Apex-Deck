import { useMemo, type CSSProperties } from "react";

import { identiconCells } from "./identicon";

/** A participant's avatar: a 5×5 pattern drawn from its saved seed, in its
 *  colour. The lit squares shimmer while it is working. */
export function Avatar({ seed, color, size = "md", working = false }: { seed: string; color: string; size?: "sm" | "md" | "lg"; working?: boolean }) {
  const cells = useMemo(() => identiconCells(seed), [seed]);
  return (
    <span className={`identicon identicon-${size}${working ? " working" : ""}`} style={{ "--who": color } as CSSProperties} aria-hidden="true">
      {cells.map((cell, i) => (
        <i key={i} className={cell.on ? "on" : undefined} style={cell.on && working ? { animationDelay: `${cell.wave * 80}ms` } : undefined} />
      ))}
    </span>
  );
}
