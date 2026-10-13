import type { FilePreview } from "./types";

export type SaveErrorKind = "conflict" | "outdated-daemon" | "other";
export type EditablePreview = Extract<FilePreview, { kind: "text" }>;

/** Only whole, readable text files can be edited. The daemon refuses the rest too. */
export function isEditable(preview: FilePreview | null, view: "file" | "changes", deleted: boolean): preview is EditablePreview {
  return !!preview && preview.kind === "text" && !preview.truncated && preview.editable !== false && view === "file" && !deleted;
}

export const isDirty = (text: string, savedText: string) => text !== savedText;

export function saveErrorKind(error: unknown): SaveErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("changed-on-disk")) return "conflict";
  if (/unknown variant|unknown (command|method)/i.test(message)) return "outdated-daemon";
  return "other";
}

export function saveErrorMessage(error: unknown): string {
  const kind = saveErrorKind(error);
  if (kind === "outdated-daemon") return "This machine's Deck needs an update to edit files.";
  return String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, "");
}

/** The line ending a file uses, so the editor keeps it instead of rewriting every line. Undefined when the text has no line break. */
export function lineSeparatorFor(text: string): "\r\n" | "\n" | undefined {
  if (text.includes("\r\n")) return "\r\n";
  return text.includes("\n") ? "\n" : undefined;
}

/** The CodeMirror language for a file name, or null when there isn't one. Loads on demand. */
export async function languageFor(fileName: string) {
  const [{ LanguageDescription }, { languages }] = await Promise.all([import("@codemirror/language"), import("@codemirror/language-data")]);
  return LanguageDescription.matchFilename(languages, fileName)?.load() ?? null;
}

export async function languageName(fileName: string): Promise<string | null> {
  const [{ LanguageDescription }, { languages }] = await Promise.all([import("@codemirror/language"), import("@codemirror/language-data")]);
  return LanguageDescription.matchFilename(languages, fileName)?.name ?? null;
}
