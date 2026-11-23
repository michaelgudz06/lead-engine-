import "server-only";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { db, query } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { addEvent } from "@/lib/repo/events";
import { claimResearch, failStaleResearch, finishResearch } from "@/lib/repo/leads";
import type { Lead } from "@/lib/types";

/**
 * Shared plumbing for the route handlers in src/app/api. The leading underscore
 * makes `_lib` a private folder, so nothing here becomes a route.
 *
 * Conventions (BUILD_SPEC section 7): JSON everywhere, errors as `{ error }` with a
 * 4xx/5xx status, bodies validated with zod, and never a stack trace in a reply.
 */

/** Every reply is live, per-lead data: no browser or CDN may cache it. */
const NO_STORE = { "cache-control": "no-store" } as const;

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

/** The error reply: `{ error }` plus optional extra fields (e.g. existingId on a 409). */
export function fail(status: number, error: string, extra?: Record<string, unknown>): NextResponse {
  return json({ ...extra, error }, status);
}

export function leadNotFound(): NextResponse {
  return fail(404, "Lead not found.");
}

// ------------------------------------------------------------------ request bodies

/** Far above any real body here (a full set of edited angles is a few KB). */
const MAX_BODY_BYTES = 512 * 1024;

export type BodyResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** `path: message` for the first few zod issues, e.g. "stage: Invalid option: expected one of ...". */
export function describeIssues(issues: z.ZodError["issues"]): string {
  const parts = issues.slice(0, 3).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return parts.join("; ") || "The request body is not valid.";
}

/**
 * Reads and validates a JSON body. An empty body counts as `{}`, so endpoints
 * whose fields are all optional accept a bare POST.
 */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<BodyResult<z.output<S>>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: fail(413, "The request body is too large.") };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: fail(400, "Could not read the request body.") };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: fail(413, "The request body is too large.") };
  // A cross-site form or no-cors fetch can only send "simple" types such as text/plain;
  // requiring JSON refuses those even where the proxy's Origin check cannot see them.
  if (text.trim() && !/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return { ok: false, response: fail(415, "Send the body as JSON (content-type: application/json).") };
  }
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: fail(400, "The request body is not valid JSON.") };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: fail(400, describeIssues(parsed.error.issues)) };
  return { ok: true, data: parsed.data };
}

// ------------------------------------------------------------------ shared field schemas

const EMAIL_RE = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;

export function isEmail(value: string): boolean {
  return value.length <= 320 && EMAIL_RE.test(value);
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Optional text field: trimmed; "" and null both mean "clear it" (null). */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Keep it under ${max.toLocaleString("en-US")} characters.`)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));
}

/** Optional email field: trimmed; "" and null clear it. */
export function optionalEmail() {
  return z
    .string()
    .trim()
    .refine((v) => v === "" || isEmail(v), "Enter a valid email address.")
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));
}

/** Drops keys whose value is undefined, so a patch only carries what the client sent. */
export function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ------------------------------------------------------------------ route params

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LeadRouteContext = { params: Promise<{ id: string }> };

/**
 * The lead id from `/api/leads/[id]/...`, or null when it is not a UUID. Checking
 * here turns a malformed id into a clean 404 instead of a Postgres cast error.
 */
export async function leadIdFrom(ctx: LeadRouteContext): Promise<string | null> {
  const { id } = await ctx.params;
  return typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null;
}

// ------------------------------------------------------------------ errors

/** The Postgres SQLSTATE of a Neon driver error, e.g. "23505" (unique) or "23503" (foreign key). */
export function pgCode(err: unknown): string | undefined {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A missing env var is safe and useful to show (it names the variable, never its
 * value). Anything else stays in the server log.
 */
function publicMessage(message: string): string | null {
  const missing = /^([A-Z][A-Z0-9_]+) is not set\b/.exec(message);
  return missing ? `The server is not fully configured: ${missing[1]} is not set.` : null;
}

/** 500 reply for an unexpected failure. The details go to the server log only. */
export function serverError(where: string, err: unknown): NextResponse {
  const message = errorText(err);
  console.error(`[api] ${where} failed: ${err instanceof Error && err.stack ? err.stack : message}`);
  return fail(500, publicMessage(message) ?? "Something went wrong on the server. Please try again.");
}

// ------------------------------------------------------------------ helpers

/** The lead that already owns a LinkedIn slug, used when two creates race past the duplicate check. */
export async function leadIdBySlug(slug: string | null): Promise<string | null> {
  if (!slug) return null;
  const rows = await query<{ id: string }>("select id from le_leads where linkedin_slug = $1 limit 1", [slug]);
  return rows[0]?.id ?? null;
}

// ------------------------------------------------------------------ research run limits

/** Research and steer runs (paid Claude and provider calls) allowed per rolling hour, across all leads. */
export const DEFAULT_RUNS_PER_HOUR = 20;
/**
 * Runs allowed per rolling 24 hours. A research run reads LinkedIn 4 times (account check,
 * profile, posts, company), so 25 runs stay near 100 LinkedIn reads a day
 * (LINKEDIN_DAILY_GUIDANCE), and cost about $4 at roughly $0.15 a run.
 */
export const DEFAULT_RUNS_PER_DAY = 25;

export interface RunLimits {
  perHour: number;
  perDay: number;
}

/** Which cap refused a run: the last hour, the last 24 hours, or both at once. */
export type RunWindow = "hour" | "day" | "both";

/** A whole number of 0 or more (0 pauses runs), else the fallback. */
function wholeNumber(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}

/**
 * The caps in force: RUN_LIMIT_PER_HOUR and RUN_LIMIT_PER_DAY when set to a whole number
 * (0 pauses all runs; new leads are still saved), else the defaults.
 */
export function runLimits(): RunLimits {
  return {
    perHour: wholeNumber(optionalEnv("RUN_LIMIT_PER_HOUR"), DEFAULT_RUNS_PER_HOUR),
    perDay: wholeNumber(optionalEnv("RUN_LIMIT_PER_DAY"), DEFAULT_RUNS_PER_DAY),
  };
}

/** A limit set to 0 is a pause, not a busy hour: waiting will not help, so say so. */
function paused(window: RunWindow, limits: RunLimits): boolean {
  return (window !== "day" && limits.perHour === 0) || (window !== "hour" && limits.perDay === 0);
}

/** The 429 message for a full window. */
export function runLimitMessage(window: RunWindow, limits: RunLimits): string {
  if (paused(window, limits)) return "Research runs are paused on this server (a run limit is set to 0).";
  if (window === "both") {
    return `Too many research runs in the last hour and the last 24 hours (the limits are ${limits.perHour} and ${limits.perDay}). Try again later.`;
  }
  return window === "hour"
    ? `Too many research runs in the last hour (the limit is ${limits.perHour}). Try again later.`
    : `Too many research runs in the last 24 hours (the limit is ${limits.perDay}). Try again later.`;
}

/** Why a new lead was saved without a run, for its activity log. */
export function runLimitEvent(window: RunWindow, limits: RunLimits): string {
  if (paused(window, limits)) return "Research did not start: research runs are paused on this server. Run it from this page later.";
  const hour = `${limits.perHour} research runs an hour`;
  const day = `${limits.perDay} research runs a day`;
  const limit = window === "both" ? `limits of ${hour} and ${day} were` : `limit of ${window === "hour" ? hour : day} was`;
  return `Research did not start: the ${limit} reached. Run it from this page later.`;
}

/** Any fixed number, the same everywhere: the advisory lock that puts reservations in a queue. */
const RUN_LOCK_KEY = 74_221_001;

export type RunReservation = { ok: true; id: string } | { ok: false; window: RunWindow; limits: RunLimits };

/**
 * Takes one run slot when both the last hour and the last 24 hours are under their caps.
 * The count and the insert run in one transaction behind an advisory lock, so any number
 * of simultaneous requests, on any number of instances, cannot start more runs than the
 * caps allow. The rows have no foreign key: deleting leads does not give runs back.
 * Routes call startRun(), which pairs this with the lead's claim.
 */
export async function reserveRun(leadId: string, kind: "research" | "steer"): Promise<RunReservation> {
  const limits = runLimits();
  const sql = db();
  const [, rows] = await sql.transaction([
    sql.query(`select pg_advisory_xact_lock(${RUN_LOCK_KEY})`),
    sql.query(
      `with counts as (
         select count(*) filter (where created_at > now() - interval '1 hour')::int as hour,
                count(*)::int as day
           from le_run_starts
          where created_at > now() - interval '24 hours'
       ), taken as (
         insert into le_run_starts (lead_id, kind)
         select $1::uuid, $2::text from counts where hour < $3::bigint and day < $4::bigint
         returning id
       )
       select (select id::text from taken) as id, hour, day from counts`,
      [leadId, kind, limits.perHour, limits.perDay],
    ),
  ]);
  const row = (rows as Array<{ id: string | null; hour: number; day: number }>)[0];
  if (row?.id) return { ok: true, id: row.id };
  const hourFull = (row?.hour ?? 0) >= limits.perHour;
  const dayFull = (row?.day ?? 0) >= limits.perDay;
  return { ok: false, window: hourFull && dayFull ? "both" : hourFull ? "hour" : "day", limits };
}

/** Gives a slot back when its run did not start after all (the lead was busy or gone). Never throws. */
export async function releaseRun(id: string): Promise<void> {
  try {
    await query("delete from le_run_starts where id = $1", [id]);
  } catch (err) {
    console.error(`[api] could not release run slot ${id}: ${errorText(err)}`);
  }
}

export type RunStart =
  | { ok: true }
  | { ok: false; reason: "limit"; window: RunWindow; limits: RunLimits }
  | { ok: false; reason: "busy" };

/**
 * Everything a route does before it hands a run to after(): take a slot under the caps,
 * then claim the lead (claimResearch, one atomic UPDATE). When the claim fails or throws,
 * the slot goes back, so only runs that really start count toward the caps.
 * "busy" means a run is already going on the lead, or the lead does not exist.
 */
export async function startRun(leadId: string, kind: "research" | "steer"): Promise<RunStart> {
  const slot = await reserveRun(leadId, kind);
  if (!slot.ok) return { ok: false, reason: "limit", window: slot.window, limits: slot.limits };
  let claimed = false;
  try {
    claimed = await claimResearch(leadId);
  } finally {
    if (!claimed) await releaseRun(slot.id);
  }
  return claimed ? { ok: true } : { ok: false, reason: "busy" };
}

/**
 * A run still 'running' after this long was lost. On Vercel a run cannot outlive its
 * 300 s function (after() dies with it): it was killed at maxDuration, crashed or was
 * redeployed. Without this the lead page would poll and keep Re-run disabled forever.
 */
export const STALE_RUN_MS = 6 * 60_000;

const STALE_RUN_MESSAGE = "Research stopped before it finished (server time limit or restart). Run it again.";

export function isStaleRun(lead: Pick<Lead, "researchStatus" | "researchStartedAt">): boolean {
  if (lead.researchStatus !== "running" || !lead.researchStartedAt) return false;
  const started = Date.parse(lead.researchStartedAt);
  return Number.isFinite(started) && Date.now() - started > STALE_RUN_MS;
}

/**
 * Marks a lost run as failed and logs an error event, so the UI stops polling and
 * claimResearch accepts a retry at once. True when it did. Never throws: a GET that
 * calls this still answers with the lead as stored.
 */
export async function failStaleRun(id: string): Promise<boolean> {
  try {
    if (!(await failStaleResearch(id, STALE_RUN_MS, STALE_RUN_MESSAGE))) return false;
  } catch (err) {
    console.error(`[api] could not mark the lost run of lead ${id} as failed: ${errorText(err)}`);
    return false;
  }
  await addEvent(id, "error", STALE_RUN_MESSAGE).catch((err) =>
    console.error(`[api] could not log the lost run of lead ${id}: ${errorText(err)}`),
  );
  return true;
}

/**
 * Runs a research entry point after the response is sent (next/server `after`).
 * runResearch and steerLead promise never to throw; this is the safety net that
 * records an unexpected failure so the lead does not stay "running" until the
 * 15-minute claim expires.
 */
export function runAfterResponse(leadId: string, label: string, task: () => Promise<void>): void {
  after(async () => {
    try {
      await task();
    } catch (err) {
      const message = errorText(err).slice(0, 400);
      console.error(`[api] ${label} for lead ${leadId} crashed: ${err instanceof Error && err.stack ? err.stack : message}`);
      try {
        await finishResearch(leadId, "error", `${label} stopped unexpectedly: ${message}`);
        await addEvent(leadId, "error", `${label} stopped unexpectedly: ${message}`);
      } catch (inner) {
        console.error(`[api] could not record the failure for lead ${leadId}: ${errorText(inner)}`);
      }
    }
  });
}
