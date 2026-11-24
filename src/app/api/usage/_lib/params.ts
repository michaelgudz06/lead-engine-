import "server-only";
import type { NextRequest } from "next/server";
import { DEFAULT_CALL_SORT, DEFAULT_WINDOW, isCallSort, isUsageWindow } from "@/lib/usage/view";
import { USAGE_PROVIDERS, type CallSort, type UsageProvider, type UsageWindow } from "@/lib/usage/types";

/**
 * Query parameters shared by the /api/usage routes. A missing value takes its default; a
 * value that is there but not allowed is an error the route answers with 400.
 */

export type Param<T> = { ok: true; value: T } | { ok: false; error: string };

function raw(request: NextRequest, name: string): string | null {
  const value = request.nextUrl.searchParams.get(name);
  return value === null || value === "" ? null : value;
}

/** ?window=today|7d|30d|all, default 30d. */
export function windowParam(request: NextRequest): Param<UsageWindow> {
  const value = raw(request, "window");
  if (value === null) return { ok: true, value: DEFAULT_WINDOW };
  return isUsageWindow(value) ? { ok: true, value } : { ok: false, error: "window must be one of today, 7d, 30d or all." };
}

/** ?sort=newest|slowest|costliest, default newest. */
export function sortParam(request: NextRequest): Param<CallSort> {
  const value = raw(request, "sort");
  if (value === null) return { ok: true, value: DEFAULT_CALL_SORT };
  return isCallSort(value) ? { ok: true, value } : { ok: false, error: "sort must be one of newest, slowest or costliest." };
}

/** ?provider=, one of the ledger's providers; none means all. */
export function providerParam(request: NextRequest): Param<UsageProvider | null> {
  const value = raw(request, "provider");
  if (value === null) return { ok: true, value: null };
  return (USAGE_PROVIDERS as readonly string[]).includes(value)
    ? { ok: true, value: value as UsageProvider }
    : { ok: false, error: `provider must be one of ${USAGE_PROVIDERS.join(", ")}.` };
}

/** ?operation=, as the ledger writes it (at most 80 characters); none means all. */
export function operationParam(request: NextRequest): Param<string | null> {
  const value = raw(request, "operation");
  if (value === null) return { ok: true, value: null };
  return value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value)
    ? { ok: true, value }
    : { ok: false, error: "operation must be an operation name of at most 80 characters." };
}
