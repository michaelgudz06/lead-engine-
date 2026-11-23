"use client";

import Link from "next/link";
import { useState } from "react";
import { formatMs, formatUsd, unitsLine } from "@/lib/admin/format";
import { USAGE_PROVIDERS, type UsageProvider, type UsageRecord } from "@/lib/usage/types";
import { formatDateTime } from "@/components/format";
import { cx } from "@/components/ui";
import { Est } from "./bits";
import { SHORT_LABELS } from "./series";

/** The latest ledger rows in the window, newest first, with a provider filter. */
export function RecentCalls({ rows, truncated, limit }: { rows: UsageRecord[]; truncated: boolean; limit: number }) {
  const [provider, setProvider] = useState<UsageProvider | "all">("all");
  const present = USAGE_PROVIDERS.filter((p) => rows.some((r) => r.provider === p));
  // A provider picked for an earlier window may have no rows in this one: show them all again.
  const active = provider !== "all" && present.includes(provider) ? provider : "all";
  const visible = active === "all" ? rows : rows.filter((r) => r.provider === active);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 pt-3.5 sm:px-5">
        <label htmlFor="recent-provider" className="text-[13px] text-quiet">
          Provider
        </label>
        <select
          id="recent-provider"
          className="field field-sm w-auto"
          value={active}
          onChange={(e) => setProvider(e.target.value as UsageProvider | "all")}
          disabled={!present.length}
        >
          <option value="all">All providers</option>
          {present.map((p) => (
            <option key={p} value={p}>
              {SHORT_LABELS[p]}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[12.5px] text-quiet">
          {visible.length === 1 ? "1 call" : `${visible.length.toLocaleString("en-US")} calls`}
          {truncated ? ` (the latest ${limit}; Export CSV has them all)` : ""}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="border-t border-hairline px-4 py-8 text-center text-quiet sm:px-5">No calls in this window.</p>
      ) : (
        <div className="max-h-[560px] overflow-auto border-t border-hairline">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="sticky top-0 z-[1] bg-paper">
              <tr className="border-b border-hairline text-left text-[12px] text-quiet">
                <th scope="col" className="py-2.5 pl-4 pr-3 font-medium sm:pl-5">
                  Time
                </th>
                <th scope="col" className="py-2.5 pr-3 font-medium">
                  Provider
                </th>
                <th scope="col" className="py-2.5 pr-3 font-medium">
                  Operation
                </th>
                <th scope="col" className="py-2.5 pr-3 font-medium">
                  Lead
                </th>
                <th scope="col" className="py-2.5 pr-3 font-medium">
                  Units
                </th>
                <th scope="col" className="py-2.5 pr-3 text-right font-medium">
                  Cost
                </th>
                <th scope="col" className="py-2.5 pr-3 font-medium">
                  Result
                </th>
                <th scope="col" className="py-2.5 pr-4 text-right font-medium sm:pr-5">
                  Took
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {visible.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap py-2 pl-4 pr-3 text-quiet tabular-nums sm:pl-5" title={r.createdAt}>
                    {formatDateTime(r.createdAt)}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">{SHORT_LABELS[r.provider] ?? r.provider}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-quiet">{r.operation}</td>
                  <td className="max-w-[200px] truncate py-2 pr-3">
                    {r.leadId ? (
                      <Link href={`/leads/${r.leadId}`} className="underline-offset-2 hover:underline">
                        {r.leadName?.trim() || "Unnamed lead"}
                      </Link>
                    ) : r.leadName ? (
                      <span className="text-quiet" title="This lead was deleted">
                        {r.leadName} (deleted)
                      </span>
                    ) : (
                      <span className="text-quiet">Not tied to a lead</span>
                    )}
                  </td>
                  <td className="max-w-[260px] py-2 pr-3 text-quiet">{unitsLine(r.units) || "–"}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">
                    <CostCell row={r} />
                  </td>
                  <td className={cx("whitespace-nowrap py-2 pr-3", r.ok ? "text-quiet" : "font-medium text-danger")}>{r.ok ? "OK" : "Failed"}</td>
                  <td className="whitespace-nowrap py-2 pr-4 text-right text-quiet tabular-nums sm:pr-5">{formatMs(r.ms) || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CostCell({ row }: { row: UsageRecord }) {
  if (row.costUsd === null) return <span className="text-quiet" title="The cost of this call is not known">–</span>;
  if (row.costBasis === "free") return <span className="text-quiet">free</span>;
  return (
    <>
      {formatUsd(row.costUsd)}
      {row.costBasis === "estimated" && <Est className="ml-1 align-[1px]" />}
    </>
  );
}
