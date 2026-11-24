"use client";

import { formatCount, formatShare, formatUsd, keyUnitsLine, plural } from "@/lib/usage/format";
import { WINDOW_PHRASES } from "@/lib/usage/view";
import { USAGE_PROVIDER_LABELS, USAGE_PROVIDERS, type ProviderBalance, type ProviderTotals, type UsageWindow } from "@/lib/usage/types";
import { timeAgo } from "@/components/format";
import { Skeleton, cx } from "@/components/ui";
import { Est } from "./bits";

/** One card per provider (key): spend in the window, calls, failures, key units, and its balance. */
export function ProviderCards({
  window,
  totals,
  balances,
  balancesLoading,
  balancesError,
  now,
}: {
  window: UsageWindow;
  totals: ProviderTotals[];
  balances: ProviderBalance[] | null;
  balancesLoading: boolean;
  balancesError: string | null;
  now: number;
}) {
  const byProvider = new Map(totals.map((t) => [t.provider, t]));
  const balanceOf = new Map((balances ?? []).map((b) => [b.provider, b]));
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {USAGE_PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider}
          label={USAGE_PROVIDER_LABELS[provider]}
          window={window}
          totals={byProvider.get(provider) ?? null}
          provider={provider}
          balance={balanceOf.get(provider) ?? null}
          balanceLoading={balancesLoading && !balances}
          balanceError={balancesError}
          now={now}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  provider,
  label,
  window,
  totals,
  balance,
  balanceLoading,
  balanceError,
  now,
}: {
  provider: (typeof USAGE_PROVIDERS)[number];
  label: string;
  window: UsageWindow;
  totals: ProviderTotals | null;
  balance: ProviderBalance | null;
  balanceLoading: boolean;
  balanceError: string | null;
  now: number;
}) {
  const calls = totals?.calls ?? 0;
  const failed = totals?.failed ?? 0;
  const units = totals ? keyUnitsLine(provider, totals.units) : "";
  const off = balance?.summary === "Not configured" && calls === 0;
  return (
    <article className={cx("card flex flex-col p-4", off && "bg-wash/40")} aria-label={label}>
      <header className="flex items-start justify-between gap-3">
        <h3 className={cx("text-[14px] font-medium leading-snug", off && "text-quiet")}>{label}</h3>
        {balance && <SourceChip source={balance.source} />}
      </header>

      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className={cx("text-[22px] font-semibold leading-tight tracking-[-0.01em]", off && "text-quiet")}>{formatUsd(totals?.costUsd ?? 0)}</span>
        {totals?.costEstimated && <Est />}
      </div>
      <p className="text-[12.5px] text-quiet">Spent {WINDOW_PHRASES[window]}</p>

      <p className="mt-2.5 text-[13px]">
        {plural(calls, "call")}
        {failed > 0 ? (
          <span className="text-danger"> · {formatCount(failed)} failed</span>
        ) : calls > 0 ? (
          <span className="text-quiet"> · none failed</span>
        ) : null}
      </p>
      {units && <p className="mt-0.5 text-[13px] text-quiet">{units}</p>}

      <div className="mt-auto pt-4">
        <div className="border-t border-hairline pt-3">
          {balanceLoading ? (
            <div aria-busy="true" aria-label="Loading balance">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
            </div>
          ) : balance ? (
            <BalanceBlock balance={balance} now={now} />
          ) : (
            <p className="text-[12.5px] text-quiet">{balanceError ? `Balance did not load: ${balanceError}` : "No balance yet."}</p>
          )}
        </div>
      </div>
    </article>
  );
}

function SourceChip({ source }: { source: ProviderBalance["source"] }) {
  const text = source === "live" ? "Live" : source === "ledger" ? "Ledger" : "Unavailable";
  const title =
    source === "live" ? "Read from the provider's own API just now" : source === "ledger" ? "Derived from this app's usage ledger" : "No balance could be read";
  return (
    <span title={title} className={cx("chip shrink-0", source === "live" ? "border-ink/25" : "text-quiet")}>
      {source === "live" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />}
      {text}
    </span>
  );
}

function BalanceBlock({ balance, now }: { balance: ProviderBalance; now: number }) {
  const share = balance.usedShare;
  const high = typeof share === "number" && share >= 0.9;
  return (
    <div>
      <p className={cx("text-[13.5px] font-medium leading-snug", balance.source === "unavailable" && "text-quiet")}>{balance.summary}</p>
      {typeof share === "number" && (
        <div className="mt-2 flex items-center gap-2">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-hairline"
            role="meter"
            aria-label="Share used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
          >
            <div className={cx("h-full rounded-full", high ? "bg-danger" : "bg-ink")} style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.round(share * 100))}%` }} />
          </div>
          <span className={cx("shrink-0 text-[11.5px] tabular-nums", high ? "text-danger" : "text-quiet")}>{formatShare(share)} used</span>
        </div>
      )}
      {balance.note && <p className="mt-1.5 text-[12.5px] leading-snug text-quiet">{balance.note}</p>}
      <p className="mt-1.5 text-[11.5px] text-quiet" title={new Date(balance.checkedAt).toLocaleString()}>
        Checked {timeAgo(balance.checkedAt, now)}
      </p>
    </div>
  );
}
