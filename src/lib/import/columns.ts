/**
 * Column mapping for imports: which column of a CSV file, Google Sheet or HubSpot list holds
 * which lead field, and the clean rows POST /api/leads/import accepts. Isomorphic: no
 * server-only imports. The server cleans every row again (src/lib/import/prepare.ts).
 */

import { isEmailAddress } from "../email";

/** The lead fields a column can map to. name is a full name; firstName and lastName are joined when there is no full name. */
export const IMPORT_FIELDS = ["linkedinUrl", "name", "firstName", "lastName", "company", "title", "email", "notes", "hubspotId"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  linkedinUrl: "LinkedIn URL",
  name: "Full name",
  firstName: "First name",
  lastName: "Last name",
  company: "Company",
  title: "Job title",
  email: "Email",
  notes: "Notes",
  hubspotId: "HubSpot ID",
};

/** For each field, the index of the column that holds it, or null when no column does. */
export type ColumnMapping = Record<ImportField, number | null>;

/** One contact as POST /api/leads/import accepts it. Every field is trimmed, and null when empty. */
export interface ImportRow {
  linkedinUrl: string | null;
  /** Full name ("Jane Doe"). */
  name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  notes: string | null;
  /** HubSpot's record id for the contact. */
  hubspotId: string | null;
  /** The row's number in the file or sheet (1-based, the header is the row before the first). For messages only; the server ignores it. */
  row?: number;
}

/** The longest value kept per field; the server applies the same limits. */
export const IMPORT_FIELD_MAX: Record<Exclude<keyof ImportRow, "row">, number> = {
  linkedinUrl: 500,
  name: 200,
  company: 200,
  title: 300,
  email: 320,
  notes: 5000,
  hubspotId: 40,
};

/** The most rows one POST /api/leads/import may carry. */
export const IMPORT_MAX_ROWS = 1000;

export function emptyMapping(): ColumnMapping {
  return { linkedinUrl: null, name: null, firstName: null, lastName: null, company: null, title: null, email: null, notes: null, hubspotId: null };
}

/** "  E-mail Address " -> "e mail address": lower case, accents and punctuation gone. */
export function normaliseHeader(header: string): string {
  return String(header ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Header names per field, already normalised, best first. A header matches when it equals one
 * of these with or without its spaces ("firstname" and "first name").
 */
const EXACT: Record<ImportField, string[]> = {
  linkedinUrl: [
    "linkedin url",
    "linkedin",
    "linkedin profile",
    "linkedin profile url",
    "linkedin link",
    "linkedin profile link",
    "person linkedin url",
    "contact linkedin url",
    "linkedin contact profile url",
    "li url",
    "li profile",
    "hs linkedin url",
  ],
  name: ["name", "full name", "contact name", "contact", "person name", "person", "lead name", "lead", "contact full name", "display name"],
  firstName: ["first name", "firstname", "first", "given name", "fname", "forename", "contact first name"],
  lastName: ["last name", "lastname", "last", "surname", "family name", "lname", "contact last name"],
  company: [
    "company",
    "company name",
    "organization",
    "organisation",
    "organization name",
    "organisation name",
    "employer",
    "account",
    "account name",
    "associated company",
    "current company",
    "org",
  ],
  title: ["title", "job title", "jobtitle", "position", "role", "headline", "occupation", "designation", "current title", "job role"],
  email: ["email", "e mail", "email address", "e mail address", "work email", "business email", "primary email", "email 1", "mail", "emails", "contact email"],
  notes: ["notes", "note", "comments", "comment", "description", "about", "context", "remarks", "message"],
  hubspotId: ["hubspot id", "record id", "contact id", "hs object id", "hubspot contact id", "hubspot record id", "vid", "object id"],
};

/** Fields matched in this order: a column goes to the first field that claims it. */
const ORDER: ImportField[] = ["hubspotId", "linkedinUrl", "email", "firstName", "lastName", "name", "company", "title", "notes"];

/** Broader matches for columns no exact name claimed: a word in the header, minus words that mean something else. */
const LOOSE: Record<ImportField, (h: string) => boolean> = {
  // "Company LinkedIn URL" is the company's page, not the person's profile.
  linkedinUrl: (h) => /\blinked ?in\b/.test(h) && !/\b(company|organi[sz]ation|account|employer|bio|connections?|followers?)\b/.test(h),
  name: (h) => /\b(full ?name|contact name|person)\b/.test(h),
  firstName: (h) => /\bfirst\b/.test(h) && /\bname\b/.test(h),
  lastName: (h) => /\b(last|sur|family)\b/.test(h) && /\bname\b/.test(h),
  company: (h) => /\b(company|organi[sz]ation|employer)\b/.test(h) && !/\b(linked ?in|url|website|domain|size|industry|phone|address|city|country|id|revenue|employees)\b/.test(h),
  title: (h) => /\b(job ?title|title|position)\b/.test(h),
  // "Email Status" or "Email Confidence" describe an address, they are not one.
  email: (h) => /\be ?mail\b/.test(h) && !/\b(status|confidence|verified|verification|valid|opt|bounce|bounced|unsubscribed?|sent|count|date|domain|type|score|catch)\b/.test(h),
  notes: (h) => /\b(notes?|comments?)\b/.test(h),
  hubspotId: (h) => /\bhubspot\b/.test(h) && /\bid\b/.test(h),
};

/**
 * Guesses which column holds which field from the header names, case-insensitively. Each
 * column maps to one field at most; fields with no likely column stay null. With `rows` (the
 * first data rows are enough), a column whose header says nothing useful still maps to the
 * LinkedIn URL or the email when most of its values are profile links or addresses (LinkedIn's
 * own export calls its profile column "URL").
 */
export function guessMapping(headers: readonly string[], rows?: readonly (readonly string[])[]): ColumnMapping {
  const mapping = emptyMapping();
  const normalised = headers.map(normaliseHeader);
  const taken = new Set<number>();
  const claim = (field: ImportField, index: number) => {
    mapping[field] = index;
    taken.add(index);
  };
  const squash = (s: string) => s.replace(/ /g, "");

  // Exact names first, for every field, so a loose match never takes a column an exact one wants.
  for (const field of ORDER) {
    for (const want of EXACT[field]) {
      const index = normalised.findIndex((h, i) => !taken.has(i) && h !== "" && (h === want || squash(h) === squash(want)));
      if (index >= 0) {
        claim(field, index);
        break;
      }
    }
  }
  for (const field of ORDER) {
    if (mapping[field] !== null) continue;
    const index = normalised.findIndex((h, i) => !taken.has(i) && h !== "" && LOOSE[field](h));
    if (index >= 0) claim(field, index);
  }

  if (rows?.length) {
    const sample = rows.slice(0, 50);
    const mostly = (index: number, test: (v: string) => boolean): boolean => {
      const values = sample.map((r) => (r[index] ?? "").trim()).filter(Boolean);
      return values.length > 0 && values.filter(test).length / values.length >= 0.6;
    };
    const byValues = (field: ImportField, test: (v: string) => boolean) => {
      if (mapping[field] !== null) return;
      const index = headers.findIndex((_, i) => !taken.has(i) && mostly(i, test));
      if (index >= 0) claim(field, index);
    };
    byValues("linkedinUrl", (v) => /linkedin\.com\/in\//i.test(v));
    byValues("email", (v) => looksLikeEmail(v.toLowerCase().replace(/^mailto:/, "")));
  }
  return mapping;
}

// ---------------------------------------------------------------------------------------------
// Cleaning cells (shared with the server)

/** Values that mean "nothing here" in exported sheets. */
const PLACEHOLDERS = new Set(["", "-", "--", "—", "–", "n/a", "na", "n.a.", "none", "null", "nil", "unknown", "tbd", "?", "#n/a", "undefined", "0"]);

/** A cell's text, trimmed; null when empty or a placeholder such as "N/A" or "-". */
export function cellText(value: unknown, max: number, opts: { multiline?: boolean } = {}): string | null {
  if (value === null || value === undefined) return null;
  let s = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  s = s.replace(/\u0000/g, "");
  s = opts.multiline ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : s.replace(/\s+/g, " ").trim();
  if (PLACEHOLDERS.has(s.toLowerCase())) return null;
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/** True for something that looks like one email address (src/lib/email.ts). */
export function looksLikeEmail(value: string): boolean {
  return isEmailAddress(value);
}

/**
 * The address in an email cell, lower case: "mailto:" dropped, "Jane <jane@acme.com>" read,
 * and the first address taken when a cell lists several. Null when the cell is empty; the
 * cleaned text (not an address) when it holds something else, so the server can say why it
 * skipped the row.
 */
export function cellEmail(value: unknown): string | null {
  const text = cellText(value, 1000);
  if (!text) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(text);
  const candidates = (angle ? [angle[1]] : text.split(/[\s,;]+/)).map((p) => p.replace(/^mailto:/i, "").replace(/^[<("']+|[>)"'.]+$/g, "").trim().toLowerCase());
  const found = candidates.find((c) => looksLikeEmail(c));
  return found ?? text.slice(0, IMPORT_FIELD_MAX.email);
}

/** A HubSpot record id: digits only ("12345.0" from a spreadsheet becomes "12345"). */
export function cellHubspotId(value: unknown): string | null {
  const text = cellText(value, 100);
  if (!text) return null;
  const m = /^(\d{1,30})(?:\.0+)?$/.exec(text.replace(/[\s,]/g, ""));
  return m ? m[1] : text.slice(0, IMPORT_FIELD_MAX.hubspotId);
}

/**
 * Turns parsed rows into ImportRows with a mapping. A full-name column wins; otherwise first and
 * last name are joined. Rows with nothing in any mapped column are left out. `firstRow` is the
 * row number of rows[0] in the file (CsvTable.headerRow + 1; default 2).
 */
export function toImportRows(rows: readonly (readonly string[])[], mapping: ColumnMapping, firstRow = 2): ImportRow[] {
  const out: ImportRow[] = [];
  const at = (row: readonly string[], field: ImportField): string | undefined => {
    const i = mapping[field];
    return i === null || i === undefined || i < 0 ? undefined : row[i];
  };
  rows.forEach((row, i) => {
    const first = cellText(at(row, "firstName"), 100);
    const last = cellText(at(row, "lastName"), 100);
    const full = cellText(at(row, "name"), IMPORT_FIELD_MAX.name) ?? (cellText([first, last].filter(Boolean).join(" "), IMPORT_FIELD_MAX.name) || null);
    const item: ImportRow = {
      linkedinUrl: cellText(at(row, "linkedinUrl"), IMPORT_FIELD_MAX.linkedinUrl),
      name: full,
      company: cellText(at(row, "company"), IMPORT_FIELD_MAX.company),
      title: cellText(at(row, "title"), IMPORT_FIELD_MAX.title),
      email: cellEmail(at(row, "email")),
      notes: cellText(at(row, "notes"), IMPORT_FIELD_MAX.notes, { multiline: true }),
      hubspotId: cellHubspotId(at(row, "hubspotId")),
      row: firstRow + i,
    };
    if (item.linkedinUrl || item.name || item.company || item.title || item.email || item.notes || item.hubspotId) out.push(item);
  });
  return out;
}
