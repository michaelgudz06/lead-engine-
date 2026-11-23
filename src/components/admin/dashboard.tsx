"use client";

import { useEffect, useState } from "react";
import { formatCount, formatUsd } from "@/lib/admin/format";
import { RECENT_LIMIT, USAGE_WINDOWS, WINDOW_LABELS, WINDOW_PHRASES, type AdminBalancesResponse, type AdminUsageResponse } from "@/lib/admin/types";
import type { UsageProvider, UsageWindow } from "@/lib/usage/types";
import { timeAgo } from "@/components/format";
import { Button, ErrorState, Notice, Skeleton, cx } from "@/components/ui";
import { exportUrl, getAdminBalances, getAdminUsage } from "./api";
import { Est, Section } from "./bits";
import { LeadTable } from "./lead-table";
import { ProviderCards } from "./provider-cards";
import { RecentCalls } from "./recent-calls";
import { seriesOf, type SeriesId } from "./series";
import { SpendChart } from "./spend-chart";

interface UsageState {
  data: AdminUsageResponse | null;
  error: string | null;
  /** The window the error belongs to, so switching windows shows the frame again. */
  errorWindow: UsageWindow | null;
}

interface BalanceState {
  data: AdminBalancesResponse | null;
  error: string | null;
  refreshing: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.";
}

/**
 * The owner's usage panel at /admin. One filter row (the window) scopes everything below it;
 * the daily chart always shows 30 days and fades the days outside the window. While a new
 * window loads, the previous numbers stay on screen, dimmed, so nothing jumps. No login: the
 * server only serves this page on the owner's computer (src/lib/admin/access.ts).
 */
export function AdminDashboard({ initialWindow }: { initialWindow: UsageWindow }) {
  const [window, setWindow] = useState<UsageWindow>(initialWindow);
  const [usage, setUsage] = useState<UsageState>({ data: null, error: null, errorWindow: null });
  const [retry, setRetry] = useState(0);
  const [balances, setBalances] = useState<BalanceState>({ data: null, error: null, refreshing: false });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    getAdminUsage(window).then(
      (data) => {
        if (alive) setUsage({ data, error: null, errorWindow: null });
      },
      (err: unknown) => {
        if (alive) setUsage((s) => ({ ...s, error: errorText(err), errorWindow: window }));
      },
    );
    return () => {
      alive = false;
    };
  }, [window, retry]);

  useEffect(() => {
    let alive = true;
    getAdminBalances(false).then(
      (data) => {
        if (alive) setBalances({ data, error: null, refreshing: false });
      },
      (err: unknown) => {
        if (alive) setBalances((s) => ({ ...s, error: errorText(err) }));
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // "Checked 12s ago" stays true while the page is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  function chooseWindow(next: UsageWindow) {
    if (next === window) return;
    setWindow(next);
    setNow(Date.now());
    // Keep the choice in the address, so a reload or a bookmark opens the same view.
    try {
      const url = new URL(globalThis.location.href);
      url.searchParams.set("window", next);
      globalThis.history.replaceState(globalThis.history.state, "", url);
    } catch {
      // Not important enough to fail over.
    }
  }

  async function refreshBalances() {
    setBalances((s) => ({ ...s, refreshing: true, error: null }));
    try {
      const data = await getAdminBalances(true);
      setBalances({ data, error: null, refreshing: false });
    } catch (err) {
      setBalances((s) => ({ ...s, refreshing: false, error: errorText(err) }));
    }
    setNow(Date.now());
  }

  const data = usage.data;
  const failedHere = usage.errorWindow === window && usage.error !== null;
  const pending = !failedHere && data !== null && data.window !== window;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="eyebrow">Owner only</p>
          <h1 className="mt-1 font-serif text-[30px] leading-tight tracking-[-0.01em]">Usage</h1>
          <p className="mt-1 text-quiet">What each key has spent, per provider and per lead. Only this computer can open this page.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href={exportUrl(window)} download className="btn btn-secondary" title={`Every ledger row ${WINDOW_PHRASES[window]}, as CSV`}>
            Export CSV
          </a>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <WindowPicker value={window} onChange={chooseWindow} />
        <span className="text-[12.5px] text-quiet" aria-live="polite">
          {pending ? "Loading…" : data ? `Windows are UTC days · updated ${timeAgo(data.generatedAt, now)}` : ""}
        </span>
      </div>

      {data === null && !failedHere ? (
        <DashboardSkeleton />
      ) : failedHere && data === null ? (
        <ErrorState
          title="Usage did not load"
          message={usage.error ?? "Please try again."}
          onRetry={() => {
            setUsage((s) => ({ ...s, error: null, errorWindow: null }));
            setRetry((n) => n + 1);
          }}
        />
      ) : data ? (
        <div className={cx("space-y-6 transition-opacity", pending && "opacity-55")} aria-busy={pending || undefined}>
          {failedHere && (
            <Notice
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setUsage((s) => ({ ...s, error: null, errorWindow: null }));
                    setRetry((n) => n + 1);
                  }}
                >
                  Try again
                </Button>
              }
            >
              Could not load {WINDOW_LABELS[window].toLowerCase()}: {usage.error}
            </Notice>
          )}
          <Panel data={data} balances={balances} onRefreshBalances={refreshBalances} now={now} />
        </div>
      ) : null}
    </div>
  );
}

function WindowPicker({ value, onChange }: { value: UsageWindow; onChange: (w: UsageWindow) => void }) {
  return (
    <div role="group" aria-label="Time window" className="inline-flex rounded-[9px] border border-hairline bg-paper p-0.5">
      {USAGE_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={w === value}
          onClick={() => onChange(w)}
          className={cx("h-8 rounded-[7px] px-3 text-[13px] transition-colors", w === value ? "bg-ink font-medium text-white" : "text-quiet hover:bg-wash hover:text-ink")}
        >
          {WINDOW_LABELS[w]}
        </button>
      ))}
    </div>
  );
}

function Panel({ data, balances, onRefreshBalances, now }: { data: AdminUsageResponse; balances: BalanceState; onRefreshBalances: () => void; now: number }) {
  const { summary } = data;
  const estimated = new Set<UsageProvider>(summary.providers.filter((p) => p.costEstimated && p.costUsd > 0).map((p) => p.provider));
  const estimatedSeries = new Set<SeriesId>([...estimated].map(seriesOf));
  const anyEstimated = estimated.size > 0;
  const phrase = WINDOW_PHRASES[data.window];

  return (
    <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Total spend" value={formatUsd(summary.totalCostUsd)} estimated={anyEstimated} sub={`Every provider, ${phrase}`} />
        <Tile label="Leads touched" value={formatCount(summary.leadsTouched)} sub={`With any usage ${phrase}`} />
        <Tile
          label="Average per lead"
          value={summary.avgCostPerLeadUsd === null ? "–" : formatUsd(summary.avgCostPerLeadUsd)}
          estimated={anyEstimated && summary.avgCostPerLeadUsd !== null}
          sub="Lead spend ÷ leads touched"
        />
        <Tile label="Not tied to a lead" value={formatUsd(summary.untaggedCostUsd)} sub="Tests and calls made without a lead" />
      </section>

      <section aria-labelledby="providers-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div>
            <h2 id="providers-title" className="font-serif text-[20px] leading-snug">
              Providers
            </h2>
            <p className="mt-0.5 text-[13px] text-quiet">One card per key: spend and calls {phrase}, then its live balance or what the ledger knows.</p>
          </div>
          <div className="flex items-center gap-3">
            {balances.data && (
              <span className="text-[12.5px] text-quiet" title={new Date(balances.data.checkedAt).toLocaleString()}>
                Balances checked {timeAgo(balances.data.checkedAt, now)}
              </span>
            )}
            <Button size="sm" onClick={onRefreshBalances} busy={balances.refreshing} disabled={!balances.data && !balances.error}>
              Refresh balances
            </Button>
          </div>
        </div>
        {balances.error && balances.data && <Notice>Could not refresh balances: {balances.error}</Notice>}
        <ProviderCards
          window={data.window}
          totals={summary.providers}
          balances={balances.data?.balances ?? null}
          balancesLoading={!balances.data && !balances.error}
          balancesError={balances.error}
          now={now}
        />
      </section>

      <Section
        id="daily-title"
        title="Daily spend"
        description={
          <>
            The last {data.daily.length} days (UTC), stacked by provider. Hover a bar for its numbers.
            {data.window !== "30d" && data.window !== "all" ? " Days outside the window are faded." : ""}
          </>
        }
      >
        <SpendChart daily={data.daily} windowFrom={data.window === "all" ? null : summary.from} estimated={estimatedSeries} />
      </Section>

      <Section
        id="leads-title"
        title="Leads"
        description={<>Cost per lead {phrase}, newest activity first. A column marked est. includes estimated costs.</>}
        flush
      >
        {data.leads.length === 0 ? (
          <p className="px-4 py-8 text-center text-quiet sm:px-5">No lead used a paid or metered service {phrase}.</p>
        ) : (
          <LeadTable leads={data.leads} estimated={estimated} now={now} />
        )}
      </Section>

      <Section id="recent-title" title="Recent calls" description={<>Every call to an outside API {phrase}, newest first.</>} flush>
        <RecentCalls rows={data.recent} truncated={data.recentTruncated} limit={RECENT_LIMIT} />
      </Section>

      <p className="text-[12.5px] leading-relaxed text-quiet">
        <Est className="mr-1 align-[1px]" /> marks a cost worked out from usage and the price table (prices as of {data.pricesAsOf}), not
        billed by the provider: Claude tokens, Apify items, and older rows filled in from before the ledger. Exa and OpenRouter report
        their own costs. Days are UTC. Live balances are read at most once a minute and are never written to the ledger.
      </p>
    </>
  );
}

function Tile({ label, value, sub, estimated }: { label: string; value: string; sub: string; estimated?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-[12.5px] text-quiet">{label}</p>
      <p className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">{value}</span>
        {estimated && <Est />}
      </p>
      <p className="mt-1 text-[12px] leading-snug text-quiet">{sub}</p>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading usage">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card p-4">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-2.5 h-6 w-20" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="card p-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-3 h-6 w-16" />
            <Skeleton className="mt-3 h-3.5 w-28" />
            <Skeleton className="mt-6 h-3.5 w-3/4" />
            <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
          </div>
        ))}
      </div>
      <div className="card p-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-4 h-[200px] w-full" />
      </div>
    </div>
  );
}
