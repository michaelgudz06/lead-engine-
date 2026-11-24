import type { NextRequest } from "next/server";
import { PRICES_AS_OF } from "@/lib/usage/prices";
import { getDailySpend, getLeadUsage, getOperationStats, getUsageSummary, listRuns } from "@/lib/usage/queries";
import { DAILY_DAYS, LEADS_LIMIT, RUNS_LIMIT, type UsageResponse } from "@/lib/usage/view";
import { fail, json, serverError } from "../_lib/api";
import { windowParam } from "./_lib/params";

/**
 * GET /api/usage?window=today|7d|30d|all (default 30d) -> UsageResponse: the window's
 * summary, cost per lead, time and cost per provider and operation, and its newest research
 * runs, plus the last 30 days of daily spend (whatever the window). Database reads only:
 * no provider is called. The call list is GET /api/usage/calls, balances GET /api/usage/balances.
 */
export async function GET(request: NextRequest) {
  const window = windowParam(request);
  if (!window.ok) return fail(400, window.error);
  try {
    const [summary, leads, daily, operations, runs] = await Promise.all([
      getUsageSummary(window.value),
      getLeadUsage(window.value, LEADS_LIMIT),
      getDailySpend(DAILY_DAYS),
      getOperationStats(window.value),
      listRuns(window.value, RUNS_LIMIT),
    ]);
    const body: UsageResponse = {
      window: window.value,
      summary,
      leads,
      daily,
      operations,
      runs: runs.runs,
      runsTotal: runs.total,
      pricesAsOf: PRICES_AS_OF,
      generatedAt: new Date().toISOString(),
    };
    return json(body);
  } catch (err) {
    return serverError("GET /api/usage", err);
  }
}
