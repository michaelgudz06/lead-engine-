"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api-client";
import { formatMs, formatUsd, unitsLine } from "@/lib/usage/format";
import { BACKFILL_OPERATION, USAGE_PROVIDERS, type CallSort, type OperationStats, type UsageProvider, type UsageRecord, type UsageWindow } from "@/lib/usage/types";
import { CALL_SORTS, CALL_SORT_LABELS, type CallsResponse } from "@/lib/usage/view";
import { formatDateTime } from "@/components/format";
import { Button, cx } from "@/components/ui";
import { getCalls, type CallFilter } from "./api";
import { Est } from "./bits";
import { SHORT_LABELS } from "./series";

/** "the newest 300", "the 300 slowest", "the 300 most expensive". */
const SHOWING: Record<CallSort, (n: string) => string> = {
  newest: (n) => `the newest ${n}`,
  slowest: (n) => `the ${n} slowest`,
  costliest: (n) => `the ${n} most expensive`,
};

interface State {
  data: CallsResponse | null;
  error: string | null;
  /** The request the error belongs to, so a new choice shows the list again. */
  errorKey: string | null;
}

function keyOf(window: UsageWindow, filter: CallFilter): string {
  return [window, filter.sort, filter.provider ?? "", filter.operation ?? ""].join("|");
}

/**
 * Every call to an outside API in the window, newest, slowest or most expensive first, each
 * with how long it took and what it cost. The server sorts and filters; the list holds at
 * most CALLS_LIMIT rows (Export CSV has them all). While a new order loads, the old rows stay
 * on screen, dimmed.
 */
export function CallList({
  window,
  filter,
  onFilter,
  operations,
}: {
  window: UsageWindow;
  filter: CallFilter;
  onFilter: (next: CallFilter) => void;
  /** The window's providers and operations, for the filters. */
  operations: OperationStats[];
}) {
  const [state, setState] = useState<State>({ data: null, error: null, errorKey: null });
  const [retry, setRetry] = useState(0);
  const key = keyOf(window, filter);

  const { sort, provider, operation } = filter;
  useEffect(() => {
    let alive = true;
    const requested = keyOf(window, { sort, provider, operation });
    getCalls(window, { sort, provider, operation }).then(
      (data) => {
        if (alive) setState({ data, error: null, errorKey: null });
      },
      (err: unknown) => {
        if (alive) setState((s) => ({ ...s, error: errorMessage(err), errorKey: requested }));
      },
    );
    return () => {
      alive = false;
    };
  }, [window, sort, provider, operation, retry]);

  const data = state.data;
  const failed = state.errorKey === key && state.error !== null;
  const pending = !failed && (data === null || keyOf(data.window, data) !== key);

  const providers = USAGE_PROVIDERS.filter((p) => p === provider || operations.some((o) => o.provider === p));
  const providerOps = provider ? [...new Set(operations.filter((o) => o.provider === provider).map((o) => o.operation))].sort() : [];
  if (operation && !providerOps.includes(operation)) providerOps.unshift(operation);
  const filtered = provider !== null || operation !== null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 pt-3.5 sm:px-5">
        <div role="group" aria-label="Order" className="inline-flex rounded-[9px] border border-hairline bg-paper p-0.5">
          {CALL_SORTS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === sort}
              onClick={() => s !== sort && onFilter({ ...filter, sort: s })}
              className={cx("h-7 rounded-[7px] px-2.5 text-[12.5px] transition-colors", s === sort ? "bg-ink font-medium text-white" : "text-quiet hover:bg-wash hover:text-ink")}
            >
              {CALL_SORT_LABELS[s]}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="calls-provider">
          Provider
        </label>
        <select
          id="calls-provider"
          className="field field-sm w-auto"
          value={provider ?? ""}
          onChange={(e) => onFilter({ ...filter, provider: (e.target.value || null) as UsageProvider | null, operation: null })}
        >
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {SHORT_LABELS[p]}
            </option>
          ))}
        </select>
        {provider && (
          <>
            <label className="sr-only" htmlFor="calls-operation">
              Operation
            </label>
            <select id="calls-operation" className="field field-sm w-auto" value={operation ?? ""} onChange={(e) => onFilter({ ...filter, operation: e.target.value || null })}>
              <option value="">All operations</option>
              {providerOps.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </>
        )}
        {filtered && (
          <Button size="sm" variant="ghost" className="text-quiet" onClick={() => onFilter({ ...filter, provider: null, operation: null })}>
            Show every call
          </Button>
        )}
        <span className="ml-auto text-[12.5px] text-quiet" aria-live="polite">
          {pending ? "Loading…" : data ? countText(data) : ""}
        </span>
      </div>

      {failed && data === null ? (
        <ErrorLine message={state.error} onRetry={() => setRetry((n) => n + 1)} />
      ) : data === null ? (
        <p className="border-t border-hairline px-4 py-8 text-center text-quiet sm:px-5">Loading calls…</p>
      ) : (
        <>
          {failed && <ErrorLine message={state.error} onRetry={() => setRetry((n) => n + 1)} />}
          {data.calls.length === 0 ? (
            <p className={cx("border-t border-hairline px-4 py-8 text-center text-quiet sm:px-5", pending && "opacity-55")}>
              {filtered ? "No calls of this kind in this window." : "No calls in this window."}
            </p>
          ) : (
            <CallTable calls={data.calls} sort={data.sort} pending={pending} />
          )}
        </>
      )}
    </div>
  );
}

function countText(data: CallsResponse): string {
  const total = data.total.toLocaleString("en-US");
  const count = data.total === 1 ? "1 call" : `${total} calls`;
  if (data.calls.length >= data.total) return count;
  return `${count} · showing ${SHOWING[data.sort](data.calls.length.toLocaleString("en-US"))} (Export CSV has them all)`;
}

function ErrorLine({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3 text-[13px] text-danger sm:px-5">
      <span>Calls did not load: {message ?? "please try again."}</span>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * The rows. On a phone the time, the lead and a failure mark move under the request, and the
 * units and result columns hide, so the duration and cost stay in view without scrolling.
 */
function CallTable({ calls, sort, pending }: { calls: UsageRecord[]; sort: CallSort; pending: boolean }) {
  const sortedBy = (column: CallSort) => (sort === column ? ("descending" as const) : undefined);
  return (
    <div className={cx("max-h-[560px] overflow-auto border-t border-hairline transition-opacity", pending && "opacity-55")} aria-busy={pending || undefined}>
      <table className="w-full text-[13px] sm:min-w-[640px] lg:min-w-[860px]">
        <thead className="sticky top-0 z-[1] bg-paper">
          <tr className="border-b border-hairline text-left text-[12px] text-quiet">
            <th scope="col" aria-sort={sortedBy("newest")} className={cx("hidden py-2.5 pl-5 pr-3 font-medium sm:table-cell", sort === "newest" && "text-ink")}>
              Time
            </th>
            <th scope="col" className="py-2.5 pl-4 pr-3 font-medium sm:pl-0">
              Request
            </th>
            <th scope="col" className="hidden py-2.5 pr-3 font-medium sm:table-cell">
              Lead
            </th>
            <th scope="col" aria-sort={sortedBy("slowest")} className={cx("py-2.5 pr-3 text-right font-medium", sort === "slowest" && "text-ink")}>
              Took
            </th>
            <th scope="col" aria-sort={sortedBy("costliest")} className={cx("py-2.5 pr-4 text-right font-medium sm:pr-3", sort === "costliest" && "text-ink")}>
              Cost
            </th>
            <th scope="col" className="hidden py-2.5 pr-3 font-medium lg:table-cell">
              Units
            </th>
            <th scope="col" className="hidden py-2.5 pr-5 font-medium sm:table-cell">
              Result
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {calls.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="hidden whitespace-nowrap py-2 pl-5 pr-3 text-quiet tabular-nums sm:table-cell" title={r.createdAt}>
                {formatDateTime(r.createdAt)}
              </td>
              <td className="py-2 pl-4 pr-3 sm:whitespace-nowrap sm:pl-0">
                {SHORT_LABELS[r.provider] ?? r.provider} <span className="text-quiet">{r.operation}</span>
                <span className="block text-[12px] text-quiet sm:hidden">
                  {formatDateTime(r.createdAt)} · <LeadCell row={r} />
                  {!r.ok && <span className="font-medium text-danger"> · Failed</span>}
                </span>
              </td>
              <td className="hidden max-w-[200px] truncate py-2 pr-3 sm:table-cell">
                <LeadCell row={r} />
              </td>
              <td className={cx("whitespace-nowrap py-2 pr-3 text-right tabular-nums", sort === "slowest" ? "font-medium" : "text-quiet")}>
                {formatMs(r.ms) || "–"}
              </td>
              <td className={cx("whitespace-nowrap py-2 pr-4 text-right tabular-nums sm:pr-3", sort === "costliest" && "font-medium")}>
                <CostCell row={r} />
              </td>
              <td className="hidden min-w-[220px] max-w-[300px] py-2 pr-3 text-quiet lg:table-cell">{unitsLine(r.units) || "–"}</td>
              <td className={cx("hidden whitespace-nowrap py-2 pr-5 sm:table-cell", r.ok ? "text-quiet" : "font-medium text-danger")}>{r.ok ? "OK" : "Failed"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeadCell({ row }: { row: UsageRecord }) {
  if (row.leadId) {
    return (
      <Link href={`/leads/${row.leadId}`} className="underline-offset-2 hover:underline">
        {row.leadName?.trim() || "Unnamed lead"}
      </Link>
    );
  }
  if (row.leadName) {
    return (
      <span className="text-quiet" title="This lead was deleted">
        {row.leadName} (deleted)
      </span>
    );
  }
  return <span className="text-quiet">Not tied to a lead</span>;
}

function CostCell({ row }: { row: UsageRecord }) {
  if (row.operation === BACKFILL_OPERATION) {
    return (
      <span title="Filled in from before the ledger began: the total of many calls, estimated">
        {formatUsd(row.costUsd)} <span className="text-[11.5px] font-normal text-quiet">(many calls)</span>
      </span>
    );
  }
  if (row.costUsd === null) return <span className="text-quiet" title="The cost of this call is not known">–</span>;
  if (row.costBasis === "free") return <span className="font-normal text-quiet">free</span>;
  return (
    <>
      {formatUsd(row.costUsd)}
      {row.costBasis === "estimated" && <Est className="ml-1 align-[1px]" />}
    </>
  );
}
