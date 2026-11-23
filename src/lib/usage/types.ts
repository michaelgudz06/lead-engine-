/**
 * Usage ledger types: one row per paid or metered call to an outside API.
 * Client-safe (types and constants only). CONTRACT for the usage-ledger and admin builders.
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
 * admin panel can label and sum them.
 * - anthropic: inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
 * - exa: searches, contents, results
 * - unipile: requests
 * - apify: runs, items
 * - apollo: credits
 * - hunter: lookups, credits (credits only when an email was found)
 * - openrouter: requests, xPosts, xProfiles, promptTokens, completionTokens
 * - huggingface, abstract, hubspot: requests
 */
export type UsageUnits = Record<string, number>;

/** reported: the provider returned the cost; estimated: price table x units; free: no charge; unknown. */
export type CostBasis = "reported" | "estimated" | "free" | "unknown";

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
  /** Usage not tied to a lead (tests, admin balance checks, HubSpot pushes without context). */
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

/** A live balance or quota read from the provider's own API, for the admin panel. */
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
