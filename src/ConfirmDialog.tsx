import { useEffect, useRef } from "react";

export interface Question {
  title: string;
  body: string;
  /** Short lines under the body, such as what is still running. */
  rows?: string[];
  /** The words on the button that goes ahead. */
  action: string;
  onConfirm: () => void;
}

/** Asks once before something that can't be taken back. Cancel has focus, so Enter is safe. */
export function ConfirmDialog({ question, onCancel }: { question: Question; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const cancelled = useRef(onCancel);
  cancelled.current = onCancel;
  useEffect(() => {
    opener.current = document.activeElement;
    cancel.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current(); } };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, []);
  return (
    <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={question.rows?.length ? "confirm-body confirm-rows" : "confirm-body"}>
        <strong id="confirm-title">{question.title}</strong>
        <p id="confirm-body" className="muted">{question.body}</p>
        {question.rows && question.rows.length > 0 && (
          <ul id="confirm-rows" className="confirm-rows">
            {question.rows.map((row, index) => <li key={index}>{row}</li>)}
          </ul>
        )}
        <div className="confirm-actions">
          <button ref={cancel} onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={() => { onCancel(); question.onConfirm(); }}>{question.action}</button>
        </div>
      </div>
    </div>
  );
}
