/**
 * What the Usage tab (/usage) shows: its time windows, sorts and limits, and the shapes the
 * /api/usage routes answer with. Client-safe: types and constants only, so the tab's client
 * components can import them.
 */
import type {
  CallSort,
  DailySpend,
  LeadUsage,
  OperationStats,
  ProviderBalance,
  RunUsage,
  UsageProvider,
  UsageRecord,
  UsageSummary,
  UsageWindow,
} from "./types";

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

/** The window the tab opens on, and the one the API uses when none is given. */
export const DEFAULT_WINDOW: UsageWindow = "30d";

export function isUsageWindow(value: unknown): value is UsageWindow {
  return typeof value === "string" && (USAGE_WINDOWS as readonly string[]).includes(value);
}

/** Days in the daily spend chart, whatever the window. */
export const DAILY_DAYS = 30;

/** Leads in the cost-per-lead table at most (the ones with the newest activity in the window). */
export const LEADS_LIMIT = 200;

/** Ledger rows the call list shows at most, in the chosen order. Export CSV has them all. */
export const CALLS_LIMIT = 300;

/** Research and steer runs the tab lists at most (the newest in the window). */
export const RUNS_LIMIT = 50;

/** How long the server serves a round of balance checks from memory (src/lib/usage/balances.ts). */
export const BALANCE_CACHE_MS = 60_000;

/** A forced balance refresh (?refresh=1) makes new checks only when the last ones are this old. */
export const BALANCE_MIN_REFRESH_MS = 30_000;

export const CALL_SORTS = ["newest", "slowest", "costliest"] as const satisfies readonly CallSort[];

export const CALL_SORT_LABELS: Record<CallSort, string> = {
  newest: "Newest",
  slowest: "Slowest",
  costliest: "Most expensive",
};

export const DEFAULT_CALL_SORT: CallSort = "newest";

export function isCallSort(value: unknown): value is CallSort {
  return typeof value === "string" && (CALL_SORTS as readonly string[]).includes(value);
}

/** GET /api/usage?window=today|7d|30d|all */
export interface UsageResponse {
  window: UsageWindow;
  summary: UsageSummary;
  /** Per-lead breakdown in the window, newest activity first. */
  leads: LeadUsage[];
  /** The last DAILY_DAYS UTC days, oldest first, whatever the window. */
  daily: DailySpend[];
  /** Each provider and operation with calls in the window. Rows filled in from before the ledger began are left out. */
  operations: OperationStats[];
  /** The newest runs in the window (at most RUNS_LIMIT), newest first. Runs of deleted leads are left out. */
  runs: RunUsage[];
  /** How many runs the window holds (runs of deleted leads left out); more than runs.length when the list is cut. */
  runsTotal: number;
  /** Date of the price table behind estimated costs (src/lib/usage/prices.ts). */
  pricesAsOf: string;
  generatedAt: string;
}

/** GET /api/usage/calls?window=&sort=newest|slowest|costliest&provider=&operation= */
export interface CallsResponse {
  window: UsageWindow;
  sort: CallSort;
  provider: UsageProvider | null;
  operation: string | null;
  /** At most CALLS_LIMIT ledger rows in the window, in `sort` order. */
  calls: UsageRecord[];
  /** Rows in the window that match the provider and operation. */
  total: number;
  generatedAt: string;
}

/** GET /api/usage/balances[?refresh=1] */
export interface BalancesResponse {
  /** One per provider, in USAGE_PROVIDERS order. */
  balances: ProviderBalance[];
  /** When the checks behind this answer ran. */
  checkedAt: string;
  /** True when the answer came from the server's cache instead of new checks. */
  cached: boolean;
  /** Until this time a forced refresh answers from the cache too. */
  refreshableAt: string;
}
