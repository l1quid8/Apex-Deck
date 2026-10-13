import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { languageFor } from "./fileEditorModel";
import "./file-editor.css";

/** A CodeMirror 6 editor. The library loads on first use so the main bundle stays small. */
export function FileEditor({ fileName, initialText, onChange, onSave }: { fileName: string; initialText: string; onChange(text: string): void; onSave(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const save = useRef(onSave); save.current = onSave;
  useEffect(() => {
    let live = true;
    void (async () => {
      const [{ EditorState }, cm, commands, search, language, autocomplete, { classHighlighter }, lang] = await Promise.all([
        import("@codemirror/state"), import("@codemirror/view"), import("@codemirror/commands"), import("@codemirror/search"),
        import("@codemirror/language"), import("@codemirror/autocomplete"), import("@lezer/highlight"), languageFor(fileName).catch(() => null),
      ]);
      if (!live || !host.current) return;
      view.current = new cm.EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: initialText,
          extensions: [
            cm.lineNumbers(), cm.highlightActiveLine(), cm.highlightActiveLineGutter(), cm.drawSelection(), cm.EditorView.lineWrapping,
            commands.history(), language.indentOnInput(), language.bracketMatching(), language.syntaxHighlighting(classHighlighter),
            autocomplete.closeBrackets(), search.search({ top: true }), search.highlightSelectionMatches(),
            cm.keymap.of([
              { key: "Mod-s", preventDefault: true, run: () => { save.current(); return true; } },
              ...autocomplete.closeBracketsKeymap, ...commands.defaultKeymap, ...search.searchKeymap, ...commands.historyKeymap, commands.indentWithTab,
            ]),
            ...(lang ? [lang] : []),
            cm.EditorView.updateListener.of((update) => { if (update.docChanged) change.current(update.state.doc.toString()); }),
            cm.EditorView.contentAttributes.of({ "aria-label": `Editing ${fileName}` }),
          ],
        }),
      });
      view.current.focus();
    })();
    return () => { live = false; view.current?.destroy(); view.current = null; };
  }, [fileName, initialText]);
  return <div className="file-editor" ref={host} data-file-editor />;
}
