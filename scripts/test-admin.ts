/**
 * Tests for the owner's usage panel (admin builder): who may open it (src/lib/admin/access.ts),
 * src/proxy.ts (the panel's localhost-only rule, every existing gate rule, ALLOW_OPEN_ACCESS and
 * the /ingest exemption), the admin layout's own check, the admin route handlers against Neon
 * (read-only), the balances with a mocked fetch, and the formatting and CSV helpers.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-admin.ts
 *   ... scripts/test-admin.ts --live     also reads every live balance once (one call per provider)
 *
 * 1. access   loopback hosts allowed; LAN, public and look-alike hosts, VERCEL=1, a production build,
 *             forwarding headers and cross-site API fetches refused; path normalisation
 * 2. proxy    the panel on this computer and from anywhere else (the 404 a missing page gets, and the
 *             same answer as any path when the deploy is locked or gated); existing gate rules;
 *             ALLOW_OPEN_ACCESS; the /ingest exemption
 * 3. layout   the admin layout's own check (notFound) and its metadata
 * 4. routes   the handlers' own 404s (no database or provider touched), usage and export (CSV)
 * 5. balance  parsers, the Unipile port-443 fallback, never throwing, no key in any URL or output,
 *             the 60 s cache; fetch is mocked, no provider is called
 * 6. format   money, counts, units, CSV escaping (formula injection), and the npm "admin" script
 *
 * Prints statuses only: never a key, token, cookie value, DSN or header.
 */
// First, as in Next's own server: installs globalThis.AsyncLocalStorage for next/server's request scope.
import "next/dist/server/node-environment-baseline";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { proxy, config as proxyConfig } from "../src/proxy";
import { createSessionToken, SESSION_COOKIE } from "../src/lib/auth";
import { adminAllowed, adminDenial, isAdminApiPath, isAdminPath, isLoopbackAddress, isLoopbackHost, isLoopbackName } from "../src/lib/admin/access";
import * as usageRoute from "../src/app/api/admin/usage/route";
import * as balancesRoute from "../src/app/api/admin/balances/route";
import * as exportRoute from "../src/app/api/admin/export/route";
import {
  apifyBalanceFrom,
  apolloBalanceFrom,
  describeFailure,
  getBalances,
  hunterBalanceFrom,
  openrouterBalanceFrom,
  resetBalanceCache,
  unipileBalanceFrom,
  unipileRoutes,
} from "../src/lib/admin/balances";
import { CSV_COLUMNS, csvCell, unitsCell } from "../src/lib/admin/export";
import { compactCount, formatCount, formatMs, formatShare, formatUsd, keyUnitsLine, mainUnit, plural, unitsLine } from "../src/lib/admin/format";
import { DAILY_DAYS, RECENT_LIMIT, type AdminBalancesResponse, type AdminUsageResponse } from "../src/lib/admin/types";
import { query } from "../src/lib/db";
import { HttpError } from "../src/lib/http";
import { PRICES_AS_OF } from "../src/lib/usage/prices";
import { windowStart } from "../src/lib/usage/queries";
import { USAGE_PROVIDERS, type ProviderBalance } from "../src/lib/usage/types";

// ------------------------------------------------------------------ compile-time checks
type Handler = (request: NextRequest) => Promise<Response>;
void (usageRoute.GET satisfies Handler);
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

/** A local run, the way `npm run admin` starts: gate off, not on Vercel, not a production build. */
function local(extra: Partial<Record<EnvName, string | undefined>> = {}): void {
  setEnv({ APP_PASSWORD: undefined, SESSION_SECRET: SECRET, VERCEL: undefined, ALLOW_OPEN_ACCESS: undefined, NODE_ENV: undefined, ...extra });
}

// ------------------------------------------------------------------ request helpers

const LOCAL = "http://localhost:3001";
const LAN_HOST = "192.168.1.20:3001";
const PUBLIC = "https://leads.example.com";

interface SendOpts {
  method?: string;
  /** The Host header; defaults to the URL's host. null sends none. */
  host?: string | null;
  /** The URL's origin (what nextUrl.hostname reads); defaults to http://localhost:3001. */
  base?: string;
  headers?: Record<string, string>;
  session?: string;
  body?: string;
}

function request(path: string, opts: SendOpts = {}): NextRequest {
  const base = opts.base ?? LOCAL;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.host !== null) headers.host = opts.host ?? new URL(base).host;
  if (opts.session) headers.cookie = `${SESSION_COOKIE}=${opts.session}`;
  // Origin + raw path, as Next builds it from the request line: "//admin" stays a path, not a host.
  return new NextRequest(new URL(`${base}${path}`), { method: opts.method ?? "GET", headers, body: opts.body });
}

const send = (path: string, opts: SendOpts = {}) => proxy(request(path, opts));
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
const redirectsTo = (res: Response) => (res.status === 307 || res.status === 308 ? res.headers.get("location") : null);
/** The proxy hands the request to a path no route matches: Next then answers with its own 404 page. */
const missingPage = (res: Response) => /^https?:\/\/[^/]+\/_missing$/.test(res.headers.get("x-middleware-rewrite") ?? "") && !passes(res);
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
const notFoundJson = async (res: Response) => res.status === 404 && (await errorOf(res)) === "Not found." && res.headers.get("cache-control") === "no-store";
const CROSS_SITE = { "sec-fetch-site": "cross-site" };
const SAME_ORIGIN = { "sec-fetch-site": "same-origin", origin: LOCAL };

/** Status, redirect target, JSON body and pass-through flag: what a visitor could compare. */
async function answer(res: Response): Promise<string> {
  return JSON.stringify([res.status, res.headers.get("location"), passes(res), res.headers.get("x-middleware-rewrite"), await res.clone().text()]);
}

// ------------------------------------------------------------------ 1. access rules

function testAccess(): void {
  section("1. who may open the panel (src/lib/admin/access.ts)");
  local();
  const h = (headers: Record<string, string>) => new Headers(headers);
  const allowedHost = (host: string, urlHostname = "localhost") => adminAllowed({ headers: h({ host }), urlHostname });

  for (const host of ["localhost:3001", "localhost", "127.0.0.1:3001", "127.0.0.1", "[::1]:3001", "[::1]", "LOCALHOST:3001"]) {
    check(`Host ${host} is allowed`, allowedHost(host));
  }
  for (const url of ["localhost", "127.0.0.1", "[::1]"]) check(`URL hostname ${url} is allowed`, allowedHost("127.0.0.1:3001", url));
  check("a layout (no URL) with Host localhost is allowed", adminAllowed({ headers: h({ host: "localhost:3001" }) }));

  for (const [label, host] of [
    ["a LAN address", LAN_HOST],
    ["another private address", "10.0.0.5:3001"],
    ["a public host name", "leads.example.com"],
    ["a look-alike: localhost.evil.example", "localhost.evil.example:3001"],
    ["a subdomain of localhost", "admin.localhost:3001"],
    ["another loopback address (only the three names count)", "127.0.0.2:3001"],
    ["the all-interfaces address", "0.0.0.0:3001"],
    ["userinfo trick", "localhost:3001@evil.example"],
    ["two hosts", "localhost:3001, evil.example"],
    ["a trailing dot", "localhost.:3001"],
    ["an empty Host", ""],
  ] as const) {
    check(`Host from ${label} is refused`, adminDenial({ headers: h({ host }), urlHostname: "localhost" }) === "host", host);
  }
  check("no Host header at all is refused", adminDenial({ headers: h({}), urlHostname: "localhost" }) === "host");
  check("a loopback Host on a non-loopback URL is refused (server bound elsewhere)", adminDenial({ headers: h({ host: "localhost:3001" }), urlHostname: "192.168.1.20" }) === "url");
  check("URL hostname 0.0.0.0 is refused", adminDenial({ headers: h({ host: "localhost:3001" }), urlHostname: "0.0.0.0" }) === "url");

  setEnv({ VERCEL: "1" });
  check("VERCEL=1 is refused even from localhost", adminDenial({ headers: h({ host: "localhost:3001" }), urlHostname: "localhost" }) === "deployed");
  setEnv({ VERCEL: "true" });
  check("any VERCEL value counts as Vercel", adminDenial({ headers: h({ host: "localhost:3001" }), urlHostname: "localhost" }) === "deployed");
  local({ NODE_ENV: "production" });
  check("a production build is refused even from localhost", adminDenial({ headers: h({ host: "localhost:3001" }), urlHostname: "localhost" }) === "deployed");
  local({ NODE_ENV: "development" });
  check("next dev (NODE_ENV=development) from localhost is allowed", allowedHost("localhost:3001"));
  local();

  const base = { host: "localhost:3001" };
  for (const [label, headers, ok] of [
    ["X-Forwarded-Host of another site", { "x-forwarded-host": "evil.example" }, false],
    ["X-Forwarded-Host localhost (what Next itself sets)", { "x-forwarded-host": "localhost:3001" }, true],
    ["X-Forwarded-For of a public address", { "x-forwarded-for": "203.0.113.9" }, false],
    ["X-Forwarded-For of a LAN address", { "x-forwarded-for": "192.168.1.30" }, false],
    ["X-Forwarded-For with one outside hop", { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }, false],
    ["X-Forwarded-For 127.0.0.1 (Next's own, from the socket)", { "x-forwarded-for": "127.0.0.1" }, true],
    ["X-Forwarded-For ::1", { "x-forwarded-for": "::1" }, true],
    ["X-Forwarded-For ::ffff:127.0.0.1", { "x-forwarded-for": "::ffff:127.0.0.1" }, true],
    ["X-Forwarded-For unknown", { "x-forwarded-for": "unknown" }, false],
    ["X-Real-IP of a public address", { "x-real-ip": "198.51.100.7" }, false],
    ["Forwarded for= a public address", { forwarded: "for=203.0.113.43;proto=https" }, false],
    ["Forwarded host= another site", { forwarded: 'for="[::1]";host=evil.example' }, false],
    ["Forwarded for=[::1], host=localhost", { forwarded: 'for="[::1]:5000";host=localhost:3001' }, true],
    ["Forwarded with an obfuscated for=", { forwarded: "for=_hidden" }, false],
  ] as const) {
    check(`${label}: ${ok ? "allowed" : "refused"}`, adminAllowed({ headers: h({ ...base, ...headers }), urlHostname: "localhost" }) === ok);
  }

  for (const [site, ok] of [["cross-site", false], ["same-site", false], ["same-origin", true], ["none", true]] as const) {
    check(`API with Sec-Fetch-Site ${site}: ${ok ? "allowed" : "refused"}`, adminAllowed({ headers: h({ ...base, "sec-fetch-site": site }), urlHostname: "localhost", api: true }) === ok);
  }
  check("API from a script (no Sec-Fetch-Site) is allowed", adminAllowed({ headers: h(base), urlHostname: "localhost", api: true }));
  check("a page opened from a link on another site is allowed (it only shows HTML)", adminAllowed({ headers: h({ ...base, "sec-fetch-site": "cross-site" }), urlHostname: "localhost" }));

  for (const path of ["/admin", "/admin/", "/admin/anything", "//admin", "/%61dmin", "/%2561dmin", "/ADMIN", "/admin%2fx", "/%5cadmin", "/api/admin", "/api/admin/usage", "/api//admin/usage", "/api/%61dmin/usage", "/API/Admin/export"]) {
    check(`${path} is the panel`, isAdminPath(path));
  }
  for (const path of ["/", "/administrator", "/adminx", "/leads/admin", "/api/administer", "/api/leads", "/ingest/admin"]) {
    check(`${path} is not the panel`, !isAdminPath(path));
  }
  check("API paths: /api/admin/usage and /api//admin/x", isAdminApiPath("/api/admin/usage") && isAdminApiPath("/api//admin/x") && !isAdminApiPath("/admin"));
  check("isLoopbackHost / isLoopbackName / isLoopbackAddress", isLoopbackHost(" [::1]:443 ") && !isLoopbackHost("::1") && isLoopbackName("[::1]") && isLoopbackAddress("[::1]:5000") && isLoopbackAddress("127.12.0.1") && !isLoopbackAddress("128.0.0.1") && !isLoopbackAddress("1270.0.0.1"));
}

// ------------------------------------------------------------------ 2. proxy

async function testProxy(): Promise<void> {
  section("2. proxy");
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config: proxyConfig, url });
  for (const url of ["/", "/leads/abc", "/pipeline", "/settings", "/login", "/admin", "/admin/x", "/api/admin/usage", "/api/admin/export", "/api/leads", "/ingest/e/", "/ingest/static/array.js"]) {
    check(`matcher runs on ${url}`, matches(url));
  }
  for (const url of ["/_next/static/chunks/main.js", "/favicon.ico", "/robots.txt", "/icon.png", "/fonts/inter.woff2"]) {
    check(`matcher skips ${url}`, !matches(url));
  }

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    // --- the Vercel lock and the ALLOW_OPEN_ACCESS opt-in (first: the open-deploy warning is once per process)
    for (const value of [undefined, "", "0", "true", "yes", "11", "REPLACE_ME"]) {
      local({ VERCEL: "1", ALLOW_OPEN_ACCESS: value });
      for (const [method, path] of [["GET", "/"], ["GET", "/login"], ["GET", "/api/leads"], ["POST", "/api/leads"]] as const) {
        const res = await send(path, { method, headers: method === "POST" ? SAME_ORIGIN : {} });
        check(
          `Vercel, no APP_PASSWORD, ALLOW_OPEN_ACCESS=${JSON.stringify(value ?? null)}: ${method} ${path} is 503`,
          res.status === 503 && /APP_PASSWORD/.test(await errorOf(res)) && res.headers.get("cache-control") === "no-store",
          { status: res.status },
        );
      }
    }
    for (const value of ["1", " 1 "]) {
      local({ VERCEL: "1", ALLOW_OPEN_ACCESS: value });
      const tag = `Vercel with ALLOW_OPEN_ACCESS=${JSON.stringify(value)}`;
      check(`${tag}: / passes`, passes(await send("/", { base: PUBLIC })));
      check(`${tag}: /api/leads passes`, passes(await send("/api/leads", { base: PUBLIC })));
      check(`${tag}: same-origin POST passes`, passes(await send("/api/leads", { method: "POST", base: PUBLIC, headers: { "sec-fetch-site": "same-origin" } })));
      check(`${tag}: cross-site POST is still 403`, (await send("/api/leads", { method: "POST", base: PUBLIC, headers: CROSS_SITE })).status === 403);
      check(`${tag}: /admin is the 404 page`, missingPage(await send("/admin", { base: PUBLIC })));
      check(`${tag}: /admin with a spoofed Host localhost is still the 404 page`, missingPage(await send("/admin", { host: "localhost:3001" })));
      check(`${tag}: /api/admin/usage is 404 JSON`, await notFoundJson(await send("/api/admin/usage", { base: PUBLIC })));
    }
    const open = warnings.filter((w) => w.includes("[proxy]"));
    check("open deploy: the warning is logged once per instance, naming ALLOW_OPEN_ACCESS", open.length === 1 && /ALLOW_OPEN_ACCESS=1/.test(open[0]), warnings);
  } finally {
    console.warn = realWarn;
  }

  // --- the panel on this computer
  local();
  for (const host of ["localhost:3001", "127.0.0.1:3001", "[::1]:3001"]) {
    const base = `http://${host}`;
    const page = await send("/admin?window=7d", { base });
    check(
      `${host}: /admin passes, noindex, no framing`,
      passes(page) &&
        /noindex/.test(page.headers.get("x-robots-tag") ?? "") &&
        page.headers.get("x-frame-options") === "DENY" &&
        /frame-ancestors 'none'/.test(page.headers.get("content-security-policy") ?? ""),
    );
    for (const path of ["/api/admin/usage?window=today", "/api/admin/balances", "/api/admin/export?window=all"]) {
      check(`${host}: ${path} passes`, passes(await send(path, { base })));
    }
  }
  check("localhost: same-origin fetch of /api/admin/usage passes", passes(await send("/api/admin/usage", { headers: SAME_ORIGIN })));
  check("localhost: cross-site fetch of /api/admin/export is 404 JSON", await notFoundJson(await send("/api/admin/export", { headers: CROSS_SITE })));
  check("localhost: same-site fetch of /api/admin/balances is 404 JSON", await notFoundJson(await send("/api/admin/balances?refresh=1", { headers: { "sec-fetch-site": "same-site" } })));
  check("localhost: a page link from another site still opens /admin", passes(await send("/admin", { headers: CROSS_SITE })));

  // --- the panel from anywhere else: the 404 page, or 404 JSON for the API
  const elsewhere: Array<[string, SendOpts]> = [
    ["a LAN address", { host: LAN_HOST }],
    ["a public host name", { base: PUBLIC }],
    ["DNS rebinding (another site's name pointed at 127.0.0.1)", { host: "evil.example:3001" }],
    ["a tunnel or proxy (X-Forwarded-Host)", { headers: { "x-forwarded-host": "abc.tunnel.example" } }],
    ["a proxy that forwards with Host localhost (X-Forwarded-For)", { headers: { "x-forwarded-for": "203.0.113.9" } }],
    ["Forwarded: for= a public address", { headers: { forwarded: "for=198.51.100.4" } }],
    ["no Host header", { host: null }],
  ];
  for (const [label, opts] of elsewhere) {
    for (const path of ["/admin", "/admin?window=all", "/admin/", "/admin/anything", "//admin", "/%61dmin", "/ADMIN"]) {
      check(`${label}: ${path} is the 404 page`, missingPage(await send(path, opts)));
    }
    for (const path of ["/api/admin/usage", "/api/admin/balances?refresh=1", "/api/admin/export?window=all", "/api/admin", "/api//admin/usage", "/api/%61dmin/usage"]) {
      check(`${label}: ${path} is 404 JSON`, await notFoundJson(await send(path, opts)));
    }
    check(`${label}: the rest of the app is unaffected (/ passes)`, passes(await send("/", opts)));
  }
  local({ VERCEL: "1", ALLOW_OPEN_ACCESS: "1" });
  check("VERCEL=1 (open deploy), Host localhost: /admin is the 404 page", missingPage(await send("/admin")));
  check("VERCEL=1 (open deploy), Host localhost: /api/admin/balances is 404 JSON", await notFoundJson(await send("/api/admin/balances")));
  local({ NODE_ENV: "production" });
  check("production build, Host localhost: /admin is the 404 page", missingPage(await send("/admin")));
  check("production build, Host localhost: /api/admin/usage is 404 JSON", await notFoundJson(await send("/api/admin/usage")));

  // --- where the deploy answers every path the same way, /admin gets that same answer
  local({ VERCEL: "1" });
  check("locked Vercel deploy: /admin answers exactly like a missing page (503)", (await answer(await send("/admin", { base: PUBLIC }))) === (await answer(await send("/no-such-page", { base: PUBLIC }))));
  check("locked Vercel deploy: /api/admin/usage answers exactly like a missing API path", (await answer(await send("/api/admin/usage", { base: PUBLIC }))) === (await answer(await send("/api/no-such-thing", { base: PUBLIC }))));
  for (const vercel of [undefined, "1"]) {
    local({ APP_PASSWORD: TEAM_PW, VERCEL: vercel });
    const tag = vercel ? "gated Vercel deploy" : "gate on (local)";
    const admin = await send("/admin", { base: PUBLIC });
    const missing = await send("/no-such-page", { base: PUBLIC });
    check(`${tag}, no session, public host: /admin redirects to /login like a missing page`, redirectsTo(admin) === `${PUBLIC}/login?next=%2Fadmin` && redirectsTo(missing) === `${PUBLIC}/login?next=%2Fno-such-page`);
    check(`${tag}, no session: /api/admin/usage answers exactly like a missing API path (401)`, (await answer(await send("/api/admin/usage", { base: PUBLIC }))) === (await answer(await send("/api/no-such-thing", { base: PUBLIC }))));
    const team = await createSessionToken();
    check(`${tag}, with a team session, public host: /admin is the 404 page`, missingPage(await send("/admin", { base: PUBLIC, session: team })));
    check(`${tag}, with a team session, public host: /api/admin/export is 404 JSON`, await notFoundJson(await send("/api/admin/export", { base: PUBLIC, session: team })));
  }

  // --- the team gate applies first on this computer too
  local({ APP_PASSWORD: TEAM_PW });
  const team = await createSessionToken();
  check("gate on, localhost, no session: /admin goes to /login?next=/admin", redirectsTo(await send("/admin")) === `${LOCAL}/login?next=%2Fadmin`);
  check("gate on, localhost, no session: /api/admin/usage is the team 401", ((r) => r.status === 401)(await send("/api/admin/usage")));
  check("gate on, localhost, team session: /admin passes", passes(await send("/admin", { session: team })));
  check("gate on, localhost, team session: /api/admin/export passes", passes(await send("/api/admin/export", { session: team })));
  check("gate on: /login?next=/admin with a session goes to /admin", redirectsTo(await send("/login?next=%2Fadmin", { session: team })) === `${LOCAL}/admin`);
  check("gate on, LAN host, team session: /admin is the 404 page", missingPage(await send("/admin", { host: LAN_HOST, session: team })));

  // --- existing rules, gate off (local)
  local();
  check("gate off: / passes", passes(await send("/")));
  check("gate off: /api/leads passes", passes(await send("/api/leads")));
  const refused = async (res: Response) => res.status === 403 && /Cross-site/.test(await errorOf(res)) && res.headers.get("cache-control") === "no-store";
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    check(`gate off: cross-site ${method} /api/leads is 403`, await refused(await send("/api/leads", { method, headers: CROSS_SITE })));
  }
  check("gate off: same-site (sibling subdomain) POST is 403", await refused(await send("/api/leads", { method: "POST", headers: { "sec-fetch-site": "same-site" } })));
  check("gate off: foreign Origin without Sec-Fetch-Site is 403", await refused(await send("/api/leads", { method: "POST", headers: { origin: "https://evil.example" } })));
  check("gate off: Origin null is 403", await refused(await send("/api/leads", { method: "POST", headers: { origin: "null" } })));
  check("gate off: same-origin POST passes", passes(await send("/api/leads", { method: "POST", headers: SAME_ORIGIN })));
  check("gate off: header-less POST (a script) passes", passes(await send("/api/leads", { method: "POST" })));
  check("gate off: cross-site GET passes", passes(await send("/api/leads", { headers: CROSS_SITE })));
  check("gate off: cross-site POST to /api/admin is 403 before anything else", await refused(await send("/api/admin/usage", { method: "POST", headers: CROSS_SITE })));
  check("gate off, off Vercel: the gate stays off", passes(await send("/api/leads", { base: PUBLIC })));

  // --- existing rules, gate on
  local({ APP_PASSWORD: TEAM_PW });
  check("gate on, no session: / redirects to /login", redirectsTo(await send("/")) === `${LOCAL}/login`);
  check("gate on, no session: deep link keeps next=", redirectsTo(await send("/leads/123?tab=angles")) === `${LOCAL}/login?next=${encodeURIComponent("/leads/123?tab=angles")}`);
  const api = await send("/api/leads");
  check("gate on, no session: /api/* is 401 JSON", api.status === 401 && /Log in/.test(await errorOf(api)));
  for (const path of ["/login", "/api/login", "/api/logout"]) check(`gate on, no session: ${path} passes`, passes(await send(path)));
  check("gate on: tampered session is 401", (await send("/api/leads", { session: `${team.slice(0, -2)}AA` })).status === 401);
  check("gate on: valid session passes /", passes(await send("/", { session: team })));
  check("gate on: valid session passes /api/leads", passes(await send("/api/leads", { session: team })));
  check("gate on: other paths keep their cookies (no header override)", (await send("/api/leads", { session: team })).headers.get("x-middleware-override-headers") === null);
  check("gate on: valid session, cross-site POST is 403", await refused(await send("/api/leads", { method: "POST", headers: CROSS_SITE, session: team })));
  check("gate on: /login?next=/pipeline with a session goes to /pipeline", redirectsTo(await send("/login?next=%2Fpipeline", { session: team })) === `${LOCAL}/pipeline`);
  for (const [label, next] of [
    ["two slashes", "%2F%2Fevil.example"],
    ["tab", "/%09/evil.example"],
    ["line feed", "/%0a/evil.example"],
    ["backslash", "/%5Cevil.example"],
    ["absolute URL", "https%3A%2F%2Fevil.example%2F"],
    ["the login page itself", "%2Flogin%3Fnext%3D%2Fpipeline"],
  ] as const) {
    check(`gate on: ?next=${next} (${label}) goes to /`, redirectsTo(await send(`/login?next=${next}`, { session: team })) === `${LOCAL}/`);
  }
  local({ APP_PASSWORD: TEAM_PW, VERCEL: "1" });
  check("gate on, Vercel: the normal gate (401 without a session)", (await send("/api/leads", { base: PUBLIC })).status === 401);
  local({ APP_PASSWORD: TEAM_PW, SESSION_SECRET: undefined });
  check("gate on, misconfigured (no SESSION_SECRET): fails closed", (await send("/api/leads", { session: team })).status === 401);

  // --- the /ingest exemption (PostHog's reverse proxy)
  for (const [label, vars] of [
    ["gate on, no session", { APP_PASSWORD: TEAM_PW }],
    ["Vercel lock (no APP_PASSWORD, no opt-in)", { VERCEL: "1" }],
    ["gate on, Vercel", { APP_PASSWORD: TEAM_PW, VERCEL: "1" }],
  ] as const) {
    local(vars);
    for (const path of ["/ingest", "/ingest/e/", "/ingest/flags/?v=2", "/ingest/static/array.js", "/ingest/array/phc_x/config.js", "/ingest/i/v0/e/"]) {
      check(`${label}: GET ${path} passes`, passes(await send(path, { base: PUBLIC })));
    }
    check(`${label}: same-origin POST /ingest/e/ passes`, passes(await send("/ingest/e/", { method: "POST", base: PUBLIC, headers: { "sec-fetch-site": "same-origin" } })));
    check(`${label}: sendBeacon-style POST /ingest/e/ (no headers) passes`, passes(await send("/ingest/e/", { method: "POST", base: PUBLIC })));
    check(`${label}: cross-site POST /ingest/e/ is still 403`, await refused(await send("/ingest/e/", { method: "POST", base: PUBLIC, headers: CROSS_SITE })));
    // The request goes on to PostHog without its cookies. NextResponse.next({ request: { headers } })
    // lists the forwarded headers in x-middleware-override-headers and their values in x-middleware-request-*.
    const ingest = await send("/ingest/e/", {
      method: "POST",
      base: PUBLIC,
      session: "v1.0.not-a-real-session",
      headers: { "sec-fetch-site": "same-origin", "user-agent": "admin-test-agent" },
    });
    const forwarded = (ingest.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
    check(
      `${label}: /ingest is forwarded without the Cookie header (the session never reaches PostHog)`,
      passes(ingest) && forwarded.length > 0 && !forwarded.includes("cookie") && ingest.headers.get("x-middleware-request-cookie") === null,
      forwarded,
    );
    check(`${label}: /ingest keeps its other headers`, ingest.headers.get("x-middleware-request-user-agent") === "admin-test-agent" && forwarded.includes("user-agent"));
    for (const path of ["/ingestion", "/ingest-x", "/api/ingest", "/ingest%2f..%2fapi%2fleads", "/ingest/%2e%2e/api/leads", "/ingest/..%5capi/leads"]) {
      const res = await send(path, { base: PUBLIC });
      check(`${label}: ${path} is not exempt`, !passes(res), { status: res.status });
    }
  }
  restoreEnv();
}

// ------------------------------------------------------------------ 3. the admin layout's own check

/** Next serves server components the react-server build of next/navigation; tsx would load the client one. */
function aliasServerNavigation(): void {
  const req = createRequire(join(process.cwd(), "package.json"));
  const from = req.resolve("next/navigation");
  const mod = new Module(from);
  mod.filename = from;
  mod.loaded = true;
  mod.exports = req("next/dist/client/components/navigation.react-server");
  req.cache[from] = mod;
}

async function inRender<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/admin", forceStatic: false, dynamicShouldError: false };
  const unitStore = { type: "private-cache", phase: "render", headers: new Headers(headers) };
  return workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run(unitStore as never, fn));
}

async function testLayout(): Promise<void> {
  section("3. the admin layout checks again");
  aliasServerNavigation();
  const layout = await import("../src/app/admin/layout");
  const render = async (headers: Record<string, string>): Promise<string> =>
    inRender(headers, async () => {
      try {
        return `rendered:${String(await layout.default({ children: "panel" as never }))}`;
      } catch (err) {
        return `threw:${(err as { digest?: unknown }).digest}`;
      }
    });
  const NOT_FOUND = "threw:NEXT_HTTP_ERROR_FALLBACK;404";
  local();
  check("localhost, Next's own forwarding headers: the layout renders", (await render({ host: "localhost:3001", "x-forwarded-host": "localhost:3001", "x-forwarded-for": "127.0.0.1" })) === "rendered:panel");
  check("[::1], socket ::ffff:127.0.0.1: the layout renders", (await render({ host: "[::1]:3001", "x-forwarded-for": "::ffff:127.0.0.1" })) === "rendered:panel");
  for (const [label, headers] of [
    ["a LAN Host", { host: LAN_HOST }],
    ["Host localhost from a LAN socket (dev server on every interface)", { host: "localhost:3001", "x-forwarded-for": "192.168.1.30" }],
    ["a tunnel", { host: "localhost:3001", "x-forwarded-host": "abc.tunnel.example" }],
    ["no Host", {}],
  ] as const) {
    check(`${label}: the layout answers notFound()`, (await render(headers)) === NOT_FOUND);
  }
  local({ VERCEL: "1" });
  check("VERCEL=1: the layout answers notFound()", (await render({ host: "localhost:3001" })) === NOT_FOUND);
  local({ NODE_ENV: "production" });
  check("production build: the layout answers notFound()", (await render({ host: "localhost:3001" })) === NOT_FOUND);
  local();
  const metaOk = await inRender({ host: "localhost:3001" }, () => layout.generateMetadata());
  const metaNo = await inRender({ host: LAN_HOST }, () => layout.generateMetadata());
  check("metadata: title Usage and noindex on this computer", metaOk.title === "Usage" && (metaOk.robots as { index?: boolean } | undefined)?.index === false);
  check("metadata: nothing at all for anyone else (not even the title)", JSON.stringify(metaNo) === "{}");
}

// ------------------------------------------------------------------ 4. routes

const realFetch = globalThis.fetch;

async function testRoutes(): Promise<void> {
  section("4. admin routes (Neon, read-only)");
  local();

  // The handlers refuse by themselves, before any database or provider call.
  let fetches = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetches++;
    return realFetch(...args);
  }) as typeof fetch;
  try {
    for (const [label, opts, vars] of [
      ["a LAN Host", { host: LAN_HOST }, {}],
      ["a public host", { base: PUBLIC }, {}],
      ["X-Forwarded-For of a LAN address (dev server on every interface)", { headers: { "x-forwarded-for": "192.168.1.30" } }, {}],
      ["a cross-site fetch", { headers: CROSS_SITE }, {}],
      ["VERCEL=1", {}, { VERCEL: "1" }],
      ["a production build", {}, { NODE_ENV: "production" }],
    ] as const) {
      local(vars);
      for (const [name, handler, path] of [
        ["usage", usageRoute.GET, "/api/admin/usage?window=all"],
        ["balances", balancesRoute.GET, "/api/admin/balances?refresh=1"],
        ["export", exportRoute.GET, "/api/admin/export?window=all"],
      ] as const) {
        const before = fetches;
        const res = await handler(request(path, opts as SendOpts));
        check(`${label}: the ${name} handler itself answers 404 JSON, touching nothing`, (await notFoundJson(res)) && fetches === before, { status: res.status });
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  local();

  // usage
  check("usage: bad window is 400", (await usageRoute.GET(request("/api/admin/usage?window=year"))).status === 400);
  for (const window of ["today", "7d", "30d", "all"] as const) {
    const res = await usageRoute.GET(request(`/api/admin/usage?window=${window}`));
    const body = await jsonOf<AdminUsageResponse>(res);
    const from = body?.summary.from ?? null;
    const expectedFrom = windowStart(window)?.toISOString() ?? null;
    check(
      `usage ${window}: 200 with summary, leads, ${DAILY_DAYS} days and recent rows inside the window`,
      res.status === 200 &&
        body?.window === window &&
        body.summary.window === window &&
        from === expectedFrom &&
        Array.isArray(body.leads) &&
        body.daily.length === DAILY_DAYS &&
        body.recent.length <= RECENT_LIMIT &&
        body.recent.every((r) => !from || r.createdAt >= from) &&
        typeof body.recentTruncated === "boolean" &&
        body.pricesAsOf === PRICES_AS_OF &&
        res.headers.get("cache-control") === "no-store" &&
        /noindex/.test(res.headers.get("x-robots-tag") ?? ""),
      { status: res.status, window: body?.window, from, days: body?.daily.length },
    );
  }
  const defaulted = await jsonOf<AdminUsageResponse>(await usageRoute.GET(request("/api/admin/usage")));
  check("usage: no window means 30d", defaulted?.window === "30d");
  check("usage: from 127.0.0.1 and [::1] too", (await usageRoute.GET(request("/api/admin/usage?window=today", { base: "http://127.0.0.1:3001" }))).status === 200 && (await usageRoute.GET(request("/api/admin/usage?window=today", { base: "http://[::1]:3001" }))).status === 200);
  check("usage: a same-origin fetch is fine", (await usageRoute.GET(request("/api/admin/usage?window=today", { headers: SAME_ORIGIN }))).status === 200);

  // export
  const count = async () => Number((await query<{ n: string }>("select count(*) as n from le_usage"))[0]?.n ?? 0);
  const before = await count();
  const csvRes = await exportRoute.GET(request("/api/admin/export?window=all"));
  const after = await count();
  // Response.text() drops a leading byte order mark, so look at the bytes.
  const bytes = new Uint8Array(await csvRes.arrayBuffer());
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  const rows = Number(csvRes.headers.get("x-row-count"));
  check("export: 200 text/csv download, no-store, nosniff", csvRes.status === 200 && /^text\/csv/.test(csvRes.headers.get("content-type") ?? "") && csvRes.headers.get("cache-control") === "no-store" && csvRes.headers.get("x-content-type-options") === "nosniff");
  check(
    "export: attachment named lead-engine-usage-all-<day>.csv",
    /^attachment; filename="lead-engine-usage-all-\d{4}-\d{2}-\d{2}\.csv"$/.test(csvRes.headers.get("content-disposition") ?? ""),
    csvRes.headers.get("content-disposition"),
  );
  check("export: starts with a UTF-8 BOM and the header row", hasBom && csv.startsWith("\uFEFF") && lines[0] === CSV_COLUMNS.join(","));
  check(`export: every ledger row is there (${rows} rows)`, rows === lines.length - 1 && rows >= before && rows <= after, { rows, before, after });
  const todayCsv = await (await exportRoute.GET(request("/api/admin/export?window=today"))).text();
  const midnight = windowStart("today")?.toISOString() ?? "";
  const todayRows = todayCsv.replace(/^\uFEFF/, "").trimEnd().split("\r\n").slice(1);
  check("export today: every row is from today (UTC)", todayRows.every((l) => l.slice(0, 24) >= midnight), todayRows.slice(0, 2).map((l) => l.slice(0, 24)));
  check("export: bad window is 400", (await exportRoute.GET(request("/api/admin/export?window=1y"))).status === 400);
}

// ------------------------------------------------------------------ 5. balances (mocked fetch)

interface Seen {
  url: string;
  headers: Record<string, string>;
  method: string;
}

/** Routes provider hosts to `answer`; anything else (Neon) goes to the real fetch. */
function mockProviders(answer: (url: URL, seen: Seen) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  const unipileHost = (() => {
    try {
      const dsn = env.UNIPILE_DSN ?? "";
      return new URL(/^https?:\/\//.test(dsn) ? dsn : `https://${dsn}`).hostname;
    } catch {
      return "";
    }
  })();
  const providerHosts = new Set(["api.hunter.io", "openrouter.ai", "api.apify.com", "api.apollo.io", "admin-api.exa.ai", unipileHost].filter(Boolean));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!providerHosts.has(url.hostname)) return realFetch(input, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const s = { url: url.href, headers, method: init?.method ?? "GET" };
    seen.push(s);
    return answer(url, s);
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
    plan_level: 0,
    reset_date: "2026-12-01",
    team_id: 1,
    requests: { credits: { used: 13, available: 50, remaining: 37 }, searches: { used: 13, available: 50, remaining: 37 }, verifications: { used: 0, available: 100, remaining: 100 } },
    calls: { _deprecation_notice: "x", used: 13, available: 150 },
  },
};
const OPENROUTER_OK = { data: { label: "sk-or-v1-abc...xyz", limit: 20, limit_remaining: 17.5, limit_reset: "monthly", usage: 2.5, usage_daily: 0.1, usage_weekly: 0.6, usage_monthly: 2.5, is_free_tier: false } };
const APIFY_OK = { data: { monthlyUsageCycle: { startAt: "2026-11-02T00:00:00.000Z", endAt: "2026-12-01T23:59:59.999Z" }, limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 1.25 } } };
const APOLLO_OK = { credit_usage_stats: { lead_credit: { limit: 100, consumed: 12, left_over: 88 } }, current_credit_cycle: { start_date: "2026-11-01T00:00:00.000Z", end_date: "2026-12-01T00:00:00.000Z" } };
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
    typeof b.numbers === "object" &&
    Object.values(b.numbers).every((n) => typeof n === "number" && Number.isFinite(n)) &&
    ["live", "ledger", "unavailable"].includes(b.source) &&
    (b.note === null || typeof b.note === "string") &&
    Number.isFinite(Date.parse(b.checkedAt))
  );
}

async function testBalances(): Promise<void> {
  section("5. balances (fetch mocked: no provider is called)");
  local();

  // Parsers on documented shapes.
  const h = hunterBalanceFrom(HUNTER_OK);
  check("hunter: credits pool -> '37 of 50 credits left', 26% used", h.source === "live" && h.summary === "37 of 50 credits left" && Math.abs((h.usedShare ?? 0) - 0.26) < 1e-9, h);
  check("hunter: never shows the account's name or email", !JSON.stringify(h).includes("owner@example.com") && !JSON.stringify(h).includes("Owner"));
  const hs = hunterBalanceFrom({ data: { requests: { searches: { used: 5, available: 25 } } } });
  check("hunter: searches-only plan, remaining derived", hs.summary === "20 of 25 searches left", hs.summary);
  let threw = false;
  try {
    hunterBalanceFrom({ data: {} });
  } catch {
    threw = true;
  }
  check("hunter: an unknown shape throws (and the round turns it into 'unavailable')", threw);

  const o = openrouterBalanceFrom(OPENROUTER_OK);
  check("openrouter: key limit -> '$17.50 of $20.00 key limit left'", o.summary === "$17.50 of $20.00 key limit left" && Math.abs((o.usedShare ?? 0) - 0.125) < 1e-9, o.summary);
  check("openrouter: daily, weekly, monthly usage in numbers and note", o.numbers.usageDaily === 0.1 && o.numbers.usageWeekly === 0.6 && /this week/.test(o.note ?? ""));
  check("openrouter: the key label is never read", !JSON.stringify(o).includes("sk-or"));
  const ou = openrouterBalanceFrom({ data: { limit: null, limit_remaining: null, usage: 3, usage_daily: 0, usage_weekly: 1, usage_monthly: 2 } });
  check("openrouter: no limit -> 'No limit on this key · $2.00 this month'", ou.summary === "No limit on this key · $2.00 this month" && ou.usedShare === null, ou.summary);
  const ob = openrouterBalanceFrom({ data: { limit: null, usage: 1, usage_monthly: 1, effective_budget: { limit_usd: 10, remaining_usd: 4 } } });
  check("openrouter: a workspace budget when the key has no limit", ob.summary === "$4.00 of $10.00 budget left" && Math.abs((ob.usedShare ?? 0) - 0.6) < 1e-9, ob.summary);

  const a = apifyBalanceFrom(APIFY_OK);
  check("apify: '$1.25 of $5.00 used this cycle', 25%", a.summary === "$1.25 of $5.00 used this cycle" && a.usedShare === 0.25 && /Dec 1/.test(a.note ?? ""), a);
  const ap = apolloBalanceFrom(APOLLO_OK);
  check("apollo: lead credits '88 of 100 credits left'", ap.summary === "88 of 100 credits left" && Math.abs((ap.usedShare ?? 0) - 0.12) < 1e-9, ap.summary);

  const u = unipileBalanceFrom(UNIPILE_OK, 12, null);
  check("unipile: '12 of ~100 LinkedIn requests today', account running", u.source === "live" && u.summary === "12 of ~100 LinkedIn requests today" && u.usedShare === 0.12 && /running/.test(u.note ?? ""), u);
  check("unipile: never shows the account name", !JSON.stringify(u).includes("Someone"));
  const uc = unipileBalanceFrom({ items: [{ type: "LINKEDIN", id: "a", sources: [{ status: "CREDENTIALS" }] }] }, 0, null);
  check("unipile: a disconnected account says it needs attention", /needs attention.*CREDENTIALS/.test(uc.note ?? ""), uc.note);
  const uf = unipileBalanceFrom(null, 3, "Could not reach the provider.");
  check("unipile: unreachable -> ledger count with the reason", uf.source === "ledger" && uf.summary.startsWith("3 of ~100") && /Could not check/.test(uf.note ?? ""));
  setEnv({ UNIPILE_ACCOUNT_ID: "acc_missing" });
  check("unipile: a pinned account that is not there is named", /does not match/.test(unipileBalanceFrom(UNIPILE_OK, 0, null).note ?? ""));
  setEnv({ UNIPILE_ACCOUNT_ID: originalEnv.UNIPILE_ACCOUNT_ID });

  const r1 = unipileRoutes("https://api9.unipile.example:14914");
  check("unipile routes: DSN port, then 443 with ?port=", r1.length === 2 && r1[0].base === "https://api9.unipile.example:14914" && r1[1].base === "https://api9.unipile.example" && r1[1].portParam === "14914");
  check("unipile routes: no port -> one route; /api/v1 suffix dropped", unipileRoutes("api9.unipile.example/api/v1/").length === 1);
  check("unipile routes: unparseable or missing -> none", unipileRoutes("https://bad host:1").length === 0 && unipileRoutes("").length === 0 && unipileRoutes(undefined).length === 0);

  check("describeFailure: 401 names the key variable, never a value", describeFailure(new HttpError(401, "body", "https://api.hunter.io/v2/account"), "HUNTER_API_KEY") === "The key was refused (401). Check HUNTER_API_KEY.");
  check(
    "describeFailure: 429, 500, timeout, network",
    [
      describeFailure(new HttpError(429, "", "https://x.example/")),
      describeFailure(new HttpError(503, "", "https://x.example/")),
      describeFailure(Object.assign(new Error("t"), { name: "TimeoutError" })),
      describeFailure(new TypeError("fetch failed")),
    ].join("|") === "Rate-limited (429). Try again in a minute.|The provider had a server error (503).|No answer within 8 s.|Could not reach the provider.",
  );

  // The whole round, with fetch mocked.
  const keys = ["HUNTER_API_KEY", "OPENROUTER_API_KEY", "APIFY_TOKEN", "APOLLO_API_KEY", "UNIPILE_API_KEY", "EXA_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL"]
    .map((k) => env[k]?.trim())
    .filter((v): v is string => Boolean(v && v.length >= 8));
  const leaks = (text: string) => keys.some((k) => text.includes(k)) || text.includes(TEAM_PW) || text.includes(SECRET);

  resetBalanceCache();
  let seen = mockProviders((url) => standardAnswer(url));
  try {
    const first = await getBalances();
    check("round: 10 balances in USAGE_PROVIDERS order", first.balances.map((b) => b.provider).join() === USAGE_PROVIDERS.join(), first.balances.map((b) => b.provider));
    check("round: fresh (not cached)", first.cached === false);
    const by = new Map(first.balances.map((b) => [b.provider, b]));
    for (const p of ["hunter", "openrouter", "apify", "apollo", "unipile"] as const) {
      const configured = Boolean(env[{ hunter: "HUNTER_API_KEY", openrouter: "OPENROUTER_API_KEY", apify: "APIFY_TOKEN", apollo: "APOLLO_API_KEY", unipile: "UNIPILE_API_KEY" }[p]]);
      check(`round: ${p} is ${configured ? "live" : "not configured"}`, by.get(p)?.source === (configured ? "live" : "unavailable"), by.get(p));
    }
    for (const p of ["anthropic", "exa", "huggingface"] as const) check(`round: ${p} comes from the ledger`, by.get(p)?.source === "ledger", by.get(p));
    check("round: anthropic says why there is no live balance", /Admin API key/.test(by.get("anthropic")?.note ?? ""));
    check("round: exa says why there is no live balance", /service key/.test(by.get("exa")?.note ?? ""));
    check("round: every entry has the contract fields", first.balances.every(validBalance), first.balances.filter((b) => !validBalance(b)));
    const perHost = new Map<string, number>();
    for (const s of seen) perHost.set(new URL(s.url).hostname, (perHost.get(new URL(s.url).hostname) ?? 0) + 1);
    check(
      "round: one call per provider (Unipile: blocked port, then the 443 route)",
      [...perHost.entries()].every(([host, n]) => n === 1 || (n === 2 && !["api.hunter.io", "openrouter.ai", "api.apify.com", "api.apollo.io"].includes(host))),
      [...perHost.entries()].map(([, n]) => n),
    );
    const unipileCalls = seen.filter((s) => s.url.includes("/api/v1/accounts"));
    if (env.UNIPILE_API_KEY && /:\d+/.test(env.UNIPILE_DSN ?? "")) {
      check("unipile fallback: the 443 route carries ?port=", unipileCalls.length === 2 && /[?&]port=\d+/.test(unipileCalls[1].url));
    }
    check("round: no key in any URL", seen.every((s) => !leaks(s.url)));
    check("round: keys travel in headers (X-API-KEY, x-api-key or Bearer)", seen.every((s) => Boolean(s.headers["x-api-key"] || /^Bearer /.test(s.headers.authorization ?? ""))));
    check("round: Apollo uses POST", seen.filter((s) => s.url.includes("apollo")).every((s) => s.method === "POST"));
    check("round: nothing returned contains a key or password", !leaks(JSON.stringify(first)));

    const callsBefore = seen.length;
    const second = await getBalances();
    check("cache: a second read within 60 s is cached, no calls", second.cached === true && seen.length === callsBefore && second.checkedAt === first.checkedAt);
    const forced = await getBalances({ refresh: true });
    check("cache: a forced refresh within 15 s is still cached", forced.cached === true && seen.length === callsBefore);
    const [c1, c2] = await Promise.all([(resetBalanceCache(), getBalances()), getBalances()]);
    const round2 = new Map<string, number>();
    for (const s of seen.slice(callsBefore)) round2.set(new URL(s.url).hostname, (round2.get(new URL(s.url).hostname) ?? 0) + 1);
    check(
      "cache: concurrent readers share one round (one call per provider; Unipile goes straight to the route that worked)",
      c1.checkedAt === c2.checkedAt && round2.size === perHost.size && [...round2.values()].every((n) => n === 1),
      [...round2.values()],
    );

    // The route handler on top, from this computer.
    const routeRes = await balancesRoute.GET(request("/api/admin/balances"));
    const routeBody = await jsonOf<AdminBalancesResponse>(routeRes);
    check("GET /api/admin/balances: 200 with 10 balances (cached), noindex", routeRes.status === 200 && routeBody?.balances.length === 10 && routeBody.cached === true && /noindex/.test(routeRes.headers.get("x-robots-tag") ?? ""));
  } finally {
    globalThis.fetch = realFetch;
  }

  // Failures: errors, garbage, an echoed key. Nothing throws, nothing leaks.
  resetBalanceCache();
  const echoed = env.HUNTER_API_KEY ?? "";
  seen = mockProviders((url) => {
    if (url.hostname === "api.hunter.io") return jsonResponse({ data: { plan_name: echoed.slice(0, 39), requests: { credits: { used: 1, available: 2, remaining: 1 } } } });
    if (url.hostname === "openrouter.ai") return jsonResponse({ error: { message: `bad key ${env.OPENROUTER_API_KEY}` } }, 401);
    if (url.hostname === "api.apify.com") return new Response("<html>oops</html>", { status: 200 });
    if (url.hostname === "api.apollo.io") return jsonResponse({ error: "This API key is not authorized", error_code: "API_INACCESSIBLE" }, 403);
    throw new TypeError("fetch failed");
  });
  try {
    const bad = await getBalances();
    const by = new Map(bad.balances.map((b) => [b.provider, b]));
    check("failures: still 10 balances, no exception", bad.balances.length === 10);
    if (env.OPENROUTER_API_KEY) check("failures: openrouter 401 -> unavailable, names the key variable", by.get("openrouter")?.source === "unavailable" && /401\). Check OPENROUTER_API_KEY/.test(by.get("openrouter")?.note ?? ""), by.get("openrouter"));
    if (env.APIFY_TOKEN) check("failures: apify garbage -> unavailable, unreadable answer", by.get("apify")?.source === "unavailable" && /unreadable/.test(by.get("apify")?.note ?? ""), by.get("apify"));
    if (env.APOLLO_API_KEY) {
      check(
        "failures: apollo 403 -> unavailable with the reason (master key) and the ledger's credits",
        by.get("apollo")?.source === "unavailable" && /master API key/.test(by.get("apollo")?.note ?? "") && /ledger counts/.test(by.get("apollo")?.note ?? ""),
        by.get("apollo"),
      );
    }
    if (env.UNIPILE_API_KEY) check("failures: unipile unreachable -> ledger count, reason given", by.get("unipile")?.source === "ledger" && /Could not check the account/.test(by.get("unipile")?.note ?? ""), by.get("unipile"));
    check("failures: no key value anywhere in the output (an echoed key is hidden)", !leaks(JSON.stringify(bad)));
    check("failures: every entry still has the contract fields", bad.balances.every(validBalance));
  } finally {
    globalThis.fetch = realFetch;
  }
  resetBalanceCache();
}

// ------------------------------------------------------------------ 6. format, CSV, npm script

function testFormat(): void {
  section("6. format, CSV and the npm script");
  check("csv: plain text unchanged", csvCell("Pieter Abbeel") === "Pieter Abbeel");
  check("csv: commas and quotes quoted", csvCell('Acme, "Robots"') === '"Acme, ""Robots"""');
  check("csv: line breaks quoted", csvCell("a\nb") === '"a\nb"');
  for (const bad of ['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
    check(`csv: formula-like ${JSON.stringify(bad.slice(0, 12))} neutralised`, csvCell(bad).replace(/^"/, "").startsWith("'"));
  }
  check("csv: null and numbers", csvCell(null) === "" && csvCell(0.007) === "0.007" && csvCell(true) === "true");
  check("csv: units as key=value", unitsCell({ inputTokens: 443, outputTokens: 10, junk: "x" }) === "inputTokens=443; outputTokens=10");

  const usd = [formatUsd(0), formatUsd(0.00004), formatUsd(0.007), formatUsd(0.0017), formatUsd(0.10124), formatUsd(0.42), formatUsd(0.5), formatUsd(12.5), formatUsd(1234.5), formatUsd(null)].join(" ");
  check("money: $0, a sliver, sub-cent, cents, dollars, missing", usd === "$0 <$0.0001 $0.007 $0.0017 $0.1012 $0.42 $0.50 $12.50 $1,234.50 –", usd);
  const compact = [compactCount(940), compactCount(12_345), compactCount(84_526), compactCount(590_173), compactCount(999_950), compactCount(1_250_000)].join(" ");
  check("compact counts", compact === "940 12.3K 84.5K 590K 1M 1.3M", compact);
  check("counts in full below 10,000, fractional credits kept", formatCount(9_999) === "9,999" && formatCount(0.5) === "0.5" && formatCount(12_345) === "12.3K");
  check("plural", plural(1, "call") === "1 call" && plural(3, "search", "searches") === "3 searches" && plural(0, "request") === "0 requests");
  check("share", [formatShare(0), formatShare(0.004), formatShare(0.26), formatShare(0.996), formatShare(1)].join(" ") === "0% <1% 26% 99% 100%");
  check("ms", [formatMs(null), formatMs(340), formatMs(2_345), formatMs(45_000), formatMs(125_000)].join("|") === "|340 ms|2.3 s|45 s|2 min 5 s");
  check("units line (one row)", unitsLine({ outputTokens: 26, inputTokens: 411, cacheReadTokens: 0 }) === "411 input tokens · 26 output tokens");
  check("units line keeps unknown units", unitsLine({ searches: 1, results: 3, widgets: 2 }) === "1 search · 3 results · 2 widgets");
  check("key units: anthropic", keyUnitsLine("anthropic", { inputTokens: 590_173, outputTokens: 84_526 }) === "590K in · 84.5K out tokens");
  check("key units: exa", keyUnitsLine("exa", { searches: 27, contents: 3, results: 1 }) === "27 searches · 3 pages read");
  check("key units: openrouter, hunter", keyUnitsLine("openrouter", { requests: 4, xPosts: 14, promptTokens: 900 }) === "4 X searches · 14 X posts" && keyUnitsLine("hunter", { lookups: 3, credits: 1 }) === "3 lookups · 1 credit");
  check("key units: nothing counted is empty", keyUnitsLine("hubspot", {}) === "" && keyUnitsLine("anthropic", {}) === "");
  check("main unit: anthropic, hunter, openrouter", mainUnit("anthropic", { inputTokens: 177_599, outputTokens: 22_440 }) === "200K tokens" && mainUnit("hunter", { lookups: 1, credits: 1 }) === "1 lookup" && mainUnit("openrouter", { requests: 3, xPosts: 10 }) === "3 X searches");

  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
  check("npm run admin: next dev bound to 127.0.0.1 on port 3001", pkg.scripts?.admin === "next dev -H 127.0.0.1 -p 3001", pkg.scripts?.admin);
}

// ------------------------------------------------------------------ live (opt-in)

async function liveBalances(): Promise<void> {
  section("live balances (one call per provider)");
  restoreEnv();
  resetBalanceCache();
  const { balances } = await getBalances();
  for (const b of balances) console.log(`  ${b.provider.padEnd(12)} ${b.source.padEnd(11)} ${b.summary}${b.note ? `  | ${b.note}` : ""}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  try {
    testFormat();
    testAccess();
    await testProxy();
    await testLayout();
    await testRoutes();
    await testBalances();
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
