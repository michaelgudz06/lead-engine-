/**
 * Tests for the Usage tab (/usage and /api/usage/*), which replaced the owner's local-only panel.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-usage-tab.ts
 *   ... scripts/test-usage-tab.ts --live     also reads every live balance once (one free call per provider)
 *
 * 1. proxy     /usage and /api/usage/* follow the app's rules and nothing else: open with the gate off,
 *              from any host; the login redirect or 401 with the gate on; cross-site writes refused;
 *              the Vercel lock and ALLOW_OPEN_ACCESS; the /ingest exemption; /admin is gone
 * 2. routes    every handler answers 200 (database reads only; balances run with fetch mocked), 400 on
 *              bad parameters, the call list's orders, the CSV download
 * 3. queries   time and cost per request, research runs and the sorted call list against Neon, on
 *              temporary rows that are deleted at the end. The temporary runs sit two days back, outside
 *              the live app's run caps, and are read with listRuns(..., now) set to that time.
 * 4. balances  parsers, never throwing, no key in any URL or output, the 60 s cache and at most one
 *              forced refresh every 30 s (clock and fetch mocked: no provider is called)
 * 5. export    the spreadsheet formula guard, on its own and through the route
 * 6. format    money, counts, durations and units; chart scales; the nav; the npm scripts
 * 7. warm paths the twitterapi.io card and the Unipile card's two accounts; twitterapi.io folded into
 *              "Other" on the chart; warm-path rows in the per-request tables, a run's cost and the
 *              per-lead table (temporary rows, deleted at the end)
 *
 * Prints statuses only: never a key, token, cookie value, DSN or header.
 */
// First, as in Next's own server: installs globalThis.AsyncLocalStorage for next/server's request scope.
import "next/dist/server/node-environment-baseline";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { proxy, config as proxyConfig } from "../src/proxy";
import { createSessionToken, SESSION_COOKIE } from "../src/lib/auth";
import * as usageRoute from "../src/app/api/usage/route";
import * as callsRoute from "../src/app/api/usage/calls/route";
import * as balancesRoute from "../src/app/api/usage/balances/route";
import * as exportRoute from "../src/app/api/usage/export/route";
import { STALE_RUN_MS } from "../src/app/api/_lib/api";
import { durationScale, usdScale } from "../src/components/usage/chart-kit";
import { otherLabels, SERIES, seriesOf, SHORT_LABELS } from "../src/components/usage/series";
import { ownAccountCalls, unipileSplit } from "../src/components/usage/unipile";
import { query } from "../src/lib/db";
import { HttpError } from "../src/lib/http";
import {
  apifyBalanceFrom,
  apolloBalanceFrom,
  describeFailure,
  getBalances,
  hunterBalanceFrom,
  openrouterBalanceFrom,
  resetBalanceCache,
  twitterapiBalanceFrom,
  unipileBalanceFrom,
  unipileRoutes,
} from "../src/lib/usage/balances";
import { CSV_COLUMNS, csvCell, unitsCell } from "../src/lib/usage/export";
import { compactCount, formatCount, formatMs, formatShare, formatUsd, keyUnitsLine, mainUnit, plural, unitsLine } from "../src/lib/usage/format";
import { PRICES_AS_OF } from "../src/lib/usage/prices";
import { DELETED_LEAD_NAME, getOperationStats, listCalls, listRuns, RUN_END_GRACE_MS, RUN_MAX_MS, windowStart } from "../src/lib/usage/queries";
import { BACKFILL_OPERATION, USAGE_PROVIDER_LABELS, USAGE_PROVIDERS, type ProviderBalance, type UsageRecord } from "../src/lib/usage/types";
import {
  BALANCE_CACHE_MS,
  BALANCE_MIN_REFRESH_MS,
  CALLS_LIMIT,
  DAILY_DAYS,
  LEADS_LIMIT,
  RUNS_LIMIT,
  type BalancesResponse,
  type CallsResponse,
  type UsageResponse,
} from "../src/lib/usage/view";

// ------------------------------------------------------------------ compile-time checks
type Handler = (request: NextRequest) => Promise<Response>;
void (usageRoute.GET satisfies Handler);
void (callsRoute.GET satisfies Handler);
void (balancesRoute.GET satisfies Handler);
void (exportRoute.GET satisfies Handler);

// ------------------------------------------------------------------ tiny harness

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  const extra = !ok && detail !== undefined ? ` -- ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 300)}` : "";
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

const ENV_KEYS = ["APP_PASSWORD", "SESSION_SECRET", "VERCEL", "ALLOW_OPEN_ACCESS", "UNIPILE_ACCOUNT_ID", "NODE_ENV"] as const;
type EnvName = (typeof ENV_KEYS)[number];
const env = process.env as Record<string, string | undefined>;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]])) as Record<EnvName, string | undefined>;
function setEnv(vars: Partial<Record<EnvName, string | undefined>>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}
function restoreEnv(): void {
  setEnv(originalEnv);
}

// Generated here, never printed.
const TEAM_PW = `team-${randomBytes(12).toString("hex")}`;
const SECRET = randomBytes(32).toString("hex");

/** A local run with the gate off: not on Vercel, not a production build. */
function local(extra: Partial<Record<EnvName, string | undefined>> = {}): void {
  setEnv({ APP_PASSWORD: undefined, SESSION_SECRET: SECRET, VERCEL: undefined, ALLOW_OPEN_ACCESS: undefined, NODE_ENV: undefined, ...extra });
}

// ------------------------------------------------------------------ request helpers

const LOCAL = "http://localhost:3000";
const PUBLIC = "https://leads.example.com";

interface SendOpts {
  method?: string;
  /** The URL's origin; defaults to http://localhost:3000. */
  base?: string;
  headers?: Record<string, string>;
  session?: string;
}

function request(path: string, opts: SendOpts = {}): NextRequest {
  const base = opts.base ?? LOCAL;
  const headers: Record<string, string> = { host: new URL(base).host, ...opts.headers };
  if (opts.session) headers.cookie = `${SESSION_COOKIE}=${opts.session}`;
  return new NextRequest(new URL(`${base}${path}`), { method: opts.method ?? "GET", headers });
}

const send = (path: string, opts: SendOpts = {}) => proxy(request(path, opts));
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
const redirectsTo = (res: Response) => (res.status === 307 || res.status === 308 ? res.headers.get("location") : null);
async function errorOf(res: Response): Promise<string> {
  try {
    return String(((await res.clone().json()) as { error?: unknown }).error ?? "");
  } catch {
    return "";
  }
}
async function jsonOf<T>(res: Response): Promise<T | null> {
  try {
    return (await res.clone().json()) as T;
  } catch {
    return null;
  }
}
const refused = async (res: Response) => res.status === 403 && /Cross-site/.test(await errorOf(res)) && res.headers.get("cache-control") === "no-store";
const CROSS_SITE = { "sec-fetch-site": "cross-site" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", origin: LOCAL };

const USAGE_PAGES = ["/usage", "/usage?window=7d"];
const USAGE_API = ["/api/usage?window=all", "/api/usage/calls?window=7d&sort=slowest", "/api/usage/balances?refresh=1", "/api/usage/export?window=30d"];

// ------------------------------------------------------------------ 1. proxy

async function testProxy(): Promise<void> {
  section("1. proxy: the Usage tab follows the app's rules and nothing else");
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config: proxyConfig, url });
  for (const url of ["/usage", "/usage?window=today", "/api/usage", "/api/usage/calls", "/api/usage/balances", "/api/usage/export"]) {
    check(`matcher runs on ${url}`, matches(url));
  }

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    // --- gate off (local): open, from any host. There is no local-only rule any more.
    local();
    for (const [label, opts] of [
      ["localhost", {}],
      ["a LAN address", { base: "http://192.168.1.20:3000" }],
      ["a public host name", { base: PUBLIC }],
      ["a request through a tunnel", { headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "abc.tunnel.example" } }],
    ] as const) {
      for (const path of [...USAGE_PAGES, ...USAGE_API]) check(`gate off, ${label}: GET ${path} passes`, passes(await send(path, opts)));
    }
    const plain = await send("/usage");
    check(
      "gate off: /usage gets no special headers from the proxy (the app's own headers come from next.config.ts)",
      passes(plain) && plain.headers.get("x-robots-tag") === null && plain.headers.get("x-middleware-rewrite") === null,
    );
    check("gate off: a cross-site GET of /api/usage passes (reads stay open to links)", passes(await send("/api/usage", { headers: CROSS_SITE })));
    check("gate off: a same-origin GET of /api/usage/balances?refresh=1 passes", passes(await send("/api/usage/balances?refresh=1", { headers: SAME_ORIGIN })));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      check(`gate off: cross-site ${method} /api/usage/balances is 403`, await refused(await send("/api/usage/balances", { method, headers: CROSS_SITE })));
    }
    check("gate off: a foreign Origin POST to /api/usage is 403", await refused(await send("/api/usage", { method: "POST", headers: { origin: "https://evil.example" } })));

    // --- /admin is gone: an ordinary unknown path now (no route, so Next answers 404)
    for (const path of ["/admin", "/api/admin/usage"]) {
      const res = await send(path, { base: PUBLIC });
      check(`gate off: ${path} gets no special treatment from the proxy`, passes(res) && res.headers.get("x-middleware-rewrite") === null);
    }
    const leftovers = ["src/app/admin", "src/app/api/admin", "src/lib/admin", "src/components/admin", "scripts/test-admin.ts"].filter((p) => existsSync(join(process.cwd(), p)));
    check("the admin page, its API, its gate and its old test are gone", leftovers.length === 0, leftovers);
    const proxySource = readFileSync(join(process.cwd(), "src/proxy.ts"), "utf8");
    check("src/proxy.ts has no admin rule left", !/admin/i.test(proxySource));

    // --- gate on
    local({ APP_PASSWORD: TEAM_PW });
    check("gate on, no session: /usage redirects to /login?next=%2Fusage", redirectsTo(await send("/usage")) === `${LOCAL}/login?next=%2Fusage`);
    check(
      "gate on, no session: /usage?window=7d keeps the window in next=",
      redirectsTo(await send("/usage?window=7d")) === `${LOCAL}/login?next=${encodeURIComponent("/usage?window=7d")}`,
    );
    for (const path of USAGE_API) {
      const res = await send(path);
      check(`gate on, no session: ${path} is the 401 JSON`, res.status === 401 && /Log in/.test(await errorOf(res)) && res.headers.get("cache-control") === "no-store", {
        status: res.status,
      });
    }
    const team = await createSessionToken();
    for (const path of [...USAGE_PAGES, ...USAGE_API]) check(`gate on, team session: ${path} passes`, passes(await send(path, { session: team })));
    check("gate on, team session from a public host: /api/usage passes", passes(await send("/api/usage", { base: PUBLIC, session: team })));
    check("gate on: /login?next=/usage with a session goes to /usage", redirectsTo(await send("/login?next=%2Fusage", { session: team })) === `${LOCAL}/usage`);
    check("gate on: a tampered session gets the 401 on /api/usage/balances", (await send("/api/usage/balances", { session: `${team.slice(0, -2)}AA` })).status === 401);
    check("gate on, team session: a cross-site POST to /api/usage is still 403", await refused(await send("/api/usage", { method: "POST", headers: CROSS_SITE, session: team })));

    // --- the Vercel lock, and the owner's opt-in to an open deploy
    for (const value of [undefined, "", "0", "true", "REPLACE_ME"]) {
      local({ VERCEL: "1", ALLOW_OPEN_ACCESS: value });
      for (const path of ["/usage", "/api/usage", "/api/usage/balances"]) {
        const res = await send(path, { base: PUBLIC });
        check(`Vercel, no APP_PASSWORD, ALLOW_OPEN_ACCESS=${JSON.stringify(value ?? null)}: ${path} is 503`, res.status === 503 && /APP_PASSWORD/.test(await errorOf(res)), {
          status: res.status,
        });
      }
    }
    for (const value of ["1", " 1 "]) {
      local({ VERCEL: "1", ALLOW_OPEN_ACCESS: value });
      const tag = `Vercel with ALLOW_OPEN_ACCESS=${JSON.stringify(value)}`;
      for (const path of [...USAGE_PAGES, ...USAGE_API]) check(`${tag}: ${path} passes`, passes(await send(path, { base: PUBLIC })));
      check(`${tag}: a cross-site POST is still 403`, await refused(await send("/api/usage", { method: "POST", base: PUBLIC, headers: CROSS_SITE })));
    }
    const open = warnings.filter((w) => w.includes("[proxy]"));
    check("open deploy: the warning is logged once per instance, naming ALLOW_OPEN_ACCESS", open.length === 1 && /ALLOW_OPEN_ACCESS=1/.test(open[0] ?? ""), open);
    local({ APP_PASSWORD: TEAM_PW, VERCEL: "1" });
    check("gated Vercel deploy, no session: /usage goes to the login", redirectsTo(await send("/usage", { base: PUBLIC })) === `${PUBLIC}/login?next=%2Fusage`);
    check("gated Vercel deploy, no session: /api/usage/export is 401", (await send("/api/usage/export", { base: PUBLIC })).status === 401);

    // --- the /ingest exemption (PostHog's reverse proxy), unchanged
    for (const [label, vars] of [
      ["gate on, no session", { APP_PASSWORD: TEAM_PW }],
      ["Vercel lock (no APP_PASSWORD, no opt-in)", { VERCEL: "1" }],
    ] as const) {
      local(vars);
      for (const path of ["/ingest", "/ingest/e/", "/ingest/static/array.js"]) check(`${label}: GET ${path} passes`, passes(await send(path, { base: PUBLIC })));
      check(`${label}: a cross-site POST /ingest/e/ is still 403`, await refused(await send("/ingest/e/", { method: "POST", base: PUBLIC, headers: CROSS_SITE })));
      const ingest = await send("/ingest/e/", { method: "POST", base: PUBLIC, session: "v1.0.not-a-real-session", headers: { "sec-fetch-site": "same-origin", "user-agent": "usage-tab-test" } });
      const forwarded = (ingest.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
      check(
        `${label}: /ingest is forwarded without the Cookie header`,
        passes(ingest) && forwarded.length > 0 && !forwarded.includes("cookie") && ingest.headers.get("x-middleware-request-cookie") === null,
        forwarded,
      );
      for (const path of ["/ingestion", "/api/ingest", "/ingest%2f..%2fapi%2fusage", "/ingest/%2e%2e/api/usage"]) {
        check(`${label}: ${path} is not exempt`, !passes(await send(path, { base: PUBLIC })));
      }
    }
  } finally {
    console.warn = realWarn;
    restoreEnv();
  }
}

// ------------------------------------------------------------------ 2. routes

const realFetch = globalThis.fetch;

async function testRoutes(): Promise<void> {
  section("2. route handlers (Neon reads; no provider is called)");
  local();

  // The handlers have no gate of their own (the proxy is the gate): any host gets an answer.
  let fetches = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!/neon/i.test(url)) fetches++;
    return realFetch(...args);
  }) as typeof fetch;
  try {
    for (const window of ["today", "7d", "30d", "all"] as const) {
      const res = await usageRoute.GET(request(`/api/usage?window=${window}`, { base: PUBLIC, headers: { "x-forwarded-for": "203.0.113.9" } }));
      const body = await jsonOf<UsageResponse>(res);
      const from = windowStart(window)?.toISOString() ?? null;
      check(
        `GET /api/usage?window=${window}: 200 with the summary, ${DAILY_DAYS} days, per lead, per request and runs`,
        res.status === 200 &&
          body?.window === window &&
          body.summary.window === window &&
          body.summary.from === from &&
          Array.isArray(body.leads) &&
          body.leads.length <= LEADS_LIMIT &&
          body.daily.length === DAILY_DAYS &&
          Array.isArray(body.operations) &&
          body.operations.every((o) => o.operation !== BACKFILL_OPERATION && USAGE_PROVIDERS.includes(o.provider)) &&
          Array.isArray(body.runs) &&
          body.runs.length <= RUNS_LIMIT &&
          body.runsTotal >= body.runs.length &&
          body.runs.every((r, i, list) => i === 0 || list[i - 1].startedAt >= r.startedAt) &&
          body.runs.every((r) => !from || r.startedAt >= from) &&
          body.pricesAsOf === PRICES_AS_OF &&
          res.headers.get("cache-control") === "no-store",
        { status: res.status, window: body?.window },
      );
    }
    check("GET /api/usage: no window means 30d", (await jsonOf<UsageResponse>(await usageRoute.GET(request("/api/usage"))))?.window === "30d");
    const badWindow = await usageRoute.GET(request("/api/usage?window=year"));
    check("GET /api/usage?window=year is 400 with a reason", badWindow.status === 400 && /window must be/.test(await errorOf(badWindow)));
    check("the usage summary called no provider", fetches === 0, fetches);

    // calls: each order, the filters, the limits
    for (const sort of ["newest", "slowest", "costliest"] as const) {
      const res = await callsRoute.GET(request(`/api/usage/calls?window=all&sort=${sort}`));
      const body = await jsonOf<CallsResponse>(res);
      const calls = body?.calls ?? [];
      check(
        `GET /api/usage/calls?sort=${sort}: 200, at most ${CALLS_LIMIT} rows, in ${sort} order`,
        res.status === 200 && body?.sort === sort && calls.length <= CALLS_LIMIT && body.total >= calls.length && inOrder(calls, sort),
        { status: res.status, n: calls.length },
      );
    }
    const defaults = await jsonOf<CallsResponse>(await callsRoute.GET(request("/api/usage/calls")));
    check("GET /api/usage/calls: defaults are 30d, newest, every provider", defaults?.window === "30d" && defaults.sort === "newest" && defaults.provider === null && defaults.operation === null);
    const anthropic = await jsonOf<CallsResponse>(await callsRoute.GET(request("/api/usage/calls?window=all&sort=slowest&provider=anthropic")));
    check("GET /api/usage/calls?provider=anthropic: only Anthropic rows", anthropic !== null && anthropic.provider === "anthropic" && anthropic.calls.every((c) => c.provider === "anthropic"));
    for (const [qs, why] of [
      ["sort=priciest", /sort must be/],
      ["provider=openai", /provider must be/],
      ["operation=" + "x".repeat(81), /operation must be/],
      ["operation=a%0Ab", /operation must be/],
      ["window=1y", /window must be/],
    ] as const) {
      const res = await callsRoute.GET(request(`/api/usage/calls?${qs}`));
      check(`GET /api/usage/calls?${qs.slice(0, 24)}: 400`, res.status === 400 && why.test(await errorOf(res)), { status: res.status });
    }

    // export
    const csvRes = await exportRoute.GET(request("/api/usage/export?window=all", { base: PUBLIC }));
    // Response.text() drops a leading byte order mark, so look at the bytes.
    const bytes = new Uint8Array(await csvRes.arrayBuffer());
    const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const rows = parseCsv(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/^﻿/, ""));
    check("export: 200 text/csv download, no-store, nosniff", csvRes.status === 200 && /^text\/csv/.test(csvRes.headers.get("content-type") ?? "") && csvRes.headers.get("cache-control") === "no-store" && csvRes.headers.get("x-content-type-options") === "nosniff");
    check("export: named lead-engine-usage-all-<day>.csv", /^attachment; filename="lead-engine-usage-all-\d{4}-\d{2}-\d{2}\.csv"$/.test(csvRes.headers.get("content-disposition") ?? ""));
    check("export: a UTF-8 BOM, the header row, one line per row", hasBom && rows[0]?.join(",") === CSV_COLUMNS.join(",") && Number(csvRes.headers.get("x-row-count")) === rows.length - 1);
    check("export: no cell starts like a formula", rows.every((r) => r.every((cell) => !/^[=+\-@\t\r]/.test(cell))), rows.find((r) => r.some((c) => /^[=+\-@\t\r]/.test(c)))?.slice(0, 3));
    const badExport = await exportRoute.GET(request("/api/usage/export?window=forever"));
    check("export: a bad window is 400", badExport.status === 400);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The call list's order: id for newest, duration (nulls last) for slowest, cost (nulls and backfill rows last) for costliest. */
function inOrder(calls: UsageRecord[], sort: "newest" | "slowest" | "costliest"): boolean {
  return calls.every((c, i) => {
    if (i === 0) return true;
    const p = calls[i - 1];
    if (sort === "newest") return p.id > c.id;
    if (sort === "slowest") return c.ms === null || (p.ms !== null && p.ms >= c.ms);
    const pb = p.operation === BACKFILL_OPERATION;
    const cb = c.operation === BACKFILL_OPERATION;
    if (pb !== cb) return !pb;
    return c.costUsd === null || (p.costUsd !== null && p.costUsd >= c.costUsd);
  });
}

/** RFC 4180 CSV: quoted cells, doubled quotes, CRLF line ends. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

// ------------------------------------------------------------------ 3. queries (temporary rows)

const MIN = 60_000;

/** Interpolated percentile, as Postgres percentile_cont computes it. */
function percentileCont(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  const at = (s.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}

async function testQueries(): Promise<void> {
  section("3. queries against Neon (temporary rows, deleted at the end)");
  const run = `usagetab-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const op = (name: string) => `${run}:${name}`;
  const leadName = `Usage Tab Test ${run}`;
  // Two days back: inside the 7d and 30d windows, outside the live app's 24-hour run caps.
  const T = Date.now() - 2 * 86_400_000;
  const at = (ms: number) => new Date(T + ms).toISOString();
  const usageIds: string[] = [];
  const runIds: string[] = [];
  let leadId: string | null = null;
  const ghostLead = randomUUID();

  const addUsage = async (row: {
    provider: string;
    operation: string;
    cost: number | null;
    basis?: string;
    ok?: boolean;
    ms: number | null;
    at: number;
    lead?: string | null;
    leadName?: string | null;
  }) => {
    const [r] = await query<{ id: string }>(
      `insert into le_usage (lead_id, lead_name, provider, operation, units, cost_usd, cost_basis, ok, ms, created_at)
       values ($1::uuid, $2, $3, $4, '{"requests": 1}'::jsonb, $5::numeric, $6, $7, $8::integer, $9::timestamptz)
       returning id`,
      [
        row.lead === undefined ? leadId : row.lead,
        row.leadName === undefined ? leadName : row.leadName,
        row.provider,
        row.operation,
        row.cost,
        row.basis ?? (row.cost === null ? "unknown" : "reported"),
        row.ok !== false,
        row.ms,
        at(row.at),
      ],
    );
    usageIds.push(r.id);
    return r.id;
  };
  const addRun = async (lead: string, kind: "research" | "steer", ms: number) => {
    const [r] = await query<{ id: string }>("insert into le_run_starts (lead_id, kind, created_at) values ($1::uuid, $2, $3::timestamptz) returning id", [lead, kind, at(ms)]);
    runIds.push(r.id);
    return Number(r.id);
  };
  const addEvent = (type: string, message: string, ms: number) =>
    query("insert into le_events (lead_id, type, message, created_at) values ($1::uuid, $2, $3, $4::timestamptz)", [leadId, type, message, at(ms)]);

  try {
    const [lead] = await query<{ id: string }>(
      `insert into le_leads (linkedin_url, linkedin_slug, name, company_name) values ($1, $2, $3, $4) returning id`,
      [`https://www.linkedin.com/in/${run}`, run, leadName, "+SUM(1,2) Usage Tab Test Co"],
    );
    leadId = lead.id;
    const id = lead.id;

    // --- four runs of the lead, and one of a lead that no longer exists
    const runA = await addRun(id, "research", 0);
    await addRun(ghostLead, "research", 5 * MIN);
    const runB = await addRun(id, "steer", 10 * MIN);
    const runC = await addRun(id, "research", 20 * MIN);
    const runD = await addRun(id, "research", 40 * MIN);

    // A: an error noted mid-run, then done after 60 s.
    await addEvent("step", "Starting research", 1_000);
    await addEvent("error", "Could not save findings (test)", 20_000);
    await addEvent("done", "Research done in 60s: test", 60_000);
    // B: failed after 30 s.
    await addEvent("error", "Research stopped after 30s: test failure", 10 * MIN + 30_000);
    // C: no end; the stale-run mark comes 7 minutes in, later than any run can take.
    await addEvent("error", "Research stopped before it finished (server time limit or restart). Run it again.", 27 * MIN);
    // D: no end yet; "now" is 3 minutes after its start.
    const fakeNow = new Date(T + 43 * MIN);

    const runOp = op("run");
    await addUsage({ provider: "exa", operation: runOp, cost: 0.001, ms: 100, at: 5_000 });
    await addUsage({ provider: "exa", operation: runOp, cost: 0.001, basis: "estimated", ms: 200, at: 6_000 });
    await addUsage({ provider: "exa", operation: runOp, cost: 0.001, ms: 300, at: 7_000 });
    await addUsage({ provider: "exa", operation: runOp, cost: null, ok: false, ms: 50, at: 10_000 });
    await addUsage({ provider: "exa", operation: runOp, cost: 0.001, ms: 100, at: 60_000 + RUN_END_GRACE_MS - 5_000 }); // written just after the end
    await addUsage({ provider: "exa", operation: runOp, cost: 0.5, ms: 100, at: 60_000 + RUN_END_GRACE_MS + 5_000 }); // after the grace: no run's
    await addUsage({ provider: "exa", operation: BACKFILL_OPERATION, cost: 0.25, ms: null, at: 30_000 }); // backfill: never a run's
    await addUsage({ provider: "exa", operation: runOp, cost: 0.002, ms: 100, at: 10 * MIN + 5_000 });
    await addUsage({ provider: "exa", operation: runOp, cost: 0.003, ms: 100, at: 10 * MIN + 40_000 });
    await addUsage({ provider: "exa", operation: runOp, cost: 0.004, ms: 100, at: 21 * MIN });
    await addUsage({ provider: "exa", operation: runOp, cost: 0.006, ms: 100, at: 27 * MIN }); // past C's RUN_MAX_MS
    await addUsage({ provider: "exa", operation: runOp, cost: 0.007, ms: 100, at: 41 * MIN });

    check("RUN_MAX_MS matches the API's stale-run limit (STALE_RUN_MS)", RUN_MAX_MS === STALE_RUN_MS, { RUN_MAX_MS, STALE_RUN_MS });

    const [{ n: before }] = await query<{ n: string }>("select count(*) as n from le_run_starts r join le_leads l on l.id = r.lead_id");
    const { runs, total } = await listRuns("all", 500, fakeNow);
    const [{ n: after }] = await query<{ n: string }>("select count(*) as n from le_run_starts r join le_leads l on l.id = r.lead_id");
    const mine = runs.filter((r) => r.leadId === id);
    const by = new Map(mine.map((r) => [r.id, r]));
    const a = by.get(runA);
    const b = by.get(runB);
    const c = by.get(runC);
    const d = by.get(runD);
    check("runs: the lead's four runs, newest first", mine.map((r) => r.id).join() === [runD, runC, runB, runA].join(), mine.map((r) => r.id));
    check("runs: the run of a deleted lead is left out", !runs.some((r) => r.leadId === ghostLead));
    check("runs: total counts the runs of existing leads", total >= Number(before) && total <= Number(after), { total, before, after });
    check(
      "run A: done after 60 s; the error noted mid-run is not its end",
      a?.outcome === "done" && a.durationMs === 60_000 && a.endedAt === at(60_000) && a.endMessage === "Research done in 60s: test" && a.kind === "research",
      a,
    );
    check(
      "run A: 5 calls (one failed, one written just after the end), $0.004, partly estimated; backfill and later rows left out",
      a?.calls === 5 && a.failedCalls === 1 && a.costUsd === 0.004 && a.costEstimated === true,
      a && { calls: a.calls, failed: a.failedCalls, cost: a.costUsd, est: a.costEstimated },
    );
    check("run A: the lead's name and company", a?.leadName === leadName && a.company === "+SUM(1,2) Usage Tab Test Co" && a.startedAt === at(0));
    check("run B: a steer run that failed after 30 s, with its message", b?.kind === "steer" && b.outcome === "failed" && b.durationMs === 30_000 && /test failure/.test(b.endMessage ?? ""), b);
    check("run B: 2 calls, $0.005", b?.calls === 2 && b.costUsd === 0.005 && b.failedCalls === 0, b && { calls: b.calls, cost: b.costUsd });
    check("run C: no end in time (a later stale mark does not count): lost, no duration", c?.outcome === "lost" && c.durationMs === null && c.endedAt === null && c.endMessage === null, c);
    check("run C: only the call inside the time a run can take: 1 call, $0.004", c?.calls === 1 && c.costUsd === 0.004, c && { calls: c.calls, cost: c.costUsd });
    check("run D: started 3 minutes before now with no end: running, 1 call, $0.007", d?.outcome === "running" && d.durationMs === null && d.calls === 1 && d.costUsd === 0.007, d);
    const later = await listRuns("all", 500, new Date(T + 47 * MIN));
    check("run D: 7 minutes after its start with no end, it is lost", later.runs.find((r) => r.id === runD)?.outcome === "lost");
    const limited = await listRuns("all", 2, fakeNow);
    check("runs: the limit holds and the total does not change", limited.runs.length === 2 && limited.total === total);
    const week = await listRuns("7d", 500, fakeNow);
    check("runs: the 7d window holds the lead's runs", week.runs.filter((r) => r.leadId === id).length === 4);

    // --- time and cost per request
    const alpha = op("alpha");
    const durations = [100, 200, 300, 400, 1000];
    await addUsage({ provider: "apollo", operation: alpha, cost: 0.001, ms: 100, at: 120 * MIN });
    await addUsage({ provider: "apollo", operation: alpha, cost: 0.002, basis: "estimated", ms: 200, at: 121 * MIN });
    await addUsage({ provider: "apollo", operation: alpha, cost: null, ok: false, ms: 300, at: 122 * MIN });
    await addUsage({ provider: "apollo", operation: alpha, cost: 0.003, ms: 400, at: 123 * MIN });
    await addUsage({ provider: "apollo", operation: alpha, cost: 0, basis: "free", ms: 1000, at: 124 * MIN });
    await addUsage({ provider: "apollo", operation: alpha, cost: null, ms: null, at: 125 * MIN });
    await addUsage({ provider: "apollo", operation: BACKFILL_OPERATION, cost: 0.9, ms: null, at: 126 * MIN });

    const stats = await getOperationStats("all");
    const s = stats.find((x) => x.provider === "apollo" && x.operation === alpha);
    check("per request: 6 calls, 1 failed, 5 with a duration, 4 with a cost", s?.calls === 6 && s.failed === 1 && s.timedCalls === 5 && s.pricedCalls === 4, s);
    check(
      `per request: median ${percentileCont(durations, 0.5)} ms and 95th percentile ${Math.round(percentileCont(durations, 0.95))} ms, as interpolated percentiles`,
      s?.medianMs === percentileCont(durations, 0.5) && s.p95Ms === Math.round(percentileCont(durations, 0.95)) && s.maxMs === 1000,
      s && { median: s.medianMs, p95: s.p95Ms, max: s.maxMs },
    );
    check("per request: total $0.006, average $0.0015 per priced call, most expensive $0.003, partly estimated", s?.totalCostUsd === 0.006 && s.avgCostUsd === 0.0015 && s.maxCostUsd === 0.003 && s.costEstimated === true, s);
    check("per request: backfill rows are never a request type", !stats.some((x) => x.operation === BACKFILL_OPERATION));
    check("per request: slowest first", stats.every((x, i) => i === 0 || (stats[i - 1].medianMs ?? -1) >= (x.medianMs ?? -1)));
    check("per request: the window applies (two days back is not today)", !(await getOperationStats("today")).some((x) => x.operation === alpha));
    check("per request: and it is in the last 7 days", (await getOperationStats("7d")).some((x) => x.operation === alpha));

    // --- the call list
    const list = async (sort: "newest" | "slowest" | "costliest", limit = 100) => listCalls({ window: "all", sort, provider: "apollo", operation: alpha, limit });
    const slowest = await list("slowest");
    check("calls, slowest first: durations descending, the call without one last", slowest.total === 6 && slowest.calls.map((x) => x.ms).join() === "1000,400,300,200,100,", slowest.calls.map((x) => x.ms));
    const costliest = await list("costliest");
    check("calls, most expensive first: costs descending, unknown costs last", costliest.calls.map((x) => x.costUsd).join() === "0.003,0.002,0.001,0,,", costliest.calls.map((x) => x.costUsd));
    const newest = await list("newest");
    check("calls, newest first: by id", newest.calls.every((x, i, l) => i === 0 || l[i - 1].id > x.id) && newest.calls.length === 6);
    const two = await list("slowest", 2);
    check("calls: the limit cuts the rows, not the total", two.calls.length === 2 && two.total === 6);
    const apollo = await listCalls({ window: "all", sort: "costliest", provider: "apollo", limit: 1000 });
    check(
      "calls, most expensive first: backfill rows (many calls each) come after every real call",
      apollo.calls.some((x) => x.operation === BACKFILL_OPERATION) && inOrder(apollo.calls, "costliest"),
      apollo.calls.slice(0, 3).map((x) => `${x.operation} ${x.costUsd}`),
    );
    const row = newest.calls.find((x) => x.ms === 300);
    check("calls: a row carries its lead, duration, cost and result", row?.leadId === id && row.leadName === leadName && row.ok === false && row.costUsd === null && row.costBasis === "unknown");
    const sorted = await listCalls({ window: "all", sort: "bogus" as never, provider: "nope" as never, operation: alpha, limit: 5 });
    check("calls: an unknown sort or provider falls back to newest and every provider", sorted.total === 6 && sorted.calls.every((x, i, l) => i === 0 || l[i - 1].id > x.id));

    // --- export: the formula guard through the route, with lead names that look like formulas
    const formulaNames = ['=HYPERLINK("http://evil.example","x")', "@SUM(A1)", "-2+3", "\t=1"];
    for (const [i, name] of formulaNames.entries()) {
      const [fl] = await query<{ id: string }>("insert into le_leads (linkedin_url, linkedin_slug, name) values ($1, $2, $3) returning id", [
        `https://www.linkedin.com/in/${run}-f${i}`,
        `${run}-f${i}`,
        name,
      ]);
      await addUsage({ provider: "hubspot", operation: op(`formula-${i}`), cost: 0, basis: "free", ms: 10, at: 130 * MIN, lead: fl.id, leadName: name });
    }
    // A deleted lead's row (lead_id null, its name kept so its spend stays tied to a lead).
    const goneName = `Removed Person ${run}`;
    await addUsage({ provider: "hubspot", operation: op("deleted"), cost: 0, basis: "free", ms: 10, at: 132 * MIN, lead: null, leadName: goneName });
    const gone = await listCalls({ window: "all", sort: "newest", provider: "hubspot", operation: op("deleted"), limit: 5 });
    check("calls: a deleted lead's row says Deleted lead, never the name", gone.calls.length === 1 && gone.calls[0].leadName === DELETED_LEAD_NAME && gone.calls[0].leadId === null, gone.calls);
    await addUsage({ provider: "hubspot", operation: op("company"), cost: 0, basis: "free", ms: 10, at: 131 * MIN });
    const csvRes = await exportRoute.GET(request("/api/usage/export?window=all"));
    const rows = parseCsv((await csvRes.text()).replace(/^﻿/, ""));
    const col = (name: (typeof CSV_COLUMNS)[number]) => CSV_COLUMNS.indexOf(name);
    for (const [i, name] of formulaNames.entries()) {
      const line = rows.find((r) => r[col("operation")] === op(`formula-${i}`));
      check(`export: the lead name ${JSON.stringify(name.slice(0, 14))} is written as text, with a leading '`, line?.[col("lead_name")] === `'${name}`, line?.[col("lead_name")]);
    }
    const companyLine = rows.find((r) => r[col("operation")] === op("company"));
    check("export: a company name like +SUM(1,2) is written as text", companyLine?.[col("company")] === "'+SUM(1,2) Usage Tab Test Co", companyLine?.[col("company")]);
    check("export: no cell anywhere starts like a formula", rows.every((r) => r.every((cell) => !/^[=+\-@\t\r]/.test(cell))));
    const goneLine = rows.find((r) => r[col("operation")] === op("deleted"));
    check("export: a deleted lead's row says Deleted lead, and the name is nowhere", goneLine?.[col("lead_name")] === DELETED_LEAD_NAME && !rows.some((r) => r.some((cell) => cell.includes(goneName))), goneLine);
  } finally {
    // Exactly what this run created: its ledger rows by id, its runs by id, its lead by id and slug.
    try {
      if (usageIds.length) await query("delete from le_usage where id = any($1::bigint[])", [usageIds]);
      await query("delete from le_usage where operation like $1", [`${run}:%`]);
      if (runIds.length) await query("delete from le_run_starts where id = any($1::bigint[])", [runIds]);
      if (leadId) await query("delete from le_leads where id = $1::uuid and linkedin_slug = $2", [leadId, run]);
      await query("delete from le_leads where linkedin_slug like $1", [`${run}-f%`]);
      const [{ u }] = await query<{ u: string }>("select count(*) as u from le_usage where id = any($1::bigint[]) or operation like $2 or lead_name = $3", [usageIds, `${run}:%`, leadName]);
      const [{ r }] = await query<{ r: string }>("select count(*) as r from le_run_starts where id = any($1::bigint[]) or lead_id = $2::uuid", [runIds, ghostLead]);
      const [{ l }] = await query<{ l: string }>("select count(*) as l from le_leads where linkedin_slug = $1 or linkedin_slug like $2", [run, `${run}-f%`]);
      const [{ e }] = await query<{ e: string }>("select count(*) as e from le_events where lead_id = $1::uuid", [leadId ?? ghostLead]);
      check("cleanup: no test rows, runs, events or lead left", Number(u) + Number(r) + Number(l) + Number(e) === 0, { u, r, l, e });
    } catch (err) {
      check("cleanup", false, err instanceof Error ? err.message.slice(0, 160) : "error");
    }
  }
}

// ------------------------------------------------------------------ 4. balances (fetch and clock mocked)

interface Seen {
  url: string;
  headers: Record<string, string>;
  method: string;
}

/** Routes provider hosts to `answer`; anything else (Neon) goes to the real fetch. */
function mockProviders(answer: (url: URL) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  const unipileHost = (() => {
    try {
      const dsn = env.UNIPILE_DSN ?? "";
      return new URL(/^https?:\/\//.test(dsn) ? dsn : `https://${dsn}`).hostname;
    } catch {
      return "";
    }
  })();
  const providerHosts = new Set(["api.hunter.io", "openrouter.ai", "api.apify.com", "api.apollo.io", unipileHost].filter(Boolean));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!providerHosts.has(url.hostname)) return realFetch(input, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({ url: url.href, headers, method: init?.method ?? "GET" });
    return answer(url);
  }) as typeof fetch;
  return seen;
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HUNTER_OK = {
  data: {
    first_name: "Owner",
    last_name: "Example",
    email: "owner@example.com",
    plan_name: "Free",
    reset_date: "2026-12-01",
    requests: { credits: { used: 13, available: 50, remaining: 37 }, searches: { used: 13, available: 50, remaining: 37 } },
  },
};
const OPENROUTER_OK = { data: { label: "sk-or-v1-abc...xyz", limit: 20, limit_remaining: 17.5, limit_reset: "monthly", usage: 2.5, usage_daily: 0.1, usage_weekly: 0.6, usage_monthly: 2.5, is_free_tier: false } };
const APIFY_OK = { data: { monthlyUsageCycle: { startAt: "2026-11-02T00:00:00.000Z", endAt: "2026-12-01T23:59:59.999Z" }, limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 1.25 } } };
const APOLLO_OK = { credit_usage_stats: { lead_credit: { limit: 100, consumed: 12, left_over: 88 } }, current_credit_cycle: { end_date: "2026-12-01T00:00:00.000Z" } };
const UNIPILE_OK = { object: "AccountList", items: [{ object: "Account", type: "LINKEDIN", id: "acc_1", name: "Someone", sources: [{ id: "acc_1_MESSAGING", status: "OK" }] }] };

function standardAnswer(url: URL): Response {
  if (url.hostname === "api.hunter.io") return jsonResponse(HUNTER_OK);
  if (url.hostname === "openrouter.ai") return jsonResponse(OPENROUTER_OK);
  if (url.hostname === "api.apify.com") return jsonResponse(APIFY_OK);
  if (url.hostname === "api.apollo.io") return jsonResponse(APOLLO_OK);
  if (url.port && url.port !== "443") throw new TypeError("fetch failed"); // the blocked DSN port
  return jsonResponse(UNIPILE_OK);
}

function validBalance(b: ProviderBalance): boolean {
  return (
    USAGE_PROVIDERS.includes(b.provider) &&
    typeof b.summary === "string" &&
    b.summary.length > 0 &&
    (b.usedShare === null || (b.usedShare >= 0 && b.usedShare <= 1)) &&
    Object.values(b.numbers).every((n) => typeof n === "number" && Number.isFinite(n)) &&
    ["live", "ledger", "unavailable"].includes(b.source) &&
    (b.note === null || typeof b.note === "string") &&
    Number.isFinite(Date.parse(b.checkedAt))
  );
}

async function testBalances(): Promise<void> {
  section("4. balances (fetch and clock mocked: no provider is called)");
  local();

  // Parsers on documented shapes.
  const h = hunterBalanceFrom(HUNTER_OK);
  check("hunter: '37 of 50 credits left', 26% used, no name or email", h.source === "live" && h.summary === "37 of 50 credits left" && Math.abs((h.usedShare ?? 0) - 0.26) < 1e-9 && !/owner|Owner/.test(JSON.stringify(h)));
  check("hunter: a searches-only plan", hunterBalanceFrom({ data: { requests: { searches: { used: 5, available: 25 } } } }).summary === "20 of 25 searches left");
  let threw = false;
  try {
    hunterBalanceFrom({ data: {} });
  } catch {
    threw = true;
  }
  check("hunter: an unknown shape throws (the round turns it into 'unavailable')", threw);
  const o = openrouterBalanceFrom(OPENROUTER_OK);
  check("openrouter: '$17.50 of $20.00 key limit left', the key label never read", o.summary === "$17.50 of $20.00 key limit left" && !JSON.stringify(o).includes("sk-or"));
  check("openrouter: no limit -> monthly usage", openrouterBalanceFrom({ data: { limit: null, usage: 3, usage_monthly: 2 } }).summary === "No limit on this key · $2.00 this month");
  check("apify: '$1.25 of $5.00 used this cycle'", apifyBalanceFrom(APIFY_OK).summary === "$1.25 of $5.00 used this cycle");
  check("apollo: '88 of 100 credits left'", apolloBalanceFrom(APOLLO_OK).summary === "88 of 100 credits left");
  const u = unipileBalanceFrom(UNIPILE_OK, 12, null);
  check("unipile: '12 of ~100 LinkedIn requests today', running, no account name", u.summary === "12 of ~100 LinkedIn requests today" && /running/.test(u.note ?? "") && !JSON.stringify(u).includes("Someone"));
  check("unipile: unreachable -> the ledger's count with the reason", unipileBalanceFrom(null, 3, "Could not reach the provider.").source === "ledger");
  const r1 = unipileRoutes("https://api9.unipile.example:14914");
  check("unipile routes: the DSN port, then 443 with ?port=", r1.length === 2 && r1[1].portParam === "14914" && unipileRoutes("").length === 0);
  check("describeFailure: names the key variable, never a value", describeFailure(new HttpError(401, "body", "https://api.hunter.io/v2/account"), "HUNTER_API_KEY") === "The key was refused (401). Check HUNTER_API_KEY.");
  check("describeFailure: 429 and network errors", describeFailure(new HttpError(429, "", "https://x.example/")) === "Rate-limited (429). Try again in a minute." && describeFailure(new TypeError("fetch failed")) === "Could not reach the provider.");

  const keys = ["HUNTER_API_KEY", "OPENROUTER_API_KEY", "APIFY_TOKEN", "APOLLO_API_KEY", "UNIPILE_API_KEY", "EXA_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL"]
    .map((k) => env[k]?.trim())
    .filter((v): v is string => Boolean(v && v.length >= 8));
  const leaks = (text: string) => keys.some((k) => text.includes(k)) || text.includes(TEAM_PW) || text.includes(SECRET);
  const hosts = (list: Seen[]) => new Set(list.map((x) => new URL(x.url).hostname)).size;

  check("limits: answers are kept 60 s, a forced refresh waits 30 s", BALANCE_CACHE_MS === 60_000 && BALANCE_MIN_REFRESH_MS === 30_000);

  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  resetBalanceCache();
  const seen = mockProviders(standardAnswer);
  try {
    const first = await getBalances();
    const round = seen.length;
    check("round: 11 balances in USAGE_PROVIDERS order, fresh", first.balances.map((b) => b.provider).join() === USAGE_PROVIDERS.join() && first.cached === false);
    check("round: every entry has the contract fields", first.balances.every(validBalance), first.balances.filter((b) => !validBalance(b)).map((b) => b.provider));
    check("round: refreshableAt is 30 s after the checks", Date.parse(first.refreshableAt) - Date.parse(first.checkedAt) === 30_000);
    check("round: no key in any URL, keys only in headers", seen.every((x) => !leaks(x.url)) && seen.every((x) => Boolean(x.headers["x-api-key"] || /^Bearer /.test(x.headers.authorization ?? ""))));
    check("round: nothing returned holds a key or password", !leaks(JSON.stringify(first)));

    clock += 20_000;
    const early = await getBalances({ refresh: true });
    check("refresh 20 s after the checks: answered from the cache, no provider called", early.cached === true && seen.length === round && early.checkedAt === first.checkedAt);
    clock += 11_000;
    const forced = await getBalances({ refresh: true });
    const round2 = seen.length - round;
    check("refresh 31 s after the checks: a new round, one call per provider", forced.cached === false && round2 > 0 && hosts(seen.slice(round)) === hosts(seen.slice(0, round)) && forced.checkedAt !== first.checkedAt);
    clock += 10_000;
    const again = await getBalances({ refresh: true });
    check("refresh again 10 s later: from the cache", again.cached === true && seen.length === round + round2);
    clock += 49_000;
    check("plain read 59 s after the last round: from the cache", (await getBalances()).cached === true && seen.length === round + round2);
    clock += 2_000;
    const expired = await getBalances();
    check("plain read 61 s after the last round: a new round", expired.cached === false && seen.length > round + round2);

    // A reload storm: many readers at once share one round, then the cache answers everyone.
    clock += 61_000;
    const callsBefore = seen.length;
    const storm = await Promise.all(Array.from({ length: 12 }, (_, i) => getBalances({ refresh: i % 2 === 0 })));
    const stormCalls = seen.slice(callsBefore);
    check(
      "12 readers at once: one round shared by all, each provider called once",
      new Set(storm.map((x) => x.checkedAt)).size === 1 && stormCalls.length > 0 && hosts(stormCalls) === stormCalls.length,
      stormCalls.length,
    );
    const afterStorm = seen.length;
    const routeAnswers = await Promise.all(Array.from({ length: 20 }, () => balancesRoute.GET(request("/api/usage/balances?refresh=1"))));
    const bodies = await Promise.all(routeAnswers.map((r) => jsonOf<BalancesResponse>(r)));
    check("20 reloads with ?refresh=1 within 30 s: all 200 from the cache, no provider called", routeAnswers.every((r) => r.status === 200) && bodies.every((b) => b?.cached === true && b.balances.length === 11) && seen.length === afterStorm);
    check("GET /api/usage/balances: no-store, refreshableAt in the answer", routeAnswers[0].headers.get("cache-control") === "no-store" && Number.isFinite(Date.parse(bodies[0]?.refreshableAt ?? "")));
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }

  // Failures: errors, garbage, an echoed key. Nothing throws, nothing leaks.
  resetBalanceCache();
  const echoed = env.HUNTER_API_KEY ?? "";
  mockProviders((url) => {
    if (url.hostname === "api.hunter.io") return jsonResponse({ data: { plan_name: echoed.slice(0, 39), requests: { credits: { used: 1, available: 2, remaining: 1 } } } });
    if (url.hostname === "openrouter.ai") return jsonResponse({ error: { message: `bad key ${env.OPENROUTER_API_KEY}` } }, 401);
    if (url.hostname === "api.apify.com") return new Response("<html>oops</html>", { status: 200 });
    if (url.hostname === "api.apollo.io") return jsonResponse({ error: "not authorized" }, 403);
    throw new TypeError("fetch failed");
  });
  try {
    const bad = await getBalances();
    check("failures: still 11 balances, no exception, every entry valid", bad.balances.length === 11 && bad.balances.every(validBalance));
    check("failures: no key value anywhere in the output (an echoed key is hidden)", !leaks(JSON.stringify(bad)));
  } finally {
    globalThis.fetch = realFetch;
    resetBalanceCache();
  }
}

// ------------------------------------------------------------------ 5. export formula guard

function testExportGuard(): void {
  section("5. export: spreadsheet formulas are written as text");
  check("plain text unchanged", csvCell("Pieter Abbeel") === "Pieter Abbeel");
  check("commas and quotes quoted", csvCell('Acme, "Robots"') === '"Acme, ""Robots"""');
  check("line breaks quoted", csvCell("a\nb") === '"a\nb"');
  for (const [input, expected] of [
    ["=1+1", "'=1+1"],
    ["+1", "'+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\t=1", "'\t=1"],
    ["\r=1", `"'\r=1"`],
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
  ] as const) {
    check(`${JSON.stringify(input.slice(0, 16))} gets a leading '`, csvCell(input) === expected, csvCell(input));
  }
  check("a formula sign later in the text is fine", csvCell("A=B") === "A=B" && csvCell(" =1") === " =1");
  check("null, numbers and booleans", csvCell(null) === "" && csvCell(0.007) === "0.007" && csvCell(true) === "true");
  check("units as key=value", unitsCell({ inputTokens: 443, outputTokens: 10, junk: "x" }) === "inputTokens=443; outputTokens=10");
}

// ------------------------------------------------------------------ 6. format, scales, nav, scripts

function testFormat(): void {
  section("6. format, chart scales, the nav and the npm scripts");
  const usd = [formatUsd(0), formatUsd(0.00004), formatUsd(0.007), formatUsd(0.0017), formatUsd(0.10124), formatUsd(0.42), formatUsd(12.5), formatUsd(1234.5), formatUsd(null)].join(" ");
  check("money", usd === "$0 <$0.0001 $0.007 $0.0017 $0.1012 $0.42 $12.50 $1,234.50 –", usd);
  check("compact counts", [compactCount(940), compactCount(12_345), compactCount(999_950), compactCount(1_250_000)].join(" ") === "940 12.3K 1M 1.3M");
  check("counts, plural, share", formatCount(9_999) === "9,999" && plural(1, "call") === "1 call" && plural(3, "search", "searches") === "3 searches" && formatShare(0.004) === "<1%");
  check("durations", [formatMs(null), formatMs(340), formatMs(2_345), formatMs(45_000), formatMs(125_000)].join("|") === "|340 ms|2.3 s|45 s|2 min 5 s");
  check("units", unitsLine({ outputTokens: 26, inputTokens: 411 }) === "411 input tokens · 26 output tokens" && keyUnitsLine("exa", { searches: 27, contents: 3 }) === "27 searches · 3 pages read");
  check("main unit", mainUnit("anthropic", { inputTokens: 177_599, outputTokens: 22_440 }) === "200K tokens" && mainUnit("hunter", { lookups: 1, credits: 1 }) === "1 lookup");

  const d = durationScale(104_000);
  check("duration axis: round steps in seconds", d.top === 120_000 && d.ticks.map(d.label).join() === "0,30 s,60 s,90 s,120 s", d.ticks.map(d.label));
  const m = durationScale(310_000);
  check("duration axis: minutes from 5 minutes up", m.ticks.map(m.label).join() === "0,2 min,4 min,6 min", m.ticks.map(m.label));
  const c = usdScale(0.287);
  check("money axis: round steps", c.top === 0.3 && c.ticks.map(c.label).join() === "$0,$0.10,$0.20,$0.30", c.ticks.map(c.label));
  check("money axis: fractions of a cent, and nothing", usdScale(0.0003).ticks.map(usdScale(0.0003).label).join() === "$0,$0.0001,$0.0002,$0.0003" && usdScale(0).ticks.length === 1);

  const shell = readFileSync(join(process.cwd(), "src/components/app-shell.tsx"), "utf8");
  const nav = [...shell.matchAll(/\{ href: "([^"]+)", label: "([^"]+)" \}/g)].map((x) => `${x[2]}:${x[1]}`);
  check("nav: Leads, Pipeline, Usage, Settings (one list for both the desktop and the phone nav)", nav.join() === "Leads:/,Pipeline:/pipeline,Usage:/usage,Settings:/settings", nav);
  const page = readFileSync(join(process.cwd(), "src/app/usage/page.tsx"), "utf8");
  check("the /usage page has the title Usage and no access check of its own", /title: "Usage"/.test(page) && !/headers\(\)|notFound|adminAllowed/.test(page));
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
  check("npm scripts: no admin script; dev is plain next dev", pkg.scripts?.admin === undefined && pkg.scripts?.dev === "next dev");
}

// ------------------------------------------------------------------ 7. warm paths on the Usage tab

async function testWarmPathRows(): Promise<void> {
  section("7. warm paths: the twitterapi.io card, the Unipile card's two accounts, and the new rows");
  local();

  // --- names, colours and units
  check("twitterapi is a provider with a card: 'twitterapi.io (X follows)'", USAGE_PROVIDERS.includes("twitterapi") && USAGE_PROVIDER_LABELS.twitterapi === "twitterapi.io (X follows)" && SHORT_LABELS.twitterapi === "twitterapi.io");
  check("chart: twitterapi.io folds into Other (no new colour)", seriesOf("twitterapi") === "other" && SERIES.length === 7 && !SERIES.some((x) => (x.id as string) === "twitterapi"));
  check("chart: the legend can say what Other holds", otherLabels(["anthropic", "twitterapi", "exa"]).join() === "twitterapi.io" && otherLabels(["hubspot", "twitterapi", "unipile"]).join() === "Unipile,HubSpot,twitterapi.io" && otherLabels(["anthropic"]).length === 0);
  check("card units: '54 requests · 34.4K credits'", keyUnitsLine("twitterapi", { requests: 54, credits: 34_400, items: 9_000 }) === "54 requests · 34.4K credits", keyUnitsLine("twitterapi", { requests: 54, credits: 34_400, items: 9_000 }));
  check("per-lead unit: credits, else requests", mainUnit("twitterapi", { requests: 15, credits: 18_440 }) === "18.4K credits" && mainUnit("twitterapi", { requests: 2 }) === "2 requests" && mainUnit("twitterapi", { requests: 1, credits: 1 }) === "1 credit" && mainUnit("twitterapi", {}) === "");
  check("a call's units line", unitsLine({ requests: 1, credits: 200, items: 200 }) === "1 request · 200 items · 200 credits", unitsLine({ requests: 1, credits: 200, items: 200 }));

  // --- the twitterapi.io card: today's X budget and this month's estimated spend, from the app's own tables
  const x = twitterapiBalanceFrom({ usedCredits: 18_000, limitCredits: 100_000, monthUsd: 0.3443, monthCalls: 54 });
  check("twitterapi.io card: '$0.18 of $1.00 X budget used today', 18% used, from the ledger", x.summary === "$0.18 of $1.00 X budget used today" && Math.abs((x.usedShare ?? 0) - 0.18) < 1e-9 && x.source === "ledger" && validBalance(x), x);
  check("twitterapi.io card: this month's estimated spend and calls in the note", /^This month: \$0\.3443 \(est\.\) over 54 calls\./.test(x.note ?? "") && x.numbers.monthUsd === 0.3443, x.note);
  const paused = twitterapiBalanceFrom({ usedCredits: 0, limitCredits: 0, monthUsd: null, monthCalls: null });
  check("twitterapi.io card: paused budget, no meter", paused.summary === "X checks are paused (WARM_PATH_X_USD_PER_DAY is 0)" && paused.usedShare === null && validBalance(paused));
  check("twitterapi.io card: over budget never shows more than 100%", twitterapiBalanceFrom({ usedCredits: 130_000, limitCredits: 100_000, monthUsd: 2, monthCalls: 9 }).usedShare === 1);

  // --- the Unipile card: the research account and yours
  const TWO = { object: "AccountList", items: [
    { object: "Account", type: "LINKEDIN", id: "acc_research", name: "Someone", sources: [{ id: "a", status: "OK" }] },
    { object: "Account", type: "LINKEDIN", id: "acc_owner", name: "Owner Person", sources: [{ id: "b", status: "OK" }] },
  ] };
  const before = { network: env.UNIPILE_NETWORK_ACCOUNT_ID, pinned: env.UNIPILE_ACCOUNT_ID };
  try {
    env.UNIPILE_NETWORK_ACCOUNT_ID = "acc_owner";
    env.UNIPILE_ACCOUNT_ID = "acc_research";
    const u = unipileBalanceFrom(TWO, 12, null, { networkRequestsToday: 4, warmPathChecks: { used: 3, limit: 10 } });
    check(
      "unipile card: '12 of ~100 LinkedIn requests today (research account) · 4 on your account · 3 of 10 warm-path checks'",
      u.summary === "12 of ~100 LinkedIn requests today (research account) · 4 on your account · 3 of 10 warm-path checks" && validBalance(u) && !JSON.stringify(u).includes("Owner Person"),
      u.summary,
    );
    check("unipile card: the meter is the research account's share only", Math.abs((u.usedShare ?? 0) - 0.12) < 1e-9);
    const rows = unipileSplit(u);
    check(
      "unipile card: shown as three rows (research account, your account, warm-path checks)",
      rows?.map((r) => `${r.label}: ${r.value}`).join(" | ") === "Research account: 12 of ~100 requests today | Your account: 4 requests today | Warm-path checks: 3 of 10 today",
      rows,
    );
    const down = unipileBalanceFrom(null, 9, "Could not reach the provider.", { networkRequestsToday: 1, warmPathChecks: { used: 0, limit: 0 } });
    check("unipile card: Unipile unreachable still splits the ledger's counts; a zero limit reads Paused", unipileSplit(down)?.map((r) => r.value).join(" | ") === "9 of ~100 requests today | 1 request today | Paused", unipileSplit(down));
    delete env.UNIPILE_NETWORK_ACCOUNT_ID;
    const single = unipileBalanceFrom(UNIPILE_OK, 12, null, { networkRequestsToday: 4, warmPathChecks: { used: 3, limit: 10 } });
    check("unipile card: without your account set up, the plain line and no split", single.summary === "12 of ~100 LinkedIn requests today" && unipileSplit(single) === null);
    check("unipile card: only Unipile's card is ever split", unipileSplit({ provider: "hunter", numbers: { networkRequestsToday: 1, linkedinRequestsToday: 1 } }) === null);
  } finally {
    if (before.network === undefined) delete env.UNIPILE_NETWORK_ACCOUNT_ID;
    else env.UNIPILE_NETWORK_ACCOUNT_ID = before.network;
    if (before.pinned === undefined) delete env.UNIPILE_ACCOUNT_ID;
    else env.UNIPILE_ACCOUNT_ID = before.pinned;
  }
  check(
    "calls on your account in a window: the network-* operations of Unipile only",
    ownAccountCalls([
      { provider: "unipile", operation: "profile", calls: 7 },
      { provider: "unipile", operation: "network-profile", calls: 7 },
      { provider: "unipile", operation: "network-search", calls: 4 },
      { provider: "unipile", operation: "network-me", calls: 1 },
      { provider: "twitterapi", operation: "network-like", calls: 50 },
    ]) === 12,
  );

  // --- the new rows through GET /api/usage: per request, a run's cost, per lead, the daily chart
  const run = `usagewarm-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const op = (name: string) => `${run}:${name}`;
  const T = Date.now() - 2 * 86_400_000;
  const at = (ms: number) => new Date(T + ms).toISOString();
  const day = at(0).slice(0, 10);
  let leadId: string | null = null;
  let runId: string | null = null;
  try {
    const [lead] = await query<{ id: string }>("insert into le_leads (linkedin_url, linkedin_slug, name, company_name) values ($1, $2, $3, $4) returning id", [
      `https://www.linkedin.com/in/${run}`,
      run,
      `Warm Rows ${run}`,
      "Usage Warm Test Co",
    ]);
    leadId = lead.id;
    const add = (provider: string, operation: string, units: Record<string, number>, cost: number | null, basis: string, ms: number, when: number, ok = true) =>
      query(
        `insert into le_usage (lead_id, lead_name, provider, operation, units, cost_usd, cost_basis, ok, ms, created_at)
         values ($1::uuid, $2, $3, $4, $5::jsonb, $6::numeric, $7, $8, $9::integer, $10::timestamptz)`,
        [leadId, `Warm Rows ${run}`, provider, operation, JSON.stringify(units), cost, basis, ok, ms, at(when)],
      );
    const [r] = await query<{ id: string }>("insert into le_run_starts (lead_id, kind, created_at) values ($1::uuid, 'research', $2::timestamptz) returning id", [leadId, at(0)]);
    runId = r.id;
    // A research run: gather, then warm paths alongside the rest (X follows and your LinkedIn account).
    await add("anthropic", op("messages.parse"), { inputTokens: 20_000, outputTokens: 2_000 }, 0.003, "estimated", 9_000, 20_000);
    await add("twitterapi", op("user-info"), { requests: 1, credits: 18, items: 1 }, 0.00018, "estimated", 400, 16_000);
    await add("twitterapi", op("followings"), { requests: 1, credits: 200, items: 200 }, 0.002, "estimated", 600, 17_000);
    await add("twitterapi", op("followings"), { requests: 1, credits: 360, items: 180 }, 0.0036, "estimated", 1_000, 18_000);
    await add("twitterapi", op("followers-ids"), { requests: 1, credits: 1_500, items: 1_500 }, 0.015, "estimated", 2_600, 19_000);
    await add("twitterapi", op("follow-check"), { requests: 1 }, null, "unknown", 300, 21_000, false);
    await add("unipile", op("network-profile"), { requests: 1 }, 0, "free", 800, 18_500);
    await add("unipile", op("network-search"), { requests: 1 }, 0, "free", 2_100, 21_500);
    await query("insert into le_events (lead_id, type, message, created_at) values ($1::uuid, 'done', $2, $3::timestamptz)", [leadId, "Research done in 70s: 30 findings, 2 angles", at(70_000)]);

    const res = await usageRoute.GET(request("/api/usage?window=7d"));
    const body = await jsonOf<UsageResponse>(res);
    const ops = (body?.operations ?? []).filter((o) => o.operation.startsWith(`${run}:`));
    const followings = ops.find((o) => o.operation === op("followings"));
    check("per request: twitterapi.io operations with median, 95th percentile and estimated cost", followings?.provider === "twitterapi" && followings.calls === 2 && followings.medianMs === 800 && followings.p95Ms === 980 && followings.totalCostUsd === 0.0056 && followings.avgCostUsd === 0.0028 && followings.costEstimated === true, followings);
    const failedCheck = ops.find((o) => o.operation === op("follow-check"));
    check("per request: a failed follow check counts as failed, with no cost", failedCheck?.failed === 1 && failedCheck.pricedCalls === 0 && failedCheck.avgCostUsd === null, failedCheck);
    check("per request: your account's operations are listed with their times, free", ops.filter((o) => o.provider === "unipile").map((o) => `${o.operation.split(":")[1]} ${o.medianMs} ${o.totalCostUsd}`).sort().join() === "network-profile 800 0,network-search 2100 0", ops.filter((o) => o.provider === "unipile"));
    check("per request: calls on your account in the window", ownAccountCalls(ops.map((o) => ({ ...o, operation: o.operation.split(":")[1] }))) === 2);
    const mine = body?.leads.find((l) => l.leadId === leadId);
    const cell = mine?.byProvider.twitterapi;
    check("per lead: a twitterapi.io column with cost and credits", cell?.calls === 5 && Math.abs((cell.costUsd ?? 0) - 0.02078) < 1e-9 && cell.units.credits === 2_078 && mainUnit("twitterapi", cell.units) === "2.1K credits", cell);
    check("per lead: the total includes the X rows; your account's requests are counted under Unipile", Math.abs((mine?.totalCostUsd ?? 0) - 0.02378) < 1e-9 && mine?.byProvider.unipile?.units.requests === 2, mine);
    const mineRun = body?.runs.find((x) => String(x.id) === runId);
    check("runs: the run's cost and calls include its warm-path rows", mineRun?.outcome === "done" && mineRun.calls === 8 && mineRun.failedCalls === 1 && Math.abs((mineRun.costUsd ?? 0) - 0.02378) < 1e-9 && mineRun.costEstimated === true, mineRun);
    const spent = body?.daily.find((d) => d.day === day);
    check("daily chart: the day's twitterapi.io spend is there, to be folded into Other", (spent?.byProvider.twitterapi ?? 0) >= 0.02078 - 1e-9 && otherLabels(Object.keys(spent?.byProvider ?? {}) as (typeof USAGE_PROVIDERS)[number][]).includes("twitterapi.io"), spent);
    const tw = body?.summary.providers.find((x) => x.provider === "twitterapi");
    check("summary: the twitterapi.io card's window totals (calls, failures, credits, estimated)", (tw?.calls ?? 0) >= 5 && (tw?.failed ?? 0) >= 1 && (tw?.units.credits ?? 0) >= 2_078 && tw?.costEstimated === true, tw);
    const calls = await jsonOf<CallsResponse>(await callsRoute.GET(request(`/api/usage/calls?window=7d&sort=costliest&provider=twitterapi&operation=${encodeURIComponent(op("followers-ids"))}`)));
    check("calls: the list filters to a twitterapi.io operation", calls?.total === 1 && calls.calls[0].costUsd === 0.015 && calls.calls[0].units.items === 1_500 && calls.calls[0].costBasis === "estimated", calls?.calls[0]);
  } finally {
    try {
      await query("delete from le_usage where operation like $1", [`${run}:%`]);
      if (runId) await query("delete from le_run_starts where id = $1::bigint", [runId]);
      if (leadId) await query("delete from le_leads where id = $1::uuid and linkedin_slug = $2", [leadId, run]);
      const [{ n }] = await query<{ n: string }>(
        "select (select count(*) from le_usage where operation like $1) + (select count(*) from le_leads where linkedin_slug = $2) + (select count(*) from le_run_starts where lead_id = $3::uuid) as n",
        [`${run}:%`, run, leadId ?? randomUUID()],
      );
      check("cleanup: no warm-path test rows, run or lead left", Number(n) === 0, n);
    } catch (err) {
      check("cleanup", false, err instanceof Error ? err.message.slice(0, 160) : "error");
    }
  }
}

// ------------------------------------------------------------------ live (opt-in)

async function liveBalances(): Promise<void> {
  section("live balances (one free call per provider)");
  restoreEnv();
  resetBalanceCache();
  const { balances } = await getBalances();
  for (const b of balances) console.log(`  ${b.provider.padEnd(12)} ${b.source.padEnd(11)} ${b.summary}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  try {
    testExportGuard();
    testFormat();
    await testProxy();
    await testRoutes();
    await testQueries();
    await testBalances();
    await testWarmPathRows();
    if (process.argv.includes("--live")) await liveBalances();
  } finally {
    restoreEnv();
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  restoreEnv();
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
