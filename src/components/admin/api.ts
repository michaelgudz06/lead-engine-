/**
 * Typed fetch helpers for the usage panel's API. Client-safe: types only from the server side.
 *
 * The panel has no login of its own. A 401 comes from the team gate (APP_PASSWORD set and the
 * session ended), so the page goes to the team login and comes back here afterwards. A 404
 * means this server will not show the panel to this request (not the owner's computer).
 */
import type { AdminBalancesResponse, AdminUsageResponse } from "@/lib/admin/types";
import type { UsageWindow } from "@/lib/usage/types";

export class AdminApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

const TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    throw new AdminApiError(timedOut ? "The request took too long. Please try again." : "Could not reach the server. Is it still running?", 0);
  } finally {
    clearTimeout(timer);
  }

  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      // A full page load on purpose: the team login sets a fresh session, then brings us back.
      const next = window.location.pathname + window.location.search;
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    }
    const message =
      res.status === 404
        ? "This panel only opens on the computer that runs the app (npm run admin)."
        : isRecord(data) && typeof data.error === "string" && data.error
          ? data.error
          : res.status >= 500
            ? "The server had a problem. Please try again."
            : `Request failed (${res.status}).`;
    throw new AdminApiError(message, res.status);
  }
  if (data === null) throw new AdminApiError("The server sent an empty or unreadable reply.", res.status);
  return data as T;
}

export function getAdminUsage(window: UsageWindow): Promise<AdminUsageResponse> {
  return request<AdminUsageResponse>(`/api/admin/usage?window=${encodeURIComponent(window)}`);
}

export function getAdminBalances(refresh = false): Promise<AdminBalancesResponse> {
  return request<AdminBalancesResponse>(`/api/admin/balances${refresh ? "?refresh=1" : ""}`);
}

export function exportUrl(window: UsageWindow): string {
  return `/api/admin/export?window=${encodeURIComponent(window)}`;
}
