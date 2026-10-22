// Settings picker for the bot chip style: one full-size preview row drawn
// with the real chip markup and CSS, plus the style names beneath it.
// Hovering or focusing a name previews it; clicking saves it.

import { useState, type CSSProperties } from "react";
import { Avatar } from "./Avatar";
import { CHIP_STYLES, type ChipStyle } from "./botChip";

const SAMPLE = [
  { name: "Jigga", seed: "jigga", color: "#a3e635", to: true, queued: 0, editing: false, phase: "Working" },
  { name: "Null", seed: "null", color: "#a78bfa", to: false, queued: 1, editing: true, phase: "Idle" },
];

export function ChipStylePicker({ value, onChange }: { value: ChipStyle; onChange: (style: ChipStyle) => void }) {
  const [hovered, setHovered] = useState<ChipStyle | null>(null);
  const shown = hovered ?? value;
  const label = CHIP_STYLES.find(style => style.id === shown)?.label ?? "Classic";
  return <div className="chip-style-picker">
    <div className="chip-style-preview chat" data-bot-chip-style={shown} aria-hidden="true">
      {shown === "tab" && <div className="chip-style-preview-composer composer-box" />}
      <div data-chip-style={shown} className="chips composer-bots">
        {SAMPLE.map(bot => <span key={bot.name} className="chip-wrap">
          <span data-editing={bot.editing} className={bot.to ? "chip to" : "chip"} style={{ "--who": bot.color } as CSSProperties}>
            <span className="chip-name">
              <Avatar seed={bot.seed} color={bot.color} size="sm" />
              <span className={`participant-status ${bot.phase === "Working" ? "working" : "idle"}`} />
              <span className="chip-copy">
                <span className="chip-label">{bot.name}</span>
                <span className="chip-details">
                  {(shown === "ledger" || shown === "two-line") && <span className="chip-phase">{bot.phase}</span>}
                  {bot.queued > 0 && <span className="chip-meta chip-queued">{bot.queued}<span className="chip-queued-word"> queued</span></span>}
                  {bot.editing && <span className="editor-badge">editing</span>}
                </span>
              </span>
            </span>
          </span>
        </span>)}
      </div>
    </div>
    <p className="chip-style-caption" role="status">{hovered && hovered !== value ? `Previewing ${label}` : `${label} (in use)`} · Jigga gets the message; Null doesn't</p>
    <div className="chip-style-names" role="radiogroup" aria-label="Chip style" onMouseLeave={() => setHovered(null)}>
      {CHIP_STYLES.map(style => <button key={style.id} type="button" role="radio" aria-checked={style.id === value}
        className={style.id === value ? "chip-style-name current" : "chip-style-name"}
        onMouseEnter={() => setHovered(style.id)} onFocus={() => setHovered(style.id)} onBlur={() => setHovered(null)}
        onClick={() => onChange(style.id)}>
        {style.id === value && <span aria-hidden="true">✓ </span>}{style.label}
      </button>)}
    </div>
  </div>;
}
