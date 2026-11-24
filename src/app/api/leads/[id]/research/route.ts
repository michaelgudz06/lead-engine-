import type { NextRequest } from "next/server";
import { z } from "zod";
import { trackResearchRun } from "@/lib/analytics-server";
import { addEvent } from "@/lib/repo/events";
import { getLead } from "@/lib/repo/leads";
import { runResearch } from "@/lib/research/pipeline";
import {
  errorText,
  fail,
  json,
  leadIdFrom,
  leadNotFound,
  readJson,
  runAfterResponse,
  runLimitMessage,
  serverError,
  startRun,
  type LeadRouteContext,
} from "../../../_lib/api";

// The run continues after the 202 inside after(), which lives as long as the function may.
export const maxDuration = 300;

/**
 * An optional reason for a re-run: what to look into or try again. A POST with no body (or an
 * empty one) is a plain re-run, as before.
 */
const ResearchBody = z.object({
  focus: z
    .string({ error: "focus must be text." })
    .trim()
    .max(1200, "Keep the reason under 1,200 characters.")
    .nullable()
    .optional()
    .transform((v) => v || null),
});

/**
 * POST /api/leads/[id]/research [{ focus }] -> 202 { ok: true }; 409 while a run is going; 429
 * over the hourly or daily run cap. With a focus, a "Re-run: <focus>" event is logged and the
 * run looks into it first (runResearch(id, { focus })).
 */
export async function POST(request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  const body = await readJson(request, ResearchBody);
  if (!body.ok) return body.response;
  const { focus } = body.data;
  try {
    // A slot under the run caps, then the lead's claim (one atomic UPDATE, so two clicks
    // can never start two runs). A failed claim gives the slot back.
    const start = await startRun(id, "research");
    if (!start.ok) {
      if (start.reason === "limit") return fail(429, runLimitMessage(start.window, start.limits));
      return (await getLead(id)) ? fail(409, "Research is already running for this lead.") : leadNotFound();
    }
    if (focus) {
      // Logged before the run starts, so the activity shows the reason above the run's steps.
      await addEvent(id, "steer", `Re-run: ${focus}`, { focus }).catch((err) =>
        console.error(`[api] could not log the re-run reason for lead ${id}: ${errorText(err)}`),
      );
    }
    runAfterResponse(id, "Research", () => trackResearchRun(id, () => runResearch(id, { focus })));
    return json({ ok: true }, 202);
  } catch (err) {
    return serverError("POST /api/leads/[id]/research", err);
  }
}
