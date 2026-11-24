import type { NextRequest } from "next/server";
import { z } from "zod";
import { IMPORT_MAX_ROWS } from "@/lib/import/columns";
import { duplicateReason, prepareImport, type ImportMatch } from "@/lib/import/prepare";
import { insertImportedLeads } from "@/lib/repo/import";
import { importLimitMessage } from "@/lib/repo/quota";
import { fail, json, readJson, serverError } from "../../_lib/api";

/**
 * POST /api/leads/import { source, rows } -> { created, createdIds, createdRows, duplicates, skipped }.
 *
 * Adds leads from a CSV file, a Google Sheet or HubSpot. Never starts research: runs are capped
 * (startRun in src/app/api/_lib/api.ts), and the team picks which leads to research. A row needs
 * a LinkedIn URL, or a name plus a company or an email. Rows that name a lead that already
 * exists (same LinkedIn profile, HubSpot contact or email), or an earlier row of the same
 * import, are reported as duplicates and not added. At most 1,000 rows per request, and at most
 * IMPORT_LIMIT_PER_DAY (default 2,000) new leads per rolling 24 hours across the app: a batch
 * that would pass the limit is refused whole with 429.
 */

/** 1,000 rows with long notes run past the usual 512 KB; Vercel takes request bodies up to 4.5 MB. */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

/** A cell as a client may send it: text, a number (a spreadsheet id), null or missing. Cleaned in prepareImport. */
const Cell = z
  .union([z.string().max(100_000), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? null : String(v)));

const ImportRowBody = z.object({
  linkedinUrl: Cell,
  name: Cell,
  company: Cell,
  title: Cell,
  email: Cell,
  notes: Cell,
  hubspotId: Cell,
});

const ImportBody = z.object({
  source: z.enum(["csv", "sheet", "hubspot"], { error: 'source must be "csv", "sheet" or "hubspot".' }),
  rows: z
    .array(ImportRowBody, { error: "rows must be a list of contacts." })
    .min(1, "There are no rows to import.")
    .max(IMPORT_MAX_ROWS, `Send at most ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows at a time.`),
});

interface ImportDuplicate {
  /** Index into the request's rows. */
  index: number;
  /** The lead that already has this person: an existing lead, or the one this import created for an earlier row. */
  existingId: string | null;
  reason: string;
  match: ImportMatch;
  /** For a repeat inside this import: the index of the earlier row. */
  duplicateOf: number | null;
}

export async function POST(request: NextRequest) {
  const body = await readJson(request, ImportBody, {
    maxBytes: MAX_IMPORT_BYTES,
    tooLarge: "This import is too large to send at once. Send fewer rows per request.",
  });
  if (!body.ok) return body.response;
  const { source, rows } = body.data;

  const prepared = prepareImport(rows);
  try {
    const outcome = await insertImportedLeads(source, prepared.candidates);
    if (!outcome.allowed) {
      const wanted = outcome.fresh;
      return fail(429, importLimitMessage({ limit: outcome.limit, used: outcome.used, wanted }), {
        limit: outcome.limit,
        remaining: Math.max(0, outcome.limit - outcome.used),
        wanted,
      });
    }

    // Where each kept row ended up: a new lead, or an existing one.
    const leadOf = new Map<number, string>();
    for (const c of outcome.created) leadOf.set(c.index, c.id);
    for (const e of outcome.existing) leadOf.set(e.index, e.existingId);

    const duplicates: ImportDuplicate[] = [
      ...outcome.existing.map((e) => ({ index: e.index, existingId: e.existingId, reason: duplicateReason(e.match, false), match: e.match, duplicateOf: null })),
      ...prepared.repeats.map((r) => ({
        index: r.index,
        existingId: leadOf.get(r.duplicateOf) ?? null,
        reason: duplicateReason(r.match, true),
        match: r.match,
        duplicateOf: r.duplicateOf,
      })),
    ].sort((a, b) => a.index - b.index);

    return json({
      created: outcome.created.length,
      createdIds: outcome.created.map((c) => c.id),
      createdRows: outcome.created,
      duplicates,
      skipped: prepared.skipped,
    });
  } catch (err) {
    return serverError("POST /api/leads/import", err);
  }
}
