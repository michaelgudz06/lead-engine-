"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { listLeads } from "@/lib/api-client";
import { sortNeedsYouFirst } from "@/lib/next-action";
import type { Lead } from "@/lib/types";
import { isRunning, leadName, settleLostRun, timeAgo, titleAtCompany } from "@/components/format";
import { NoLinkedinChip } from "@/components/lead/contact";
import { leadAction, notResearched } from "@/components/lead/status";
import { ButtonLink, EmptyState, ErrorState, Notice, PageTitle, Skeleton, StageChip, cx } from "@/components/ui";
import { useLoad } from "@/components/use-load";

export default function LeadsPage() {
  // Refresh while any lead is being researched so its row updates by itself.
  const { data, error, loading, reload } = useLoad(listLeads, (leads) => (leads?.some((l) => isRunning(l)) ? 4000 : null));
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => sortNeedsYouFirst((data ?? []).map(settleLostRun)), [data]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((l) => [l.name, l.title, l.companyName, l.linkedinSlug, l.email, l.owner].some((v) => v?.toLowerCase().includes(q)));
  }, [sorted, query]);

  const total = data?.length ?? 0;

  return (
    <>
      <PageTitle title="Leads" subtitle="Needs you first: replies, then due follow-ups, then drafts ready to send." actions={<ButtonLink href="/leads/import">Import</ButtonLink>} />

      {loading ? (
        <ListSkeleton />
      ) : !data ? (
        <ErrorState title="Leads did not load" message={error ?? "Please try again."} onRetry={reload} />
      ) : total === 0 ? (
        <EmptyState
          title="No leads yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <ButtonLink href="/leads/new" variant="primary">+ New lead</ButtonLink>
              <ButtonLink href="/leads/import">Import</ButtonLink>
            </div>
          }
        >
          Add one person by their LinkedIn URL, or import a list from a CSV file, a Google Sheet or HubSpot. The agent researches each person and their company, then drafts outreach for you to review and send.
        </EmptyState>
      ) : (
        <>
          {error && (
            <div className="mb-4">
              <Notice>Could not refresh: {error}</Notice>
            </div>
          )}
          <div className="mb-3 flex items-center gap-3">
            <div className="relative w-full max-w-sm">
              <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-quiet" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              <input
                type="search"
                className="field pl-8.5"
                style={{ paddingLeft: 32 }}
                placeholder="Search by name, company or title"
                aria-label="Search leads"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <span className="ml-auto shrink-0 text-[13px] text-quiet">
              {visible.length === total ? `${total} ${total === 1 ? "lead" : "leads"}` : `${visible.length} of ${total}`}
            </span>
          </div>

          {visible.length === 0 ? (
            <div className="card px-6 py-10 text-center text-quiet">
              No leads match “{query.trim()}”.{" "}
              <button type="button" className="text-ink underline underline-offset-2" onClick={() => setQuery("")}>
                Clear search
              </button>
            </div>
          ) : (
            <ul className="card divide-y divide-hairline overflow-hidden">
              {visible.map((lead) => (
                <LeadRow key={lead.id} lead={lead} />
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function LeadRow({ lead }: { lead: Lead }) {
  const action = leadAction(lead);
  const sub = titleAtCompany(lead);
  return (
    <li>
      <Link href={`/leads/${lead.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3.5 transition-colors hover:bg-wash focus-visible:bg-wash sm:grid-cols-[minmax(0,1fr)_auto_190px] sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{leadName(lead)}</span>
            {!lead.linkedinUrl && <NoLinkedinChip className="shrink-0" />}
          </div>
          <div className="truncate text-[13.5px] text-quiet">{sub || (notResearched(lead) ? "Details appear after research" : "Details appear once research finishes")}</div>
        </div>
        <div className="row-span-1 justify-self-end">
          <StageChip stage={lead.stage} />
        </div>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-1 sm:justify-end">
          {isRunning(lead) ? <span className="spinner" aria-hidden /> : <span aria-hidden className={cx("h-1.5 w-1.5 shrink-0 rounded-full", action.tone === "urgent" ? "bg-danger" : action.tone === "normal" ? "bg-ink" : "bg-hairline")} />}
          <span className={cx("truncate text-[13.5px]", action.tone === "urgent" ? "font-medium text-danger" : action.tone === "normal" ? "text-ink" : "text-quiet")}>{action.label}</span>
          <span className="ml-auto text-[12.5px] text-quiet sm:hidden">{timeAgo(lead.updatedAt)}</span>
        </div>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading leads">
      <Skeleton className="mb-3 h-9 w-full max-w-sm" />
      <div className="card divide-y divide-hairline">
        {[62, 48, 55, 40, 58].map((w, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4" style={{ width: `${w * 0.5}%` }} />
              <Skeleton className="mt-2 h-3.5" style={{ width: `${w}%` }} />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
