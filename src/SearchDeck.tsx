import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  GROUP_LABEL, TIER_1_KINDS, createSearch, emptyView, highlightParts, loadRecents, machineLine, parseQuery, pushRecent, saveRecents,
  shownRows, showMoreLabel,
  type GroupKind, type MergedHit, type RecentPlace, type Recents, type SearchControl, type SearchFilters, type SearchMachine,
  type SearchPort, type SearchView, type SettingMatch,
} from "./globalSearch.ts";
import { ageWords } from "./sidebarModel.ts";

// The Search Deck field at the top of the rail, and its results panel.
//
// The panel is drawn on document.body: a glass card's backdrop-filter squeezes
// fixed children, and the rail clips what overflows it. Focus never leaves the
// field; the arrow keys move a highlighted row instead.

export interface SearchDeckProps {
  machines: SearchMachine[];
  /** One connection per machine per window; null when it can't be reached. */
  portOf(id: string): SearchPort | null;
  settings(query: string): SettingMatch[];
  /** Open the thing. `query` is what was typed, for checking a message still matches. */
  onOpen(place: RecentPlace, query: string): void;
  /** Bumped by the shortcut to put the cursor in the field. */
  focusRequest?: number;
  /** The shortcut as printed: "⌘P". */
  shortcut?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

type Chip = "all" | "thread" | "message" | "setting";
const CHIPS: { id: Chip; label: string; filters: SearchFilters }[] = [
  { id: "all", label: "All", filters: { kinds: TIER_1_KINDS, settings: true } },
  { id: "thread", label: "Threads", filters: { kinds: ["thread"], settings: false } },
  { id: "message", label: "Messages", filters: { kinds: ["message"], settings: false } },
  { id: "setting", label: "Settings", filters: { kinds: [], settings: true } },
];

function folderOf(path: string | null): string { return path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path : ""; }

/** The quiet line under a row: where the hit lives. No type word; the group heading says that. */
function detailOf(hit: MergedHit, manyMachines: boolean): string {
  const t = hit.target;
  const parts: string[] = [];
  if (t.type === "project") { if (hit.snippet !== t.path) parts.push(t.path); }
  else if (t.type === "setting") parts.push(hit.project ?? "");
  else {
    if (hit.project) parts.push(folderOf(hit.project));
    if (t.type === "message") { if (hit.roomTitle) parts.push(hit.roomTitle); parts.push(t.speaker); }
  }
  if (manyMachines && hit.machineName && t.type !== "setting") parts.push(hit.machineName);
  if (hit.trashed) parts.push("In Trash"); else if (hit.archived) parts.push("Archived");
  return parts.filter(Boolean).join(" · ");
}

function placeOf(hit: MergedHit, manyMachines: boolean): RecentPlace {
  const title = hit.kind === "message" ? hit.roomTitle ?? hit.title : hit.title;
  return { key: hit.key, title, kind: hit.kind, machineId: hit.machineId, target: hit.target, detail: detailOf(hit, manyMachines) };
}

export function SearchDeck({ machines, portOf, settings, onOpen, focusRequest = 0, shortcut, storage = localStorage }: SearchDeckProps) {
  const [text, setText] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SearchView>(emptyView);
  const [expanded, setExpanded] = useState<ReadonlySet<GroupKind>>(new Set());
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<Recents>(() => loadRecents(storage));
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<HTMLElement | null>(null);
  const live = useRef({ machines, portOf, settings });
  live.current = { machines, portOf, settings };

  const control = useRef<SearchControl | null>(null);
  if (!control.current) control.current = createSearch({
    machines: () => live.current.machines, portOf: (id) => live.current.portOf(id), settings: (q) => live.current.settings(q), onView: setView,
  });
  useEffect(() => () => control.current?.close(), []);

  const ask = (value: string, which: Chip) => {
    setExpanded(new Set());
    setActive(0);
    control.current!.setQuery(value, CHIPS.find((c) => c.id === which)!.filters);
  };

  const manyMachines = machines.length > 1;
  const asked = !!parseQuery(text);
  const groups = asked ? view.groups : [];
  /** Every row the arrow keys can reach, in the order drawn. */
  const rows = useMemo(() => asked
    ? groups.flatMap((group) => shownRows(group, expanded).map((hit) => placeOf(hit, manyMachines)))
    : recents.places, [asked, groups, expanded, recents.places, manyMachines]);
  const at = Math.min(active, Math.max(0, rows.length - 1));

  const place = () => {
    const rect = field.current?.getBoundingClientRect();
    if (rect) setBox({ left: Math.round(rect.left), top: Math.round(rect.bottom + 6) });
  };
  const show = () => {
    if (!open) {
      const now = document.activeElement as HTMLElement | null;
      cameFrom.current = now && now !== field.current && now !== document.body ? now : cameFrom.current;
      setRecents(loadRecents(storage));
    }
    place();
    setOpen(true);
  };
  const hide = (restoreFocus: boolean) => {
    setOpen(false);
    control.current!.close();
    if (!restoreFocus) return;
    const back = cameFrom.current;
    cameFrom.current = null;
    if (back?.isConnected) back.focus(); else field.current?.blur();
  };

  useEffect(() => {
    if (!focusRequest) return;
    const now = document.activeElement as HTMLElement | null;
    if (now && now !== field.current && now !== document.body) cameFrom.current = now;
    field.current?.focus();
    field.current?.select();
    show();
  }, [focusRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !field.current?.contains(target)) hide(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("pointerdown", outside, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(`[data-row="${at}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [at, rows.length]);

  const remember = (next: Recents) => { setRecents(next); saveRecents(storage, next); };
  const choose = (row: RecentPlace | undefined) => {
    if (!row) return;
    const query = text.trim();
    remember({ searches: asked ? pushRecent(recents.searches, query, (x) => x.toLocaleLowerCase()) : recents.searches, places: pushRecent(recents.places, row, (p) => p.key) });
    cameFrom.current = null;
    setOpen(false);
    control.current!.close();
    field.current?.blur();
    onOpen(row, query);
  };

  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(true); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { show(); return; }
      if (rows.length) setActive((at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      return;
    }
    if (event.key === "Enter" && open) { event.preventDefault(); choose(rows[at]); }
  };

  /** Mouse presses in the panel must not take the cursor out of the field. */
  const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();
  const pickChip = (next: Chip) => { setChip(next); ask(text, next); };
  const expand = (kind: GroupKind) => { setExpanded((old) => new Set(old).add(kind)); control.current!.expand(kind); };

  const waiting = view.machines.filter((m) => m.state === "searching");
  const lines = view.machines.map((m) => ({ machine: m, text: machineLine(m) })).filter((l): l is { machine: SearchView["machines"][number]; text: string } => !!l.text);
  const now = Date.now();
  let index = -1;
  const drawRow = (row: RecentPlace, hit: MergedHit | null) => {
    index += 1;
    const mine = index;
    // A name found by its other field (a project by its folder) shows the name, then the matching text.
    const aside = !!hit && hit.kind !== "message" && !!hit.snippet && hit.snippet !== hit.title;
    const parts = !hit ? [{ text: row.title, hit: false }]
      : aside ? [{ text: `${hit.title} · `, hit: false }, ...highlightParts(hit.snippet, hit.ranges)]
      : highlightParts(hit.snippet || hit.title, hit.snippet ? hit.ranges : []);
    return <div key={`${row.key}:${mine}`} id={`search-deck-row-${mine}`} role="option" aria-selected={mine === at} data-row={mine}
      className={mine === at ? "search-deck-row active" : "search-deck-row"} onMouseDown={keepFocus} onMouseMove={() => { if (mine !== at) setActive(mine); }} onClick={() => choose(row)}>
      <span className="search-deck-main">
        <span className="search-deck-title">{parts.map((part, n) => part.hit ? <mark key={n}>{part.text}</mark> : <span key={n}>{part.text}</span>)}</span>
        {row.detail ? <span className="search-deck-detail">{row.detail}</span> : null}
      </span>
      {hit?.at ? <span className="search-deck-time">{ageWords(now - hit.at)}</span> : null}
    </div>;
  };

  const body = () => {
    if (!asked) {
      if (!recents.searches.length && !recents.places.length) return <p className="search-deck-empty">Type two or more letters to search names, messages and settings on every machine.</p>;
      return <>
        {recents.searches.length > 0 && <>
          <div className="search-deck-head"><h3>Recent searches</h3><button type="button" className="search-deck-link" onMouseDown={keepFocus} onClick={() => remember({ ...recents, searches: [] })}>Clear</button></div>
          <div className="search-deck-words">{recents.searches.map((word) => <button type="button" key={word} tabIndex={-1} onMouseDown={keepFocus} onClick={() => { setText(word); ask(word, chip); }}>{word}</button>)}</div>
        </>}
        {recents.places.length > 0 && <><div className="search-deck-head"><h3>Recent places</h3></div>{recents.places.map((row) => drawRow(row, null))}</>}
      </>;
    }
    if (!groups.length) return <p className="search-deck-empty" role="status">{waiting.length ? "Searching…" : `No matches for “${text.trim()}” in saved history.`}</p>;
    return groups.map((group) => {
      const shown = shownRows(group, expanded);
      const more = !expanded.has(group.kind) && group.total > shown.length;
      return <section key={group.kind} aria-label={GROUP_LABEL[group.kind]}>
        <div className="search-deck-head"><h3>{GROUP_LABEL[group.kind]}</h3>
          {more && <button type="button" className="search-deck-link" tabIndex={-1} onMouseDown={keepFocus} onClick={() => expand(group.kind)}>{showMoreLabel(group)}</button>}
        </div>
        {shown.map((hit) => drawRow(placeOf(hit, manyMachines), hit))}
      </section>;
    });
  };

  return <div className="search-deck">
    <label className="visually-hidden" htmlFor="search-deck-field">Search Deck</label>
    <input ref={field} id="search-deck-field" className="search-deck-field" type="search" placeholder="Search Deck…" autoComplete="off" spellCheck={false}
      role="combobox" aria-expanded={open} aria-controls="search-deck-panel" aria-autocomplete="list" aria-activedescendant={open && rows.length ? `search-deck-row-${at}` : undefined}
      title={shortcut ? `Search Deck (${shortcut})` : "Search Deck"} value={text}
      onChange={(event) => { setText(event.target.value); show(); ask(event.target.value, chip); }}
      onFocus={show} onClick={show} onKeyDown={onKey} />
    {shortcut && !text && <kbd className="search-deck-key" aria-hidden="true">{shortcut}</kbd>}
    {open && box && createPortal(
      <div ref={panel} id="search-deck-panel" className="search-deck-panel" style={{ left: box.left, top: box.top, maxHeight: `calc(100vh - ${box.top + 12}px)` }}>
        <div className="search-deck-chips" role="group" aria-label="Show">
          {CHIPS.map((c) => <button type="button" key={c.id} tabIndex={-1} aria-pressed={chip === c.id} onMouseDown={keepFocus} onClick={() => pickChip(c.id)}>{c.label}</button>)}
        </div>
        <div className="search-deck-scroll" role="listbox" aria-label={asked ? "Matches" : "Recent places"}>{body()}</div>
        {asked && (lines.length > 0 || view.notes.length > 0 || (waiting.length > 0 && groups.length > 0)) && <footer className="search-deck-status" role="status">
          {waiting.length > 0 && groups.length > 0 && <p>Still searching {waiting.map((m) => m.name).join(", ")}…</p>}
          {lines.map(({ machine, text: line }) => <p key={machine.id}>{line}
            {(machine.state === "offline" || machine.state === "refused") && <> <button type="button" className="search-deck-link" tabIndex={-1} onMouseDown={keepFocus} onClick={() => control.current!.retry(machine.id)}>Retry</button></>}
          </p>)}
          {view.notes.map((note) => <p key={note}>{note}</p>)}
        </footer>}
      </div>, document.body)}
  </div>;
}
