/**
 * What the import screen knows about a row before it is sent. The server checks every row
 * again (src/lib/import/prepare.ts) and has the last word; the reasons here use its wording.
 */
import { looksLikeEmail, type ImportRow } from "@/lib/import/columns";
import type { ImportSource } from "@/lib/types";
import { normalizeLinkedinUrl } from "../format";

export type RowStatus =
  | { kind: "ready" }
  /** No LinkedIn URL, but a name plus a company or an email: research looks the profile up. */
  | { kind: "no_linkedin" }
  | { kind: "skipped"; reason: string };

export function rowStatus(row: ImportRow): RowStatus {
  const url = row.linkedinUrl ? normalizeLinkedinUrl(row.linkedinUrl) : null;
  if (row.linkedinUrl && !url) return { kind: "skipped", reason: "The LinkedIn URL is not a profile link (linkedin.com/in/...)." };
  if (row.email && !looksLikeEmail(row.email)) return { kind: "skipped", reason: "The email address is not valid." };
  if (url) return { kind: "ready" };
  if (row.name && (row.company || row.email)) return { kind: "no_linkedin" };
  return { kind: "skipped", reason: "Needs a LinkedIn URL, or a name plus a company or an email." };
}

/** A file, sheet or HubSpot list, loaded and ready to map. */
export interface LoadedSource {
  source: ImportSource;
  /** The file's name, "Google Sheet" or "HubSpot". */
  label: string;
  headers: string[];
  rows: string[][];
  /** The row number of rows[0] in the file or sheet. */
  firstRow: number;
  /** Things worth saying about the load, e.g. that a long sheet was cut short. */
  notes: string[];
  /** HubSpot has more contacts than were loaded. */
  more?: boolean;
}

/** "Jane Doe", else their email, else the profile's slug: something to call a row. */
export function rowName(row: ImportRow): string {
  if (row.name) return row.name;
  if (row.email) return row.email;
  const slug = row.linkedinUrl ? /\/in\/([^/?#]+)/.exec(row.linkedinUrl)?.[1] : null;
  return slug || "No name";
}

/** "Row 12" for a file or sheet; HubSpot contacts have no row numbers worth showing. */
export function rowLabel(row: ImportRow, source: ImportSource): string {
  return source === "hubspot" || !row.row ? "" : `Row ${row.row}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The most contacts GET /api/import/hubspot lists (HUBSPOT_LIST_MAX on the server). */
export const HUBSPOT_LIST_MAX_ROWS = 2000;
