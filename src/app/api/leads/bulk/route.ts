import type { NextRequest } from "next/server";
import { z } from "zod";
import { deleteLeads, restoreLeads, unqualifyLeads } from "@/lib/repo/qualify";
import { BULK_LEADS_MAX } from "@/lib/types";
import { json, readJson, serverError, unqualifiedReasonField, UUID_RE } from "../../_lib/api";

/**
 * POST /api/leads/bulk: one action on one lead or up to 500 at once, each in one statement.
 *
 *   { action: "unqualify", ids, reason? }  -> { leads, missing }
 *   { action: "restore", ids }             -> { leads, missing }
 *   { action: "delete", ids }              -> { deleted, missing }
 *
 * ids: 1 to 500 lead ids (UUIDs), repeats removed, answered in the order sent. missing: the ids
 * that matched no lead (for restore: no unqualified lead). reason: text of at most 200
 * characters, or null; without one a newly marked lead has none and an unqualified lead keeps
 * its own. The rules and the "stage" events are in src/lib/repo/qualify.ts. Delete is for good,
 * like DELETE /api/leads/[id]. Like every write, the proxy refuses it from another site. Each
 * action that changed something leaves one line in the server log (logBulk).
 */

const Ids = z
  .array(z.string({ error: "Each id must be text." }).regex(UUID_RE, "Each id must be a lead id."), { error: "Send a list of lead ids." })
  .min(1, "Pick at least one lead.")
  .max(BULK_LEADS_MAX, `Send at most ${BULK_LEADS_MAX} leads at a time.`)
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]);

const BulkBody = z.discriminatedUnion(
  "action",
  [
    z.object({ action: z.literal("unqualify"), ids: Ids, reason: unqualifiedReasonField() }),
    z.object({ action: z.literal("restore"), ids: Ids }),
    z.object({ action: z.literal("delete"), ids: Ids }),
  ],
  { error: 'Use "unqualify", "restore" or "delete".' },
);

/** The requested ids that are not in `found`, in the order sent. */
function missingFrom(ids: readonly string[], found: readonly string[]): string[] {
  const seen = new Set(found);
  return ids.filter((id) => !seen.has(id));
}

/**
 * One line in the server log for each bulk action that changed something: the action and the
 * count first (a log host that shortens long lines keeps those), then the ids. A mass delete can
 * then be dated, and undone with the database's point-in-time restore.
 */
function logBulk(action: string, changed: readonly string[], asked: number): void {
  if (changed.length) console.warn(`[api] bulk ${action}: ${changed.length} of ${asked} leads: ${changed.join(" ")}`);
}

export async function POST(request: NextRequest) {
  const body = await readJson(request, BulkBody);
  if (!body.ok) return body.response;
  const action = body.data;
  try {
    if (action.action === "delete") {
      const deleted = await deleteLeads(action.ids);
      logBulk("delete", deleted, action.ids.length);
      return json({ deleted, missing: missingFrom(action.ids, deleted) });
    }
    const leads = action.action === "unqualify" ? await unqualifyLeads(action.ids, action.reason ?? null) : await restoreLeads(action.ids);
    const ids = leads.map((lead) => lead.id);
    logBulk(action.action, ids, action.ids.length);
    return json({ leads, missing: missingFrom(action.ids, ids) });
  } catch (err) {
    return serverError(`POST /api/leads/bulk (${action.action})`, err);
  }
}
