import { useEffect, useRef, useState } from "react";

export interface PickerGroup {
  /** Heading for the group. Empty lists the options without one. */
  label: string;
  options: { value: string; text: string }[];
}

interface Props {
  name: string;
  /** The chosen value. Empty means "leave it to the default". */
  value: string;
  onChange: (value: string) => void;
  groups: PickerGroup[];
  /** Text for the empty choice, for example "Default". */
  emptyLabel: string;
  /** Text for the choice that opens the text field. */
  customLabel: string;
  customPlaceholder: string;
}

const CUSTOM = "__type_a_name__";

/**
 * A dropdown of known choices that can also take a typed value.
 *
 * A plain dropdown shows everything on offer at a glance, which a text box
 * with suggestions does not. The last entry opens a text field for names
 * the list does not have yet. A value that is not in the list, such as one
 * typed earlier, opens the text field by itself.
 */
export function Picker({ name, value, onChange, groups, emptyLabel, customLabel, customPlaceholder }: Props) {
  const known = value === "" || groups.some((g) => g.options.some((o) => o.value === value));
  const [typing, setTyping] = useState(!known);
  useEffect(() => {
    if (!known) setTyping(true);
  }, [known]);
  // Move the cursor into the text field only when the user has just asked
  // for it, not when a form opens with a typed value already in place.
  const focusNext = useRef(false);

  return (
    <>
      <select
        name={name}
        value={typing ? CUSTOM : value}
        onChange={(e) => {
          const picked = e.target.value;
          setTyping(picked === CUSTOM);
          focusNext.current = picked === CUSTOM;
          onChange(picked === CUSTOM ? "" : picked);
        }}
      >
        <option value="">{emptyLabel}</option>
        {groups.map((group) => {
          const options = group.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ));
          if (options.length === 0) return null;
          return group.label ? (
            <optgroup key={group.label} label={group.label}>
              {options}
            </optgroup>
          ) : (
            options
          );
        })}
        <option value={CUSTOM}>{customLabel}</option>
      </select>
      {typing && (
        <input
          name={`${name}-typed`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={customPlaceholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          ref={(el) => {
            if (el && focusNext.current) {
              focusNext.current = false;
              el.focus();
            }
          }}
        />
      )}
    </>
  );
}
