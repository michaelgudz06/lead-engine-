import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { linkedinSlug, normaliseLinkedinUrl } from "@/lib/http";
import { addEvent } from "@/lib/repo/events";
import { claimResearch, createLead, DuplicateLeadError, getLead, listLeads } from "@/lib/repo/leads";
import { runResearch } from "@/lib/research/pipeline";
import { errorText, fail, json, leadIdBySlug, optionalText, pgCode, readJson, runAfterResponse, serverError } from "../_lib/api";

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
    return json({ leads: await listLeads() });
  } catch (err) {
    return serverError("GET /api/leads", err);
  }
}

/** POST /api/leads -> 201 { lead } with research already started; 409 { error, existingId } for a duplicate. */
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

    if (await claimResearch(lead.id)) {
      const id = lead.id;
      runAfterResponse(id, "Research", () => runResearch(id));
    }
    // Re-read so the reply already shows research as running.
    return json({ lead: (await getLead(lead.id)) ?? lead }, 201);
  } catch (err) {
    return serverError("POST /api/leads", err);
  }
}
