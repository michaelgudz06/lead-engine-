import type { NextRequest } from "next/server";
import { findEmail, hunterStatus, type EmailResult, type FoundEmailStatus } from "@/lib/providers/hunter";
import { addEvent } from "@/lib/repo/events";
import { getLead, saveFoundEmail } from "@/lib/repo/leads";
import { creditUnits, emailLookupLimitMessage, LOOKUP_MAX_UNITS, releaseQuota, reserveQuota, settleQuota } from "@/lib/repo/quota";
import { givenEmail, personFrom } from "@/lib/research/identify";
import { emailScore } from "@/lib/research/util";
import { withUsageContext } from "@/lib/usage/ledger";
import { errorText, fail, isStaleRun, json, leadIdFrom, leadNotFound, serverError, type LeadRouteContext } from "../../../_lib/api";

/**
 * POST /api/leads/[id]/email -> { email, emailStatus, emailConfidence, message, creditsUsed, lead }.
 *
 * Looks up one lead's work email with Hunter, without a research run: the Email Finder, then
 * an address built from the company's email pattern (src/lib/providers/hunter.ts). A found
 * address is saved with its kind (found, verified or guess); one the team typed in or imported
 * is never replaced (409). When nothing is found the reply is 200 with email null and a
 * message saying why. The app runs open, so Hunter credits are capped across the app at
 * HUNTER_CREDITS_PER_DAY (default 10) per rolling 24 hours, shared with research: 429 when the
 * budget has no room for one more lookup (up to 1.5 credits).
 */

// Finder (up to 25 s), Domain Search and the verifier (up to 25 s plus a poll) fit in 60 s.
export const maxDuration = 60;
const LOOKUP_BUDGET_MS = 50_000;

/** Lookups in progress on this instance: a double click must not pay twice. */
const inFlight = new Set<string>();

const SAVED_MESSAGE: Record<FoundEmailStatus, (r: EmailResult) => string> = {
  found: () => "Hunter found this address.",
  verified: (r) => `Built from the company's email pattern${r.pattern ? ` (${r.pattern})` : ""}, and Hunter checked that it can receive mail.`,
  guess: (r) =>
    `Built from the company's email pattern${r.pattern ? ` (${r.pattern})` : ""}. Their mail server accepts every address, so it could not be checked: treat it as a best guess.`,
};

export async function POST(_request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  if (!hunterStatus().configured) return fail(400, "Email lookup is off: HUNTER_API_KEY is not set on the server.", { code: "not_configured" });
  if (inFlight.has(id)) return fail(409, "An email lookup is already running for this lead.");

  inFlight.add(id);
  try {
    const lead = await getLead(id);
    if (!lead) return leadNotFound();
    if (givenEmail(lead)) {
      return fail(409, "This lead already has an email address you added. Clear it on this page to look one up.", { code: "email_given" });
    }
    if (lead.researchStatus === "running" && !isStaleRun(lead)) {
      return fail(409, "Research is running for this lead, and it looks up the email itself. Try again when it finishes.");
    }
    const person = personFrom(lead, null);
    const named = Boolean(person.name) && !person.nameIsGuess;
    if (!lead.linkedinUrl && !(named && (person.domain || person.company))) {
      return fail(400, "Add their name and company (or their LinkedIn URL) on this page first.", { code: "not_enough" });
    }

    // The most a lookup can cost comes out of the day's Hunter budget first; it is settled to
    // what Hunter really charged below.
    const slot = await reserveQuota("email_lookup", LOOKUP_MAX_UNITS, id);
    if (!slot.ok) return fail(429, emailLookupLimitMessage(slot.limit), { code: "hunter_budget" });

    const result = await withUsageContext(id, () =>
      findEmail({
        linkedinUrl: lead.linkedinUrl,
        fullName: named ? person.name : null,
        firstName: named ? person.firstName : null,
        lastName: named ? person.lastName : null,
        domain: person.domain,
        company: person.company,
        budgetMs: LOOKUP_BUDGET_MS,
      }),
    );
    // Nothing reached Hunter (it is paused after a rejected key or used-up credits): give the slot
    // back. A lookup that failed part-way keeps the whole slot, since Hunter may have charged
    // without its reply arriving.
    if (!result.requests) await releaseQuota(slot.id);
    else if (!result.error) await settleQuota(slot.id, creditUnits(result.credits));
    const creditsUsed = result.credits ?? 0;

    if (result.error && result.status !== "claimed") {
      await addEvent(id, "tool", `Email lookup failed: ${result.error}`).catch(() => undefined);
      return fail(502, result.error, { code: "hunter", creditsUsed });
    }

    if (result.email && result.emailStatus) {
      const emailConfidence = emailScore(result.score);
      const saved = await saveFoundEmail(id, { email: result.email, emailStatus: result.emailStatus, emailConfidence }, "lookup");
      const current = saved ?? (await getLead(id));
      if (!current) return leadNotFound();
      if (!saved) {
        // The team added an address while the lookup ran: theirs stays.
        return json({ email: current.email, emailStatus: current.emailStatus, emailConfidence: current.emailConfidence, message: "An address was added on this page while the lookup ran, so it was kept.", creditsUsed, lead: current });
      }
      const message = SAVED_MESSAGE[result.emailStatus](result);
      await addEvent(id, "tool", `Email lookup: ${result.email}. ${message}`, { emailStatus: result.emailStatus, pattern: result.pattern ?? null }).catch((err) =>
        console.error(`[api] could not log the email lookup for lead ${id}: ${errorText(err)}`),
      );
      return json({ email: saved.email, emailStatus: saved.emailStatus, emailConfidence: saved.emailConfidence, message, creditsUsed, lead: saved });
    }

    const why = result.status === "claimed" ? "This person asked Hunter not to process their data, so no address is looked up for them." : (result.reason ?? "Hunter found no address for them.");
    const current = (await getLead(id)) ?? lead;
    const message = current.email ? `${why} The address found earlier is kept.` : why;
    await addEvent(id, "tool", `Email lookup found nothing. ${why}`).catch(() => undefined);
    return json({ email: null, emailStatus: null, emailConfidence: null, message, creditsUsed, lead: current });
  } catch (err) {
    return serverError("POST /api/leads/[id]/email", err);
  } finally {
    inFlight.delete(id);
  }
}
