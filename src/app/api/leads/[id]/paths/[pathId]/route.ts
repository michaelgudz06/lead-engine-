import type { NextRequest } from "next/server";
import { z } from "zod";
import { getWarmPath } from "@/lib/paths/engine";
import { canDraftIntro } from "@/lib/paths/intro";
import { INTRO_DRAFT_MAX } from "@/lib/paths/types";
import { addEvent } from "@/lib/repo/events";
import { getLead } from "@/lib/repo/leads";
import { saveIntro, type IntroEntry } from "@/lib/repo/paths";
import { errorMessage } from "@/lib/research/util";
import { fail, json, leadNotFound, readJson, serverError } from "../../../../_lib/api";
import { pathParamsFrom, type PathRouteContext } from "../../../../_lib/paths";

/**
 * PATCH /api/leads/[id]/paths/[pathId] { introDraft?: string | null, asked?: boolean } -> { path }.
 * pathId: the path's opaque id ("li-" or "x-" and 12 hex characters; src/lib/paths/ids.ts).
 * - introDraft: the intro request as edited on the page, at most 2,000 characters; "" or null
 *   clears it. A draft keeps the time it was first drafted.
 * - asked: true marks the path "asked" (once: asking again keeps the first date) and logs a 'note'
 *   event "Asked Priya Shah for an intro"; false clears the mark.
 * 400 { code: "direct" } for the direct path (there is nobody in between to ask), 400 for a bad
 * body, 404 for an unknown lead or path, 415 for a body that is not JSON.
 */

const PatchIntroBody = z.object({
  introDraft: z
    .string({ error: "introDraft must be text, or null to clear it." })
    .max(INTRO_DRAFT_MAX, `Keep the message to ${INTRO_DRAFT_MAX.toLocaleString("en-US")} characters or fewer.`)
    .nullable()
    .optional(),
  asked: z.boolean({ error: "asked must be true or false." }).optional(),
});

/** Marks in progress on this instance: a double click logs one note. */
const marking = new Set<string>();

export async function PATCH(request: NextRequest, ctx: PathRouteContext) {
  const { id, pathId } = await pathParamsFrom(ctx);
  if (!id) return leadNotFound();
  if (!pathId) return fail(404, "Path not found.");
  const body = await readJson(request, PatchIntroBody);
  if (!body.ok) return body.response;
  const { introDraft, asked } = body.data;
  if (introDraft === undefined && asked === undefined) return fail(400, "Nothing to update. Send introDraft or asked.");

  const key = `${id}|${pathId}`;
  if (asked === true && marking.has(key)) return fail(409, "Marking this path as asked already.", { code: "marking" });
  if (asked === true) marking.add(key);
  try {
    const lead = await getLead(id);
    if (!lead) return leadNotFound();
    const path = await getWarmPath(id, pathId);
    if (!path) return fail(404, "Path not found.");
    if (!canDraftIntro(path)) return fail(400, "You are connected directly: there is nobody in between to ask.", { code: "direct" });

    const now = new Date().toISOString();
    const patch: Partial<IntroEntry> = {};
    if (introDraft !== undefined) {
      const message = (introDraft ?? "").replace(/\r\n?/g, "\n").trim();
      patch.introDraft = message ? { message, createdAt: path.introDraft?.createdAt ?? now } : null;
    }
    const markNow = asked === true && !path.askedAt;
    if (markNow) patch.askedAt = now;
    if (asked === false) patch.askedAt = null;

    const entry = Object.keys(patch).length ? await saveIntro(id, pathId, patch) : { introDraft: path.introDraft, askedAt: path.askedAt };
    if (!entry) return fail(404, "Path not found.");
    if (markNow) {
      // The lead's own activity log (shown with the paths), never a server log.
      await addEvent(id, "note", `Asked ${path.connector?.name ?? "them"} for an intro`, { warmPath: "asked" }).catch((err) =>
        console.error(`[api] could not log the intro request for lead ${id}: ${errorMessage(err).slice(0, 200)}`),
      );
    }
    return json({ path: { ...path, introDraft: entry.introDraft, askedAt: entry.askedAt } });
  } catch (err) {
    return serverError("PATCH /api/leads/[id]/paths/[pathId]", err);
  } finally {
    if (asked === true) marking.delete(key);
  }
}
