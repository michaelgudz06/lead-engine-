import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { addEvent, listEvents } from "@/lib/repo/events";
import { listFindings } from "@/lib/repo/findings";
import { deleteLead, getLead, updateLead, type LeadPatch } from "@/lib/repo/leads";
import { STAGE_LABELS, STAGES, type LeadDetail } from "@/lib/types";
import {
  definedOnly,
  errorText,
  fail,
  failStaleRun,
  isStaleRun,
  json,
  leadIdFrom,
  leadNotFound,
  optionalEmail,
  optionalText,
  readJson,
  serverError,
  type LeadRouteContext,
} from "../../_lib/api";

/**
 * An angle as edited on the lead page. Known fields are checked; unknown ones are
 * kept (looseObject) so nothing the research agent stored is lost on save.
 */
const AngleBody = z.looseObject({
  id: z.string().trim().min(1, "Each angle needs an id.").max(120),
  name: z.string().max(200),
  reasoning: z.string().max(4000).default(""),
  findingIds: z.array(z.string().max(100)).max(100).default([]),
  email: z.object({
    subject: z.string().max(500),
    body: z.string().max(20_000),
  }),
  // The UI shows a character count; LinkedIn enforces its own limits, so only a sanity cap here.
  linkedinMessage: z.string().max(8000),
});

/** ISO date or date-time (the UI sends toISOString()); "" or null clears the follow-up. */
const NextStepAt = z
  .string()
  .trim()
  .max(64)
  .nullable()
  .optional()
  .refine((v) => v == null || v === "" || (/^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v))), {
    message: "Use an ISO date such as 2026-12-01 or 2026-12-01T09:00:00Z.",
  })
  .transform((v) => (v === undefined ? undefined : v ? new Date(v).toISOString() : null));

const PatchBody = z.object({
  stage: z.enum(STAGES).optional(),
  notes: optionalText(10_000),
  owner: optionalText(200),
  nextStepAt: NextStepAt,
  email: optionalEmail(),
  name: optionalText(300),
  title: optionalText(300),
  companyName: optionalText(300),
  angles: z
    .array(AngleBody)
    .max(12, "At most 12 angles.")
    .refine((list) => new Set(list.map((a) => a.id)).size === list.length, "Angle ids must be unique.")
    .optional(),
});

const PATCHABLE_FIELDS = Object.keys(PatchBody.shape).join(", ");

/** GET /api/leads/[id] -> LeadDetail { lead, findings, events }. Polled every 2 s while research runs. */
export async function GET(_request: NextRequest, ctx: LeadRouteContext) {
  await connection();
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  try {
    // One round trip of wall time: the id is a valid UUID, so the list queries are safe to start blind.
    const [lead, findings, events] = await Promise.all([getLead(id), listFindings(id), listEvents(id)]);
    if (!lead) return leadNotFound();
    let detail: LeadDetail = { lead, findings, events };
    // A run that outlived its function was lost: fail it now, so the page stops polling and
    // can retry. Re-read so this reply (the last one the page polls) shows the error event.
    if (isStaleRun(lead) && (await failStaleRun(id))) {
      const [fresh, freshEvents] = await Promise.all([getLead(id), listEvents(id)]);
      if (!fresh) return leadNotFound();
      detail = { lead: fresh, findings, events: freshEvents };
    }
    return json(detail);
  } catch (err) {
    return serverError("GET /api/leads/[id]", err);
  }
}

/** PATCH /api/leads/[id] -> { lead }. Logs a "stage" event when the stage changes. */
export async function PATCH(request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  const body = await readJson(request, PatchBody);
  if (!body.ok) return body.response;
  const patch = definedOnly(body.data) as LeadPatch;
  if (Object.keys(patch).length === 0) return fail(400, `Nothing to update. Send any of: ${PATCHABLE_FIELDS}.`);

  try {
    const before = await getLead(id);
    if (!before) return leadNotFound();
    // A hand-entered address replaces whatever Hunter scored, so its confidence no longer applies.
    if (patch.email !== undefined && patch.email !== before.email) patch.emailConfidence = null;

    const lead = await updateLead(id, patch);
    if (!lead) return leadNotFound(); // deleted in between

    if (patch.stage && patch.stage !== before.stage) {
      await addEvent(id, "stage", `Stage changed from ${STAGE_LABELS[before.stage] ?? before.stage} to ${STAGE_LABELS[patch.stage]}`, {
        from: before.stage,
        to: patch.stage,
      }).catch((err) => console.error(`[api] could not log the stage event for lead ${id}: ${errorText(err)}`));
    }
    return json({ lead });
  } catch (err) {
    return serverError("PATCH /api/leads/[id]", err);
  }
}

/** DELETE /api/leads/[id] -> { ok: true }. Findings, events and raw data go with it (on delete cascade). */
export async function DELETE(_request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  try {
    return (await deleteLead(id)) ? json({ ok: true }) : leadNotFound();
  } catch (err) {
    return serverError("DELETE /api/leads/[id]", err);
  }
}
