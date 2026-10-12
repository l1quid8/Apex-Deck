// Card grid + searchable model list + segmented controls for the add-agent form.
// Replaces the provider <select>, the model <select>, and the effort/access
// <select>s with controls that show state (installed, pinned vs floating)
// at a glance instead of hiding it inside a dropdown.

import { useMemo, useState } from "react";
import { ProviderLogo } from "./providerLogos";
import type { PickerGroup } from "./Picker";

export interface ProviderOption {
  key: string;
  label: string;
  hint: string;
  installed: boolean;
  enabled: boolean;
}

export function ProviderGrid({ options, value, onPick }: {
  options: ProviderOption[];
  value: string;
  onPick: (key: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Connect through" className="agent-providers">
      {options.map((p) => {
        const on = value === p.key;
        const off = !p.installed || !p.enabled;
        return (
          <button
            key={p.key}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off}
            title={off ? `${p.label} is not installed` : p.label}
            onClick={() => onPick(p.key)}
            className={on ? "agent-provider on" : "agent-provider"}
          >
            <ProviderLogo preset={p.key} label={`${p.label} logo`} />
            <span className="agent-provider-text">
              <strong>{p.label}</strong>
              <small className={p.installed ? undefined : "missing"}>{p.installed ? p.hint : "Not installed"}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A bare alias (opus, gemini-flash-latest) moves with the provider; a name with a version number stays put. */
export function versionBadge(model: string): string {
  const name = model.replace(/\[.*\]$/, "");
  return /latest/i.test(name) || !/\d/.test(name) ? "follows latest" : "pins version";
}

export function ModelSearchList({ groups, value, onChange, emptyLabel, modelNote }: {
  groups: PickerGroup[];
  value: string;
  onChange: (value: string) => void;
  emptyLabel: string;
  modelNote?: string;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          options: g.options.filter(
            (o) => !q || o.value.toLowerCase().includes(q) || o.text.toLowerCase().includes(q),
          ),
        }))
        .filter((g) => g.options.length > 0),
    [groups, q],
  );
  const [typing, setTyping] = useState(
    () => value !== "" && !groups.some((g) => g.options.some((o) => o.value === value)),
  );
  const known = value === "" || groups.some((g) => g.options.some((o) => o.value === value));

  return (
    <div className="model-picker">
      <input
        type="search"
        aria-label="Search models"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search models…"
        className="model-search"
      />
      <div role="listbox" aria-label="Model" className="model-list">
        <button
          type="button"
          role="option"
          aria-selected={value === ""}
          className={value === "" ? "model-row on" : "model-row"}
          onClick={() => { setTyping(false); onChange(""); }}
        >
          <span className="model-name">{emptyLabel}</span>
        </button>
        {filtered.map((g) => (
          <div key={g.label || "ungrouped"} className="model-group">
            {g.label && <div className="model-group-label">{g.label}</div>}
            {g.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={value === o.value}
                className={value === o.value ? "model-row on" : "model-row"}
                onClick={() => { setTyping(false); onChange(o.value); }}
              >
                <span className="model-name">{o.text}</span>
                <span className="model-badge">{versionBadge(o.value)}</span>
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="hint">No match — type the exact name below.</p>
        )}
      </div>
      <button type="button" className="ghost model-custom-toggle" onClick={() => setTyping((t) => !t)}>
        {typing ? "Pick from the list" : "Type another model name…"}
      </button>
      {(typing || !known) && (
        <input
          aria-label="Exact model name"
          value={value}
          onChange={(e) => { setTyping(true); onChange(e.target.value); }}
          placeholder="Exact model name"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      )}
      {modelNote && <span className="hint">{modelNote}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ label, name, options, value, onChange }: {
  label: string;
  name: string;
  options: { value: T; text: string; title?: string }[];
  value: string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          name={name}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={value === o.value ? "seg on" : "seg"}
          onClick={() => onChange(o.value)}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}
