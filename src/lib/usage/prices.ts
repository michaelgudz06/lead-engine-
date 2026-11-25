import type { CostBasis, UsageUnits } from "./types";

/**
 * Price table for the usage ledger. No secrets, no network: plain numbers and arithmetic.
 *
 * PRICES AS OF 2026-11-23. Review when a provider changes its pricing or the owner changes
 * a plan. Where a provider returns the billed cost itself (Exa, OpenRouter) that number is
 * stored as "reported" and nothing here is used; the table only fills in what is missing,
 * and those rows are stored as "estimated".
 */
export const PRICES_AS_OF = "2026-11-25";

const PER_MILLION = 1_000_000;

// ---------------------------------------------------------------------------------------------
// Anthropic: Claude Haiku 5.5 (the only model the app runs)

export const HAIKU_55 = {
  /** A request whose whole prompt (input + cache reads + cache writes) is above this is billed at the long tier. */
  longPromptAboveTokens: 100_000,
  /** USD per million tokens, prompts up to 100K tokens. From the owner's price sheet. */
  standard: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  /** USD per million tokens, prompts above 100K tokens. The whole request is billed at this tier. */
  long: { inputPerMTok: 0.5, outputPerMTok: 2.5 },
  /**
   * ESTIMATE, not from the price sheet: cache reads at 0.1x and 5-minute cache writes at 1.25x
   * the tier's input price (Anthropic's usual multipliers). The app sends no cache_control
   * today, so both counts are normally zero and this estimate does not move the totals.
   */
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
} as const;

export interface ClaudeTokens {
  /** Uncached input tokens (usage.input_tokens). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cost of ONE Claude response. The tier depends on that request's prompt size, so never pass summed tokens of several calls. */
export function claudeCostUsd(t: ClaudeTokens): number {
  const input = nonNeg(t.inputTokens);
  const output = nonNeg(t.outputTokens);
  const cacheRead = nonNeg(t.cacheReadTokens);
  const cacheWrite = nonNeg(t.cacheWriteTokens);
  const prompt = input + cacheRead + cacheWrite;
  const tier = prompt > HAIKU_55.longPromptAboveTokens ? HAIKU_55.long : HAIKU_55.standard;
  const usd =
    (input * tier.inputPerMTok +
      cacheRead * tier.inputPerMTok * HAIKU_55.cacheReadMultiplier +
      cacheWrite * tier.inputPerMTok * HAIKU_55.cacheWriteMultiplier +
      output * tier.outputPerMTok) /
    PER_MILLION;
  return roundUsd(usd);
}

export function claudeUnits(t: ClaudeTokens): UsageUnits {
  return {
    inputTokens: nonNeg(t.inputTokens),
    outputTokens: nonNeg(t.outputTokens),
    cacheReadTokens: nonNeg(t.cacheReadTokens),
    cacheWriteTokens: nonNeg(t.cacheWriteTokens),
  };
}

// ---------------------------------------------------------------------------------------------
// Exa: the API returns costDollars.total on every answer; that is what gets stored.

/**
 * ESTIMATE, used only when an answer carries no costDollars. These are the amounts Exa
 * reported on live calls from this app on 2026-11-23: a search with page text cost $0.007
 * for up to 10 results and $0.001 more per result above 10 (12 results: $0.009); /contents
 * cost $0.001 per page of text.
 */
export const EXA_ESTIMATE = {
  searchUsd: 0.007,
  resultsIncluded: 10,
  extraResultUsd: 0.001,
  pageTextUsd: 0.001,
} as const;

export function exaEstimateUsd(operation: "search" | "contents", o: { results: number }): number {
  const results = nonNeg(o.results);
  if (operation === "contents") return roundUsd(results * EXA_ESTIMATE.pageTextUsd);
  return roundUsd(EXA_ESTIMATE.searchUsd + Math.max(0, results - EXA_ESTIMATE.resultsIncluded) * EXA_ESTIMATE.extraResultUsd);
}

/** Reads costDollars.total from an Exa answer. Null when missing or not a sane number. */
export function exaReportedCostUsd(body: unknown): number | null {
  const cost = isRec(body) ? body.costDollars : null;
  const total = isRec(cost) ? cost.total : null;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? roundUsd(total) : null;
}

// ---------------------------------------------------------------------------------------------
// Apify: HarvestAPI actors (APIFY_ACTORS in providers/linkedin.ts), pay per item. ESTIMATED:
// the run-sync endpoint does not return the charge, so it is items x the actor's listed price.

export const APIFY_USD_PER_ITEM = {
  /** harvestapi/linkedin-profile-scraper, mode "Profile details no email ($4 per 1k)". */
  profile: 0.004,
  /** harvestapi/linkedin-profile-posts, $2 per 1k posts. */
  posts: 0.002,
  /** harvestapi/linkedin-company, $4 per 1k companies. */
  company: 0.004,
} as const;
export type ApifyOperation = keyof typeof APIFY_USD_PER_ITEM;

export function apifyCostUsd(operation: ApifyOperation, items: number): number {
  return roundUsd(nonNeg(items) * APIFY_USD_PER_ITEM[operation]);
}

// ---------------------------------------------------------------------------------------------
// Credit plans. Both accounts are on FREE plans today, so credits are counted as units and
// the cost is 0 with basis "free". After upgrading, set usdPerCredit to (plan price / credits
// in the plan): rows written from then on are stored as "estimated" at that rate.

export const APOLLO_PLAN = { name: "free", usdPerCredit: 0 } as const;
export const HUNTER_PLAN = { name: "free", usdPerCredit: 0, creditsPerMonth: 50 } as const;

/** Apollo charges one credit per enriched record or page of job postings; a failed or blocked call charges none. */
export const APOLLO_CREDITS_PER_CALL = 1;
/** Hunter's Email Finder charges one credit only when it returns an address. */
export const HUNTER_CREDITS_PER_FOUND_EMAIL = 1;

export function creditCost(credits: number, plan: { usdPerCredit: number }): { costUsd: number; costBasis: CostBasis } {
  if (plan.usdPerCredit <= 0) return { costUsd: 0, costBasis: "free" };
  return { costUsd: roundUsd(nonNeg(credits) * plan.usdPerCredit), costBasis: "estimated" };
}

// ---------------------------------------------------------------------------------------------
// No per-call charge: requests are counted, cost 0, basis "free".
// - Unipile: flat monthly subscription per connected account, not per request.
// - Hugging Face Hub API, Abstract inspect, HubSpot CRM API: free to call.

export const FREE: { costUsd: number; costBasis: CostBasis } = { costUsd: 0, costBasis: "free" };

// ---------------------------------------------------------------------------------------------
// OpenRouter (Grok with X search): usage.cost from the answer is stored as "reported".
// ROUGH ASSUMPTION for the one-time backfill only, where the old counters kept no cost:
// 3 cents per pinned X search (search fee plus tokens). Not measured; live rows carry the
// real billed cost.

export const OPENROUTER_X_SEARCH_BACKFILL_USD = 0.03;

// ---------------------------------------------------------------------------------------------
// twitterapi.io (X follow lists for warm paths). ESTIMATED: the API does not return what a call
// was charged, so each call is booked from the published credit table (twitterapi.io/pricing and
// the endpoint pages, read 2026-11-25). $1 = 100,000 credits.
// - user/info: one profile, about 18 credits
// - followings: 1 credit per account at 200 a page, 2 at 100-199, 3 below 100; at least 60 a call
//   (the endpoint page; the pricing page says 15, the higher is used)
// - followers_ids: 0.45 credits per id at 4,000-5,000 a call, 1 at 200-3,999, 2 below; at least
//   100 a call. The tier is taken from the ids returned, which never undercounts.
// - check_follow_relationship: 100 credits

export const TWITTERAPI_CREDITS_PER_USD = 100_000;

export const TWITTERAPI_CREDITS = {
  userInfo: 18,
  followingsMinCall: 60,
  followerIdsMinCall: 100,
  followCheck: 100,
  /** The most one followings call can cost (199 accounts at 2 credits each). */
  followingsMaxCall: 398,
  /** The most one follower-ids call can cost (3,999 ids at 1 credit each). */
  followerIdsMaxCall: 3999,
} as const;

export function twitterapiCostUsd(credits: number): number {
  return roundUsd(nonNeg(credits) / TWITTERAPI_CREDITS_PER_USD);
}

// ---------------------------------------------------------------------------------------------

/** numeric(12,6) in the ledger. */
export function roundUsd(usd: number): number {
  return Number.isFinite(usd) ? Math.round(usd * 1e6) / 1e6 : 0;
}

function nonNeg(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
