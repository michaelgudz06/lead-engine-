/**
 * Typed fetch helpers for the Usage tab's API (/api/usage/*). Client-safe: types only from
 * the server side. Errors are the app's ApiError; a 401 (the team gate is on and the session
 * ended) sends the page to the login, which brings the person back here afterwards.
 */
import { ApiError } from "@/lib/api-client";
import type { CallSort, UsageProvider, UsageWindow } from "@/lib/usage/types";
import type { BalancesResponse, CallsResponse, UsageResponse } from "@/lib/usage/view";

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
    throw new ApiError(timedOut ? "The request took too long. Please try again." : "Could not reach the server. Check your connection.", 0);
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
      isRecord(data) && typeof data.error === "string" && data.error
        ? data.error
        : res.status === 401
          ? "Your session has ended. Please log in again."
          : res.status >= 500
            ? "The server had a problem. Please try again."
            : `Request failed (${res.status}).`;
    throw new ApiError(message, res.status);
  }
  if (data === null) throw new ApiError("The server sent an empty or unreadable reply.", res.status);
  return data as T;
}

const enc = encodeURIComponent;

export function getUsage(window: UsageWindow): Promise<UsageResponse> {
  return request<UsageResponse>(`/api/usage?window=${enc(window)}`);
}

export interface CallFilter {
  sort: CallSort;
  provider: UsageProvider | null;
  operation: string | null;
}

export function getCalls(window: UsageWindow, filter: CallFilter): Promise<CallsResponse> {
  const qs = new URLSearchParams({ window, sort: filter.sort });
  if (filter.provider) qs.set("provider", filter.provider);
  if (filter.operation) qs.set("operation", filter.operation);
  return request<CallsResponse>(`/api/usage/calls?${qs}`);
}

/** `refresh` asks the providers again; the server only does so once its last checks are 30 s old. */
export function getBalances(refresh = false): Promise<BalancesResponse> {
  return request<BalancesResponse>(`/api/usage/balances${refresh ? "?refresh=1" : ""}`);
}

export function exportUrl(window: UsageWindow): string {
  return `/api/usage/export?window=${enc(window)}`;
}
