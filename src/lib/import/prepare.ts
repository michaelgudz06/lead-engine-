import "server-only";
import { randomUUID } from "node:crypto";
import { linkedinSlug, normaliseLinkedinUrl } from "../http";
import type { Stage } from "../types";
import { cellEmail, cellHubspotId, cellText, IMPORT_FIELD_MAX, looksLikeEmail, type ImportRow } from "./columns";

/**
 * Server side of an import: cleans each submitted row, decides which rows can become leads,
 * and folds rows that name the same person twice into one. Pure (no database): the duplicate
 * check against existing leads happens in the same statement as the insert
 * (src/lib/repo/import.ts).
 */

/**
 * Which key two rows (or a row and a lead) share. "name" (the same name and company, case
 * aside) is used only for a row with no LinkedIn URL, HubSpot id or email, so importing the
 * same sheet twice does not double the leads that have nothing else.
 */
export type ImportMatch = "linkedin" | "hubspot" | "email" | "name";

/** A row that can become a lead, cleaned. The id is chosen here so the insert's result maps back to the row. */
export interface ImportCandidate {
  id: string;
  index: number;
  linkedinUrl: string | null;
  linkedinSlug: string | null;
  name: string | null;
  companyName: string | null;
  title: string | null;
  /** Lower case. */
  email: string | null;
  notes: string | null;
  hubspotContactId: string | null;
  /** "name|company" in lower case, only for a row with no LinkedIn URL, HubSpot id or email. */
  nameKey: string | null;
}

export interface PreparedImport {
  /** Rows to insert, unique within the batch, in row order. */
  candidates: ImportCandidate[];
  skipped: Array<{ index: number; reason: string }>;
  /** Rows that repeat an earlier row of the same batch. duplicateOf is the index of the row kept for them. */
  repeats: Array<{ index: number; duplicateOf: number; match: ImportMatch }>;
}

export const SKIP_REASONS = {
  notEnough: "Needs a LinkedIn URL, or a name plus a company or an email.",
  badLinkedin: "The LinkedIn URL is not a profile link (linkedin.com/in/...).",
  badEmail: "The email address is not valid.",
} as const;

/**
 * Duplicate reasons, for the import's reply. A row that matches an unqualified lead is a
 * duplicate too (an import never brings it back), and the reason says so.
 */
export function duplicateReason(match: ImportMatch, inBatch: boolean, existingStage?: Stage | null): string {
  const what = match === "linkedin" ? "LinkedIn profile" : match === "hubspot" ? "HubSpot contact" : match === "email" ? "email" : "name and company";
  if (inBatch) return `Same ${what} as an earlier row in this import.`;
  return existingStage === "unqualified" ? `Already a lead with this ${what} (marked unqualified).` : `Already a lead with this ${what}.`;
}

/** "Jane  Doe" + "ACME" -> "jane doe|acme": the key for matching on name and company. */
export function nameCompanyKey(name: string | null, company: string | null): string | null {
  const clean = (v: string | null) => (v ?? "").toLowerCase().trim();
  return name && company ? `${clean(name)}|${clean(company)}` : null;
}

/** Loose input: the route validates the shape; every field may be missing, null, a string or a number. */
export type ImportRowInput = Partial<Record<Exclude<keyof ImportRow, "row">, unknown>>;

export function prepareImport(rows: readonly ImportRowInput[], newId: () => string = randomUUID): PreparedImport {
  const out: PreparedImport = { candidates: [], skipped: [], repeats: [] };
  /** Key ("li:slug", "hs:123", "em:a@b.c") -> index of the row kept for it. */
  const seen = new Map<string, number>();

  rows.forEach((row, index) => {
    const rawUrl = cellText(row.linkedinUrl, IMPORT_FIELD_MAX.linkedinUrl);
    const url = rawUrl ? normaliseLinkedinUrl(rawUrl) : null;
    if (rawUrl && !url) {
      out.skipped.push({ index, reason: SKIP_REASONS.badLinkedin });
      return;
    }
    const email = cellEmail(row.email);
    if (email && !looksLikeEmail(email)) {
      out.skipped.push({ index, reason: SKIP_REASONS.badEmail });
      return;
    }
    const name = cellText(row.name, IMPORT_FIELD_MAX.name);
    const companyName = cellText(row.company, IMPORT_FIELD_MAX.company);
    if (!url && !(name && (companyName || email))) {
      out.skipped.push({ index, reason: SKIP_REASONS.notEnough });
      return;
    }
    const slug = url ? linkedinSlug(url) : null;
    // HubSpot record ids are numbers; anything else came from a mismatched column and is left out.
    const hubspotId = cellHubspotId(row.hubspotId);
    const hubspotContactId = hubspotId && /^\d+$/.test(hubspotId) ? hubspotId : null;
    const keys: Array<[ImportMatch, string]> = [];
    if (slug) keys.push(["linkedin", `li:${slug}`]);
    if (hubspotContactId) keys.push(["hubspot", `hs:${hubspotContactId}`]);
    if (email) keys.push(["email", `em:${email}`]);
    const nameKey = keys.length ? null : nameCompanyKey(name, companyName);
    if (nameKey) keys.push(["name", `nc:${nameKey}`]);

    const earlier = keys.find(([, key]) => seen.has(key));
    if (earlier) {
      const keptIndex = seen.get(earlier[1])!;
      out.repeats.push({ index, duplicateOf: keptIndex, match: earlier[0] });
      // The repeat's other keys point at the same person too.
      for (const [, key] of keys) if (!seen.has(key)) seen.set(key, keptIndex);
      return;
    }
    for (const [, key] of keys) seen.set(key, index);
    out.candidates.push({
      id: newId(),
      index,
      linkedinUrl: url,
      linkedinSlug: slug,
      name,
      companyName,
      title: cellText(row.title, IMPORT_FIELD_MAX.title),
      email,
      notes: cellText(row.notes, IMPORT_FIELD_MAX.notes, { multiline: true }),
      hubspotContactId,
      nameKey,
    });
  });
  return out;
}
