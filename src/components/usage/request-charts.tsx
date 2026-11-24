"use client";

import { formatMs, formatUsd, plural } from "@/lib/usage/format";
import type { CallSort, OperationStats } from "@/lib/usage/types";
import { cx } from "@/components/ui";
import { Est } from "./bits";
import { CHART } from "./chart-kit";
import { SHORT_LABELS } from "./series";

/**
 * Time and cost per request: one row per provider and operation in the window, a ranked
 * horizontal bar beside the figures it draws. Every figure is printed in its row, so the
 * table is its own table view; bars run from one baseline on the left, ink, with a 4px
 * rounded data end. On a phone the bar and the secondary figures drop under the name.
 * Choosing a row lists those calls in the call list below.
 */

type ShowCalls = (op: OperationStats, sort: CallSort) => void;

function RequestName({ op, sort, onShowCalls }: { op: OperationStats; sort: CallSort; onShowCalls: ShowCalls }) {
  const name = `${SHORT_LABELS[op.provider] ?? op.provider} ${op.operation}`;
  return (
    <button
      type="button"
      onClick={() => onShowCalls(op, sort)}
      title={sort === "slowest" ? `Show the slowest ${name} calls` : `Show the most expensive ${name} calls`}
      className="max-w-full truncate rounded text-left underline-offset-2 hover:underline"
    >
      <span className="font-medium">{SHORT_LABELS[op.provider] ?? op.provider}</span> <span className="text-quiet">{op.operation}</span>
    </button>
  );
}

/** A horizontal bar from the left baseline, `share` of the track wide, rounded at its data end. */
function Bar({ share }: { share: number }) {
  if (!(share > 0)) return null;
  return <div className="absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-r-[4px]" style={{ width: `${Math.max(0.6, share * 100)}%`, background: CHART.ink }} />;
}

/** The median as a bar, and a whisker from its end to the 95th percentile. Shares of the longest whisker. */
function TimeBar({ median, p95 }: { median: number; p95: number }) {
  return (
    <div className="relative h-4" aria-hidden>
      {p95 > median && (
        <>
          <div className="absolute top-1/2 h-[2px] -translate-y-1/2" style={{ left: `${median * 100}%`, width: `${(p95 - median) * 100}%`, background: CHART.secondary }} />
          <div className="absolute top-1/2 h-2.5 w-[2px] -translate-x-full -translate-y-1/2" style={{ left: `${p95 * 100}%`, background: CHART.secondary }} />
        </>
      )}
      <Bar share={median} />
    </div>
  );
}

function CostBar({ share }: { share: number }) {
  return (
    <div className="relative h-4" aria-hidden>
      <Bar share={share} />
    </div>
  );
}

const pct = (value: number | null, max: number) => (value === null || max <= 0 ? 0 : Math.min(1, value / max));

const TH = "py-2.5 pr-3 font-medium";
const TD = "py-2 pr-3 align-top sm:align-middle";

// ------------------------------------------------------------------ time per request

export function TimePerRequest({ operations, onShowCalls }: { operations: OperationStats[]; onShowCalls: ShowCalls }) {
  const rows = operations
    .filter((o) => o.timedCalls > 0 && o.medianMs !== null)
    .sort((a, b) => (b.medianMs ?? 0) - (a.medianMs ?? 0) || (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
  if (!rows.length) return <p className="px-4 py-8 text-center text-quiet sm:px-5">No call recorded how long it took in this window.</p>;
  const max = Math.max(1, ...rows.map((o) => o.p95Ms ?? o.medianMs ?? 0));

  return (
    <div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 pt-3.5 text-[12.5px] sm:px-5" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-3.5 rounded-r-[3px]" style={{ background: CHART.ink }} />
          Median: half the calls were quicker
        </li>
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width="16" height="10" className="block">
            <line x1="0" x2="14" y1="5" y2="5" stroke={CHART.secondary} strokeWidth="2" />
            <line x1="14" x2="14" y1="0" y2="10" stroke={CHART.secondary} strokeWidth="2" />
          </svg>
          95th percentile: 1 call in 20 took longer
        </li>
      </ul>
      <table className="mt-1 w-full text-[13px]">
        <thead>
          <tr className="border-b border-hairline text-left text-[12px] text-quiet">
            <th scope="col" className={cx(TH, "pl-4 sm:pl-5")}>
              Request
            </th>
            <th scope="col" className={cx(TH, "hidden w-[38%] sm:table-cell")}>
              <span className="sr-only">Median and 95th percentile as bars</span>
            </th>
            <th scope="col" className={cx(TH, "pr-4 text-right sm:pr-3")}>
              Median
            </th>
            <th scope="col" className={cx(TH, "hidden text-right sm:table-cell")}>
              95th pct.
            </th>
            <th scope="col" className={cx(TH, "hidden pr-5 text-right sm:table-cell")}>
              Calls
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((op) => {
            const m = pct(op.medianMs, max);
            const p = Math.max(m, pct(op.p95Ms, max));
            const calls = (
              <>
                {plural(op.timedCalls, "call")}
                {op.failed > 0 && <span className="text-danger"> ({op.failed} failed)</span>}
              </>
            );
            return (
              <tr key={`${op.provider}:${op.operation}`} className="transition-colors hover:bg-wash/60">
                <td className={cx(TD, "w-full max-w-0 pl-4 sm:w-[30%] sm:pl-5")}>
                  <RequestName op={op} sort="slowest" onShowCalls={onShowCalls} />
                  <div className="mt-1 sm:hidden">
                    <TimeBar median={m} p95={p} />
                    <p className="mt-0.5 text-[12px] text-quiet">
                      95th pct. {formatMs(op.p95Ms)} · {calls}
                    </p>
                  </div>
                </td>
                <td className={cx(TD, "hidden sm:table-cell")}>
                  <TimeBar median={m} p95={p} />
                </td>
                <td className={cx(TD, "whitespace-nowrap pr-4 text-right font-medium tabular-nums sm:pr-3")} title={op.maxMs !== null ? `Slowest call: ${formatMs(op.maxMs)}` : undefined}>
                  {formatMs(op.medianMs)}
                </td>
                <td className={cx(TD, "hidden whitespace-nowrap text-right text-quiet tabular-nums sm:table-cell")}>{formatMs(op.p95Ms)}</td>
                <td className={cx(TD, "hidden whitespace-nowrap pr-5 text-right tabular-nums sm:table-cell")}>
                  {op.timedCalls.toLocaleString("en-US")}
                  {op.failed > 0 && <span className="text-danger"> ({op.failed} failed)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ cost per request

export function CostPerRequest({ operations, phrase, onShowCalls }: { operations: OperationStats[]; phrase: string; onShowCalls: ShowCalls }) {
  const paid = operations.filter((o) => o.pricedCalls > 0 && o.totalCostUsd > 0).sort((a, b) => (b.avgCostUsd ?? 0) - (a.avgCostUsd ?? 0) || b.totalCostUsd - a.totalCostUsd);
  const free = operations.filter((o) => o.pricedCalls > 0 && o.totalCostUsd === 0);
  const unknown = operations.filter((o) => o.pricedCalls === 0);
  const maxAvg = Math.max(0, ...paid.map((o) => o.avgCostUsd ?? 0));
  const maxTotal = Math.max(0, ...paid.map((o) => o.totalCostUsd));
  const spend = paid.reduce((s, o) => s + o.totalCostUsd, 0);

  return (
    <div>
      {paid.length === 0 ? (
        <p className="px-4 py-8 text-center text-quiet sm:px-5">No paid call {phrase}.</p>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-left text-[12px] text-quiet">
              <th scope="col" className={cx(TH, "pl-4 sm:pl-5")}>
                Request
              </th>
              <th scope="col" className={cx(TH, "hidden w-[17%] sm:table-cell")}>
                Average per call
              </th>
              <th scope="col" className={cx(TH, "pr-4 text-right sm:pr-4")}>
                <span className="sm:sr-only">Average per call</span>
              </th>
              <th scope="col" className={cx(TH, "hidden w-[17%] sm:table-cell")}>
                Total {phrase}
              </th>
              <th scope="col" className={cx(TH, "hidden sm:table-cell")}>
                <span className="sr-only">Total {phrase}</span>
              </th>
              <th scope="col" className={cx(TH, "hidden pr-5 text-right sm:table-cell")}>
                Calls
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {paid.map((op) => {
              const share = spend > 0 ? shareText(op.totalCostUsd / spend) : "";
              return (
                <tr key={`${op.provider}:${op.operation}`} className="transition-colors hover:bg-wash/60">
                  <td className={cx(TD, "w-full max-w-0 pl-4 sm:w-[30%] sm:pl-5")}>
                    <RequestName op={op} sort="costliest" onShowCalls={onShowCalls} />
                    <div className="mt-1 sm:hidden">
                      <CostBar share={pct(op.avgCostUsd, maxAvg)} />
                      <p className="mt-0.5 text-[12px] text-quiet">
                        {formatUsd(op.totalCostUsd)} in total{share ? ` (${share})` : ""} · {plural(op.pricedCalls, "call")}
                      </p>
                    </div>
                  </td>
                  <td className={cx(TD, "hidden sm:table-cell")}>
                    <CostBar share={pct(op.avgCostUsd, maxAvg)} />
                  </td>
                  <td
                    className={cx(TD, "whitespace-nowrap pr-4 text-right font-medium tabular-nums")}
                    title={op.maxCostUsd !== null ? `Most expensive call: ${formatUsd(op.maxCostUsd)}` : undefined}
                  >
                    {op.costEstimated && <Est className="mr-1 align-[1px]" />}
                    {formatUsd(op.avgCostUsd)}
                  </td>
                  <td className={cx(TD, "hidden sm:table-cell")}>
                    <CostBar share={pct(op.totalCostUsd, maxTotal)} />
                  </td>
                  <td className={cx(TD, "hidden whitespace-nowrap text-right tabular-nums sm:table-cell")}>
                    {formatUsd(op.totalCostUsd)}
                    <span className="ml-1 inline-block w-8 text-left text-[11.5px] text-quiet">{share}</span>
                  </td>
                  <td
                    className={cx(TD, "hidden whitespace-nowrap pr-5 text-right tabular-nums sm:table-cell")}
                    title={op.pricedCalls < op.calls ? `${op.calls - op.pricedCalls} more without a known cost` : undefined}
                  >
                    {op.pricedCalls.toLocaleString("en-US")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(free.length > 0 || unknown.length > 0) && (
        <div className={cx("space-y-1 px-4 pb-3.5 text-[12.5px] leading-relaxed text-quiet sm:px-5", paid.length ? "border-t border-hairline pt-3" : "")}>
          {free.length > 0 && (
            <p>
              <span className="text-ink">No charge {phrase}:</span> {groupNames(free)}.
            </p>
          )}
          {unknown.length > 0 && (
            <p>
              <span className="text-ink">Cost not recorded:</span> {groupNames(unknown)}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A share of the window's spend: "31%", "<1%". */
function shareText(share: number): string {
  if (!(share > 0)) return "";
  return share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** "Apollo job-postings, org-enrich (15 calls) · Hugging Face datasets, models (19 calls)": operations by provider. */
function groupNames(ops: OperationStats[]): string {
  const byProvider = new Map<string, { names: string[]; calls: number }>();
  for (const op of ops) {
    const label = SHORT_LABELS[op.provider] ?? op.provider;
    const entry = byProvider.get(label) ?? { names: [], calls: 0 };
    entry.names.push(op.operation);
    entry.calls += op.calls;
    byProvider.set(label, entry);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, { names, calls }]) => `${label} ${names.sort().join(", ")} (${plural(calls, "call")})`)
    .join(" · ");
}
