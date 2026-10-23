// Legacy import screen (brief G2b). Read-only preview, one explicit confirm bound to
// the hashes on screen, and a result that says what came in and what stayed behind.
// Nothing here imports on its own: no auto-run, no retry, no import on dismiss.
import { useEffect, useRef, useState } from "react";
import type { Backend } from "./backend";
import type { LegacyImportApi, LegacyImportPreview, LegacyImportResult } from "./legacyImport.ts";
import { createLegacyImportClient } from "./legacyImport.ts";
import {
  LEGACY_MARKER, LEDGER_LABELS, applyRequest, confirmWords, fileSize, importableCount, interestingLedgers,
  isStalePreview, noticeKey, plain, resultLine, resultOutcomes, rowText, shouldShowNotice, shortHash, skippedIds, staleWords,
} from "./legacyImportModel.ts";

/** Where a dismissal is kept. Swap it for a fake in tests. */
export type DismissalStore = { read(): string | null; write(key: string): void };

const DISMISSED_KEY = "apex-legacy-import-dismissed";

const remembered: DismissalStore = {
  read() { try { return window.localStorage.getItem(DISMISSED_KEY); } catch { return null; } },
  write(key) { try { window.localStorage.setItem(DISMISSED_KEY, key); } catch { /* Lasts this window. */ } },
};

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.";
  return plain(text) || "Something went wrong.";
}

// One client per backend, and one preview per client per session. A chat pane mounts
// a panel per pane, and a preview hashes up to 23 MB of saved JSON; without this every
// pane would re-read every file. `null` means "already asked, cannot import".
const clients = new WeakMap<Backend, LegacyImportApi | null>();
const previewCache = new WeakMap<LegacyImportApi, Promise<LegacyImportPreview>>();

/** The typed client, or undefined when this machine's service cannot import at all. */
export function legacyImportFor(backend: Backend): LegacyImportApi | undefined {
  const known = clients.get(backend);
  if (known !== undefined) return known ?? undefined;
  const api = createLegacyImportClient({ route: backend });
  const usable = api.unavailable() ? null : api;
  clients.set(backend, usable);
  return usable ?? undefined;
}

function previewOnce(api: LegacyImportApi): Promise<LegacyImportPreview> {
  const cached = previewCache.get(api);
  if (cached) return cached;
  const fresh = api.preview();
  previewCache.set(api, fresh);
  return fresh;
}

/** Drop the shared preview after an import, or when the files moved under it. */
export function forgetPreview(api: LegacyImportApi): void {
  previewCache.delete(api);
}

/** The marker every imported record carries, wherever its status is shown. */
export function LegacyBadge({ label = LEGACY_MARKER }: { label?: string }) {
  return (
    <span className="legacy-badge" title="Saved by an older version of Apex Deck. This machine did not write it, so treat it as unverified.">
      {label}
    </span>
  );
}

type ScreenProps = { api: LegacyImportApi; onClose: () => void; onImported: () => void };

/**
 * Preview → confirm → result. `onImported` lets the caller refresh the views the
 * import touched; this screen never refreshes them itself.
 */
export function LegacyImportScreen({ api, onClose, onImported }: ScreenProps) {
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [result, setResult] = useState<LegacyImportResult | null>(null);
  const [problem, setProblem] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const applying = useRef(false);
  const live = useRef(true);

  const load = (why?: "stale") => {
    setProblem("");
    setStale(why === "stale");
    api.preview().then(
      (next) => { if (live.current) { setPreview(next); setResult(null); } },
      (error) => { if (live.current) setProblem(message(error)); },
    );
  };

  useEffect(() => {
    live.current = true;
    load();
    return () => { live.current = false; };
  }, []);

  const confirm = () => {
    // One apply per click, and never a second one on its own.
    if (!preview || applying.current) return;
    let request: ReturnType<typeof applyRequest>;
    try {
      request = applyRequest(preview);
    } catch (error) {
      setProblem(message(error));
      return;
    }
    applying.current = true;
    setBusy(true);
    setProblem("");
    api.apply(preview, request.ledgers).then(
      (done) => {
        applying.current = false;
        setBusy(false);
        setStale(false);
        setResult(done);
        forgetPreview(api);
        onImported();
      },
      (error) => {
        applying.current = false;
        setBusy(false);
        if (isStalePreview(error)) {
          // The files moved under the preview. Show why, and re-read them; the person
          // has to press Import again on the new preview.
          forgetPreview(api);
          load("stale");
          return;
        }
        setProblem(message(error));
      },
    );
  };

  if (result) {
    const outcomes = resultOutcomes(result);
    const leftBehind = skippedIds(result);
    return (
      <section className="legacy-import" aria-labelledby="legacy-import-done">
        <h3 id="legacy-import-done">Import finished</h3>
        <p role="status">{resultLine(result)}</p>
        {!result.complete && <p className="legacy-import-note">Some files could not be read, so the import is not complete.</p>}
        <ul className="legacy-import-files">
          {outcomes.map((row) => (
            <li key={row.label}>
              <strong>{row.label}</strong>
              <span>{row.imported === 1 ? "1 record" : `${row.imported} records`} imported</span>
              {row.skipped > 0 && <span>{row.skipped === 1 ? "1 left behind" : `${row.skipped} left behind`}</span>}
              {row.failed && <span className="legacy-import-problem">Not imported. {row.error}</span>}
            </li>
          ))}
        </ul>
        {leftBehind.length > 0 && (
          <p className="legacy-import-note">
            Left behind ({(leftBehind.length === 1 ? "1 record" : `${leftBehind.length} records`)}): <span className="mono">{leftBehind.slice(0, 20).join(", ")}</span>
            {leftBehind.length > 20 ? " …" : ""}
          </p>
        )}
        <p className="legacy-import-note">Imported records are marked <LegacyBadge /> until you confirm them.</p>
        <button onClick={onClose}>Done</button>
      </section>
    );
  }

  return (
    <section className="legacy-import" aria-labelledby="legacy-import-title">
      <header>
        <h3 id="legacy-import-title">Older records</h3>
        <button className="icon" onClick={onClose} aria-label="Close older records">×</button>
      </header>
      {!preview && !problem && <p role="status">Looking through your saved files…</p>}
      {problem && <p className="legacy-import-problem" role="alert">{problem} <button onClick={() => load()}>Try again</button></p>}
      {stale && <p className="legacy-import-stale" role="alert">{staleWords()}</p>}
      {preview && (
        <>
          <p role="status">
            {preview.snapshot
              ? <>Found {importableCount(preview) === 1 ? "1 record" : `${importableCount(preview)} records`} to bring in from {interestingLedgers(preview).length === 1 ? "1 file" : `${interestingLedgers(preview).length} files`}. Nothing changes until you import.</>
              : "No older saved files were found."}
          </p>
          {preview.snapshot && <p className="legacy-import-note">Saved copy: <span className="mono">{preview.snapshot.path}</span></p>}
          <ul className="legacy-import-files">
            {interestingLedgers(preview).map((ledger) => {
              const rows = ledger.records.map(rowText);
              const blocked = rows.filter((row) => row.blocked);
              return (
                <li key={ledger.ledger}>
                  <details>
                    <summary>
                      <strong>{LEDGER_LABELS[ledger.ledger] ?? plain(ledger.ledger)}</strong>
                      <span>{ledger.counts.importable === 1 ? "1 record" : `${ledger.counts.importable} records`} to import</span>
                      {ledger.counts.notImported > 0 && <span>{ledger.counts.notImported} stay behind</span>}
                      {ledger.state !== "ready" && <span className="legacy-import-problem">{plain(ledger.reason) || "Not imported."}</span>}
                    </summary>
                    <p className="legacy-import-note">
                      {plain(ledger.sourcePath)} · {fileSize(ledger.size)} · <span className="mono">{shortHash(ledger.sha256)}</span>
                    </p>
                    {rows.length > 0 && (
                      <table className="legacy-import-rows">
                        <caption>{LEDGER_LABELS[ledger.ledger] ?? plain(ledger.ledger)} — what each record is and what it becomes</caption>
                        <thead><tr><th scope="col">Record</th><th scope="col">Change</th><th scope="col">Why</th></tr></thead>
                        <tbody>
                          {rows.map((row, index) => (
                            <tr key={`${ledger.ledger}-${index}`} data-blocked={row.blocked ? "true" : undefined}>
                              <td>{row.title}</td>
                              <td>{row.change}</td>
                              <td>{row.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {blocked.length > 0 && <p className="legacy-import-note">{blocked.length === 1 ? "1 record is not carried over" : `${blocked.length} records are not carried over`}; each says why above.</p>}
                    {ledger.problems.length > 0 && (
                      <ul className="legacy-import-problems">
                        {ledger.problems.map((entry) => <li key={entry.id}><span className="mono">{plain(entry.id)}</span> — {plain(entry.reason)}</li>)}
                      </ul>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {preview && importableCount(preview) > 0 && (
        <footer>
          <button className="primary" disabled={busy} onClick={confirm}>{busy ? "Importing…" : confirmWords(preview)}</button>
          <small>This reads your old files and copies what it can. The originals stay where they are.</small>
        </footer>
      )}
    </section>
  );
}

type PanelProps = { backend: Backend; store?: DismissalStore; startOpen?: boolean; onClose?: () => void; onImported?: () => void };

/**
 * Notice plus screen, wired to one machine. Settings and the chat banner both render
 * this; it renders nothing when there is nothing to offer.
 */
export function LegacyImportPanel({ backend, store = remembered, startOpen, onClose, onImported }: PanelProps) {
  const [api] = useState(() => legacyImportFor(backend));
  const [dataDir, setDataDir] = useState("");
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => store.read());
  const [open, setOpen] = useState(startOpen === true);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    backend.dataFolder().then((folder) => { if (live.current) setDataDir(folder); }, () => {});
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    if (!api) return;
    live.current = true;
    previewOnce(api).then((next) => { if (live.current) setPreview(next); }, () => {});
    return () => { live.current = false; };
  }, []);

  if (!api) return null;
  const showing = open || (preview !== null && shouldShowNotice(preview, dataDir, dismissed));
  if (!showing) return null;

  return (
    <>
      {!open && preview && (
        <div className="legacy-import-notice" role="status">
          <div>
            <strong>Older records found</strong>
            <small>{importableCount(preview) === 1 ? "1 record" : `${importableCount(preview)} records`} saved before this machine started keeping records safely.</small>
          </div>
          <button onClick={() => setOpen(true)}>Review import</button>
          <button className="icon" aria-label="Dismiss until my saved files change" onClick={() => {
            const key = noticeKey(dataDir, preview);
            store.write(key);
            setDismissed(key);
          }}>×</button>
        </div>
      )}
      {open && (
        <LegacyImportScreen
          api={api}
          onClose={() => { setOpen(false); onClose?.(); }}
          onImported={() => { onImported?.(); }}
        />
      )}
    </>
  );
}
