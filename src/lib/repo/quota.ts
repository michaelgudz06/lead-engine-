import "server-only";
import { db, query } from "../db";
import { optionalEnv, type EnvKey } from "../env";

/**
 * Daily limits on what a visitor of the open app can trigger that has no row of its own to
 * count: leads added by import, and Hunter credits spent on email lookups. Each use is a row in
 * le_quota_uses; the count over the last 24 hours and the insert run in one transaction behind
 * an advisory lock (as le_run_starts does for research runs), so a burst of requests cannot
 * get past a limit. Deleting leads does not give uses back.
 */

export type QuotaKind = "import" | "email_lookup";

/** New leads per rolling 24 hours, across the app, from imports. */
export const DEFAULT_IMPORTS_PER_DAY = 2_000;
/**
 * Hunter credits per rolling 24 hours, across the app. "Find email" on the lead page and
 * research's email step share it. The free plan has 50 credits a month, so one visitor of the
 * open app cannot spend the month in a day.
 */
export const DEFAULT_HUNTER_CREDITS_PER_DAY = 10;
/** email_lookup rows count half-credits: Hunter's smallest charge is 0.5 (the verifier). */
export const HALF_CREDITS_PER_CREDIT = 2;
/**
 * The most one lookup can use, in half-credits: 1.5 credits. The Email Finder costs 1 when it
 * finds an address and nothing runs after it; otherwise Domain Search (1) and the verifier (0.5).
 */
export const LOOKUP_MAX_UNITS = 3;

const LIMIT_ENV: Record<QuotaKind, EnvKey> = { import: "IMPORT_LIMIT_PER_DAY", email_lookup: "HUNTER_CREDITS_PER_DAY" };
const DEFAULTS: Record<QuotaKind, number> = { import: DEFAULT_IMPORTS_PER_DAY, email_lookup: DEFAULT_HUNTER_CREDITS_PER_DAY };
/** Units per whole number in the env var: leads for imports, half-credits for Hunter. */
const UNITS_PER: Record<QuotaKind, number> = { import: 1, email_lookup: HALF_CREDITS_PER_CREDIT };

/** Advisory lock keys, one per kind; RUN_LOCK_KEY (src/app/api/_lib/api.ts) is 74_221_001. */
export const QUOTA_LOCK_KEYS: Record<QuotaKind, number> = { import: 74_221_002, email_lookup: 74_221_003 };

/**
 * The limit in force, in units (leads, or Hunter half-credits): the env var when it is a whole
 * number (0 pauses), else the default.
 */
export function quotaLimit(kind: QuotaKind): number {
  const raw = optionalEnv(LIMIT_ENV[kind]);
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return (Number.isSafeInteger(n) ? n : DEFAULTS[kind]) * UNITS_PER[kind];
}

/** Hunter credits as email_lookup units, rounded up to the next half-credit. */
export function creditUnits(credits: number | null | undefined): number {
  const c = Number(credits);
  return Number.isFinite(c) && c > 0 ? Math.ceil(c * HALF_CREDITS_PER_CREDIT) : 0;
}

/** Units used in the last 24 hours. */
export async function quotaUsed(kind: QuotaKind): Promise<number> {
  const rows = await query<{ n: string | number }>(
    "select coalesce(sum(units), 0)::bigint as n from le_quota_uses where kind = $1 and created_at > now() - interval '24 hours'",
    [kind],
  );
  return Number(rows[0]?.n ?? 0);
}

export type QuotaReservation = { ok: true; id: string; used: number; limit: number } | { ok: false; used: number; limit: number };

/**
 * Takes `units` of the kind's daily limit when they fit, in one transaction behind the kind's
 * advisory lock. `used` is the count before this reservation. Imports reserve inside their own
 * insert (src/lib/repo/import.ts) instead.
 */
export async function reserveQuota(kind: QuotaKind, units = 1, leadId: string | null = null): Promise<QuotaReservation> {
  const limit = quotaLimit(kind);
  const sql = db();
  const [, rows] = await sql.transaction([
    sql.query(`select pg_advisory_xact_lock(${QUOTA_LOCK_KEYS[kind]})`),
    sql.query(
      `with used as (
         select coalesce(sum(units), 0)::bigint as n from le_quota_uses
          where kind = $1 and created_at > now() - interval '24 hours'
       ), taken as (
         insert into le_quota_uses (kind, units, lead_id)
         select $1, $2::int, $3::uuid from used where n + $2::bigint <= $4::bigint
         returning id
       )
       select (select id::text from taken) as id, (select n from used) as used`,
      [kind, units, leadId, limit],
    ),
  ]);
  const row = (rows as Array<{ id: string | null; used: string | number }>)[0];
  const used = Number(row?.used ?? 0);
  return row?.id ? { ok: true, id: row.id, used, limit } : { ok: false, used, limit };
}

/** Gives a reservation back when the work it was for did not happen. Never throws. */
export async function releaseQuota(id: string): Promise<void> {
  try {
    await query("delete from le_quota_uses where id = $1", [id]);
  } catch (err) {
    console.error(`[quota] could not release ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Sets a reservation to what the work really used, once that is known: a lookup reserves the
 * most it can cost, then keeps only the credits Hunter charged. At 0 the row is given back.
 * Never throws.
 */
export async function settleQuota(id: string, units: number): Promise<void> {
  if (!(units > 0)) return releaseQuota(id);
  try {
    await query("update le_quota_uses set units = $2::int where id = $1", [id, Math.ceil(units)]);
  } catch (err) {
    console.error(`[quota] could not settle ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const count = (n: number) => n.toLocaleString("en-US");

/** The 429 message when an import would pass the daily limit. */
export function importLimitMessage(input: { limit: number; used: number; wanted: number }): string {
  if (input.limit === 0) return "Imports are paused on this server (the import limit is set to 0).";
  const left = Math.max(0, input.limit - input.used);
  if (left === 0) return `The import limit of ${count(input.limit)} new leads a day has been reached. Try again later.`;
  return `This import would add ${count(input.wanted)} new leads, but only ${count(left)} more can be imported in the next 24 hours (the limit is ${count(input.limit)} a day). Import fewer rows, or try again later.`;
}

/** Half-credits as credits for a message: "10", "7.5". */
const credits = (units: number) => (units / HALF_CREDITS_PER_CREDIT).toLocaleString("en-US", { maximumFractionDigits: 1 });

/** The 429 message when the last 24 hours' Hunter credits leave no room for another lookup. */
export function emailLookupLimitMessage(limit: number): string {
  if (limit === 0) return "Email lookups are paused on this server (HUNTER_CREDITS_PER_DAY is set to 0).";
  return `The Hunter budget of ${credits(limit)} credits a day is used up. Try again later.`;
}
