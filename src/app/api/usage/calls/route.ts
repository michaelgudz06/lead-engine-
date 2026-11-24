import type { NextRequest } from "next/server";
import { listCalls } from "@/lib/usage/queries";
import { CALLS_LIMIT, type CallsResponse } from "@/lib/usage/view";
import { fail, json, serverError } from "../../_lib/api";
import { operationParam, providerParam, sortParam, windowParam } from "../_lib/params";

/**
 * GET /api/usage/calls?window=today|7d|30d|all&sort=newest|slowest|costliest&provider=&operation=
 * -> CallsResponse: at most CALLS_LIMIT ledger rows of the window in that order, each with its
 * duration and cost, and how many rows match. Defaults: 30d, newest, every provider and operation.
 */
export async function GET(request: NextRequest) {
  const window = windowParam(request);
  if (!window.ok) return fail(400, window.error);
  const sort = sortParam(request);
  if (!sort.ok) return fail(400, sort.error);
  const provider = providerParam(request);
  if (!provider.ok) return fail(400, provider.error);
  const operation = operationParam(request);
  if (!operation.ok) return fail(400, operation.error);
  try {
    const { calls, total } = await listCalls({
      window: window.value,
      sort: sort.value,
      provider: provider.value,
      operation: operation.value,
      limit: CALLS_LIMIT,
    });
    const body: CallsResponse = {
      window: window.value,
      sort: sort.value,
      provider: provider.value,
      operation: operation.value,
      calls,
      total,
      generatedAt: new Date().toISOString(),
    };
    return json(body);
  } catch (err) {
    return serverError("GET /api/usage/calls", err);
  }
}
