import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { batteryCells, refillDelay, REFILL_STAGGER_MS, shellState, type Levels } from "./battery";
import { identiconCells } from "./identicon";

/** Counters that go up when a side should refill, bottom row first. */
export interface Refills {
  context: number;
  plan: number;
}

/** The last row starts four steps in, then takes as long as one cell. */
const REFILL_MS = 4 * REFILL_STAGGER_MS + 420;

/** A participant's avatar: a 5×5 pattern drawn from its saved seed, in its
 *  colour. The lit squares shimmer while it is working. Given `levels`, it
 *  is also a battery: context left on the left half, plan left on the right
 *  (see battery.ts). */
export function Avatar({ seed, color, size = "md", working = false, levels, refills }: { seed: string; color: string; size?: "sm" | "md" | "lg"; working?: boolean; levels?: Levels; refills?: Refills }) {
  const cells = useMemo(() => identiconCells(seed), [seed]);
  const refilling = useRefill(refills);
  if (!levels) {
    return (
      <span className={`identicon identicon-${size}${working ? " working" : ""}`} style={{ "--who": color } as CSSProperties} aria-hidden="true">
        {cells.map((cell, i) => (
          <i key={i} className={cell.on ? "on" : undefined} style={cell.on && working ? { animationDelay: `${cell.wave * 80}ms` } : undefined} />
        ))}
      </span>
    );
  }
  const battery = batteryCells(cells, levels);
  const shell = shellState(levels);
  return (
    <span className={`identicon battery identicon-${size}${working ? " working" : ""}${shell === "ok" ? "" : ` ${shell}`}`} style={{ "--who": color } as CSSProperties} aria-hidden="true">
      {battery.map((cell, i) => {
        const refill = cell.on && refilling.some((side) => side === cell.side || cell.side === "both");
        const style: Record<string, string> = { "--a": `${Math.round(cell.alpha * 100)}%` };
        if (cell.red) style["--c"] = "var(--danger)";
        if (refill) style.animationDelay = `${refillDelay(Math.floor(i / 5))}ms`;
        else if (cell.on && working) style.animationDelay = `${cell.wave * 80}ms`;
        const classes = [cell.on ? "on" : "", refill ? "refill" : ""].filter(Boolean).join(" ");
        // A new key restarts the refill each time it plays.
        return <i key={refill ? `r${i}-${refills?.context}-${refills?.plan}` : i} className={classes || undefined} style={style as CSSProperties} />;
      })}
    </span>
  );
}

/** The sides refilling right now. A side refills when its counter goes up,
 *  never when the avatar first appears. */
function useRefill(refills: Refills | undefined): ("context" | "plan")[] {
  const seen = useRef(refills);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [sides, setSides] = useState<("context" | "plan")[]>([]);
  useEffect(() => {
    const before = seen.current;
    seen.current = refills;
    if (!refills || !before) return;
    const started = (["context", "plan"] as const).filter((side) => refills[side] > before[side]);
    if (started.length === 0) return;
    setSides((now) => [...new Set([...now, ...started])]);
    timers.current.push(setTimeout(() => setSides((now) => now.filter((side) => !started.includes(side))), REFILL_MS));
  }, [refills?.context, refills?.plan]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return sides;
}
