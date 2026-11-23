import "server-only";
import type { DailySpend, LeadUsage, UsageRecord, UsageSummary, UsageWindow } from "./types";

/**
 * Read side of the usage ledger, for the admin panel.
 * CONTRACT: signatures fixed; bodies owned by the usage-ledger builder.
 */

export async function getUsageSummary(window: UsageWindow): Promise<UsageSummary> {
  void window;
  throw new Error("not implemented");
}

/** Per-lead breakdown in the window, newest activity first. */
export async function getLeadUsage(window: UsageWindow, limit = 200): Promise<LeadUsage[]> {
  void window;
  void limit;
  throw new Error("not implemented");
}

/** The most recent ledger rows, newest first. */
export async function getRecentUsage(limit = 100): Promise<UsageRecord[]> {
  void limit;
  throw new Error("not implemented");
}

/** One row per UTC day for the last `days` days (zero-filled), oldest first. */
export async function getDailySpend(days = 30): Promise<DailySpend[]> {
  void days;
  throw new Error("not implemented");
}
