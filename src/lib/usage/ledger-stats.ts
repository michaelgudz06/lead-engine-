import "server-only";
import { query } from "../db";
import { USAGE_PROVIDERS, type UsageProvider, type UsageUnits } from "./types";

/**
 * What the usage ledger knows per provider for today and for this calendar month (both UTC),
 * for the balance lines of providers without a usable balance API, and for Unipile's LinkedIn
 * request count. One round of two queries; throws on a database error (the caller catches).
 */

export interface LedgerProviderStats {
  provider: UsageProvider;
  todayCalls: number;
  todayUsd: number;
  monthCalls: number;
  monthUsd: number;
  /** Part of the month's cost is estimated from the price table. */
  monthEstimated: boolean;
  monthUnits: UsageUnits;
  /**
   * Unipile only: requests today that reach LinkedIn on the research account (profiles, posts,
   * company pages, searches). The accounts list never touches LinkedIn and is left out, and so
   * are the owner's own account's network-* operations (counted in networkRequestsToday).
   */
  linkedinRequestsToday: number;
  /** Unipile only: requests today on the owner's own LinkedIn account (warm paths: network-profile, network-search, network-me). */
  networkRequestsToday: number;
}

export type LedgerStats = Map<UsageProvider, LedgerProviderStats>;

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const usd = (v: unknown): number => Math.round(num(v) * 1e6) / 1e6;

export function emptyStats(provider: UsageProvider): LedgerProviderStats {
  return { provider, todayCalls: 0, todayUsd: 0, monthCalls: 0, monthUsd: 0, monthEstimated: false, monthUnits: {}, linkedinRequestsToday: 0, networkRequestsToday: 0 };
}

export async function ledgerStats(now: Date = new Date()): Promise<LedgerStats> {
  const today = utcDayStart(now);
  // Never after today's start (on the 1st of a month they are the same instant).
  const month = utcMonthStart(now);
  const [rows, unitRows] = await Promise.all([
    query<{
      provider: string;
      today_calls: string;
      today_cost: string | null;
      month_calls: string;
      month_cost: string | null;
      month_estimated: boolean | null;
      linkedin_today: string | null;
      network_today: string | null;
    }>(
      `select provider,
              count(*) filter (where created_at >= $1::timestamptz) as today_calls,
              sum(cost_usd) filter (where created_at >= $1::timestamptz) as today_cost,
              count(*) filter (where created_at >= $2::timestamptz) as month_calls,
              sum(cost_usd) filter (where created_at >= $2::timestamptz) as month_cost,
              bool_or(cost_basis = 'estimated' and coalesce(cost_usd, 0) > 0 and created_at >= $2::timestamptz) as month_estimated,
              sum(case when jsonb_typeof(units -> 'requests') = 'number' then (units ->> 'requests')::numeric else 1 end)
                filter (where created_at >= $1::timestamptz and operation <> 'accounts' and operation not like 'network-%') as linkedin_today,
              sum(case when jsonb_typeof(units -> 'requests') = 'number' then (units ->> 'requests')::numeric else 1 end)
                filter (where created_at >= $1::timestamptz and operation like 'network-%') as network_today
         from le_usage
        where created_at >= $2::timestamptz
        group by provider`,
      [today.toISOString(), month.toISOString()],
    ),
    query<{ provider: string; unit: string; total: string }>(
      `select u.provider, e.key as unit, sum(e.value::numeric) as total
         from le_usage u
        cross join lateral jsonb_each_text(u.units) e
        where u.created_at >= $1::timestamptz
          and jsonb_typeof(u.units -> e.key) = 'number'
        group by u.provider, e.key`,
      [month.toISOString()],
    ),
  ]);

  const out: LedgerStats = new Map(USAGE_PROVIDERS.map((p) => [p, emptyStats(p)]));
  for (const r of rows) {
    const s = out.get(r.provider as UsageProvider);
    if (!s) continue;
    s.todayCalls = num(r.today_calls);
    s.todayUsd = usd(r.today_cost);
    s.monthCalls = num(r.month_calls);
    s.monthUsd = usd(r.month_cost);
    s.monthEstimated = r.month_estimated === true;
    s.linkedinRequestsToday = s.provider === "unipile" ? num(r.linkedin_today) : 0;
    s.networkRequestsToday = s.provider === "unipile" ? num(r.network_today) : 0;
  }
  for (const r of unitRows) {
    const s = out.get(r.provider as UsageProvider);
    if (s) s.monthUnits[r.unit] = num(r.total);
  }
  return out;
}
