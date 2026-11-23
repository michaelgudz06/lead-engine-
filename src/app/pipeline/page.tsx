"use client";

import Link from "next/link";
import { useState } from "react";
import { track } from "@/lib/analytics";
import { errorMessage, listLeads, updateLead } from "@/lib/api-client";
import { nextAction, sortNeedsYouFirst } from "@/lib/next-action";
import { STAGES, STAGE_LABELS, type Lead, type Stage } from "@/lib/types";
import { isRunning, leadName, settleLostRun, titleAtCompany } from "@/components/format";
import { ButtonLink, EmptyState, ErrorState, Notice, PageTitle, Skeleton, StageSelect, cx } from "@/components/ui";
import { useLoad } from "@/components/use-load";

export default function PipelinePage() {
  const { data, error, loading, reload, setData } = useLoad(listLeads, (leads) => (leads?.some((l) => isRunning(l)) ? 4000 : null));
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moving, setMoving] = useState<Record<string, boolean>>({});

  async function move(lead: Lead, stage: Stage) {
    if (stage === lead.stage) return;
    setMoveError(null);
    setMoving((m) => ({ ...m, [lead.id]: true }));
    // Move the card straight away; put it back if the server says no.
    setData((prev) => prev?.map((l) => (l.id === lead.id ? { ...l, stage } : l)) ?? prev);
    try {
      const saved = await updateLead(lead.id, { stage });
      setData((prev) => prev?.map((l) => (l.id === lead.id ? saved : l)) ?? prev);
      track("stage_changed", { leadId: lead.id, from: lead.stage, to: stage, surface: "pipeline" });
    } catch (err) {
      setData((prev) => prev?.map((l) => (l.id === lead.id ? { ...l, stage: lead.stage } : l)) ?? prev);
      setMoveError(`Could not move ${leadName(lead)}: ${errorMessage(err)}`);
    } finally {
      setMoving((m) => ({ ...m, [lead.id]: false }));
    }
  }

  const sorted = sortNeedsYouFirst((data ?? []).map(settleLostRun));

  return (
    <>
      <PageTitle title="Pipeline" subtitle="Every lead by stage. Change a card's stage to move it." />

      {loading ? (
        <div className="grid gap-3 md:grid-flow-col md:auto-cols-[232px] md:overflow-hidden" aria-busy="true" aria-label="Loading pipeline">
          {[2, 1, 3, 1, 2].map((n, i) => (
            <div key={i}>
              <Skeleton className="mb-3 h-4 w-24" />
              <div className="space-y-2">
                {Array.from({ length: n }, (_, j) => (
                  <Skeleton key={j} className="h-[104px] rounded-[10px]" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : !data ? (
        <ErrorState title="The pipeline did not load" message={error ?? "Please try again."} onRetry={reload} />
      ) : data.length === 0 ? (
        <EmptyState title="Nothing in the pipeline yet" action={<ButtonLink href="/leads/new" variant="primary">+ New lead</ButtonLink>}>
          Leads appear here by stage once you add them.
        </EmptyState>
      ) : (
        <>
          {(moveError || error) && (
            <div className="mb-4">
              <Notice>{moveError ?? `Could not refresh: ${error}`}</Notice>
            </div>
          )}
          {/* Wide screens: a board that scrolls sideways. Phones: one column, stage after stage. */}
          <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
            <div className="flex flex-col gap-6 md:grid md:grid-flow-col md:auto-cols-[232px] md:gap-3">
              {STAGES.map((stage) => {
                const leads = sorted.filter((l) => l.stage === stage);
                return (
                  <section key={stage} aria-label={STAGE_LABELS[stage]} className="min-w-0">
                    <h2 className="mb-2.5 flex items-center gap-2 border-b border-hairline pb-2 text-[13px] font-medium">
                      {STAGE_LABELS[stage]}
                      <span className="font-normal text-quiet">{leads.length}</span>
                    </h2>
                    {leads.length === 0 ? (
                      <p className="rounded-[10px] border border-dashed border-hairline px-3 py-3 text-[13px] text-quiet md:py-5 md:text-center">No leads</p>
                    ) : (
                      <ul className="space-y-2">
                        {leads.map((lead) => (
                          <PipelineCard key={lead.id} lead={lead} busy={Boolean(moving[lead.id])} onMove={(s) => move(lead, s)} />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function PipelineCard({ lead, busy, onMove }: { lead: Lead; busy: boolean; onMove: (stage: Stage) => void }) {
  const action = nextAction(lead);
  const sub = titleAtCompany(lead);
  return (
    <li className="card p-3">
      <Link href={`/leads/${lead.id}`} className="block rounded">
        <div className="truncate font-medium hover:underline hover:underline-offset-2">{leadName(lead)}</div>
        {sub && <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-quiet">{sub}</div>}
      </Link>
      <div className={cx("mt-2 text-[12.5px]", action.tone === "urgent" ? "font-medium text-danger" : action.tone === "normal" ? "text-ink" : "text-quiet")}>{action.label}</div>
      <div className="mt-2.5">
        <StageSelect small value={lead.stage} disabled={busy} onChange={onMove} />
      </div>
    </li>
  );
}
