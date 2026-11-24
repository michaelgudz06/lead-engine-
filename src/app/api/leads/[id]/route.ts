import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { normaliseLinkedinUrl } from "@/lib/http";
import { listEvents } from "@/lib/repo/events";
import { listFindings } from "@/lib/repo/findings";
import { deleteLead, DuplicateLeadError, getLead, setLeadLinkedin, updateLead, type LeadPatch } from "@/lib/repo/leads";
import { STAGES, type Lead, type LeadDetail } from "@/lib/types";
import {
  definedOnly,
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
  unqualifiedReasonField,
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

/** A LinkedIn profile URL (normalised in the handler); "" and null clear it. */
const LinkedinUrl = z
  .string()
  .trim()
  .max(500, "That URL is too long.")
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));

const PatchBody = z.object({
  stage: z.enum(STAGES).optional(),
  // Only while the lead is, or with this patch becomes, unqualified (checked in the handler). "" and null clear it.
  unqualifiedReason: unqualifiedReasonField(),
  notes: optionalText(10_000),
  owner: optionalText(200),
  nextStepAt: NextStepAt,
  // Saved lower case, as an address the team added (email_status "manual"); null clears it.
  email: optionalEmail().transform((v) => (typeof v === "string" ? v.toLowerCase() : v)),
  linkedinUrl: LinkedinUrl,
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

/**
 * PATCH /api/leads/[id] -> { lead }. Logs one "stage" event when the stage changes, in the same
 * statement as the change: "Marked unqualified[: reason]" { from, to: "unqualified", reason } when
 * it becomes unqualified (as the bulk action does), else "Stage changed from X to Y" { from, to }.
 * stage "unqualified" follows the bulk action's rules (src/lib/repo/qualify.ts); any other stage
 * clears the unqualified fields. unqualifiedReason (trimmed, at most 200 characters; "" or null
 * clears it): 400 unless the lead is unqualified after this patch.
 * linkedinUrl: normalised; 400 when it is not a LinkedIn profile URL, 409 { existingId,
 * existingStage } when another lead has that profile; "" or null clears it. email: lower case,
 * saved as an address the team added (emailStatus "manual", no confidence); null clears it.
 */
export async function PATCH(request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  const body = await readJson(request, PatchBody);
  if (!body.ok) return body.response;
  const { linkedinUrl: rawLinkedin, ...fields } = definedOnly(body.data);
  const patch = fields as LeadPatch;
  if (Object.keys(patch).length === 0 && rawLinkedin === undefined) return fail(400, `Nothing to update. Send any of: ${PATCHABLE_FIELDS}.`);
  const linkedinUrl = rawLinkedin ? normaliseLinkedinUrl(rawLinkedin) : rawLinkedin;
  if (rawLinkedin && !linkedinUrl) return fail(400, "That does not look like a LinkedIn profile URL (linkedin.com/in/...).");

  try {
    const before = await getLead(id);
    if (!before) return leadNotFound();
    if (patch.unqualifiedReason !== undefined && (patch.stage ?? before.stage) !== "unqualified") {
      return fail(400, 'unqualifiedReason is only for an unqualified lead. Send it with stage "unqualified", or mark the lead unqualified first.');
    }
    // A hand-entered address replaces whatever Hunter found: it is the team's, with no score.
    if (patch.email !== undefined && patch.email !== before.email) {
      patch.emailConfidence = null;
      patch.emailStatus = patch.email ? "manual" : null;
    }

    let lead: Lead | null = before;
    if (linkedinUrl !== undefined && linkedinUrl !== before.linkedinUrl) {
      try {
        lead = await setLeadLinkedin(id, linkedinUrl);
      } catch (err) {
        if (err instanceof DuplicateLeadError) {
          return fail(409, "Another lead already has this LinkedIn profile.", { existingId: err.existingId, existingStage: err.existingStage });
        }
        throw err;
      }
    }
    // The stage event is written by the update itself, from the stage it found under the row lock:
    // a change made since `before` was read cannot log a wrong or second event, and a bulk action
    // at the same moment cannot land between the change and its event.
    if (lead && Object.keys(patch).length) lead = await updateLead(id, patch, { logStage: true });
    if (!lead) return leadNotFound(); // deleted in between
    return json({ lead });
  } catch (err) {
    return serverError("PATCH /api/leads/[id]", err);
  }
}

/** DELETE /api/leads/[id] -> { ok: true }. Findings, events and raw data go with it (on delete cascade). POST /api/leads/bulk deletes many. */
export async function DELETE(_request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  try {
    return (await deleteLead(id)) ? json({ ok: true }) : leadNotFound();
  } catch (err) {
    return serverError("DELETE /api/leads/[id]", err);
  }
}
