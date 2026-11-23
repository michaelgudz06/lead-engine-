/**
 * Tests for product analytics (PostHog): src/lib/analytics.ts, src/lib/analytics-server.ts,
 * src/instrumentation-client.ts and the /ingest rewrites in next.config.ts.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-analytics.ts [--e2e]
 *
 * 1. client  the no-op path (no key: nothing captured, posthog-js never loaded), key validation,
 *            the property sanitiser, beforeSend, the init options (privacy), events queued before
 *            posthog-js is up, the SPA pageleave, the draft_edited debounce, reset on log out
 * 2. config  next.config.ts: no rewrites without a key; per region they agree with posthogHosts()
 * 3. server  the no-op path; then a local fake PostHog (no network): captureServerEvent, and
 *            research_completed / research_failed / steer_completed for a demo lead, read-only
 *            (the "run" is a stub: no research runs), $process_person_profile false
 * 4. e2e     with --e2e (or --e2e=nokey,key,gate): `next dev -p 3500`, one server per pass, each
 *            stopped after. The servers never see a key or password from .env.local.
 *            nokey  no /ingest traffic, posthog-js never loaded, /ingest is a 404.
 *            key    NEXT_PUBLIC_POSTHOG_KEY=phc_test_fake, upstream pointed at the local fake PostHog
 *                   (nothing can reach posthog.com even by mistake): Playwright clicks through every
 *                   tracked action with every write API call mocked (no lead, setting or run is
 *                   touched), intercepts /ingest, checks events and properties, and that the browser
 *                   never calls posthog.com. The research and steer routes are loaded with an
 *                   unknown lead id (404: no run).
 *            gate   the same key plus a throwaway APP_PASSWORD: the app stays shut without a session,
 *                   /ingest does not, a real login works, and the cookies that reach PostHog are named.
 *
 * Prints statuses and short snippets only: never a key, token, cookie or header value.
 */
// First, as in Next's own server: installs globalThis.AsyncLocalStorage, which next/server
// (after(), used by analytics-server) needs when it loads.
import "next/dist/server/node-environment-baseline";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as http from "node:http";
import { createRequire } from "node:module";
import * as net from "node:net";
import { join, sep } from "node:path";
import * as zlib from "node:zlib";
import { CONFIG_DEFAULTS_DATES } from "@posthog/types";
import type { CaptureResult } from "posthog-js";
import nextConfig from "../next.config";
import { ANGLE_LIBRARY } from "../src/lib/abstract-context";
import {
  analyticsKey,
  angleRef,
  attachAnalytics,
  beforeSend,
  changedSettingsFields,
  CLIENT_EVENTS,
  daysFromNow,
  DraftEditTracker,
  isSafeToken,
  LIBRARY_ANGLE_IDS,
  posthogHosts,
  posthogInitOptions,
  resetAnalytics,
  sanitizeProps,
  track,
  trackNavigationStart,
  type AnalyticsClient,
} from "../src/lib/analytics";
import {
  captureServerEvent,
  SERVER_DISTINCT_ID,
  serverAnalyticsEnabled,
  shutdownServerAnalytics,
  steerOutcomeFrom,
  trackResearchRun,
  trackSteerRun,
  type ServerEventProps,
} from "../src/lib/analytics-server";
import { getLead } from "../src/lib/repo/leads";
import { DEFAULT_SETTINGS, type Lead } from "../src/lib/types";

const ROOT = join(__dirname, "..");
/** Demo leads: read only. Never deleted, never researched. */
const PIETER = "d0593297-256c-430d-ab75-60e0e93511c4";
const FAKE_KEY = "phc_test_fake";
/** --e2e runs every browser pass; --e2e=nokey,key,gate picks some. */
const E2E_ARG = process.argv.find((a) => a === "--e2e" || a.startsWith("--e2e="));
const E2E_PASSES = new Set(!E2E_ARG ? [] : E2E_ARG === "--e2e" ? ["nokey", "key", "gate"] : E2E_ARG.slice("--e2e=".length).split(","));

// ------------------------------------------------------------------ helpers

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function info(line: string): void {
  console.log(`      ${line}`);
}

/** Something outside these files that needs a decision: reported, not counted as a failure. */
function note(line: string): void {
  console.log(`NOTE  ${line}`);
}

const T0 = Date.now();
function section(title: string): void {
  console.log(`\n=== ${title}  (+${Math.round((Date.now() - T0) / 1000)}s)`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

async function waitFor(test: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    if (test()) return true;
    await sleep(stepMs);
  }
  return test();
}

type Props = Record<string, unknown>;

function asRecord(value: unknown): Props {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Props) : {};
}

function sameSet(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));
}

/** Was posthog-js (the browser SDK) loaded into this process? */
function posthogJsLoaded(): boolean {
  const req = createRequire(__filename);
  return Object.keys(req.cache).some((p) => p.includes(`${sep}node_modules${sep}posthog-js${sep}`));
}

class FakeClient implements AnalyticsClient {
  readonly calls: { event: string; props: Props; options: Props }[] = [];
  resets = 0;
  capture(event: string, properties?: Record<string, unknown> | null, options?: Record<string, unknown>): undefined {
    this.calls.push({ event, props: { ...(properties ?? {}) }, options: { ...(options ?? {}) } });
    return undefined;
  }
  reset(): void {
    this.resets += 1;
  }
}

// ------------------------------------------------------------------ PostHog payloads

/** An event as PostHog receives it (browser batches and posthog-node's capture v1 alike). */
interface SeenEvent {
  source: "browser" | "upstream" | "server";
  event: string;
  distinctId: string;
  properties: Props;
  options: Props;
  raw: string;
}

/** posthog-js sends a JSON event or batch, maybe gzipped (compression=gzip-js) or base64 form data; posthog-node gzips capture v1 batches. */
function decodeBody(body: Buffer, url: string, encoding?: string): unknown {
  let buf = body;
  try {
    if ((encoding ?? "").includes("gzip") || /compression=gzip/.test(url) || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = zlib.gunzipSync(buf);
  } catch {
    // Not gzip after all.
  }
  let text = buf.toString("utf8");
  if (text.startsWith("data=")) text = decodeURIComponent(text.slice(5).replace(/\+/g, " "));
  try {
    return JSON.parse(text);
  } catch {
    // Maybe base64.
  }
  try {
    return JSON.parse(Buffer.from(text, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function toEvents(decoded: unknown, source: SeenEvent["source"]): SeenEvent[] {
  const record = asRecord(decoded);
  const list: unknown[] = Array.isArray(decoded) ? decoded : Array.isArray(record.batch) ? record.batch : decoded ? [decoded] : [];
  return list.map((item) => {
    const e = asRecord(item);
    const properties = asRecord(e.properties);
    const distinct = e.distinct_id ?? properties.distinct_id ?? "";
    return { source, event: String(e.event ?? ""), distinctId: String(distinct), properties, options: asRecord(e.options), raw: JSON.stringify(item) };
  });
}

interface FakePosthog {
  origin: string;
  /** cookieNames: names only, values are never kept. */
  requests: { method: string; path: string; cookieNames: string[]; events: SeenEvent[] }[];
  events(): SeenEvent[];
  close(): Promise<void>;
}

/** A local stand-in for PostHog's hosts: records what arrives and answers like PostHog. */
async function startFakePosthog(): Promise<FakePosthog> {
  const requests: FakePosthog["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      const body = Buffer.concat(chunks);
      const decoded = body.length ? decodeBody(body, path, String(req.headers["content-encoding"] ?? "")) : null;
      const source: SeenEvent["source"] = path.startsWith("/i/v1/") ? "server" : "upstream";
      const events = decoded ? toEvents(decoded, source) : [];
      const cookieNames = String(req.headers.cookie ?? "")
        .split(";")
        .map((c) => c.split("=")[0].trim())
        .filter(Boolean);
      requests.push({ method: req.method ?? "", path, cookieNames, events });
      let reply: unknown = { status: 1 };
      if (source === "server") {
        // Capture v1 answers per event uuid.
        const batch = Array.isArray(asRecord(decoded).batch) ? (asRecord(decoded).batch as unknown[]) : [];
        reply = { results: Object.fromEntries(batch.map((e) => [String(asRecord(e).uuid ?? ""), { result: "ok" }])) };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    events: () => requests.flatMap((r) => r.events),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ------------------------------------------------------------------ 1. client

async function testClient(): Promise<void> {
  section("1. client (src/lib/analytics.ts, src/instrumentation-client.ts)");
  const g = globalThis as unknown as { window?: unknown };
  const fake = new FakeClient();
  try {
    // --- no key: a complete no-op
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    g.window = { location: new URL(`http://localhost:3500/leads/${PIETER}`) };
    attachAnalytics(fake); // even with a client attached by mistake, nothing goes out without a key
    track("email_copied", angleRef(PIETER, "no-cold-starts", 0));
    track("login_succeeded");
    track("logged_out", {}, { beforeUnload: true });
    trackNavigationStart("/pipeline", "push");
    const quiet = new DraftEditTracker(5);
    quiet.edited("a1", angleRef(PIETER, "no-cold-starts", 0), "subject");
    quiet.flush();
    resetAnalytics();
    check("no key: track(), pageleave, draft tracker and reset send nothing", fake.calls.length === 0 && fake.resets === 0, `${fake.calls.length} captures`);
    attachAnalytics(null);
    check("no key: analyticsKey() is empty", analyticsKey() === "");
    const inst = await import("../src/instrumentation-client");
    inst.onRouterTransitionStart("/pipeline", "push");
    await sleep(50);
    check("no key: instrumentation-client loads no posthog-js and does not throw", !posthogJsLoaded());

    // --- key validation: only a public project key is ever used
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phx_personal_api_key_123";
    check("a personal API key (phx_) is refused", analyticsKey() === "");
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "REPLACE_ME";
    check("a placeholder is refused", analyticsKey() === "");
    process.env.NEXT_PUBLIC_POSTHOG_KEY = `  ${FAKE_KEY}  `;
    check("a phc_ project key is used (trimmed)", analyticsKey() === FAKE_KEY);

    // --- the sanitiser
    const tokens: [string, boolean][] = [
      [PIETER, true],
      ["no-cold-starts", true],
      ["call_booked", true],
      ["email", true],
      ["pieter@example.com", false],
      ["https://www.linkedin.com/in/someone", false],
      ["linkedin.com/in/someone", false],
      ["linkedin.com", false],
      ["www.example.org", false],
      ["abstract.inc", false],
      ["two words", false],
      ["line\nbreak", false],
      ["x".repeat(65), false],
      ["", false],
    ];
    const wrong = tokens.filter(([v, want]) => isSafeToken(v) !== want).map(([v]) => JSON.stringify(v.slice(0, 30)));
    check("isSafeToken: ids and enums pass; emails, URLs, domains and text do not", wrong.length === 0, wrong.join(", "));

    const clean = sanitizeProps({
      leadId: PIETER,
      angleId: "no-cold-starts",
      channel: "email",
      count: 3,
      durationMs: 1234.5,
      ok: true,
      withName: true,
      instructionLength: 42,
      fields: ["senderName", "a@b.co", "two words", "calendlyUrl"],
      email: "pieter@example.com",
      name: "Pieter",
      notes: "Met at a conference",
      linkedinUrl: "https://www.linkedin.com/in/someone",
      companyName: "Acme",
      subject: "Hi",
      ref: "https://www.linkedin.com/in/someone",
      site: "linkedin.com/in/someone",
      domain: "abstract.inc",
      who: "pieter@example.com",
      sentence: "a long free text sentence that goes on",
      long: "x".repeat(65),
      multi: "line one\nline two",
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      nil: null,
      undef: undefined,
      obj: { a: 1 },
      $set: "x",
      $current_url: "http://evil.example",
      "bad key": "x",
    });
    const keys = Object.keys(clean).sort();
    const want = ["angleId", "channel", "count", "durationMs", "fields", "instructionLength", "leadId", "ok", "withName"].sort();
    check("sanitizeProps keeps ids, enums, counts, durations and booleans only", JSON.stringify(keys) === JSON.stringify(want), keys.join(","));
    check("sanitizeProps filters list entries", sameSet(clean.fields, ["senderName", "calendlyUrl"]), JSON.stringify(clean.fields));
    check("sanitizeProps: strings under content keys never pass, booleans and counts do", !("name" in clean) && !("email" in clean) && clean.withName === true && clean.instructionLength === 42);
    check("sanitizeProps caps the number of properties", Object.keys(sanitizeProps(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])))).length === 30);
    check("sanitizeProps never throws on junk", Object.keys(sanitizeProps(null)).length === 0 && Object.keys(sanitizeProps(undefined)).length === 0);

    // --- beforeSend: only our events and pageviews/pageleaves, no page title, no person properties
    const pageview = { uuid: "u1", event: "$pageview", properties: { title: "Pieter Abbeel · Lead Engine", $pathname: "/leads/x" }, $set: { a: 1 }, $set_once: { b: 2 } } as unknown as CaptureResult;
    const kept = beforeSend(pageview);
    check("beforeSend keeps $pageview without the page title or $set", Boolean(kept) && !("title" in (kept?.properties ?? {})) && !kept?.$set && !kept?.$set_once);
    const dropped = ["$autocapture", "$rageclick", "$dead_click", "$copy_autocapture", "$web_vitals", "$exception", "$set", "$identify", "$snapshot", "survey shown", "random_event"].filter(
      (event) => beforeSend({ uuid: "u", event, properties: {} } as unknown as CaptureResult) !== null,
    );
    check("beforeSend drops every other event (autocapture, rage clicks, web vitals, exceptions...)", dropped.length === 0, dropped.join(","));
    const ours = [...CLIENT_EVENTS, "$pageleave"].filter((event) => beforeSend({ uuid: "u", event, properties: {} } as unknown as CaptureResult) === null);
    check(`beforeSend keeps all ${CLIENT_EVENTS.length} client events and $pageleave`, ours.length === 0 && CLIENT_EVENTS.length === 19, ours.join(","));
    check("beforeSend(null) is null", beforeSend(null) === null);

    // --- init options
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
    const o = posthogInitOptions();
    const privacy =
      o.api_host === "/ingest" &&
      o.autocapture === false &&
      o.rageclick === false &&
      o.capture_dead_clicks === false &&
      o.capture_heatmaps === false &&
      o.capture_exceptions === false &&
      o.capture_performance === false &&
      o.disable_session_recording === true &&
      o.disable_surveys === true &&
      o.disable_external_dependency_loading === true &&
      o.advanced_disable_flags === true &&
      o.persistence === "localStorage" &&
      o.person_profiles === "identified_only" &&
      o.before_send === beforeSend;
    check("init: /ingest, no autocapture, recording, heatmaps, vitals, exceptions, surveys, flags; localStorage; beforeSend", privacy);
    check("init: pageviews on history change and pageleaves", o.capture_pageview === "history_change" && o.capture_pageleave === true);
    check("init: the defaults date is one posthog-js knows", (CONFIG_DEFAULTS_DATES as readonly string[]).includes(String(o.defaults)), String(o.defaults));
    check("init: ui_host is US by default", o.ui_host === "https://us.posthog.com");
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
    check("init: ui_host follows the EU region", posthogInitOptions().ui_host === "https://eu.posthog.com");
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;

    // --- region hosts
    const hostCases: [string | undefined, string, string][] = [
      [undefined, "us", "https://us.i.posthog.com"],
      ["", "us", "https://us.i.posthog.com"],
      ["https://us.i.posthog.com", "us", "https://us.i.posthog.com"],
      ["https://app.posthog.com", "us", "https://us.i.posthog.com"],
      ["https://eu.i.posthog.com", "eu", "https://eu.i.posthog.com"],
      ["https://eu.posthog.com/", "eu", "https://eu.i.posthog.com"],
      ["https://eu-assets.i.posthog.com", "eu", "https://eu.i.posthog.com"],
      ["not a url", "us", "https://us.i.posthog.com"],
      ["ftp://files.example.com", "us", "https://us.i.posthog.com"],
      ["https://ph.example.com/some/path", "custom", "https://ph.example.com"],
    ];
    const badHosts = hostCases.filter(([raw, region, api]) => {
      const h = posthogHosts(raw);
      return h.region !== region || h.api !== api;
    });
    check("posthogHosts: US default, EU supported, self-hosted origins", badHosts.length === 0, badHosts.map(([raw]) => String(raw)).join(", "));
    const eu = posthogHosts("https://eu.i.posthog.com");
    check("posthogHosts: EU assets and app hosts", eu.assets === "https://eu-assets.i.posthog.com" && eu.ui === "https://eu.posthog.com");

    // --- helpers
    const library = ANGLE_LIBRARY.map((a) => a.id);
    check("LIBRARY_ANGLE_IDS matches the angle library in abstract-context.ts", JSON.stringify([...LIBRARY_ANGLE_IDS]) === JSON.stringify(library), library.join(","));
    check(
      "angleRef: library ids pass, a repeat counts as its library id, anything else is 'custom'",
      angleRef(PIETER, "no-cold-starts", 0).angleId === "no-cold-starts" &&
        angleRef(PIETER, "drop-onboard-gpu-2", 1).angleId === "drop-onboard-gpu" &&
        angleRef(PIETER, "pieter-abbeel-covariant", 2).angleId === "custom",
    );
    const after = { ...DEFAULT_SETTINGS, senderName: "Someone", criteria: [...DEFAULT_SETTINGS.criteria, "One more"] };
    check("changedSettingsFields names the changed fields only", sameSet(changedSettingsFields(DEFAULT_SETTINGS, after), ["senderName", "criteria"]));
    check("daysFromNow", daysFromNow(new Date(Date.now() + 3 * 86_400_000).toISOString()) === 3 && daysFromNow(null) === undefined && daysFromNow("nope") === undefined);

    // --- with a key: events tracked before posthog-js is up wait, then go out with their time
    process.env.NEXT_PUBLIC_POSTHOG_KEY = FAKE_KEY;
    attachAnalytics(null);
    track("login_succeeded");
    track("email_copied", { ...angleRef(PIETER, "no-cold-starts", 0), email: "x@y.co" } as unknown as ReturnType<typeof angleRef>);
    const early = new FakeClient();
    attachAnalytics(early);
    check(
      "queued events are sent once posthog-js attaches, with their original time",
      early.calls.length === 2 && early.calls.every((c) => c.options.timestamp instanceof Date) && early.calls[0].event === "login_succeeded",
      `${early.calls.length} sent`,
    );
    check("queued events are sanitised too", early.calls[1] && !("email" in early.calls[1].props) && early.calls[1].props.angleId === "no-cold-starts");
    track("logged_out", {}, { beforeUnload: true });
    const last = early.calls.at(-1);
    check("beforeUnload events go at once with sendBeacon", last?.event === "logged_out" && last.options.transport === "sendBeacon" && last.options.send_instantly === true);

    // --- SPA pageleave
    const before = early.calls.length;
    trackNavigationStart("/pipeline", "push");
    trackNavigationStart(`/leads/${PIETER}?tab=2`, "replace");
    trackNavigationStart("/settings", "traverse");
    const leaves = early.calls.slice(before);
    check("a client-side navigation to another page sends one $pageleave (same page or back/forward: none)", leaves.length === 1 && leaves[0].event === "$pageleave", `${leaves.length}`);

    // --- draft_edited: once per angle per page view, debounced, with the fields touched
    const tracker = new DraftEditTracker(60);
    const ref = angleRef(PIETER, "no-cold-starts", 0);
    const mark = early.calls.length;
    tracker.edited("no-cold-starts", ref, "subject");
    await sleep(20);
    tracker.edited("no-cold-starts", ref, "body");
    tracker.edited("no-cold-starts", ref, "body");
    await sleep(30);
    const tooSoon = early.calls.length - mark;
    await sleep(120);
    tracker.edited("no-cold-starts", ref, "linkedin");
    await sleep(120);
    tracker.edited("gpus-for-less", angleRef(PIETER, "gpus-for-less", 1), "linkedin");
    tracker.flush();
    const drafts = early.calls.slice(mark).filter((c) => c.event === "draft_edited");
    check(
      "draft_edited: debounced, once per angle, with the fields touched; flush() sends what waits",
      tooSoon === 0 && drafts.length === 2 && sameSet(drafts[0].props.fields, ["subject", "body"]) && drafts[1].props.angleId === "gpus-for-less",
      `${drafts.length} events`,
    );

    resetAnalytics();
    check("resetAnalytics() forgets the anonymous id", early.resets === 1);
  } finally {
    attachAnalytics(null);
    delete g.window;
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  }
}

// ------------------------------------------------------------------ 2. next.config.ts

async function testConfig(): Promise<void> {
  section("2. config (next.config.ts)");
  try {
    check("skipTrailingSlashRedirect is on", nextConfig.skipTrailingSlashRedirect === true);
    check("posthog-node runs from node_modules (serverExternalPackages)", (nextConfig.serverExternalPackages ?? []).includes("posthog-node"));
    const rewrites = nextConfig.rewrites;
    if (!rewrites) {
      check("rewrites() exists", false);
      return;
    }
    const list = async () => {
      const r = await rewrites();
      return Array.isArray(r) ? r : [...(r.beforeFiles ?? []), ...(r.afterFiles ?? []), ...(r.fallback ?? [])];
    };
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    check("no key: no /ingest rewrites at all", (await list()).length === 0);
    process.env.NEXT_PUBLIC_POSTHOG_KEY = FAKE_KEY;
    for (const host of [undefined, "https://us.i.posthog.com", "https://eu.i.posthog.com", "https://eu.posthog.com", "https://ph.example.com"]) {
      if (host === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
      else process.env.NEXT_PUBLIC_POSTHOG_HOST = host;
      const h = posthogHosts(host);
      const got = (await list()).map((r) => `${r.source} -> ${r.destination}`);
      const wantList = [`/ingest/static/:path* -> ${h.assets}/static/:path*`, `/ingest/array/:path* -> ${h.assets}/array/:path*`, `/ingest/:path* -> ${h.api}/:path*`];
      check(`rewrites for ${host ?? "(unset: US)"} match posthogHosts(), assets first`, JSON.stringify(got) === JSON.stringify(wantList), got.join(" | "));
    }
  } finally {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  }
}

// ------------------------------------------------------------------ 3. server

/** Strings that must never appear in anything sent to PostHog about this lead. */
function forbiddenFor(lead: Lead | null): string[] {
  if (!lead) return [];
  const words = (lead.name ?? "").split(/\s+/).filter((w) => w.length >= 4);
  return [lead.name, ...words, lead.email, lead.linkedinUrl, lead.linkedinSlug, lead.notes?.slice(0, 40), lead.companyName, "linkedin.com/in/"].filter(
    (s): s is string => typeof s === "string" && s.length >= 4,
  );
}

function leaks(events: SeenEvent[], forbidden: string[]): string[] {
  const hits = new Set<string>();
  for (const e of events) for (const f of forbidden) if (e.raw.toLowerCase().includes(f.toLowerCase())) hits.add(`${e.event}: <${f.length} chars>`);
  return [...hits];
}

async function testServer(): Promise<void> {
  section("3. server (src/lib/analytics-server.ts)");
  const fake = await startFakePosthog();
  try {
    // --- no key: a pass-through that sends nothing
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    process.env.NEXT_PUBLIC_POSTHOG_HOST = fake.origin;
    check("no key: server analytics is off", !serverAnalyticsEnabled());
    let ran = 0;
    await trackResearchRun(PIETER, async () => {
      ran += 1;
    });
    const thrown = await trackSteerRun(PIETER, async () => {
      throw new Error("boom");
    }).then(
      () => null,
      (err: unknown) => err,
    );
    await captureServerEvent("steer_completed", { leadId: PIETER, mode: "rewrite", status: "done", ok: true, durationMs: 1, angles: 1 });
    await sleep(300);
    check("no key: the run runs, its error passes through, and nothing is sent", ran === 1 && errorText(thrown) === "boom" && fake.requests.length === 0, `${fake.requests.length} requests`);

    // --- key on, PostHog = the local fake
    process.env.NEXT_PUBLIC_POSTHOG_KEY = FAKE_KEY;
    check("with a phc_ key: server analytics is on", serverAnalyticsEnabled());
    const sample = {
      leadId: PIETER,
      status: "done",
      durationMs: 1234,
      findings: 3,
      findingsUsed: 2,
      angles: 2,
      hasBrief: true,
      costUsd: 0.0123,
      // Junk a careless caller might pass: must never be sent.
      name: "Pieter Abbeel",
      email: "pieter@example.com",
      linkedinUrl: "https://www.linkedin.com/in/someone",
      notes: "Met at a conference",
      error: "Something failed at https://api.example.com/v1",
    } as unknown as ServerEventProps["research_completed"];
    await captureServerEvent("research_completed", sample);
    const first = fake.events().at(-1);
    const req0 = fake.requests.at(-1);
    check("captureServerEvent posts one capture v1 batch to the configured host", Boolean(first) && req0?.path.startsWith("/i/v1/analytics/events") === true, req0?.path.split("?")[0]);
    check(
      "server event: fixed distinct id, no person profile",
      first?.distinctId === SERVER_DISTINCT_ID && first?.options.process_person_profile === false && first?.properties.$process_person_profile !== true,
    );
    const sp = first?.properties ?? {};
    check(
      "server event: ids, counts, durations, enums and booleans only",
      sp.leadId === PIETER && sp.durationMs === 1234 && sp.costUsd === 0.0123 && sp.hasBrief === true && !("name" in sp) && !("email" in sp) && !("linkedinUrl" in sp) && !("notes" in sp) && !("error" in sp),
      Object.keys(sp)
        .filter((k) => !k.startsWith("$"))
        .sort()
        .join(","),
    );
    check("server event: GeoIP off", sp.$geoip_disable === true);

    // --- what a steer run decided, from its own events (newest first, as listEvents returns them)
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const instruction = "Dig into their compute setup, a private instruction";
    const logged = [
      { type: "done" as const, data: { mode: "research", newFindings: 2 }, createdAt: at(5_000) },
      { type: "steer" as const, data: { instruction, mode: "research", focus: instruction }, createdAt: at(1_000) },
      { type: "done" as const, data: { mode: "rewrite", newFindings: 0 }, createdAt: at(-3_600_000) },
    ];
    const finished = steerOutcomeFrom(logged, t0);
    const failedEarly = steerOutcomeFrom(logged.slice(1), t0); // the run stopped before its "done" event
    const earlierRunOnly = steerOutcomeFrom(logged.slice(2), t0);
    check(
      "steerOutcomeFrom: mode and new findings from this run's events only",
      finished.mode === "research" && finished.newFindings === 2 && failedEarly.mode === "research" && failedEarly.newFindings === undefined && earlierRunOnly.mode === "unknown",
      JSON.stringify([finished, failedEarly, earlierRunOnly]),
    );
    check("steerOutcomeFrom never carries the instruction", !JSON.stringify([finished, failedEarly, earlierRunOnly]).includes("private instruction"));

    // --- a demo lead, read only; the "run" is a stub, so nothing is researched
    const lead = await getLead(PIETER);
    if (!lead) {
      check("demo lead found (read only)", false);
      return;
    }
    const forbidden = forbiddenFor(lead);
    const planted: SeenEvent = { source: "server", event: "x", distinctId: "", properties: {}, options: {}, raw: JSON.stringify({ title: `${lead.name} · Lead Engine` }) };
    check("the leak detector catches a planted lead name (control)", forbidden.length > 0 && leaks([planted], forbidden).length > 0, `${forbidden.length} forbidden strings`);
    let count = fake.events().length;
    await trackResearchRun(PIETER, async () => {});
    const rr = fake.events().slice(count);
    const expectEvent = lead.researchStatus === "done" ? "research_completed" : "research_failed";
    const rp = rr[0]?.properties ?? {};
    check(
      `trackResearchRun (stub run) sends ${expectEvent} with counts`,
      rr.length === 1 && rr[0].event === expectEvent && rp.status === lead.researchStatus && typeof rp.findings === "number" && rp.angles === lead.angles.length && typeof rp.durationMs === "number",
      `findings ${String(rp.findings)}, used ${String(rp.findingsUsed)}, angles ${String(rp.angles)}`,
    );
    check("research event: costUsd from the usage ledger", typeof rp.costUsd === "number", typeof rp.costUsd === "number" ? `$${rp.costUsd}` : "absent (leadCostUsd missing or failed)");

    count = fake.events().length;
    await trackSteerRun(PIETER, async () => {});
    const sr = fake.events().slice(count);
    const sprops = sr[0]?.properties ?? {};
    check(
      "trackSteerRun (stub run) sends steer_completed with a mode",
      sr.length === 1 && sr[0].event === "steer_completed" && ["rewrite", "research", "unknown"].includes(String(sprops.mode)) && sprops.ok === (lead.researchStatus === "done"),
      `mode ${String(sprops.mode)}`,
    );

    count = fake.events().length;
    const crash = await trackResearchRun(PIETER, async () => {
      throw new Error("crash test");
    }).then(
      () => null,
      (err: unknown) => err,
    );
    const crashed = await waitFor(() => fake.events().length > count, 8_000);
    const cr = fake.events().slice(count);
    check(
      "a run that throws: the error passes through, then research_failed (crashed) is sent",
      errorText(crash) === "crash test" && crashed && cr[0]?.event === "research_failed" && cr[0]?.properties.status === "crashed",
    );

    count = fake.events().length;
    await trackResearchRun(randomUUID(), async () => {});
    await sleep(500);
    check("a lead that no longer exists: nothing is sent", fake.events().length === count);

    const all = fake.events();
    const hits = leaks(all, forbidden);
    check("no name, email, LinkedIn URL, notes or company in any server event", hits.length === 0, hits.join("; "));
    const strings = all.flatMap((e) => Object.entries(e.properties).filter(([k, v]) => !k.startsWith("$") && typeof v === "string" && !isSafeToken(v)));
    check("every string property of a server event is a token", strings.length === 0, strings.map(([k]) => k).join(","));
  } finally {
    await shutdownServerAnalytics();
    await fake.close();
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  }
}

// ------------------------------------------------------------------ 4. e2e (Playwright)

const PORT = 3500;
const BASE = `http://localhost:${PORT}`;
const DESKTOP_CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// Minimal shapes of the Playwright API used here (playwright has no types in this project).
interface PwRequest {
  url(): string;
  method(): string;
  postData(): string | null;
  postDataBuffer(): Buffer | null;
  headers(): Record<string, string>;
}
interface PwRoute {
  request(): PwRequest;
  fulfill(o: { status?: number; contentType?: string; body?: string }): Promise<void>;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}
interface PwLocator {
  click(o?: { timeout?: number }): Promise<void>;
  fill(value: string, o?: { timeout?: number }): Promise<void>;
  press(key: string, o?: { timeout?: number }): Promise<void>;
  pressSequentially(text: string, o?: { delay?: number }): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  inputValue(): Promise<string>;
  check(o?: { timeout?: number }): Promise<void>;
  isEnabled(): Promise<boolean>;
  count(): Promise<number>;
  first(): PwLocator;
  locator(selector: string): PwLocator;
  waitFor(o?: { state?: "attached" | "visible"; timeout?: number }): Promise<void>;
}
interface PwPage {
  goto(url: string, o?: { timeout?: number; waitUntil?: "load" | "domcontentloaded" }): Promise<unknown>;
  locator(selector: string, o?: { hasText?: string }): PwLocator;
  getByRole(role: string, o?: { name?: string | RegExp; exact?: boolean }): PwLocator;
  getByLabel(text: string | RegExp): PwLocator;
  waitForURL(url: string | RegExp, o?: { timeout?: number }): Promise<void>;
  waitForRequest(test: (r: PwRequest) => boolean, o?: { timeout?: number }): Promise<PwRequest>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  on(event: "console", cb: (m: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", cb: (err: Error) => void): void;
  close(): Promise<void>;
}
interface PwContext {
  addInitScript(script: string): Promise<void>;
  route(url: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  on(event: "request", cb: (r: PwRequest) => void): void;
  on(event: "response", cb: (r: { url(): string; status(): number }) => void): void;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(o?: { baseURL?: string; permissions?: string[]; viewport?: { width: number; height: number }; userAgent?: string }): Promise<PwContext>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(o?: { headless?: boolean }): Promise<PwBrowser> };
}

interface DevServer {
  proc: ChildProcess;
  logs: string[];
}

function redact(line: string): string {
  return line
    .replace(/postgres(ql)?:\/\/\S+/gi, "postgres://<redacted>")
    .replace(/\b(phc|phx|phs|sk|pk|key|token)[_-][A-Za-z0-9_-]{6,}/gi, "<redacted>")
    .slice(0, 300);
}

function logTail(dev: DevServer, n = 25): string {
  return dev.logs
    .filter((l) => l.trim())
    .slice(-n)
    .map(redact)
    .join("\n");
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** The dev server running now, so an interrupted test still stops it. */
let liveDev: DevServer | null = null;

function killLiveDev(): void {
  const pid = liveDev?.proc.pid;
  if (!pid || liveDev?.proc.exitCode !== null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
process.on("exit", killLiveDev);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killLiveDev();
    process.exit(130);
  });
}

async function startDev(extraEnv: Record<string, string>): Promise<DevServer> {
  if (await portInUse(PORT)) throw new Error(`port ${PORT} is already in use`);
  // Set even when empty: next dev fills only unset variables from .env.local, so neither a real
  // PostHog key nor a team password kept there can reach these test servers.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_POSTHOG_KEY: "",
    NEXT_PUBLIC_POSTHOG_HOST: "",
    APP_PASSWORD: "",
    SESSION_SECRET: "",
    ...extraEnv,
  };
  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const dev: DevServer = { proc, logs: [] };
  liveDev = dev;
  const collect = (d: Buffer) => dev.logs.push(...String(d).split("\n"));
  proc.stdout?.on("data", collect);
  proc.stderr?.on("data", collect);
  const stop = Date.now() + 240_000;
  while (Date.now() < stop) {
    if (proc.exitCode !== null) throw new Error(`next dev exited early:\n${logTail(dev)}`);
    try {
      const res = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (res.status < 500) return dev;
    } catch {
      // Not up yet.
    }
    await sleep(1000);
  }
  await stopDev(dev);
  throw new Error(`next dev did not come up in 4 minutes:\n${logTail(dev)}`);
}

async function stopDev(dev: DevServer): Promise<void> {
  const pid = dev.proc.pid;
  if (!pid || dev.proc.exitCode !== null) {
    if (liveDev === dev) liveDev = null;
    return;
  }
  const exited = new Promise<void>((resolve) => dev.proc.once("exit", () => resolve()));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const done = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
  if (!done) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (liveDev === dev) liveDev = null;
  // Let the port and the .next/dev lock go before the next start.
  await sleep(1_500);
}

function playwright(): Playwright {
  // Installed globally (NODE_PATH), not a project dependency.
  return createRequire(__filename)("playwright") as Playwright;
}

const isPosthogHost = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === "posthog.com" || host.endsWith(".posthog.com");
  } catch {
    return false;
  }
};

/** The page an event was captured on. */
function pathOf(e: SeenEvent): string {
  if (typeof e.properties.$pathname === "string") return e.properties.$pathname;
  try {
    return new URL(String(e.properties.$current_url ?? "")).pathname;
  } catch {
    return "";
  }
}

/** Cookie names (never values) that reached the fake PostHog, from request number `from` on. */
function cookieNamesSeen(fake: FakePosthog, from = 0): string[] {
  return [...new Set(fake.requests.slice(from).flatMap((r) => r.cookieNames))].sort();
}

/** posthog-js sets this global when its module runs, so it shows whether posthog-js was loaded. */
const POSTHOG_LOADED = "typeof window.__PosthogExtensions__ !== 'undefined'";

/**
 * PostHog drops events from browsers that look automated (navigator.webdriver, a HeadlessChrome
 * user agent or brand). That filter stays on in the app; the test browser looks like a person's.
 */
const HUMAN_BROWSER =
  "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });" +
  "Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined, configurable: true });";

/** Run A: no key. Nothing analytics-related may happen. */
async function e2eWithoutKey(pw: Playwright): Promise<void> {
  section("4a. e2e without a key (next dev -p 3500)");
  let dev: DevServer | null = null;
  let browser: PwBrowser | null = null;
  try {
    dev = await startDev({});
    const ingest = await fetch(`${BASE}/ingest/e/`, { method: "GET", redirect: "manual" });
    check("no key: /ingest is not proxied (404)", ingest.status === 404, `status ${ingest.status}`);

    browser = await pw.chromium.launch();
    const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 } });
    const urls: string[] = [];
    context.on("request", (r) => urls.push(r.url()));
    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return route.abort();
      // Never write anything: this run only reads.
      if (url.pathname.startsWith("/api/") && req.method() !== "GET") return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
      return route.continue();
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (err) => problems.push(`pageerror: ${errorText(err)}`));
    page.on("console", (m) => {
      if (/posthog|analytics/i.test(m.text())) problems.push(`console ${m.type()}: ${redact(m.text())}`);
    });
    for (const path of ["/", "/pipeline", "/settings", `/leads/${PIETER}`]) {
      await page.goto(path, { timeout: 180_000 });
      await page.waitForTimeout(1_500);
    }
    await page.getByRole("button", { name: "Copy email" }).click({ timeout: 60_000 });
    await page.getByRole("link", { name: "Pipeline", exact: true }).first().click();
    await page.waitForURL(/\/pipeline$/, { timeout: 120_000 });
    await page.waitForTimeout(4_000);
    const touched = urls.filter((u) => /\/ingest(\/|$)|posthog/i.test(u));
    check("no key: no /ingest request, no posthog chunk, no posthog.com", touched.length === 0, `${urls.length} requests seen${touched.length ? `; ${touched.slice(0, 3).join(" ")}` : ""}`);
    const loaded = await page.evaluate(POSTHOG_LOADED);
    check("no key: posthog-js never ran in the browser", loaded === false, `posthog-js global ${String(loaded)}`);
    check("no key: no page errors or analytics console messages", problems.length === 0, problems.slice(0, 3).join(" | "));
    await context.close();
  } catch (err) {
    check("e2e without a key ran", false, errorText(err));
    if (dev) info(`dev server log tail:\n${logTail(dev)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dev) await stopDev(dev);
  }
}

/** Run B: a fake key. Every tracked action, every write mocked, /ingest intercepted. */
async function e2eWithKey(pw: Playwright): Promise<void> {
  section("4b. e2e with NEXT_PUBLIC_POSTHOG_KEY=phc_test_fake (next dev -p 3500)");
  const upstream = await startFakePosthog();
  let dev: DevServer | null = null;
  let browser: PwBrowser | null = null;
  try {
    dev = await startDev({ NEXT_PUBLIC_POSTHOG_KEY: FAKE_KEY, NEXT_PUBLIC_POSTHOG_HOST: upstream.origin });

    // --- the rewrites, end to end (to the local fake PostHog, not posthog.com)
    const probes: [string, string, string][] = [
      ["POST", "/ingest/e/?probe=1", "/e/?probe=1"],
      ["GET", "/ingest/static/probe.js", "/static/probe.js"],
      ["GET", "/ingest/array/phc_test_fake/config", "/array/phc_test_fake/config"],
    ];
    for (const [method, path, upstreamPath] of probes) {
      const before = upstream.requests.length;
      const res = await fetch(`${BASE}${path}`, {
        method,
        redirect: "manual",
        headers: { "content-type": "application/json", cookie: "le_session=probe-not-a-real-session" },
        body: method === "POST" ? '{"event":"probe","properties":{}}' : undefined,
      });
      const got = upstream.requests.slice(before).map((r) => r.path);
      // PostHog's documented rule (/ingest/:path* -> host/:path*) forwards "/e/" as "/e"; PostHog takes both.
      const slashless = upstreamPath.replace(/\/(\?|$)/, "$1");
      check(
        `rewrite ${method} ${path} reaches the upstream as ${slashless} (no 308)`,
        res.status === 200 && (got.includes(upstreamPath) || got.includes(slashless)),
        `status ${res.status}, upstream saw ${got.join(",") || "nothing"}`,
      );
    }
    const probeCookies = cookieNamesSeen(upstream);
    info(`the probes' cookie ${probeCookies.length ? `reached the upstream (${probeCookies.join(", ")})` : "did not reach the upstream"}`);
    upstream.requests.length = 0;

    // The routes that report research and steer runs load with posthog-node. An unknown lead: 404, no run.
    const ghost = randomUUID();
    const researchRoute = await fetch(`${BASE}/api/leads/${ghost}/research`, { method: "POST", redirect: "manual" });
    const steerRoute = await fetch(`${BASE}/api/leads/${ghost}/steer`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: "probe" }),
    });
    check(
      "the research and steer routes load with posthog-node (unknown lead: 404, no run started)",
      [404, 429].includes(researchRoute.status) && [404, 429].includes(steerRoute.status),
      `research ${researchRoute.status}, steer ${steerRoute.status}`,
    );

    // --- the demo leads as the server has them (read-only GET), for mocks and checks
    const leadRes = await fetch(`${BASE}/api/leads/${PIETER}`);
    const lead = (asRecord(await leadRes.json()).lead ?? null) as Lead | null;
    if (!lead || !Array.isArray(lead.angles) || lead.angles.length < 2) throw new Error("the demo lead did not load or has fewer than two angles");
    const leadName = lead.name ?? "";
    const second = lead.angles[1];

    // --- browser
    browser = await pw.chromium.launch();
    const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"], userAgent: DESKTOP_CHROME_UA });
    await context.addInitScript(HUMAN_BROWSER);
    const allUrls: string[] = [];
    const ingestPaths: string[] = [];
    const unexpectedWrites: string[] = [];
    const browserEvents: SeenEvent[] = [];
    const mockedWrites: string[] = [];
    context.on("request", (r) => allUrls.push(r.url()));

    const json = (status: number, data: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(data) });
    const status = json(200, {
      providers: [{ id: "hubspot", label: "HubSpot", configured: true, detail: "Mocked for the analytics test." }],
      model: { name: "claude-haiku-5-5", effort: "low" },
      authEnabled: true,
    });
    let current: Lead = lead;

    await context.route("**/*", async (route) => {
      const req = route.request();
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return route.abort();
      }
      // Nothing leaves this machine: Gmail and LinkedIn popups, and posthog.com if anything tried.
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return route.abort();
      if (url.pathname === "/ingest" || url.pathname.startsWith("/ingest/")) {
        ingestPaths.push(url.pathname);
        const body = req.postDataBuffer();
        if (body?.length) {
          const decoded = decodeBody(body, req.url(), req.headers()["content-encoding"]);
          browserEvents.push(...toEvents(decoded, "browser"));
        }
        return route.fulfill(json(200, { status: 1 }));
      }
      const method = req.method();
      if (url.pathname === "/api/status" && method === "GET") return route.fulfill(status);
      if (!url.pathname.startsWith("/api/") || method === "GET") return route.continue();

      // Every write is answered here: no lead, setting or run is touched.
      let body: Props = {};
      try {
        body = asRecord(JSON.parse(req.postData() || "{}"));
      } catch {
        // Not JSON: treated as empty.
      }
      const p = url.pathname;
      const tag = `${method} ${p.replace(PIETER, ":id")}`;
      mockedWrites.push(tag);
      if (method === "POST" && p === "/api/leads") return route.fulfill(json(201, { lead: current }));
      if (method === "PATCH" && p === `/api/leads/${PIETER}`) {
        current = { ...current, ...(body as Partial<Lead>) };
        return route.fulfill(json(200, { lead: current }));
      }
      if (method === "POST" && p === `/api/leads/${PIETER}/research`) return route.fulfill(json(202, { ok: true }));
      if (method === "POST" && p === `/api/leads/${PIETER}/steer`) return route.fulfill(json(202, { ok: true }));
      if (method === "POST" && p === `/api/leads/${PIETER}/sent`) {
        current = { ...current, stage: "contacted", lastContactedAt: new Date().toISOString() };
        return route.fulfill(json(200, { lead: current }));
      }
      if (method === "POST" && p === `/api/leads/${PIETER}/events`) return route.fulfill(json(200, { ok: true }));
      if (method === "POST" && p === `/api/leads/${PIETER}/hubspot`) return route.fulfill(json(200, { ok: true, contactId: "1" }));
      if (method === "PUT" && p === "/api/settings") return route.fulfill(json(200, { settings: { ...DEFAULT_SETTINGS, ...body } }));
      if (method === "POST" && (p === "/api/login" || p === "/api/logout")) return route.fulfill(json(200, { ok: true }));
      unexpectedWrites.push(tag);
      return route.abort();
    });

    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (err) => problems.push(`pageerror: ${errorText(err)}`));
    page.on("console", (m) => {
      if (/posthog|analytics/i.test(m.text()) && (m.type() === "error" || m.type() === "warning")) problems.push(`console ${m.type()}: ${redact(m.text())}`);
    });

    const typed = {
      newName: "Analytics Test Person",
      newUrl: "https://www.linkedin.com/in/analytics-test-person",
      newNotes: "Private note typed during the analytics test",
      steer: "Shorter please, a private instruction for the analytics test",
      owner: "Analytics Owner",
      notes: "Met at a conference, private notes text",
      draft: " qaeditmarker",
      password: "fake-password-for-the-test",
      sender: " QA-sender-marker",
    };
    const steps: [string, () => Promise<void>][] = [
      [
        "home, then Pipeline by the nav (SPA)",
        async () => {
          await page.goto("/", { timeout: 180_000 });
          await page.locator(`a[href="/leads/${PIETER}"]`).first().waitFor({ timeout: 120_000 });
          await page.getByRole("link", { name: "Pipeline", exact: true }).first().click();
          await page.waitForURL(/\/pipeline$/, { timeout: 120_000 });
        },
      ],
      [
        "pipeline: change a stage",
        async () => {
          const select = page.locator("li.card", { hasText: leadName }).locator("select");
          await select.waitFor({ timeout: 120_000 });
          const from = await select.inputValue();
          const wait = page.waitForRequest((r) => r.method() === "PATCH", { timeout: 30_000 });
          await select.selectOption(from === "nurture" ? "replied" : "nurture");
          await wait;
        },
      ],
      [
        "settings: save a changed sender name",
        async () => {
          await page.getByRole("link", { name: "Settings", exact: true }).first().click();
          await page.waitForURL(/\/settings$/, { timeout: 120_000 });
          const name = page.locator("#senderName");
          await name.waitFor({ timeout: 120_000 });
          await name.fill(`${await name.inputValue()}${typed.sender}`);
          const wait = page.waitForRequest((r) => r.method() === "PUT", { timeout: 30_000 });
          await page.getByRole("button", { name: "Save settings" }).click();
          await wait;
        },
      ],
      [
        "new lead: add one (POST mocked), land on the lead page",
        async () => {
          await page.getByRole("link", { name: /New lead/ }).first().click();
          await page.waitForURL(/\/leads\/new$/, { timeout: 120_000 });
          await page.locator("#linkedinUrl").fill(typed.newUrl, { timeout: 120_000 });
          await page.locator("#name").fill(typed.newName);
          await page.locator("#notes").fill(typed.newNotes);
          await page.getByRole("button", { name: "Add and research" }).click();
          await page.waitForURL(new RegExp(`/leads/${PIETER}$`), { timeout: 120_000 });
          await page.locator(`#angle-tab-${second.id}`).waitFor({ timeout: 120_000 });
        },
      ],
      [
        "angles: view the second angle, copy both drafts",
        async () => {
          await page.locator(`#angle-tab-${second.id}`).click();
          await page.getByRole("button", { name: "Copy email" }).click();
          await page.getByRole("button", { name: "Copy LinkedIn message" }).click();
        },
      ],
      [
        "angles: Open in Gmail, Open LinkedIn profile; header LinkedIn link",
        async () => {
          await page.getByRole("link", { name: /Open in Gmail/ }).click();
          await page.getByRole("link", { name: /Open LinkedIn profile/ }).click();
          await page.getByRole("link", { name: "LinkedIn ↗", exact: true }).click();
        },
      ],
      [
        "angles: edit subject and body (draft_edited after the pause)",
        async () => {
          const subject = page.locator("#angle-subject");
          await subject.click();
          await subject.press("End");
          await subject.pressSequentially(typed.draft, { delay: 15 });
          const body = page.locator("#angle-body");
          await body.click();
          await body.press("Control+End");
          await body.pressSequentially(typed.draft, { delay: 15 });
          await page.waitForTimeout(3_000);
        },
      ],
      [
        "findings: show filtered out",
        async () => {
          await page.getByLabel(/Show filtered out/).check();
        },
      ],
      [
        "details: follow-up date, then clear it",
        async () => {
          const date = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
          let wait = page.waitForRequest((r) => r.method() === "PATCH", { timeout: 30_000 });
          await page.locator("#nextStepAt").fill(date);
          await wait;
          wait = page.waitForRequest((r) => r.method() === "PATCH", { timeout: 30_000 });
          await page.getByRole("button", { name: "Clear", exact: true }).click();
          await wait;
        },
      ],
      [
        "details: owner and notes",
        async () => {
          let wait = page.waitForRequest((r) => r.method() === "PATCH" && (r.postData() ?? "").includes("owner"), { timeout: 30_000 });
          await page.locator("#owner").fill(typed.owner);
          await page.locator("#owner").press("Enter");
          await wait;
          wait = page.waitForRequest((r) => r.method() === "PATCH" && (r.postData() ?? "").includes("notes"), { timeout: 30_000 });
          await page.locator("#notes").fill(typed.notes);
          await page.locator("#notes").press("Tab");
          await wait;
        },
      ],
      [
        "details: stage",
        async () => {
          const wait = page.waitForRequest((r) => r.method() === "PATCH" && (r.postData() ?? "").includes("stage"), { timeout: 30_000 });
          await page.locator("#stage").selectOption(current.stage === "replied" ? "call_booked" : "replied");
          await wait;
        },
      ],
      [
        "angles: mark as sent by email",
        async () => {
          await page.getByRole("button", { name: "Mark as sent" }).click();
          const wait = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/sent"), { timeout: 30_000 });
          await page.getByRole("button", { name: "Email", exact: true }).click();
          await wait;
        },
      ],
      [
        "push to HubSpot (status mocked as configured)",
        async () => {
          const wait = page.waitForRequest((r) => r.url().endsWith("/hubspot"), { timeout: 30_000 });
          await page.getByRole("button", { name: "Push to HubSpot" }).click();
          await wait;
        },
      ],
      [
        "steer (POST mocked: no run)",
        async () => {
          await page.locator("#steer-input").fill(typed.steer);
          const wait = page.waitForRequest((r) => r.url().endsWith("/steer"), { timeout: 30_000 });
          await page.getByRole("button", { name: "Send to agent" }).click();
          await wait;
        },
      ],
      [
        "re-run research (POST mocked: no run)",
        async () => {
          const rerun = page.getByRole("button", { name: "Re-run research" });
          if (!(await waitForAsync(() => rerun.isEnabled(), 30_000))) throw new Error("Re-run research stayed disabled");
          const wait = page.waitForRequest((r) => r.url().endsWith("/research"), { timeout: 30_000 });
          await rerun.click();
          await wait;
          await page.waitForTimeout(1_500);
        },
      ],
      [
        "log out (mocked), then log in (mocked)",
        async () => {
          await page.getByRole("button", { name: "Log out" }).click();
          await page.waitForURL(/\/login$/, { timeout: 120_000 });
          await page.locator("#password").fill(typed.password, { timeout: 120_000 });
          await page.getByRole("button", { name: "Log in" }).click();
          await page.waitForURL(new RegExp(`^${BASE}/$`), { timeout: 120_000 });
          await page.locator(`a[href="/leads/${PIETER}"]`).first().waitFor({ timeout: 120_000 });
        },
      ],
    ];

    for (const [name, run] of steps) {
      try {
        await run();
        check(`step: ${name}`, true);
      } catch (err) {
        check(`step: ${name}`, false, errorText(err).split("\n")[0]);
      }
    }

    // Batches go every few seconds; then close the page (pageleave on unload).
    await page.waitForTimeout(5_000);
    // The other side of the no-key check: here posthog-js runs, from a chunk fetched on demand.
    const loaded = await page.evaluate(POSTHOG_LOADED);
    const chunks = allUrls.filter((u) => u.includes("/_next/") && /posthog/i.test(u)).length;
    check("with the key: posthog-js runs in the browser (so the no-key pass would have seen it)", loaded === true, `posthog-js global ${String(loaded)}; ${chunks} chunk URL(s) name posthog`);
    await page.close();
    await sleep(2_000);
    await context.close();

    const events = [...browserEvents, ...upstream.events()];
    info(`${events.length} events: ${browserEvents.length} intercepted in the browser, ${upstream.events().length} reached the fake upstream through the rewrite`);
    info(`ingest paths: ${[...new Set(ingestPaths)].join(", ") || "none"}; mocked writes: ${mockedWrites.length}`);

    const named = (event: string) => events.filter((e) => e.event === event);
    const pv = events.find((e) => e.event === "$pageview");
    if (pv) info(`a $pageview carries: ${Object.keys(pv.properties).sort().join(", ")}`);
    const viaUpstream = upstream.events().map((e) => e.event);
    if (viaUpstream.length) info(`through the rewrite (beacons the browser route did not catch): ${viaUpstream.join(", ")}`);
    const expectations: [string, string, (e: SeenEvent) => boolean][] = [
      ["$pageview", "home", (e) => pathOf(e) === "/"],
      ["$pageview", "pipeline (client-side navigation)", (e) => pathOf(e) === "/pipeline"],
      ["$pageview", "lead page", (e) => pathOf(e) === `/leads/${PIETER}`],
      ["$pageview", "login page", (e) => pathOf(e) === "/login"],
      ["$pageleave", "on a client-side navigation", (e) => pathOf(e) === "/pipeline" || pathOf(e) === "/"],
      ["stage_changed", "pipeline", (e) => e.properties.surface === "pipeline" && e.properties.leadId === PIETER && typeof e.properties.from === "string" && typeof e.properties.to === "string"],
      [
        "settings_saved",
        "fields, not values",
        (e) => Array.isArray(e.properties.fields) && e.properties.fields.includes("senderName") && e.properties.fieldCount === e.properties.fields.length && typeof e.properties.criteriaCount === "number",
      ],
      ["lead_created", "", (e) => e.properties.leadId === PIETER && e.properties.withName === true && e.properties.withCompany === false && e.properties.withNotes === true],
      ["angle_viewed", "", (e) => e.properties.angleId === angleRef(PIETER, second.id, 1).angleId && e.properties.angleIndex === 1 && e.properties.recommended === (second.id === lead.approach?.leadAngleId)],
      ["email_copied", "", (e) => e.properties.leadId === PIETER && e.properties.angleIndex === 1],
      ["linkedin_message_copied", "", (e) => typeof e.properties.length === "number" && typeof e.properties.overLimit === "boolean"],
      ["gmail_opened", "", (e) => e.properties.withRecipient === Boolean(lead.email)],
      ["linkedin_profile_opened", "from the angles", (e) => e.properties.from === "angles"],
      ["linkedin_profile_opened", "from the header", (e) => e.properties.from === "header"],
      ["draft_edited", "subject and body", (e) => sameSet(e.properties.fields, ["subject", "body"]) && e.properties.angleIndex === 1],
      ["findings_filter_toggled", "", (e) => e.properties.showFiltered === true && typeof e.properties.filteredOut === "number" && e.properties.leadId === PIETER],
      ["followup_set", "a date", (e) => e.properties.cleared === false && typeof e.properties.inDays === "number"],
      ["followup_set", "cleared", (e) => e.properties.cleared === true],
      ["owner_set", "", (e) => e.properties.cleared === false],
      ["notes_saved", "", (e) => e.properties.cleared === false && e.properties.length === typed.notes.length],
      ["stage_changed", "lead page", (e) => e.properties.surface === "lead"],
      ["marked_sent", "email", (e) => e.properties.channel === "email" && e.properties.leadId === PIETER],
      ["hubspot_pushed", "ok", (e) => e.properties.ok === true],
      ["steer_sent", "", (e) => e.properties.instructionLength === typed.steer.length],
      ["research_rerun", "", (e) => e.properties.hadResearch === true && e.properties.afterFailure === false],
      ["logged_out", "", () => true],
      ["login_succeeded", "", () => true],
    ];
    for (const [event, label, test] of expectations) {
      const list = named(event);
      check(`event ${event}${label ? ` (${label})` : ""}`, list.some(test), list.length ? `${list.length} seen` : "not seen");
    }
    check("draft_edited once for the edited angle", named("draft_edited").filter((e) => e.properties.angleIndex === 1).length === 1);

    const allowed = new Set<string>([...CLIENT_EVENTS, "$pageview", "$pageleave"]);
    const others = [...new Set(events.map((e) => e.event).filter((n) => !allowed.has(n)))];
    check("only our events, $pageview and $pageleave are sent", others.length === 0, others.join(","));
    check("no $pageview carries the page title (it holds the lead's name)", named("$pageview").every((e) => !("title" in e.properties)));
    const sdkKeys = new Set(["token", "distinct_id"]);
    const badProps = events
      .filter((e) => !e.event.startsWith("$"))
      .flatMap((e) =>
        Object.entries(e.properties)
          .filter(([k]) => !k.startsWith("$") && !sdkKeys.has(k))
          .filter(([, v]) => !(typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && isSafeToken(v)) || (Array.isArray(v) && v.every((x) => typeof x === "string" && isSafeToken(x)))))
          .map(([k]) => `${e.event}.${k}`),
      );
    check("our event properties are ids, counts, enums and booleans only", badProps.length === 0, [...new Set(badProps)].join(","));
    const forbidden = [
      ...forbiddenFor(lead),
      typed.newName,
      typed.newUrl,
      typed.newNotes.slice(0, 30),
      typed.steer.slice(0, 30),
      typed.owner,
      typed.notes.slice(0, 30),
      typed.draft.trim(),
      typed.password,
      typed.sender.trim(),
      second.email.subject.slice(0, 30),
      second.email.body.slice(0, 30),
      second.linkedinMessage.slice(0, 30),
    ].filter((s) => s.trim().length >= 6);
    const hits = leaks(events, forbidden);
    check("no lead name, email, LinkedIn URL, notes, draft text, instruction or password in any event", hits.length === 0, hits.slice(0, 5).join("; "));
    const keyLeaks = events.filter((e) => /phx_|phs_|sk-ant|postgres(ql)?:\/\//i.test(e.raw));
    check("no secret key or database URL in any event", keyLeaks.length === 0);

    const beforeLogout = named("email_copied")[0]?.distinctId;
    const afterLogin = named("login_succeeded")[0]?.distinctId;
    check("log out resets the anonymous id", Boolean(beforeLogout && afterLogin && beforeLogout !== afterLogin));

    const direct = allUrls.filter(isPosthogHost);
    check("the browser never called posthog.com (everything went through /ingest)", direct.length === 0, `${allUrls.length} requests seen`);
    check("only /ingest/e/ was used (no flags, remote config or extra scripts)", ingestPaths.every((p) => p === "/ingest/e/") && ingestPaths.length > 0, [...new Set(ingestPaths)].join(","));
    const upstreamNonEvents = upstream.requests.filter((r) => !/^\/e\/?(\?|$)/.test(r.path));
    check("the upstream saw event posts only", upstreamNonEvents.length === 0, upstreamNonEvents.map((r) => r.path).join(","));
    check("every write API call was mocked (no lead, setting or run touched)", unexpectedWrites.length === 0, unexpectedWrites.join(", "));
    check("no page errors or PostHog console errors", problems.length === 0, problems.slice(0, 3).join(" | "));
  } catch (err) {
    check("e2e with a key ran", false, errorText(err));
    if (dev) info(`dev server log tail:\n${logTail(dev)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dev) await stopDev(dev);
    await upstream.close();
  }
}

async function waitForAsync(test: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const stop = Date.now() + timeoutMs;
  while (Date.now() < stop) {
    if (await test().catch(() => false)) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Run C: the access gate on, with a throwaway APP_PASSWORD for this server only. The app stays
 * shut without a session; /ingest does not (the login page's own pageview must get out); a real
 * login works end to end. Names (never values) the cookies the rewrite hands on to PostHog.
 */
async function e2eGateOn(pw: Playwright): Promise<void> {
  section("4c. e2e with the access gate on (throwaway APP_PASSWORD, fake key, next dev -p 3500)");
  const upstream = await startFakePosthog();
  const password = `gate-test-${randomBytes(9).toString("hex")}`;
  let dev: DevServer | null = null;
  let browser: PwBrowser | null = null;
  try {
    dev = await startDev({
      NEXT_PUBLIC_POSTHOG_KEY: FAKE_KEY,
      NEXT_PUBLIC_POSTHOG_HOST: upstream.origin,
      APP_PASSWORD: password,
      SESSION_SECRET: randomBytes(32).toString("hex"),
    });

    const api = await fetch(`${BASE}/api/leads`, { redirect: "manual" });
    check("gate on: /api/leads without a session answers 401", api.status === 401, `status ${api.status}`);
    const home = await fetch(`${BASE}/`, { redirect: "manual" });
    check(
      "gate on: a page without a session redirects to /login",
      home.status >= 300 && home.status < 400 && /\/login/.test(home.headers.get("location") ?? ""),
      `status ${home.status}`,
    );
    const probeFrom = upstream.requests.length;
    const probe = await fetch(`${BASE}/ingest/e/?probe=gate`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: '{"event":"probe","properties":{}}',
    });
    check("gate on: /ingest without a session passes the gate to PostHog (src/proxy.ts exemption)", probe.status === 200 && upstream.requests.length > probeFrom, `status ${probe.status}`);

    browser = await pw.chromium.launch();
    const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 }, userAgent: DESKTOP_CHROME_UA });
    await context.addInitScript(HUMAN_BROWSER);
    const urls: string[] = [];
    const ingestStatuses: number[] = [];
    const refused: string[] = [];
    context.on("request", (r) => urls.push(r.url()));
    context.on("response", (r) => {
      if (r.url().includes("/ingest/")) ingestStatuses.push(r.status());
    });
    await context.route("**/*", async (route) => {
      const req = route.request();
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return route.abort();
      }
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return route.abort();
      // Reads, the login itself and /ingest reach the server; no other write may.
      if (url.pathname.startsWith("/api/") && req.method() !== "GET" && url.pathname !== "/api/login") {
        refused.push(`${req.method()} ${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (err) => problems.push(`pageerror: ${errorText(err)}`));

    await page.goto("/", { timeout: 180_000 });
    await page.waitForURL(/\/login/, { timeout: 120_000 });
    await page.locator("#password").waitFor({ timeout: 120_000 });
    const sawLogin = await waitFor(() => upstream.events().some((e) => e.event === "$pageview" && pathOf(e) === "/login"), 20_000);
    check("gate on: the login page's $pageview reaches PostHog before anyone has a session", sawLogin);
    const cookiesBeforeLogin = cookieNamesSeen(upstream);

    const loginFrom = upstream.requests.length;
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForURL(new RegExp(`^${BASE}/$`), { timeout: 120_000 });
    await page.locator(`a[href="/leads/${PIETER}"]`).first().waitFor({ timeout: 120_000 });
    const sawHome = await waitFor(() => upstream.events().some((e) => e.event === "$pageview" && pathOf(e) === "/"), 20_000);
    await page.close();
    await sleep(1_500);
    await context.close();

    const events = upstream.events();
    check(
      "gate on: a real login works; login_succeeded and the next $pageview arrive through /ingest",
      sawHome && events.some((e) => e.event === "login_succeeded"),
      `${events.length} events at the upstream`,
    );
    check(
      "gate on: no /ingest request was redirected or refused",
      ingestStatuses.length > 0 && ingestStatuses.every((s) => s === 200),
      `${ingestStatuses.length} responses: ${[...new Set(ingestStatuses)].join(",")}`,
    );
    check("gate on: the browser never called posthog.com", urls.filter(isPosthogHost).length === 0, `${urls.length} requests seen`);
    check("gate on: no write but the login reached the server", refused.length === 0, refused.join(", "));
    check("gate on: the password is in no event", leaks(events, [password]).length === 0);
    check("gate on: no page errors", problems.length === 0, problems.slice(0, 3).join(" | "));
    info(`cookies that reached PostHog before login: ${cookiesBeforeLogin.join(", ") || "none"}`);
    const cookiesAfterLogin = cookieNamesSeen(upstream, loginFrom);
    if (cookiesAfterLogin.length) {
      note(
        `after login, the /ingest rewrite hands these cookies to PostHog with every analytics request: ${cookiesAfterLogin.join(", ")}. ` +
          "PostHog needs none of them (posthog-js keeps its state in localStorage); src/proxy.ts can delete the cookie header for /ingest.",
      );
    } else {
      info("after login, no cookie reaches PostHog through /ingest");
    }
  } catch (err) {
    check("e2e with the gate on ran", false, errorText(err));
    if (dev) info(`dev server log tail:\n${logTail(dev)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (dev) await stopDev(dev);
    await upstream.close();
  }
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  // A real key or host from .env.local is never used: every section sets its own.
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  await testClient();
  await testConfig();
  await testServer();
  if (E2E_PASSES.size) {
    const pw = playwright();
    if (E2E_PASSES.has("nokey")) await e2eWithoutKey(pw);
    if (E2E_PASSES.has("key")) await e2eWithKey(pw);
    if (E2E_PASSES.has("gate")) await e2eGateOn(pw);
  } else {
    console.log("\n(e2e skipped: pass --e2e, or --e2e=nokey,key,gate, to run next dev on port 3500 with Playwright)");
  }
  console.log(`\n${passes} passed, ${failures} failed  (${Math.round((Date.now() - T0) / 1000)}s)`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`test-analytics crashed: ${errorText(err)}`);
  process.exit(1);
});
