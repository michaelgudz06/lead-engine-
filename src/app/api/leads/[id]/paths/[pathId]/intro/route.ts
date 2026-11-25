import type { NextRequest } from "next/server";
import { z } from "zod";
import { ClaudeError, generateObject } from "@/lib/claude";
import { getWarmPath } from "@/lib/paths/engine";
import { canDraftIntro, cleanIntroMessage, INTRO_FINDINGS, INTRO_SYSTEM, introDraftProblem, introPrompt } from "@/lib/paths/intro";
import { listFindings } from "@/lib/repo/findings";
import { getLead } from "@/lib/repo/leads";
import { saveIntro } from "@/lib/repo/paths";
import { introDraftLimitMessage, releaseQuota, reserveQuota } from "@/lib/repo/quota";
import { getSettings } from "@/lib/repo/settings";
import { fail, json, leadNotFound, serverError } from "../../../../../_lib/api";
import { pathParamsFrom, type PathRouteContext } from "../../../../../_lib/paths";

/**
 * POST /api/leads/[id]/paths/[pathId]/intro (no body) -> { path } with path.introDraft.
 *
 * Drafts one intro request to the person in the middle of the path (src/lib/paths/intro.ts):
 * one Claude call through generateObject, so it is claude-haiku-5-5 at effort low with no
 * sampling parameters, booked on the lead in the usage ledger. Nothing is sent from here.
 * Every input is wrapped as data. A new draft replaces the one before.
 *
 * The app may run open, so drafts are capped across the app at 100 per rolling 24 hours
 * (le_quota_uses, kind intro_draft): 429 { code: "intro_budget" } over the cap.
 * - 400 { code: "direct" }: the direct path (nobody in between).
 * - 404: unknown lead or path. 409 { code: "drafting" }: a draft is already running for this lead.
 * - 502 { code: "claude" }: Claude declined, was cut off or failed ("Could not draft the request: ..."),
 *   or the draft had a link or an email address in it (the prompt forbids them, so it followed
 *   something in the data): nothing is saved, and the draft still counts.
 */

// generateObject gets 30 s; the client waits 35 s.
export const maxDuration = 60;
const DRAFT_TIMEOUT_MS = 30_000;

const IntroSchema = z.object({ message: z.string() });

/** Drafts in progress on this instance, per lead: the page drafts one request at a time. */
const drafting = new Set<string>();

/** A plain reason for a failed draft: no model output, no names. */
function draftFailure(err: ClaudeError): string {
  switch (err.kind) {
    case "refusal":
      return "Could not draft the request: Claude declined it. Write it yourself, or try again.";
    case "max_tokens":
    case "parse":
      return "Could not draft the request: the answer came back incomplete. Try again.";
    case "timeout":
    case "aborted":
      return "Could not draft the request: Claude did not answer in time. Try again.";
    case "rate_limit":
    case "overloaded":
      return "Could not draft the request: Claude is busy. Try again in a minute.";
    case "config":
      return "Could not draft the request: the Claude API key is missing or was rejected on the server.";
    default:
      return "Could not draft the request: the Claude API failed. Try again.";
  }
}

export async function POST(_request: NextRequest, ctx: PathRouteContext) {
  const { id, pathId } = await pathParamsFrom(ctx);
  if (!id) return leadNotFound();
  if (!pathId) return fail(404, "Path not found.");
  if (drafting.has(id)) return fail(409, "Drafting another request. Try again when it finishes.", { code: "drafting" });

  drafting.add(id);
  try {
    const [lead, path, findings, settings] = await Promise.all([getLead(id), getWarmPath(id, pathId), listFindings(id), getSettings()]);
    if (!lead) return leadNotFound();
    if (!path) return fail(404, "Path not found.");
    if (!canDraftIntro(path)) return fail(400, "You are connected directly: no intro is needed.", { code: "direct" });

    // One Claude call: counted before it is made, so a loop on an open app cannot run them up.
    const slot = await reserveQuota("intro_draft", 1, id);
    if (!slot.ok) return fail(429, introDraftLimitMessage(), { code: "intro_budget" });

    const angle = lead.approach?.leadAngleId ? lead.angles.find((a) => a.id === lead.approach?.leadAngleId) : undefined;
    const prompt = introPrompt({
      senderName: settings.senderName,
      path,
      lead: { name: lead.name, title: lead.title, companyName: lead.companyName },
      briefSummary: lead.brief?.summary ?? null,
      angleReasoning: angle?.reasoning ?? null,
      // listFindings is most relevant first.
      findings: findings.filter((f) => f.passesCriteria).slice(0, INTRO_FINDINGS),
    });

    let message: string;
    try {
      const out = await generateObject({
        leadId: id,
        label: "Drafting an intro request",
        system: INTRO_SYSTEM,
        prompt,
        schema: IntroSchema,
        maxTokens: 1000,
        timeoutMs: DRAFT_TIMEOUT_MS,
      });
      message = cleanIntroMessage(out.message);
    } catch (err) {
      const mapped = err instanceof ClaudeError ? err : new ClaudeError("api", "unexpected");
      // No key: nothing reached Claude, so the draft does not count.
      if (mapped.kind === "config") await releaseQuota(slot.id);
      console.error(`[api] intro draft for lead ${id} failed: ${mapped.kind}`);
      return fail(502, draftFailure(mapped), { code: "claude" });
    }
    if (!message) return fail(502, "Could not draft the request: the answer came back empty. Try again.", { code: "claude" });
    const problem = introDraftProblem(message);
    if (problem) return fail(502, `Could not draft the request: the answer had ${problem} in it. Try again, or write it yourself.`, { code: "claude" });

    const entry = await saveIntro(id, pathId, { introDraft: { message, createdAt: new Date().toISOString() } });
    if (!entry) return fail(404, "Path not found.");
    return json({ path: { ...path, introDraft: entry.introDraft, askedAt: entry.askedAt } });
  } catch (err) {
    return serverError("POST /api/leads/[id]/paths/[pathId]/intro", err);
  } finally {
    drafting.delete(id);
  }
}
