import "server-only";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { addEvent } from "@/lib/repo/events";
import { finishResearch } from "@/lib/repo/leads";

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
