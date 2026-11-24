import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { trackResearchRun } from "@/lib/analytics-server";
import { linkedinSlug, normaliseLinkedinUrl } from "@/lib/http";
import { addEvent } from "@/lib/repo/events";
import { countLeads, createLead, DuplicateLeadError, getLead, listLeads } from "@/lib/repo/leads";
import { runResearch } from "@/lib/research/pipeline";
import { LEAD_VIEWS, type LeadView, type Stage } from "@/lib/types";
import {
  errorText,
  fail,
  failStaleRun,
  isStaleRun,
  json,
  leadBySlug,
  optionalText,
  pgCode,
  readJson,
  runAfterResponse,
  runLimitEvent,
  serverError,
  startRun,
} from "../_lib/api";

// POST starts a research run after the response; after() lives as long as the function may.
export const maxDuration = 300;

const CreateLeadBody = z.object({
  linkedinUrl: z
    .string({ error: "linkedinUrl is required." })
    .trim()
    .min(1, "linkedinUrl is required.")
    .max(500, "That URL is too long."),
  name: optionalText(200),
  companyName: optionalText(200),
  notes: optionalText(5000),
});

/** The 409 for a person who is already a lead. existingStage lets the page offer to restore an unqualified one. */
function duplicate(existingId: string, existingStage: Stage | null) {
  const error = existingStage === "unqualified" ? "This person is already a lead (marked unqualified)." : "This person is already a lead.";
  return fail(409, error, { existingId, existingStage });
}

/** ?view=active|unqualified; missing or empty is "active". */
function viewParam(request: NextRequest): { ok: true; view: LeadView } | { ok: false; error: string } {
  const value = request.nextUrl.searchParams.get("view");
  if (value === null || value === "") return { ok: true, view: "active" };
  return (LEAD_VIEWS as readonly string[]).includes(value) ? { ok: true, view: value as LeadView } : { ok: false, error: 'view must be "active" or "unqualified".' };
}

/**
 * GET /api/leads[?view=active|unqualified] -> { leads, counts: { active, unqualified } }.
 * active (the default): every lead that is not unqualified, most recently updated first.
 * unqualified: most recently marked first. Each list holds at most 500 leads; counts are the
 * totals. Any other view is a 400.
 */
export async function GET(request: NextRequest) {
  await connection(); // reads the database: never prerender this at build time
  const param = viewParam(request);
  if (!param.ok) return fail(400, param.error);
  const { view } = param;
  try {
    const [listed, counts] = await Promise.all([listLeads(view), countLeads()]);
    let leads = listed;
    // A run that outlived its function was lost: fail it so the lists stop polling and it can be
    // retried. Only the stage of a "researching" lead changes, so the counts stay as they are.
    const stale = leads.filter((lead) => isStaleRun(lead));
    if (stale.length) {
      const reaped = await Promise.all(stale.map((lead) => failStaleRun(lead.id)));
      if (reaped.some(Boolean)) leads = await listLeads(view);
    }
    return json({ leads, counts });
  } catch (err) {
    return serverError("GET /api/leads", err);
  }
}

/**
 * POST /api/leads -> 201 { lead } with research already started; 409 { error, existingId, existingStage }
 * for a duplicate (an unqualified one says so in the error).
 * Over the hourly or daily run cap the lead is still created, without a run, and an event says why.
 */
export async function POST(request: NextRequest) {
  const body = await readJson(request, CreateLeadBody);
  if (!body.ok) return body.response;
  const linkedinUrl = normaliseLinkedinUrl(body.data.linkedinUrl);
  if (!linkedinUrl) return fail(400, "That does not look like a LinkedIn profile URL (linkedin.com/in/...).");

  try {
    let lead;
    try {
      lead = await createLead({ ...body.data, linkedinUrl });
    } catch (err) {
      if (err instanceof DuplicateLeadError) return duplicate(err.existingId, err.existingStage);
      // Two requests for the same person raced past the duplicate check; the unique index stopped the second.
      if (pgCode(err) === "23505") {
        const existing = await leadBySlug(linkedinSlug(linkedinUrl));
        if (existing) return duplicate(existing.id, existing.stage);
      }
      throw err;
    }

    // The lead exists from here on: a failed log line must not turn this into an error reply.
    await addEvent(lead.id, "created", "Lead added", { linkedinUrl }).catch((err) =>
      console.error(`[api] could not log the created event for lead ${lead.id}: ${errorText(err)}`),
    );

    const start = await startRun(lead.id, "research");
    if (start.ok) {
      const id = lead.id;
      runAfterResponse(id, "Research", () => trackResearchRun(id, () => runResearch(id)));
    } else if (start.reason === "limit") {
      await addEvent(lead.id, "error", runLimitEvent(start.window, start.limits)).catch((err) =>
        console.error(`[api] could not log the skipped run for lead ${lead.id}: ${errorText(err)}`),
      );
    }
    // Re-read so the reply already shows research as running.
    return json({ lead: (await getLead(lead.id)) ?? lead }, 201);
  } catch (err) {
    return serverError("POST /api/leads", err);
  }
}
