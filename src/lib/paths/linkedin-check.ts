import "server-only";
import { getNetworkAccountState, getNetworkDegree, getNetworkOwnerFlags, networkAccountConfigured, searchSharedConnections, type SharedConnectionsPage } from "../providers/linkedin";
import { getNetworkSource, saveNetworkSource } from "../repo/network";
import type { LinkedinLive } from "../repo/paths";
import { releaseQuota, reserveQuota } from "../repo/quota";
import { LINKEDIN_LIVE_FAILED_TTL_MS, LINKEDIN_LIVE_TTL_MS, type LinkedinPauseKind, type WarmPathTarget, type WarmSourceReason } from "./types";

/**
 * Step 2 of warm paths: the owner's own LinkedIn on Unipile (UNIPILE_NETWORK_ACCOUNT_ID), off until
 * that is set. At most 10 checks a day across the app (WARM_PATH_LINKEDIN_CHECKS_PER_DAY), at
 * least 2 minutes apart; each lead's result is cached 30 days. A check:
 *  1. the lead's degree (one LinkedIn request, no profile sections, notify=false);
 *  2. for a 2nd-degree lead only, one page of the shared-connections search;
 *  3. once ever, the account's premium flags.
 * A 429 pauses the account for 24 hours, a 5xx or 401 for 1 hour; the pause is stored in
 * le_network_sources (linkedin_account), so every server instance respects it. Never Apify, and
 * never the research account's cooldown. The reserved check is kept once LinkedIn was called and
 * given back only when nothing was sent.
 */

const PAUSE_429_MS = 24 * 3_600_000;
const PAUSE_OTHER_MS = 3_600_000;

export interface LeadLinkedinResult {
  state: "checked" | "cached" | "skipped" | "failed";
  reason: WarmSourceReason | null;
  error: string | null;
  /** New or cached data; null when nothing is known. */
  live: LinkedinLive | null;
  /** LinkedIn requests made on your account. */
  requests: number;
  /** When a minimum gap stopped the check: how long until the next one may run. */
  waitMs?: number;
  /** The lead's member id, when the check learned it (the target had only the slug). */
  memberId?: string | null;
}

/**
 * The safety checks a shared-connections search must pass before its people are shown:
 * every item is your 1st degree (DISTANCE_1), the echoed search config carries the lead's member
 * id, and the total is at most LinkedIn's shared count + 5 (250 when the count is unknown).
 * Pure. Returns the reason it fails, or null.
 */
export function sharedConnectionsProblem(page: SharedConnectionsPage, memberId: string, sharedCount: number | null): string | null {
  if (page.items.some((i) => i.distance !== "DISTANCE_1")) return "a result was not your 1st-degree connection";
  if (!JSON.stringify(page.config ?? null).includes(memberId)) return "LinkedIn did not confirm the shared-connections filter";
  const total = page.total ?? page.items.length;
  const cap = sharedCount === null ? 250 : sharedCount + 5;
  if (total > cap) return `the search found ${total} people, more than the ${sharedCount ?? "about 250"} LinkedIn says you share`;
  return null;
}

/**
 * True when a cached check belongs to this target and is younger than 30 days. A 2nd-degree check
 * whose shared-connections search never ran (no time was left after the degree read) is not kept,
 * and one whose search failed (an error or a timeout) is kept for an hour only.
 */
export function linkedinLiveFresh(live: LinkedinLive | null, target: WarmPathTarget | null, now: number): boolean {
  const searchSkipped = Boolean(live && live.distance === "SECOND_DEGREE" && !live.verified && live.memberId && live.form === null);
  const ttl = live?.searchFailed ? LINKEDIN_LIVE_FAILED_TTL_MS : LINKEDIN_LIVE_TTL_MS;
  return Boolean(live && linkedinLiveMatches(live, target) && !searchSkipped && now - Date.parse(live.checkedAt) < ttl);
}

/** True when a cached check was made for this lead's profile (its member id). */
export function linkedinLiveMatches(live: LinkedinLive | null, target: WarmPathTarget | null): boolean {
  return Boolean(live && target?.linkedinMemberId && live.memberId === target.linkedinMemberId);
}

const MEMBER_ID = /^A[CD]o[A-Za-z0-9_-]{8,}$/;

/** The pause stored for your account, or null. */
async function pausedUntil(now: number): Promise<{ until: string; reason: string | null } | null> {
  const row = await getNetworkSource("linkedin_account");
  const until = typeof row?.data.pausedUntil === "string" ? row.data.pausedUntil : null;
  if (!until || Date.parse(until) <= now) return null;
  return { until, reason: typeof row?.data.pauseReason === "string" ? row.data.pauseReason : null };
}

/** Pauses your account's checks; the kind tells Settings what to say (wait, or fix the key). */
async function pause(ms: number, reason: string, kind: LinkedinPauseKind, now: number): Promise<void> {
  await saveNetworkSource("linkedin_account", { data: { pausedUntil: new Date(now + ms).toISOString(), pauseReason: reason, pauseKind: kind } }).catch(() => undefined);
}

/**
 * The lead's LinkedIn degree and shared connections from your own account. `cached` is reused
 * while fresh unless `force`. Never throws.
 */
export async function checkLeadLinkedin(input: {
  leadId: string;
  target: WarmPathTarget | null;
  /** The lead's slug, used for the degree when the member id is not known yet. */
  slug?: string | null;
  cached: LinkedinLive | null;
  force?: boolean;
  stopAt: number;
  now?: () => number;
}): Promise<LeadLinkedinResult> {
  const now = input.now ?? Date.now;
  let requests = 0;
  try {
    if (!networkAccountConfigured()) return { state: "skipped", reason: "not_configured", error: null, live: null, requests };
    const known = input.target?.linkedinMemberId ?? null;
    const ident = known ?? input.target?.linkedinSlug ?? input.slug ?? null;
    if (!ident) return { state: "skipped", reason: "no_target", error: null, live: null, requests };
    if (!input.force && linkedinLiveFresh(input.cached, input.target, now())) return { state: "cached", reason: null, error: null, live: input.cached, requests };
    const paused = await pausedUntil(now());
    if (paused) return { state: "skipped", reason: "account_paused", error: paused.reason, live: null, requests };
    const account = await getNetworkAccountState();
    if (account.state === "needs_reconnect") return { state: "skipped", reason: "needs_reconnect", error: account.detail, live: null, requests };
    if (account.state !== "connected") return { state: "failed", reason: "upstream", error: account.detail ?? "Unipile did not answer.", live: null, requests };
    if (input.stopAt - now() < 5000) return { state: "skipped", reason: "timeout", error: null, live: null, requests };

    const slot = await reserveQuota("warm_path_linkedin", 1, input.leadId);
    if (!slot.ok) {
      if (slot.reason === "gap") return { state: "skipped", reason: "gap", error: null, live: null, requests, waitMs: slot.waitMs };
      return { state: "skipped", reason: slot.limit === 0 ? "paused" : "budget", error: null, live: null, requests };
    }

    // A slug goes as a profile URL: a bare identifier must be ASCII, and slugs keep letters such as "é".
    const degree = await getNetworkDegree(known ?? `https://www.linkedin.com/in/${encodeURIComponent(ident)}`, { timeoutMs: Math.min(15_000, input.stopAt - now()) });
    if (!degree.ok) {
      if (!degree.sent) await releaseQuota(slot.id);
      else requests++;
      if (degree.kind === "rate_limited") await pause(PAUSE_429_MS, "LinkedIn asked to slow down (429)", "rate_limited", now());
      else if (degree.kind === "server" || degree.kind === "auth") {
        await pause(PAUSE_OTHER_MS, degree.kind === "auth" ? "Unipile refused the key (401)" : `LinkedIn or Unipile had an error (${degree.status})`, degree.kind === "auth" ? "auth" : "error", now());
      }
      const reason: WarmSourceReason = degree.kind === "timeout" ? "timeout" : degree.kind === "config" ? "needs_reconnect" : "upstream";
      return { state: "failed", reason, error: degree.error, live: null, requests };
    }
    requests++;
    const learned = degree.value.providerId && MEMBER_ID.test(degree.value.providerId) ? degree.value.providerId : null;
    const memberId = known ?? learned;
    const live: LinkedinLive = {
      memberId,
      distance: degree.value.distance,
      sharedCount: degree.value.sharedCount,
      mutuals: [],
      total: null,
      form: null,
      verified: false,
      reason: null,
      checkedAt: new Date(now()).toISOString(),
    };

    if (degree.value.distance === "SECOND_DEGREE" && !memberId) {
      live.reason = "LinkedIn did not give the lead's member id, so the shared connections were not searched";
    } else if (memberId && degree.value.distance === "SECOND_DEGREE" && input.stopAt - now() > 4000) {
      const settings = await getNetworkSource("linkedin_account");
      const form = settings?.data.searchForm === "url" ? "url" : "classic";
      const search = await searchSharedConnections(memberId, { form, timeoutMs: Math.min(15_000, input.stopAt - now()) });
      live.form = form;
      if (search.ok) {
        requests++;
        live.total = search.value.total;
        const problem = sharedConnectionsProblem(search.value, memberId, degree.value.sharedCount);
        if (problem) live.reason = problem;
        else {
          live.verified = true;
          live.mutuals = search.value.items.slice(0, 10).flatMap((i) => (i.name ? [{ memberId: i.memberId, slug: i.slug ? i.slug.toLowerCase() : null, name: i.name, headline: i.headline, url: i.url, company: i.company, role: i.role }] : []));
        }
      } else {
        if (search.sent) requests++;
        if (search.kind === "rate_limited") await pause(PAUSE_429_MS, "LinkedIn asked to slow down (429)", "rate_limited", now());
        else if (search.kind === "server" || search.kind === "auth") {
          await pause(PAUSE_OTHER_MS, search.kind === "auth" ? "Unipile refused the key (401)" : `LinkedIn or Unipile had an error (${search.status ?? "no answer"})`, search.kind === "auth" ? "auth" : "error", now());
        }
        live.reason = `the shared-connections search failed (${search.error})`;
        live.searchFailed = true;
      }
    } else if (degree.value.distance !== "SECOND_DEGREE") {
      live.verified = true;
    } else {
      // 2nd degree, but no time was left for the search: the footer says so, and it is not kept.
      live.reason = "there was no time left to search the shared connections";
    }

    // Once: whether the account is Premium or Sales Navigator (shown in Settings).
    const stored = await getNetworkSource("linkedin_account");
    if (stored?.data.premium === undefined && input.stopAt - now() > 3000) {
      const flags = await getNetworkOwnerFlags({ timeoutMs: Math.min(10_000, input.stopAt - now()) });
      if (flags.ok || flags.sent) requests++;
      if (flags.ok) await saveNetworkSource("linkedin_account", { data: { premium: flags.value.premium, salesNavigator: flags.value.salesNavigator } }).catch(() => undefined);
    }
    return { state: "checked", reason: live.reason ? "unverified" : null, error: live.reason, live, requests, memberId };
  } catch (err) {
    return { state: "failed", reason: "upstream", error: `LinkedIn check failed (${err instanceof Error ? err.message.slice(0, 120) : "error"})`, live: null, requests };
  }
}
