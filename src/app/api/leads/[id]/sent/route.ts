import type { NextRequest } from "next/server";
import { z } from "zod";
import { addEvent } from "@/lib/repo/events";
import { getLead, updateLead } from "@/lib/repo/leads";
import { getSettings } from "@/lib/repo/settings";
import { DEFAULT_SETTINGS } from "@/lib/types";
import { errorText, json, leadIdFrom, leadNotFound, readJson, serverError, type LeadRouteContext } from "../../../_lib/api";

const DAY_MS = 86_400_000;

const SentBody = z.object({
  angleId: z.string({ error: "angleId is required." }).trim().min(1, "angleId is required.").max(200),
  channel: z.enum(["email", "linkedin"], { error: 'channel must be "email" or "linkedin".' }),
});

/** settings.followUpDays as a whole number of days from 1 to 30, whatever is stored. */
function followUpDays(value: unknown): number {
  const days = Math.round(Number(value));
  return Number.isFinite(days) && days >= 1 ? Math.min(days, 30) : DEFAULT_SETTINGS.followUpDays;
}

/**
 * POST /api/leads/[id]/sent { angleId, channel } -> { lead }.
 * The person sent a draft from their own Gmail or LinkedIn: the lead moves to
 * "contacted", lastContactedAt is now and the follow-up is due in followUpDays.
 */
export async function POST(request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  const body = await readJson(request, SentBody);
  if (!body.ok) return body.response;
  const { angleId, channel } = body.data;

  try {
    const [lead, settings] = await Promise.all([getLead(id), getSettings()]);
    if (!lead) return leadNotFound();

    const now = new Date();
    const followUpAt = new Date(now.getTime() + followUpDays(settings.followUpDays) * DAY_MS);
    // The angle may have been replaced by a re-run since the page loaded. The message
    // went out regardless, so record it rather than refuse.
    const angle = lead.angles.find((a) => a.id === angleId) ?? null;
    // A booked call is further along than "contacted": a message sent to confirm it must not move it back.
    const stage = lead.stage === "call_booked" ? lead.stage : "contacted";

    const updated = await updateLead(id, {
      stage,
      lastContactedAt: now.toISOString(),
      nextStepAt: followUpAt.toISOString(),
    });
    if (!updated) return leadNotFound();

    const what = angle ? `"${angle.name}"` : "a message";
    await addEvent(id, "sent", `Sent ${what} by ${channel === "email" ? "email" : "LinkedIn"}`, {
      angleId,
      angleName: angle?.name ?? null,
      channel,
      fromStage: lead.stage,
      followUpAt: followUpAt.toISOString(),
    }).catch((err) => console.error(`[api] could not log the sent event for lead ${id}: ${errorText(err)}`));

    return json({ lead: updated });
  } catch (err) {
    return serverError("POST /api/leads/[id]/sent", err);
  }
}
