import type { NextRequest } from "next/server";
import { trackResearchRun } from "@/lib/analytics-server";
import { claimResearch, getLead } from "@/lib/repo/leads";
import { runResearch } from "@/lib/research/pipeline";
import {
  fail,
  json,
  leadIdFrom,
  leadNotFound,
  overRunBudget,
  RUN_LIMIT_MESSAGE,
  runAfterResponse,
  serverError,
  type LeadRouteContext,
} from "../../../_lib/api";

// The run continues after the 202 inside after(), which lives as long as the function may.
export const maxDuration = 300;

/** POST /api/leads/[id]/research -> 202 { ok: true }; 409 while a run is going; 429 over the hourly run cap. */
export async function POST(_request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  try {
    if (await overRunBudget()) return fail(429, RUN_LIMIT_MESSAGE);
    // The claim is one atomic UPDATE, so two clicks can never start two runs.
    if (!(await claimResearch(id))) {
      return (await getLead(id)) ? fail(409, "Research is already running for this lead.") : leadNotFound();
    }
    runAfterResponse(id, "Research", () => trackResearchRun(id, () => runResearch(id)));
    return json({ ok: true }, 202);
  } catch (err) {
    return serverError("POST /api/leads/[id]/research", err);
  }
}
