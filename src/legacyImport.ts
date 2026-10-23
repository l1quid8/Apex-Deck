// Typed client for the host's legacy ledger import (docs/security/provenance-boundary.md,
// "Legacy data and activation gate"). Preview and history are read-only. Apply is a
// protected UI intent: desktop/provenance.mjs attests it, and it binds exactly the
// hashes a preview showed. Nothing imported is ever presented as verified.
import type { Backend } from "./backend";

export const LEGACY_IMPORT_CAPABILITY = "assistant_legacy_import_v1";
/** Stable token on the existing string-error wire; independent of host/IPC copy. */
export const LEGACY_IMPORT_PREVIEW_CHANGED = "LEGACY_IMPORT_PREVIEW_CHANGED";
export class LegacyImportPreviewChangedError extends Error {
  readonly code = LEGACY_IMPORT_PREVIEW_CHANGED;
  constructor() {
    super("Your old files changed since this preview — review again.");
    this.name = "LegacyImportPreviewChangedError";
  }
}

export type LegacyMarker = {
  sourceSha256: string; importedAtMs: number; originalId?: string; originalStatus?: string; verified: false;
};

export type LegacyLedgerName =
  | "assistant-tasks-v1.json" | "assistant-conversations-v1.json" | "room-authority-v1.json"
  | "personal-assistants.json" | "personal-machine.json";
/** Only these can be imported by this host version. */
export const IMPORTABLE_LEDGERS: readonly LegacyLedgerName[] = ["assistant-tasks-v1.json", "assistant-conversations-v1.json", "room-authority-v1.json", "personal-assistants.json"];
export type LegacyLedgerState = "ready" | "imported" | "conflict" | "missing" | "unreadable" | "unavailable" | "notSupported";
export type LegacyRecordKind = "task" | "conversation" | "room" | "assistant" | "memory" | "schedule" | "rule" | "approval" | "grant" | "personalTask" | "history";
export type LegacyRow = { id: string; kind: LegacyRecordKind; title: string; originalStatus: string; importStatus: string; reason: string };
export type LegacyProblem = { id: string; reason: string };
export type LegacyLedgerPreview = {
  ledger: LegacyLedgerName; sourcePath: string; size: number; sha256?: string; state: LegacyLedgerState; reason: string;
  counts: { records: number; importable: number; notImported: number }; records: LegacyRow[]; problems: LegacyProblem[];
};
export type LegacySnapshot = { id: string; path: string; createdAtMs: number; reused: boolean };
export type LegacyImportPreview = { snapshot: LegacySnapshot | null; ledgers: LegacyLedgerPreview[] };
export type LegacyLedgerResult = {
  ledger: LegacyLedgerName; state: "imported" | "alreadyImported" | "failed" | "notAttempted";
  imported: number; skipped: number; skippedIds?: string[]; verified: boolean; importedAtMs?: number; error?: string | null;
};
export type LegacyImportResult = { snapshot: string; complete: boolean; ledgers: LegacyLedgerResult[] };
/** A full legacy transcript from the hashed snapshot. `record` is the original, unverified JSON. */
export type LegacyHistory = { snapshot: string; requestId: string; sourceSha256: string; verified: false; label: string; record: unknown };
export type LegacyImportApi = {
  /** Explains why the host cannot import, without sending anything. */
  unavailable(): string | undefined;
  preview(): Promise<LegacyImportPreview>;
  /** Import the ready ledgers of `preview` (or only `ledgers`), bound to their previewed hashes. */
  apply(preview: LegacyImportPreview, ledgers?: readonly LegacyLedgerName[]): Promise<LegacyImportResult>;
  history(snapshot: string, requestId: string): Promise<LegacyHistory>;
};

const ledgerNames = new Set<string>(["assistant-tasks-v1.json", "assistant-conversations-v1.json", "room-authority-v1.json", "personal-assistants.json", "personal-machine.json"]);
const states = new Set<string>(["ready", "imported", "conflict", "missing", "unreadable", "unavailable", "notSupported"]);
const kinds = new Set<string>(["task", "conversation", "room", "assistant", "memory", "schedule", "rule", "approval", "grant", "personalTask", "history"]);
const resultStates = new Set<string>(["imported", "alreadyImported", "failed", "notAttempted"]);
const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string => text(value) && /^[0-9a-f]{64}$/.test(value);
const snapshotId = (value: unknown): value is string => text(value) && /^\d{8}-\d{6}(-\d{1,4})?$/.test(value);

function invalid(what: string): never {
  throw new Error(`The machine returned an invalid legacy import ${what}.`);
}

function checkPreview(value: unknown): LegacyImportPreview {
  if (!object(value) || !Array.isArray(value.ledgers)) invalid("preview");
  const snapshot = value.snapshot;
  if (snapshot !== null && (!object(snapshot) || !snapshotId(snapshot.id) || !text(snapshot.path) || !count(snapshot.createdAtMs) || typeof snapshot.reused !== "boolean")) invalid("snapshot");
  for (const ledger of value.ledgers as unknown[]) {
    if (!object(ledger) || !ledgerNames.has(ledger.ledger as string) || !text(ledger.sourcePath) || !count(ledger.size) || !states.has(ledger.state as string)
      || !text(ledger.reason) || (ledger.sha256 !== undefined && !hash(ledger.sha256)) || (ledger.state === "ready" && !hash(ledger.sha256))
      || !object(ledger.counts) || !count(ledger.counts.records) || !count(ledger.counts.importable) || !count(ledger.counts.notImported)
      || !Array.isArray(ledger.records) || !Array.isArray(ledger.problems)) invalid("ledger");
    for (const row of ledger.records as unknown[]) {
      if (!object(row) || !text(row.id) || !kinds.has(row.kind as string) || !text(row.title) || !text(row.originalStatus) || !text(row.importStatus) || !text(row.reason)) invalid("record");
    }
    for (const problem of ledger.problems as unknown[]) if (!object(problem) || !text(problem.id) || !text(problem.reason)) invalid("problem");
  }
  return structuredClone(value as LegacyImportPreview);
}

function checkResult(value: unknown, snapshot: string): LegacyImportResult {
  if (!object(value) || value.snapshot !== snapshot || typeof value.complete !== "boolean" || !Array.isArray(value.ledgers)) invalid("result");
  for (const ledger of value.ledgers as unknown[]) {
    if (!object(ledger) || !ledgerNames.has(ledger.ledger as string) || !resultStates.has(ledger.state as string) || !count(ledger.imported) || !count(ledger.skipped)
      || typeof ledger.verified !== "boolean" || (ledger.error != null && !text(ledger.error))
      || (ledger.skippedIds !== undefined && (!Array.isArray(ledger.skippedIds) || !ledger.skippedIds.every(text)))) invalid("ledger result");
  }
  return structuredClone(value as LegacyImportResult);
}

export function createLegacyImportClient({ route }: { route: Pick<Backend, "call" | "supports"> }): LegacyImportApi {
  const need = () => {
    if (route.supports?.(LEGACY_IMPORT_CAPABILITY) !== true) throw new Error("Update this machine's service to import data saved before protected provenance.");
  };
  return {
    unavailable: () => { try { need(); return undefined; } catch (error) { return error instanceof Error ? error.message : String(error); } },
    preview: async () => {
      need();
      return checkPreview(await route.call<unknown>("legacy_import_preview", {}));
    },
    apply: async (preview, ledgers) => {
      need();
      const snapshot = preview.snapshot?.id;
      if (!snapshotId(snapshot)) throw new Error("There is nothing to import. Preview again.");
      const chosen = ledgers ?? preview.ledgers.filter(l => l.state === "ready").map(l => l.ledger);
      const sources: Record<string, string> = {};
      for (const name of chosen) {
        const ledger = preview.ledgers.find(l => l.ledger === name);
        if (!ledger || ledger.state !== "ready" || !hash(ledger.sha256) || !IMPORTABLE_LEDGERS.includes(name)) throw new Error(`${name} is not ready to import. Preview again.`);
        sources[name] = ledger.sha256;
      }
      if (!Object.keys(sources).length) throw new Error("There is nothing ready to import.");
      let result: unknown;
      try {
        result = await route.call<unknown>("legacy_import_apply", { snapshot, sources });
      } catch (error) {
        // Electron can wrap the host error in its IPC method name and "Error:"
        // prefix. Only the explicit machine token identifies this refusal.
        const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
        if (message.includes(`[${LEGACY_IMPORT_PREVIEW_CHANGED}]`)) throw new LegacyImportPreviewChangedError();
        throw error;
      }
      return checkResult(result, snapshot);
    },
    history: async (snapshot, requestId) => {
      need();
      if (!snapshotId(snapshot) || !text(requestId) || !requestId) throw new Error("Choose a legacy conversation to read.");
      const value = await route.call<unknown>("legacy_import_history", { snapshot, requestId });
      if (!object(value) || value.snapshot !== snapshot || value.requestId !== requestId || !hash(value.sourceSha256) || !text(value.label) || !("record" in value)) invalid("history");
      if (value.verified !== false) throw new Error("Legacy history must be labelled unverified.");
      return structuredClone(value as LegacyHistory);
    },
  };
}
