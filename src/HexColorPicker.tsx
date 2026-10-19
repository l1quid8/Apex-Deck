import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { isHardToReadOnDark, normalizeHexColor, parseHexColorInput } from "./hexColor";

/** A colour control for an agent: preset swatches, the system colour well, and
 *  a hex field that takes `#aabbcc`, `aabbcc`, `#abc` or `abc`. Every change is
 *  reported as lowercase `#rrggbb` so callers can store it as-is. */
export function HexColorPicker({ label, value, presets, onChange }: {
  label: string;
  value: string;
  presets: readonly string[];
  onChange: (hex: string) => void;
}) {
  const normalized = normalizeHexColor(value) ?? presets[0] ?? "#a78bfa";
  const [draft, setDraft] = useState(normalized);
  // The last colour the hex field itself reported. The sync below skips that
  // echo, so typing `#abc` is not rewritten to `#aabbcc` under the cursor.
  const typed = useRef<string | null>(null);
  useEffect(() => {
    if (typed.current === normalized) return;
    setDraft(normalized);
  }, [normalized]);
  // A preset or the colour well replaces the whole value, field included.
  const choose = (hex: string) => {
    typed.current = hex;
    setDraft(hex);
    onChange(hex);
  };
  const titleId = useId();
  const hintId = useId();
  const dim = isHardToReadOnDark(normalized);
  return (
    <div className="hex-picker">
      <span className="hex-picker-title" id={titleId}>{label}</span>
      <div className="hex-picker-row" role="group" aria-labelledby={titleId}>
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className="hex-swatch"
            style={{ "--swatch": preset } as CSSProperties}
            aria-label={`Use ${preset}`}
            aria-pressed={preset === normalized}
            title={preset}
            onClick={() => choose(preset)}
          >
            <span aria-hidden="true" />
          </button>
        ))}
        <span className="hex-well">
          <input
            type="color"
            value={normalized}
            aria-label={`${label}: pick any colour`}
            onChange={(event) => {
              const next = normalizeHexColor(event.target.value);
              if (next) choose(next);
            }}
          />
        </span>
        <input
          className="hex-text"
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-label={`${label} hex value`}
          aria-describedby={hintId}
          placeholder="#a78bfa"
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const next = parseHexColorInput(text);
            // Apply once it is a whole colour; half-typed text stays a draft.
            if (next) {
              typed.current = next;
              onChange(next);
            }
          }}
          // Leaving the field restores the canonical form it is stored as.
          onBlur={() => { typed.current = null; setDraft(normalized); }}
        />
      </div>
      <p className="hex-hint" id={hintId} role="status">
        {dim
          ? `${normalized} is very dark on the chat background, so this agent's name and avatar will be hard to read.`
          : "Hex like #a78bfa, or #abc."}
      </p>
    </div>
  );
}
