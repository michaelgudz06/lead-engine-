/**
 * Tests for the API layer (api agent): auth, proxy, route handlers and HubSpot.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-api.ts
 *
 * 1. auth     password check; session token valid / tampered / expired / wrong secret; cookie attributes
 * 2. proxy    the matcher as Next compiles it, and every gate decision: login ?next= open-redirect
 *             cases, cross-site write refusal (CSRF), and the Vercel lock without APP_PASSWORD
 * 3. routes   the real handlers against Neon with one temp lead: create, duplicate, get, patch,
 *             sent, events, research and steer claims, settings, status, login/logout, delete.
 *             Handlers run inside a minimal Next request scope whose after() only records the
 *             task: research is claimed but never run, so no provider or Claude credit is spent.
 * 4. hubspot  pushLeadToHubSpot against a mocked HubSpot API (no token, no network)
 * 5. guards   against Neon with temp leads: the stage rule when a run ends, the stale-run reaper
 *             (research_started_at backdated) and the hourly and daily run caps (le_run_starts
 *             rows on temp leads, including a concurrent burst; all removed at the end)
 * 6. qualify  unqualified leads: the restore mapping and the reason rules (pure), POST
 *             /api/leads/bulk validation, then against Neon with temp leads named "LE Qualify
 *             Test ...": the list views and counts, bulk unqualify, restore and delete (rules read
 *             back from the rows, events, missing ids), marking twice, PATCH both ways, the 409s'
 *             existingStage, research on an unqualified lead (repo functions only, never a run),
 *             and the SQL restore mapping against the pure one. The old deployed code cannot show
 *             an unqualified lead, so each block keeps its leads unqualified for as few queries
 *             as it can and deletes them in a finally; a count at the end confirms none is left.
 * 7. warm paths  only against a LOCAL test database (it writes le_settings and le_network_*; it
 *             refuses otherwise): the proxy on the new routes, GET /api/network, Settings handles,
 *             Connections.csv parts (limits, bad rows, 409, 413, 415), POST /paths (every outcome
 *             and status), the free recompute on GET (once, never during research or a check, never
 *             over a newer write), invalidation (lead X handle, your X handle, a new upload, a
 *             delete, a new LinkedIn URL), intro drafts (the Claude request, the 100-a-day cap,
 *             refusals), "asked" notes, the Instagram handle, Read now, Refresh now, the step-2
 *             budget, and the api-client helpers through the same handlers. twitterapi.io,
 *             Unipile and Claude are mocked with fake keys (any other host fails the section), the
 *             app runs open as the live deploy does, and no contact list or name may reach a
 *             reply of /api/network, a server log line or more than 5 company people.
 *
 * Prints statuses and short snippets only: never a key, token, cookie value or header.
 */
// First, as in Next's own server: installs globalThis.AsyncLocalStorage, which the
// request-scope modules below need when they load.
import "next/dist/server/node-environment-baseline";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import * as leadsRoute from "../src/app/api/leads/route";
import * as bulkRoute from "../src/app/api/leads/bulk/route";
import * as leadRoute from "../src/app/api/leads/[id]/route";
import * as researchRoute from "../src/app/api/leads/[id]/research/route";
import * as steerRoute from "../src/app/api/leads/[id]/steer/route";
import * as sentRoute from "../src/app/api/leads/[id]/sent/route";
import * as eventsRoute from "../src/app/api/leads/[id]/events/route";
import * as hubspotRoute from "../src/app/api/leads/[id]/hubspot/route";
import * as settingsRoute from "../src/app/api/settings/route";
import * as statusRoute from "../src/app/api/status/route";
import * as loginRoute from "../src/app/api/login/route";
import * as logoutRoute from "../src/app/api/logout/route";
import * as pathsRoute from "../src/app/api/leads/[id]/paths/route";
import * as pathRoute from "../src/app/api/leads/[id]/paths/[pathId]/route";
import * as introRoute from "../src/app/api/leads/[id]/paths/[pathId]/intro/route";
import * as networkRoute from "../src/app/api/network/route";
import * as connectionsRoute from "../src/app/api/network/linkedin/connections/route";
import * as selfRoute from "../src/app/api/network/linkedin/self/route";
import * as xSyncRoute from "../src/app/api/network/x/sync/route";
import { isPathId } from "../src/app/api/_lib/paths";
import * as client from "../src/lib/api-client";
import { noPathsCopy } from "../src/lib/paths/copy";
import { publicPathId } from "../src/lib/paths/ids";
import { INTRO_SYSTEM, introPrompt } from "../src/lib/paths/intro";
import type { WarmPath, WarmPaths } from "../src/lib/paths/types";
import { resetUnipileState } from "../src/lib/providers/linkedin";
import { insertFindings } from "../src/lib/repo/findings";
import { claimNetworkSource, saveNetworkSource } from "../src/lib/repo/network";
import { claimWarmPathCheck, getWarmPathRow, releaseWarmPathCheck, saveIntro, saveWarmPathResult } from "../src/lib/repo/paths";
import {
  DEFAULT_RUNS_PER_DAY,
  DEFAULT_RUNS_PER_HOUR,
  isStaleRun,
  runLimitEvent,
  runLimitMessage,
  runLimits,
  serverError,
  STALE_RUN_MS,
} from "../src/app/api/_lib/api";
import { proxy, config as proxyConfig } from "../src/proxy";
import {
  authConfigError,
  authEnabled,
  checkPassword,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookie,
  verifySessionToken,
} from "../src/lib/auth";
import { normaliseDomain, pushLeadToHubSpot, pushToHubSpot, splitName } from "../src/lib/providers/hubspot";
import { query } from "../src/lib/db";
import { nextAction, sortNeedsYouFirst } from "../src/lib/next-action";
import {
  cleanUnqualifiedReason,
  justMarked,
  restoredEventMessage,
  restoredStage,
  stageChangedEventMessage,
  stageEventMessages,
  unqualifiedEventMessage,
  type RestoreInput,
} from "../src/lib/qualify";
import { listEvents } from "../src/lib/repo/events";
import {
  claimResearch,
  countLeads,
  createLead,
  deleteLead,
  failStaleResearch,
  finishResearch,
  getLead,
  setLeadLinkedin,
  setResearchStep,
  updateLead,
  type LeadPatch,
} from "../src/lib/repo/leads";
import { DELETE_LEADS_SQL, deleteLeads, restoreLeads, uniqueLeadIds, unqualifyLeads } from "../src/lib/repo/qualify";
import { getSettings, saveSettings } from "../src/lib/repo/settings";
import {
  ACTIVE_STAGES,
  BULK_LEADS_MAX,
  STAGE_LABELS,
  STAGES,
  UNQUALIFIED_REASONS,
  type ActiveStage,
  type Angle,
  type Brief,
  type Lead,
  type LeadEvent,
  type ResearchStatus,
} from "../src/lib/types";

// ------------------------------------------------------------------ compile-time checks
// The same shape Next's generated validator (.next/types/validator.ts) requires of route
// files; `npx tsc --noEmit` fails here if a handler signature drifts.
type Handler<P> = (request: NextRequest, context: { params: Promise<P> }) => Promise<Response | void> | Response | void;
type RouteHandlerConfig<P> = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS", Handler<P>>>;
type NoParams = Record<string, never>;
void (leadsRoute satisfies RouteHandlerConfig<NoParams>);
void (bulkRoute satisfies RouteHandlerConfig<NoParams>);
void (leadRoute satisfies RouteHandlerConfig<{ id: string }>);
void (researchRoute satisfies RouteHandlerConfig<{ id: string }>);
void (steerRoute satisfies RouteHandlerConfig<{ id: string }>);
void (sentRoute satisfies RouteHandlerConfig<{ id: string }>);
void (eventsRoute satisfies RouteHandlerConfig<{ id: string }>);
void (hubspotRoute satisfies RouteHandlerConfig<{ id: string }>);
void (settingsRoute satisfies RouteHandlerConfig<NoParams>);
void (statusRoute satisfies RouteHandlerConfig<NoParams>);
void (loginRoute satisfies RouteHandlerConfig<NoParams>);
void (logoutRoute satisfies RouteHandlerConfig<NoParams>);
void (pathsRoute satisfies RouteHandlerConfig<{ id: string }>);
void (pathRoute satisfies RouteHandlerConfig<{ id: string; pathId: string }>);
void (introRoute satisfies RouteHandlerConfig<{ id: string; pathId: string }>);
void (networkRoute satisfies RouteHandlerConfig<NoParams>);
void (connectionsRoute satisfies RouteHandlerConfig<NoParams>);
void (selfRoute satisfies RouteHandlerConfig<NoParams>);
void (xSyncRoute satisfies RouteHandlerConfig<NoParams>);

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

const GATE_KEYS = ["APP_PASSWORD", "SESSION_SECRET", "HUBSPOT_ACCESS_TOKEN", "VERCEL", "RUN_LIMIT_PER_HOUR", "RUN_LIMIT_PER_DAY"] as const;
const originalEnv = Object.fromEntries(GATE_KEYS.map((k) => [k, process.env[k]]));
function setEnv(vars: Partial<Record<(typeof GATE_KEYS)[number], string | undefined>>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv(): void {
  setEnv(originalEnv as Record<(typeof GATE_KEYS)[number], string | undefined>);
}

const PASSWORD = "correct horse battery staple";
const SECRET = randomBytes(32).toString("hex"); // generated here, never printed
const DAY = 86_400_000;

/**
 * Leads whose run slots (le_run_starts rows) the tests may have taken. Those rows have no
 * foreign key, so they outlive the temp leads; main() deletes them at the end so the tests
 * never use up the real hourly and daily caps.
 */
const runLeadIds = new Set<string>();

/** Tasks handed to next/server after() during route calls. Recorded only, never run. */
const afterTasks: unknown[] = [];

interface CallResult {
  status: number;
  data: Record<string, unknown> | null;
  headers: Headers;
}

/** Route calls in progress (section 7 records what the server logs meanwhile). */
let routeDepth = 0;

/** Runs fn inside a minimal Next request scope (enough for after() and connection()). after() tasks are recorded, never run. */
async function inRequestScope<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: path,
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: (task: unknown) => void afterTasks.push(task) },
  };
  const unitStore = { type: "request", phase: "action" };
  routeDepth++;
  try {
    return await workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run(unitStore as never, fn));
  } finally {
    routeDepth--;
  }
}

/** Runs a route handler inside a minimal Next request scope. params defaults to { id }. */
async function callRoute(
  handler: (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  opts: { method?: string; path: string; body?: unknown; rawBody?: string; id?: string; params?: Record<string, string>; headers?: Record<string, string> },
): Promise<CallResult> {
  const method = opts.method ?? "GET";
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const request = new NextRequest(new URL(opts.path, "http://localhost:3000"), {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: method === "GET" ? undefined : body,
  });
  const ctx = { params: Promise.resolve((opts.params ?? { id: opts.id ?? "" }) as { id: string }) };
  const res = await inRequestScope(opts.path, () => handler(request, ctx));
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers };
}

const asHandler = (fn: unknown) => fn as (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Runs fn and returns what it wrote with console.warn meanwhile (the bulk route's log lines), without printing it. */
async function warnsDuring<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = warn;
  }
}

// ------------------------------------------------------------------ 1. auth

async function testAuth(): Promise<void> {
  section("1. auth");
  setEnv({ APP_PASSWORD: undefined, SESSION_SECRET: undefined });
  check("gate off without APP_PASSWORD", authEnabled() === false && authConfigError() === null);
  check("checkPassword is false with the gate off", (await checkPassword("anything")) === false);
  check("verifySessionToken is false with the gate off", (await verifySessionToken("v1.1.x")) === false);

  setEnv({ APP_PASSWORD: PASSWORD, SESSION_SECRET: undefined });
  check("gate on, missing secret is a config error", authEnabled() && /SESSION_SECRET is not set/.test(authConfigError() ?? ""));
  let threw = false;
  try {
    await createSessionToken();
  } catch {
    threw = true;
  }
  check("createSessionToken refuses without a secret", threw);
  setEnv({ SESSION_SECRET: "short" });
  check("a short secret is a config error", /too short/.test(authConfigError() ?? ""));

  setEnv({ SESSION_SECRET: SECRET });
  check("gate on and configured", authEnabled() && authConfigError() === null);
  check("right password", await checkPassword(PASSWORD));
  check("right password with stray spaces", await checkPassword(`  ${PASSWORD} `));
  check("wrong password", !(await checkPassword("correct horse battery stapl")));
  check("empty password", !(await checkPassword("")));
  check("oversized password", !(await checkPassword("x".repeat(5000))));

  const now = Date.now();
  const token = await createSessionToken(now);
  const [, expiry, mac] = token.split(".");
  check("token shape v1.<expiry>.<mac>", /^v1\.\d{13}\.[A-Za-z0-9_-]{43}$/.test(token));
  check("token expires in 30 days", Number(expiry) - now === SESSION_MAX_AGE_SECONDS * 1000);
  check("valid token verifies", await verifySessionToken(token, now));
  check("valid token verifies on day 29", await verifySessionToken(token, now + 29 * DAY));

  const flip = (c: string) => (c === "A" ? "B" : "A");
  check("tampered MAC (first char) is refused", !(await verifySessionToken(`v1.${expiry}.${flip(mac[0])}${mac.slice(1)}`, now)));
  const longer = String(Number(expiry) + 1000);
  check("tampered expiry is refused", !(await verifySessionToken(`v1.${longer}.${mac}`, now)));
  // The last base64url char carries 2 unused bits: a variant decodes to the same bytes and must still fail.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = mac[mac.length - 1];
  const variant = alphabet[alphabet.indexOf(last) ^ 1];
  check("non-canonical MAC spelling is refused", !(await verifySessionToken(`v1.${expiry}.${mac.slice(0, -1)}${variant}`, now)));
  check("expired token is refused", !(await verifySessionToken(token, Number(expiry) + 1)));
  const old = await createSessionToken(now - 31 * DAY);
  check("token issued 31 days ago is refused", !(await verifySessionToken(old, now)));
  const future = await createSessionToken(now + 2 * DAY);
  check("token from the future (beyond max age) is refused", !(await verifySessionToken(future, now)));
  for (const [label, bad] of [
    ["empty", ""],
    ["prefix only", "v1."],
    ["garbage", "garbage"],
    ["unknown version", "v2.1234567890123.abc"],
    ["MAC with an extra char", `v1.${expiry}.${mac}x`],
    ["oversized", "x".repeat(500)],
  ] as const) {
    check(`malformed token refused: ${label}`, !(await verifySessionToken(bad, now)));
  }
  check("missing token refused", !(await verifySessionToken(undefined, now)) && !(await verifySessionToken(null, now)));

  setEnv({ SESSION_SECRET: randomBytes(32).toString("hex") });
  check("a different SESSION_SECRET refuses the old token", !(await verifySessionToken(token, now)));
  setEnv({ SESSION_SECRET: SECRET, APP_PASSWORD: "a new team password" });
  check("changing APP_PASSWORD signs everyone out", !(await verifySessionToken(token, now)));
  setEnv({ APP_PASSWORD: PASSWORD });
  check("the original token verifies again with the original settings", await verifySessionToken(token, now));

  const cookie = sessionCookie("value");
  check(
    "cookie: le_session, HttpOnly, SameSite=Lax, Path=/, 30 days",
    cookie.name === SESSION_COOKIE && cookie.name === "le_session" && cookie.httpOnly && cookie.sameSite === "lax" && cookie.path === "/" && cookie.maxAge === 30 * 86400,
  );
  check(`cookie: Secure only in production (NODE_ENV=${process.env.NODE_ENV ?? "unset"})`, cookie.secure === (process.env.NODE_ENV === "production"));
  check("clearing cookie has maxAge 0", sessionCookie("", 0).maxAge === 0);
}

// ------------------------------------------------------------------ 2. proxy

async function testProxy(): Promise<void> {
  section("2. proxy");
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config: proxyConfig, url });
  for (const url of ["/", "/leads/abc", "/leads/new", "/pipeline", "/settings", "/login", "/api/leads", "/api/status", "/api/login", "/opengraph-image"]) {
    check(`matcher runs on ${url}`, matches(url));
  }
  for (const url of ["/_next/static/chunks/main.js", "/_next/image?url=%2Fa.png&w=64&q=75", "/favicon.ico", "/robots.txt", "/icon.png", "/fonts/inter.woff2", "/manifest.webmanifest"]) {
    check(`matcher skips ${url}`, !matches(url));
  }

  const run = async (path: string, cookie?: string) => {
    const req = new NextRequest(new URL(path, "http://localhost:3000"), cookie ? { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } } : undefined);
    return proxy(req);
  };
  /** Any method, with browser headers such as Sec-Fetch-Site and Origin. */
  const send = async (method: string, path: string, headers: Record<string, string> = {}, cookie?: string) =>
    proxy(new NextRequest(new URL(path, "http://localhost:3000"), { method, headers: { ...headers, ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) } }));
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
  const redirectsTo = (res: Response) => (res.status === 307 || res.status === 308 ? res.headers.get("location") : null);
  const refusedCrossSite = async (res: Response) =>
    res.status === 403 && res.headers.get("cache-control") === "no-store" && /Cross-site/.test(((await res.json()) as { error?: string }).error ?? "");
  const CROSS_SITE = { "sec-fetch-site": "cross-site" };
  const SAME_ORIGIN = { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" };

  setEnv({ APP_PASSWORD: undefined, SESSION_SECRET: undefined });
  check("gate off: pages pass", passes(await run("/")));
  check("gate off: API passes", passes(await run("/api/leads")));

  // Cross-site writes (CSRF) are refused before the gate, so a local run with the gate off is covered.
  check("gate off: cross-site POST /api/leads is 403", await refusedCrossSite(await send("POST", "/api/leads", CROSS_SITE)));
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    check(`gate off: cross-site ${method} is 403`, await refusedCrossSite(await send(method, "/api/settings", CROSS_SITE)));
  }
  check("gate off: same-site POST (a sibling subdomain) is 403", await refusedCrossSite(await send("POST", "/api/leads", { "sec-fetch-site": "same-site" })));
  check("gate off: POST with a foreign Origin and no Sec-Fetch-Site is 403", await refusedCrossSite(await send("POST", "/api/leads", { origin: "https://evil.example" })));
  check("gate off: POST with Origin null (sandboxed frame) is 403", await refusedCrossSite(await send("POST", "/api/leads", { origin: "null" })));
  check("gate off: POST from another local port is 403", await refusedCrossSite(await send("POST", "/api/leads", { origin: "http://localhost:3001" })));
  check("gate off: cross-site POST to a page path is 403 too", await refusedCrossSite(await send("POST", "/leads/new", CROSS_SITE)));
  check("gate off: cross-site POST /api/leads/bulk (unqualify, restore, delete) is 403", await refusedCrossSite(await send("POST", "/api/leads/bulk", CROSS_SITE)));
  check("gate off: a foreign Origin on POST /api/leads/bulk is 403", await refusedCrossSite(await send("POST", "/api/leads/bulk", { origin: "https://evil.example" })));
  check("gate off: same-origin POST /api/leads/bulk passes", passes(await send("POST", "/api/leads/bulk", SAME_ORIGIN)));
  check("gate off: same-origin POST passes", passes(await send("POST", "/api/leads", SAME_ORIGIN)));
  check("gate off: our own Origin without Sec-Fetch-Site passes", passes(await send("POST", "/api/leads", { origin: "http://localhost:3000" })));
  check("gate off: header-less POST (a script) passes", passes(await send("POST", "/api/leads")));
  check("gate off: Sec-Fetch-Site none (user-initiated) passes", passes(await send("POST", "/api/leads", { "sec-fetch-site": "none" })));
  check("gate off: cross-site GET (a link from another site) passes", passes(await send("GET", "/api/leads", CROSS_SITE)));

  // On Vercel a missing APP_PASSWORD locks the app instead of leaving it open.
  setEnv({ VERCEL: "1" });
  for (const [method, path] of [["GET", "/"], ["GET", "/leads/new"], ["GET", "/login"], ["GET", "/api/leads"], ["POST", "/api/leads"], ["POST", "/api/login"]] as const) {
    const res = await send(method, path, method === "POST" ? SAME_ORIGIN : {});
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    check(
      `Vercel without APP_PASSWORD: ${method} ${path} is 503 JSON`,
      res.status === 503 && /APP_PASSWORD/.test(body?.error ?? "") && res.headers.get("cache-control") === "no-store",
      { status: res.status },
    );
  }
  setEnv({ VERCEL: undefined });
  check("off Vercel without APP_PASSWORD: the gate stays off", passes(await run("/api/leads")));

  setEnv({ APP_PASSWORD: PASSWORD, SESSION_SECRET: SECRET });
  const token = await createSessionToken();
  check("no session: / redirects to /login", redirectsTo(await run("/")) === "http://localhost:3000/login");
  check(
    "no session: deep link keeps next=",
    redirectsTo(await run("/leads/123?tab=angles")) === `http://localhost:3000/login?next=${encodeURIComponent("/leads/123?tab=angles")}`,
  );
  const api = await run("/api/leads");
  const apiBody = (await api.json()) as { error?: string };
  check("no session: /api/* answers 401 JSON", api.status === 401 && typeof apiBody.error === "string", { status: api.status });
  check("no session: /login passes", passes(await run("/login")));
  check("no session: /api/login passes", passes(await run("/api/login")));
  check("no session: /api/logout passes", passes(await run("/api/logout")));
  check("tampered session: /api/leads is 401", (await run("/api/leads", `${token.slice(0, -2)}AA`)).status === 401);
  check("valid session: / passes", passes(await run("/", token)));
  check("valid session: /api/leads passes", passes(await run("/api/leads", token)));
  check("valid session: /login?next=/pipeline goes to /pipeline", redirectsTo(await run("/login?next=%2Fpipeline", token)) === "http://localhost:3000/pipeline");
  check("valid session: /login?next=//evil.example goes to /", redirectsTo(await run("/login?next=%2F%2Fevil.example", token)) === "http://localhost:3000/");

  // ?next= must never leave the site. URL parsing drops tab/CR/LF, so "/<TAB>/evil.example" was "//evil.example".
  for (const [label, next] of [
    ["tab", "/%09/evil.example"],
    ["line feed", "/%0a/evil.example"],
    ["carriage return", "/%0d/evil.example"],
    ["NUL", "/%00/evil.example"],
    ["two slashes", "//evil.example"],
    ["backslash", "/%5Cevil.example"],
    ["slash, backslash", "/%5C/evil.example"],
    ["encoded slash", "/%2F/evil.example"],
    ["absolute URL", "https%3A%2F%2Fevil.example%2F"],
    // Dot segments resolve to a path that starts with "//", which the redirect would read as another host.
    ["dot segment", "/.//evil.example"],
    ["dot-dot segment", "/..//evil.example"],
    ["encoded dot segment", "/%2e//evil.example"],
    ["dot, encoded slash", "/./%2Fevil.example"],
    ["path, then dot-dot", "/pipeline/..//evil.example/x"],
    ["the login page itself", "%2Flogin%3Fnext%3D%2Fpipeline"],
  ] as const) {
    const to = redirectsTo(await run(`/login?next=${next}`, token));
    check(`valid session: ?next=${next} (${label}) goes to /`, to === "http://localhost:3000/", to);
  }
  const leadPath = "/leads/3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f";
  for (const [next, expected] of [
    [leadPath, leadPath],
    ["%2Fpipeline%3Fx%3D1", "/pipeline?x=1"],
    ["%2Fsettings%23criteria", "/settings#criteria"],
  ] as const) {
    const to = redirectsTo(await run(`/login?next=${next}`, token));
    check(`valid session: ?next=${next} is kept`, to === `http://localhost:3000${expected}`, to);
  }

  // A session cookie does not make a cross-site write acceptable (a sibling subdomain would send it).
  check("valid session: cross-site POST /api/leads is 403", await refusedCrossSite(await send("POST", "/api/leads", CROSS_SITE, token)));
  check("valid session: same-origin POST /api/leads passes", passes(await send("POST", "/api/leads", SAME_ORIGIN, token)));
  check("no session: cross-site POST /api/login is 403 (login CSRF)", await refusedCrossSite(await send("POST", "/api/login", CROSS_SITE)));
  check("no session: same-origin POST /api/login passes", passes(await send("POST", "/api/login", SAME_ORIGIN)));

  setEnv({ VERCEL: "1" });
  check("Vercel with APP_PASSWORD: the normal gate (401 without a session)", (await run("/api/leads")).status === 401);
  check("Vercel with APP_PASSWORD: a session passes", passes(await run("/api/leads", token)));
  setEnv({ VERCEL: undefined });

  setEnv({ SESSION_SECRET: undefined });
  check("misconfigured gate fails closed", (await run("/api/leads", token)).status === 401);
  restoreEnv();
}

// ------------------------------------------------------------------ 3. routes against Neon

async function testRoutes(): Promise<void> {
  section("3. routes (Neon)");
  restoreEnv();
  // The run caps share le_run_starts with the live app: limits far above any real count
  // keep a busy day there from failing these checks (section 5 tests the caps themselves).
  setEnv({ APP_PASSWORD: undefined, HUBSPOT_ACCESS_TOKEN: undefined, RUN_LIMIT_PER_HOUR: "100000", RUN_LIMIT_PER_DAY: "100000" });

  check("research routes allow 300 s", leadsRoute.maxDuration === 300 && researchRoute.maxDuration === 300 && steerRoute.maxDuration === 300);

  const status = await callRoute(asHandler(statusRoute.GET), { path: "/api/status" });
  const providers = (status.data?.providers ?? []) as Array<{ id: string; configured: boolean }>;
  const model = status.data?.model as { name?: string; effort?: string } | undefined;
  check("GET /api/status 200 with 9 providers", status.status === 200 && providers.length === 9, status.data);
  check("status: X follows (twitterapi.io) listed, from a status function", providers.some((p) => p.id === "twitterapi"));
  check("status: model is claude-haiku-5-5 at low effort", model?.name === "claude-haiku-5-5" && model?.effort === "low", model);
  check("status: authEnabled false with the gate off", status.data?.authEnabled === false);
  check("status: hubspot listed as not configured", providers.some((p) => p.id === "hubspot" && p.configured === false));
  check("status: no-store", status.headers.get("cache-control") === "no-store");

  // Validation before any write.
  const leadsPost = asHandler(leadsRoute.POST);
  check("POST /api/leads without linkedinUrl is 400", (await callRoute(leadsPost, { method: "POST", path: "/api/leads", body: {} })).status === 400);
  const notLinkedIn = await callRoute(leadsPost, { method: "POST", path: "/api/leads", body: { linkedinUrl: "https://example.com/jane" } });
  check("POST /api/leads with a non-LinkedIn URL is 400", notLinkedIn.status === 400 && /LinkedIn/.test(String(notLinkedIn.data?.error)), notLinkedIn.data);
  check("POST /api/leads with broken JSON is 400", (await callRoute(leadsPost, { method: "POST", path: "/api/leads", rawBody: "{nope" })).status === 400);
  check("POST /api/leads with a wrong type is 400", (await callRoute(leadsPost, { method: "POST", path: "/api/leads", body: { linkedinUrl: 42 } })).status === 400);
  // Bodies a cross-site form or no-cors fetch can send are refused before anything is written.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const r = await callRoute(leadsPost, {
      method: "POST",
      path: "/api/leads",
      rawBody: JSON.stringify({ linkedinUrl: "linkedin.com/in/le-api-csrf-probe" }),
      headers: { "content-type": type },
    });
    check(`POST /api/leads with a JSON body sent as ${type.split(";")[0]} is 415`, r.status === 415 && /application\/json/.test(String(r.data?.error)), r.data);
  }
  // An invalid value (0 days), so a regression would answer 400, never save the owner's settings.
  const noType = await callRoute(asHandler(settingsRoute.PUT), { method: "PUT", path: "/api/settings", rawBody: '{"followUpDays":0}', headers: { "content-type": "" } });
  check("PUT /api/settings with an empty content-type is 415", noType.status === 415, noType.data);
  const charset = await callRoute(leadsPost, { method: "POST", path: "/api/leads", body: {}, headers: { "content-type": "application/json; charset=utf-8" } });
  check("application/json with a charset is accepted (reaches validation: 400)", charset.status === 400 && /linkedinUrl/.test(String(charset.data?.error)), charset.data);

  const slug = `le-api-test-${randomBytes(4).toString("hex")}`;
  let leadId: string | null = null;
  try {
    const created = await callRoute(leadsPost, {
      method: "POST",
      path: "/api/leads",
      body: { linkedinUrl: `linkedin.com/in/${slug}/?trk=public`, name: "  API Test  ", companyName: "", notes: "Met at a robotics meetup." },
    });
    const lead = created.data?.lead as Lead | undefined;
    leadId = lead?.id ?? null;
    if (leadId) runLeadIds.add(leadId);
    check("POST /api/leads is 201 with the lead", created.status === 201 && Boolean(leadId), created.data);
    check("create: URL normalised", lead?.linkedinUrl === `https://www.linkedin.com/in/${slug}`, lead?.linkedinUrl);
    check("create: fields trimmed, empty company is null", lead?.name === "API Test" && lead?.companyName === null);
    check("create: research claimed (running, researching)", lead?.researchStatus === "running" && lead?.stage === "researching", {
      status: lead?.researchStatus,
      stage: lead?.stage,
    });
    check("create: research handed to after() (recorded, not run)", afterTasks.length === 1);
    if (!leadId) throw new Error("no lead id; stopping route tests");
    const id = leadId;

    const dup = await callRoute(leadsPost, { method: "POST", path: "/api/leads", body: { linkedinUrl: `https://www.linkedin.com/in/${slug.toUpperCase()}` } });
    check("duplicate is 409 with existingId", dup.status === 409 && dup.data?.existingId === id, dup.data);
    check(
      "duplicate's 409 names the existing lead's stage (researching), with the usual message",
      dup.data?.existingStage === "researching" && dup.data?.error === "This person is already a lead.",
      dup.data,
    );
    check("duplicate starts no research", afterTasks.length === 1);

    const list = await callRoute(asHandler(leadsRoute.GET), { path: "/api/leads" });
    check("GET /api/leads includes the lead", list.status === 200 && (list.data?.leads as Lead[]).some((l) => l.id === id));
    const listCounts = list.data?.counts as { active?: unknown; unqualified?: unknown } | undefined;
    check(
      "GET /api/leads also answers counts { active, unqualified }",
      typeof listCounts?.active === "number" && typeof listCounts?.unqualified === "number" && listCounts.active >= 1,
      list.data?.counts,
    );
    const listed = (list.data?.leads as Lead[]).find((l) => l.id === id);
    check(
      "a listed lead carries unqualifiedAt, unqualifiedReason and stageBeforeUnqualified (null)",
      listed?.unqualifiedAt === null && listed?.unqualifiedReason === null && listed?.stageBeforeUnqualified === null,
      listed && { at: listed.unqualifiedAt, reason: listed.unqualifiedReason, before: listed.stageBeforeUnqualified },
    );

    const getOne = asHandler(leadRoute.GET);
    const detail = await callRoute(getOne, { path: `/api/leads/${id}`, id });
    const events = (detail.data?.events ?? []) as Array<{ type: string }>;
    check("GET /api/leads/[id] returns lead, findings, events", detail.status === 200 && Array.isArray(detail.data?.findings) && events.some((e) => e.type === "created"), detail.data && Object.keys(detail.data));
    check("GET with a malformed id is 404", (await callRoute(getOne, { path: "/api/leads/nope", id: "nope" })).status === 404);
    const ghost = "00000000-0000-4000-8000-000000000000";
    check("GET with an unknown id is 404", (await callRoute(getOne, { path: `/api/leads/${ghost}`, id: ghost })).status === 404);

    // Research and steer claims while the (recorded, not run) research is "running".
    const research = asHandler(researchRoute.POST);
    const steer = asHandler(steerRoute.POST);
    check("POST /research while running is 409", (await callRoute(research, { method: "POST", path: `/api/leads/${id}/research`, id })).status === 409);
    check("POST /steer while running is 409", (await callRoute(steer, { method: "POST", path: `/api/leads/${id}/steer`, id, body: { instruction: "dig into their compute" } })).status === 409);
    check("POST /steer with an empty instruction is 400", (await callRoute(steer, { method: "POST", path: `/api/leads/${id}/steer`, id, body: { instruction: "  " } })).status === 400);
    check("POST /research on an unknown lead is 404", (await callRoute(research, { method: "POST", path: `/api/leads/${ghost}/research`, id: ghost })).status === 404);
    await finishResearch(id, "done");
    const rerun = await callRoute(research, { method: "POST", path: `/api/leads/${id}/research`, id });
    check("POST /research when idle is 202 { ok: true }", rerun.status === 202 && rerun.data?.ok === true && afterTasks.length === 2, rerun.data);
    await finishResearch(id, "done");
    const steered = await callRoute(steer, { method: "POST", path: `/api/leads/${id}/steer`, id, body: { instruction: "Make angle 2 more technical" } });
    check("POST /steer when idle is 202 { ok: true }", steered.status === 202 && steered.data?.ok === true && afterTasks.length === 3, steered.data);
    await finishResearch(id, "done");

    // A re-run with a reason: { focus } is checked before any run slot is taken, logged as
    // "Re-run: <focus>", and the run is handed to after(). No body, {} or a blank focus is a plain re-run.
    const reruns = async () => (await listEvents(id)).filter((e) => e.type === "steer" && e.message.startsWith("Re-run: "));
    const rerunPost = (opts: { body?: unknown; rawBody?: string; headers?: Record<string, string> }) =>
      callRoute(research, { method: "POST", path: `/api/leads/${id}/research`, id, ...opts });
    let tasks = afterTasks.length;
    const tooLong = await rerunPost({ body: { focus: "x".repeat(1201) } });
    check("POST /research with a focus over 1,200 characters is 400", tooLong.status === 400 && /1,200/.test(String(tooLong.data?.error)) && afterTasks.length === tasks, tooLong.data);
    const notText = await rerunPost({ body: { focus: 42 } });
    check("POST /research with a focus that is not text is 400", notText.status === 400 && afterTasks.length === tasks, notText.data);
    const plainBody = await rerunPost({ rawBody: JSON.stringify({ focus: "x" }), headers: { "content-type": "text/plain" } });
    check("POST /research with a text/plain body is 415", plainBody.status === 415 && afterTasks.length === tasks, plainBody.data);
    const focused = await rerunPost({ body: { focus: "  Dig into their GPU spend\nand who signs off  " } });
    const logged = await reruns();
    check("POST /research { focus } is 202 and hands the run to after()", focused.status === 202 && focused.data?.ok === true && afterTasks.length === tasks + 1, focused.data);
    check(
      'POST /research { focus } logs "Re-run: <focus>" (trimmed) with the focus as data',
      logged.length === 1 && logged[0].message === "Re-run: Dig into their GPU spend\nand who signs off" && (logged[0].data as { focus?: string })?.focus === "Dig into their GPU spend\nand who signs off",
      logged,
    );
    await finishResearch(id, "done");
    for (const [label, opts] of [
      ["no body", {}],
      ["{}", { body: {} }],
      ["a blank focus", { body: { focus: "   " } }],
      ["a null focus", { body: { focus: null } }],
      ["an empty body sent as JSON", { rawBody: "", headers: { "content-type": "application/json" } }],
    ] as const) {
      tasks = afterTasks.length;
      const r = await rerunPost(opts);
      check(`POST /research with ${label} is a plain re-run (202, nothing logged)`, r.status === 202 && afterTasks.length === tasks + 1 && (await reruns()).length === 1, r.data);
      await finishResearch(id, "done");
    }

    // PATCH
    const patch = asHandler(leadRoute.PATCH);
    const before = await getLead(id);
    const stageTo = before?.stage === "nurture" ? "lost" : "nurture";
    const p1 = await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { stage: stageTo, owner: " Sam ", nextStepAt: "2026-12-01" } });
    const p1lead = p1.data?.lead as Lead | undefined;
    check("PATCH stage/owner/nextStepAt", p1.status === 200 && p1lead?.stage === stageTo && p1lead?.owner === "Sam" && p1lead?.nextStepAt === "2026-12-01T00:00:00.000Z", p1lead && { stage: p1lead.stage, owner: p1lead.owner, next: p1lead.nextStepAt });
    const afterPatch = await callRoute(getOne, { path: `/api/leads/${id}`, id });
    const stageEvent = ((afterPatch.data?.events ?? []) as Array<{ type: string; data: { from?: string; to?: string } }>).find((e) => e.type === "stage");
    check("PATCH logs a stage event with from/to", stageEvent?.data?.to === stageTo && stageEvent?.data?.from === before?.stage, stageEvent);

    await query("update le_leads set email_confidence = 80 where id = $1", [id]);
    const p2 = await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { email: "jane@example.com", title: "", notes: null } });
    const p2lead = p2.data?.lead as Lead | undefined;
    check("PATCH email resets its confidence; '' and null clear", p2.status === 200 && p2lead?.email === "jane@example.com" && p2lead?.emailConfidence === null && p2lead?.title === null && p2lead?.notes === null, p2lead && { email: p2lead.email, conf: p2lead.emailConfidence });
    check("PATCH email marks the address as added by hand", p2lead?.emailStatus === "manual", p2lead?.emailStatus);

    // Email by hand: lower case, "manual"; the same address again keeps its kind; null clears all three.
    await query("update le_leads set email = 'found@acme.com', email_status = 'found', email_confidence = 80 where id = $1", [id]);
    const typed = (await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { email: " Jane.Doe@Example.COM " } })).data?.lead as Lead | undefined;
    check("PATCH email: trimmed, lower case, manual, no confidence", typed?.email === "jane.doe@example.com" && typed?.emailStatus === "manual" && typed?.emailConfidence === null, typed && { e: typed.email, s: typed.emailStatus, c: typed.emailConfidence });
    await query("update le_leads set email_status = 'found', email_confidence = 80 where id = $1", [id]);
    const same = (await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { email: "JANE.DOE@example.com" } })).data?.lead as Lead | undefined;
    check("PATCH email with the same address keeps its kind and confidence", same?.emailStatus === "found" && same?.emailConfidence === 80, same && { s: same.emailStatus, c: same.emailConfidence });
    const noEmail = (await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { email: null } })).data?.lead as Lead | undefined;
    check("PATCH email null clears the address, its kind and confidence", noEmail?.email === null && noEmail?.emailStatus === null && noEmail?.emailConfidence === null, noEmail);

    // LinkedIn URL by hand: normalised; 400 when not a profile; 409 with existingId when another lead has it; "" clears.
    const other = await createLead({ linkedinUrl: `https://www.linkedin.com/in/${slug}-other` });
    try {
      const notProfile = await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { linkedinUrl: "https://www.linkedin.com/company/acme" } });
      check("PATCH linkedinUrl that is not a profile is 400", notProfile.status === 400 && /LinkedIn profile URL/.test(String(notProfile.data?.error)), notProfile.data);
      const taken = await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { linkedinUrl: `LINKEDIN.COM/IN/${slug.toUpperCase()}-OTHER` } });
      check("PATCH linkedinUrl another lead has is 409 with existingId", taken.status === 409 && taken.data?.existingId === other.id, taken.data);
      const moved = (await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { linkedinUrl: `linkedin.com/in/${slug}-New/?trk=x`, owner: "Kim" } })).data?.lead as Lead | undefined;
      check("PATCH linkedinUrl: normalised with its slug, other fields saved too", moved?.linkedinUrl === `https://www.linkedin.com/in/${slug}-new` && moved?.linkedinSlug === `${slug}-new` && moved?.owner === "Kim", moved && { u: moved.linkedinUrl, s: moved.linkedinSlug, o: moved.owner });
      const cleared = (await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { linkedinUrl: "" } })).data?.lead as Lead | undefined;
      check('PATCH linkedinUrl "" clears it (and its slug)', cleared?.linkedinUrl === null && cleared?.linkedinSlug === null, cleared && { u: cleared.linkedinUrl, s: cleared.linkedinSlug });
      const back = (await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { linkedinUrl: `https://www.linkedin.com/in/${slug}` } })).data?.lead as Lead | undefined;
      check("PATCH linkedinUrl sets it again", back?.linkedinUrl === `https://www.linkedin.com/in/${slug}`, back?.linkedinUrl);
    } finally {
      await deleteLead(other.id).catch(() => undefined);
    }

    const angle: Angle & { recommended: boolean } = {
      id: "drop-onboard-gpu",
      name: "Drop the onboard GPU",
      reasoning: "They run pi0.5 on a Jetson.",
      findingIds: [],
      email: { subject: "Your Jetson", body: "Hi Jane,\n\nShort note.\n\nSam" },
      linkedinMessage: "Hi Jane, quick question about your onboard inference.",
      recommended: true,
    };
    const p3 = await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { angles: [angle] } });
    const savedAngles = (p3.data?.lead as Lead | undefined)?.angles as Array<Angle & { recommended?: boolean }> | undefined;
    check("PATCH angles saves and keeps unknown angle fields", p3.status === 200 && savedAngles?.[0]?.email.body === angle.email.body && savedAngles?.[0]?.recommended === true, savedAngles?.[0]);

    for (const [label, body] of [
      ["empty body", {}],
      ["unknown stage", { stage: "won" }],
      ["bad email", { email: "not-an-email" }],
      ["bad date", { nextStepAt: "next tuesday" }],
      ["duplicate angle ids", { angles: [angle, angle] }],
      ["angle without email", { angles: [{ id: "x", name: "x", linkedinMessage: "" }] }],
      ["only unknown keys", { researchStatus: "done" }],
    ] as const) {
      const r = await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body });
      check(`PATCH ${label} is 400 with an error`, r.status === 400 && typeof r.data?.error === "string", r.data);
    }

    // Sent
    const sent = asHandler(sentRoute.POST);
    const settings = await getSettings();
    const t0 = Date.now();
    const s1 = await callRoute(sent, { method: "POST", path: `/api/leads/${id}/sent`, id, body: { angleId: angle.id, channel: "email" } });
    const s1lead = s1.data?.lead as Lead | undefined;
    const lastAt = Date.parse(s1lead?.lastContactedAt ?? "");
    const nextAt = Date.parse(s1lead?.nextStepAt ?? "");
    check("POST /sent: stage contacted", s1.status === 200 && s1lead?.stage === "contacted", s1.data);
    check("POST /sent: lastContactedAt is now", Math.abs(lastAt - t0) < 60_000);
    check(`POST /sent: nextStepAt is now + ${settings.followUpDays} days`, Math.abs(nextAt - lastAt - settings.followUpDays * DAY) < 5_000);
    const s1events = (await callRoute(getOne, { path: `/api/leads/${id}`, id })).data?.events as Array<{ type: string; message: string; data: { channel?: string } }>;
    const sentEvent = s1events.find((e) => e.type === "sent");
    check("POST /sent logs a sent event", sentEvent?.data?.channel === "email" && /Drop the onboard GPU/.test(sentEvent.message), sentEvent);
    check("POST /sent with a bad channel is 400", (await callRoute(sent, { method: "POST", path: `/api/leads/${id}/sent`, id, body: { angleId: "a", channel: "sms" } })).status === 400);
    await callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body: { stage: "call_booked" } });
    const s2 = await callRoute(sent, { method: "POST", path: `/api/leads/${id}/sent`, id, body: { angleId: angle.id, channel: "linkedin" } });
    check("POST /sent keeps call_booked", (s2.data?.lead as Lead | undefined)?.stage === "call_booked");

    // Events
    const ev = asHandler(eventsRoute.POST);
    const e1 = await callRoute(ev, { method: "POST", path: `/api/leads/${id}/events`, id, body: { type: "copied", message: "Copied the email" } });
    check("POST /events copied is { ok: true }", e1.status === 200 && e1.data?.ok === true, e1.data);
    check("POST /events note works", (await callRoute(ev, { method: "POST", path: `/api/leads/${id}/events`, id, body: { type: "note", message: "Called, no answer" } })).status === 200);
    check("POST /events with a server-only type is 400", (await callRoute(ev, { method: "POST", path: `/api/leads/${id}/events`, id, body: { type: "done", message: "x" } })).status === 400);
    check("POST /events on an unknown lead is 404", (await callRoute(ev, { method: "POST", path: `/api/leads/${ghost}/events`, id: ghost, body: { type: "note", message: "x" } })).status === 404);

    // HubSpot without a token
    const hs = await callRoute(asHandler(hubspotRoute.POST), { method: "POST", path: `/api/leads/${id}/hubspot`, id });
    check("POST /hubspot without a token is 400", hs.status === 400 && /HUBSPOT_ACCESS_TOKEN/.test(String(hs.data?.error)), hs.data);

    // Delete
    const del = asHandler(leadRoute.DELETE);
    const d1 = await callRoute(del, { method: "DELETE", path: `/api/leads/${id}`, id });
    check("DELETE is { ok: true }", d1.status === 200 && d1.data?.ok === true);
    check("DELETE again is 404", (await callRoute(del, { method: "DELETE", path: `/api/leads/${id}`, id })).status === 404);
    check("GET after delete is 404", (await callRoute(getOne, { path: `/api/leads/${id}`, id })).status === 404);
    leadId = null;
  } finally {
    if (leadId) {
      await deleteLead(leadId).catch(() => undefined);
      console.log("  (cleaned up the temp lead)");
    }
  }

  // Settings: reads freely; writes only the stored values back, and only when a row exists,
  // so the owner's settings (and the code defaults) are left exactly as they were.
  const getS = await callRoute(asHandler(settingsRoute.GET), { path: "/api/settings" });
  const current = getS.data?.settings as Record<string, unknown> | undefined;
  check("GET /api/settings", getS.status === 200 && Array.isArray(current?.criteria) && typeof current?.followUpDays === "number", getS.data);
  const put = asHandler(settingsRoute.PUT);
  for (const [label, body] of [
    ["followUpDays 0", { followUpDays: 0 }],
    ["followUpDays 2.5", { followUpDays: 2.5 }],
    ["bad senderEmail", { senderEmail: "sam(at)abstract" }],
    ["non-http calendlyUrl", { calendlyUrl: "javascript:alert(1)" }],
    ["criteria not an array", { criteria: "be nice" }],
    ["31 criteria", { criteria: Array.from({ length: 31 }, (_, i) => `rule ${i}`) }],
  ] as const) {
    const r = await callRoute(put, { method: "PUT", path: "/api/settings", body });
    check(`PUT /api/settings ${label} is 400`, r.status === 400 && typeof r.data?.error === "string", r.data);
  }
  const stored = await query("select 1 from le_settings where key = 'app'");
  if (stored.length && current) {
    const same = await callRoute(put, { method: "PUT", path: "/api/settings", body: current });
    check("PUT /api/settings round trip leaves settings unchanged", same.status === 200 && JSON.stringify(same.data?.settings) === JSON.stringify(current), same.data);
  } else {
    console.log("  skip PUT round trip: no settings row yet (writing one would freeze the code defaults)");
  }

  // Login / logout through the real handlers.
  const login = asHandler(loginRoute.POST);
  const logout = asHandler(logoutRoute.POST);
  setEnv({ APP_PASSWORD: undefined, SESSION_SECRET: undefined });
  check("login with the gate off is { ok: true }", (await callRoute(login, { method: "POST", path: "/api/login", body: { password: "x" } })).data?.ok === true);
  check("status: authEnabled true with the gate on", await (async () => {
    setEnv({ APP_PASSWORD: PASSWORD, SESSION_SECRET: SECRET });
    return (await callRoute(asHandler(statusRoute.GET), { path: "/api/status" })).data?.authEnabled === true;
  })());
  setEnv({ APP_PASSWORD: PASSWORD, SESSION_SECRET: undefined });
  const mis = await callRoute(login, { method: "POST", path: "/api/login", body: { password: PASSWORD }, headers: { "x-forwarded-for": "203.0.113.9" } });
  check("login with a missing SESSION_SECRET is 500 and says why", mis.status === 500 && /SESSION_SECRET/.test(String(mis.data?.error)), mis.data);
  setEnv({ SESSION_SECRET: SECRET });
  const ip = { "x-forwarded-for": "203.0.113.10" };
  const t1 = Date.now();
  const wrong = await callRoute(login, { method: "POST", path: "/api/login", body: { password: "nope" }, headers: ip });
  check("wrong password is 401 after a fixed delay", wrong.status === 401 && Date.now() - t1 >= 550 && !wrong.headers.get("set-cookie"), { status: wrong.status, ms: Date.now() - t1 });
  check("missing password is 400", (await callRoute(login, { method: "POST", path: "/api/login", body: {}, headers: ip })).status === 400);
  const right = await callRoute(login, { method: "POST", path: "/api/login", body: { password: PASSWORD }, headers: ip });
  const setCookie = right.headers.get("set-cookie") ?? "";
  const value = /le_session=([^;]*)/.exec(setCookie)?.[1] ?? "";
  check("right password is { ok: true } with a cookie", right.status === 200 && right.data?.ok === true && value.length > 0);
  check("login cookie verifies", await verifySessionToken(decodeURIComponent(value)));
  check("login cookie attributes", /HttpOnly/i.test(setCookie) && /SameSite=lax/i.test(setCookie) && /Path=\//.test(setCookie) && /Max-Age=2592000/.test(setCookie), setCookie.replace(value, "<value>"));
  const out = await callRoute(logout, { method: "POST", path: "/api/logout" });
  const cleared = out.headers.get("set-cookie") ?? "";
  check("logout clears the cookie", out.data?.ok === true && /le_session=;/.test(cleared) && /Max-Age=0/.test(cleared), cleared);

  const flood = { "x-forwarded-for": "203.0.113.11" };
  for (let i = 0; i < 10; i++) await callRoute(login, { method: "POST", path: "/api/login", body: { password: `guess-${i}` }, headers: flood });
  const limited = await callRoute(login, { method: "POST", path: "/api/login", body: { password: PASSWORD }, headers: flood });
  check("11th attempt after 10 failures is 429", limited.status === 429 && Boolean(limited.headers.get("retry-after")), limited.data);
  check("other clients are not affected", (await callRoute(login, { method: "POST", path: "/api/login", body: { password: PASSWORD }, headers: ip })).status === 200);
  restoreEnv();

  // 500s never leak internals; config errors are named.
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const generic = serverError("test", new Error('relation "le_secret_table" does not exist at character 15'));
    const generic2 = (await generic.json()) as { error: string };
    check("500 hides internal error text", generic.status === 500 && !/le_secret_table/.test(generic2.error), generic2);
    const cfg = (await serverError("test", new Error("DATABASE_URL is not set. Add it to .env.local (see .env.example).")).json()) as { error: string };
    check("500 names a missing env var", cfg.error === "The server is not fully configured: DATABASE_URL is not set.", cfg);
  } finally {
    console.error = quiet;
  }
}

// ------------------------------------------------------------------ 4. HubSpot (mocked)

interface HubCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
  auth: boolean;
}

type Route = (c: HubCall) => Response | null | undefined;

const realFetch = globalThis.fetch;
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Swaps fetch for HubSpot calls only; everything else (Neon) still goes to the network. */
function mockHubSpot(token: string, routes: Route[]): { calls: HubCall[]; restore: () => void } {
  const calls: HubCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.hubapi.com") return realFetch(input, init);
    const headers = new Headers(init?.headers);
    const call: HubCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      auth: headers.get("authorization") === `Bearer ${token}`,
    };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    return reply({ status: "error", message: `not mocked: ${call.method} ${call.path}`, category: "OBJECT_NOT_FOUND" }, 404);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = realFetch) };
}

const V = "/crm/objects/2026-09";
const on = (method: string, path: string | RegExp, res: (c: HubCall) => Response | null): Route => (c) =>
  c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)) ? res(c) : null;
const filtersOf = (c: HubCall) =>
  ((c.body?.filterGroups ?? []) as Array<{ filters: Array<{ propertyName: string; value?: string }> }>).map((g) => g.filters.map((f) => `${f.propertyName}=${f.value ?? "?"}`).join("&"));
const assocTypes = (c: HubCall | undefined) =>
  ((c?.body?.associations ?? []) as Array<{ to: { id: string }; types: Array<{ associationTypeId: number }> }>).map((a) => `${a.to.id}:${a.types[0]?.associationTypeId}`).sort();

const PIPELINES = {
  results: [
    {
      id: "default",
      label: "Sales Pipeline",
      displayOrder: 0,
      stages: [
        { id: "closedwon", label: "Closed won", displayOrder: 5, metadata: { isClosed: "true", probability: "1.0" } },
        { id: "qualifiedtobuy", label: "Qualified", displayOrder: 1, metadata: { isClosed: "false" } },
        { id: "appointmentscheduled", label: "Appointment scheduled", displayOrder: 0, metadata: { isClosed: "false" } },
      ],
    },
  ],
};

function sampleLead(over: Partial<Lead> = {}): Lead {
  const at = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    linkedinUrl: "https://www.linkedin.com/in/jane-doe",
    linkedinSlug: "jane-doe",
    name: "Jane Doe",
    title: "Head of ML Infrastructure",
    companyName: "Acme Robotics",
    companyDomain: "https://www.acme-robotics.com/about",
    companyLinkedinUrl: "https://www.linkedin.com/company/acme-robotics",
    email: "Jane@Acme-Robotics.com",
    emailConfidence: 91,
    emailStatus: null,
    source: null,
    hubspotContactId: null,
    xHandle: null,
    location: null,
    notes: null,
    stage: "contacted",
    unqualifiedAt: null,
    unqualifiedReason: null,
    stageBeforeUnqualified: null,
    owner: null,
    nextStepAt: null,
    lastContactedAt: null,
    researchStatus: "done",
    researchStep: null,
    researchError: null,
    researchStartedAt: null,
    researchFinishedAt: null,
    brief: { summary: "Runs pi0.5 fine-tunes on YAM arms <onboard> & wants lower latency.", bullets: [], pains: [], objections: [], questions: [] },
    companyPicture: { name: "Acme Robotics", domain: "acme-robotics.com", oneLiner: "Bimanual robots for kitting.", headcount: null, growth: null, funding: null, team: [], hiring: [], robotsAndModels: [], decisionMakers: [] },
    angles: [],
    approach: null,
    usage: {},
    warmPath: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const SENT: Angle = {
  id: "drop-onboard-gpu",
  name: "Drop the onboard GPU",
  reasoning: "r",
  findingIds: [],
  email: { subject: "Your Jetson <setup>", body: "Hi Jane,\n\nSaw your post & the latency numbers.\nWorth a call?\n\nSam" },
  linkedinMessage: "Hi Jane, quick one about onboard inference.",
};

async function testHubSpot(): Promise<void> {
  section("4. hubspot (mocked API)");
  check("splitName", JSON.stringify(splitName("Dr. Jane van der Berg, PhD 🚀")) === JSON.stringify({ first: "Jane", last: "van der Berg" }), splitName("Dr. Jane van der Berg, PhD 🚀"));
  check("splitName single word", JSON.stringify(splitName("Cher")) === JSON.stringify({ first: "Cher", last: null }));
  check("normaliseDomain", normaliseDomain("HTTPS://www.Acme-Robotics.com:443/about?x=1") === "acme-robotics.com" && normaliseDomain("not a domain") === null && normaliseDomain("localhost") === null);

  const token = `test-${randomBytes(6).toString("hex")}`; // fake; the API is mocked
  setEnv({ HUBSPOT_ACCESS_TOKEN: token });

  // A: nothing exists yet -> everything is created and linked.
  {
    const m = mockHubSpot(token, [
      on("GET", "/crm/owners/2026-09", () => reply({ results: [{ id: 77, email: "sam@abstract.inc", userId: 9 }, { id: 78, email: "other@abstract.inc" }] })),
      on("GET", "/crm/pipelines/2026-09/deals", () => reply(PIPELINES)),
      on("POST", `${V}/companies/search`, () => reply({ total: 0, results: [] })),
      on("POST", `${V}/companies`, () => reply({ id: "c1", properties: {} }, 201)),
      on("GET", /\/contacts\/.+/, () => reply({ status: "error", message: "Object not found", category: "OBJECT_NOT_FOUND" }, 404)),
      on("POST", `${V}/contacts`, () => reply({ id: "p1", properties: {} }, 201)),
      on("POST", `${V}/deals/search`, () => reply({ total: 0, results: [] })),
      on("POST", `${V}/deals`, () => reply({ id: "d1", properties: {} }, 201)),
      on("POST", `${V}/notes`, () => reply({ id: "n1", properties: {} }, 201)),
    ]);
    try {
      const r = await pushLeadToHubSpot({ lead: sampleLead(), sentAngle: SENT, channel: "email", senderEmail: "Sam@Abstract.inc", sentAt: "2026-11-20T10:00:00.000Z" });
      check("A: ok with all ids", r.ok && r.companyId === "c1" && r.contactId === "p1" && r.dealId === "d1" && r.noteId === "n1", r);
      check("A: created company, contact, deal, note", r.created.join(",") === "company,contact,deal,note", r.created);
      check("A: no warnings", r.warnings.length === 0, r.warnings);
      check("A: every call carries the bearer token", m.calls.every((c) => c.auth));
      const owner = m.calls.find((c) => c.path === "/crm/owners/2026-09");
      check("A: owner looked up by sender email (lowercased)", owner?.query.email === "sam@abstract.inc");
      const companySearch = m.calls.filter((c) => c.path === `${V}/companies/search`);
      check("A: company searched by domain (with and without www) then by name without domain", filtersOf(companySearch[0]).join("|") === "domain=acme-robotics.com|domain=www.acme-robotics.com" && filtersOf(companySearch[1]).join("|") === "name=Acme Robotics&domain=?", companySearch.map(filtersOf));
      const company = m.calls.find((c) => c.method === "POST" && c.path === `${V}/companies`);
      const cp = company?.body?.properties as Record<string, string> | undefined;
      check("A: company props", cp?.name === "Acme Robotics" && cp?.domain === "acme-robotics.com" && cp?.hubspot_owner_id === "77" && cp?.linkedin_company_page === "https://www.linkedin.com/company/acme-robotics", cp);
      const contactGet = m.calls.find((c) => c.method === "GET" && c.path.startsWith(`${V}/contacts/`));
      check("A: contact looked up by email with idProperty=email", contactGet?.path === `${V}/contacts/jane%40acme-robotics.com` && contactGet?.query.idProperty === "email", contactGet && { path: contactGet.path, q: contactGet.query });
      const contact = m.calls.find((c) => c.method === "POST" && c.path === `${V}/contacts`);
      const pp = contact?.body?.properties as Record<string, string> | undefined;
      check("A: contact props", pp?.email === "jane@acme-robotics.com" && pp?.firstname === "Jane" && pp?.lastname === "Doe" && pp?.jobtitle === "Head of ML Infrastructure" && pp?.company === "Acme Robotics" && pp?.hubspot_owner_id === "77", pp);
      check("A: contact linked to its primary company (type 1)", assocTypes(contact).join() === "c1:1", assocTypes(contact));
      const dealSearch = m.calls.find((c) => c.path === `${V}/deals/search`);
      check("A: existing deals checked by associations.contact", filtersOf(dealSearch!).join() === "associations.contact=p1", dealSearch && filtersOf(dealSearch));
      const deal = m.calls.find((c) => c.method === "POST" && c.path === `${V}/deals`);
      const dp = deal?.body?.properties as Record<string, string> | undefined;
      check("A: deal in the default pipeline's first open stage", dp?.pipeline === "default" && dp?.dealstage === "appointmentscheduled" && dp?.dealname === "Acme Robotics (Jane Doe)", dp);
      check("A: deal linked to contact (3) and company (5)", assocTypes(deal).join() === "c1:5,p1:3", assocTypes(deal));
      const note = m.calls.find((c) => c.method === "POST" && c.path === `${V}/notes`);
      const np = note?.body?.properties as Record<string, string> | undefined;
      check("A: note linked to contact (202), deal (214), company (190)", assocTypes(note).join() === "c1:190,d1:214,p1:202", assocTypes(note));
      check("A: note at the sent time", np?.hs_timestamp === "2026-11-20T10:00:00.000Z", np?.hs_timestamp);
      const html = np?.hs_note_body ?? "";
      check("A: note quotes the sent email, escaped", html.includes("Your Jetson &lt;setup&gt;") && html.includes("Saw your post &amp; the latency numbers.<br>Worth a call?") && !html.includes("<setup>"), html.slice(0, 300));
      check("A: email channel note leaves the LinkedIn text out", !html.includes("LinkedIn message") && html.includes("by email"));
      check("A: note has the brief and the profile link", html.includes("Why this lead:") && html.includes('href="https://www.linkedin.com/in/jane-doe"'));
      check("A: no create was sent twice", m.calls.filter((c) => c.method === "POST" && /\/(companies|contacts|deals|notes)$/.test(c.path)).length === 4);
    } finally {
      m.restore();
    }
  }

  // B: everything exists -> nothing overwritten, a refused property is dropped, the open deal is reused.
  {
    const m = mockHubSpot(token, [
      on("GET", "/crm/owners/2026-09", () => reply({ results: [] })),
      on("GET", "/crm/pipelines/2026-09/deals", () => reply(PIPELINES)),
      on("POST", `${V}/companies/search`, () => reply({ total: 1, results: [{ id: "c9", properties: { name: "ACME (HQ)", domain: "acme-robotics.com", linkedin_company_page: "", description: null } }] })),
      on("PATCH", `${V}/companies/c9`, () => reply({ id: "c9", properties: {} })),
      on("GET", /\/contacts\/.+/, () => reply({ id: "p9", properties: { email: "jane@acme-robotics.com", firstname: "Janet", lastname: "", jobtitle: null } })),
      on("PATCH", `${V}/contacts/p9`, (c) => {
        const props = c.body?.properties as Record<string, string>;
        if ("hs_linkedin_url" in props) {
          return reply(
            {
              status: "error",
              message: 'Property values were not valid: [{"isValid":false,"message":"Property \\"hs_linkedin_url\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"hs_linkedin_url"}]',
              category: "VALIDATION_ERROR",
            },
            400,
          );
        }
        return reply({ id: "p9", properties: props });
      }),
      on("PUT", /\/associations\/default\//, () => reply({ status: "COMPLETE", results: [] })),
      on("POST", `${V}/deals/search`, () =>
        reply({
          total: 2,
          results: [
            { id: "d8", properties: { dealname: "Old pilot", pipeline: "default", dealstage: "closedwon", hs_is_closed: "true" } },
            { id: "d9", properties: { dealname: "acme robotics (jane doe)", pipeline: "default", dealstage: "qualifiedtobuy", hs_is_closed: "false" } },
          ],
        }),
      ),
      on("POST", `${V}/notes`, () => reply({ id: "n9", properties: {} }, 201)),
    ]);
    try {
      const r = await pushLeadToHubSpot({ lead: sampleLead(), sentAngle: SENT, channel: "linkedin", senderEmail: "nobody@abstract.inc" });
      check("B: ok, reusing company, contact, deal", r.ok && r.companyId === "c9" && r.contactId === "p9" && r.dealId === "d9" && r.created.join() === "note", r);
      const companyPatch = m.calls.find((c) => c.method === "PATCH" && c.path === `${V}/companies/c9`)?.body?.properties as Record<string, string> | undefined;
      check("B: company: only empty fields filled (name kept)", !!companyPatch && !("name" in companyPatch) && !("domain" in companyPatch) && "linkedin_company_page" in companyPatch && "description" in companyPatch, companyPatch);
      const contactPatches = m.calls.filter((c) => c.method === "PATCH" && c.path === `${V}/contacts/p9`).map((c) => c.body?.properties as Record<string, string>);
      check("B: contact: refused property dropped and retried once", contactPatches.length === 2 && "hs_linkedin_url" in contactPatches[0] && !("hs_linkedin_url" in contactPatches[1]), contactPatches);
      check("B: contact: firstname kept, blanks filled", !("firstname" in contactPatches[1]) && contactPatches[1].lastname === "Doe" && contactPatches[1].jobtitle === "Head of ML Infrastructure", contactPatches[1]);
      check("B: warns about the refused property and the missing owner", r.warnings.some((w) => /hs_linkedin_url/.test(w)) && r.warnings.some((w) => /No HubSpot user/.test(w)), r.warnings);
      const puts = m.calls.filter((c) => c.method === "PUT").map((c) => c.path);
      check("B: existing records linked with default associations", puts.includes(`${V}/contact/p9/associations/default/company/c9`) && puts.includes(`${V}/deal/d9/associations/default/company/c9`), puts);
      check("B: no deal created", !m.calls.some((c) => c.method === "POST" && c.path === `${V}/deals`));
      const html = (m.calls.find((c) => c.path === `${V}/notes`)?.body?.properties as Record<string, string>).hs_note_body;
      check("B: LinkedIn channel note quotes the LinkedIn message only", html.includes("LinkedIn message") && !html.includes("Subject:") && html.includes("on LinkedIn"), html.slice(0, 200));
    } finally {
      m.restore();
    }
  }

  // C: 409 on contact create -> use the existing id; no sender email -> no owner lookup; no sent angle.
  {
    const m = mockHubSpot(token, [
      on("GET", "/crm/pipelines/2026-09/deals", () => reply({ status: "error", message: "missing scope" }, 403)),
      on("POST", `${V}/companies/search`, () => reply({ results: [] })),
      on("POST", `${V}/companies`, () => reply({ id: "c2" }, 201)),
      on("GET", /\/contacts\/.+/, () => reply({ message: "not found" }, 404)),
      on("POST", `${V}/contacts`, () => reply({ status: "error", message: "Contact already exists. Existing ID: 555", category: "CONFLICT" }, 409)),
      on("PUT", /\/associations\/default\//, () => reply({ status: "COMPLETE" })),
      on("POST", `${V}/deals/search`, () => reply({ results: [] })),
      on("POST", `${V}/deals`, () => reply({ id: "d2" }, 201)),
      on("POST", `${V}/notes`, () => reply({ id: "n2" }, 201)),
    ]);
    try {
      const r = await pushLeadToHubSpot({ lead: sampleLead({ companyDomain: "n/a" }), sentAngle: null });
      check("C: 409 conflict reuses Existing ID", r.ok && r.contactId === "555", r);
      const firstSearch = m.calls.find((c) => c.path === `${V}/companies/search`);
      check("C: a malformed companyDomain falls back to the company picture's domain", filtersOf(firstSearch!)[0] === "domain=acme-robotics.com", firstSearch && filtersOf(firstSearch));
      check("C: no owner lookup without a sender email", !m.calls.some((c) => c.path.startsWith("/crm/owners")));
      const dp = m.calls.find((c) => c.method === "POST" && c.path === `${V}/deals`)?.body?.properties as Record<string, string> | undefined;
      check("C: unreadable pipelines fall back to default/appointmentscheduled", dp?.pipeline === "default" && dp?.dealstage === "appointmentscheduled" && r.warnings.some((w) => /pipelines/.test(w)), { dp, w: r.warnings });
      check("C: conflicting contact linked to the company", m.calls.some((c) => c.method === "PUT" && c.path === `${V}/contact/555/associations/default/company/c2`));
      const html = (m.calls.find((c) => c.path === `${V}/notes`)?.body?.properties as Record<string, string>).hs_note_body;
      check("C: note without a sent angle says nothing was sent", /nothing marked as sent yet/.test(html));
    } finally {
      m.restore();
    }
  }

  // D: no email -> contact matched by name AND company; one 429 is retried.
  {
    let searches = 0;
    const m = mockHubSpot(token, [
      on("GET", "/crm/pipelines/2026-09/deals", () => reply(PIPELINES)),
      on("POST", `${V}/companies/search`, () => reply({ results: [{ id: "c3", properties: { name: "Acme Robotics", domain: "acme-robotics.com" } }] })),
      on("POST", `${V}/contacts/search`, () => (++searches === 1 ? reply({ status: "error", message: "secondly limit" }, 429, { "retry-after": "1" }) : reply({ results: [{ id: "p3", properties: { firstname: "Jane", lastname: "Doe" } }] }))),
      on("PATCH", `${V}/contacts/p3`, () => reply({ id: "p3" })),
      on("PUT", /\/associations\/default\//, () => reply({ status: "COMPLETE" })),
      on("POST", `${V}/deals/search`, () => reply({ results: [] })),
      on("POST", `${V}/deals`, () => reply({ id: "d3" }, 201)),
      on("POST", `${V}/notes`, () => reply({ id: "n3" }, 201)),
    ]);
    try {
      const r = await pushLeadToHubSpot({ lead: sampleLead({ email: null }), sentAngle: SENT });
      const search = m.calls.filter((c) => c.path === `${V}/contacts/search`);
      check("D: found by name + company after one 429 retry", r.ok && r.contactId === "p3" && search.length === 2, { r, n: search.length });
      check("D: name + company filters (linked company OR company text)", filtersOf(search[1]).join("|") === "firstname=Jane&lastname=Doe&associations.company=c3|firstname=Jane&lastname=Doe&company=Acme Robotics", filtersOf(search[1]));
      check("D: no email lookup without an email", !m.calls.some((c) => c.method === "GET" && c.path.includes("/contacts/")));
    } finally {
      m.restore();
    }
  }

  // F: a lead imported from HubSpot goes back to its own contact, found by id; a deleted one falls back to the email.
  {
    const m = mockHubSpot(token, [
      on("GET", "/crm/pipelines/2026-09/deals", () => reply(PIPELINES)),
      on("POST", `${V}/companies/search`, () => reply({ results: [{ id: "c7", properties: { name: "Acme Robotics", domain: "acme-robotics.com" } }] })),
      on("GET", `${V}/contacts/4242`, () => reply({ id: "4242", properties: { email: "", firstname: "Jane", lastname: "Doe" } })),
      on("GET", `${V}/contacts/4343`, () => reply({ status: "error", message: "Object not found", category: "OBJECT_NOT_FOUND" }, 404)),
      on("GET", `${V}/contacts/4444`, () => reply({ id: "4444", properties: { email: "someone@else.example", firstname: "Other", lastname: "Person" } })),
      on("GET", /\/contacts\/jane%40/, () => reply({ id: "p8", properties: { email: "jane@acme-robotics.com" } })),
      on("PATCH", /\/contacts\/(4242|p8)$/, (c) => reply({ id: c.path.split("/").pop(), properties: {} })),
      on("PUT", /\/associations\/default\//, () => reply({ status: "COMPLETE" })),
      on("POST", `${V}/deals/search`, () => reply({ results: [] })),
      on("POST", `${V}/deals`, () => reply({ id: "d7" }, 201)),
      on("POST", `${V}/notes`, () => reply({ id: "n7" }, 201)),
    ]);
    try {
      const r = await pushLeadToHubSpot({ lead: sampleLead({ hubspotContactId: "4242", source: "hubspot" }), sentAngle: SENT });
      const gets = m.calls.filter((c) => c.method === "GET" && c.path.includes("/contacts/")).map((c) => c.path);
      check("F: an imported lead reuses its HubSpot contact by id, no email lookup", r.ok && r.contactId === "4242" && gets.join() === `${V}/contacts/4242` && !r.created.includes("contact"), { r, gets });
      const patchCall = m.calls.find((c) => c.method === "PATCH" && c.path === `${V}/contacts/4242`);
      check("F: only its empty fields are filled (the email)", (patchCall?.body?.properties as Record<string, string> | undefined)?.email === "jane@acme-robotics.com" && !("firstname" in ((patchCall?.body?.properties as object) ?? {})), patchCall?.body);
      const r2 = await pushLeadToHubSpot({ lead: sampleLead({ hubspotContactId: "4343" }), sentAngle: SENT });
      check("F: a contact deleted in HubSpot falls back to the email lookup", r2.ok && r2.contactId === "p8", r2);
      // An import row can name any record id: a contact that is someone else is never written to.
      const before = m.calls.length;
      const r3 = await pushLeadToHubSpot({ lead: sampleLead({ hubspotContactId: "4444" }), sentAngle: SENT });
      const touched = m.calls.slice(before).filter((c) => c.method !== "GET" && (c.path.includes("4444") || JSON.stringify(c.body ?? null).includes('"4444"')));
      check("F: a contact id that is someone else is not written to; the email lookup is used", r3.ok && r3.contactId === "p8" && touched.length === 0, { r3, touched: touched.map((c) => `${c.method} ${c.path}`) });
    } finally {
      m.restore();
    }
  }

  // E: failures -> clear errors and the ids already written.
  {
    const m = mockHubSpot(token, [() => reply({ status: "error", message: "Authentication credentials not found.", category: "INVALID_AUTHENTICATION" }, 401)]);
    try {
      const r = await pushToHubSpot({ lead: sampleLead() });
      check("E: 401 -> ok false with a token hint", r.ok === false && /access token/.test(r.error ?? ""), r);
      check("E: 401 stops before any create", !m.calls.some((c) => c.method === "POST" && /\/(companies|contacts|deals|notes)$/.test(c.path)));
    } finally {
      m.restore();
    }
    const m2 = mockHubSpot(token, [
      on("GET", "/crm/pipelines/2026-09/deals", () => reply(PIPELINES)),
      on("POST", `${V}/companies/search`, () => reply({ results: [] })),
      on("POST", `${V}/companies`, () => reply({ id: "c4" }, 201)),
      on("GET", /\/contacts\/.+/, () => reply({}, 404)),
      on("POST", `${V}/contacts`, () => reply({ id: "p4" }, 201)),
      on("POST", `${V}/deals/search`, () => reply({ results: [] })),
      on("POST", `${V}/deals`, () =>
        reply(
          {
            status: "error",
            message: "This app hasn't been granted all required scopes to make this call.",
            category: "MISSING_SCOPES",
            errors: [{ message: "One or more of the following scopes are required.", context: { requiredGranularScopes: ["crm.objects.deals.write"] } }],
          },
          403,
        ),
      ),
    ]);
    try {
      const r = await pushLeadToHubSpot({ lead: sampleLead(), sentAngle: SENT });
      check("E: missing scope names the scope and the step", !r.ok && r.error === "Saving the deal: The HubSpot private app is missing a scope: crm.objects.deals.write.", r.error);
      check("E: ids written before the failure are returned", r.companyId === "c4" && r.contactId === "p4" && !r.dealId, r);
      check("E: a failed create is not retried", m2.calls.filter((c) => c.method === "POST" && c.path === `${V}/deals`).length === 1);
    } finally {
      m2.restore();
    }
    const nameless = await pushLeadToHubSpot({ lead: sampleLead({ email: null, name: null }) });
    check("E: a lead with no name or email is refused before any call", !nameless.ok && /no name or email/.test(nameless.error ?? ""));
  }

  setEnv({ HUBSPOT_ACCESS_TOKEN: undefined });
  const off = await pushToHubSpot({ lead: sampleLead() });
  check("not configured -> ok false, no throw", off.ok === false && /HUBSPOT_ACCESS_TOKEN/.test(off.error ?? ""), off);
  restoreEnv();
}

// ------------------------------------------------------------------ 5. run guards against Neon

async function testRunGuards(): Promise<void> {
  section("5. run guards (Neon)");
  restoreEnv();
  setEnv({ APP_PASSWORD: undefined });

  // Run limits: defaults, env overrides, and bad values ignored.
  setEnv({ RUN_LIMIT_PER_HOUR: undefined, RUN_LIMIT_PER_DAY: undefined });
  const defaults = runLimits();
  check(
    "run limits default to 20 an hour and 25 a day",
    DEFAULT_RUNS_PER_HOUR === 20 && DEFAULT_RUNS_PER_DAY === 25 && defaults.perHour === 20 && defaults.perDay === 25,
    defaults,
  );
  setEnv({ RUN_LIMIT_PER_HOUR: "5", RUN_LIMIT_PER_DAY: "40" });
  check("run limits read RUN_LIMIT_PER_HOUR and RUN_LIMIT_PER_DAY", runLimits().perHour === 5 && runLimits().perDay === 40, runLimits());
  for (const bad of ["-3", "1.5", "abc", "1e3", "  ", "99999999999999999999"]) {
    setEnv({ RUN_LIMIT_PER_HOUR: bad, RUN_LIMIT_PER_DAY: bad });
    const l = runLimits();
    check(`run limit "${bad}" falls back to the defaults`, l.perHour === DEFAULT_RUNS_PER_HOUR && l.perDay === DEFAULT_RUNS_PER_DAY, l);
  }
  setEnv({ RUN_LIMIT_PER_HOUR: "0", RUN_LIMIT_PER_DAY: "3000000000" });
  check("run limit 0 is kept (it pauses runs), and a limit past 32 bits is kept", runLimits().perHour === 0 && runLimits().perDay === 3_000_000_000, runLimits());
  check(
    "429 messages name the window and the limit",
    /last hour \(the limit is 20\)/.test(runLimitMessage("hour", defaults)) &&
      /last 24 hours \(the limit is 25\)/.test(runLimitMessage("day", defaults)) &&
      /last hour and the last 24 hours \(the limits are 20 and 25\)/.test(runLimitMessage("both", defaults)),
  );
  check(
    "a limit of 0 reads as paused, in the 429 and in the new-lead event",
    /paused/.test(runLimitMessage("hour", { perHour: 0, perDay: 25 })) &&
      /paused/.test(runLimitMessage("both", { perHour: 20, perDay: 0 })) &&
      /paused/.test(runLimitEvent("day", { perHour: 20, perDay: 0 })) &&
      !/paused/.test(runLimitMessage("hour", { perHour: 20, perDay: 0 })),
  );
  // Limits far above any real count for the rest of this section, except where a check sets its own.
  setEnv({ RUN_LIMIT_PER_HOUR: "100000", RUN_LIMIT_PER_DAY: "100000" });

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  check("stale window is 6 minutes", STALE_RUN_MS === 6 * 60_000);
  check("isStaleRun: running past the window", isStaleRun({ researchStatus: "running", researchStartedAt: ago(STALE_RUN_MS + 5_000) }));
  check("isStaleRun: running inside the window", !isStaleRun({ researchStatus: "running", researchStartedAt: ago(STALE_RUN_MS - 60_000) }));
  check("isStaleRun: a finished run is never stale", !isStaleRun({ researchStatus: "error", researchStartedAt: ago(DAY) }));
  check("isStaleRun: no start time is not stale", !isStaleRun({ researchStatus: "running", researchStartedAt: null }));

  const angle: Angle = { id: "a1", name: "Angle", reasoning: "", findingIds: [], email: { subject: "s", body: "b" }, linkedinMessage: "m" };
  const brief: Brief = { summary: "Summary.", bullets: [], pains: [], objections: [], questions: [] };
  const tempIds: string[] = [];
  const tempLead = async (): Promise<string> => {
    const lead = await createLead({ linkedinUrl: `https://www.linkedin.com/in/le-api-guard-${randomBytes(4).toString("hex")}` });
    tempIds.push(lead.id);
    runLeadIds.add(lead.id);
    return lead.id;
  };
  const getOne = asHandler(leadRoute.GET);
  const research = asHandler(researchRoute.POST);
  const STALE_RE = /stopped before it finished/;

  try {
    // ---- the stage when a run ends (finishResearch)
    const id = await tempLead();
    const stageOf = async () => (await getLead(id))?.stage;
    const runThenFinish = async (status: "done" | "error") => {
      const claimed = await claimResearch(id);
      const during = await stageOf();
      await finishResearch(id, status, status === "error" ? "test failure" : undefined);
      return { claimed, during, after: await stageOf() };
    };
    let r = await runThenFinish("error");
    check("stage rule: a failed first run (no brief, no angles) goes back to new", r.claimed && r.during === "researching" && r.after === "new", r);
    r = await runThenFinish("done");
    check("stage rule: a done run is researched", r.claimed && r.after === "researched", r);
    await updateLead(id, { angles: [angle] });
    r = await runThenFinish("error");
    check("stage rule: a failed re-run keeps researched when angles exist", r.during === "researching" && r.after === "researched", r);
    await query("update le_leads set angles = '[]'::jsonb, brief = $2::jsonb where id = $1", [id, JSON.stringify(brief)]);
    r = await runThenFinish("error");
    check("stage rule: a failed re-run keeps researched when a brief exists", r.during === "researching" && r.after === "researched", r);
    await query("update le_leads set brief = 'null'::jsonb, angles = '{}'::jsonb where id = $1", [id]);
    let threw: unknown = null;
    r = await runThenFinish("error").catch((err: unknown) => {
      threw = err;
      return r;
    });
    check("stage rule: a JSON null brief and non-array angles count as nothing (no SQL error)", !threw && r.after === "new", threw ? String(threw) : r);
    await query("update le_leads set brief = null, angles = '[]'::jsonb where id = $1", [id]);
    await claimResearch(id);
    await updateLead(id, { stage: "contacted" });
    await finishResearch(id, "error", "test failure");
    check("stage rule: a stage changed during the run is kept", (await stageOf()) === "contacted");

    // ---- the stale-run reaper (a lost run: function killed at maxDuration, or a restart)
    const rid = await tempLead();
    const backdate = (minutes: number) => query("update le_leads set research_started_at = now() - make_interval(mins => $2) where id = $1", [rid, minutes]);
    const staleEvents = (events: unknown) => ((events ?? []) as LeadEvent[]).filter((e) => e.type === "error" && STALE_RE.test(e.message)).length;
    check("reaper: research claimed", await claimResearch(rid));
    await backdate(5);
    let d = await callRoute(getOne, { path: `/api/leads/${rid}`, id: rid });
    check("reaper: a run 5 minutes old is left running", (d.data?.lead as Lead | undefined)?.researchStatus === "running" && staleEvents(d.data?.events) === 0, d.data?.lead);
    await backdate(7);
    d = await callRoute(getOne, { path: `/api/leads/${rid}`, id: rid });
    const reaped = d.data?.lead as Lead | undefined;
    check(
      "reaper: GET /api/leads/[id] marks a run 7 minutes old as failed",
      d.status === 200 && reaped?.researchStatus === "error" && STALE_RE.test(reaped.researchError ?? "") && reaped.researchStep === null && Boolean(reaped.researchFinishedAt),
      reaped && { status: reaped.researchStatus, error: reaped.researchError, step: reaped.researchStep },
    );
    check("reaper: the stage goes back to new (no brief or angles)", reaped?.stage === "new", reaped?.stage);
    check("reaper: the same reply carries one error event", staleEvents(d.data?.events) === 1);
    d = await callRoute(getOne, { path: `/api/leads/${rid}`, id: rid });
    check("reaper: a second GET logs nothing more", staleEvents(d.data?.events) === 1 && (d.data?.lead as Lead | undefined)?.researchStatus === "error");
    const tasks = afterTasks.length;
    const retry = await callRoute(research, { method: "POST", path: `/api/leads/${rid}/research`, id: rid });
    check("reaper: a retry is accepted at once (202)", retry.status === 202 && afterTasks.length === tasks + 1, retry.data);
    await updateLead(rid, { angles: [angle] });
    await backdate(7);
    const list = await callRoute(asHandler(leadsRoute.GET), { path: "/api/leads" });
    const listed = ((list.data?.leads ?? []) as Lead[]).find((l) => l.id === rid);
    check(
      "reaper: GET /api/leads marks it failed too, and keeps researched (angles exist)",
      list.status === 200 && listed?.researchStatus === "error" && listed.stage === "researched",
      listed && { status: listed.researchStatus, stage: listed.stage },
    );
    check("reaper: the list logged one more error event", staleEvents(await listEvents(rid)) === 2);

    // ---- the run caps: le_run_starts rows, counted and inserted under one advisory lock.
    // Each check sets the limits just above what the table already holds, so the result does
    // not depend on how many real runs happened in the last day.
    const counts = async () =>
      (
        await query<{ hour: number; day: number }>(
          `select count(*) filter (where created_at > now() - interval '1 hour')::int as hour, count(*)::int as day
             from le_run_starts where created_at > now() - interval '24 hours'`,
        )
      )[0] ?? { hour: 0, day: 0 };
    const startsFor = async (leadId: string) =>
      (await query<{ n: number }>("select count(*)::int as n from le_run_starts where lead_id = $1", [leadId]))[0]?.n ?? 0;
    const steerPost = asHandler(steerRoute.POST);
    const leadsPost = asHandler(leadsRoute.POST);
    const createWithoutRun = async () => {
      const res = await callRoute(leadsPost, { method: "POST", path: "/api/leads", body: { linkedinUrl: `linkedin.com/in/le-api-cap-${randomBytes(4).toString("hex")}` } });
      const lead = res.data?.lead as Lead | undefined;
      if (lead?.id) {
        tempIds.push(lead.id);
        runLeadIds.add(lead.id);
      }
      return { res, lead, events: lead ? await listEvents(lead.id) : [] };
    };

    // Hourly cap: room for 2 more, then 2 fake run starts fill it.
    let c = await counts();
    setEnv({ RUN_LIMIT_PER_HOUR: String(c.hour + 2), RUN_LIMIT_PER_DAY: "100000" });
    let limits = runLimits();
    const bid = await tempLead();
    await query("insert into le_run_starts (lead_id, kind) select $1::uuid, 'research' from generate_series(1, 2)", [bid]);
    const before = afterTasks.length;
    const r1 = await callRoute(research, { method: "POST", path: `/api/leads/${bid}/research`, id: bid });
    check("cap: POST /research is 429 when the hour is full", r1.status === 429 && r1.data?.error === runLimitMessage("hour", limits), r1.data);
    const s1 = await callRoute(steerPost, { method: "POST", path: `/api/leads/${bid}/steer`, id: bid, body: { instruction: "dig into their compute" } });
    check("cap: POST /steer is 429 too", s1.status === 429 && s1.data?.error === runLimitMessage("hour", limits), s1.data);
    check("cap: nothing was claimed or handed to after()", afterTasks.length === before && (await getLead(bid))?.researchStatus === "idle");
    check("cap: a refused request takes no slot", (await startsFor(bid)) === 2);
    const hourly = await createWithoutRun();
    check(
      "cap: POST /api/leads still creates the lead (201), without a run",
      hourly.res.status === 201 && hourly.lead?.researchStatus === "idle" && hourly.lead?.stage === "new" && afterTasks.length === before,
      hourly.res.data,
    );
    check(
      "cap: an event on the new lead says why research did not start",
      hourly.events.some((e) => e.type === "error" && e.message === runLimitEvent("hour", limits)),
      hourly.events.map((e) => `${e.type}: ${e.message}`),
    );
    await query("delete from le_run_starts where lead_id = $1", [bid]);
    const r2 = await callRoute(research, { method: "POST", path: `/api/leads/${bid}/research`, id: bid });
    check("cap: under the cap again, POST /research is 202 and takes one slot", r2.status === 202 && (await startsFor(bid)) === 1, r2.data);

    // Daily cap: the last 24 hours already hold the limit.
    c = await counts();
    setEnv({ RUN_LIMIT_PER_HOUR: "100000", RUN_LIMIT_PER_DAY: String(Math.max(1, c.day)) });
    limits = runLimits();
    if (c.day === 0) await query("insert into le_run_starts (lead_id, kind) values ($1::uuid, 'research')", [bid]);
    const did = await tempLead();
    const r3 = await callRoute(research, { method: "POST", path: `/api/leads/${did}/research`, id: did });
    check("cap: POST /research is 429 when the 24 hours are full", r3.status === 429 && r3.data?.error === runLimitMessage("day", limits), r3.data);
    const daily = await createWithoutRun();
    check(
      "cap: the new lead's event names the daily limit",
      daily.res.status === 201 && daily.events.some((e) => e.type === "error" && e.message === runLimitEvent("day", limits)),
      daily.events.map((e) => `${e.type}: ${e.message}`),
    );

    // A burst: 8 requests at once with room for 3 start exactly 3 runs.
    c = await counts();
    setEnv({ RUN_LIMIT_PER_HOUR: String(c.hour + 3), RUN_LIMIT_PER_DAY: "100000" });
    const burstIds = await Promise.all(Array.from({ length: 8 }, () => tempLead()));
    const burstBefore = afterTasks.length;
    const burst = await Promise.all(burstIds.map((lid) => callRoute(research, { method: "POST", path: `/api/leads/${lid}/research`, id: lid })));
    check(
      "cap: a burst of 8 with room for 3 starts exactly 3 runs",
      burst.filter((r) => r.status === 202).length === 3 && burst.filter((r) => r.status === 429).length === 5 && afterTasks.length === burstBefore + 3,
      burst.map((r) => r.status),
    );

    // Both windows full: the reply names both limits.
    await query("insert into le_run_starts (lead_id, kind) values ($1::uuid, 'research')", [bid]);
    c = await counts();
    setEnv({ RUN_LIMIT_PER_HOUR: String(c.hour), RUN_LIMIT_PER_DAY: String(c.day) });
    limits = runLimits();
    const both = await callRoute(research, { method: "POST", path: `/api/leads/${did}/research`, id: did });
    check("cap: with both windows full the 429 names both limits", both.status === 429 && both.data?.error === runLimitMessage("both", limits), both.data);

    // A limit of 0 pauses runs: 429 that says so, and a new lead is saved with an event saying so.
    setEnv({ RUN_LIMIT_PER_HOUR: "100000", RUN_LIMIT_PER_DAY: "0" });
    limits = runLimits();
    const pausedRun = await callRoute(research, { method: "POST", path: `/api/leads/${did}/research`, id: did });
    check("cap: RUN_LIMIT_PER_DAY=0 pauses runs (429, says paused)", pausedRun.status === 429 && /paused/.test(String(pausedRun.data?.error)), pausedRun.data);
    const pausedLead = await createWithoutRun();
    check(
      "cap: while paused a new lead is saved, with an event that says runs are paused",
      pausedLead.res.status === 201 && pausedLead.events.some((e) => e.type === "error" && e.message === runLimitEvent("day", limits)),
      pausedLead.events.map((e) => `${e.type}: ${e.message}`),
    );

    // A limit past 32 bits still binds in SQL (compared as bigint), so runs start normally.
    setEnv({ RUN_LIMIT_PER_HOUR: "3000000000", RUN_LIMIT_PER_DAY: "3000000000" });
    const huge = await callRoute(research, { method: "POST", path: `/api/leads/${did}/research`, id: did });
    check("cap: a limit of 3,000,000,000 works (202, not a database error)", huge.status === 202, huge.data);

    // A claim that fails gives its slot back; deleting the lead does not.
    setEnv({ RUN_LIMIT_PER_HOUR: "100000", RUN_LIMIT_PER_DAY: "100000" });
    const kid = await tempLead();
    const k1 = await callRoute(research, { method: "POST", path: `/api/leads/${kid}/research`, id: kid });
    const k2 = await callRoute(research, { method: "POST", path: `/api/leads/${kid}/research`, id: kid });
    check("cap: a 409 (already running) gives its slot back", k1.status === 202 && k2.status === 409 && (await startsFor(kid)) === 1, [k1.status, k2.status]);
    const ghostLead = "00000000-0000-4000-8000-00000000c0de";
    runLeadIds.add(ghostLead);
    const g = await callRoute(research, { method: "POST", path: `/api/leads/${ghostLead}/research`, id: ghostLead });
    check("cap: a 404 (unknown lead) gives its slot back", g.status === 404 && (await startsFor(ghostLead)) === 0, g.status);
    await deleteLead(kid);
    check("cap: run starts outlive their lead (deleting leads does not free slots)", (await startsFor(kid)) === 1);
  } finally {
    for (const tempId of tempIds) await deleteLead(tempId).catch(() => undefined);
    console.log(`  (cleaned up ${tempIds.length} temp leads and their events)`);
    restoreEnv();
  }
}

// ------------------------------------------------------------------ 6. unqualified leads and bulk actions

/** Temp leads in this section are named "LE Qualify Test <run> <label>", so they are obviously fake. */
const QUALIFY_PREFIX = `LE Qualify Test ${randomBytes(3).toString("hex")}`;

/** One row of the restore mapping: an unqualified lead as stored, and the stage Restore must give it. */
interface RestoreCase {
  label: string;
  before: ActiveStage | null;
  status: ResearchStatus;
  /** When its latest run started: before it was marked, or after (a run on the unqualified lead). */
  run?: "before" | "after";
  contacted?: boolean;
  research?: "brief" | "angles";
  want: ActiveStage;
}

const RESTORE_CASES: RestoreCase[] = [
  { label: "contacted goes back to contacted", before: "contacted", status: "done", research: "brief", contacted: true, want: "contacted" },
  { label: "nurture", before: "nurture", status: "idle", want: "nurture" },
  { label: "lost", before: "lost", status: "done", research: "brief", want: "lost" },
  { label: "replied", before: "replied", status: "done", research: "angles", contacted: true, want: "replied" },
  { label: "call booked, with a re-run going", before: "call_booked", status: "running", run: "after", want: "call_booked" },
  { label: "marked mid-run, the run still going", before: "researching", status: "running", run: "before", want: "researching" },
  { label: "marked mid-run, the run done", before: "researching", status: "done", run: "before", research: "brief", want: "researched" },
  { label: "marked mid-run, the run failed with nothing", before: "researching", status: "error", run: "before", want: "new" },
  { label: "marked mid-run, a re-run failed, angles kept", before: "researching", status: "error", run: "before", research: "angles", want: "researched" },
  { label: "new, a run started after it was marked, still going", before: "new", status: "running", run: "after", want: "researching" },
  { label: "new, a run started after it was marked, done", before: "new", status: "done", run: "after", research: "brief", want: "researched" },
  { label: "new, a run started after it was marked, failed with nothing", before: "new", status: "error", run: "after", want: "new" },
  { label: "new on purpose (its last run was before it was marked)", before: "new", status: "done", run: "before", research: "brief", want: "new" },
  { label: "researched, a run since then failed, brief kept", before: "researched", status: "error", run: "after", research: "brief", want: "researched" },
  { label: "researched, no run since", before: "researched", status: "done", run: "before", research: "brief", want: "researched" },
  { label: "none recorded, contacted", before: null, status: "done", contacted: true, research: "brief", want: "contacted" },
  { label: "none recorded, research done", before: null, status: "done", research: "brief", want: "researched" },
  { label: "none recorded, a run going", before: null, status: "running", run: "after", want: "researching" },
  { label: "none recorded, nothing", before: null, status: "idle", want: "new" },
];

const QUALIFY_BRIEF: Brief = { summary: "LE Qualify Test brief.", bullets: [], pains: [], objections: [], questions: [] };
const QUALIFY_ANGLE: Angle = { id: "a1", name: "Angle", reasoning: "", findingIds: [], email: { subject: "s", body: "b" }, linkedinMessage: "m" };

/**
 * A case as the lead's fields. Every time is within the last few minutes, so no run here looks
 * stale (6 minutes) to a list's reaper while the case is set up.
 */
function restoreInput(c: RestoreCase, markedAt: number): RestoreInput {
  const at = (ms: number) => new Date(ms).toISOString();
  return {
    stageBeforeUnqualified: c.before,
    unqualifiedAt: at(markedAt),
    researchStatus: c.status,
    researchStartedAt: c.run ? at(markedAt + (c.run === "after" ? 2 : -1) * 60_000) : null,
    lastContactedAt: c.contacted ? at(markedAt - 60 * 60_000) : null,
    brief: c.research === "brief" ? QUALIFY_BRIEF : null,
    angles: c.research === "angles" ? [QUALIFY_ANGLE] : [],
  };
}

async function testQualify(): Promise<void> {
  section("6. unqualified leads and bulk actions");
  restoreEnv();
  setEnv({ APP_PASSWORD: undefined, HUBSPOT_ACCESS_TOKEN: undefined, RUN_LIMIT_PER_HOUR: "100000", RUN_LIMIT_PER_DAY: "100000" });
  const tasksAtStart = afterTasks.length;

  // ---- pure: stages, reasons, next action, the restore mapping, messages
  check(
    "STAGES ends with unqualified (label Unqualified); ACTIVE_STAGES is every other stage",
    STAGES[STAGES.length - 1] === "unqualified" &&
      STAGE_LABELS.unqualified === "Unqualified" &&
      JSON.stringify(ACTIVE_STAGES) === JSON.stringify(STAGES.slice(0, -1)),
    ACTIVE_STAGES,
  );
  check(
    "UNQUALIFIED_REASONS: the five quick picks",
    JSON.stringify(UNQUALIFIED_REASONS.map((r) => `${r.key}=${r.label}`)) ===
      JSON.stringify(["not_fit=Not a fit", "wrong_person=Wrong person", "no_need=No need right now", "competitor=Competitor or partner", "bad_data=Bad or duplicate data"]),
  );
  const unq = sampleLead({ stage: "unqualified", unqualifiedAt: new Date().toISOString(), stageBeforeUnqualified: "researched" });
  const na = nextAction(unq);
  check("nextAction: unqualified is Unqualified, quiet, priority 99 (after lost at 95)", na.label === "Unqualified" && na.tone === "quiet" && na.priority === 99 && nextAction(sampleLead({ stage: "lost" })).priority === 95, na);
  const naRunning = nextAction({ ...unq, researchStatus: "running" });
  const naFailed = nextAction({ ...unq, researchStatus: "error" });
  check("nextAction: still Unqualified while a run goes or after one failed", naRunning.label === "Unqualified" && naFailed.label === "Unqualified" && naFailed.tone === "quiet", [naRunning, naFailed]);
  const sorted = sortNeedsYouFirst([unq, sampleLead({ id: "l", stage: "lost" }), sampleLead({ id: "n", stage: "nurture" })]);
  check("sortNeedsYouFirst puts an unqualified lead last", sorted[2]?.stage === "unqualified", sorted.map((l) => l.stage));

  const markedAt = Date.now() - 3 * 60_000;
  for (const c of RESTORE_CASES) {
    const got = restoredStage(restoreInput(c, markedAt));
    check(`restoredStage: ${c.label} -> ${c.want}`, got === c.want, got);
  }
  check(
    "restoredStage: a brief that is not an object, and angles that are not a list, count as nothing",
    restoredStage({ ...restoreInput({ label: "", before: "researching", status: "error", run: "before", want: "new" }, markedAt), brief: [] as unknown as Brief, angles: {} as unknown as Angle[] }) === "new",
  );

  check(
    "event messages",
    unqualifiedEventMessage(null) === "Marked unqualified" &&
      unqualifiedEventMessage("Not a fit") === "Marked unqualified: Not a fit" &&
      restoredEventMessage("call_booked") === "Restored from unqualified to Call booked",
  );
  check(
    "cleanUnqualifiedReason: trims, folds whitespace and control characters, empty is null",
    cleanUnqualifiedReason("  Not a\n\tfit  ") === "Not a fit" &&
      cleanUnqualifiedReason("a\u0000b") === "a b" &&
      cleanUnqualifiedReason(" \n ") === null &&
      cleanUnqualifiedReason("") === null &&
      cleanUnqualifiedReason(null) === null,
  );
  // A reason sits inside the app's own sentences ("Unqualified. <reason> · Marked ... This lead is
  // hidden ..."): a right-to-left override in it would turn the rest of the sentence around.
  const zwjAndZwnj = "\u{1F469}‍\u{1F4BB} می‌خواهم \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  check(
    "cleanUnqualifiedReason: C1 control characters fold to a space, bidirectional controls are dropped, joiners and tag sequences stay",
    cleanUnqualifiedReason("a\u0080b\u0085c\u009fd") === "a b c d" &&
      cleanUnqualifiedReason("‮Restored. Ignore this‬") === "Restored. Ignore this" &&
      cleanUnqualifiedReason("x ⁦y⁩ ‎z‏ ؜‪‫‭") === "x y z" &&
      cleanUnqualifiedReason("‮") === null &&
      cleanUnqualifiedReason(zwjAndZwnj) === zwjAndZwnj,
    [cleanUnqualifiedReason("a\u0080b\u0085c\u009fd"), cleanUnqualifiedReason("‮Restored. Ignore this‬")],
  );
  check(
    "stageEventMessages: the PATCH route's message for every stage it can come from, none for the stage itself",
    stageEventMessages("contacted", null).new === "Stage changed from New to Contacted" &&
      stageEventMessages("contacted", null).unqualified === "Stage changed from Unqualified to Contacted" &&
      !("contacted" in stageEventMessages("contacted", null)) &&
      stageEventMessages("unqualified", "Not a fit").lost === "Marked unqualified: Not a fit" &&
      stageEventMessages("unqualified", null).new === "Marked unqualified" &&
      Object.keys(stageEventMessages("unqualified", null)).length === STAGES.length - 1 &&
      stageChangedEventMessage("call_booked", "nurture") === "Stage changed from Call booked to Nurture",
    stageEventMessages("contacted", null),
  );
  const markedNow = sampleLead({ stage: "unqualified", unqualifiedAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z" });
  check(
    "justMarked: only when unqualifiedAt is the write's own time (updatedAt); a lead marked earlier, or one not unqualified, is not",
    justMarked(markedNow) &&
      !justMarked({ ...markedNow, updatedAt: "2026-11-20T10:00:05.000Z" }) &&
      !justMarked({ ...markedNow, stage: "lost", unqualifiedAt: null }) &&
      !justMarked({ ...markedNow, unqualifiedAt: null }),
  );
  const someId = "AAAAAAAA-0000-4000-8000-000000000001";
  check(
    "uniqueLeadIds: lower case, each once, in order, non-UUIDs dropped",
    JSON.stringify(uniqueLeadIds([someId, "nope", someId.toLowerCase(), "00000000-0000-4000-8000-000000000002"])) ===
      JSON.stringify([someId.toLowerCase(), "00000000-0000-4000-8000-000000000002"]),
  );

  // ---- POST /api/leads/bulk: refused before anything is read or written
  const bulk = asHandler(bulkRoute.POST);
  const post = (body: unknown) => callRoute(bulk, { method: "POST", path: "/api/leads/bulk", body });
  const ghost = "00000000-0000-4000-8000-00000000dead";
  const manyIds = (n: number) => Array.from({ length: n }, () => randomUUID());
  for (const [label, body, pattern] of [
    ["an empty body", {}, /^action: Use "unqualify", "restore" or "delete"\.$/],
    ["an unknown action", { action: "archive", ids: [ghost] }, /^action: Use "unqualify", "restore" or "delete"\.$/],
    ["no ids", { action: "delete" }, /^ids: Send a list of lead ids\.$/],
    ["ids that are not a list", { action: "restore", ids: ghost }, /^ids: Send a list of lead ids\.$/],
    ["no ids at all", { action: "delete", ids: [] }, /at least one lead/],
    [`${BULK_LEADS_MAX + 1} ids`, { action: "delete", ids: manyIds(BULK_LEADS_MAX + 1) }, /at most 500 leads/],
    ["an id that is not a UUID", { action: "restore", ids: [ghost, "not-a-uuid"] }, /ids\.1: Each id must be a lead id/],
    ["an id that is not text", { action: "unqualify", ids: [42] }, /Each id must be text/],
    ["a reason over 200 characters", { action: "unqualify", ids: [ghost], reason: "x".repeat(201) }, /^reason: Keep it to 200 characters or fewer\.$/],
    ["a reason that is not text", { action: "unqualify", ids: [ghost], reason: 5 }, /^reason: Send it as text, or null\.$/],
  ] as const) {
    const { value: r, lines } = await warnsDuring(() => post(body));
    check(`POST /api/leads/bulk with ${label} is 400 that says why, and logs nothing`, r.status === 400 && pattern.test(String(r.data?.error)) && lines.length === 0, { data: r.data, lines });
  }
  const plain = await callRoute(bulk, { method: "POST", path: "/api/leads/bulk", rawBody: JSON.stringify({ action: "delete", ids: [ghost] }), headers: { "content-type": "text/plain" } });
  check("POST /api/leads/bulk with a text/plain body is 415", plain.status === 415, plain.data);
  const broken = await callRoute(bulk, { method: "POST", path: "/api/leads/bulk", rawBody: "{nope" });
  check("POST /api/leads/bulk with broken JSON is 400", broken.status === 400, broken.data);
  const fullBatch = manyIds(BULK_LEADS_MAX);
  const atMax = await post({ action: "restore", ids: fullBatch });
  check(
    `POST /api/leads/bulk with ${BULK_LEADS_MAX} unknown ids (restore) is 200, all missing`,
    atMax.status === 200 && (atMax.data?.leads as unknown[])?.length === 0 && JSON.stringify(atMax.data?.missing) === JSON.stringify(fullBatch),
    atMax.status,
  );
  const exact200 = await post({ action: "unqualify", ids: [ghost], reason: "y".repeat(200) });
  check("a reason of exactly 200 characters is accepted (unknown id: missing)", exact200.status === 200 && JSON.stringify(exact200.data?.missing) === JSON.stringify([ghost]), exact200.data);
  const { value: delGhost, lines: delGhostLog } = await warnsDuring(() => post({ action: "delete", ids: [ghost, ghost.toUpperCase()] }));
  check(
    "bulk delete of an unknown id (twice, in two cases): 200 { deleted: [], missing: [it] }, and no log line (nothing changed)",
    delGhost.status === 200 && JSON.stringify(delGhost.data) === JSON.stringify({ deleted: [], missing: [ghost] }) && delGhostLog.length === 0,
    { data: delGhost.data, delGhostLog },
  );
  // A plain "delete ... where id = any(...)" locks rows in the order a scan meets them, and can
  // deadlock with a bulk unqualify or restore of the same leads, which lock in id order. EXPLAIN
  // only plans the statement: nothing is deleted.
  const deletePlan = (await query<Record<string, string>>(`explain (costs off) ${DELETE_LEADS_SQL.replace("$1::uuid[]", `array['${ghost}']::uuid[]`)}`))
    .map((row) => Object.values(row)[0])
    .join("\n");
  const lockAt = deletePlan.indexOf("LockRows");
  check(
    "bulk delete locks its rows in id order first, like unqualify and restore (LockRows over rows sorted by id)",
    lockAt >= 0 && /Sort Key: [\w.]*\bid\b|Index (?:Only )?Scan using le_leads_pkey/.test(deletePlan.slice(lockAt)),
    deletePlan,
  );

  // ---- GET /api/leads?view=
  const list = asHandler(leadsRoute.GET);
  const getList = (query = "") => callRoute(list, { path: `/api/leads${query}` });
  const bogus = await getList("?view=lost");
  check('GET /api/leads?view=lost is 400 that names the views', bogus.status === 400 && /view must be "active" or "unqualified"/.test(String(bogus.data?.error)), bogus.data);
  const emptyView = await getList("?view=");
  check("GET /api/leads?view= (empty) is the active list", emptyView.status === 200 && Array.isArray(emptyView.data?.leads), emptyView.status);

  // ---- against the database: temp leads only, each block deletes its own in a finally
  const made: string[] = [];
  // A run stopped before its finally ran (Ctrl-C, a timeout, a cancelled job) leaves its temp
  // leads behind, maybe unqualified, and a later run's prefix differs: remove any run's that are
  // over 10 minutes old (a run going at the same moment keeps its own).
  const sweepStale = () => query<{ id: string }>("delete from le_leads where name like 'LE Qualify Test %' and created_at < now() - interval '10 minutes' returning id");
  const swept = await sweepStale();
  if (swept.length) console.log(`  (removed ${swept.length} temp leads an earlier run left behind)`);
  // Ctrl-C or SIGTERM in the middle: delete this run's temp leads before exiting.
  const onSignal = (signal: NodeJS.Signals) =>
    void deleteLeads(made)
      .catch(() => undefined)
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const make = async (label: string, over?: LeadPatch): Promise<Lead> => {
    const lead = await createLead({ linkedinUrl: `https://www.linkedin.com/in/le-qualify-test-${randomBytes(5).toString("hex")}`, name: `${QUALIFY_PREFIX} ${label}` });
    made.push(lead.id);
    runLeadIds.add(lead.id);
    return over ? ((await updateLead(lead.id, over)) ?? lead) : lead;
  };
  const rowOf = async (id: string) =>
    (
      await query<{ stage: string; unqualified_at: string | null; unqualified_reason: string | null; stage_before_unqualified: string | null; research_status: string; research_step: string | null; updated_at: string }>(
        // Times as text: exact to the microsecond, and comparable with ===.
        "select stage, unqualified_at::text as unqualified_at, unqualified_reason, stage_before_unqualified, research_status, research_step, updated_at::text as updated_at from le_leads where id = $1",
        [id],
      )
    )[0];
  const stageEvents = async (id: string) => (await listEvents(id)).filter((e) => e.type === "stage");
  const idsOf = (data: Record<string, unknown> | null) => ((data?.leads ?? []) as Lead[]).map((l) => l.id);
  const sameList = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  /** counts from the reply against a direct count; one retry, in case a teammate's change landed in between. */
  const countsAgree = async (res: { data: Record<string, unknown> | null }, again: () => Promise<{ data: Record<string, unknown> | null }>) => {
    for (const reply of [res, await again()]) if (sameList(reply.data?.counts, await countLeads())) return true;
    return false;
  };
  const patch = asHandler(leadRoute.PATCH);
  const patchLead = (id: string, body: unknown) => callRoute(patch, { method: "PATCH", path: `/api/leads/${id}`, id, body });

  try {
    // ---- 0: the start-of-run sweep removes another run's leftovers and keeps a lead made just now
    {
      const old = await make("left behind");
      const fresh = await make("fresh");
      await query("update le_leads set created_at = now() - interval '20 minutes' where id = $1", [old.id]);
      const sweptNow = (await sweepStale()).map((r) => String(r.id));
      check(
        "0: the sweep removes a temp lead over 10 minutes old and keeps a new one",
        sweptNow.includes(old.id) && !sweptNow.includes(fresh.id) && (await getLead(old.id)) === null && (await getLead(fresh.id)) !== null,
        { sweptNow, old: old.id, fresh: fresh.id },
      );
      await deleteLeads([fresh.id]).catch(() => undefined);
    }

    // ---- A: list views and counts, bulk unqualify, marking twice, the 409s, restore, delete
    {
      const a = await make("A");
      const b = await make("B", { stage: "contacted", lastContactedAt: new Date().toISOString() });
      const c = await make("C");
      try {
        const before = await getList();
        const beforeCounts = before.data?.counts as { active: number; unqualified: number };
        check("A: the temp leads start on the active list", ["a", "b", "c"].every((_, i) => idsOf(before.data).includes([a, b, c][i].id)));

        const { value: marked, lines: markedLog } = await warnsDuring(() => post({ action: "unqualify", ids: [a.id, b.id.toUpperCase(), a.id, ghost], reason: "  Not a fit \n" }));
        const ra = await rowOf(a.id);
        const rb = await rowOf(b.id);
        check(
          "A: bulk unqualify is 200 with the leads in the order sent, repeats removed, unknown ids missing",
          marked.status === 200 && sameList(idsOf(marked.data), [a.id, b.id]) && sameList(marked.data?.missing, [ghost]),
          marked.data && { ids: idsOf(marked.data), missing: marked.data.missing },
        );
        check("A: ... and one line in the server log: the action, the count, then the ids", sameList(markedLog, [`[api] bulk unqualify: 2 of 3 leads: ${a.id} ${b.id}`]), markedLog);
        check(
          "A: justMarked is true for each lead this action marked (the Leads page offers Undo for exactly these)",
          ((marked.data?.leads ?? []) as Lead[]).length === 2 && ((marked.data?.leads ?? []) as Lead[]).every(justMarked),
          ((marked.data?.leads ?? []) as Lead[]).map((l) => ({ at: l.unqualifiedAt, updated: l.updatedAt })),
        );
        check(
          "A: the rows: stage unqualified, when it was marked, the reason trimmed, the stage each had before",
          ra?.stage === "unqualified" && Boolean(ra.unqualified_at) && ra.unqualified_reason === "Not a fit" && ra.stage_before_unqualified === "new" && rb?.stage === "unqualified" && rb.stage_before_unqualified === "contacted",
          { ra, rb },
        );
        const replyA = (marked.data?.leads as Lead[] | undefined)?.[0];
        const storedA = await getLead(a.id);
        check(
          "A: the reply's leads carry unqualifiedAt, unqualifiedReason and stageBeforeUnqualified",
          replyA?.stage === "unqualified" && replyA.unqualifiedReason === "Not a fit" && replyA.stageBeforeUnqualified === "new" && Boolean(replyA.unqualifiedAt) && replyA.unqualifiedAt === storedA?.unqualifiedAt,
          replyA && { stage: replyA.stage, at: replyA.unqualifiedAt, reason: replyA.unqualifiedReason, before: replyA.stageBeforeUnqualified },
        );
        const [ea, eb] = await Promise.all([stageEvents(a.id), stageEvents(b.id)]);
        check(
          'A: one "stage" event each: "Marked unqualified: Not a fit" with { from, to, reason }',
          ea.length === 1 &&
            eb.length === 1 &&
            ea[0].message === "Marked unqualified: Not a fit" &&
            sameList(ea[0].data, { to: "unqualified", from: "new", reason: "Not a fit" }) &&
            (eb[0].data as { from?: string })?.from === "contacted",
          { ea, eb },
        );

        const [active, unqualified] = await Promise.all([getList(), getList("?view=unqualified")]);
        check("A: the active list leaves them out, keeps the rest", !idsOf(active.data).includes(a.id) && !idsOf(active.data).includes(b.id) && idsOf(active.data).includes(c.id));
        const unqIds = idsOf(unqualified.data);
        const order = [a.id, b.id].sort();
        check(
          "A: the unqualified view has them (one batch: same time, so in id order), and no active lead",
          unqualified.status === 200 && unqIds.includes(a.id) && unqIds.includes(b.id) && !unqIds.includes(c.id) && unqIds.indexOf(order[0]) < unqIds.indexOf(order[1]) && ((unqualified.data?.leads ?? []) as Lead[]).every((l) => l.stage === "unqualified"),
          unqIds,
        );
        const afterCounts = unqualified.data?.counts as { active: number; unqualified: number };
        // Only this test makes unqualified leads (the deployed code cannot), so that count moves by
        // exactly two; the active count is checked against a direct count, since a teammate may
        // add a lead meanwhile.
        check("A: counts: two more unqualified leads", afterCounts?.unqualified === beforeCounts.unqualified + 2, { beforeCounts, afterCounts });
        check("A: the counts agree with a direct count", await countsAgree(unqualified, () => getList("?view=unqualified")));

        // The single add and a LinkedIn edit say when the person is an unqualified lead.
        const dup = await callRoute(asHandler(leadsRoute.POST), { method: "POST", path: "/api/leads", body: { linkedinUrl: a.linkedinUrl } });
        check(
          "A: POST /api/leads for an unqualified person is 409 with existingId, existingStage and a message that says so",
          dup.status === 409 && dup.data?.existingId === a.id && dup.data?.existingStage === "unqualified" && dup.data?.error === "This person is already a lead (marked unqualified).",
          dup.data,
        );
        const taken = await patchLead(c.id, { linkedinUrl: a.linkedinUrl });
        check("A: PATCH linkedinUrl that an unqualified lead has is 409 with existingStage", taken.status === 409 && taken.data?.existingId === a.id && taken.data?.existingStage === "unqualified", taken.data);

        // Marking twice: no reason keeps everything; a reason replaces only the reason. No second event.
        const again = await post({ action: "unqualify", ids: [a.id] });
        const ra2 = await rowOf(a.id);
        check(
          "A: marking again without a reason keeps when, the reason and the stage before",
          again.status === 200 && ra2?.unqualified_at === ra?.unqualified_at && ra2?.unqualified_reason === "Not a fit" && ra2?.stage_before_unqualified === "new",
          ra2,
        );
        const relabel = await post({ action: "unqualify", ids: [a.id], reason: "Wrong person" });
        const ra3 = await rowOf(a.id);
        check("A: marking again with a reason replaces the reason, keeps when it was marked", relabel.status === 200 && ra3?.unqualified_reason === "Wrong person" && ra3?.unqualified_at === ra?.unqualified_at, ra3);
        check("A: marking twice logs no second event", (await stageEvents(a.id)).length === 1);
        // A teammate (or another tab) marked it first: Undo on this page must not restore it.
        const againLead = ((again.data?.leads ?? []) as Lead[])[0];
        const relabelLead = ((relabel.data?.leads ?? []) as Lead[])[0];
        check(
          "A: justMarked is false for a lead that was unqualified already (marking again, with or without a reason)",
          Boolean(againLead && relabelLead) && !justMarked(againLead) && !justMarked(relabelLead),
          againLead && { at: againLead.unqualifiedAt, updated: againLead.updatedAt },
        );

        const { value: restored, lines: restoredLog } = await warnsDuring(() => post({ action: "restore", ids: [a.id, b.id, c.id, ghost] }));
        const [rra, rrb] = await Promise.all([rowOf(a.id), rowOf(b.id)]);
        check(
          "A: bulk restore is 200 with the unqualified leads; an active lead and an unknown id are missing",
          restored.status === 200 && sameList(idsOf(restored.data), [a.id, b.id]) && sameList(restored.data?.missing, [c.id, ghost]),
          restored.data && { ids: idsOf(restored.data), missing: restored.data.missing },
        );
        check("A: ... and one line in the server log", sameList(restoredLog, [`[api] bulk restore: 2 of 4 leads: ${a.id} ${b.id}`]), restoredLog);
        check(
          "A: back on the stage each had, the three fields cleared (rows)",
          rra?.stage === "new" && rrb?.stage === "contacted" && [rra, rrb].every((r) => r.unqualified_at === null && r.unqualified_reason === null && r.stage_before_unqualified === null),
          { rra, rrb },
        );
        const [ra4, rb4] = await Promise.all([stageEvents(a.id), stageEvents(b.id)]);
        check(
          'A: one "Restored from unqualified to <stage>" event each, with { from, to }',
          ra4.length === 2 && ra4[0].message === "Restored from unqualified to New" && sameList(ra4[0].data, { to: "new", from: "unqualified" }) && rb4[0].message === "Restored from unqualified to Contacted",
          [ra4[0], rb4[0]],
        );
        const { value: restoreAgain, lines: restoreAgainLog } = await warnsDuring(() => post({ action: "restore", ids: [a.id] }));
        check(
          "A: restoring a lead that is not unqualified changes nothing (missing), and logs nothing",
          restoreAgain.status === 200 && sameList(restoreAgain.data?.missing, [a.id]) && (await stageEvents(a.id)).length === 2 && restoreAgainLog.length === 0,
          { data: restoreAgain.data, restoreAgainLog },
        );
        check("A: they are on the active list again", idsOf((await getList()).data).includes(a.id));

        // Delete for good, as the single delete does: findings, events and raw rows go too.
        await query("insert into le_findings (lead_id, source, kind, text) values ($1, 'notes', 'other', 'LE Qualify Test finding')", [a.id]);
        await query("insert into le_raw (lead_id, provider, request) values ($1, 'test', '{}'::jsonb)", [a.id]);
        const { value: del, lines: delLog } = await warnsDuring(() => post({ action: "delete", ids: [a.id, b.id, ghost] }));
        check("A: bulk delete is 200 { deleted, missing }", del.status === 200 && sameList(del.data?.deleted, [a.id, b.id]) && sameList(del.data?.missing, [ghost]), del.data);
        check("A: ... and one line in the server log, with the count and the ids deleted", sameList(delLog, [`[api] bulk delete: 2 of 3 leads: ${a.id} ${b.id}`]), delLog);
        const leftovers = await query<{ n: number }>(
          `select (select count(*) from le_leads where id = any($1::uuid[]))::int
                + (select count(*) from le_events where lead_id = any($1::uuid[]))::int
                + (select count(*) from le_findings where lead_id = any($1::uuid[]))::int
                + (select count(*) from le_raw where lead_id = any($1::uuid[]))::int as n`,
          [[a.id, b.id]],
        );
        check("A: the leads are gone with their events, findings and raw rows", leftovers[0]?.n === 0, leftovers[0]);
        check("A: getLead after a bulk delete is null", (await getLead(a.id)) === null);
      } finally {
        await deleteLeads([a.id, b.id, c.id]).catch(() => undefined);
      }
    }

    // ---- B: PATCH, both ways, and the reason rules
    {
      const d = await make("D", { stage: "researched" });
      try {
        const r1 = await patchLead(d.id, { unqualifiedReason: "Not a fit" });
        check("B: PATCH a reason on an active lead is 400 that says why", r1.status === 400 && /only for an unqualified lead/.test(String(r1.data?.error)), r1.data);
        const r2 = await patchLead(d.id, { stage: "contacted", unqualifiedReason: "Not a fit" });
        check("B: PATCH a reason with another stage is 400", r2.status === 400 && /only for an unqualified lead/.test(String(r2.data?.error)), r2.data);
        check("B: nothing was saved by the refusals", (await rowOf(d.id))?.stage === "researched");

        const r3 = await patchLead(d.id, { stage: "unqualified", unqualifiedReason: "  No need right now  " });
        const l3 = r3.data?.lead as Lead | undefined;
        const row3 = await rowOf(d.id);
        check(
          "B: PATCH stage unqualified with a reason: marked, reason trimmed, stage before kept",
          r3.status === 200 && l3?.stage === "unqualified" && l3.unqualifiedReason === "No need right now" && l3.stageBeforeUnqualified === "researched" && Boolean(row3?.unqualified_at),
          l3 && { stage: l3.stage, reason: l3.unqualifiedReason, before: l3.stageBeforeUnqualified },
        );
        const e3 = await stageEvents(d.id);
        check(
          'B: PATCH logs one event, "Marked unqualified: <reason>" (no "Stage changed" event besides it)',
          e3.length === 1 && e3[0].message === "Marked unqualified: No need right now" && sameList(e3[0].data, { to: "unqualified", from: "researched", reason: "No need right now" }),
          e3,
        );
        check("B: justMarked is true for the lead the PATCH marked (the Pipeline offers Undo for it)", Boolean(l3 && justMarked(l3)), l3 && { at: l3.unqualifiedAt, updated: l3.updatedAt });
        const r4 = await patchLead(d.id, { unqualifiedReason: "Competitor or partner" });
        const row4 = await rowOf(d.id);
        check("B: PATCH a reason on an unqualified lead replaces it; when it was marked is kept", r4.status === 200 && row4?.unqualified_reason === "Competitor or partner" && row4.unqualified_at === row3?.unqualified_at, row4);
        const r4b = await patchLead(d.id, { unqualifiedReason: "‮Wrong\u0085person‬" });
        check(
          "B: PATCH a reason with a right-to-left override and a C1 control character: saved without them",
          r4b.status === 200 && (await rowOf(d.id))?.unqualified_reason === "Wrong person" && (r4b.data?.lead as Lead | undefined)?.unqualifiedReason === "Wrong person",
          r4b.data?.lead && (r4b.data.lead as Lead).unqualifiedReason,
        );
        const r5 = await patchLead(d.id, { unqualifiedReason: "" });
        check('B: PATCH unqualifiedReason "" clears it', r5.status === 200 && (await rowOf(d.id))?.unqualified_reason === null, r5.data);
        const r6 = await patchLead(d.id, { unqualifiedReason: "x".repeat(201) });
        check("B: PATCH a reason over 200 characters is 400", r6.status === 400 && /200 characters/.test(String(r6.data?.error)), r6.data);
        const r7 = await patchLead(d.id, { stage: "unqualified", owner: "Kim" });
        const row7 = await rowOf(d.id);
        check(
          "B: PATCH stage unqualified again (with another field): saved, when and the stage before kept, no new event",
          r7.status === 200 && (r7.data?.lead as Lead | undefined)?.owner === "Kim" && row7?.unqualified_at === row3?.unqualified_at && row7?.stage_before_unqualified === "researched" && (await stageEvents(d.id)).length === 1,
          row7,
        );
        check("B: ... and justMarked is false for it (it was unqualified already: no Undo)", r7.data?.lead !== undefined && !justMarked(r7.data.lead as Lead));
        const r8 = await patchLead(d.id, { stage: "nurture" });
        const row8 = await rowOf(d.id);
        const e8 = await stageEvents(d.id);
        check(
          "B: PATCH another stage on an unqualified lead: that stage, the three fields cleared",
          r8.status === 200 && row8?.stage === "nurture" && row8.unqualified_at === null && row8.unqualified_reason === null && row8.stage_before_unqualified === null,
          row8,
        );
        check('B: ... with one "Stage changed from Unqualified to Nurture" event', e8.length === 2 && e8[0].message === "Stage changed from Unqualified to Nurture" && sameList(e8[0].data, { to: "nurture", from: "unqualified" }), e8[0]);
        const r9 = await patchLead(d.id, { stage: "unqualified" });
        const e9 = await stageEvents(d.id);
        check(
          'B: PATCH stage unqualified without a reason: no reason, stage before nurture, "Marked unqualified" with reason null',
          r9.status === 200 && (await rowOf(d.id))?.stage_before_unqualified === "nurture" && e9[0].message === "Marked unqualified" && (e9[0].data as { reason?: unknown })?.reason === null,
          e9[0],
        );
        const r10 = await patchLead(d.id, { stage: "researched", unqualifiedReason: null });
        check("B: PATCH another stage with unqualifiedReason null is 400 too (the lead would not be unqualified)", r10.status === 400 && (await rowOf(d.id))?.stage === "unqualified", r10.data);
        // Mark as sent on an unqualified lead: it was contacted, so it is back on the lists as contacted.
        const sent = await callRoute(asHandler(sentRoute.POST), { method: "POST", path: `/api/leads/${d.id}/sent`, id: d.id, body: { angleId: "a1", channel: "email" } });
        const rowSent = await rowOf(d.id);
        check(
          "B: POST /sent on an unqualified lead moves it to contacted and clears the three fields",
          sent.status === 200 && rowSent?.stage === "contacted" && rowSent.unqualified_at === null && rowSent.stage_before_unqualified === null,
          rowSent,
        );
      } finally {
        await deleteLeads([d.id]).catch(() => undefined);
      }
    }

    // ---- C: research and an unqualified lead (repo functions only: no run, nothing is spent)
    {
      const e = await make("E");
      try {
        check("C: claimResearch on a new lead moves it to researching", (await claimResearch(e.id)) && (await rowOf(e.id))?.stage === "researching");
        await unqualifyLeads([e.id], "Bad or duplicate data");
        check("C: marked while the run goes: the stage before is researching", (await rowOf(e.id))?.stage_before_unqualified === "researching");
        await setResearchStep(e.id, "Writing the brief");
        await updateLead(e.id, { brief: QUALIFY_BRIEF, angles: [QUALIFY_ANGLE] });
        const mid = await getLead(e.id);
        check("C: the run's own writes still land (step, brief, angles), the lead stays unqualified", mid?.stage === "unqualified" && mid.researchStep === "Writing the brief" && mid.brief?.summary === QUALIFY_BRIEF.summary && mid.angles.length === 1, mid && { stage: mid.stage, step: mid.researchStep });
        await finishResearch(e.id, "done");
        const done = await rowOf(e.id);
        check("C: finishResearch done: still unqualified (reason kept), research done", done?.stage === "unqualified" && done.research_status === "done" && done.research_step === null && done.unqualified_reason === "Bad or duplicate data", done);
        check("C: claimResearch on an unqualified lead (a re-run) keeps it unqualified", (await claimResearch(e.id)) && (await rowOf(e.id))?.stage === "unqualified" && (await rowOf(e.id))?.research_status === "running");
        await finishResearch(e.id, "error", "test failure");
        check("C: finishResearch error: still unqualified", (await rowOf(e.id))?.stage === "unqualified" && (await rowOf(e.id))?.research_status === "error");
        const backdate = () => query("update le_leads set research_started_at = now() - interval '7 minutes' where id = $1", [e.id]);
        await claimResearch(e.id);
        await backdate();
        check("C: failStaleResearch (the reaper): still unqualified, research error", (await failStaleResearch(e.id, STALE_RUN_MS, "test: lost run")) && (await rowOf(e.id))?.stage === "unqualified" && (await rowOf(e.id))?.research_status === "error");
        await claimResearch(e.id);
        await backdate();
        const errorsBefore = (await listEvents(e.id)).filter((ev) => ev.type === "error").length;
        const view = await getList("?view=unqualified");
        const reapedLead = ((view.data?.leads ?? []) as Lead[]).find((l) => l.id === e.id);
        check(
          "C: GET /api/leads?view=unqualified reaps a lost run in that view, and the lead stays unqualified",
          view.status === 200 && reapedLead?.researchStatus === "error" && reapedLead.stage === "unqualified" && (await listEvents(e.id)).filter((ev) => ev.type === "error").length === errorsBefore + 1,
          reapedLead && { status: reapedLead.researchStatus, stage: reapedLead.stage },
        );
        const beforeRestore = await getLead(e.id);
        const [back] = await restoreLeads([e.id]);
        check(
          "C: restored after the run ended in error: researched (marked mid-run, and the brief and angles are there)",
          back?.stage === "researched" && beforeRestore !== null && restoredStage(beforeRestore) === "researched",
          back?.stage,
        );
      } finally {
        await deleteLeads([e.id]).catch(() => undefined);
      }
    }

    // ---- D: the SQL restore mapping agrees with restoredStage on every case
    {
      const leads = await Promise.all(RESTORE_CASES.map((_, i) => make(`R${i + 1}`)));
      const ids = leads.map((l) => l.id);
      try {
        const marked = Date.now() - 3 * 60_000;
        const states = RESTORE_CASES.map((c, i) => {
          const input = restoreInput(c, marked);
          return { id: ids[i], unqualified_at: input.unqualifiedAt, before: input.stageBeforeUnqualified, status: input.researchStatus, started_at: input.researchStartedAt, contacted_at: input.lastContactedAt, brief: input.brief, angles: input.angles };
        });
        // One statement sets every case up, so the leads are unqualified for three queries in all.
        await query(
          `update le_leads l
              set stage = 'unqualified', unqualified_at = v.unqualified_at, stage_before_unqualified = v.before,
                  research_status = v.status, research_started_at = v.started_at, last_contacted_at = v.contacted_at,
                  brief = v.brief, angles = v.angles
             from jsonb_to_recordset($1::jsonb) as v(id uuid, unqualified_at timestamptz, before text, status text, started_at timestamptz, contacted_at timestamptz, brief jsonb, angles jsonb)
            where l.id = v.id`,
          [JSON.stringify(states)],
        );
        const stored = await Promise.all(ids.map((id) => getLead(id)));
        const restored = await restoreLeads(ids);
        const byId = new Map(restored.map((l) => [l.id, l.stage]));
        RESTORE_CASES.forEach((c, i) => {
          const sqlStage = byId.get(ids[i]);
          const tsStage = stored[i] ? restoredStage(stored[i]!) : null;
          check(`D: restore in SQL and restoredStage agree: ${c.label} -> ${c.want}`, sqlStage === c.want && tsStage === c.want, { sql: sqlStage, ts: tsStage });
        });
        const events = await query<{ n: number }>("select count(*)::int as n from le_events where lead_id = any($1::uuid[]) and type = 'stage' and message like 'Restored from unqualified to %'", [ids]);
        check(`D: one restore event per lead (${ids.length})`, events[0]?.n === ids.length, events[0]);
      } finally {
        await deleteLeads(ids).catch(() => undefined);
      }
    }

    // ---- E: a PATCH and a bulk action at the same moment. The bulk unqualify is sent the instant
    // the PATCH's own statement has answered, before the route goes on: the Activity log must still
    // read in the order the changes happened (the PATCH writes its event in that statement).
    {
      const f = await make("F");
      const inner = globalThis.fetch;
      let raced = false;
      try {
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const res = await inner(input, init);
          if (!raced && typeof init?.body === "string" && init.body.includes("with prev as materialized")) {
            raced = true;
            await unqualifyLeads([f.id], "Not a fit");
          }
          return res;
        }) as typeof fetch;
        const r = await patchLead(f.id, { stage: "contacted" });
        globalThis.fetch = inner;
        const row = await rowOf(f.id);
        const events = await stageEvents(f.id); // newest first
        // Replayed oldest first from "new", the events must end on the lead's stage.
        const replayed = [...events].reverse().reduce<string | null>((at, e) => ((e.data as { from?: string })?.from === at ? ((e.data as { to?: string }).to ?? null) : null), "new");
        check(
          "E: PATCH stage and a bulk unqualify racing it: the newest Activity entry is the bulk mark, and the log replays to the lead's stage",
          raced && r.status === 200 && row?.stage === "unqualified" && row.stage_before_unqualified === "contacted" && events.length === 2 && events[0].message === "Marked unqualified: Not a fit" && events[1].message === "Stage changed from New to Contacted" && replayed === "unqualified",
          { raced, stage: row?.stage, events: events.map((e) => e.message), replayed },
        );
      } finally {
        globalThis.fetch = inner;
        await deleteLeads([f.id]).catch(() => undefined);
      }
    }
    check("6: no after() task was recorded (nothing here starts a run)", afterTasks.length === tasksAtStart, afterTasks.length - tasksAtStart);
  } finally {
    const removed = await deleteLeads(made).catch(() => [] as string[]);
    await sweepStale().catch(() => undefined);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    const left = await query<{ n: number }>("select count(*)::int as n from le_leads where id = any($1::uuid[]) or name like $2", [made, `${QUALIFY_PREFIX}%`]);
    check(`6: every "${QUALIFY_PREFIX}" lead is gone (count 0)`, left[0]?.n === 0, left[0]);
    console.log(`  (made ${made.length} temp leads; ${removed.length} were still there to delete at the end)`);
    restoreEnv();
  }
}

// ------------------------------------------------------------------ 7. warm paths (a LOCAL test database, every provider mocked)

const W_HOSTS = { unipile: "api9.unipile.example", x: "api.twitterapi.io", claude: "api.anthropic.com" } as const;
const W_KEYS = { unipile: "test-unipile-key-wpapi", x: "test-twitter-key-wpapi", claude: "test-anthropic-key-wpapi" } as const;
/** Env this section changes; saved first and put back at the end. */
const W_ENV = [
  "UNIPILE_API_KEY",
  "UNIPILE_DSN",
  "UNIPILE_ACCOUNT_ID",
  "UNIPILE_NETWORK_ACCOUNT_ID",
  "TWITTERAPI_IO_KEY",
  "ANTHROPIC_API_KEY",
  "APIFY_TOKEN",
  "WARM_PATH_LINKEDIN_CHECKS_PER_DAY",
  "WARM_PATH_X_USD_PER_DAY",
  "ALLOW_OPEN_ACCESS",
  "VERCEL",
  "APP_PASSWORD",
  "SESSION_SECRET",
] as const;
function setWarmEnv(vars: Partial<Record<(typeof W_ENV)[number], string | undefined>>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

interface WCall {
  host: string;
  path: string;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

/** [id, handle, name, followers, bio] */
type XFixture = [string, string, string, number, string];

const wx = {
  users: {} as Record<string, { id: string; name: string; followers: number; following: number }>,
  followings: {} as Record<string, XFixture[]>,
  followerIds: {} as Record<string, string[]>,
  /** "source>target" pairs (handles, lower case) for follow checks. */
  follows: new Set<string>(),
  fail: {} as Partial<Record<"user-info" | "followings" | "followers-ids" | "follow-check", number>>,
  delayMs: 0,
};
const wu = { accounts: [] as Array<{ id: string; status: string }>, profiles: {} as Record<string, Record<string, unknown>>, profileStatus: 0 };
const wc = { message: "", stop: "end_turn" as "end_turn" | "refusal", delayMs: 0, bodies: [] as Array<Record<string, unknown>> };
const wcalls: WCall[] = [];
const strayHosts: string[] = [];
const wpause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** twitterapi.io, as its docs describe the four endpoints the app uses. */
async function wxRoute(c: WCall): Promise<Response> {
  if (wx.delayMs) await wpause(wx.delayMs);
  const op = c.path.endsWith("/user/info")
    ? "user-info"
    : c.path.endsWith("/user/followings")
      ? "followings"
      : c.path.endsWith("/user/followers_ids")
        ? "followers-ids"
        : c.path.endsWith("/check_follow_relationship")
          ? "follow-check"
          : null;
  if (!op) return reply({ error: 404, message: "no such endpoint" }, 404);
  const failing = wx.fail[op];
  if (failing) return reply({ error: failing, message: "upstream error" }, failing);
  const handle = String(c.query.userName ?? "").toLowerCase();
  if (op === "user-info") {
    const u = wx.users[handle];
    if (!u) return reply({ status: "error", msg: "user not found" });
    return reply({ status: "success", msg: "success", data: { type: "user", userName: handle, id: u.id, name: u.name, followers: u.followers, following: u.following, protected: false, unavailable: false } });
  }
  if (op === "followings") {
    const all = wx.followings[handle] ?? [];
    return reply({
      followings: all.map(([id, screen_name, name, followers_count, description]) => ({ id, screen_name, name, followers_count, description, url: null })),
      has_next_page: false,
      next_cursor: "",
      status: "success",
      msg: "success",
      code: 0,
    });
  }
  if (op === "followers-ids") return reply({ ids: wx.followerIds[handle] ?? [], has_next_page: false, next_cursor: "0", status: "success", msg: "success", code: 0 });
  const source = String(c.query.source_user_name ?? "").toLowerCase();
  const target = String(c.query.target_user_name ?? "").toLowerCase();
  return reply({ status: "success", message: "success", data: { following: wx.follows.has(`${source}>${target}`), followed_by: wx.follows.has(`${target}>${source}`) } });
}

/** Unipile: the accounts list and profile reads on the research account. */
function wuRoute(c: WCall): Response {
  const p = c.path.replace(/^\/api\/v1/, "");
  if (p === "/accounts") {
    return reply({ object: "AccountList", items: wu.accounts.map((a) => ({ object: "Account", type: "LINKEDIN", id: a.id, name: "Someone", sources: [{ id: `${a.id}_MESSAGING`, status: a.status }] })) });
  }
  if (p.startsWith("/users/") && c.query.account_id === "acc_research") {
    if (wu.profileStatus) return reply({ title: "Unipile error", type: "errors/error" }, wu.profileStatus);
    const raw = wu.profiles[decodeURIComponent(p.slice("/users/".length)).toLowerCase()];
    return raw ? reply(raw) : reply({ title: "Not found", type: "errors/resource_not_found" }, 404);
  }
  return reply({ title: "not mocked" }, 404);
}

/** The Claude Messages API: one structured answer { message }, or a refusal. */
async function wcRoute(c: WCall): Promise<Response> {
  wc.bodies.push((c.body ?? {}) as Record<string, unknown>);
  if (wc.delayMs) await wpause(wc.delayMs);
  const refusal = wc.stop === "refusal";
  return reply({
    id: "msg_test_wpapi",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: refusal ? [] : [{ type: "text", text: JSON.stringify({ message: wc.message }) }],
    stop_reason: wc.stop,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: refusal ? 4 : 120 },
  });
}

/** The api-client's relative fetches ("/api/..."), answered by the route handlers in this process. */
const dec = decodeURIComponent;
const BRIDGE: Array<{ re: RegExp; mod: Record<string, unknown>; params: (m: RegExpMatchArray) => Record<string, string> }> = [
  { re: /^\/api\/network$/, mod: networkRoute, params: () => ({}) },
  { re: /^\/api\/network\/linkedin\/connections$/, mod: connectionsRoute, params: () => ({}) },
  { re: /^\/api\/network\/linkedin\/self$/, mod: selfRoute, params: () => ({}) },
  { re: /^\/api\/network\/x\/sync$/, mod: xSyncRoute, params: () => ({}) },
  { re: /^\/api\/leads\/([^/]+)\/paths\/([^/]+)\/intro$/, mod: introRoute, params: (m) => ({ id: dec(m[1]), pathId: dec(m[2]) }) },
  { re: /^\/api\/leads\/([^/]+)\/paths\/([^/]+)$/, mod: pathRoute, params: (m) => ({ id: dec(m[1]), pathId: dec(m[2]) }) },
  { re: /^\/api\/leads\/([^/]+)\/paths$/, mod: pathsRoute, params: (m) => ({ id: dec(m[1]) }) },
  { re: /^\/api\/leads\/([^/]+)$/, mod: leadRoute, params: (m) => ({ id: dec(m[1]) }) },
  { re: /^\/api\/status$/, mod: statusRoute, params: () => ({}) },
];
/** Bodies the client sent through the bridge, by path (to check the parts of an upload). */
const bridged: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];

async function bridge(href: string, init?: RequestInit): Promise<Response> {
  const url = new URL(href, "http://localhost:3000");
  const method = init?.method ?? "GET";
  for (const r of BRIDGE) {
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const handler = r.mod[method];
    if (typeof handler !== "function") return reply({ error: "Method not allowed." }, 405);
    const body = typeof init?.body === "string" ? init.body : undefined;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    bridged.push({ method, path: url.pathname, body: parsed });
    const request = new NextRequest(url, { method, headers: new Headers(init?.headers), body: method === "GET" ? undefined : body });
    const ctx = { params: Promise.resolve(r.params(m)) };
    return inRequestScope(url.pathname, () => (handler as (req: NextRequest, c: typeof ctx) => Promise<Response>)(request, ctx));
  }
  return reply({ error: "Not found." }, 404);
}

/** Every outside call is answered here; the database stand-in passes through, anything else is refused and noted. */
function installWarmMock(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith("/")) return bridge(href, init);
    const url = new URL(href);
    if (url.hostname.endsWith(".fake-neon.test") || url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(input, init);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    const c: WCall = { host: url.hostname, path: url.pathname, method: init?.method ?? "GET", query: Object.fromEntries(url.searchParams), headers, body };
    wcalls.push(c);
    if (c.host === W_HOSTS.x) return wxRoute(c);
    if (c.host === W_HOSTS.unipile) return wuRoute(c);
    if (c.host === W_HOSTS.claude) return wcRoute(c);
    strayHosts.push(c.host);
    return reply({ error: `unexpected host ${c.host}` }, 599);
  }) as typeof fetch;
}

/** Server log lines written while section 7 runs: route calls (console.log too) and everything on error/warn/info. */
const serverLines: string[] = [];
function captureServerLogs(): () => void {
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const record = (args: unknown[]) => void serverLines.push(args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" "));
  console.warn = (...a: unknown[]) => record(a);
  console.error = (...a: unknown[]) => record(a);
  console.info = (...a: unknown[]) => record(a);
  console.log = (...a: unknown[]) => (routeDepth > 0 ? record(a) : saved.log(...a));
  return () => Object.assign(console, saved);
}

async function testWarmPaths(): Promise<void> {
  section("7. warm paths (local database; LinkedIn, X, Unipile and Claude mocked)");
  if (!/\.fake-neon\.test\b/.test(process.env.DATABASE_URL ?? "")) {
    // These checks write global tables (le_settings, le_network_*): never against a shared database.
    check("7: warm-path route tests need a LOCAL test database (run through the local runner)", false);
    return;
  }

  const W = randomBytes(3).toString("hex");
  const ADA_SLUG = `ada-kim-wp-${W}`;
  const SAM_SLUG = `sam-okafor-wp-${W}`;
  const SAM_URL = `https://www.linkedin.com/in/${SAM_SLUG}`;
  const X_OWNER = `sam_wp_${W}`;
  const X_LEAD = `ada_wp_${W}`;
  const PRIYA = `priya-wp-${W}`;
  const LEAD_MEMBER = "ACoAAAwpApiLead0001";
  const QUILLS = Array.from({ length: 30 }, (_, i) => ({ slug: `quill-${i}-wp-${W}`, name: `Quill Varga${String(i).padStart(2, "0")}` }));
  const CONTACT_NAMES = ["Priya Shah", "Omar Haddad", "Lena Berg", "Tomas Ruiz", "Zed Mora", ...QUILLS.map((q) => q.name)];
  const CONNECTIONS: Array<[string, string, string, string, string, string | null]> = [
    [PRIYA, "Priya", "Shah", "Nimbus Robotics", "Head of Operations", "2021-11-02"],
    [`omar-wp-${W}`, "Omar", "Haddad", "Acme Robotics", "Staff Engineer", "2020-02-14"],
    [`lena-wp-${W}`, "Lena", "Berg", "Acme Robotics Inc.", "Designer", "2024-01-10"],
    [`tomas-wp-${W}`, "Tomas", "Ruiz", "Northwind Labs", "CTO", "2018-06-01"],
    [ADA_SLUG, "Ada", "Kim", "Acme Robotics", "CTO", "2021-03-14"],
    ...QUILLS.map((q): [string, string, string, string, string, string | null] => [q.slug, "Quill", q.name.split(" ")[1], "Acme Robotics", "Engineer", "2019-01-01"]),
  ];
  const withoutOmar = CONNECTIONS.filter((r) => r[1] !== "Omar");

  const savedEnv = Object.fromEntries(W_ENV.map((k) => [k, process.env[k]]));
  const settingsRow = await query<{ value: unknown }>("select value from le_settings where key = 'app'");
  const made: string[] = [];
  /** Every reply in this section, with the route it came from. */
  const responses: Array<{ path: string; text: string }> = [];
  const restoreConsole = captureServerLogs();
  installWarmMock();
  // The live deploy runs open (ALLOW_OPEN_ACCESS=1, no APP_PASSWORD): every route here must work so.
  setWarmEnv({
    UNIPILE_API_KEY: W_KEYS.unipile,
    UNIPILE_DSN: `https://${W_HOSTS.unipile}:14914`,
    UNIPILE_ACCOUNT_ID: "acc_research",
    UNIPILE_NETWORK_ACCOUNT_ID: undefined,
    TWITTERAPI_IO_KEY: undefined,
    ANTHROPIC_API_KEY: W_KEYS.claude,
    APIFY_TOKEN: undefined,
    WARM_PATH_LINKEDIN_CHECKS_PER_DAY: undefined,
    WARM_PATH_X_USD_PER_DAY: undefined,
    ALLOW_OPEN_ACCESS: "1",
    VERCEL: "1",
    APP_PASSWORD: undefined,
    SESSION_SECRET: undefined,
  });
  resetUnipileState();
  wu.accounts = [{ id: "acc_research", status: "OK" }];
  wu.profiles = {
    [ADA_SLUG]: {
      object: "UserProfile",
      provider: "LINKEDIN",
      provider_id: LEAD_MEMBER,
      public_identifier: ADA_SLUG,
      first_name: "Ada",
      last_name: "Kim",
      headline: "CTO at Acme Robotics",
      websites: [],
      network_distance: "OUT_OF_NETWORK",
      work_experience: [
        { position: "CTO", company: "Acme Robotics", company_id: "4242", start: "8/1/2022", end: null },
        { position: "Engineer", company: "Northwind Labs", company_id: "777", start: "1/1/2017", end: "5/1/2022" },
      ],
      education: [{ school: "KTH Royal Institute of Technology", school_id: "9001", start: "1/1/2013", end: "1/1/2017" }],
    },
    [SAM_SLUG]: {
      object: "UserProfile",
      provider: "LINKEDIN",
      provider_id: "ACoAAAwpApiSam00001",
      public_identifier: SAM_SLUG,
      first_name: "Sam",
      last_name: "Okafor",
      headline: "COO at Nimbus Robotics",
      websites: [],
      work_experience: [
        { position: "COO", company: "Nimbus Robotics", company_id: "5150", start: "2/1/2023", end: null },
        { position: "PM", company: "Northwind Labs", company_id: "777", start: "3/1/2018", end: "6/1/2022" },
      ],
      education: [{ school: "KTH Royal Institute of Technology", school_id: "9001", start: "1/1/2012", end: "1/1/2016" }],
    },
  };
  wu.profileStatus = 0;
  wx.users = {
    [X_OWNER]: { id: "500", name: "Sam Okafor", followers: 2, following: 2 },
    [X_LEAD]: { id: "800", name: "Ada Kim", followers: 150, following: 3 },
  };
  wx.followings = {
    [X_OWNER]: [
      ["1001", `priya_x_${W}`, "Priya Shah", 900, "Ops lead at Nimbus Robotics"],
      ["1002", `zed_x_${W}`, "Zed Mora", 400, "robots"],
    ],
    [X_LEAD]: [
      ["1001", `priya_x_${W}`, "Priya Shah", 900, "Ops lead at Nimbus Robotics"],
      ["1002", `zed_x_${W}`, "Zed Mora", 400, "robots"],
      ["500", X_OWNER, "Sam Okafor", 2, ""],
    ],
  };
  wx.followerIds = { [X_OWNER]: ["1001", "1002"], [X_LEAD]: ["1001"] };
  // Priya follows the lead back; Zed does not (the lead has few followers, so follow checks are cheaper than its follower ids).
  wx.follows = new Set([`priya_x_${W}>${X_LEAD}`]);
  wx.fail = {};
  wc.message = "Hi Priya,\n\nWould you introduce me to Ada Kim at Acme Robotics?\n\nNo worries if it's not a fit.\n\nSam Okafor";
  wc.stop = "end_turn";

  const call = (handler: unknown, opts: Parameters<typeof callRoute>[1]) =>
    callRoute(asHandler(handler), opts).then((r) => {
      responses.push({ path: opts.path, text: JSON.stringify(r.data ?? null) });
      return r;
    });
  const pathsOf = (r: CallResult) => (r.data?.paths ?? null) as WarmPaths | null;
  const named = (text: string) => CONTACT_NAMES.filter((n) => text.includes(n));
  const quillsIn = (text: string) => QUILLS.filter((q) => text.includes(q.name)).length;

  try {
    // ---------------------------------------------- 7a. the proxy covers the new routes like every other write
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config: proxyConfig, url });
    const leadPath = "/api/leads/3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f";
    const SAMPLE_LI = "li-0a1b2c3d4e5f";
    const SAMPLE_X = "x-9f8e7d6c5b4a";
    const newRoutes = ["/api/network", "/api/network/linkedin/connections", "/api/network/linkedin/self", "/api/network/x/sync", `${leadPath}/paths`, `${leadPath}/paths/${SAMPLE_LI}`, `${leadPath}/paths/${SAMPLE_LI}/intro`, `${leadPath}/paths/${SAMPLE_X}`];
    check("7a: the proxy runs on every new route", newRoutes.every(matches), newRoutes.filter((u) => !matches(u)));
    check(
      "7a: path ids are opaque (the network and 12 hex characters): a slug, a name or a handle is refused, and so is anything that could end like a static file (the proxy skips those)",
      !matches(`${leadPath}/paths/li%3Aada.png`) &&
        isPathId("direct") &&
        isPathId(SAMPLE_LI) &&
        isPathId(SAMPLE_X) &&
        !isPathId("li:ada-kim") &&
        !isPathId("x:1001") &&
        !isPathId("li-ada-kim") &&
        !isPathId("li:ada.png") &&
        !isPathId(`${SAMPLE_LI}.png`) &&
        !isPathId("li-0A1B2C3D4E5F") &&
        !isPathId("li-0a1b2c3d4e5") &&
        !isPathId("foo") &&
        !isPathId("li-"),
    );
    const viaProxy = (method: string, path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(new URL(path, "http://localhost:3000"), { method, headers }));
    const writes: Array<[string, string]> = [
      ["PUT", "/api/network/linkedin/connections"],
      ["DELETE", "/api/network/linkedin/connections"],
      ["POST", "/api/network/linkedin/self"],
      ["POST", "/api/network/x/sync"],
      ["POST", `${leadPath}/paths`],
      ["PATCH", `${leadPath}/paths`],
      ["POST", `${leadPath}/paths/${SAMPLE_LI}/intro`],
      ["PATCH", `${leadPath}/paths/${SAMPLE_LI}`],
      ["PUT", "/api/settings"],
    ];
    const notRefused: string[] = [];
    for (const [method, path] of writes) if ((await viaProxy(method, path, { "sec-fetch-site": "cross-site" })).status !== 403) notRefused.push(`${method} ${path}`);
    check("7a: a cross-site write to any new route is 403 (proxy rule 1)", notRefused.length === 0, notRefused);
    const open: string[] = [];
    for (const [method, path] of [...writes, ["GET", "/api/network"]] as Array<[string, string]>) {
      if ((await viaProxy(method, path, { "sec-fetch-site": "same-origin" })).headers.get("x-middleware-next") !== "1") open.push(`${method} ${path}`);
    }
    check("7a: on the open deploy (VERCEL=1, ALLOW_OPEN_ACCESS=1, no APP_PASSWORD) every new route passes the proxy", open.length === 0, open);
    setWarmEnv({ APP_PASSWORD: PASSWORD, SESSION_SECRET: SECRET });
    const gated = [(await viaProxy("GET", "/api/network")).status, (await viaProxy("POST", `${leadPath}/paths`, { "sec-fetch-site": "same-origin" })).status];
    check("7a: with the team password set, the new routes need a session (401)", gated.every((s) => s === 401), gated);
    setWarmEnv({ APP_PASSWORD: undefined, SESSION_SECRET: undefined });

    // ---------------------------------------------- fixtures: a researched lead, and one with nothing to check
    const ada = await createLead({ linkedinUrl: `https://www.linkedin.com/in/${ADA_SLUG}`, name: "Ada Kim", companyName: "Acme Robotics" });
    made.push(ada.id);
    const A = ada.id;
    const angle: Angle = {
      id: "no-cold-starts",
      name: "No cold starts",
      reasoning: "They serve pi0.5 on shared GPUs and fight cold starts before demos.",
      findingIds: [],
      email: { subject: "Cold starts", body: "Hi Ada" },
      linkedinMessage: "Hi Ada",
    };
    const brief: Brief = { summary: "Ada runs robot learning at Acme Robotics and is moving pi0.5 policies into pilots.", bullets: [], pains: [], objections: [], questions: [] };
    await updateLead(A, {
      title: "CTO",
      brief,
      angles: [angle],
      approach: { leadAngleId: angle.id, channel: "email", why: "Cold starts", firstCallQuestions: [], dealBreakers: [] },
      researchStatus: "done",
      researchFinishedAt: new Date().toISOString(),
    });
    await insertFindings(A, [
      { source: "exa", kind: "news", title: "Pilot with a carmaker", text: "FINDING-ONE Acme started a pilot with a carmaker in October.", relevance: 0.9, publishedAt: "2026-10" },
      { source: "exa", kind: "hiring", title: "Hiring ML infra", text: "FINDING-TWO Acme is hiring two ML infrastructure engineers.", relevance: 0.8 },
      { source: "exa", kind: "model", title: "Runs pi0.5", text: "FINDING-THREE Acme fine-tunes pi0.5 for bin picking.", relevance: 0.7 },
      { source: "exa", kind: "talk", title: "A talk", text: "FINDING-FOUR Ada spoke at a robotics meetup.", relevance: 0.6 },
      { source: "exa", kind: "personal", title: "Family", text: "FINDING-FILTERED a personal fact the criteria leave out.", relevance: 0.95, passesCriteria: false, excludedReason: "personal" },
    ]);
    const bare = await createLead({ linkedinUrl: `https://www.linkedin.com/in/bare-wp-${W}`, name: "Bare Lead" });
    made.push(bare.id);
    // A lead never researched, who is one of your connections (the upload gives it a chip).
    const tomas = await createLead({ linkedinUrl: `https://www.linkedin.com/in/tomas-wp-${W}`, name: "Tomas Ruiz" });
    made.push(tomas.id);
    await setLeadLinkedin(bare.id, null);
    await updateLead(bare.id, { researchStatus: "done", researchFinishedAt: new Date().toISOString() });
    await saveSettings({ senderName: "Sam Okafor", xHandle: "", instagramHandle: "", linkedinUrl: "" });

    const getDetail = (id = A) => call(leadRoute.GET, { path: `/api/leads/${id}`, id });
    const postPaths = (id = A) => call(pathsRoute.POST, { method: "POST", path: `/api/leads/${id}/paths`, id });
    const patchInstagram = (body: unknown, id = A, extra: { rawBody?: string; headers?: Record<string, string> } = {}) =>
      call(pathsRoute.PATCH, { method: "PATCH", path: `/api/leads/${id}/paths`, id, body, ...extra });
    const postIntro = (pathId: string, id = A) => call(introRoute.POST, { method: "POST", path: `/api/leads/${id}/paths/${encodeURIComponent(pathId)}/intro`, params: { id, pathId } });
    const patchPath = (pathId: string, body: unknown, extra: { rawBody?: string; headers?: Record<string, string> } = {}) =>
      call(pathRoute.PATCH, { method: "PATCH", path: `/api/leads/${A}/paths/${encodeURIComponent(pathId)}`, params: { id: A, pathId }, body, ...extra });
    const getNet = () => call(networkRoute.GET, { path: "/api/network" });
    const putPart = (body: unknown, extra: { rawBody?: string; headers?: Record<string, string> } = {}) =>
      call(connectionsRoute.PUT, { method: "PUT", path: "/api/network/linkedin/connections", body, ...extra });
    const putSettings = (body: unknown) => call(settingsRoute.PUT, { method: "PUT", path: "/api/settings", body });
    const postSelf = () => call(selfRoute.POST, { method: "POST", path: "/api/network/linkedin/self" });
    const postSync = () => call(xSyncRoute.POST, { method: "POST", path: "/api/network/x/sync" });
    const patchLead = (body: unknown) => call(leadRoute.PATCH, { method: "PATCH", path: `/api/leads/${A}`, id: A, body });
    const uploadAll = async (rows: typeof CONNECTIONS) => putPart({ importId: randomUUID(), part: 1, parts: 1, rows, exportedAt: "2026-11-02T09:00:00.000Z" });
    const computedAt = async () => (await getWarmPathRow(A))?.computedAt ?? null;
    const outside = () => wcalls.length;

    // ---------------------------------------------- 7b. nothing set up yet
    const net0 = await getNet();
    const n0 = net0.data as Record<string, Record<string, unknown>> | null;
    check(
      "7b: GET /api/network before any setup: no connections, no profile, account not set up, X off",
      net0.status === 200 && n0?.linkedin?.connections === null && n0?.linkedin?.self === null && (n0?.linkedin?.account as Record<string, unknown>)?.state === "not_set_up" && n0?.x?.configured === false && n0?.x?.handle === null && n0?.instagram?.handle === null,
      n0,
    );
    const st0 = await call(statusRoute.GET, { path: "/api/status" });
    check(
      "7b: GET /api/status: the twitterapi.io row (off) and your LinkedIn account not set up, with no call made",
      ((st0.data?.providers ?? []) as Array<{ id: string; configured: boolean }>).some((p) => p.id === "twitterapi" && !p.configured) &&
        (st0.data?.linkedinAccount as { state?: string } | undefined)?.state === "not_set_up" &&
        outside() === 0,
      st0.data?.linkedinAccount,
    );
    const d0 = await getDetail();
    const p0 = pathsOf(d0);
    check(
      "7b: GET /api/leads/[id] carries paths: idle, nothing set up, and the check-yourself LinkedIn link",
      d0.status === 200 && p0?.status === "idle" && p0.setup.any === false && p0.links.linkedinMutuals === `https://www.linkedin.com/in/${ADA_SLUG}/` && p0.paths.length === 0 && p0.leadFirstName === "Ada",
      p0,
    );
    const notSetUp = await postPaths();
    check("7b: POST /paths with nothing set up is 400 not_set_up, with the paths", notSetUp.status === 400 && notSetUp.data?.code === "not_set_up" && pathsOf(notSetUp) !== null, notSetUp.data);
    check(
      "7b: ... and with X off on this server it does not ask for an X handle",
      String(notSetUp.data?.error) === "Nothing is set up yet. Upload your LinkedIn connections or add your profile link in Settings." && pathsOf(notSetUp)?.setup.xAvailable === false,
      notSetUp.data?.error,
    );
    check("7b: ... and the lead's side is kept for later (a row with its target)", (await getWarmPathRow(A))?.target?.linkedinSlug === ADA_SLUG);
    const nothing = await postPaths(bare.id);
    check("7b: POST /paths for a lead with no LinkedIn and no X handle is 400 nothing_to_check", nothing.status === 400 && nothing.data?.code === "nothing_to_check", nothing.data);
    check("7b: POST /paths with a malformed id is 404", (await postPaths("nope")).status === 404);
    const ghost = "00000000-0000-4000-8000-00000000beef";
    check("7b: POST /paths for an unknown lead is 404", (await postPaths(ghost)).status === 404);
    // Checks from the lead page are counted across the app: a loop cannot test profiles against your network.
    await query("insert into le_quota_uses (kind, units) select 'warm_path_check', 1 from generate_series(1, 100)");
    const checkCapped = await postPaths();
    check(
      "7b: POST /paths past 100 checks a day is 429 warm_path_check_limit",
      checkCapped.status === 429 && checkCapped.data?.code === "warm_path_check_limit" && /100 warm-path checks a day/.test(String(checkCapped.data?.error)),
      checkCapped.data,
    );
    await query("delete from le_quota_uses where kind = 'warm_path_check'");
    const notCounted = await query<{ n: number }>("select count(*)::int as n from le_quota_uses where kind = 'warm_path_check'");
    await postPaths();
    const afterNotSetUp = await query<{ n: number }>("select count(*)::int as n from le_quota_uses where kind = 'warm_path_check'");
    check("7b: a check that compared nothing (not set up) does not count", afterNotSetUp[0]?.n === notCounted[0]?.n, afterNotSetUp);
    const notConfigured = await postSync();
    check("7b: POST /api/network/x/sync without TWITTERAPI_IO_KEY is 400 not_configured", notConfigured.status === 400 && notConfigured.data?.code === "not_configured", notConfigured.data);
    const noUrl = await postSelf();
    check("7b: POST /api/network/linkedin/self without your LinkedIn URL is 400 no_url", noUrl.status === 400 && noUrl.data?.code === "no_url", noUrl.data);
    check("7b: nothing reached an outside service so far", outside() === 0, wcalls.map((c) => c.host));

    // ---------------------------------------------- 7c. Settings: your handles and profile URL
    for (const [label, body, field] of [
      ["an X handle with a space", { xHandle: "not a handle" }, "xHandle"],
      ["an X handle of 16 characters", { xHandle: "x".repeat(16) }, "xHandle"],
      ['the Instagram page "explore"', { instagramHandle: "explore" }, "instagramHandle"],
      ["an Instagram post link", { instagramHandle: "https://www.instagram.com/p/Cabc123/" }, "instagramHandle"],
      ["an Instagram handle with two dots", { instagramHandle: "ada..kim" }, "instagramHandle"],
      ["a LinkedIn company page", { linkedinUrl: "https://www.linkedin.com/company/acme" }, "linkedinUrl"],
      ["another site", { linkedinUrl: "https://example.com/in/sam" }, "linkedinUrl"],
      ["an X handle that is not text", { xHandle: 42 }, null],
    ] as const) {
      const r = await putSettings(body);
      check(`7c: PUT /api/settings with ${label} is 400${field ? ` (field ${field})` : ""}`, r.status === 400 && typeof r.data?.error === "string" && (field === null || r.data?.field === field), r.data);
    }
    const saved = await putSettings({ xHandle: `@${X_OWNER}`, instagramHandle: "https://www.instagram.com/Sam.WP/?hl=en", linkedinUrl: `linkedin.com/in/${SAM_SLUG.toUpperCase()}/?trk=x` });
    const s1 = saved.data?.settings as Record<string, unknown> | undefined;
    check(
      "7c: PUT /api/settings saves the three cleaned: X handle without @, Instagram from a link (lower case), LinkedIn URL normalised",
      saved.status === 200 && s1?.xHandle === X_OWNER && s1?.instagramHandle === "sam.wp" && s1?.linkedinUrl === SAM_URL && s1?.senderName === "Sam Okafor",
      s1,
    );
    const net1 = (await getNet()).data as Record<string, Record<string, unknown>> | null;
    check(
      "7c: GET /api/network shows your handles and profile URL (not read yet)",
      net1?.x?.handle === X_OWNER && net1?.instagram?.handle === "sam.wp" && (net1?.linkedin?.self as Record<string, unknown>)?.url === SAM_URL && (net1?.linkedin?.self as Record<string, unknown>)?.readAt === null,
      net1,
    );

    // ---------------------------------------------- 7d. PUT /api/network/linkedin/connections
    const id1 = randomUUID();
    const plain = await putPart(undefined, { rawBody: JSON.stringify({ importId: id1, part: 1, parts: 1, rows: [] }), headers: { "content-type": "text/plain" } });
    check("7d: a part sent as text/plain is 415", plain.status === 415, plain.data);
    const big = await putPart(undefined, { rawBody: JSON.stringify({ importId: id1, part: 1, parts: 1, rows: [], pad: "x".repeat(4 * 1024 * 1024 + 10) }) });
    check("7d: a part over 4 MB is 413", big.status === 413 && /4 MB/.test(String(big.data?.error)), big.data);
    const good = CONNECTIONS.slice(0, 2);
    for (const [label, body, pattern] of [
      ["a bad importId", { importId: "not-a-uuid", part: 1, parts: 1, rows: good }, /importId/],
      ["part 0", { importId: id1, part: 0, parts: 1, rows: good }, /part/],
      ["7 parts", { importId: id1, part: 1, parts: 7, rows: good }, /parts/],
      ["part 3 of 2", { importId: id1, part: 3, parts: 2, rows: good }, /part/],
      ["rows that are not a list", { importId: id1, part: 1, parts: 1, rows: "Priya Shah" }, /rows/],
      ["5,001 rows", { importId: id1, part: 1, parts: 1, rows: Array.from({ length: 5001 }, (_, i) => [`x-${i}`, "A", "B", "", "", null]) }, /5,000/],
      ["a row that is not a profile slug", { importId: id1, part: 1, parts: 1, rows: [good[0], ["Priya Shah", "Priya", "Shah", "", "", null]] }, /^Row 2: not a LinkedIn profile slug\.$/],
      ["a row with 7 fields", { importId: id1, part: 1, parts: 1, rows: [[...good[0], "extra"]] }, /^Row 1: expected/],
      ["a bad Connected On date", { importId: id1, part: 1, parts: 1, rows: [[good[0][0], "Priya", "Shah", "", "", "2026-13-45"]] }, /^Row 1: connectedOn/],
      ["a company over 200 characters", { importId: id1, part: 1, parts: 1, rows: [[good[0][0], "Priya", "Shah", "c".repeat(201), "", null]] }, /^Row 1: a field/],
    ] as const) {
      const r = await putPart(body);
      const error = String(r.data?.error ?? "");
      check(`7d: a part with ${label} is 400, and the message names no one`, r.status === 400 && (pattern as RegExp).test(error) && named(error).length === 0, r.data);
    }
    check("7d: the refused parts stored nothing", (await query<{ n: number }>("select count(*)::int as n from le_network_contacts where network = 'linkedin'"))[0]?.n === 0);

    const upload = randomUUID();
    const tasks0 = afterTasks.length;
    const part1 = await putPart({ importId: upload, part: 1, parts: 2, rows: CONNECTIONS.slice(0, 20), exportedAt: "2026-11-02T09:00:00.000Z" });
    check("7d: part 1 of 2: { received, total, done: false }", part1.status === 200 && part1.data?.received === 20 && part1.data?.total === 20 && part1.data?.done === false, part1.data);
    const stale = await putPart({ importId: randomUUID(), part: 2, parts: 2, rows: CONNECTIONS.slice(20) });
    check("7d: a later part of an upload that is not the one in progress is 409 replaced", stale.status === 409 && stale.data?.code === "replaced", stale.data);
    const part2 = await putPart({ importId: upload, part: 2, parts: 2, rows: CONNECTIONS.slice(20), exportedAt: "2026-11-02T09:00:00.000Z" });
    check(
      "7d: the last part: done, every row stored, the Connected chip set on the lead, the free recompute handed to after()",
      part2.status === 200 && part2.data?.done === true && part2.data?.total === CONNECTIONS.length && Number(part2.data?.connectedLeads) >= 1 && afterTasks.length === tasks0 + 1,
      part2.data,
    );
    const listed = (await call(leadsRoute.GET, { path: "/api/leads" })).data?.leads as Lead[] | undefined;
    const chip = listed?.find((l) => l.id === A)?.warmPath;
    check("7d: GET /api/leads: the lead carries warmPath, connected, labelled with the tie", chip?.connected === true && chip.hops === 1 && chip.label === "LinkedIn 1st degree since 2021", chip);
    const tomasChip = listed?.find((l) => l.id === tomas.id)?.warmPath;
    const beforeTomas = outside();
    const tomasDetail = await getDetail(tomas.id);
    const tp = pathsOf(tomasDetail);
    check(
      "7d: a lead never researched with a Connected chip: GET /api/leads/[id] computes its free part, so the page shows the direct box too (no outside call)",
      tomasChip?.connected === true &&
        (tomasDetail.data?.lead as Lead | undefined)?.researchFinishedAt === null &&
        Boolean(tp?.checkedAt) &&
        tp?.paths[0]?.id === "direct" &&
        tp.paths[0].links[0].evidence.some((e) => e.kind === "linkedin_1st") &&
        (tomasDetail.data?.lead as Lead | undefined)?.warmPath?.connected === true &&
        outside() === beforeTomas,
      tp && { checkedAt: tp.checkedAt, ids: tp.paths.map((p) => p.id) },
    );
    const net2 = await getNet();
    const conn2 = (net2.data?.linkedin as Record<string, unknown> | undefined)?.connections as Record<string, unknown> | undefined;
    check(
      "7d: GET /api/network: the count and the export date, and not one contact's name",
      conn2?.count === CONNECTIONS.length && conn2?.exportedAt === "2026-11-02T09:00:00.000Z" && named(JSON.stringify(net2.data)).length === 0,
      conn2,
    );

    // ---------------------------------------------- 7e. POST /paths: the free part (your connections and profile)
    const before5 = outside();
    const found = await postPaths();
    const fp = pathsOf(found);
    const direct = fp?.paths[0];
    check("7e: POST /paths is 200 { paths, message, outcome: found }", found.status === 200 && found.data?.outcome === "found" && typeof found.data?.message === "string", found.data && { status: found.status, outcome: found.data.outcome, message: found.data.message });
    check(
      "7e: the direct path first: Strong, LinkedIn 1st degree, worked together at Northwind Labs, same school",
      direct?.id === "direct" && direct.strength === "strong" && ["linkedin_1st", "worked_together", "same_school"].every((k) => direct.links[0].evidence.some((e) => e.kind === k)),
      direct,
    );
    const uniReads = wcalls.slice(before5).filter((c) => c.host === W_HOSTS.unipile && c.path.startsWith("/api/v1/users/"));
    check(
      "7e: the lead's profile and yours were read once each, on the research account, with notify=false",
      uniReads.length === 2 && uniReads.every((c) => c.query.account_id === "acc_research" && c.query.notify === "false" && c.headers["x-api-key"] === W_KEYS.unipile && !c.path.includes(W_KEYS.unipile)),
      uniReads.map((c) => ({ p: c.path, a: c.query.account_id })),
    );
    check(
      "7e: at most 10 paths and 5 company people; of 32 people at Acme Robotics, at most 5 reach the reply",
      Boolean(fp) && fp!.paths.length <= 10 && fp!.companyPaths.length === 5 && quillsIn(JSON.stringify(found.data)) <= 5 && !JSON.stringify(found.data).includes("Tomas Ruiz"),
      fp && { paths: fp.paths.length, company: fp.companyPaths.length, quills: quillsIn(JSON.stringify(found.data)) },
    );
    const events5 = await listEvents(A);
    const toolEvent = events5.find((e) => e.type === "tool" && e.message.startsWith("Warm paths:"));
    check("7e: one 'tool' event with the outcome (Activity)", toolEvent?.message === found.data?.message && (toolEvent?.data as { trigger?: string })?.trigger === "button", toolEvent);
    const d5 = pathsOf(await getDetail());
    check("7e: GET /api/leads/[id]: paths done, checked now, the direct path first", d5?.status === "done" && Boolean(d5.checkedAt) && d5.paths[0]?.id === "direct" && d5.setup.linkedinConnections && d5.setup.linkedinProfile, d5 && { status: d5.status, setup: d5.setup });
    // A lead you are not connected to, in the launch setup (no X check, no check on your own LinkedIn
    // account): nothing says that nobody links you, since mutual connections were not checked.
    const cy = await createLead({ linkedinUrl: `https://www.linkedin.com/in/cy-wp-${W}`, name: "Cy Lund" });
    made.push(cy.id);
    await updateLead(cy.id, { researchStatus: "done", researchFinishedAt: new Date().toISOString() });
    const cyCheck = await postPaths(cy.id);
    const cyPaths = pathsOf(cyCheck);
    const cyEvent = (await listEvents(cy.id)).find((e) => e.type === "tool")?.message ?? "";
    check(
      "7e: not connected, no source of mutual connections: the message and the Activity line say 'no direct link ... mutual connections not checked', never 'none found'",
      cyCheck.status === 200 &&
        cyCheck.data?.outcome === "none" &&
        /^Warm paths: no direct link \(checked \d+ LinkedIn connections; mutual connections not checked\)$/.test(String(cyCheck.data?.message)) &&
        cyEvent === cyCheck.data?.message,
      { message: cyCheck.data?.message, event: cyEvent },
    );
    const cyWords = cyPaths ? noPathsCopy(cyPaths) : null;
    check(
      "7e: ... and the panel's words, from that reply: no direct link, what was compared, and that mutual connections are not checked here",
      cyWords?.title === "No direct link to Cy yet." &&
        /^Cy is not one of your \d+ LinkedIn connections\. Re-run research to compare employers and schools\.$/.test(cyWords.detail) &&
        cyWords.mutuals === "Mutual connections are not checked here." &&
        cyWords.setUp === "To check them here, set up X or your LinkedIn account in Settings.",
      cyWords,
    );

    // ---------------------------------------------- 7f. the free recompute on GET
    const c0 = await computedAt();
    await getDetail();
    check("7f: nothing changed: GET does not recompute (computed_at stays)", (await computedAt()) === c0);
    const before6 = outside();
    const reup = await uploadAll(withoutOmar);
    const afterUpload = await getDetail();
    const c1 = await computedAt();
    check(
      "7f: a new upload without Omar: the next GET recomputes for free, with no outside call, and Omar is gone",
      reup.data?.done === true && c1 !== c0 && outside() === before6 && !JSON.stringify(afterUpload.data).includes("Omar Haddad") && (pathsOf(afterUpload)?.companyPaths.length ?? 0) === 5,
      { c0, c1, calls: outside() - before6 },
    );
    await getDetail();
    check("7f: ... at most once: the GET after it does not recompute again", (await computedAt()) === c1);
    await claimResearch(A);
    await uploadAll(CONNECTIONS);
    const during = await getDetail();
    check("7f: never while research runs: the network changed, the paths stay as they were", (await computedAt()) === c1 && !JSON.stringify(pathsOf(during)).includes("Omar Haddad"));
    await finishResearch(A, "done");
    const backAgain = await getDetail();
    check("7f: research done: the next GET recomputes (Omar is back)", (await computedAt()) !== c1 && JSON.stringify(pathsOf(backAgain)).includes("Omar Haddad"));
    const c2 = await computedAt();
    check("7f: (the claim of a check)", await claimWarmPathCheck(A));
    await uploadAll(withoutOmar);
    const checking = pathsOf(await getDetail());
    check("7f: never while a check runs: status running, the paths untouched", checking?.status === "running" && (await computedAt()) === c2);
    await releaseWarmPathCheck(A);
    await getDetail();
    const c3 = await computedAt();
    check("7f: the check released: the GET recomputes", c3 !== c2);
    // Race safety: the recompute saves only over the row it read.
    const read = await getWarmPathRow(A);
    await saveIntro(A, "li:race-wp", { askedAt: null });
    const lost = await saveWarmPathResult(A, { status: "done", target: null, linkedinLive: null, xLive: null, paths: [], companyPaths: [], sources: [], error: null, summary: null }, { onlyIfIdle: true, ifVersion: read?.version ?? "x" });
    const kept = await getWarmPathRow(A);
    check("7f: a recompute computed from an older row writes nothing (a newer write is never overwritten)", Boolean(read?.version) && lost === false && (kept?.paths.length ?? 0) > 0 && kept?.target !== null);
    const other = await createLead({ linkedinUrl: `https://www.linkedin.com/in/other-wp-${W}` });
    made.push(other.id);
    const noRow = await saveWarmPathResult(other.id, { status: "done", target: null, linkedinLive: null, xLive: null, paths: [], companyPaths: [], sources: [], error: null, summary: null }, { updateOnly: true });
    check("7f: an update-only save never creates a row (a row deleted meanwhile stays deleted)", noRow === false && (await getWarmPathRow(other.id)) === null);

    // ---------------------------------------------- 7g. X through twitterapi.io
    const xOffLine = pathsOf(await getDetail())?.sources.find((s) => s.network === "x");
    check("7g: X off on this server comes first: the lead without an X handle is not asked for one", xOffLine?.detail === "off on this server." && xOffLine.reason === "not_configured", xOffLine);
    const cBeforeKey = await computedAt();
    const callsBeforeKey = outside();
    setWarmEnv({ TWITTERAPI_IO_KEY: W_KEYS.x });
    const keyOnLine = pathsOf(await getDetail())?.sources.find((s) => s.network === "x");
    check(
      "7g: the key added on the server: the next GET redoes the free part (no outside call), and the footer follows what is set up now",
      keyOnLine?.detail === "not checked, their X account is not known. Add it under Details." && (await computedAt()) !== cBeforeKey && outside() === callsBeforeKey,
      keyOnLine,
    );
    const badX = await patchLead({ xHandle: "not a handle!" });
    check("7g: PATCH /api/leads/[id] xHandle that is not a handle is 400 bad_handle", badX.status === 400 && badX.data?.code === "bad_handle", badX.data);
    const setX = await patchLead({ xHandle: `@${X_LEAD.toUpperCase()}` });
    check("7g: PATCH xHandle saves it cleaned (no @)", setX.status === 200 && (setX.data?.lead as Lead | undefined)?.xHandle === X_LEAD.toUpperCase(), setX.data?.lead && (setX.data.lead as Lead).xHandle);
    const linkX = await patchLead({ xHandle: `https://x.com/${X_LEAD}` });
    check("7g: PATCH xHandle accepts an x.com link", (linkX.data?.lead as Lead | undefined)?.xHandle === X_LEAD);
    const sync = await postSync();
    check(
      "7g: POST /api/network/x/sync: your lists refreshed, counts and credits only",
      sync.status === 200 && sync.data?.following === 2 && sync.data?.followers === 2 && Number(sync.data?.creditsUsed) > 0 && sync.data?.refreshed === true && named(JSON.stringify(sync.data)).length === 0,
      sync.data,
    );
    const xCheck = await postPaths();
    const xp = pathsOf(xCheck);
    const priyaPath = xp?.paths.find((p) => p.id === publicPathId(A, `li:${PRIYA}`));
    const zedPath = xp?.paths.find((p) => p.id === publicPathId(A, "x:1002"));
    check(
      "7g: POST /paths with X: Priya (your connection, mutual follows) is a Medium two-hop path; Zed (X only) is Weak",
      xCheck.status === 200 && priyaPath?.hops === 2 && priyaPath.strength === "medium" && zedPath?.strength === "weak" && xp?.sources.find((s) => s.network === "x")?.state === "checked",
      xp && xp.paths.map((p) => [p.id, p.strength]),
    );
    const xCalls = wcalls.filter((c) => c.host === W_HOSTS.x);
    check("7g: the twitterapi.io key travels only in the X-API-Key header", xCalls.length > 0 && xCalls.every((c) => c.headers["x-api-key"] === W_KEYS.x && !JSON.stringify(c.query).includes(W_KEYS.x)));
    check("7g: the lead's own lists are never stored (only your own X lists are)", (await query<{ n: number }>("select count(*)::int as n from le_network_contacts where network = 'x' and external_id = '800'"))[0]?.n === 0);
    if (!priyaPath) throw new Error("no two-hop path; stopping the warm-path checks");
    const PID = priyaPath.id;
    const replyIds = [...(xp?.paths ?? []), ...(xp?.companyPaths ?? [])].map((p) => p.id);
    check(
      "7g: every path id in the reply is opaque: 'direct' or the network and 12 hex characters, never a slug, name or handle",
      replyIds.length > 3 && replyIds.every((id) => /^(?:direct|li-[0-9a-f]{12}|x-[0-9a-f]{12})$/.test(id)) && !replyIds.some((id) => id.includes(PRIYA) || id.includes("1002") || named(id).length > 0),
      replyIds,
    );

    // ---------------------------------------------- 7h. intro requests
    const quota0 = (await query<{ n: number }>("select count(*)::int as n from le_quota_uses where kind = 'intro_draft'"))[0]?.n ?? 0;
    const bodies0 = wc.bodies.length;
    const drafted = await postIntro(PID);
    const dpath = drafted.data?.path as WarmPath | undefined;
    check("7h: POST .../intro is 200 { path } with the draft", drafted.status === 200 && dpath?.id === PID && dpath.introDraft?.message === wc.message, drafted.data);
    const sent = wc.bodies[bodies0] ?? {};
    const outputConfig = sent.output_config as { effort?: string; format?: { type?: string } } | undefined;
    check(
      "7h: one Claude call: claude-haiku-5-5 at effort low, max_tokens 1000, structured output, no sampling parameters",
      wc.bodies.length === bodies0 + 1 &&
        sent.model === "claude-haiku-5-5" &&
        outputConfig?.effort === "low" &&
        outputConfig?.format?.type === "json_schema" &&
        sent.max_tokens === 1000 &&
        !("temperature" in sent) &&
        !("top_p" in sent) &&
        !("top_k" in sent) &&
        !("thinking" in sent),
      { model: sent.model, effort: outputConfig?.effort, max: sent.max_tokens, keys: Object.keys(sent) },
    );
    const prompt = String(((sent.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content as string | undefined) ?? "");
    const blocks = ["sender", "connector", "your_link", "their_link", "lead", "brief", "angle", "findings"];
    check("7h: every input is in its own data block", blocks.every((b) => prompt.includes(`<${b}>`) && prompt.includes(`</${b}>`)), blocks.filter((b) => !prompt.includes(`<${b}>`)));
    check(
      "7h: the inputs: your name, the connector's first name, both links' evidence, the lead, the brief and the recommended angle",
      prompt.includes("Name: Sam Okafor") && prompt.includes("First name: Priya") && prompt.includes("Mutual follow with Ada on X") && prompt.includes("LinkedIn 1st degree since 2021") && prompt.includes("Title: CTO") && prompt.includes(brief.summary) && prompt.includes(angle.reasoning),
      prompt.slice(0, 1200),
    );
    check(
      "7h: the 3 most relevant findings that pass your criteria, not a 4th, not one the criteria leave out",
      ["FINDING-ONE", "FINDING-TWO", "FINDING-THREE"].every((f) => prompt.includes(f)) && !prompt.includes("FINDING-FOUR") && !prompt.includes("FINDING-FILTERED"),
    );
    const system = String(sent.system ?? "");
    check(
      "7h: the system prompt carries the rules (under 90 words, the ask first, forwardable, no follows, no link, no closeness beyond the evidence)",
      system === INTRO_SYSTEM && /Under 90 words/.test(system) && /No worries if it's not a fit/.test(system) && /Never mention follows/.test(system) && /No booking link/.test(system) && /Claim no more closeness/.test(system),
    );
    check("7h: introPrompt is pure: the same inputs give the same prompt", introPrompt({ senderName: "", path: priyaPath, lead: { name: "Ada Kim", title: null, companyName: null }, briefSummary: null, angleReasoning: null, findings: [] }).includes("Name: [your name]"));
    const quota1 = (await query<{ n: number }>("select count(*)::int as n from le_quota_uses where kind = 'intro_draft'"))[0]?.n ?? 0;
    check("7h: the draft is counted in le_quota_uses (intro_draft)", quota1 === quota0 + 1, { quota0, quota1 });
    const directIntro = await postIntro("direct");
    check("7h: no intro on the direct path: 400 direct, no Claude call", directIntro.status === 400 && directIntro.data?.code === "direct" && wc.bodies.length === bodies0 + 1, directIntro.data);
    for (const [label, pid] of [
      ["an unknown path", publicPathId(A, `li:nobody-wp-${W}`)],
      ["a malformed path id", "foo"],
      ["a path id that ends like a static file", "li:ada.png"],
      ["the person's slug instead of the opaque id", `li:${PRIYA}`],
    ] as const) {
      const r = await postIntro(pid);
      check(`7h: intro for ${label} is 404`, r.status === 404, r.data);
    }
    check("7h: intro for an unknown lead is 404", (await postIntro(PID, ghost)).status === 404);
    wc.delayMs = 250;
    const [i1, i2] = await Promise.all([
      postIntro(PID),
      (async () => {
        await wpause(40);
        return postIntro(PID);
      })(),
    ]);
    wc.delayMs = 0;
    check("7h: a second draft for the lead while one runs is 409 drafting", [i1.status, i2.status].sort().join(",") === "200,409" && [i1, i2].some((r) => r.data?.code === "drafting"), [i1.status, i2.status]);
    const room = 100 - ((await query<{ n: number }>("select count(*)::int as n from le_quota_uses where kind = 'intro_draft' and created_at > now() - interval '24 hours'"))[0]?.n ?? 0);
    if (room > 0) await query("insert into le_quota_uses (kind, units, lead_id) select 'intro_draft', 1, $1::uuid from generate_series(1, $2::int)", [A, room]);
    const bodies2 = wc.bodies.length;
    const capped = await postIntro(PID);
    check("7h: the 101st draft in 24 hours is 429 intro_budget, and Claude is not called", capped.status === 429 && capped.data?.code === "intro_budget" && /100 intro drafts a day/.test(String(capped.data?.error)) && wc.bodies.length === bodies2, capped.data);
    await query("delete from le_quota_uses where kind = 'intro_draft'");
    wc.stop = "refusal";
    const refused = await postIntro(PID);
    wc.stop = "end_turn";
    check("7h: Claude declines: 502 claude, \"Could not draft the request: ...\"", refused.status === 502 && refused.data?.code === "claude" && String(refused.data?.error).startsWith("Could not draft the request:"), refused.data);
    check("7h: ... the earlier draft stays", (await getWarmPathRow(A))?.intros[PID]?.introDraft?.message === wc.message);
    // A draft that followed something in the data (a link or an address the prompt forbids) is not saved.
    const goodMessage = wc.message;
    for (const [label, message] of [
      ["a link", "Hi Priya,\n\nWould you introduce me to Ada? Book here: https://evil.example/book\n\nSam"],
      ["an email address", "Hi Priya,\n\nWould you introduce me to Ada? Write to sam@evil.example\n\nSam"],
    ] as const) {
      wc.message = message;
      const tainted = await postIntro(PID);
      check(
        `7h: a draft with ${label} in it: 502 claude, nothing saved (the earlier draft stays)`,
        tainted.status === 502 && tainted.data?.code === "claude" && String(tainted.data?.error).includes(`had ${label} in it`) && (await getWarmPathRow(A))?.intros[PID]?.introDraft?.message === goodMessage,
        tainted.data,
      );
    }
    wc.message = goodMessage;

    // ---------------------------------------------- 7i. PATCH /paths/[pathId]: edits and "asked"
    const createdAt = (await getWarmPathRow(A))?.intros[PID]?.introDraft?.createdAt;
    const edited = await patchPath(PID, { introDraft: "  Hi Priya, edited by hand.\r\n\r\nSam  " });
    const ep = edited.data?.path as WarmPath | undefined;
    check("7i: introDraft saves the edit (trimmed, line breaks kept) and keeps the draft's time", edited.status === 200 && ep?.introDraft?.message === "Hi Priya, edited by hand.\n\nSam" && ep.introDraft.createdAt === createdAt, ep?.introDraft);
    check("7i: introDraft over 2,000 characters is 400", (await patchPath(PID, { introDraft: "x".repeat(2001) })).status === 400);
    check("7i: an empty body is 400", (await patchPath(PID, {})).status === 400);
    check("7i: asked that is not a boolean is 400", (await patchPath(PID, { asked: "yes" })).status === 400);
    check("7i: a body sent as text/plain is 415", (await patchPath(PID, undefined, { rawBody: '{"asked":true}', headers: { "content-type": "text/plain" } })).status === 415);
    check("7i: the direct path is 400 direct", (await patchPath("direct", { asked: true })).data?.code === "direct");
    check("7i: an unknown path is 404", (await patchPath(publicPathId(A, `li:nobody-wp-${W}`), { asked: true })).status === 404);
    check("7i: a path id that ends like a static file is 404", (await patchPath("li:ada.png", { asked: true })).status === 404);
    check("7i: the person's slug instead of the opaque id is 404 (no name ever goes in a URL)", (await patchPath(`li:${PRIYA}`, { asked: true })).status === 404);
    const asked = await patchPath(PID, { asked: true });
    const askedAt = (asked.data?.path as WarmPath | undefined)?.askedAt;
    const notes = async () => (await listEvents(A)).filter((e) => e.type === "note" && e.message === "Asked Priya Shah for an intro");
    check("7i: asked: true sets askedAt and logs one note \"Asked Priya Shah for an intro\"", asked.status === 200 && Boolean(askedAt) && (await notes()).length === 1, asked.data);
    const again = await patchPath(PID, { asked: true });
    check("7i: asked again keeps the first date and logs no second note", (again.data?.path as WarmPath | undefined)?.askedAt === askedAt && (await notes()).length === 1);
    const unasked = await patchPath(PID, { asked: false });
    check("7i: asked: false clears it", (unasked.data?.path as WarmPath | undefined)?.askedAt === null);
    await saveNetworkSource("linkedin_csv", { syncedAt: "now" });
    const kept2 = pathsOf(await getDetail())?.paths.find((p) => p.id === PID);
    check("7i: a recompute keeps the draft (drafts are kept by path id)", kept2?.introDraft?.message === "Hi Priya, edited by hand.\n\nSam");
    const cleared = await patchPath(PID, { introDraft: "" });
    check('7i: introDraft "" clears the draft', (cleared.data?.path as WarmPath | undefined)?.introDraft === null);

    // ---------------------------------------------- 7j. PATCH /paths: the lead's Instagram handle (a link only)
    const ig = await patchInstagram({ instagramHandle: "@Ada.Kim" });
    const igp = pathsOf(ig);
    check(
      "7j: PATCH /paths { instagramHandle } saves it (lower case, manual) and returns the paths with the link",
      ig.status === 200 && igp?.instagram?.handle === "ada.kim" && igp.instagram.source === "manual" && igp.links.instagram === "https://www.instagram.com/ada.kim/",
      igp && { instagram: igp.instagram, link: igp.links.instagram },
    );
    check("7j: ... and the footer's Instagram line follows (a link, nothing read)", igp?.sources.find((s) => s.network === "instagram")?.reason === "link_only");
    for (const [label, value, pattern] of [
      ['"explore"', "explore", /Instagram page/],
      ["a reel link", "https://www.instagram.com/reel/Cabc/", /Instagram page/],
      ["a handle with a space", "ada kim", /letters, digits, dots and _/],
      ["31 characters", "a".repeat(31), /letters, digits, dots and _/],
      ["another site", "https://example.com/ada", /letters, digits, dots and _/],
    ] as const) {
      const r = await patchInstagram({ instagramHandle: value });
      check(`7j: instagramHandle ${label} is 400 bad_handle`, r.status === 400 && r.data?.code === "bad_handle" && pattern.test(String(r.data?.error)), r.data);
    }
    check("7j: instagramHandle that is not text is 400", (await patchInstagram({ instagramHandle: 5 })).status === 400);
    check("7j: a missing instagramHandle is 400", (await patchInstagram({})).status === 400);
    check("7j: a body sent as text/plain is 415", (await patchInstagram(undefined, A, { rawBody: '{"instagramHandle":null}', headers: { "content-type": "text/plain" } })).status === 415);
    check("7j: an unknown lead is 404", (await patchInstagram({ instagramHandle: "ada" }, ghost)).status === 404);
    await claimWarmPathCheck(A);
    const busyIg = await patchInstagram({ instagramHandle: "someone.else" });
    await releaseWarmPathCheck(A);
    check("7j: while a check runs: 409 checking, and the handle is kept", busyIg.status === 409 && busyIg.data?.code === "checking" && (await getWarmPathRow(A))?.target?.instagramHandle === "ada.kim", busyIg.data);
    const igClear = await patchInstagram({ instagramHandle: null });
    check("7j: null clears it", pathsOf(igClear)?.instagram === null && pathsOf(igClear)?.links.instagram === null);

    // ---------------------------------------------- 7k. busy, research running, budgets and failures
    await claimResearch(A);
    const before11 = outside();
    const researching = await postPaths();
    await finishResearch(A, "done");
    check("7k: POST /paths while research runs is 409 research_running, and nothing is called", researching.status === 409 && researching.data?.code === "research_running" && outside() === before11, researching.data);
    await claimWarmPathCheck(A);
    const busy = await postPaths();
    await releaseWarmPathCheck(A);
    check("7k: POST /paths while another check runs (another server) is 409 checking", busy.status === 409 && busy.data?.code === "checking", busy.data);
    wx.delayMs = 200;
    const [k1, k2] = await Promise.all([
      postPaths(),
      (async () => {
        await wpause(40);
        return postPaths();
      })(),
    ]);
    wx.delayMs = 0;
    check("7k: a second click while a check runs on this server is 409 checking", [k1.status, k2.status].sort().join(",") === "200,409", [k1.status, k2.status]);
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: "0" });
    const overX = await postPaths();
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: undefined });
    check(
      "7k: every live source over budget (X paused): 429 warm_path_budget, and the free part is still saved",
      overX.status === 429 && overX.data?.code === "warm_path_budget" && /X checks are paused/.test(String(overX.data?.error)) && pathsOf(overX)?.paths[0]?.id === "direct",
      overX.data && { status: overX.status, error: overX.data.error },
    );
    wx.fail = { "user-info": 502 };
    const upstream = await postPaths();
    const upstreamRow = await getWarmPathRow(A);
    // A lead with only an X handle: nothing else can be checked, so the whole check failed.
    await updateLead(bare.id, { xHandle: `bare_wp_${W}` });
    const allFailed = await postPaths(bare.id);
    await updateLead(bare.id, { xHandle: null });
    wx.fail = {};
    check(
      "7k: X answered 502 but your connections were still matched: 200, the X line says it failed (as after a reload), and the free part is saved",
      upstream.status === 200 &&
        pathsOf(upstream)?.status === "done" &&
        pathsOf(upstream)?.sources.find((s) => s.network === "x")?.state === "failed" &&
        pathsOf(upstream)?.sources.find((s) => s.network === "x")?.detail.startsWith("did not answer (") === true &&
        pathsOf(upstream)?.paths[0]?.id === "direct" &&
        upstreamRow?.status === "done",
      upstream.data && { status: upstream.status, error: upstream.data.error },
    );
    check(
      "7k: every source that could run failed (X answered 502, no LinkedIn profile): 502 upstream, each line named once",
      allFailed.status === 502 &&
        allFailed.data?.code === "upstream" &&
        /^Could not check for warm paths\. X: did not answer \(.*502.*\)\. Try again in a few minutes\.$/.test(String(allFailed.data?.error)) &&
        pathsOf(allFailed)?.status === "error" &&
        pathsOf(allFailed)?.error?.startsWith("X: did not answer") === true,
      allFailed.data && { status: allFailed.status, error: allFailed.data.error, stored: pathsOf(allFailed)?.error },
    );
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: "0" });
    const keptLists = await postSync();
    check("7k: Refresh now with the X budget paused and your lists stored: 200, refreshed false, with a note", keptLists.status === 200 && keptLists.data?.refreshed === false && typeof keptLists.data?.note === "string", keptLists.data);
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: undefined });

    // A different X handle on the lead: the cached X check goes, the paths drop the old X evidence.
    check("7k: (the X check is cached)", (await getWarmPathRow(A))?.xLive !== null);
    const changedX = await patchLead({ xHandle: `someone_${W}` });
    const xGone = await getWarmPathRow(A);
    const hasX = (paths: WarmPath[] | undefined) => (paths ?? []).some((p) => p.links.some((l) => l.evidence.some((e) => e.kind === "mutual_follow" || e.kind === "follows")));
    check(
      "7k: PATCH a different xHandle: the cached X check is cleared and the paths lose their X evidence at once (the list chip too)",
      changedX.status === 200 && xGone?.xLive === null && !hasX(xGone?.paths) && !xGone?.paths.some((p) => p.id === publicPathId(A, "x:1002")),
      xGone && xGone.paths.map((p) => p.id),
    );
    await patchLead({ xHandle: X_LEAD });
    const xBack = await postPaths();
    check("7k: (the X paths are back after a new check)", hasX(pathsOf(xBack)?.paths));
    // Your own X handle in Settings: your lists and every X-derived path go, and the chips are rebuilt after.
    const tasksX = afterTasks.length;
    const newOwn = await putSettings({ xHandle: `sam_new_${W}` });
    const ownGone = await getWarmPathRow(A);
    check(
      "7k: a new X handle in Settings drops your X lists and every path from them, and hands the free recompute to after()",
      newOwn.status === 200 &&
        (await query<{ n: number }>("select count(*)::int as n from le_network_contacts where network = 'x'"))[0]?.n === 0 &&
        ownGone?.xLive === null &&
        !ownGone?.paths.some((p) => p.id.startsWith("x-")) &&
        afterTasks.length === tasksX + 1,
    );
    const sameSettings = await putSettings({ senderName: "Sam Okafor" });
    check("7k: a Settings save that changes neither handle nor URL schedules nothing", sameSettings.status === 200 && afterTasks.length === tasksX + 1);
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: "0" });
    const noLists = await postSync();
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: undefined });
    check("7k: Refresh now with the X budget paused and no lists stored: 429 warm_path_budget", noLists.status === 429 && noLists.data?.code === "warm_path_budget", noLists.data);
    wx.fail = { "user-info": 502 };
    const syncDown = await postSync();
    wx.fail = {};
    check("7k: Refresh now when X does not answer: 502 upstream", syncDown.status === 502 && syncDown.data?.code === "upstream", syncDown.data);
    const noHandle = await putSettings({ xHandle: "" });
    const syncNoHandle = await postSync();
    check("7k: Refresh now with no X handle in Settings: 400 no_handle", noHandle.status === 200 && syncNoHandle.status === 400 && syncNoHandle.data?.code === "no_handle", syncNoHandle.data);
    await putSettings({ xHandle: X_OWNER });

    // LinkedIn on your own account (step 2): its budget, and the account state in /api/status.
    setWarmEnv({ TWITTERAPI_IO_KEY: undefined, UNIPILE_NETWORK_ACCOUNT_ID: "acc_owner", WARM_PATH_LINKEDIN_CHECKS_PER_DAY: "0" });
    wu.accounts = [
      { id: "acc_research", status: "OK" },
      { id: "acc_owner", status: "OK" },
    ];
    resetUnipileState();
    const before12 = wcalls.length;
    const st1 = await call(statusRoute.GET, { path: "/api/status" });
    const st2 = await call(statusRoute.GET, { path: "/api/status" });
    const statusCalls = wcalls.slice(before12);
    check(
      "7k: GET /api/status: your LinkedIn account connected, from one cached accounts call that never touches LinkedIn",
      (st1.data?.linkedinAccount as { state?: string } | undefined)?.state === "connected" && (st2.data?.linkedinAccount as { state?: string } | undefined)?.state === "connected" && statusCalls.length === 1 && statusCalls[0].path === "/api/v1/accounts",
      statusCalls.map((c) => c.path),
    );
    const overLi = await postPaths();
    check(
      "7k: LinkedIn checks paused and X not set up: 429 warm_path_budget naming LinkedIn, and no LinkedIn request on your account",
      overLi.status === 429 && overLi.data?.code === "warm_path_budget" && /LinkedIn checks are paused/.test(String(overLi.data?.error)) && !wcalls.slice(before12).some((c) => c.query.account_id === "acc_owner"),
      overLi.data && { status: overLi.status, error: overLi.data.error },
    );
    const net3 = (await getNet()).data?.linkedin as Record<string, Record<string, unknown>> | undefined;
    check("7k: GET /api/network: your account connected, 0 checks allowed today", net3?.account?.state === "connected" && net3?.account?.checksLimit === 0, net3?.account);
    setWarmEnv({ UNIPILE_NETWORK_ACCOUNT_ID: undefined, WARM_PATH_LINKEDIN_CHECKS_PER_DAY: undefined, TWITTERAPI_IO_KEY: W_KEYS.x });
    wu.accounts = [{ id: "acc_research", status: "OK" }];
    resetUnipileState();

    // ---------------------------------------------- 7l. your own profile: Read now
    const soon = await postSelf();
    check("7l: Read now right after a read (the check read it): 429 too_soon", soon.status === 429 && soon.data?.code === "too_soon", soon.data);
    const backdate = () => query("update le_network_sources set data = jsonb_set(data, '{readAt}', '\"2026-01-01T00:00:00.000Z\"'::jsonb) where key = 'linkedin_self'");
    await backdate();
    const tasks1 = afterTasks.length;
    const self = await postSelf();
    check(
      "7l: POST /api/network/linkedin/self: counts only (2 roles, 1 school), and every lead's paths are recomputed after",
      self.status === 200 && self.data?.roles === 2 && self.data?.schools === 1 && typeof self.data?.readAt === "string" && !/Nimbus|Northwind|KTH/.test(JSON.stringify(self.data)) && afterTasks.length === tasks1 + 1,
      self.data,
    );
    await backdate();
    check("7l: (claimed elsewhere)", await claimNetworkSource("linkedin_self", 120_000));
    const busySelf = await postSelf();
    check("7l: a read already running is 409 busy", busySelf.status === 409 && busySelf.data?.code === "busy", busySelf.data);
    await saveNetworkSource("linkedin_self", { status: "ok" });
    wu.profileStatus = 500;
    const failedSelf = await postSelf();
    wu.profileStatus = 0;
    resetUnipileState();
    check("7l: LinkedIn does not answer (and the Apify fallback is off): 502 failed", failedSelf.status === 502 && failedSelf.data?.code === "failed", failedSelf.data);
    const retry = await postSelf();
    check("7l: a retry right after a failed read: 429 too_soon", retry.status === 429 && retry.data?.code === "too_soon", retry.data);
    // A new URL in Settings resets the gaps above, not the 10 profile reads a day (7 are taken here, so 3 are left).
    await query("delete from le_quota_uses where kind = 'profile_read'");
    await query("insert into le_quota_uses (kind, units) select 'profile_read', 1 from generate_series(1, 7)");
    const readsBefore = wcalls.filter((c) => c.host === W_HOSTS.unipile && c.path.includes("/users/")).length;
    const toggled: number[] = [];
    for (let i = 0; i < 6; i++) {
      await putSettings({ linkedinUrl: i % 2 ? SAM_URL : `https://www.linkedin.com/in/other-wp-${W}` });
      toggled.push((await postSelf()).status);
    }
    const readsAfter = wcalls.filter((c) => c.host === W_HOSTS.unipile && c.path.includes("/users/")).length;
    const lastToggle = await postSelf();
    check(
      "7l: alternating the LinkedIn URL in Settings gets 3 more reads, then 429 too_soon with the day's limit",
      toggled.filter((s) => s !== 429).length === 3 && toggled.slice(3).every((s) => s === 429) && readsAfter - readsBefore === 3 && /10 LinkedIn profile reads a day/.test(String(lastToggle.data?.error)),
      { toggled, reads: readsAfter - readsBefore, error: lastToggle.data?.error },
    );
    await putSettings({ linkedinUrl: SAM_URL });
    await query("delete from le_quota_uses where kind = 'profile_read'");

    // ---------------------------------------------- 7m. the api-client against these routes
    const cDetail = await client.getLead(A);
    check("7m: client getLead: paths normalised (lists filled, setup booleans)", Array.isArray(cDetail.paths?.paths) && Array.isArray(cDetail.paths?.companyPaths) && typeof cDetail.paths?.setup.any === "boolean");
    check("7m: client warmPathsFrom fills a partial object and refuses junk", client.warmPathsFrom({ status: "weird", paths: [{ id: "x:1", hops: 3 }, { id: "x:2", hops: 2, links: "no" }] })?.paths.length === 1 && client.warmPathsFrom("nope") === null && client.warmPathsFrom({})?.status === "idle");
    const cCheck = await client.findWarmPaths(A);
    check("7m: client findWarmPaths: { paths, message, outcome }", cCheck.outcome === "found" && cCheck.paths?.paths[0]?.id === "direct" && cCheck.message.startsWith("Warm paths:"));
    const cDraft = await client.draftIntro(A, PID);
    check("7m: client draftIntro (the opaque path id in the URL): the path with its draft", cDraft.id === PID && cDraft.introDraft?.message === wc.message);
    const draftUrl = bridged.filter((b) => b.method === "POST" && b.path.endsWith("/intro")).at(-1)?.path ?? "";
    check("7m: ... and that URL holds no name, slug or handle", draftUrl.endsWith(`/paths/${PID}/intro`) && !draftUrl.includes(PRIYA) && named(decodeURIComponent(draftUrl)).length === 0, draftUrl);
    const cAsk = await client.saveIntro(A, PID, { asked: true });
    check("7m: client saveIntro: the path, asked", Boolean(cAsk.askedAt));
    let codeSeen: string | null = null;
    try {
      await client.draftIntro(A, "direct");
    } catch (err) {
      codeSeen = err instanceof client.ApiError ? `${err.status}:${err.code}:${err.message}` : "other";
    }
    check("7m: client errors keep the server's status, code and message", codeSeen === "400:direct:You are connected directly: no intro is needed.", codeSeen);
    const cIg = await client.setInstagramHandle(A, "ada.k");
    check("7m: client setInstagramHandle: the paths", cIg?.instagram?.handle === "ada.k");
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: "0" });
    let budgetPaths: WarmPaths | null = null;
    try {
      await client.findWarmPaths(A);
    } catch (err) {
      budgetPaths = client.warmPathsFromError(err);
    }
    setWarmEnv({ WARM_PATH_X_USD_PER_DAY: undefined });
    check("7m: client warmPathsFromError: the paths a 429 still carries", budgetPaths?.paths[0]?.id === "direct");
    const cNet = await client.getNetwork();
    check("7m: client getNetwork: counts and states", cNet.linkedin.connections?.count === withoutOmar.length && cNet.x.handle === X_OWNER && cNet.instagram.handle === "sam.wp");
    // 7,000 connections: two parts, one PUT each, the second one done.
    const many = Array.from({ length: 7000 }, (_, i): [string, string, string, string, string, string | null] => [`many-${i}-wp-${W}`, "Many", `Person${i}`, "Elsewhere Inc", "Engineer", null]);
    const progress: number[] = [];
    bridged.length = 0;
    const uploaded = await client.uploadConnections([...CONNECTIONS, ...many], { exportedAt: Date.parse("2026-11-02T09:00:00Z"), onProgress: (p) => progress.push(p.part) });
    const puts = bridged.filter((b) => b.method === "PUT");
    check(
      "7m: client uploadConnections: 2 parts of at most 5,000 rows, one PUT each, one upload id, the export date from the file",
      uploaded.parts === 2 && uploaded.total === CONNECTIONS.length + 7000 && puts.length === 2 && puts.every((p) => (p.body?.rows as unknown[]).length <= 5000 && p.body?.importId === puts[0].body?.importId && p.body?.exportedAt === "2026-11-02T09:00:00.000Z") && progress.join(",") === "1,2",
      { parts: uploaded.parts, total: uploaded.total, puts: puts.length, progress },
    );
    let uploadErr: unknown = null;
    try {
      await client.uploadConnections([["Not A Slug", "A", "B", "", "", null]]);
    } catch (err) {
      uploadErr = err;
    }
    check("7m: client uploadConnections: a refused part rejects with ConnectionsUploadError (part 1 of 1, 400)", uploadErr instanceof client.ConnectionsUploadError && uploadErr.part === 1 && uploadErr.parts === 1 && uploadErr.status === 400);
    const cSync = await client.syncX();
    check("7m: client syncX: counts", cSync.following === 2 && cSync.followers === 2 && cSync.refreshed === true);
    const cStatus = await client.getStatus();
    check("7m: client getStatus: linkedinAccount", cStatus.linkedinAccount.state === "not_set_up" && cStatus.providers.some((p) => p.id === "twitterapi" && p.configured));
    const removed = await client.deleteConnections();
    check("7m: client deleteConnections: { removed }", removed.removed === CONNECTIONS.length + 7000);

    // ---------------------------------------------- 7n. removing your connections; a new LinkedIn URL for the lead
    const afterDelete = await getWarmPathRow(A);
    const leadNow = await getLead(A);
    check(
      "7n: DELETE connections: no stored path or company person names one, the chip is cleared, and the free recompute is handed to after()",
      !afterDelete?.paths.some((p) => p.id.startsWith("li-") || p.id === "direct") && afterDelete?.companyPaths.length === 0 && leadNow?.warmPath?.connected !== true,
      afterDelete && afterDelete.paths.map((p) => p.id),
    );
    const net4 = (await getNet()).data?.linkedin as Record<string, unknown> | undefined;
    check("7n: GET /api/network: no connections", net4?.connections === null);
    const runTask = afterTasks.at(-1);
    const beforeTask = outside();
    const ranTask = typeof runTask === "function";
    if (ranTask) await inRequestScope("/after", () => (runTask as () => Promise<void>)());
    check("7n: the recorded after() task (recompute everyone) runs, SQL only: no outside call", ranTask && outside() === beforeTask);
    await uploadAll(CONNECTIONS);
    await postPaths();
    const moved = await patchLead({ linkedinUrl: `https://www.linkedin.com/in/someone-else-wp-${W}` });
    const movedPaths = pathsOf(await getDetail());
    check(
      "7n: PATCH a new LinkedIn URL: the lead's warm paths and chip are gone (a different person)",
      moved.status === 200 && (moved.data?.lead as Lead | undefined)?.warmPath === null && (await getWarmPathRow(A)) === null && movedPaths?.status === "idle" && movedPaths.paths.length === 0,
      movedPaths && { status: movedPaths.status, n: movedPaths.paths.length },
    );

    // ---------------------------------------------- 7o. exposure: no contact lists in replies, no names in logs
    const network = responses.filter((r) => r.path.startsWith("/api/network") || r.path === "/api/settings" || r.path === "/api/status");
    check(
      `7o: no reply of /api/network/*, /api/settings or /api/status (${network.length}) names a contact`,
      network.length > 20 && network.every((r) => named(r.text).length === 0),
      network.filter((r) => named(r.text).length).slice(0, 2),
    );
    check("7o: no reply ever held more than 5 of the 32 people at Acme Robotics", responses.every((r) => quillsIn(r.text) <= 5));
    const leaked = serverLines.filter((l) => named(l).length > 0 || l.includes("Ada Kim"));
    check(`7o: no name in the ${serverLines.length} server log lines written meanwhile`, leaked.length === 0, leaked.slice(0, 3));
    const keys = [W_KEYS.unipile, W_KEYS.x, W_KEYS.claude];
    check("7o: no key in a log line or a reply", !serverLines.some((l) => keys.some((k) => l.includes(k))) && !responses.some((r) => keys.some((k) => r.text.includes(k))));
    check("7o: no call to any other outside host", strayHosts.length === 0, strayHosts);
  } finally {
    globalThis.fetch = realFetch;
    restoreConsole();
    setWarmEnv(savedEnv as Partial<Record<(typeof W_ENV)[number], string | undefined>>);
    resetUnipileState();
    for (const id of made) await deleteLead(id).catch(() => undefined);
    await query("delete from le_network_contacts");
    await query("delete from le_network_sources");
    await query("delete from le_quota_uses where kind in ('warm_path_linkedin', 'warm_path_x', 'intro_draft', 'profile_read', 'warm_path_check') or lead_id = any($1::uuid[])", [made]);
    if (settingsRow[0]) await query("update le_settings set value = $1::jsonb where key = 'app'", [JSON.stringify(settingsRow[0].value)]);
    else await query("delete from le_settings where key = 'app'");
    const left = await query<{ n: number }>("select count(*)::int as n from le_leads where id = any($1::uuid[])", [made]);
    check("7: cleanup: no test lead, contact, source or budget row left", left[0]?.n === 0, left[0]);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  // Every provider call in this harness is mocked: keep those fake calls out of the usage ledger.
  process.env.USAGE_LEDGER_DISABLED = "1";
  try {
    await testAuth();
    await testProxy();
    await testRoutes();
    await testHubSpot();
    await testRunGuards();
    await testQualify();
    await testWarmPaths();
  } finally {
    restoreEnv();
    globalThis.fetch = realFetch;
    // The tests' run slots: without this they would count against the real caps for a day.
    if (runLeadIds.size) {
      try {
        const removed = await query("delete from le_run_starts where lead_id = any($1::uuid[]) returning id", [[...runLeadIds]]);
        console.log(`  (removed ${removed.length} run slots taken by the tests)`);
      } catch (err) {
        check("remove the run slots taken by the tests", false, err instanceof Error ? err.message : String(err));
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(1)} s (after() tasks recorded, never run: ${afterTasks.length})`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
