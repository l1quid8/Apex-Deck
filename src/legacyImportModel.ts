// Pure presentation model for the legacy import screen (brief G2b).
//
// Everything the screen decides — what to offer, what a row means, which hashes an
// apply is bound to, whether a failure was a stale preview — lives here so it can be
// tested without a renderer or a host. The component below it only draws this.
import type {
  LegacyImportPreview, LegacyImportResult, LegacyLedgerName, LegacyLedgerPreview, LegacyRow,
} from "./legacyImport.ts";
import { IMPORTABLE_LEDGERS, LEGACY_IMPORT_PREVIEW_CHANGED } from "./legacyImport.ts";

/** The one label every imported record carries. Never "verified". */
export const LEGACY_MARKER = "Imported · unverified";

/** Plain names for the saved files. No file names, no schema words, in front of a person. */
export const LEDGER_LABELS: Record<LegacyLedgerName, string> = {
  "assistant-tasks-v1.json": "Tasks",
  "assistant-conversations-v1.json": "Conversations",
  "room-authority-v1.json": "Group chats",
  "personal-assistants.json": "Assistants",
  "personal-machine.json": "Machine permissions",
};

// The host writes reasons for machines. A few words from its internals must not
// reach a person: the brief bans them outright. Prefer fixing the host copy; this
// keeps a host wording change from putting jargon on screen in the meantime.
const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/\bledgers\b/gi, "files"],
  [/\bledger\b/gi, "file"],
  [/\bbrokers\b/gi, "apps"],
  [/\bbroker\b/gi, "app"],
  [/\bprovenance\b/gi, "protected storage"],
  [/\bsnapshots\b/gi, "saved copies"],
  [/\bsnapshot\b/gi, "saved copy"],
];

/** Host copy with internal words replaced, for display only. */
export function plain(value: string): string {
  let out = value;
  for (const [pattern, word] of REPLACEMENTS) out = out.replace(pattern, word);
  return out.trim();
}

const STATUS_WORDS: Record<string, string> = {
  queued: "queued",
  running: "running",
  proposed: "waiting for you",
  interrupted: "stopped",
  legacy: "old copy",
  imported: "imported",
  skipped: "not imported",
  notImported: "not imported",
  done: "done",
  failed: "failed",
  approved: "approved",
  pending: "pending",
  paused: "paused",
  granted: "allowed",
  neverRan: "never ran",
};

/** A saved status word in plain language, falling back to the word the host sent. */
export function statusWord(status: string): string {
  const key = status.trim();
  return STATUS_WORDS[key] ?? (key ? plain(key) : "unknown");
}

/** Saved files that still hold records this host has not imported yet. */
export function importableLedgers(preview: LegacyImportPreview): LegacyLedgerPreview[] {
  // IMPORTABLE_LEDGERS is the host version's own statement of what it can import;
  // a file it lists but will not import (machine permissions) is never offered,
  // even if the host reports it ready.
  return preview.ledgers.filter((ledger) => ledger.state === "ready" && ledger.counts.importable > 0
    && IMPORTABLE_LEDGERS.includes(ledger.ledger));
}

/** How many records an import would bring in. */
export function importableCount(preview: LegacyImportPreview): number {
  return importableLedgers(preview).reduce((total, ledger) => total + ledger.counts.importable, 0);
}

/** States that are worth showing even with no records and no per-record problems. */
const ALWAYS_SHOWN = new Set(["unreadable", "unavailable", "conflict"]);

/**
 * Saved files with something to say even when nothing can be imported.
 *
 * A file that could not be read, could not be found by the service, or conflicts
 * with what was already imported is shown on its own merits: its counts are zero
 * and it has no per-record problems precisely *because* it could not be opened, so
 * requiring content would hide the one thing the person needs to be told.
 */
export function interestingLedgers(preview: LegacyImportPreview): LegacyLedgerPreview[] {
  return preview.ledgers.filter((ledger) => {
    if (ledger.state === "missing" || ledger.state === "notSupported") return false;
    if (ALWAYS_SHOWN.has(ledger.state)) return true;
    return ledger.counts.records > 0 || ledger.problems.length > 0;
  });
}

/**
 * What a dismissal is remembered against: this data folder plus the exact content
 * it was dismissed for. New or changed saved files produce a different key, so the
 * notice comes back on its own.
 */
export function noticeKey(dataDir: string, preview: LegacyImportPreview): string {
  const sources = importableLedgers(preview)
    .map((ledger) => `${ledger.ledger}@${ledger.sha256 ?? "unhashed"}`)
    .sort();
  return JSON.stringify({ dataDir, sources });
}

/** Offer the notice only when there is something importable that was not dismissed as-is. */
export function shouldShowNotice(preview: LegacyImportPreview, dataDir: string, dismissed: string | null): boolean {
  if (importableCount(preview) === 0) return false;
  return noticeKey(dataDir, preview) !== dismissed;
}

/** One record as the preview list shows it: what it was, what it becomes, and why. */
export type RowText = { title: string; change: string; reason: string; blocked: boolean };

export function rowText(row: LegacyRow): RowText {
  const blocked = row.importStatus === "skipped" || row.importStatus === "notImported";
  return {
    title: plain(row.title) || "Untitled record",
    change: `${statusWord(row.originalStatus)} → ${statusWord(row.importStatus)}`,
    reason: plain(row.reason),
    blocked,
  };
}

/** A source short enough to compare on screen, e.g. `9a7405e0…4c31`. */
export function shortHash(sha256: string | undefined): string {
  if (!sha256) return "no fingerprint";
  return `${sha256.slice(0, 8)}…${sha256.slice(-4)}`;
}

// `size` arrives in bytes; show the unit rather than a bare number.
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Exactly what the confirm button will import: the previewed files, and the
 * previewed hashes. Derived from the preview on screen rather than remembered, so
 * a refreshed preview can never apply last preview's hashes.
 */
export function applyRequest(preview: LegacyImportPreview): { ledgers: LegacyLedgerName[]; sources: Record<string, string> } {
  const chosen = importableLedgers(preview).filter((ledger) => !!ledger.sha256);
  if (!chosen.length) throw new Error("There is nothing to import.");
  return {
    ledgers: chosen.map((ledger) => ledger.ledger),
    sources: Object.fromEntries(chosen.map((ledger) => [ledger.ledger, ledger.sha256 as string])),
  };
}

/** What the confirm button says. Counts records, not files. */
export function confirmWords(preview: LegacyImportPreview): string {
  const total = importableCount(preview);
  return total === 1 ? "Import 1 record" : `Import ${total} records`;
}

/**
 * Only the typed client refusal identifies stale data. Human-readable copy can
 * change without turning another failure into a stale-preview response.
 */
export function isStalePreview(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === LEGACY_IMPORT_PREVIEW_CHANGED;
}

/** The refusal text itself, already free of internals, for the review-again state. */
export function staleWords(): string {
  return "Your old files changed since this preview — review again.";
}

export type LedgerOutcome = { label: string; imported: number; skipped: number; failed: boolean; error: string };

/** What the result screen lists per file, after an apply. */
export function resultOutcomes(result: LegacyImportResult): LedgerOutcome[] {
  return result.ledgers.map((ledger) => ({
    label: LEDGER_LABELS[ledger.ledger] ?? plain(ledger.ledger),
    imported: ledger.imported,
    skipped: ledger.skipped,
    failed: ledger.state === "failed",
    error: ledger.error ? plain(ledger.error) : "",
  }));
}

/** One line for the top of the result screen. */
export function resultLine(result: LegacyImportResult): string {
  const imported = result.ledgers.reduce((total, ledger) => total + ledger.imported, 0);
  const skipped = result.ledgers.reduce((total, ledger) => total + ledger.skipped, 0);
  const failed = result.ledgers.filter((ledger) => ledger.state === "failed").length;
  const parts = [imported === 1 ? "Imported 1 record" : `Imported ${imported} records`];
  if (skipped) parts.push(skipped === 1 ? "1 left behind" : `${skipped} left behind`);
  if (failed) parts.push(failed === 1 ? "1 file failed" : `${failed} files failed`);
  return `${parts.join(", ")}.`;
}

/** Records named in the result's skipped ids, for a short "left behind" list. */
export function skippedIds(result: LegacyImportResult): string[] {
  return result.ledgers.flatMap((ledger) => ledger.skippedIds ?? []);
}
