import "server-only";
import { query } from "../db";
import {
  BACKFILL_OPERATION,
  USAGE_PROVIDERS,
  type CallSort,
  type CostBasis,
  type DailySpend,
  type LeadUsage,
  type OperationStats,
  type ProviderTotals,
  type RunOutcome,
  type RunUsage,
  type UsageProvider,
  type UsageRecord,
  type UsageSummary,
  type UsageUnits,
  type UsageWindow,
} from "./types";

/**
 * Read side of the usage ledger, for the Usage tab (/usage). leadCostUsd() is also read by
 * src/lib/analytics-server.ts, so its signature stays as it is.
 *
 * Windows are whole UTC days: "today" starts at the last UTC midnight, "7d" and "30d"
 * cover today plus the 6 or 29 UTC days before it (the same days getDailySpend(7 | 30)
 * returns), "all" has no start.
 *
 * Three kinds of row (see ledger.ts):
 * - tied to a lead: lead_id set;
 * - tied to a lead that was deleted since: lead_id null, lead_name kept (to tell it from
 *   untagged spend; it is never shown: LEAD_NAME_SQL);
 * - never tied to a lead ("untagged"): both null.
 *
 * The backfill rows (BACKFILL_OPERATION) count in the totals (summary, per lead, daily
 * spend) and are left out of per-call figures (time and cost per request, run costs); the
 * call list puts them last when it sorts by cost.
 */

const DAY_MS = 86_400_000;

/** Shown instead of a deleted lead's name in the call list and the CSV export. */
export const DELETED_LEAD_NAME = "Deleted lead";
/** The name column for a ledger row u joined to le_leads l: never a deleted lead's name. */
export const LEAD_NAME_SQL = `case when u.lead_id is null and u.lead_name is not null then '${DELETED_LEAD_NAME}' else coalesce(l.name, u.lead_name) end`;

/**
 * The longest a research or steer run can take. A run still going after this long was lost:
 * the API marks it failed then (STALE_RUN_MS in src/app/api/_lib/api.ts), and on Vercel a run
 * is cut at 300 s anyway. An end recorded later than this is that mark, written whenever
 * someone next opened the lead, so it says nothing about how long the run took.
 */
export const RUN_MAX_MS = 6 * 60_000;

/** Ledger rows a run may still write after its end event (its last inserts finish in the background). */
export const RUN_END_GRACE_MS = 15_000;

/** Start of the window, or null for all time. Exported for tests. */
export function windowStart(window: UsageWindow, now: Date = new Date()): Date | null {
  if (window === "all") return null;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysBack = window === "today" ? 0 : window === "7d" ? 6 : 29;
  return new Date(midnight - daysBack * DAY_MS);
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
/** Sums of numeric(12,6) values: cut float noise at the sixth decimal. */
const usd = (v: unknown): number => Math.round(num(v) * 1e6) / 1e6;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isProvider = (v: unknown): v is UsageProvider => (USAGE_PROVIDERS as readonly string[]).includes(String(v));
const order = (p: UsageProvider): number => USAGE_PROVIDERS.indexOf(p);

function units(v: unknown): UsageUnits {
  const out: UsageUnits = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) {
      const n = Number(x);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

export async function getUsageSummary(window: UsageWindow): Promise<UsageSummary> {
  const from = windowStart(window);
  const fromIso = from ? from.toISOString() : null;
  const [providerRows, unitRows, totalRows] = await Promise.all([
    query<{ provider: string; calls: string; failed: string; cost: string | null; estimated: boolean | null }>(
      `select provider,
              count(*) as calls,
              count(*) filter (where not ok) as failed,
              sum(cost_usd) as cost,
              bool_or(cost_basis = 'estimated' and coalesce(cost_usd, 0) > 0) as estimated
         from le_usage
        where ($1::timestamptz is null or created_at >= $1::timestamptz)
        group by provider`,
      [fromIso],
    ),
    query<{ provider: string; unit: string; total: string }>(
      `select u.provider, e.key as unit, sum(e.value::numeric) as total
         from le_usage u
        cross join lateral jsonb_each_text(u.units) e
        where ($1::timestamptz is null or u.created_at >= $1::timestamptz)
          and jsonb_typeof(u.units -> e.key) = 'number'
        group by u.provider, e.key`,
      [fromIso],
    ),
    query<{ total: string | null; tagged: string | null; untagged: string | null; live: string; deleted: string }>(
      `select sum(cost_usd) as total,
              sum(cost_usd) filter (where lead_id is not null or lead_name is not null) as tagged,
              sum(cost_usd) filter (where lead_id is null and lead_name is null) as untagged,
              count(distinct lead_id) as live,
              count(distinct lead_name) filter (where lead_id is null) as deleted
         from le_usage
        where ($1::timestamptz is null or created_at >= $1::timestamptz)`,
      [fromIso],
    ),
  ]);

  const byProvider = new Map<UsageProvider, ProviderTotals>();
  for (const r of providerRows) {
    if (!isProvider(r.provider)) continue;
    byProvider.set(r.provider, {
      provider: r.provider,
      calls: num(r.calls),
      failed: num(r.failed),
      costUsd: usd(r.cost),
      costEstimated: r.estimated === true,
      units: {},
    });
  }
  for (const r of unitRows) {
    const p = isProvider(r.provider) ? byProvider.get(r.provider) : undefined;
    if (p) p.units[r.unit] = num(r.total);
  }

  const t = totalRows[0];
  const leadsTouched = num(t?.live) + num(t?.deleted);
  return {
    window,
    from: fromIso,
    totalCostUsd: usd(t?.total),
    providers: [...byProvider.values()].sort((a, b) => order(a.provider) - order(b.provider)),
    leadsTouched,
    avgCostPerLeadUsd: leadsTouched > 0 ? usd(num(t?.tagged) / leadsTouched) : null,
    untaggedCostUsd: usd(t?.untagged),
  };
}

/** Per-lead breakdown in the window, newest activity first. */
export async function getLeadUsage(window: UsageWindow, limit = 200): Promise<LeadUsage[]> {
  const from = windowStart(window);
  const max = Math.max(1, Math.min(1000, Math.round(num(limit)) || 200));
  // One group per live lead, plus one group (lead_id null) for all usage of deleted leads.
  // Usage that was never tied to a lead is not listed here; it is UsageSummary.untaggedCostUsd.
  const rows = await query<{
    lead_id: string | null;
    lead_name: string | null;
    company: string | null;
    first_at: string;
    last_at: string;
    total: string | null;
    by_provider: Record<string, { calls: number; costUsd: number; units: Record<string, unknown> }> | null;
  }>(
    `with scoped as (
       select * from le_usage
        where ($1::timestamptz is null or created_at >= $1::timestamptz)
          and (lead_id is not null or lead_name is not null)
     ),
     top as (
       select lead_id, min(created_at) as first_at, max(created_at) as last_at, sum(cost_usd) as total
         from scoped
        group by lead_id
        order by max(created_at) desc
        limit $2
     ),
     unit_sums as (
       select s.lead_id, s.provider, e.key, sum(e.value::numeric) as total
         from scoped s
        cross join lateral jsonb_each_text(s.units) e
        where jsonb_typeof(s.units -> e.key) = 'number'
        group by s.lead_id, s.provider, e.key
     ),
     provider_units as (
       select lead_id, provider, jsonb_object_agg(key, total) as units
         from unit_sums
        group by lead_id, provider
     ),
     provider_sums as (
       select lead_id, provider, count(*) as calls, coalesce(sum(cost_usd), 0) as cost
         from scoped
        group by lead_id, provider
     ),
     per_lead as (
       select p.lead_id,
              jsonb_object_agg(
                p.provider,
                jsonb_build_object('calls', p.calls, 'costUsd', p.cost, 'units', coalesce(pu.units, '{}'::jsonb))
              ) as by_provider
         from provider_sums p
         left join provider_units pu on pu.lead_id is not distinct from p.lead_id and pu.provider = p.provider
        group by p.lead_id
     )
     select t.lead_id, l.name as lead_name, l.company_name as company, t.first_at, t.last_at, t.total, pl.by_provider
       from top t
       left join le_leads l on l.id = t.lead_id
       left join per_lead pl on pl.lead_id is not distinct from t.lead_id
      order by t.last_at desc`,
    [from ? from.toISOString() : null, max],
  );

  return rows.map((r) => {
    const byProvider: LeadUsage["byProvider"] = {};
    for (const [provider, v] of Object.entries(r.by_provider ?? {})) {
      if (!isProvider(provider)) continue;
      byProvider[provider] = { calls: num(v?.calls), costUsd: usd(v?.costUsd), units: units(v?.units) };
    }
    return {
      leadId: r.lead_id,
      leadName: r.lead_id ? r.lead_name : null,
      company: r.lead_id ? r.company : null,
      firstAt: iso(r.first_at),
      lastAt: iso(r.last_at),
      totalCostUsd: usd(r.total),
      byProvider,
    };
  });
}

interface RecordRow {
  id: string;
  lead_id: string | null;
  lead_name: string | null;
  provider: string;
  operation: string;
  units: unknown;
  cost_usd: string | null;
  cost_basis: string;
  ok: boolean;
  ms: number | null;
  created_at: string;
}

function toRecord(r: RecordRow): UsageRecord {
  return {
    id: num(r.id),
    leadId: r.lead_id,
    leadName: r.lead_name,
    provider: r.provider as UsageProvider,
    operation: r.operation,
    units: units(r.units),
    costUsd: r.cost_usd === null ? null : usd(r.cost_usd),
    costBasis: (["reported", "estimated", "free", "unknown"].includes(r.cost_basis) ? r.cost_basis : "unknown") as CostBasis,
    ok: r.ok,
    ms: r.ms === null ? null : num(r.ms),
    createdAt: iso(r.created_at),
  };
}

/**
 * ORDER BY per sort. Fixed strings: nothing from a request is ever spliced into the SQL.
 * Rows without a duration come last when sorting by time, rows without a cost (and the
 * backfill rows, which each stand for many calls) last when sorting by cost.
 */
const CALL_ORDER: Record<CallSort, string> = {
  newest: "u.id desc",
  slowest: "u.ms desc nulls last, u.id desc",
  costliest: `(u.operation = '${BACKFILL_OPERATION}'), u.cost_usd desc nulls last, u.id desc`,
};

export interface CallQuery {
  window: UsageWindow;
  /** Default "newest". */
  sort?: CallSort;
  provider?: UsageProvider | null;
  operation?: string | null;
  /** 1..1000, default 100. */
  limit?: number;
}

/**
 * Ledger rows in the window, newest, slowest or most expensive first, optionally for one
 * provider and one operation, plus how many rows match (whatever the sort).
 */
export async function listCalls(q: CallQuery): Promise<{ calls: UsageRecord[]; total: number }> {
  const sort: CallSort = q.sort && Object.hasOwn(CALL_ORDER, q.sort) ? q.sort : "newest";
  const max = Math.max(1, Math.min(1000, Math.round(num(q.limit)) || 100));
  const from = windowStart(q.window);
  const provider = q.provider && isProvider(q.provider) ? q.provider : null;
  const operation = typeof q.operation === "string" && q.operation ? q.operation.slice(0, 80) : null;
  const params = [from ? from.toISOString() : null, provider, operation];
  const where = `($1::timestamptz is null or u.created_at >= $1::timestamptz)
     and ($2::text is null or u.provider = $2::text)
     and ($3::text is null or u.operation = $3::text)`;
  const [rows, counts] = await Promise.all([
    // The lead's current name when it still exists. A deleted lead (lead_id null, its name
    // kept on the row so its spend still counts as tied to a lead) shows as "Deleted lead": the
    // open tab must not keep publishing the name of someone the team removed.
    query<RecordRow>(
      `select u.id, u.lead_id, ${LEAD_NAME_SQL} as lead_name, u.provider, u.operation, u.units,
              u.cost_usd, u.cost_basis, u.ok, u.ms, u.created_at
         from le_usage u
         left join le_leads l on l.id = u.lead_id
        where ${where}
        order by ${CALL_ORDER[sort]}
        limit $4`,
      [...params, max],
    ),
    query<{ total: string }>(`select count(*) as total from le_usage u where ${where}`, params),
  ]);
  return { calls: rows.map(toRecord), total: num(counts[0]?.total) };
}

/**
 * Time and cost per request: one row per provider and operation with calls in the window,
 * slowest first (by median, then 95th percentile). Durations are interpolated percentiles of
 * le_usage.ms over the calls that recorded one; failed calls count, since they took time too.
 * The backfill rows are left out (no duration, and each stands for many calls).
 */
export async function getOperationStats(window: UsageWindow): Promise<OperationStats[]> {
  const from = windowStart(window);
  const rows = await query<{
    provider: string;
    operation: string;
    calls: string;
    failed: string;
    timed: string;
    median_ms: number | string | null;
    p95_ms: number | string | null;
    max_ms: number | string | null;
    priced: string;
    total_cost: string | null;
    avg_cost: string | null;
    max_cost: string | null;
    estimated: boolean | null;
  }>(
    `select provider, operation,
            count(*) as calls,
            count(*) filter (where not ok) as failed,
            count(ms) as timed,
            percentile_cont(0.5) within group (order by ms) as median_ms,
            percentile_cont(0.95) within group (order by ms) as p95_ms,
            max(ms) as max_ms,
            count(cost_usd) as priced,
            sum(cost_usd) as total_cost,
            avg(cost_usd) as avg_cost,
            max(cost_usd) as max_cost,
            bool_or(cost_basis = 'estimated' and coalesce(cost_usd, 0) > 0) as estimated
       from le_usage
      where ($1::timestamptz is null or created_at >= $1::timestamptz)
        and operation <> $2
      group by provider, operation
      order by median_ms desc nulls last, p95_ms desc nulls last, provider, operation`,
    [from ? from.toISOString() : null, BACKFILL_OPERATION],
  );
  const ms = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(num(v)));
  return rows
    .filter((r) => isProvider(r.provider))
    .map((r) => {
      const priced = num(r.priced);
      return {
        provider: r.provider as UsageProvider,
        operation: r.operation,
        calls: num(r.calls),
        failed: num(r.failed),
        timedCalls: num(r.timed),
        medianMs: ms(r.median_ms),
        p95Ms: ms(r.p95_ms),
        maxMs: ms(r.max_ms),
        pricedCalls: priced,
        totalCostUsd: usd(r.total_cost),
        avgCostUsd: priced > 0 ? usd(r.avg_cost) : null,
        maxCostUsd: priced > 0 ? usd(r.max_cost) : null,
        costEstimated: r.estimated === true,
      };
    });
}

/**
 * Research and steer runs that started in the window, newest first (at most `limit`), plus
 * how many the window holds. Runs of leads deleted since are left out: their events went
 * with the lead, and their ledger rows no longer name it.
 *
 * - Start: the run's row in le_run_starts (written when the run was allowed to start).
 * - End: the lead's first 'done' event after the start, or else its last 'error' event (a run
 *   can log an error, such as findings it could not save, and still carry on). Only events
 *   before the lead's next run and within RUN_MAX_MS of the start count.
 * - Cost: the lead's ledger rows from the start to the end (plus RUN_END_GRACE_MS for rows
 *   still being written), never past the lead's next run. Without an end: up to RUN_MAX_MS.
 *
 * `now` decides which runs without an end are still running; tests pass their own.
 */
export async function listRuns(window: UsageWindow, limit = 50, now: Date = new Date()): Promise<{ runs: RunUsage[]; total: number }> {
  const from = windowStart(window, now);
  const fromIso = from ? from.toISOString() : null;
  const max = Math.max(1, Math.min(500, Math.round(num(limit)) || 50));
  const [rows, counts] = await Promise.all([
    query<{
      id: string;
      lead_id: string;
      kind: string;
      started_at: string;
      lead_name: string | null;
      company: string | null;
      end_type: string | null;
      end_message: string | null;
      ended_at: string | null;
      running: boolean;
      calls: string;
      failed: string;
      priced: string;
      cost: string | null;
      estimated: boolean | null;
    }>(
      `with starts as (
         select r.id, r.lead_id, r.kind, r.created_at as started_at,
                lead(r.created_at) over (partition by r.lead_id order by r.created_at, r.id) as next_start
           from le_run_starts r
          where r.lead_id is not null
            and ($1::timestamptz is null or r.created_at >= $1::timestamptz)
       ),
       picked as (
         select s.*, coalesce(nullif(btrim(l.name), ''), l.linkedin_slug) as lead_name, l.company_name as company
           from starts s
           join le_leads l on l.id = s.lead_id
          order by s.started_at desc, s.id desc
          limit $2
       ),
       ended as (
         select p.*, fin.type as end_type, fin.message as end_message, fin.created_at as ended_at
           from picked p
           left join lateral (
             select e.type, e.message, e.created_at
               from le_events e
              where e.lead_id = p.lead_id
                and e.type in ('done', 'error')
                and e.created_at >= p.started_at
                and e.created_at <= p.started_at + make_interval(secs => $3)
                and (p.next_start is null or e.created_at < p.next_start)
              order by (e.type = 'done') desc,
                       case when e.type = 'done' then e.created_at end asc,
                       e.created_at desc,
                       e.id desc
              limit 1
           ) fin on true
       )
       select x.id, x.lead_id, x.kind, x.started_at, x.lead_name, x.company,
              x.end_type, left(x.end_message, 300) as end_message, x.ended_at,
              (x.ended_at is null and x.next_start is null and $6::timestamptz - x.started_at <= make_interval(secs => $3)) as running,
              c.calls, c.failed, c.priced, c.cost, c.estimated
         from ended x
         left join lateral (
           select count(*) as calls,
                  count(*) filter (where not u.ok) as failed,
                  count(u.cost_usd) as priced,
                  sum(u.cost_usd) as cost,
                  bool_or(u.cost_basis = 'estimated' and coalesce(u.cost_usd, 0) > 0) as estimated
             from le_usage u
            where u.lead_id = x.lead_id
              and u.operation <> $5
              and u.created_at >= x.started_at
              and u.created_at < least(
                    coalesce(x.next_start, 'infinity'::timestamptz),
                    case when x.ended_at is null then x.started_at + make_interval(secs => $3)
                         else x.ended_at + make_interval(secs => $4) end)
         ) c on true
        order by x.started_at desc, x.id desc`,
      [fromIso, max, RUN_MAX_MS / 1000, RUN_END_GRACE_MS / 1000, BACKFILL_OPERATION, now.toISOString()],
    ),
    query<{ total: string }>(
      `select count(*) as total
         from le_run_starts r
         join le_leads l on l.id = r.lead_id
        where ($1::timestamptz is null or r.created_at >= $1::timestamptz)`,
      [fromIso],
    ),
  ]);

  const runs = rows.map((r): RunUsage => {
    const startedAt = iso(r.started_at);
    const endedAt = r.ended_at ? iso(r.ended_at) : null;
    const outcome: RunOutcome = r.end_type === "done" ? "done" : r.end_type === "error" ? "failed" : r.running ? "running" : "lost";
    const priced = num(r.priced);
    return {
      id: num(r.id),
      kind: r.kind === "steer" ? "steer" : "research",
      leadId: r.lead_id,
      leadName: r.lead_name,
      company: r.company,
      startedAt,
      endedAt,
      outcome,
      durationMs: endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : null,
      calls: num(r.calls),
      failedCalls: num(r.failed),
      costUsd: priced > 0 ? usd(r.cost) : null,
      costEstimated: r.estimated === true,
      endMessage: r.end_message,
    };
  });
  return { runs, total: num(counts[0]?.total) };
}

/** One row per UTC day for the last `days` days (zero-filled), oldest first. */
export async function getDailySpend(days = 30): Promise<DailySpend[]> {
  const count = Math.max(1, Math.min(366, Math.round(num(days)) || 30));
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (count - 1) * DAY_MS;
  const rows = await query<{ day: string; provider: string; cost: string | null }>(
    `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, provider, sum(cost_usd) as cost
       from le_usage
      where created_at >= $1::timestamptz
      group by 1, 2`,
    [new Date(start).toISOString()],
  );
  const byDay = new Map<string, DailySpend>();
  for (let i = 0; i < count; i++) {
    const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    byDay.set(day, { day, totalUsd: 0, byProvider: {} });
  }
  for (const r of rows) {
    const d = byDay.get(r.day);
    const cost = usd(r.cost);
    if (!d || !isProvider(r.provider) || cost === 0) continue;
    d.byProvider[r.provider] = usd((d.byProvider[r.provider] ?? 0) + cost);
    d.totalUsd = usd(d.totalUsd + cost);
  }
  return [...byDay.values()];
}

/** Everything the ledger has recorded for one lead, in USD. For the analytics builder. Throws on a database error. */
export async function leadCostUsd(leadId: string): Promise<number> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(leadId ?? ""))) return 0;
  const rows = await query<{ total: string | null }>("select sum(cost_usd) as total from le_usage where lead_id = $1::uuid", [leadId]);
  return usd(rows[0]?.total);
}
