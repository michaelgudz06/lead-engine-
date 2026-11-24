"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api-client";
import { formatCount, formatUsd } from "@/lib/usage/format";
import type { CallSort, OperationStats, UsageProvider, UsageWindow } from "@/lib/usage/types";
import { BALANCE_MIN_REFRESH_MS, DEFAULT_CALL_SORT, USAGE_WINDOWS, WINDOW_LABELS, WINDOW_PHRASES, type BalancesResponse, type UsageResponse } from "@/lib/usage/view";
import { timeAgo } from "@/components/format";
import { Button, ErrorState, Notice, PageTitle, Skeleton, cx } from "@/components/ui";
import { exportUrl, getBalances, getUsage, type CallFilter } from "./api";
import { Est, Section } from "./bits";
import { CallList } from "./calls";
import { LeadTable } from "./lead-table";
import { ProviderCards } from "./provider-cards";
import { CostPerRequest, TimePerRequest } from "./request-charts";
import { RunsChart, runsSummary } from "./runs-chart";
import { seriesOf, type SeriesId } from "./series";
import { SpendChart } from "./spend-chart";

interface UsageState {
  data: UsageResponse | null;
  error: string | null;
  /** The window the error belongs to, so switching windows shows the frame again. */
  errorWindow: UsageWindow | null;
}

interface BalanceState {
  data: BalancesResponse | null;
  error: string | null;
  refreshing: boolean;
  /** This browser's time from which a refresh would make new checks. */
  refreshAt: number;
}

/**
 * A balance answer as it arrives. The wait for the next refresh is never longer than the
 * server's limit, so a browser clock that runs behind cannot stretch it (one that runs ahead
 * only gets the cached answer a little early).
 */
function received(data: BalancesResponse): BalanceState {
  const wait = Math.min(BALANCE_MIN_REFRESH_MS, Math.max(0, Date.parse(data.refreshableAt) - Date.now()));
  return { data, error: null, refreshing: false, refreshAt: Date.now() + (Number.isFinite(wait) ? wait : 0) };
}

/**
 * The Usage tab (/usage). One filter row (the window) scopes everything below it; the daily
 * chart always shows 30 days and fades the days outside the window. While a new window
 * loads, the previous numbers stay on screen, dimmed, so nothing jumps. Choosing a request in
 * the time or cost table lists those calls at the bottom, slowest or most expensive first.
 */
export function UsageDashboard({ initialWindow }: { initialWindow: UsageWindow }) {
  const [window, setWindow] = useState<UsageWindow>(initialWindow);
  const [usage, setUsage] = useState<UsageState>({ data: null, error: null, errorWindow: null });
  const [retry, setRetry] = useState(0);
  const [balances, setBalances] = useState<BalanceState>({ data: null, error: null, refreshing: false, refreshAt: 0 });
  const [callFilter, setCallFilter] = useState<CallFilter>({ sort: DEFAULT_CALL_SORT, provider: null, operation: null });
  const [now, setNow] = useState(() => Date.now());
  const callsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getUsage(window).then(
      (data) => {
        if (alive) setUsage({ data, error: null, errorWindow: null });
      },
      (err: unknown) => {
        if (alive) setUsage((s) => ({ ...s, error: errorMessage(err), errorWindow: window }));
      },
    );
    return () => {
      alive = false;
    };
  }, [window, retry]);

  useEffect(() => {
    let alive = true;
    getBalances(false).then(
      (data) => {
        if (alive) setBalances(received(data));
      },
      (err: unknown) => {
        if (alive) setBalances((s) => ({ ...s, error: errorMessage(err) }));
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

  // The server answers a refresh from its cache until refreshableAt: enable the button then.
  const { refreshAt } = balances;
  useEffect(() => {
    const wait = refreshAt - Date.now();
    if (!(wait > 0)) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 100);
    return () => clearTimeout(timer);
  }, [refreshAt]);

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
      setBalances(received(await getBalances(true)));
    } catch (err) {
      setBalances((s) => ({ ...s, refreshing: false, error: errorMessage(err) }));
    }
    setNow(Date.now());
  }

  function showCalls(op: OperationStats, sort: CallSort) {
    setCallFilter({ sort, provider: op.provider, operation: op.operation });
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    callsRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  const data = usage.data;
  const failedHere = usage.errorWindow === window && usage.error !== null;
  const pending = !failedHere && data !== null && data.window !== window;

  return (
    <div className="space-y-6">
      <PageTitle
        title="Usage"
        subtitle="What each key has spent and how long its calls took: per provider, per request, per research run and per lead."
        actions={
          <a href={exportUrl(window)} download className="btn btn-secondary" title={`Every ledger row ${WINDOW_PHRASES[window]}, as CSV`}>
            Export CSV
          </a>
        }
      />

      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
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
          <Panel
            data={data}
            balances={balances}
            canRefresh={now >= refreshAt}
            onRefreshBalances={refreshBalances}
            now={now}
            onShowCalls={showCalls}
          />
          {/* Where choosing a request scrolls to, clear of the sticky header. */}
          <div ref={callsRef} className="scroll-mt-32">
            <Section
              id="calls-title"
              title="Calls"
              description={<>Every call to an outside API {WINDOW_PHRASES[window]}, with how long it took and what it cost.</>}
              flush
            >
              <CallList window={window} filter={callFilter} onFilter={setCallFilter} operations={data.operations} />
            </Section>
          </div>
          <p className="text-[12.5px] leading-relaxed text-quiet">
            <Est className="mr-1 align-[1px]" /> marks a cost worked out from usage and the price table (prices as of {data.pricesAsOf}), not
            billed by the provider: Claude tokens, Apify items, and older rows filled in from before the ledger. Exa and OpenRouter report
            their own costs. Durations are measured by this app around each call. Days are UTC. Live balances are checked at most once a
            minute, or every 30 seconds with Refresh balances, and are never written to the ledger.
          </p>
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

function Panel({
  data,
  balances,
  canRefresh,
  onRefreshBalances,
  now,
  onShowCalls,
}: {
  data: UsageResponse;
  balances: BalanceState;
  canRefresh: boolean;
  onRefreshBalances: () => void;
  now: number;
  onShowCalls: (op: OperationStats, sort: CallSort) => void;
}) {
  const { summary } = data;
  const estimated = new Set<UsageProvider>(summary.providers.filter((p) => p.costEstimated && p.costUsd > 0).map((p) => p.provider));
  const estimatedSeries = new Set<SeriesId>([...estimated].map(seriesOf));
  const anyEstimated = estimated.size > 0;
  const phrase = WINDOW_PHRASES[data.window];
  const summaryLine = runsSummary(data.runs);

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
            <Button
              size="sm"
              onClick={onRefreshBalances}
              busy={balances.refreshing}
              disabled={!balances.data && !balances.error}
              disabledReason={balances.data && !balances.refreshing && !canRefresh ? "Balances were checked less than 30 seconds ago." : null}
              tipEnd
            >
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
            US dollars per UTC day for the last {data.daily.length} days, stacked by provider. Hover a bar for its numbers.
            {data.window !== "30d" && data.window !== "all" ? " Days outside the window are faded." : ""}
          </>
        }
      >
        <SpendChart daily={data.daily} windowFrom={data.window === "all" ? null : summary.from} estimated={estimatedSeries} />
      </Section>

      <Section
        id="runs-title"
        title="Research runs"
        description={
          data.runs.length ? (
            <>
              How long each research and steer run {phrase} took, and what its calls cost.
              {data.runsTotal > data.runs.length ? ` The newest ${data.runs.length} of ${data.runsTotal}.` : ""} {summaryLine} Select a run to open
              its lead.
            </>
          ) : (
            <>How long each research and steer run took, and what its calls cost.</>
          )
        }
      >
        {data.runs.length ? <RunsChart runs={data.runs} /> : <p className="py-6 text-center text-quiet">No research runs {phrase}.</p>}
      </Section>

      <Section
        id="time-title"
        title="Time per request"
        description={<>How long each kind of call took {phrase}, slowest first, as the ledger timed it. Choose one to list its slowest calls.</>}
        flush
      >
        <TimePerRequest operations={data.operations} onShowCalls={onShowCalls} />
      </Section>

      <Section
        id="cost-title"
        title="Cost per request"
        description={<>What each kind of call cost {phrase}, in US dollars: the average per call and the total. Choose one to list its most expensive calls.</>}
        flush
      >
        <CostPerRequest operations={data.operations} phrase={phrase} onShowCalls={onShowCalls} />
      </Section>

      <Section
        id="leads-title"
        title="Cost per lead"
        description={<>What each lead cost {phrase}, newest activity first. A column marked est. includes estimated costs.</>}
        flush
      >
        {data.leads.length === 0 ? (
          <p className="px-4 py-8 text-center text-quiet sm:px-5">No lead used a paid or metered service {phrase}.</p>
        ) : (
          <LeadTable leads={data.leads} estimated={estimated} now={now} />
        )}
      </Section>
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
