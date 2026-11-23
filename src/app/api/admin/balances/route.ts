import type { NextRequest } from "next/server";
import { getBalances } from "@/lib/admin/balances";
import type { AdminBalancesResponse } from "@/lib/admin/types";
import { json, serverError } from "../../_lib/api";
import { adminGuard, noindex } from "../_lib/guard";

/**
 * GET /api/admin/balances[?refresh=1] -> AdminBalancesResponse: each provider's live balance
 * or ledger-derived line. Cached in memory for 60 s; ?refresh=1 skips the cache once it is
 * 15 s old. A provider that cannot be read says so in its own entry. Owner's computer only.
 */
export async function GET(request: NextRequest) {
  const denied = adminGuard(request);
  if (denied) return denied;
  try {
    const { balances, checkedAt, cached } = await getBalances({ refresh: request.nextUrl.searchParams.get("refresh") === "1" });
    const body: AdminBalancesResponse = { balances, checkedAt, cached };
    return noindex(json(body));
  } catch (err) {
    // getBalances never throws; this is a safety net.
    return serverError("GET /api/admin/balances", err);
  }
}
