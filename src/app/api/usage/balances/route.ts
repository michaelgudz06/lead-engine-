import type { NextRequest } from "next/server";
import { getBalances } from "@/lib/usage/balances";
import type { BalancesResponse } from "@/lib/usage/view";
import { json, serverError } from "../../_lib/api";

/**
 * GET /api/usage/balances[?refresh=1] -> BalancesResponse: each provider's live balance or
 * ledger-derived line. The server keeps the answer for 60 s; ?refresh=1 asks the providers
 * again only once the last checks are 30 s old (refreshableAt says when), so reloading the
 * tab cannot flood the provider APIs. A provider that cannot be read says so in its own entry.
 */
export async function GET(request: NextRequest) {
  try {
    const body: BalancesResponse = await getBalances({ refresh: request.nextUrl.searchParams.get("refresh") === "1" });
    return json(body);
  } catch (err) {
    // getBalances never throws; this is a safety net.
    return serverError("GET /api/usage/balances", err);
  }
}
