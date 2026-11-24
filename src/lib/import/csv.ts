/**
 * A CSV parser for imports (RFC 4180, read leniently). Isomorphic: no server-only imports, so the
 * browser parses an uploaded file with the same code the server uses for a Google Sheet.
 *
 * - Fields may be quoted with double quotes; inside quotes, "" is one quote, and delimiters and
 *   line breaks are part of the field.
 * - Records end at CRLF, LF or a lone CR. A line break at the very end adds no record.
 * - A UTF-8 byte order mark at the start is dropped.
 * - The delimiter is a comma, a semicolon (Excel in many European locales) or a tab (a sheet
 *   copied from the browser), detected from the first records unless given.
 * - Lenient where files in the wild break the rules: a quote inside an unquoted field is kept as
 *   a character, text right after a closing quote joins the field, and an unclosed quote runs
 *   to the end of the file.
 */

export type CsvDelimiter = "," | ";" | "\t";

export const CSV_DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t"];

export interface CsvTable {
  /** The first record that is not blank, trimmed. */
  headers: string[];
  /** The records after the header, as they are (blank records inside the file are kept, so row numbers match the sheet). Trailing blank records are dropped. */
  rows: string[][];
  delimiter: CsvDelimiter;
  /** 1-based number of the header record in the file (1 unless blank records come first). The first data row is headerRow + 1. */
  headerRow: number;
  /** Set when maxRecords stopped the parse before the end of the text: the rows are then only the first ones. */
  more?: true;
}

const BOM = "﻿";

/** Splits CSV text into records of fields. Every record has at least one field. */
export function parseCsv(text: string, opts: { delimiter?: CsvDelimiter; maxRecords?: number } = {}): string[][] {
  const input = text.startsWith(BOM) ? text.slice(1) : text;
  const delimiter = opts.delimiter ?? detectDelimiter(input);
  const max = opts.maxRecords ?? Number.POSITIVE_INFINITY;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let i = 0;
  const n = input.length;
  // True once anything was read for the current record: a final line break adds no empty record.
  let started = false;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    started = false;
  };

  while (i < n && records.length < max) {
    const c = input[i];
    if (c === '"' && field === "") {
      // A quoted field: read to the closing quote; "" is an escaped quote.
      started = true;
      i++;
      let closed = false;
      while (i < n) {
        const q = input.indexOf('"', i);
        if (q < 0) {
          field += input.slice(i);
          i = n;
          break;
        }
        field += input.slice(i, q);
        if (input[q + 1] === '"') {
          field += '"';
          i = q + 2;
          continue;
        }
        i = q + 1;
        closed = true;
        break;
      }
      if (!closed) break; // unclosed quote: the field runs to the end of the file
      continue;
    }
    if (c === delimiter) {
      started = true;
      endField();
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      endRecord();
      i += c === "\r" && input[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    // Unquoted text up to the next delimiter or line break (a quote here is just a character).
    started = true;
    let j = i + 1;
    while (j < n) {
      const d = input[j];
      if (d === delimiter || d === "\n" || d === "\r") break;
      j++;
    }
    field += input.slice(i, j);
    i = j;
  }
  if ((started || field !== "" || record.length > 0) && records.length < max) endRecord();
  return records;
}

/**
 * The delimiter that splits the first records into the most columns, consistently: each
 * candidate is scored on up to 20 records by how many have the same number of fields as the
 * first, times that number. A file with one column (or no delimiter at all) reads as comma.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const sample = sampleRecords(text.startsWith(BOM) ? text.slice(1) : text);
  let best: CsvDelimiter = ",";
  let bestScore = 0;
  for (const d of CSV_DELIMITERS) {
    const records = parseCsv(sample, { delimiter: d, maxRecords: 20 }).filter((r) => !isBlank(r));
    if (!records.length) continue;
    const width = records[0].length;
    if (width < 2) continue;
    const consistent = records.filter((r) => r.length === width).length / records.length;
    const score = consistent * width;
    // Ties keep the earlier candidate: comma, then semicolon, then tab.
    if (score > bestScore + 1e-9) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** About the first 20 lines (64 KB at most), cut at a line break so the sample ends on a whole record where it can. */
function sampleRecords(text: string): string {
  const limit = Math.min(text.length, 64 * 1024);
  let lines = 0;
  for (let i = 0; i < limit; i++) {
    const c = text[i];
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) {
      lines++;
      if (lines >= 20) return text.slice(0, i + 1);
    }
  }
  return text.slice(0, limit);
}

/** True for a record with no content: every field empty or whitespace. */
export function isBlank(record: readonly string[]): boolean {
  return record.every((f) => f.trim() === "");
}

/**
 * Parses CSV text into a header and data rows. With maxRecords, reads at most that many records
 * (the header and blank records above it count) and sets `more` when the text goes on. Throws
 * only on non-string input.
 */
export function parseCsvTable(text: string, opts: { delimiter?: CsvDelimiter; maxRecords?: number } = {}): CsvTable {
  if (typeof text !== "string") throw new TypeError("parseCsvTable needs the file's text");
  const input = text.startsWith(BOM) ? text.slice(1) : text;
  const delimiter = opts.delimiter ?? detectDelimiter(input);
  const max = opts.maxRecords ?? Number.POSITIVE_INFINITY;
  // One record past the limit tells whether the text goes on; it is not kept.
  const records = parseCsv(input, { delimiter, maxRecords: max + 1 });
  const more = records.length > max;
  if (more) records.length = max;
  const cut = more ? { more: true as const } : {};
  const first = records.findIndex((r) => !isBlank(r));
  if (first < 0) return { headers: [], rows: [], delimiter, headerRow: 1, ...cut };
  const headers = records[first].map((h) => h.replace(/\s+/g, " ").trim());
  let end = records.length;
  // Blank records just before a cut are not the end of the file, so they stay.
  if (!more) while (end > first + 1 && isBlank(records[end - 1])) end--;
  return { headers, rows: records.slice(first + 1, end), delimiter, headerRow: first + 1, ...cut };
}
