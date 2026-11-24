"use client";

import { useRef, useState } from "react";
import { errorMessage, getHubSpotContacts, parseSheet } from "@/lib/api-client";
import { parseCsvTable } from "@/lib/import/csv";
import { HUBSPOT_LIST_MAX_ROWS, type LoadedSource } from "./rows";
import type { ImportSource } from "@/lib/types";
import { Button, Label, Notice, cx } from "../ui";

const SOURCES: Array<{ id: ImportSource; label: string }> = [
  { id: "csv", label: "Upload a CSV" },
  { id: "sheet", label: "Google Sheet" },
  { id: "hubspot", label: "HubSpot" },
];

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_ROWS = 5000;

/** Step one: pick where the contacts come from and load them. Every error shows the server's own message. */
export function SourcePicker({ source, onSource, onLoaded }: { source: ImportSource; onSource: (source: ImportSource) => void; onLoaded: (loaded: LoadedSource) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetUrl, setSheetUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function pick(next: ImportSource) {
    if (busy || next === source) return;
    setError(null);
    onSource(next);
  }

  async function readFile(file: File | undefined | null) {
    if (!file || busy) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError("This file is larger than 10 MB. Split it and import the parts.");
      return;
    }
    if (/\.(xlsx?|numbers|ods)$/i.test(file.name)) {
      setError("This is a spreadsheet file, not a CSV. In your spreadsheet choose File, Download, Comma-separated values (.csv), then upload that file.");
      return;
    }
    setBusy(true);
    try {
      const table = parseCsvTable(await file.text());
      if (table.headers.length === 0 || table.rows.length === 0) {
        setError(table.headers.length === 0 ? "This file is empty." : "This file has a header row but no contacts under it.");
      } else if (table.rows.length > MAX_FILE_ROWS) {
        setError(`This file has ${table.rows.length.toLocaleString("en-US")} rows. Import up to ${MAX_FILE_ROWS.toLocaleString("en-US")} at a time: split it and import the parts.`);
      } else {
        onLoaded({ source: "csv", label: file.name, headers: table.headers, rows: table.rows, firstRow: table.headerRow + 1, notes: [] });
      }
    } catch {
      setError("Could not read this file. Save it as a CSV and try again.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function loadSheet(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!sheetUrl.trim()) {
      setError("Paste the link to a Google Sheet.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const table = await parseSheet(sheetUrl.trim());
      if (table.rows.length === 0) {
        setError("This sheet has no contacts under its header row.");
        return;
      }
      const notes = table.truncated
        ? [`This sheet is long: the first ${table.rows.length.toLocaleString("en-US")} of ${table.total.toLocaleString("en-US")} rows were loaded. Import these, then split the rest into another sheet.`]
        : [];
      onLoaded({ source: "sheet", label: "Google Sheet", headers: table.headers, rows: table.rows, firstRow: table.headerRow + 1, notes });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadHubspot() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const table = await getHubSpotContacts(500);
      if (table.rows.length === 0) {
        setError(table.warnings[0] ?? "HubSpot has no contacts to import.");
        return;
      }
      onLoaded({ source: "hubspot", label: "HubSpot", headers: table.headers, rows: table.rows, firstRow: 1, notes: table.warnings, more: table.more });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 sm:p-6">
      <div role="radiogroup" aria-label="Where the contacts come from" className="grid grid-cols-3 rounded-lg border border-hairline p-0.5 sm:inline-grid">
        {SOURCES.map((s) => {
          const on = s.id === source;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy && !on}
              onClick={() => pick(s.id)}
              className={cx("h-8 rounded-md px-2 text-[13px] font-medium transition-colors sm:px-4 sm:text-[13.5px]", on ? "bg-ink text-white" : "text-quiet hover:bg-wash hover:text-ink")}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        {source === "csv" && (
          <>
            <label
              className={cx(
                "flex cursor-pointer flex-col items-center rounded-[10px] border border-dashed px-4 py-10 text-center transition-colors focus-within:border-ink",
                dragging ? "border-ink bg-wash" : "border-[#d3d3cc] hover:bg-wash",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void readFile(e.dataTransfer.files?.[0]);
              }}
            >
              <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values" className="sr-only" disabled={busy} onChange={(e) => void readFile(e.target.files?.[0])} />
              <span className="font-medium">{busy ? "Reading the file…" : "Drop a CSV file here"}</span>
              <span className="mt-1 text-[13px] text-quiet">
                or <span className="text-ink underline underline-offset-2">choose a file</span>. Up to 5,000 rows.
              </span>
            </label>
            <p className="mt-3 text-[13px] text-quiet">The file is read in your browser. Nothing is added until you press Import on the next step.</p>
          </>
        )}

        {source === "sheet" && (
          <form onSubmit={loadSheet} noValidate>
            <Label htmlFor="sheet-url">Link to the Google Sheet</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="sheet-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                className="field min-w-0"
                placeholder="https://docs.google.com/spreadsheets/d/..."
                value={sheetUrl}
                maxLength={2000}
                disabled={busy}
                onChange={(e) => {
                  setSheetUrl(e.target.value);
                  setError(null);
                }}
              />
              <Button type="submit" variant="primary" busy={busy} className="shrink-0">
                {busy ? "Loading…" : "Load sheet"}
              </Button>
            </div>
            <p className="mt-3 text-[13px] text-quiet">The sheet must be shared: in Google Sheets choose Share, then Anyone with the link, Viewer. The tab in the link is the one that loads.</p>
          </form>
        )}

        {source === "hubspot" && (
          <div>
            <Button variant="primary" busy={busy} onClick={() => void loadHubspot()}>
              {busy ? "Loading contacts…" : "Load contacts from HubSpot"}
            </Button>
            <p className="mt-3 text-[13px] text-quiet">
              Loads the first 500 contacts (you can load up to {HUBSPOT_LIST_MAX_ROWS.toLocaleString("en-US")} on the next step) with their name, email, company, job title and LinkedIn URL. Nothing changes in HubSpot.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4">
            <Notice>{error}</Notice>
          </div>
        )}
      </div>

      <p className="mt-5 border-t border-hairline pt-4 text-[13px] text-quiet">
        Columns can be in any order. Each contact needs a LinkedIn URL, or a name plus a company or an email. Importing does not start research.
      </p>
    </div>
  );
}
