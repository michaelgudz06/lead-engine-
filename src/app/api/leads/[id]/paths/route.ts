import type { NextRequest } from "next/server";
import { z } from "zod";
import { sourceLine } from "@/lib/paths/copy";
import { findWarmPaths, loadWarmPaths, recomputeWarmPathsFree } from "@/lib/paths/engine";
import { cleanInstagramHandle, isReservedInstagramPath } from "@/lib/paths/links";
import type { WarmPaths } from "@/lib/paths/types";
import { addEvent } from "@/lib/repo/events";
import { getLead } from "@/lib/repo/leads";
import { setTargetInstagram } from "@/lib/repo/paths";
import { quotaLimit, releaseQuota, reserveQuota, warmPathBudgetMessage, warmPathCheckLimitMessage } from "@/lib/repo/quota";
import { errorMessage } from "@/lib/research/util";
import { withUsageContext } from "@/lib/usage/ledger";
import { fail, isStaleRun, json, leadIdFrom, leadNotFound, readJson, serverError, type LeadRouteContext } from "../../../_lib/api";

/**
 * Warm paths for one lead, on demand (src/lib/paths/engine.ts).
 *
 * POST /api/leads/[id]/paths (no body): "Find warm paths" / "Check again". Reads LinkedIn on your
 * own account and X again even when their results are recent, within the daily budgets, and saves
 * the free part (your connections, your roles and schools) whatever happens. Runs inside the lead's
 * usage context and logs one 'tool' event. The app may run open: the checks are capped by the
 * daily budgets, and the reply holds only this lead's paths (at most 10 and 5 company people).
 * - 200 { paths, message, outcome: "found" | "none" }
 * - 400 { code: "nothing_to_check" }: the lead has no LinkedIn profile and no X handle.
 * - 400 { code: "not_set_up", paths }: nothing of yours is set up (the lead's side is still saved).
 * - 404: unknown lead.
 * - 409 { code: "research_running" }: research is running, and it checks warm paths itself.
 * - 409 { code: "checking" }: a check is already running for this lead.
 * - 409 { code: "changed" }: the lead got another LinkedIn profile during the check (nothing saved).
 * - 429 { code: "warm_path_budget", paths }: every live source you set up is over its daily budget.
 * - 502 { code: "upstream", paths }: every live source you set up failed, and nothing else was
 *   checked (the stored paths say error). When your connections or work history were still
 *   matched, or an earlier result still counts, the reply is 200 and the footer line says what
 *   failed, as the page shows after a reload.
 * - 500 { code: "error" }: the check failed unexpectedly (the stored paths are kept).
 *
 * PATCH /api/leads/[id]/paths { instagramHandle: string | null } -> { paths }: the lead's Instagram
 * handle, typed in (null or "" clears it). Instagram is a link only: nothing is ever read from it.
 * - 400 { code: "bad_handle" }: not [A-Za-z0-9._]{1,30}, or a reserved Instagram path.
 * - 404: unknown lead. 409 { code: "checking" }: a check is running (try again when it ends).
 */

// LinkedIn on your account (up to 15 s a call) and X (45 s in all) run side by side in 50 s.
export const maxDuration = 60;
const CHECK_BUDGET_MS = 50_000;

/** Checks in progress on this instance: a double click must not pay twice. */
const inFlight = new Set<string>();

const CHECKING = "Checking warm paths now. Try again when it finishes.";

/** "Could not check for warm paths. X: did not answer (twitterapi.io HTTP 502). Try again in a few minutes." */
function upstreamMessage(paths: WarmPaths | null): string {
  const failed = (paths?.sources ?? []).filter((s) => s.state === "failed").map(sourceLine);
  return ["Could not check for warm paths.", ...failed, "Try again in a few minutes."].join(" ");
}

export async function POST(_request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  if (inFlight.has(id)) return fail(409, CHECKING, { code: "checking" });

  inFlight.add(id);
  try {
    const lead = await getLead(id);
    if (!lead) return leadNotFound();
    if (lead.researchStatus === "running" && !isStaleRun(lead)) {
      return fail(409, "Research is running and checks warm paths itself. Try again when it finishes.", { code: "research_running" });
    }

    // Counted across the app (the free part needs no outside call, so it has no budget of its own).
    const slot = await reserveQuota("warm_path_check", 1, id);
    if (!slot.ok) return fail(429, warmPathCheckLimitMessage(), { code: "warm_path_check_limit" });
    const res = await withUsageContext(id, () => findWarmPaths(id, { trigger: "button", force: true, budgetMs: CHECK_BUDGET_MS }));
    // Nothing was compared: the check does not count.
    if (res.outcome !== "found" && res.outcome !== "none") await releaseQuota(slot.id);
    switch (res.outcome) {
      case "lead_missing":
        // The lead is gone, or got another LinkedIn profile while the check ran (nothing was saved).
        return (await getLead(id)) ? fail(409, "The lead's LinkedIn profile changed during the check. Try again.", { code: "changed" }) : leadNotFound();
      case "busy":
        return fail(409, CHECKING, { code: "checking" });
      case "nothing_to_check":
        return fail(400, "Add their LinkedIn profile or X handle on this page first.", { code: "nothing_to_check", paths: res.paths });
      case "not_set_up": {
        // An X handle only helps when X checks are on for this server (TWITTERAPI_IO_KEY).
        const what = res.paths?.setup.xAvailable ? "Add your LinkedIn connections or your X handle in Settings." : "Upload your LinkedIn connections or add your profile link in Settings.";
        return fail(400, `Nothing is set up yet. ${what}`, { code: "not_set_up", paths: res.paths });
      }
      case "error":
        // An internal error: the log keeps it, the reply does not. Quoted text is cut (a JSON parse
        // error quotes its input), so no name can reach the log.
        console.error(`[api] warm-path check for lead ${id} failed: ${res.message.replace(/"[^"]*"|'[^']*'/g, "…").slice(0, 300)}`);
        await addEvent(id, "tool", "Warm paths: could not check. Try again in a few minutes.", { warmPaths: "error", trigger: "button" }).catch(() => undefined);
        return fail(500, "Could not check for warm paths. Try again in a few minutes.", { code: "error" });
    }

    await addEvent(id, "tool", res.message, { warmPaths: res.outcome, trigger: "button", xCredits: res.spent.xCredits, linkedinRequests: res.spent.linkedinRequests }).catch((err) =>
      console.error(`[api] could not log the warm-path check of lead ${id}: ${errorMessage(err).slice(0, 200)}`),
    );
    const { setUp, overBudget, failed } = res.live;
    if (setUp.length && setUp.every((s) => overBudget.includes(s))) {
      const error = warmPathBudgetMessage({
        linkedin: setUp.includes("linkedin") ? { limit: quotaLimit("warm_path_linkedin") } : null,
        x: setUp.includes("x") ? { limit: quotaLimit("warm_path_x") } : null,
      });
      return fail(429, error, { code: "warm_path_budget", paths: res.paths });
    }
    // Partly failed (your connections, your work history or an earlier result still counted): 200,
    // and the footer line says what failed. 502 only when nothing was checked.
    if (setUp.length && setUp.every((s) => failed.includes(s)) && res.paths?.status !== "done") return fail(502, upstreamMessage(res.paths), { code: "upstream", paths: res.paths });
    return json({ paths: res.paths, message: res.message, outcome: res.outcome });
  } catch (err) {
    return serverError("POST /api/leads/[id]/paths", err);
  } finally {
    inFlight.delete(id);
  }
}

const InstagramBody = z.object({
  instagramHandle: z
    .string({ error: "instagramHandle must be text, or null to clear it." })
    .trim()
    .max(200, "That is too long for an Instagram username.")
    .nullable(),
});

export async function PATCH(request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  const body = await readJson(request, InstagramBody);
  if (!body.ok) return body.response;
  const raw = body.data.instagramHandle;
  const handle = raw ? cleanInstagramHandle(raw) : null;
  if (raw && !handle) {
    const error = isReservedInstagramPath(raw)
      ? "That is an Instagram page, not a profile. Enter their username, such as @ada.kim."
      : "Enter their Instagram username: letters, digits, dots and _, up to 30.";
    return fail(400, error, { code: "bad_handle" });
  }
  try {
    const lead = await getLead(id);
    if (!lead) return leadNotFound();
    // Refused while a check runs: it would save the lead's side it read before this handle.
    const saved = await setTargetInstagram(id, handle, "manual", { onlyIfIdle: true });
    if (!saved) return (await getLead(id)) ? fail(409, CHECKING, { code: "checking" }) : leadNotFound();
    // The footer's Instagram line follows (SQL only; nothing when the lead was never checked).
    await recomputeWarmPathsFree(id);
    return json({ paths: await loadWarmPaths(lead) });
  } catch (err) {
    return serverError("PATCH /api/leads/[id]/paths", err);
  }
}
