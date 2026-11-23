import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { adminDenial } from "@/lib/admin/access";
import { DEFAULT_WINDOW, isUsageWindow } from "@/lib/admin/types";
import type { UsageWindow } from "@/lib/usage/types";
import { fail } from "../../_lib/api";

/**
 * The admin API's own check, repeated in every handler although src/proxy.ts makes it first
 * (a matcher change or a path the proxy reads differently must not open the panel). The panel
 * only answers on the owner's computer (`npm run admin`, see src/lib/admin/access.ts);
 * anything else gets the same 404 JSON as the proxy gives, so nothing reveals it exists.
 */
export function adminGuard(request: NextRequest): NextResponse | null {
  if (adminDenial({ headers: request.headers, urlHostname: request.nextUrl.hostname, api: true }) === null) return null;
  return fail(404, "Not found.");
}

export function noindex(res: NextResponse): NextResponse {
  res.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return res;
}

/** ?window=today|7d|30d|all; missing means 30d; anything else is null (a 400). */
export function windowParam(request: NextRequest): UsageWindow | null {
  const raw = request.nextUrl.searchParams.get("window");
  if (raw === null || raw === "") return DEFAULT_WINDOW;
  return isUsageWindow(raw) ? raw : null;
}

export const WINDOW_ERROR = "window must be one of today, 7d, 30d or all.";
