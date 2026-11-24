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
  setResearchStep,
  updateLead,
  type LeadPatch,
} from "../src/lib/repo/leads";
import { DELETE_LEADS_SQL, deleteLeads, restoreLeads, uniqueLeadIds, unqualifyLeads } from "../src/lib/repo/qualify";
import { getSettings } from "../src/lib/repo/settings";
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

/** Runs a route handler inside a minimal Next request scope (enough for after() and connection()). */
async function callRoute(
  handler: (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  opts: { method?: string; path: string; body?: unknown; rawBody?: string; id?: string; headers?: Record<string, string> },
): Promise<CallResult> {
  const method = opts.method ?? "GET";
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const request = new NextRequest(new URL(opts.path, "http://localhost:3000"), {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: method === "GET" ? undefined : body,
  });
  const ctx = { params: Promise.resolve({ id: opts.id ?? "" }) };
  const workStore = {
    route: opts.path,
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: (task: unknown) => void afterTasks.push(task) },
  };
  const unitStore = { type: "request", phase: "action" };
  const res = await workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run(unitStore as never, () => handler(request, ctx)));
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
  check("GET /api/status 200 with 8 providers", status.status === 200 && providers.length === 8, status.data);
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
