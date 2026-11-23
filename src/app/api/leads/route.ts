import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { trackResearchRun } from "@/lib/analytics-server";
import { linkedinSlug, normaliseLinkedinUrl } from "@/lib/http";
import { addEvent } from "@/lib/repo/events";
import { claimResearch, createLead, DuplicateLeadError, getLead, listLeads } from "@/lib/repo/leads";
import { runResearch } from "@/lib/research/pipeline";
import {
  errorText,
  fail,
  failStaleRun,
  isStaleRun,
  json,
  leadIdBySlug,
  MAX_RUNS_PER_HOUR,
  optionalText,
  overRunBudget,
  pgCode,
  readJson,
  runAfterResponse,
  serverError,
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

const DUPLICATE = "This person is already a lead.";

/** GET /api/leads -> { leads } (most recently updated first). */
export async function GET() {
  await connection(); // reads the database: never prerender this at build time
  try {
    let leads = await listLeads();
    // A run that outlived its function was lost: fail it so the lists stop polling and it can be retried.
    const stale = leads.filter((lead) => isStaleRun(lead));
    if (stale.length) {
      const reaped = await Promise.all(stale.map((lead) => failStaleRun(lead.id)));
      if (reaped.some(Boolean)) leads = await listLeads();
    }
    return json({ leads });
  } catch (err) {
    return serverError("GET /api/leads", err);
  }
}

/**
 * POST /api/leads -> 201 { lead } with research already started; 409 { error, existingId } for a duplicate.
 * Over the hourly run cap the lead is still created, without a run, and an event says why.
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
      if (err instanceof DuplicateLeadError) return fail(409, DUPLICATE, { existingId: err.existingId });
      // Two requests for the same person raced past the duplicate check; the unique index stopped the second.
      if (pgCode(err) === "23505") {
        const existingId = await leadIdBySlug(linkedinSlug(linkedinUrl));
        if (existingId) return fail(409, DUPLICATE, { existingId });
      }
      throw err;
    }

    // The lead exists from here on: a failed log line must not turn this into an error reply.
    await addEvent(lead.id, "created", "Lead added", { linkedinUrl }).catch((err) =>
      console.error(`[api] could not log the created event for lead ${lead.id}: ${errorText(err)}`),
    );

    if (await overRunBudget()) {
      await addEvent(
        lead.id,
        "error",
        `Research did not start: the limit of ${MAX_RUNS_PER_HOUR} research runs an hour was reached. Run it from this page later.`,
      ).catch((err) => console.error(`[api] could not log the skipped run for lead ${lead.id}: ${errorText(err)}`));
    } else if (await claimResearch(lead.id)) {
      const id = lead.id;
      runAfterResponse(id, "Research", () => trackResearchRun(id, () => runResearch(id)));
    }
    // Re-read so the reply already shows research as running.
    return json({ lead: (await getLead(lead.id)) ?? lead }, 201);
  } catch (err) {
    return serverError("POST /api/leads", err);
  }
}
