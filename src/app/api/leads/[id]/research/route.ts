import type { NextRequest } from "next/server";
import { trackResearchRun } from "@/lib/analytics-server";
import { getLead } from "@/lib/repo/leads";
import { runResearch } from "@/lib/research/pipeline";
import {
  fail,
  json,
  leadIdFrom,
  leadNotFound,
  runAfterResponse,
  runLimitMessage,
  serverError,
  startRun,
  type LeadRouteContext,
} from "../../../_lib/api";

// The run continues after the 202 inside after(), which lives as long as the function may.
export const maxDuration = 300;

/** POST /api/leads/[id]/research -> 202 { ok: true }; 409 while a run is going; 429 over the hourly or daily run cap. */
export async function POST(_request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  try {
    // A slot under the run caps, then the lead's claim (one atomic UPDATE, so two clicks
    // can never start two runs). A failed claim gives the slot back.
    const start = await startRun(id, "research");
    if (!start.ok) {
      if (start.reason === "limit") return fail(429, runLimitMessage(start.window, start.limits));
      return (await getLead(id)) ? fail(409, "Research is already running for this lead.") : leadNotFound();
    }
    runAfterResponse(id, "Research", () => trackResearchRun(id, () => runResearch(id)));
    return json({ ok: true }, 202);
  } catch (err) {
    return serverError("POST /api/leads/[id]/research", err);
  }
}
