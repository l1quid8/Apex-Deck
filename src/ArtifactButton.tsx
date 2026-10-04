import { useEffect, useRef, useState } from "react";

import type { CodeChoices } from "./artifacts";

// The control a code block in a finished reply gets when its kind can open
// as an artifact. Only a person's click makes an artifact. See the spec, 2.2.

export type CodeChoice = { kind: "new" } | { kind: "version"; artifactId: string } | { kind: "show"; artifactId: string; n: number };

interface Props {
  choices: CodeChoices;
  /** True while the panel shows the version this block was opened as. */
  showing: boolean;
  onChoose: (choice: CodeChoice) => void;
}

export function ArtifactButton({ choices, showing, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (choices.opened) {
    const { artifactId, n } = choices.opened;
    return (
      <button type="button" className={showing ? "artifact-shown on" : "artifact-shown"} aria-pressed={showing} onClick={() => onChoose({ kind: "show", artifactId, n })}>
        {showing ? `Showing v${n}` : `Show v${n}`}
      </button>
    );
  }
  if (choices.tooLarge) return <button type="button" disabled title="Too large to open as an artifact.">Open as artifact</button>;
  if (choices.targets.length === 0) return <button type="button" onClick={() => onChoose({ kind: "new" })}>Open as artifact</button>;
  const choose = (choice: CodeChoice) => {
    setOpen(false);
    onChoose(choice);
  };
  return (
    <span className="artifact-choice" ref={wrap}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((on) => !on)}>Open as artifact ▾</button>
      {open && (
        <span className="artifact-menu" role="menu" aria-label="Open as artifact">
          {choices.targets.map((target) => (
            <button key={target.id} type="button" role="menuitem" onClick={() => choose({ kind: "version", artifactId: target.id })}>
              New version of {target.title}
              <small>Becomes v{target.next}. Earlier versions are kept.</small>
            </button>
          ))}
          <button type="button" role="menuitem" onClick={() => choose({ kind: "new" })}>
            New artifact
            <small>Starts its own history at v1.</small>
          </button>
        </span>
      )}
    </span>
  );
}
