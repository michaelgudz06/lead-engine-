import "server-only";
import { json, query } from "../db";
import type { NetworkDistance } from "../providers/linkedin";
import { CHECK_STALE_MS, type WarmPath, type WarmPathSetup, type WarmPathsStatus, type WarmPathSource, type WarmPathSummary, type WarmPathTarget } from "../paths/types";

/**
 * le_warm_paths (migration 007): one row per lead with the lead's side (target), the cached live
 * checks, the computed paths, and the intro drafts and "asked" dates by path id. le_leads.warm_path
 * carries the list summary and is written in the same statement as the paths.
 */

/** The owner's LinkedIn account's view of the lead (step 2), kept 30 days. */
export interface LinkedinLive {
  /** The lead's member id the check was made for: a different one makes this stale. */
  memberId: string | null;
  distance: NetworkDistance | null;
  sharedCount: number | null;
  /** Shared connections in LinkedIn's order, up to 10. Empty unless `verified`. */
  mutuals: Array<{ memberId: string | null; slug: string | null; name: string; headline: string | null; url: string | null; company: string | null; role: string | null }>;
  /** paging.total_count of the search. */
  total: number | null;
  form: "classic" | "url" | null;
  /** The shared-connections search was sent and failed (an error or a timeout): kept for an hour only. */
  searchFailed?: boolean;
  /** The search passed every safety check; when false, `reason` says which failed and the panel shows the link. */
  verified: boolean;
  reason: string | null;
  checkedAt: string;
}

/** The lead's side on X, kept 7 days. The lead's own lists are never stored, only this. */
export interface XLive {
  /** The lead's handle and your handle when it was checked: either changing makes this stale. */
  handle: string;
  ownHandle: string;
  userId: string | null;
  protected: boolean;
  unavailable: boolean;
  notFound: boolean;
  /** The lead's counts. */
  following: number | null;
  followers: number | null;
  /** How many of the lead's follows were read (the newest, up to 5,000). */
  followingRead: number;
  /** How "does the connector follow the lead" was answered: the lead's follower ids, follow checks, or not at all. */
  followsLeadBy: "ids" | "checks" | "none";
  /** You and the lead. */
  you: { youFollow: boolean; followsYou: boolean };
  /** People the lead follows who are in your lists, best first, up to 30. */
  connectors: Array<{
    id: string;
    handle: string;
    name: string | null;
    followers: number | null;
    youFollow: boolean;
    followsYou: boolean;
    /** null when it was not checked. */
    followsLead: boolean | null;
    /** Your LinkedIn connection this account is (same name, and the X bio names their slug or company). */
    linkedinSlug: string | null;
  }>;
  /** Time ran out, or a page failed: what was read is used. */
  partial: boolean;
  credits: number;
  costUsd: number;
  ownFollowing: number;
  ownFollowers: number;
  checkedAt: string;
}

export interface IntroEntry {
  introDraft: { message: string; createdAt: string } | null;
  askedAt: string | null;
}

export interface WarmPathRow {
  leadId: string;
  status: WarmPathsStatus;
  target: WarmPathTarget | null;
  linkedinLive: LinkedinLive | null;
  xLive: XLive | null;
  paths: WarmPath[];
  companyPaths: WarmPath[];
  sources: WarmPathSource[];
  /** Which of your sources were set up when the paths were computed; null before the first computation. */
  setup: WarmPathSetup | null;
  intros: Record<string, IntroEntry>;
  error: string | null;
  startedAt: string | null;
  computedAt: string | null;
  updatedAt: string;
  /**
   * The row's version as read (Postgres xmin): every write changes it. The free recompute saves
   * only while it is unchanged, so it never overwrites a newer check, a recompute that won the race,
   * or a handle typed in meanwhile. Set by getWarmPathRow; absent on rows from a RETURNING clause.
   */
  version?: string | null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function toRow(r: Record<string, unknown>): WarmPathRow {
  const status = r.status === "running" || r.status === "done" || r.status === "error" ? r.status : "idle";
  return {
    leadId: String(r.lead_id),
    status,
    target: isObj(r.target) ? (r.target as unknown as WarmPathTarget) : null,
    linkedinLive: isObj(r.linkedin_live) ? (r.linkedin_live as unknown as LinkedinLive) : null,
    xLive: isObj(r.x_live) ? (r.x_live as unknown as XLive) : null,
    paths: list<WarmPath>(r.paths),
    companyPaths: list<WarmPath>(r.company_paths),
    sources: list<WarmPathSource>(r.sources),
    setup: isObj(r.setup) ? (r.setup as unknown as WarmPathSetup) : null,
    intros: isObj(r.intros) ? (r.intros as Record<string, IntroEntry>) : {},
    error: r.error == null ? null : String(r.error),
    startedAt: iso(r.started_at),
    computedAt: iso(r.computed_at),
    updatedAt: iso(r.updated_at) ?? new Date(0).toISOString(),
    ...(r.row_version == null ? {} : { version: String(r.row_version) }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getWarmPathRow(leadId: string): Promise<WarmPathRow | null> {
  if (!UUID.test(leadId)) return null;
  const rows = await query("select *, xmin::text as row_version from le_warm_paths where lead_id = $1", [leadId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Postgres foreign_key_violation (the lead was deleted). */
const isFkViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23503";

/**
 * Marks a check as running, unless one is already running (one started more than `staleMs` ago
 * counts as lost). True when this caller got it; it must end with saveWarmPathResult or
 * releaseWarmPathCheck. False too when the lead is gone.
 */
export async function claimWarmPathCheck(leadId: string, staleMs: number = CHECK_STALE_MS): Promise<boolean> {
  try {
    const rows = await query(
      `insert into le_warm_paths (lead_id, status, started_at, updated_at) values ($1, 'running', now(), now())
       on conflict (lead_id) do update set status = 'running', started_at = now(), error = null, updated_at = now()
        where le_warm_paths.status <> 'running' or le_warm_paths.started_at is null
           or le_warm_paths.started_at < now() - make_interval(secs => $2::double precision)
       returning lead_id`,
      [leadId, staleMs / 1000],
    );
    return rows.length > 0;
  } catch (err) {
    if (isFkViolation(err)) return false;
    throw err;
  }
}

/** Ends a claimed check that wrote nothing: back to done (or idle when it was never checked). Never throws. */
export async function releaseWarmPathCheck(leadId: string): Promise<void> {
  try {
    await query(
      `update le_warm_paths set status = case when computed_at is null then 'idle' else 'done' end, updated_at = now()
        where lead_id = $1 and status = 'running'`,
      [leadId],
    );
  } catch (err) {
    console.error(`[paths] could not release the check of lead ${leadId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  }
}

/** Marks a claimed check as failed, keeping the paths it had. Never throws. */
export async function failWarmPathCheck(leadId: string, error: string): Promise<void> {
  try {
    await query("update le_warm_paths set status = 'error', error = $2, updated_at = now() where lead_id = $1", [leadId, error.slice(0, 500)]);
  } catch (err) {
    console.error(`[paths] could not record the failed check of lead ${leadId}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
  }
}

/** Stores the lead's side (a run captured it, or the owner typed an Instagram handle), creating the row when needed. */
export async function saveWarmPathTarget(leadId: string, target: WarmPathTarget): Promise<void> {
  try {
    await query(
      `insert into le_warm_paths (lead_id, target, updated_at) values ($1, $2::jsonb, now())
       on conflict (lead_id) do update set target = excluded.target, updated_at = now()`,
      [leadId, json(target)],
    );
  } catch (err) {
    if (isFkViolation(err)) return;
    throw err;
  }
}

export interface WarmPathResult {
  status: "done" | "error";
  target: WarmPathTarget | null;
  linkedinLive: LinkedinLive | null;
  xLive: XLive | null;
  paths: WarmPath[];
  companyPaths: WarmPath[];
  sources: WarmPathSource[];
  error: string | null;
  /** le_leads.warm_path. */
  summary: WarmPathSummary | null;
  /** Which of your sources were set up for this computation (a change makes the paths stale). */
  setup?: WarmPathSetup | null;
}

export interface SaveWarmPathOptions {
  /** The free recompute (which holds no claim): write nothing while a check is running. */
  onlyIfIdle?: boolean;
  /**
   * Update the row only, never create it: a check that claimed the row, or the free recompute. A
   * row deleted meanwhile (the lead got another LinkedIn profile) then stays deleted instead of
   * coming back with the old person's data.
   */
  updateOnly?: boolean;
  /** Write only while the row is still the version read (WarmPathRow.version). Implies updateOnly. */
  ifVersion?: string | null;
  /** Create the row only, never overwrite one (a check that claimed it meanwhile wins). */
  insertOnly?: boolean;
}

/**
 * Writes a check's result and the lead's list summary in one statement. True when written. With
 * `onlyIfIdle`, nothing is written while a check runs; with `updateOnly` or `ifVersion`, a missing
 * row is not created, and with `ifVersion` a row written since it was read is left alone; with
 * `insertOnly`, an existing row is left alone.
 */
export async function saveWarmPathResult(leadId: string, r: WarmPathResult, opts: SaveWarmPathOptions = {}): Promise<boolean> {
  const params: unknown[] = [
    leadId,
    r.status,
    json(r.target),
    json(r.linkedinLive),
    json(r.xLive),
    json(r.paths),
    json(r.companyPaths),
    json(r.sources),
    r.error,
    json(r.summary),
    json(r.setup ?? null),
  ];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  if (opts.onlyIfIdle) {
    conditions.push(`(le_warm_paths.status <> 'running' or le_warm_paths.started_at < now() - make_interval(secs => ${param(CHECK_STALE_MS / 1000)}::double precision))`);
  }
  if (opts.ifVersion) conditions.push(`le_warm_paths.xmin::text = ${param(opts.ifVersion)}::text`);
  const updateOnly = Boolean(opts.updateOnly || opts.ifVersion);
  const write = updateOnly
    ? `update le_warm_paths set
         status = $2, target = nullif($3::jsonb, 'null'::jsonb), linkedin_live = nullif($4::jsonb, 'null'::jsonb), x_live = nullif($5::jsonb, 'null'::jsonb),
         paths = $6::jsonb, company_paths = $7::jsonb, sources = $8::jsonb, error = $9, setup = nullif($11::jsonb, 'null'::jsonb),
         computed_at = now(), updated_at = now()
        where le_warm_paths.lead_id = $1 ${conditions.map((c) => `and ${c}`).join(" ")}
       returning lead_id`
    : `insert into le_warm_paths (lead_id, status, target, linkedin_live, x_live, paths, company_paths, sources, error, setup, computed_at, updated_at)
       values ($1, $2, nullif($3::jsonb, 'null'::jsonb), nullif($4::jsonb, 'null'::jsonb), nullif($5::jsonb, 'null'::jsonb), $6::jsonb, $7::jsonb, $8::jsonb, $9,
               nullif($11::jsonb, 'null'::jsonb), now(), now())
       on conflict (lead_id) do ${
         opts.insertOnly
           ? "nothing"
           : `update set
         status = excluded.status, target = excluded.target, linkedin_live = excluded.linkedin_live, x_live = excluded.x_live,
         paths = excluded.paths, company_paths = excluded.company_paths, sources = excluded.sources, error = excluded.error,
         setup = excluded.setup, computed_at = now(), updated_at = now()
        ${conditions.length ? `where ${conditions.join(" and ")}` : ""}`
       }
       returning lead_id`;
  try {
    const rows = await query<{ saved: number }>(
      `with w as (
         ${write}
       ), l as (
         update le_leads set warm_path = nullif($10::jsonb, 'null'::jsonb) where id = $1 and exists (select 1 from w) returning id
       )
       select (select count(*) from w)::int as saved`,
      params,
    );
    return Number(rows[0]?.saved ?? 0) > 0;
  } catch (err) {
    if (isFkViolation(err)) return false;
    throw err;
  }
}

/**
 * Sets (or with null clears) the lead's Instagram handle in its target, creating the row when
 * needed. The handle must already be clean (cleanInstagramHandle). Returns the row, or null when
 * the lead is gone. With `onlyIfIdle` it also returns null, writing nothing, while a check runs
 * (that check would save the target it read before the handle and lose it).
 */
export async function setTargetInstagram(
  leadId: string,
  handle: string | null,
  source: "profile" | "manual" = "manual",
  opts: { onlyIfIdle?: boolean } = {},
): Promise<WarmPathRow | null> {
  const patch = { instagramHandle: handle, instagramSource: handle ? source : null };
  const fresh: WarmPathTarget = {
    linkedinSlug: null,
    linkedinPublicId: null,
    linkedinMemberId: null,
    roles: [],
    schools: [],
    companySize: null,
    xHandle: null,
    xUserId: null,
    instagramHandle: handle,
    instagramSource: handle ? source : null,
    capturedAt: new Date().toISOString(),
  };
  try {
    const rows = await query(
      `insert into le_warm_paths (lead_id, target, updated_at) values ($1, $2::jsonb, now())
       on conflict (lead_id) do update set target = coalesce(nullif(le_warm_paths.target, 'null'::jsonb), $2::jsonb) || $3::jsonb, updated_at = now()
        ${opts.onlyIfIdle ? "where le_warm_paths.status <> 'running' or le_warm_paths.started_at is null or le_warm_paths.started_at < now() - make_interval(secs => $4::double precision)" : ""}
       returning *`,
      [leadId, json(fresh), json(patch), ...(opts.onlyIfIdle ? [CHECK_STALE_MS / 1000] : [])],
    );
    return rows[0] ? toRow(rows[0]) : null;
  } catch (err) {
    if (isFkViolation(err)) return null;
    throw err;
  }
}

/**
 * Updates the intro draft and/or the "asked" date of one path (by its id). introDraft null clears
 * the draft; askedAt null clears the date. Returns the entry as saved, or null when the lead has
 * no warm-paths row.
 */
export async function saveIntro(leadId: string, pathId: string, patch: Partial<IntroEntry>): Promise<IntroEntry | null> {
  const set: Record<string, unknown> = {};
  if (patch.introDraft !== undefined) set.introDraft = patch.introDraft;
  if (patch.askedAt !== undefined) set.askedAt = patch.askedAt;
  const rows = await query<{ entry: IntroEntry | null }>(
    `update le_warm_paths
        set intros = jsonb_set(intros, array[$2::text], coalesce(intros -> $2::text, '{"introDraft": null, "askedAt": null}'::jsonb) || $3::jsonb, true),
            updated_at = now()
      where lead_id = $1
      returning intros -> $2::text as entry`,
    [leadId, pathId, json(set)],
  );
  if (!rows[0]) return null;
  const e = rows[0].entry ?? { introDraft: null, askedAt: null };
  return { introDraft: e.introDraft ?? null, askedAt: e.askedAt ?? null };
}

/** Forgets the lead's cached X check (its X handle changed). */
export async function clearXLive(leadId: string): Promise<void> {
  await query("update le_warm_paths set x_live = null, updated_at = now() where lead_id = $1", [leadId]);
}

/**
 * Your connections were deleted: drops every stored path that may name one (all but X-only paths),
 * every company person, and the intro drafts and "asked" dates of those people (company people
 * have "li-" ids too), and clears the list summaries. Each lead's paths are rebuilt for free (from
 * the cached checks) the next time its page is opened; a draft does not come back with a new upload.
 * Path ids carry their network: "li-..." or "x-..." (src/lib/paths/ids.ts).
 */
export async function purgeLinkedinDerivedPaths(): Promise<void> {
  await query(
    `update le_warm_paths
        set paths = coalesce((select jsonb_agg(p order by (p ->> 'rank')::int) from jsonb_array_elements(paths) p where p ->> 'id' like 'x-%'), '[]'::jsonb),
            company_paths = '[]'::jsonb, linkedin_live = null,
            intros = coalesce((select jsonb_object_agg(k, v) from jsonb_each(intros) as e(k, v) where k not like 'li-%'), '{}'::jsonb),
            updated_at = now()`,
  );
  await query("update le_leads set warm_path = null where warm_path is not null");
}

/**
 * Your X lists were forgotten: drops every cached X check, every path that may name an X account
 * and the intro drafts and "asked" dates of X-only people, and clears the summaries of checked leads.
 */
export async function purgeXDerivedPaths(): Promise<void> {
  await query(
    `update le_warm_paths
        set x_live = null,
            paths = coalesce((select jsonb_agg(p order by (p ->> 'rank')::int) from jsonb_array_elements(paths) p where p ->> 'id' like 'li-%'), '[]'::jsonb),
            intros = coalesce((select jsonb_object_agg(k, v) from jsonb_each(intros) as e(k, v) where k not like 'x-%'), '{}'::jsonb),
            updated_at = now()`,
  );
  // A lead never checked (no row) has only the chip a connections upload set, which this leaves
  // alone; the others are rebuilt by the free recompute.
  await query("update le_leads l set warm_path = null where l.warm_path is not null and exists (select 1 from le_warm_paths w where w.lead_id = l.id)");
}

/** Lead ids with a warm-paths row, the most recently computed first (for a recompute of everyone). */
/**
 * The LinkedIn profile and company page the lead's last research run read, as it stored them
 * (le_raw 'linkedin.profile' and 'linkedin.company', the newest of each), with the profile URL it
 * read. Null fields when there is none. Read only, for leads researched before warm paths existed.
 */
export async function storedResearchLinkedin(leadId: string): Promise<{ url: string | null; profile: Record<string, unknown> | null; company: Record<string, unknown> | null }> {
  const rows = await query<{ provider: string; url: string | null; response: unknown }>(
    `select distinct on (provider) provider, request ->> 'url' as url, response from le_raw
      where lead_id = $1 and provider in ('linkedin.profile', 'linkedin.company') and jsonb_typeof(response) = 'object'
      order by provider, created_at desc, id desc`,
    [leadId],
  );
  const of = (p: string) => rows.find((r) => r.provider === p);
  const asObj = (v: unknown) => (isObj(v) ? (v as Record<string, unknown>) : null);
  const profile = of("linkedin.profile");
  return { url: profile?.url ? String(profile.url) : null, profile: asObj(profile?.response), company: asObj(of("linkedin.company")?.response) };
}

/**
 * Researched leads with a LinkedIn profile and no warm-paths row yet, whose research stored that
 * profile: leads researched before warm paths existed. Newest first.
 */
export async function leadIdsToBackfill(limit = 200): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `select l.id from le_leads l
      where l.research_finished_at is not null and l.linkedin_slug is not null
        and not exists (select 1 from le_warm_paths w where w.lead_id = l.id)
        and exists (select 1 from le_raw r where r.lead_id = l.id and r.provider = 'linkedin.profile')
      order by l.updated_at desc, l.id
      limit $1`,
    [limit],
  );
  return rows.map((r) => String(r.id));
}

export async function warmPathLeadIds(limit = 500): Promise<string[]> {
  const rows = await query<{ lead_id: string }>("select lead_id from le_warm_paths order by computed_at desc nulls last limit $1", [limit]);
  return rows.map((r) => String(r.lead_id));
}

/** Leads (other than `exceptId`) whose LinkedIn slug or X handle is one of these: a connector who is also a lead. */
export async function leadsBySlugsOrHandles(slugs: string[], handles: string[], exceptId: string): Promise<Array<{ id: string; slug: string | null; xHandle: string | null; stage: string }>> {
  if (!slugs.length && !handles.length) return [];
  const rows = await query(
    `select id, linkedin_slug, x_handle, stage from le_leads
      where id <> $3::uuid and (linkedin_slug = any($1::text[]) or lower(x_handle) = any($2::text[]))
      limit 100`,
    [slugs, handles.map((h) => h.toLowerCase()), exceptId],
  );
  return rows.map((r) => ({ id: String(r.id), slug: r.linkedin_slug == null ? null : String(r.linkedin_slug), xHandle: r.x_handle == null ? null : String(r.x_handle), stage: String(r.stage) }));
}
