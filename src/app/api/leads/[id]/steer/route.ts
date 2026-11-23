import type { NextRequest } from "next/server";
import { z } from "zod";
import { trackSteerRun } from "@/lib/analytics-server";
import { claimResearch, getLead } from "@/lib/repo/leads";
import { steerLead } from "@/lib/research/pipeline";
import {
  fail,
  json,
  leadIdFrom,
  leadNotFound,
  overRunBudget,
  readJson,
  RUN_LIMIT_MESSAGE,
  runAfterResponse,
  serverError,
  type LeadRouteContext,
} from "../../../_lib/api";

// Steering may research before it rewrites; it runs after the 202 inside after().
export const maxDuration = 300;

const SteerBody = z.object({
  instruction: z
    .string({ error: "instruction is required." })
    .trim()
    .min(1, "Tell the agent what to change or dig into.")
    .max(1200, "Keep the instruction under 1,200 characters."),
});

/** POST /api/leads/[id]/steer { instruction } -> 202 { ok: true }; 409 while a run is going; 429 over the hourly run cap. */
export async function POST(request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  const body = await readJson(request, SteerBody);
  if (!body.ok) return body.response;
  const { instruction } = body.data;
  try {
    // A steer is a run too (it may research before it rewrites), so it counts toward the cap.
    if (await overRunBudget()) return fail(429, RUN_LIMIT_MESSAGE);
    if (!(await claimResearch(id))) {
      return (await getLead(id)) ? fail(409, "The agent is already working on this lead. Try again when it finishes.") : leadNotFound();
    }
    // steerLead logs the instruction itself (a "steer" event), so nothing is logged here.
    runAfterResponse(id, "Steering", () => trackSteerRun(id, () => steerLead(id, instruction)));
    return json({ ok: true }, 202);
  } catch (err) {
    return serverError("POST /api/leads/[id]/steer", err);
  }
}
