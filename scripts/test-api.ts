/**
 * Tests for the API layer (api agent): auth, proxy, route handlers and HubSpot.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-api.ts
 *
 * 1. auth     password check; session token valid / tampered / expired / wrong secret; cookie attributes
 * 2. proxy    the matcher as Next compiles it, and every gate decision
 * 3. routes   the real handlers against Neon with one temp lead: create, duplicate, get, patch,
 *             sent, events, research and steer claims, settings, status, login/logout, delete.
 *             Handlers run inside a minimal Next request scope whose after() only records the
 *             task: research is claimed but never run, so no provider or Claude credit is spent.
 * 4. hubspot  pushLeadToHubSpot against a mocked HubSpot API (no token, no network)
 *
 * Prints statuses and short snippets only: never a key, token, cookie value or header.
 */
// First, as in Next's own server: installs globalThis.AsyncLocalStorage, which the
// request-scope modules below need when they load.
import "next/dist/server/node-environment-baseline";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import * as leadsRoute from "../src/app/api/leads/route";
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
import { serverError } from "../src/app/api/_lib/api";
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
import { deleteLead, finishResearch, getLead } from "../src/lib/repo/leads";
import { getSettings } from "../src/lib/repo/settings";
import type { Angle, Lead } from "../src/lib/types";

// ------------------------------------------------------------------ compile-time checks
// The same shape Next's generated validator (.next/types/validator.ts) requires of route
// files; `npx tsc --noEmit` fails here if a handler signature drifts.
type Handler<P> = (request: NextRequest, context: { params: Promise<P> }) => Promise<Response | void> | Response | void;
type RouteHandlerConfig<P> = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS", Handler<P>>>;
type NoParams = Record<string, never>;
void (leadsRoute satisfies RouteHandlerConfig<NoParams>);
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

const GATE_KEYS = ["APP_PASSWORD", "SESSION_SECRET", "HUBSPOT_ACCESS_TOKEN"] as const;
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
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
  const redirectsTo = (res: Response) => (res.status === 307 || res.status === 308 ? res.headers.get("location") : null);

  setEnv({ APP_PASSWORD: undefined, SESSION_SECRET: undefined });
  check("gate off: pages pass", passes(await run("/")));
  check("gate off: API passes", passes(await run("/api/leads")));

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
  setEnv({ SESSION_SECRET: undefined });
  check("misconfigured gate fails closed", (await run("/api/leads", token)).status === 401);
  restoreEnv();
}

// ------------------------------------------------------------------ 3. routes against Neon

async function testRoutes(): Promise<void> {
  section("3. routes (Neon)");
  restoreEnv();
  setEnv({ APP_PASSWORD: undefined, HUBSPOT_ACCESS_TOKEN: undefined });

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
    check("duplicate starts no research", afterTasks.length === 1);

    const list = await callRoute(asHandler(leadsRoute.GET), { path: "/api/leads" });
    check("GET /api/leads includes the lead", list.status === 200 && (list.data?.leads as Lead[]).some((l) => l.id === id));

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
    xHandle: null,
    location: null,
    notes: null,
    stage: "contacted",
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

async function main(): Promise<void> {
  const started = Date.now();
  try {
    await testAuth();
    await testProxy();
    await testRoutes();
    await testHubSpot();
  } finally {
    restoreEnv();
    globalThis.fetch = realFetch;
  }
  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(1)} s (after() tasks recorded, never run: ${afterTasks.length})`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
