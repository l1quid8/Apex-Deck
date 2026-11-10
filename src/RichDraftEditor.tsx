import { useLayoutEffect, useRef } from 'react';
import { DRAFT_MIME, decodeClipboard, encodeClipboard, type Caret, type DraftDoc, type DraftNames, type Token } from './sliceDraft.ts';
import './RichDraftEditor.css';

export interface RichDraftEditorProps {
  doc: DraftDoc;
  onChange(doc: DraftDoc, caret: Caret): void;
  caret: Caret | null;
  chip(token: Token): { label: string; title: string; problem?: boolean; flash?: boolean; busy?: boolean };
  draftId: string;
  names: DraftNames;
  known: { thread(id: string): boolean; file(id: string): boolean };
  onAttachFiles(files: File[], at: Caret): void;
  onTrigger(kind: '#' | '@', query: string, at: DOMRect): void;
  /** Keep host menus and insertion points in sync with native navigation. */
  onTriggerClose?(): void;
  onCaretChange?(caret: Caret): void;
}

type Unit = string | Exclude<Token, { kind: 'text' }>;
type Selection = { start: number; end: number };
type Snapshot = { doc: DraftDoc; selection: Selection };
const equal = (a: DraftDoc, b: DraftDoc) => JSON.stringify(a) === JSON.stringify(b);
const units = (doc: DraftDoc): Unit[] => doc.flatMap((line, index) => [
  ...(index ? ['\n'] : []), ...line.flatMap<Unit>(token => token.kind === 'text' ? token.text.split('') : [token]),
]);
function documentFrom(value: Unit[]): DraftDoc {
  const doc: DraftDoc = [[]];
  for (const unit of value) {
    if (unit === '\n') { doc.push([]); continue; }
    const line = doc[doc.length - 1];
    if (typeof unit !== 'string') line.push(unit);
    else if (line.at(-1)?.kind === 'text') (line.at(-1) as { kind: 'text'; text: string }).text += unit;
    else line.push({ kind: 'text', text: unit });
  }
  return doc;
}
const absolute = (doc: DraftDoc, caret: Caret) => {
  const line = Math.max(0, Math.min(caret.line, Math.max(0, doc.length - 1)));
  return doc.slice(0, line).reduce((at, tokens) => at + units([tokens]).length + 1, 0)
    + Math.min(caret.offset, units([doc[line] ?? []]).length);
};
function relative(doc: DraftDoc, at: number): Caret {
  for (let line = 0; line < Math.max(1, doc.length); line++) {
    const length = units([doc[line] ?? []]).length;
    if (at <= length || line === doc.length - 1) return { line, offset: Math.max(0, Math.min(length, at)) };
    at -= length + 1;
  }
  return { line: 0, offset: 0 };
}
function inline(node: Node): Unit[] {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').split('');
  if (!(node instanceof HTMLElement)) return [];
  if (node.dataset.token) {
    try { return [JSON.parse(node.dataset.token) as Exclude<Token, { kind: 'text' }>]; } catch { return []; }
  }
  return Array.from(node.childNodes).flatMap(inline);
}
function readDOM(root: HTMLElement): DraftDoc {
  return documentFrom(Array.from(root.childNodes).flatMap((node, index) => [
    ...(index ? ['\n'] : []), ...inline(node),
  ]));
}
function point(root: HTMLElement, node: Node, offset: number): number {
  if (node === root) return Array.from(root.children).slice(0, offset).reduce((at, line) => at + inline(line).length + 1, 0);
  const chip = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-token]');
  if (chip && root.contains(chip)) {
    return point(root, chip.parentNode!, Array.from(chip.parentNode!.childNodes).indexOf(chip)) + (offset ? 1 : 0);
  }
  let line: Node = node;
  while (line.parentNode && line.parentNode !== root) line = line.parentNode;
  if (line.parentNode !== root) return 0;
  const index = Array.from(root.childNodes).indexOf(line as ChildNode);
  const prefix = document.createRange();
  prefix.selectNodeContents(line);
  prefix.setEnd(node, offset);
  return Array.from(root.childNodes).slice(0, index).reduce((at, row) => at + inline(row).length + 1, 0)
    + Array.from(prefix.cloneContents().childNodes).flatMap(inline).length;
}
function selection(root: HTMLElement, fallback: number): Selection {
  const selected = window.getSelection();
  if (!selected?.rangeCount || !root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) return { start: fallback, end: fallback };
  const range = selected.getRangeAt(0);
  return { start: point(root, range.startContainer, range.startOffset), end: point(root, range.endContainer, range.endOffset) };
}
function place(root: HTMLElement, doc: DraftDoc, selected: Selection) {
  const locate = (at: number): [Node, number] => {
    const caret = relative(doc, at);
    const line = root.children[caret.line] ?? root.firstChild!;
    let remaining = caret.offset;
    for (const child of line.childNodes) {
      const length = inline(child).length;
      if (child.nodeType === Node.TEXT_NODE && remaining <= length) return [child, remaining];
      if (remaining < length) return [line, Array.from(line.childNodes).indexOf(child)];
      remaining -= length;
    }
    return [line, line.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...locate(selected.start)); range.setEnd(...locate(selected.end));
  const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(range);
}

export function RichDraftEditor(props: RichDraftEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const state = useRef({ doc: props.doc, draftId: props.draftId, undo: [] as Snapshot[], redo: [] as Snapshot[], composing: false,
    composition: null as (Snapshot & { data: string; draftId: string }) | null, caret: null as Caret | null,
    group: '', time: 0, fallback: 0, drag: null as { token: Unit; at: number } | null });
  const paint = (doc: DraftDoc, selected?: Selection) => {
    const editor = root.current!;
    if (state.current.composing) return;
    editor.replaceChildren(...(doc.length ? doc : [[]]).map((tokens, index) => {
      const line = document.createElement('div'); line.dataset.line = String(index);
      for (const token of tokens) {
        if (token.kind === 'text') { line.append(document.createTextNode(token.text)); continue; }
        const info = latest.current.chip(token);
        const chip = document.createElement('span');
        chip.contentEditable = 'false'; chip.draggable = true; chip.dataset.token = JSON.stringify(token);
        chip.className = `rich-draft-chip ${token.kind}${info.problem ? ' problem' : ''}${info.flash ? ' flash' : ''}`;
        chip.title = info.title; chip.setAttribute('aria-label', info.label);
        if (info.busy) {
          chip.setAttribute('aria-busy', 'true');
          const spinner = document.createElement('span'); spinner.className = 'rich-draft-spinner'; spinner.setAttribute('aria-hidden', 'true'); chip.append(spinner);
        }
        chip.append(document.createTextNode(info.label)); line.append(chip);
      }
      if (!line.childNodes.length) line.append(document.createElement('br'));
      return line;
    }));
    if (selected) place(editor, doc, selected);
  };
  useLayoutEffect(() => {
    const current = state.current;
    const changedDraft = props.draftId !== current.draftId;
    if (changedDraft) {
      current.draftId = props.draftId; current.undo = []; current.redo = []; current.group = ''; current.drag = null;
      latest.current.onTriggerClose?.();
    }
    if (current.composing) return;
    if (!changedDraft && !equal(props.doc, current.doc)) {
      current.undo.push({ doc: current.doc, selection: selection(root.current!, current.fallback) });
      if (current.undo.length > 100) current.undo.shift();
      current.redo = []; current.group = '';
    }
    const selected = props.caret && props.caret !== current.caret ? { start: absolute(props.doc, props.caret), end: absolute(props.doc, props.caret) }
      : document.activeElement === root.current ? selection(root.current!, current.fallback) : undefined;
    current.caret = props.caret;
    current.doc = props.doc;
    if (selected) current.fallback = selected.end;
    paint(props.doc, selected);
  });

  useLayoutEffect(() => {
    const editor = root.current!, current = state.current;
    editor.focus();
    const notifyTrigger = () => {
      if (current.composing) return;
      const selected = selection(editor, current.fallback);
      if (selected.start !== selected.end) { latest.current.onTriggerClose?.(); return; }
      current.fallback = selected.end;
      latest.current.onCaretChange?.(relative(current.doc, selected.end));
      const before = units(current.doc).slice(0, selected.end).map(unit => typeof unit === 'string' ? unit : '\uFFFC').join('');
      const match = before.match(/(?:^|[\s\uFFFC])([#@])([^\s#@\uFFFC]*)$/);
      if (!match) { latest.current.onTriggerClose?.(); return; }
      const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
      latest.current.onTrigger(match[1] as '#' | '@', match[2], range?.getBoundingClientRect() ?? editor.getBoundingClientRect());
    };
    const apply = (doc: DraftDoc, next: Selection, action: string, before = selection(editor, current.fallback)) => {
      if (equal(doc, current.doc)) return;
      const now = Date.now();
      if (!action || action !== current.group || now - current.time > 1000 || (before.start !== current.fallback && before.end !== current.fallback)) {
        current.undo.push({ doc: current.doc, selection: before });
        if (current.undo.length > 100) current.undo.shift();
      }
      current.group = action; current.time = now; current.redo = [];
      current.doc = doc; current.fallback = next.end;
      paint(doc, next); latest.current.onChange(doc, relative(doc, next.end)); notifyTrigger();
    };
    const replace = (value: Unit[], action = '', selected = selection(editor, current.fallback)) => {
      const all = units(current.doc);
      all.splice(selected.start, selected.end - selected.start, ...value);
      const at = selected.start + value.length;
      apply(documentFrom(all), { start: at, end: at }, action, selected);
    };
    const history = (redo: boolean) => {
      const from = redo ? current.redo : current.undo, to = redo ? current.undo : current.redo;
      while (from.length) {
        const snapshot = from.pop()!;
        const filtered = documentFrom(units(snapshot.doc).filter(token => typeof token === 'string' || token.kind !== 'file' || latest.current.known.file(token.fileId)));
        if (equal(filtered, current.doc)) continue;
        to.push({ doc: current.doc, selection: selection(editor, current.fallback) });
        current.doc = filtered; current.group = '';
        const selected = { start: Math.min(snapshot.selection.start, units(filtered).length), end: Math.min(snapshot.selection.end, units(filtered).length) };
        current.fallback = selected.end; paint(filtered, selected);
        latest.current.onChange(filtered, relative(filtered, selected.end)); notifyTrigger(); return;
      }
    };
    const beforeinput = (event: InputEvent) => {
      if (current.composing || event.isComposing || event.inputType === 'insertCompositionText') {
        if (current.composition && event.data !== null) current.composition.data = event.data;
        return;
      }
      event.preventDefault();
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { history(event.inputType === 'historyRedo'); return; }
      if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') { replace((event.data ?? '').split(''), 'typing'); return; }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') { replace(['\n']); return; }
      if (event.inputType.startsWith('delete')) {
        const selected = selection(editor, current.fallback), all = units(current.doc);
        if (selected.start === selected.end) {
          const backwards = event.inputType.endsWith('Backward');
          const dir = backwards ? -1 : 1;
          let at = backwards ? selected.start : selected.end;
          if (event.inputType.includes('Word')) {
            while (at + dir >= 0 && at + dir <= all.length) {
              const unit = all[backwards ? at - 1 : at];
              at += dir;
              if (typeof unit !== 'string' || /\s/.test(unit)) break;
            }
          } else at = Math.max(0, Math.min(all.length, at + dir));
          if (backwards) selected.start = at; else selected.end = at;
        }
        replace([], 'delete', selected);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (current.composing || event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey); }
      else if (!['Backspace', 'Delete'].includes(event.key)) current.group = '';
    };
    const copy = (event: ClipboardEvent) => {
      if (!event.clipboardData || current.composing) return;
      const selected = selection(editor, current.fallback);
      if (selected.start === selected.end) return;
      const encoded = encodeClipboard(documentFrom(units(current.doc).slice(selected.start, selected.end)), latest.current.draftId, latest.current.names);
      event.preventDefault(); event.clipboardData.setData('text/plain', encoded.plain); event.clipboardData.setData(DRAFT_MIME, encoded.json);
      if (event.type === 'cut') replace([], '', selected);
    };
    const paste = (event: ClipboardEvent) => {
      if (!event.clipboardData || current.composing) return;
      event.preventDefault();
      const selected = selection(editor, current.fallback);
      const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
      if (files.length) { latest.current.onAttachFiles(files, relative(current.doc, selected.start)); return; }
      const decoded = decodeClipboard(event.clipboardData.getData(DRAFT_MIME), latest.current.draftId, latest.current.known);
      replace(decoded ? units(decoded) : event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').split(''));
    };
    const compositionstart = () => {
      current.composing = true; current.group = '';
      latest.current.onTriggerClose?.();
      current.composition = { doc: current.doc, selection: selection(editor, current.fallback), data: '', draftId: current.draftId };
    };
    const compositionend = (event: CompositionEvent) => {
      const saved = current.composition;
      current.composing = false; current.composition = null;
      if (!saved) return;
      if (saved.draftId !== latest.current.draftId) {
        current.doc = latest.current.doc;
        const at = latest.current.caret ? absolute(current.doc, latest.current.caret) : 0;
        current.fallback = at; paint(current.doc, { start: at, end: at }); return;
      }
      let doc = readDOM(editor);
      // Synthetic composition has no browser default edit. Real IME is read from
      // the untouched DOM; the fallback also handles canceled default insertion.
      if (equal(doc, saved.doc) && (event.data || saved.data)) {
        replace((event.data || saved.data).split(''), '', saved.selection);
      } else {
        const selected = selection(editor, current.fallback);
        apply(doc, selected, '', saved.selection);
        if (equal(doc, current.doc)) paint(doc, selected);
      }
    };
    const dragstart = (event: DragEvent) => {
      const chip = (event.target as Element).closest<HTMLElement>('[data-token]');
      if (!chip || !event.dataTransfer) return;
      const at = point(editor, chip.parentNode!, Array.from(chip.parentNode!.childNodes).indexOf(chip));
      const token = units(current.doc)[at];
      current.drag = { token, at }; event.dataTransfer.effectAllowed = 'copyMove';
      const encoded = encodeClipboard(documentFrom([token]), latest.current.draftId, latest.current.names);
      event.dataTransfer.setData(DRAFT_MIME, encoded.json); event.dataTransfer.setData('text/plain', encoded.plain);
    };
    const drop = (event: DragEvent) => {
      if (current.composing) return;
      event.preventDefault();
      const range = (document as Document & { caretRangeFromPoint(x: number, y: number): Range | null }).caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!range || !editor.contains(range.startContainer)) return;
      let at = point(editor, range.startContainer, range.startOffset);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) { latest.current.onAttachFiles(files, relative(current.doc, at)); return; }
      const drag = current.drag;
      if (!drag) return;
      const all = units(current.doc);
      if (!event.altKey) { all.splice(drag.at, 1); if (at > drag.at) at--; }
      all.splice(at, 0, drag.token); current.drag = null;
      apply(documentFrom(all), { start: at + 1, end: at + 1 }, '');
    };
    const dragover = (event: DragEvent) => { if (current.drag || event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    const dragend = () => { current.drag = null; };
    const blur = () => { latest.current.onTriggerClose?.(); };
    const listeners = { beforeinput, keydown, copy, cut: copy, paste, compositionstart, compositionend, dragstart, dragover, drop, dragend, keyup: notifyTrigger, mouseup: notifyTrigger, blur };
    for (const [name, fn] of Object.entries(listeners)) editor.addEventListener(name, fn as EventListener);
    return () => { for (const [name, fn] of Object.entries(listeners)) editor.removeEventListener(name, fn as EventListener); };
  }, []);
  return <div ref={root} className="rich-draft-editor" contentEditable suppressContentEditableWarning role="textbox" aria-label="Message multiple threads" aria-multiline="true" spellCheck />;
}

export default RichDraftEditor;
