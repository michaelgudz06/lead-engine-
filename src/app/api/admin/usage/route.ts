import type { NextRequest } from "next/server";
import { DAILY_DAYS, RECENT_LIMIT, type AdminUsageResponse } from "@/lib/admin/types";
import { PRICES_AS_OF } from "@/lib/usage/prices";
import { getDailySpend, getLeadUsage, getRecentUsage, getUsageSummary } from "@/lib/usage/queries";
import { fail, json, serverError } from "../../_lib/api";
import { adminGuard, noindex, WINDOW_ERROR, windowParam } from "../_lib/guard";

/**
 * GET /api/admin/usage?window=today|7d|30d|all (default 30d) -> AdminUsageResponse: the
 * window's summary and per-lead breakdown, the last 30 days of daily spend (whatever the
 * window), and the newest ledger rows inside the window. Owner's computer only (404 elsewhere).
 */
export async function GET(request: NextRequest) {
  const denied = adminGuard(request);
  if (denied) return denied;
  const window = windowParam(request);
  if (!window) return noindex(fail(400, WINDOW_ERROR));
  try {
    const [summary, leads, daily, latest] = await Promise.all([
      getUsageSummary(window),
      getLeadUsage(window, 200),
      getDailySpend(DAILY_DAYS),
      getRecentUsage(RECENT_LIMIT),
    ]);
    const from = summary.from;
    // ISO strings in UTC compare correctly as text.
    const recent = from ? latest.filter((r) => r.createdAt >= from) : latest;
    const body: AdminUsageResponse = {
      window,
      summary,
      leads,
      daily,
      recent,
      recentTruncated: latest.length === RECENT_LIMIT && recent.length === latest.length,
      pricesAsOf: PRICES_AS_OF,
      generatedAt: new Date().toISOString(),
    };
    return noindex(json(body));
  } catch (err) {
    return serverError("GET /api/admin/usage", err);
  }
}
