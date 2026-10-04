import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TurnPolicy } from "./types";

export const REPLY_POLICIES: { value: TurnPolicy; label: string }[] = [
  { value: "mention", label: "Whoever I addressed last" },
  { value: "everyone", label: "Everyone at once" },
  { value: "round_robin", label: "Everyone in turn" },
];

export function ReplyPolicyPicker({ value, label, disabled, onChange }: {
  value: TurnPolicy; label: string; disabled: boolean; onChange: (value: TurnPolicy) => void;
}) {
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setPosition(null); trigger.current?.focus(); };
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const away = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const dismiss = () => setPosition(null);
    window.addEventListener("pointerdown", away);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [position]);
  useEffect(() => { if (disabled) setPosition(null); }, [disabled]);
  return <>
    <button ref={trigger} type="button" className="reply-policy-trigger" disabled={disabled}
      title="Change who answers by default" aria-label={`Who answers: ${label}`} aria-haspopup="menu"
      aria-expanded={Boolean(position)} aria-controls={position ? id : undefined}
      onClick={() => {
        if (position) return close();
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 220)), bottom: window.innerHeight - rect.top + 5 });
      }}>
      {label}<span className="reply-policy-chevron" aria-hidden="true">▾</span>
    </button>
    {position && createPortal(<div ref={menu} id={id} className="reply-policy-menu" role="menu" aria-label="Who answers"
      style={position}
      // React events bubble through portals: without this, the pane's
      // mousedown refocuses the composer, which scrolls and closes the menu
      // before the click lands.
      onMouseDown={(event) => { event.stopPropagation(); event.preventDefault(); }}
      onKeyDown={(event) => {
        // Safari can blur a focused item with relatedTarget=null when another
        // button is clicked. Dismissing on blur would unmount it before click.
        // Outside pointer presses are handled above; Tab dismisses keyboard use.
        if (event.key === "Tab") setPosition(null);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button"));
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      {REPLY_POLICIES.map((choice) => <button type="button" key={choice.value} role="menuitemradio"
        aria-checked={value === choice.value} onClick={() => { onChange(choice.value); close(); }}>
        <span aria-hidden="true">{value === choice.value ? "✓" : ""}</span>{choice.label}
      </button>)}
    </div>, document.body)}
  </>;
}
