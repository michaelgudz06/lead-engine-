import "server-only";
import { query } from "../db";
import {
  USAGE_PROVIDERS,
  type CostBasis,
  type DailySpend,
  type LeadUsage,
  type ProviderTotals,
  type UsageProvider,
  type UsageRecord,
  type UsageSummary,
  type UsageUnits,
  type UsageWindow,
} from "./types";

/**
 * Read side of the usage ledger, for the admin panel.
 * CONTRACT: signatures fixed; bodies owned by the usage-ledger builder.
 *
 * Windows are whole UTC days: "today" starts at the last UTC midnight, "7d" and "30d"
 * cover today plus the 6 or 29 UTC days before it (the same days getDailySpend(7 | 30)
 * returns), "all" has no start.
 *
 * Three kinds of row (see ledger.ts):
 * - tied to a lead: lead_id set;
 * - tied to a lead that was deleted since: lead_id null, lead_name kept;
 * - never tied to a lead ("untagged"): both null.
 */

const DAY_MS = 86_400_000;

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

/** The most recent ledger rows, newest first. */
export async function getRecentUsage(limit = 100): Promise<UsageRecord[]> {
  const max = Math.max(1, Math.min(1000, Math.round(num(limit)) || 100));
  const rows = await query<{
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
  }>(
    // The lead's current name when it still exists; the name written with the row for a
    // deleted lead (lead_id is null then, so the panel can still say who it was).
    `select u.id, u.lead_id, coalesce(l.name, u.lead_name) as lead_name, u.provider, u.operation, u.units,
            u.cost_usd, u.cost_basis, u.ok, u.ms, u.created_at
       from le_usage u
       left join le_leads l on l.id = u.lead_id
      order by u.id desc
      limit $1`,
    [max],
  );
  return rows.map((r) => ({
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
  }));
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
