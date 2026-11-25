import "server-only";

export class HttpError extends Error {
  constructor(
    public status: number,
    public bodySnippet: string,
    public url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${bodySnippet.slice(0, 200)}`);
  }
}

export interface FetchJsonOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** Milliseconds before the request is aborted. Default 30s. */
  timeoutMs?: number;
  /** Retry once on 429/5xx/network errors. Default true. */
  retry?: boolean;
}

/**
 * fetch + JSON with a timeout and one retry. Never logs headers (they hold keys).
 * Throws HttpError on non-2xx so callers can branch on .status.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { method = "GET", headers = {}, body, timeoutMs = 30_000, retry = true } = opts;
  const attempt = async (): Promise<T> => {
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text, url);
    return (text ? JSON.parse(text) : null) as T;
  };
  try {
    return await attempt();
  } catch (err) {
    const retriable =
      retry &&
      (!(err instanceof HttpError) || err.status === 429 || err.status >= 500);
    if (!retriable) throw err;
    await new Promise((r) => setTimeout(r, 1200));
    return attempt();
  }
}

/** Run async work over items with at most `limit` in flight. Keeps input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Pure and client-safe, in their own module so the browser can use the same rules.
export { linkedinSlug, normaliseLinkedinUrl } from "./linkedin-url";
