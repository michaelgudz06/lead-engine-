"use client";

import Link from "next/link";
import { formatUsd, mainUnit } from "@/lib/usage/format";
import { USAGE_PROVIDERS, type LeadUsage, type UsageProvider } from "@/lib/usage/types";
import { formatDateTime, timeAgo } from "@/components/format";
import { cx } from "@/components/ui";
import { Est } from "./bits";
import { SHORT_LABELS } from "./series";

/**
 * Cost per lead in the window: lead, company, last use, total, then one column per provider
 * that any listed lead used (cost, and its main unit underneath). Usage of deleted leads is
 * one row at the end of its place in time; usage never tied to a lead is in the tiles above.
 */
export function LeadTable({ leads, estimated, now }: { leads: LeadUsage[]; estimated: ReadonlySet<UsageProvider>; now: number }) {
  const columns = USAGE_PROVIDERS.filter((p) => leads.some((l) => l.byProvider[p]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]" style={{ minWidth: 520 + columns.length * 96 }}>
        <thead>
          <tr className="border-b border-hairline text-left text-[12px] text-quiet">
            <th scope="col" className="py-2.5 pl-4 pr-3 font-medium sm:pl-5">
              Lead
            </th>
            <th scope="col" className="py-2.5 pr-3 font-medium">
              Company
            </th>
            <th scope="col" className="py-2.5 pr-3 font-medium">
              Last used
            </th>
            <th scope="col" className="py-2.5 pr-3 text-right font-medium">
              Total
            </th>
            {columns.map((p) => (
              <th key={p} scope="col" className="py-2.5 pr-3 text-right font-medium last:pr-4 sm:last:pr-5">
                {SHORT_LABELS[p]}
                {estimated.has(p) && <span className="ml-1 font-normal">est.</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {leads.map((lead) => {
            const rowEstimated = columns.some((p) => estimated.has(p) && (lead.byProvider[p]?.costUsd ?? 0) > 0);
            return (
              <tr key={lead.leadId ?? "deleted"} className="align-top transition-colors hover:bg-wash/60">
                <td className="max-w-[220px] py-2.5 pl-4 pr-3 sm:pl-5">
                  {lead.leadId ? (
                    <Link href={`/leads/${lead.leadId}`} className="block truncate font-medium underline-offset-2 hover:underline">
                      {lead.leadName?.trim() || "Unnamed lead"}
                    </Link>
                  ) : (
                    <span className="block truncate text-quiet" title="Usage of leads that have since been deleted">
                      Deleted leads
                    </span>
                  )}
                </td>
                <td className="max-w-[180px] truncate py-2.5 pr-3 text-quiet">{lead.company?.trim() || "–"}</td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-quiet" title={formatDateTime(lead.lastAt)}>
                  {timeAgo(lead.lastAt, now)}
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-right font-medium tabular-nums">
                  {formatUsd(lead.totalCostUsd)}
                  {rowEstimated && <Est className="ml-1 align-[1px]" />}
                </td>
                {columns.map((p) => {
                  const cell = lead.byProvider[p];
                  const unit = cell ? mainUnit(p, cell.units) : "";
                  return (
                    <td key={p} className={cx("whitespace-nowrap py-2.5 pr-3 text-right tabular-nums last:pr-4 sm:last:pr-5")}>
                      {cell ? (
                        <>
                          <div>{formatUsd(cell.costUsd)}</div>
                          {unit && <div className="text-[11.5px] text-quiet">{unit}</div>}
                        </>
                      ) : (
                        <span className="text-quiet">–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
