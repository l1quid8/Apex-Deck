import { useState } from "react";
import type { TurnFile } from "./turnChanges";

interface Props {
  files: TurnFile[];
  onOpenFile: (path: string) => void;
  onOpenTurn: () => void;
}

/** A one-line summary under a bot reply that touched files, collapsed by
 *  default. Expands to the file list; every model gets it when its turn
 *  reported changes. */
export function ChangedFilesStrip({ files, onOpenFile, onOpenTurn }: Props) {
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="turn-files">
      <button
        type="button"
        className="turn-files-strip"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
      >
        <span className="turn-files-count">{files.length === 1 ? "1 file" : `${files.length} files`}</span>
        <span className="turn-files-nums" aria-label={`${added} lines added, ${removed} removed`}>
          <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
        </span>
        <span className="turn-files-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="turn-files-list">
          {files.map((file) => (
            <li key={file.path}>
              <button type="button" className="turn-files-row" onClick={() => onOpenFile(file.path)} title={file.path}>
                <span className="path">{file.path}</span>
                <span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="turn-files-turn" onClick={onOpenTurn}>
              Turn diff →
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
