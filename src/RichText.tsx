import { useEffect, useState, type ReactNode } from "react";

interface Props {
  text: string;
  /** Open a file, folder or web address named in the text. With `reveal`,
   *  show a file in its folder instead of opening it. */
  onOpen: (target: string, reveal?: boolean) => void;
}

// A markdown link, [label](target), or a bare web address.
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])/g;

const isWeb = (target: string) => /^https?:\/\//.test(target);

/** The name of the file browser on this computer. */
const FILE_BROWSER = /Mac/i.test(navigator.platform) ? "Finder" : /Win/i.test(navigator.platform) ? "File Explorer" : "file manager";

interface Menu {
  target: string;
  x: number;
  y: number;
}

/**
 * Message text with its links made clickable.
 *
 * Bots refer to files as markdown links whose target is a path on this
 * computer. Clicking one shows the file in its folder; clicking a web
 * address opens it in the browser. Right-clicking offers to open the file
 * in its own app or copy its path. Everything else is shown exactly as written.
 */
export function RichText({ text, onOpen }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);

  // Any click, scroll or Escape elsewhere puts the menu away.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const target = match[2] ?? match[3];
    const label = match[1] ?? match[3];
    parts.push(
      <a
        key={start}
        className="msg-link"
        href={target}
        title={target}
        onClick={(e) => {
          e.preventDefault();
          // A click shows a file or folder in the file browser; opening it
          // in its own app is on the right-click menu.
          onOpen(target, !isWeb(target));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Keep the menu inside the window.
          setMenu({ target, x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 120) });
        }}
      >
        {label}
      </a>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
  };

  return (
    <>
      {parts}
      {menu && (
        <span className="link-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          <button role="menuitem" onClick={() => onOpen(menu.target)}>
            Open
          </button>
          {!isWeb(menu.target) && (
            <button role="menuitem" onClick={() => onOpen(menu.target, true)}>
              Show in {FILE_BROWSER}
            </button>
          )}
          <button role="menuitem" onClick={() => copy(menu.target)}>
            {isWeb(menu.target) ? "Copy link" : "Copy path"}
          </button>
        </span>
      )}
    </>
  );
}
