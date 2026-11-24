import type { NextRequest } from "next/server";
import { z } from "zod";
import { parseCsvTable } from "@/lib/import/csv";
import { downloadSheetCsv, SheetError } from "@/lib/import/sheet";
import { fail, json, readJson, serverError } from "../../_lib/api";

/**
 * POST /api/import/sheet { url } -> { headers, rows, total, truncated, headerRow }.
 *
 * Reads a Google Sheet shared as "anyone with the link" as CSV (src/lib/import/sheet.ts) and
 * returns its header and rows for the import screen, which maps the columns and sends the rows
 * to POST /api/leads/import. Nothing is saved here. Errors carry a `code`: bad_link,
 * not_shared, not_found, too_large (400), timeout (504) or upstream (502).
 */

export const maxDuration = 30;

/** Rows sent back at most. The daily import limit is far lower, and a reply must stay under Vercel's 4.5 MB. */
const MAX_ROWS = 5_000;
/** About the most row text sent back, so a wide sheet stays under the reply limit too. */
const MAX_REPLY_CHARS = 3_000_000;
/**
 * Records read at most: the rows sent back plus room for the header and blank rows above it.
 * Each record is an array of about 200 bytes even when the row is empty, so a 5 MB sheet of
 * empty rows (2.6 million of them) must never be read whole.
 */
const MAX_RECORDS = MAX_ROWS + 1_000;

const SheetBody = z.object({
  url: z.string({ error: "url is required." }).trim().min(1, "Paste the link of the Google Sheet.").max(2000, "That link is too long."),
});

export async function POST(request: NextRequest) {
  const body = await readJson(request, SheetBody);
  if (!body.ok) return body.response;
  try {
    const text = await downloadSheetCsv(body.data.url);
    const table = parseCsvTable(text, { maxRecords: MAX_RECORDS });
    const rows: string[][] = [];
    let chars = table.headers.join("").length;
    for (const row of table.rows) {
      chars += row.reduce((n, cell) => n + cell.length + 4, 0);
      if (rows.length >= MAX_ROWS || chars > MAX_REPLY_CHARS) break;
      rows.push(row);
    }
    // When the parse stopped early, the rows after the cut are counted without being built.
    const total = table.more ? Math.max(table.rows.length, recordCount(text) - table.headerRow) : table.rows.length;
    return json({ headers: table.headers, rows, total, truncated: table.more === true || rows.length < table.rows.length, headerRow: table.headerRow });
  } catch (err) {
    if (err instanceof SheetError) return fail(err.status, err.message, { code: err.code });
    return serverError("POST /api/import/sheet", err);
  }
}

/**
 * Records in Google's CSV, counted without building them: line breaks outside quoted cells (CRLF,
 * LF or a lone CR; a final one adds none). Google quotes every cell that holds a quote or a line
 * break, so each quote opens, closes or doubles inside a quoted cell.
 */
function recordCount(text: string): number {
  let records = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (!quoted && (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10))) records++;
  }
  const last = text.charCodeAt(text.length - 1);
  return text.length === 0 || last === 10 || last === 13 ? records : records + 1;
}
