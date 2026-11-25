import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { recomputeAllWarmPathsFree } from "@/lib/paths/engine";
import { removeConnections, uploadConnectionsPart } from "@/lib/paths/network";
import { CONNECTIONS_MAX_PARTS, CONNECTIONS_PART_MAX_BYTES, CONNECTIONS_ROWS_PER_PART } from "@/lib/paths/types";
import { errorMessage } from "@/lib/research/util";
import { fail, json, readJson, serverError, UUID_RE } from "../../../_lib/api";

/**
 * Your LinkedIn connections, from LinkedIn's Connections.csv export. The browser reads the file
 * (src/lib/paths/csv.ts), drops the email addresses, and sends the rows in parts.
 *
 * PUT /api/network/linkedin/connections
 *   { importId: uuid, part: 1..parts, parts: 1..6, rows: [slug, firstName, lastName, company,
 *     position, connectedOn (YYYY-MM-DD or null)][] (at most 5,000), exportedAt?: ISO date }
 *   -> { received, total, done, connectedLeads }. Each row is checked again here. When the last
 *   part arrives the rows of older uploads are deleted, the "Connected" chip is set on every lead
 *   in your connections, and every lead's paths are recomputed for free after the reply.
 *   400 for a bad part or row (the message names the row number, never its content), 409 when a
 *   newer upload replaced this one, 413 over 4 MB, 415 for a body that is not JSON.
 *
 * DELETE /api/network/linkedin/connections -> { ok: true, removed }: every stored connection, and
 * every stored path or company person that may name one; paths are rebuilt for free after.
 *
 * Replies are counts only: no route returns your contacts.
 */

// A part is one transaction of up to 5,000 rows; the free recompute runs after the reply.
export const maxDuration = 60;

const PartBody = z.object({
  importId: z.string({ error: "importId is required." }).regex(UUID_RE, "importId must be a UUID."),
  part: z.number({ error: "part must be a number." }).int().min(1, `part must be 1 to ${CONNECTIONS_MAX_PARTS}.`).max(CONNECTIONS_MAX_PARTS, `part must be 1 to ${CONNECTIONS_MAX_PARTS}.`),
  parts: z.number({ error: "parts must be a number." }).int().min(1, `parts must be 1 to ${CONNECTIONS_MAX_PARTS}.`).max(CONNECTIONS_MAX_PARTS, `parts must be 1 to ${CONNECTIONS_MAX_PARTS}.`),
  rows: z
    .array(z.unknown(), { error: "rows must be a list." })
    .max(CONNECTIONS_ROWS_PER_PART, `Send at most ${CONNECTIONS_ROWS_PER_PART.toLocaleString("en-US")} rows a part.`),
  exportedAt: z.string().trim().max(64).nullable().optional(),
});

const TOO_LARGE = `This part is too large. Send at most ${CONNECTIONS_ROWS_PER_PART.toLocaleString("en-US")} rows and ${CONNECTIONS_PART_MAX_BYTES / 1024 / 1024} MB a part.`;

/** Rebuilds every lead's paths from the stored checks after the reply (SQL only). Never throws. */
function recomputeLater(): void {
  try {
    after(async () => {
      const res = await recomputeAllWarmPathsFree();
      if (res.left) console.warn(`[api] warm paths: ${res.left} leads left to recompute (they recompute when opened)`);
    });
  } catch (err) {
    console.error(`[api] could not schedule the warm-path recompute: ${errorMessage(err).slice(0, 200)}`);
  }
}

export async function PUT(request: NextRequest) {
  const body = await readJson(request, PartBody, { maxBytes: CONNECTIONS_PART_MAX_BYTES, tooLarge: TOO_LARGE });
  if (!body.ok) return body.response;
  if (body.data.part > body.data.parts) return fail(400, `part must be 1 to ${body.data.parts}.`);
  try {
    const res = await uploadConnectionsPart(body.data);
    if (!res.ok) return fail(res.status, res.error, res.status === 409 ? { code: "replaced" } : undefined);
    if (res.done) {
      // Counts only, never a name or a slug: anyone may replace them on an open app, so the change can be dated.
      console.warn(`[api] LinkedIn connections replaced: ${res.total} stored`);
      recomputeLater();
    }
    return json({ received: res.received, total: res.total, done: res.done, connectedLeads: res.connectedLeads });
  } catch (err) {
    return serverError("PUT /api/network/linkedin/connections", err);
  }
}

export async function DELETE() {
  try {
    const { removed } = await removeConnections();
    console.warn(`[api] LinkedIn connections removed: ${removed}`);
    recomputeLater();
    return json({ ok: true, removed });
  } catch (err) {
    return serverError("DELETE /api/network/linkedin/connections", err);
  }
}
