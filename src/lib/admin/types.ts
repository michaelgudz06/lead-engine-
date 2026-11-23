/**
 * Shapes and constants of the owner's usage panel (/admin and /api/admin/*). Client-safe:
 * types and constants only, so the panel's client components can import them.
 */
import type { DailySpend, LeadUsage, ProviderBalance, UsageRecord, UsageSummary, UsageWindow } from "../usage/types";

export const USAGE_WINDOWS = ["today", "7d", "30d", "all"] as const satisfies readonly UsageWindow[];

/** Labels for the window selector. */
export const WINDOW_LABELS: Record<UsageWindow, string> = {
  today: "Today",
  "7d": "7 days",
  "30d": "30 days",
  all: "All time",
};

/** The window inside a sentence: "Spent today", "Spent in the last 7 days". */
export const WINDOW_PHRASES: Record<UsageWindow, string> = {
  today: "today",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  all: "since the ledger began",
};

/** The window the panel opens on, and the one the API uses when none is given. */
export const DEFAULT_WINDOW: UsageWindow = "30d";

export function isUsageWindow(value: unknown): value is UsageWindow {
  return typeof value === "string" && (USAGE_WINDOWS as readonly string[]).includes(value);
}

/** Days in the daily spend chart, whatever the window. */
export const DAILY_DAYS = 30;

/** Ledger rows the recent-calls log reads (the newest ones in the window). Export CSV has them all. */
export const RECENT_LIMIT = 300;

/** Unipile's guidance for one connected LinkedIn account: about this many requests a day. */
export const LINKEDIN_DAILY_GUIDANCE = 100;

/** GET /api/admin/usage?window=today|7d|30d|all */
export interface AdminUsageResponse {
  window: UsageWindow;
  summary: UsageSummary;
  /** Per-lead breakdown in the window, newest activity first. */
  leads: LeadUsage[];
  /** The last DAILY_DAYS UTC days, oldest first, whatever the window. */
  daily: DailySpend[];
  /** The newest ledger rows inside the window (at most RECENT_LIMIT), newest first. */
  recent: UsageRecord[];
  /** True when the window may hold more rows than `recent` shows. */
  recentTruncated: boolean;
  /** Date of the price table behind estimated costs (src/lib/usage/prices.ts). */
  pricesAsOf: string;
  generatedAt: string;
}

/** GET /api/admin/balances[?refresh=1] */
export interface AdminBalancesResponse {
  /** One per provider, in USAGE_PROVIDERS order. */
  balances: ProviderBalance[];
  /** When the checks behind this answer ran. */
  checkedAt: string;
  /** True when the answer came from the in-memory cache instead of new checks. */
  cached: boolean;
}
