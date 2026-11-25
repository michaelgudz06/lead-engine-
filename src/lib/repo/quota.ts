import "server-only";
import { db, query } from "../db";
import { optionalEnv, type EnvKey } from "../env";

/**
 * Daily limits on what a visitor of the open app can trigger that has no row of its own to
 * count: leads added by import, Hunter credits spent on email lookups, warm-path checks on the
 * owner's LinkedIn account, twitterapi.io credits for X follows, intro drafts (Claude calls), and
 * LinkedIn profile reads on the research account made outside a research run.
 * Each use is a row in le_quota_uses; the count over the last 24 hours and the insert run in one
 * transaction behind an advisory lock (as le_run_starts does for research runs), so a burst of
 * requests cannot get past a limit. Deleting leads does not give uses back.
 */

export type QuotaKind = "import" | "email_lookup" | "warm_path_linkedin" | "warm_path_x" | "intro_draft" | "profile_read" | "warm_path_check";

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

/**
 * Warm-path checks a day on the owner's own LinkedIn account (step 2). One check is at most 3
 * LinkedIn requests (the degree, a search for a 2nd-degree lead, the account flags once).
 */
export const DEFAULT_WARM_PATH_LINKEDIN_CHECKS_PER_DAY = 10;
/** LinkedIn checks at least this far apart, across the app (LinkedIn watches the account). */
export const WARM_PATH_LINKEDIN_MIN_GAP_MS = 120_000;
/** Dollars of twitterapi.io credits a day for X follows (cents allowed, such as 0.5). */
export const DEFAULT_WARM_PATH_X_USD_PER_DAY = 1;
/** warm_path_x rows count twitterapi.io credits: $1 is 100,000. */
export const X_CREDITS_PER_USD = 100_000;
/** Intro drafts a day, fixed: each is one Claude call, and the open app must not run them up. */
export const INTRO_DRAFTS_PER_DAY = 100;
/**
 * LinkedIn profile reads a day on the research account outside research runs, fixed: warm paths'
 * read of a lead researched before they existed, your own profile read again during a check, and
 * Read now in Settings (each about 2 LinkedIn requests; Read now can fall back to an Apify run).
 * Research runs are capped on their own and keep that account near ~100 requests a day; these
 * come on top, so the open app must not be able to loop them, whatever URL is set.
 */
export const PROFILE_READS_PER_DAY = 10;
/**
 * "Find warm paths" / "Check again" a day, fixed: a check matches the lead's LinkedIn profile
 * against your connections with no outside call, so on an open app a loop of them (changing the
 * lead's profile each time) would test any list of profiles against your network.
 */
export const WARM_PATH_CHECKS_PER_DAY = 100;

/** The env var for each kind's limit; intro drafts and profile reads have a fixed limit. */
const LIMIT_ENV: Partial<Record<QuotaKind, EnvKey>> = {
  import: "IMPORT_LIMIT_PER_DAY",
  email_lookup: "HUNTER_CREDITS_PER_DAY",
  warm_path_linkedin: "WARM_PATH_LINKEDIN_CHECKS_PER_DAY",
  warm_path_x: "WARM_PATH_X_USD_PER_DAY",
};
const DEFAULTS: Record<QuotaKind, number> = {
  import: DEFAULT_IMPORTS_PER_DAY,
  email_lookup: DEFAULT_HUNTER_CREDITS_PER_DAY,
  warm_path_linkedin: DEFAULT_WARM_PATH_LINKEDIN_CHECKS_PER_DAY,
  warm_path_x: DEFAULT_WARM_PATH_X_USD_PER_DAY,
  intro_draft: INTRO_DRAFTS_PER_DAY,
  profile_read: PROFILE_READS_PER_DAY,
  warm_path_check: WARM_PATH_CHECKS_PER_DAY,
};
/** Units per whole number in the env var: leads, Hunter half-credits, checks, twitterapi.io credits per dollar, drafts, reads. */
const UNITS_PER: Record<QuotaKind, number> = {
  import: 1,
  email_lookup: HALF_CREDITS_PER_CREDIT,
  warm_path_linkedin: 1,
  warm_path_x: X_CREDITS_PER_USD,
  intro_draft: 1,
  profile_read: 1,
  warm_path_check: 1,
};
/** Kinds whose uses must also be spaced out: no reservation within this long of the last one. */
const MIN_GAP_MS: Partial<Record<QuotaKind, number>> = { warm_path_linkedin: WARM_PATH_LINKEDIN_MIN_GAP_MS };

/** Advisory lock keys, one per kind; RUN_LOCK_KEY (src/app/api/_lib/api.ts) is 74_221_001. */
export const QUOTA_LOCK_KEYS: Record<QuotaKind, number> = {
  import: 74_221_002,
  email_lookup: 74_221_003,
  warm_path_linkedin: 74_221_004,
  warm_path_x: 74_221_005,
  intro_draft: 74_221_006,
  profile_read: 74_221_007,
  warm_path_check: 74_221_008,
};

/**
 * The limit in force, in units (leads, Hunter half-credits, checks, credits, drafts or reads): the
 * env var when it is a whole number (0 pauses), else the default. Intro drafts: always 100. Profile
 * reads: always 10.
 */
export function quotaLimit(kind: QuotaKind): number {
  const env = LIMIT_ENV[kind];
  const raw = env ? optionalEnv(env) : undefined;
  // The X budget is in dollars and may have cents ("0.5"); every other limit is a whole number.
  const n = raw && (kind === "warm_path_x" ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/).test(raw) ? Number(raw) : NaN;
  const units = Math.round(n * UNITS_PER[kind]);
  return Number.isSafeInteger(units) ? units : DEFAULTS[kind] * UNITS_PER[kind];
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

/**
 * A reservation, or why there is none: "limit" (the last 24 hours have no room; limit 0 means
 * paused) or "gap" (the kind's minimum gap since the last use has not passed; waitMs says how
 * long is left).
 */
export type QuotaReservation =
  | { ok: true; id: string; used: number; limit: number }
  | { ok: false; used: number; limit: number; reason: "limit" | "gap"; waitMs: number };

/** The minimum time between two uses of a kind (0 when it has none). */
export function quotaMinGapMs(kind: QuotaKind): number {
  return MIN_GAP_MS[kind] ?? 0;
}

/**
 * Takes `units` of the kind's daily limit when they fit, in one transaction behind the kind's
 * advisory lock. `used` is the count before this reservation. For a kind with a minimum gap
 * (warm_path_linkedin: 120 s), the last use must also be at least that old, checked under the
 * same lock; `opts.minGapMs` overrides the kind's gap. Imports reserve inside their own insert
 * (src/lib/repo/import.ts) instead.
 */
export async function reserveQuota(kind: QuotaKind, units = 1, leadId: string | null = null, opts: { minGapMs?: number } = {}): Promise<QuotaReservation> {
  const limit = quotaLimit(kind);
  const gapMs = Math.max(0, opts.minGapMs ?? quotaMinGapMs(kind));
  const sql = db();
  const [, rows] = await sql.transaction([
    sql.query(`select pg_advisory_xact_lock(${QUOTA_LOCK_KEYS[kind]})`),
    sql.query(
      `with used as (
         select coalesce(sum(units), 0)::bigint as n,
                max(created_at) as last_at
           from le_quota_uses
          where kind = $1 and created_at > now() - interval '24 hours'
       ), gap as (
         select case when $5::double precision > 0 and last_at is not null
                     then greatest(0, $5::double precision - extract(epoch from (now() - last_at)) * 1000)
                     else 0 end as wait_ms
           from used
       ), taken as (
         insert into le_quota_uses (kind, units, lead_id)
         select $1, $2::int, $3::uuid from used, gap where used.n + $2::bigint <= $4::bigint and gap.wait_ms = 0
         returning id
       )
       select (select id::text from taken) as id, (select n from used) as used, (select wait_ms from gap) as wait_ms`,
      [kind, units, leadId, limit, gapMs],
    ),
  ]);
  const row = (rows as Array<{ id: string | null; used: string | number; wait_ms: string | number | null }>)[0];
  const used = Number(row?.used ?? 0);
  if (row?.id) return { ok: true, id: row.id, used, limit };
  const waitMs = Math.ceil(Number(row?.wait_ms ?? 0));
  const fits = used + units <= limit;
  return { ok: false, used, limit, reason: fits && waitMs > 0 ? "gap" : "limit", waitMs: fits ? waitMs : 0 };
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
/** "$1", "$0.50". */
const usdText = (n: number) => (Number.isInteger(n) ? `$${count(n)}` : `$${n.toFixed(2)}`);

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

/** Dollars from warm_path_x units: 1, 0.18. */
export function xBudgetUsd(units: number): number {
  return Math.round((units / X_CREDITS_PER_USD) * 100) / 100;
}

/** The 429 message when intro drafts are over their daily limit. */
export function introDraftLimitMessage(): string {
  return `The limit of ${count(INTRO_DRAFTS_PER_DAY)} intro drafts a day has been reached. Try again later.`;
}

/** The 429 message when warm-path checks from the lead page are over their daily limit. */
export function warmPathCheckLimitMessage(): string {
  return `The limit of ${count(WARM_PATH_CHECKS_PER_DAY)} warm-path checks a day has been reached. Try again later.`;
}

/** The 429 message when LinkedIn profile reads outside research runs are over their daily limit. */
export function profileReadLimitMessage(): string {
  return `The limit of ${count(PROFILE_READS_PER_DAY)} LinkedIn profile reads a day has been reached. Try again later.`;
}

/**
 * The 429 message when every live warm-path source that is set up is over its daily budget
 * (POST /api/leads/[id]/paths answers it with { code: "warm_path_budget" }).
 */
export function warmPathBudgetMessage(input: { linkedin?: { limit: number } | null; x?: { limit: number } | null }): string {
  const parts: string[] = [];
  if (input.linkedin) parts.push(input.linkedin.limit === 0 ? "LinkedIn checks are paused (WARM_PATH_LINKEDIN_CHECKS_PER_DAY is 0)" : `today's ${count(input.linkedin.limit)} LinkedIn checks are used up`);
  if (input.x) parts.push(input.x.limit === 0 ? "X checks are paused (WARM_PATH_X_USD_PER_DAY is 0)" : `today's X budget (${usdText(xBudgetUsd(input.x.limit))}) is used up`);
  const what = parts.length ? `${parts.join(", and ")}.` : "today's warm-path budgets are used up.";
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} The free part was still checked. Try again tomorrow.`;
}
