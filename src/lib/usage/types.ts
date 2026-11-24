/**
 * Usage ledger types: one row per paid or metered call to an outside API, and the shapes the
 * Usage tab reads from it. Client-safe (types and constants only).
 */

export const USAGE_PROVIDERS = [
  "anthropic",
  "exa",
  "unipile",
  "apify",
  "apollo",
  "hunter",
  "openrouter",
  "huggingface",
  "abstract",
  "hubspot",
] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  anthropic: "Anthropic (Claude Haiku 5.5)",
  exa: "Exa",
  unipile: "Unipile (LinkedIn)",
  apify: "Apify (LinkedIn fallback)",
  apollo: "Apollo",
  hunter: "Hunter",
  openrouter: "OpenRouter (Grok X search)",
  huggingface: "Hugging Face",
  abstract: "Abstract inspect",
  hubspot: "HubSpot",
};

/**
 * Unit names per provider (keys of `units`). Writers must use these names so the
 * Usage tab can label and sum them.
 * - anthropic: inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
 * - exa: searches, contents, results
 * - unipile: requests
 * - apify: runs, items
 * - apollo: credits
 * - hunter: lookups, credits (finder: 1 when an email was found; Domain Search: 1; verifier: 0.5)
 * - openrouter: requests, xPosts, xProfiles, promptTokens, completionTokens
 * - huggingface, abstract, hubspot: requests
 */
export type UsageUnits = Record<string, number>;

/** reported: the provider returned the cost; estimated: price table x units; free: no charge; unknown. */
export type CostBasis = "reported" | "estimated" | "free" | "unknown";

/**
 * The operation of the rows scripts/backfill-usage.ts filled in from the old per-lead
 * counters, before the ledger existed. Each row holds one provider's totals for a lead (many
 * calls, no duration), so per-call figures leave these rows out; totals keep them.
 */
export const BACKFILL_OPERATION = "backfill";

export type UsageWindow = "today" | "7d" | "30d" | "all";

export interface UsageRecord {
  id: number;
  leadId: string | null;
  /** Snapshot of the lead's name when the row was read; null if the lead was deleted. */
  leadName: string | null;
  provider: UsageProvider;
  /** e.g. "messages.parse", "search", "contents", "profile", "posts", "email-finder", "x-search". */
  operation: string;
  units: UsageUnits;
  costUsd: number | null;
  costBasis: CostBasis;
  ok: boolean;
  ms: number | null;
  createdAt: string;
}

export interface ProviderTotals {
  provider: UsageProvider;
  calls: number;
  failed: number;
  costUsd: number;
  /** True when part of costUsd is estimated from the price table rather than reported. */
  costEstimated: boolean;
  units: UsageUnits;
}

export interface UsageSummary {
  window: UsageWindow;
  /** ISO start of the window, null for all time. */
  from: string | null;
  totalCostUsd: number;
  providers: ProviderTotals[];
  /** Distinct leads with any usage in the window. */
  leadsTouched: number;
  /** totalCostUsd of lead-tagged usage / leadsTouched, null when no leads. */
  avgCostPerLeadUsd: number | null;
  /** Usage not tied to a lead (tests and calls made outside a lead's run, such as HubSpot pushes without context). */
  untaggedCostUsd: number;
}

export interface LeadUsage {
  /** null groups usage whose lead was deleted. */
  leadId: string | null;
  leadName: string | null;
  company: string | null;
  firstAt: string;
  lastAt: string;
  totalCostUsd: number;
  byProvider: Partial<Record<UsageProvider, { calls: number; costUsd: number; units: UsageUnits }>>;
}

export interface DailySpend {
  /** YYYY-MM-DD (UTC). */
  day: string;
  totalUsd: number;
  byProvider: Partial<Record<UsageProvider, number>>;
}

/** A live balance or quota read from the provider's own API, for the Usage tab. */
export interface ProviderBalance {
  provider: UsageProvider;
  /** Human line, e.g. "37 of 50 credits left this month". */
  summary: string;
  /** 0..1 share used, when a limit is known. */
  usedShare: number | null;
  /** Raw numbers worth showing, e.g. { used: 13, limit: 50 }. */
  numbers: Record<string, number>;
  /** "live" = read just now from the provider; "ledger" = derived from our own ledger; "unavailable". */
  source: "live" | "ledger" | "unavailable";
  note: string | null;
  checkedAt: string;
}

/**
 * One provider and operation over a window: how many calls it made, how long they took and
 * what they cost. Time figures cover the calls with a recorded duration (timedCalls), cost
 * figures the calls with a known cost (pricedCalls); failed calls count in both.
 */
export interface OperationStats {
  provider: UsageProvider;
  /** As written by the provider module, e.g. "search", "messages.parse", "profile". */
  operation: string;
  calls: number;
  failed: number;
  timedCalls: number;
  /** Median duration in ms (interpolated), null when no call has a duration. */
  medianMs: number | null;
  /** 95th percentile duration in ms (interpolated), null when no call has a duration. */
  p95Ms: number | null;
  /** The slowest call in ms. */
  maxMs: number | null;
  pricedCalls: number;
  /** Sum of the known costs, in USD. */
  totalCostUsd: number;
  /** totalCostUsd / pricedCalls, null when no call has a known cost. */
  avgCostUsd: number | null;
  /** The most expensive single call, in USD. */
  maxCostUsd: number | null;
  /** Part of the cost is estimated from the price table rather than reported. */
  costEstimated: boolean;
}

export type RunKind = "research" | "steer";

/**
 * done: ended with a 'done' event. failed: ended with an 'error' event. running: no end yet
 * and still inside the time a run can take. lost: no end was recorded in that time (the run
 * was cut off, or the server restarted).
 */
export type RunOutcome = "done" | "failed" | "running" | "lost";

/** One research or steer run (le_run_starts), its length from the lead's events and its cost from the ledger. */
export interface RunUsage {
  id: number;
  kind: RunKind;
  leadId: string;
  /** The lead's name, else its LinkedIn slug; null when it has neither. */
  leadName: string | null;
  company: string | null;
  startedAt: string;
  /** The run's 'done' or 'error' event; null while running or when lost. */
  endedAt: string | null;
  outcome: RunOutcome;
  /** endedAt - startedAt, null when there is no end. */
  durationMs: number | null;
  /** Ledger rows of the lead during the run (rows filled in from before the ledger are left out). */
  calls: number;
  failedCalls: number;
  /** Sum of their known costs in USD; null when none of them has a known cost (or there are none). */
  costUsd: number | null;
  costEstimated: boolean;
  /** The end event's text, e.g. "Research done in 77s: 38 findings, 2 angles" or why it failed. */
  endMessage: string | null;
}

/** Orders for the call list: newest first, slowest first, most expensive first. */
export type CallSort = "newest" | "slowest" | "costliest";
