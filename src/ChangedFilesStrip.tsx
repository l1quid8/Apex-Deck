import type { TurnFile } from "./turnChanges";

interface Props {
  files: TurnFile[];
  expanded?: boolean;
  onOpenTurn: () => void;
}

/** A turn snapshot that opens the live Git menu with matching files selected. */
export function ChangedFilesStrip({ files, expanded = false, onOpenTurn }: Props) {
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="turn-files">
      <button
        type="button"
        className="turn-files-strip"
        aria-expanded={expanded}
        title="Review this turn’s current files in Changes"
        onClick={event => { event.currentTarget.focus(); onOpenTurn(); }}
      >
        <span className="turn-files-count">{files.length === 1 ? "1 file" : `${files.length} files`}</span>
        <span className="turn-files-nums" aria-label={`${added} lines added, ${removed} removed`}>
          <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
        </span>
        <span className="turn-files-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
    </div>
  );
}
