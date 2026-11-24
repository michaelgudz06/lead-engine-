"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { track } from "@/lib/analytics";
import { errorMessage, getHubSpotContacts, importLeadsInBatches, ImportBatchError, type ImportResult } from "@/lib/api-client";
import { guessMapping, toImportRows, type ColumnMapping, type ImportField, type ImportRow } from "@/lib/import/columns";
import type { ImportSource } from "@/lib/types";
import { Button, Notice, PageTitle } from "../ui";
import { MappingRow } from "./mapping";
import { PreviewList } from "./preview";
import { ResultView, type ImportOutcome } from "./result";
import { HUBSPOT_LIST_MAX_ROWS, plural, rowStatus, type LoadedSource } from "./rows";
import { SourcePicker } from "./source-picker";

/** Rows per request. The server takes up to 1,000; smaller batches keep each one quick. */
const BATCH_SIZE = 500;

const SOURCE_NOUN: Record<ImportSource, string> = { csv: "file", sheet: "sheet", hubspot: "HubSpot list" };

/** The import screen: pick a source, match its columns, choose the rows, import, see what happened. */
export function ImportFlow() {
  const [source, setSource] = useState<ImportSource>("csv");
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  /** Rows the person unticked, by index into `items`. Cleared whenever the rows change. */
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  /** Why an import that added nothing was refused (the daily limit, a server error): shown on the review step, which stays as it was. */
  const [importError, setImportError] = useState<string | null>(null);

  const items = useMemo<ImportRow[]>(() => (loaded && mapping ? toImportRows(loaded.rows, mapping, loaded.firstRow) : []), [loaded, mapping]);
  const statuses = useMemo(() => items.map(rowStatus), [items]);
  const counts = useMemo(() => {
    let ready = 0;
    let noLinkedin = 0;
    let skipped = 0;
    for (const s of statuses) {
      if (s.kind === "ready") ready++;
      else if (s.kind === "no_linkedin") noLinkedin++;
      else skipped++;
    }
    return { ready, noLinkedin, skipped };
  }, [statuses]);
  const selected = useMemo(() => items.map((_, i) => i).filter((i) => statuses[i].kind !== "skipped" && !unticked.has(i)), [items, statuses, unticked]);

  function accept(next: LoadedSource) {
    setLoaded(next);
    setMapping(guessMapping(next.headers, next.rows.slice(0, 50)));
    setUnticked(new Set());
    setMoreError(null);
    setImportError(null);
    track("import_source_loaded", { source: next.source, rows: next.rows.length });
  }

  function reset() {
    setLoaded(null);
    setMapping(null);
    setUnticked(new Set());
    setOutcome(null);
    setProgress(null);
    setMoreError(null);
    setImportError(null);
  }

  function changeMapping(field: ImportField, column: number | null) {
    setMapping((m) => (m ? { ...m, [field]: column } : m));
    setUnticked(new Set());
    setImportError(null);
  }

  async function loadAllHubspot() {
    if (loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const table = await getHubSpotContacts(HUBSPOT_LIST_MAX_ROWS);
      accept({ source: "hubspot", label: "HubSpot", headers: table.headers, rows: table.rows, firstRow: 1, notes: table.warnings, more: table.more });
    } catch (err) {
      setMoreError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function runImport() {
    if (!loaded || progress || selected.length === 0) return;
    const sent = selected.map((i) => items[i]);
    const leftOut = items.map((row, i) => ({ row, status: statuses[i] })).flatMap(({ row, status }) => (status.kind === "skipped" ? [{ row, reason: status.reason }] : []));
    const unchecked = items.length - sent.length - leftOut.length;
    setImportError(null);
    setProgress({ done: 0, total: sent.length });
    let result: ImportResult;
    let error: string | null = null;
    let notSent = 0;
    try {
      result = await importLeadsInBatches(loaded.source, sent, { batchSize: BATCH_SIZE, onProgress: (done, total) => setProgress({ done, total }) });
    } catch (err) {
      if (err instanceof ImportBatchError) {
        result = err.partial;
        notSent = sent.length - err.failedAt;
      } else {
        result = { created: 0, createdIds: [], createdRows: [], duplicates: [], skipped: [] };
        notSent = sent.length;
      }
      error = errorMessage(err);
    }
    if (error && notSent === sent.length) {
      // Refused before any row went in (the daily limit, for one): stay on the review step, with
      // the mapping and ticks kept, so the person can untick rows and try again.
      setImportError(error);
      setProgress(null);
      return;
    }
    track("import_completed", { source: loaded.source, created: result.created, duplicates: result.duplicates.length, skipped: result.skipped.length + leftOut.length });
    setOutcome({ source: loaded.source, sent, result, error, notSent, leftOut, unchecked });
    setProgress(null);
    // The Import button sits under a long list: show the result from its top.
    window.scrollTo({ top: 0 });
  }

  if (outcome) {
    return (
      <Shell>
        <ResultView outcome={outcome} onAgain={reset} />
      </Shell>
    );
  }

  if (!loaded || !mapping) {
    return (
      <Shell>
        <SourcePicker source={source} onSource={setSource} onLoaded={accept} />
      </Shell>
    );
  }

  const importing = progress !== null;
  const noun = SOURCE_NOUN[loaded.source];
  return (
    <Shell>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 wrap-anywhere">
            <span className="font-medium">{loaded.label}</span>
            <span className="text-quiet"> · {plural(loaded.rows.length, "row")}</span>
          </p>
          <Button size="sm" onClick={reset} disabled={importing}>
            Choose another source
          </Button>
        </div>

        {loaded.notes.map((note) => (
          <Notice key={note} tone="info">
            {note}
          </Notice>
        ))}
        {loaded.more && (
          <Notice
            tone="info"
            action={
              loaded.rows.length < HUBSPOT_LIST_MAX_ROWS ? (
                <Button size="sm" busy={loadingMore} disabled={importing} onClick={() => void loadAllHubspot()}>
                  Load up to {HUBSPOT_LIST_MAX_ROWS.toLocaleString("en-US")}
                </Button>
              ) : undefined
            }
          >
            HubSpot has more contacts than the {loaded.rows.length.toLocaleString("en-US")} loaded here.
          </Notice>
        )}
        {moreError && <Notice>{moreError}</Notice>}

        <section className="card" aria-label="Columns">
          <div className="border-b border-hairline px-4 py-3 sm:px-5">
            <h2 className="font-serif text-[20px] leading-snug">Match the columns</h2>
            <p className="mt-0.5 text-[13px] text-quiet">For each field, pick the column of your {noun} that holds it. The guesses come from the column names.</p>
          </div>
          <div className="px-4 py-4 sm:px-5">
            <MappingRow headers={loaded.headers} mapping={mapping} disabled={importing} onChange={changeMapping} />
          </div>
        </section>

        <section className="card" aria-label="Contacts">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-hairline px-4 py-3 sm:px-5">
            <h2 className="font-serif text-[20px] leading-snug">Contacts</h2>
            <p className="text-[13px] text-quiet" aria-live="polite">
              {counts.ready.toLocaleString("en-US")} ready · {counts.noLinkedin.toLocaleString("en-US")} without LinkedIn · {counts.skipped.toLocaleString("en-US")} skipped
            </p>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-quiet sm:px-5">No contacts yet. Match at least the LinkedIn URL column, or the name plus the company or the email.</p>
          ) : (
            <PreviewList
              items={items}
              statuses={statuses}
              source={loaded.source}
              unticked={unticked}
              disabled={importing}
              onToggle={(i) => {
                setImportError(null);
                setUnticked((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(i)) next.add(i);
                  return next;
                });
              }}
              onToggleAll={(on) => {
                setImportError(null);
                setUnticked(on ? new Set() : new Set(items.map((_, i) => i)));
              }}
            />
          )}
        </section>

        {importError && (
          <Notice>
            <span className="font-medium">Nothing was imported.</span> {importError}
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button variant="primary" busy={importing} disabledReason={selected.length === 0 ? "Tick at least one contact to import." : null} onClick={() => void runImport()}>
            {importing ? `Importing ${progress.done.toLocaleString("en-US")} of ${progress.total.toLocaleString("en-US")}…` : `Import ${plural(selected.length, "contact")}`}
          </Button>
          <p className="min-w-0 flex-1 basis-64 text-[13px] text-quiet">
            Importing does not start research. Research runs when someone opens a lead and presses Run research, up to 25 a day.
          </p>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Link href="/" className="mb-4 inline-block text-[13.5px] text-quiet hover:text-ink">
        ← Leads
      </Link>
      <PageTitle title="Import leads" subtitle="Add many contacts at once from a CSV file, a Google Sheet or HubSpot." />
      {children}
    </>
  );
}
