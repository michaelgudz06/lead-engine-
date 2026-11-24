"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { errorMessage, listLeads, restoreLeads, unqualifyLeads, updateLead } from "@/lib/api-client";
import { sortNeedsYouFirst } from "@/lib/next-action";
import { justMarked } from "@/lib/qualify";
import { ACTIVE_STAGES, STAGE_LABELS, type Lead, type Stage, type UnqualifiedReasonKey } from "@/lib/types";
import { isRunning, leadName, settleLostRun, titleAtCompany } from "@/components/format";
import { NoLinkedinChip } from "@/components/lead/contact";
import { leadAction } from "@/components/lead/status";
import { UnqualifyDialog, reasonLabel } from "@/components/lead/unqualify";
import { Button, ButtonLink, EmptyState, ErrorState, Notice, PageTitle, Skeleton, StageSelect, cx } from "@/components/ui";
import { useLoad } from "@/components/use-load";

/** The active leads (the board never shows unqualified ones), with how many are unqualified. */
const loadLeads = () => listLeads("active");

/** A card that just left the board for Unqualified: Undo puts it back. */
interface Hidden {
  id: string;
  name: string;
  /** Set once Undo has put it back. */
  restored?: boolean;
  /** It was unqualified already (marked elsewhere first, while this board was open): no Undo. */
  already?: boolean;
}

export default function PipelinePage() {
  const { data, error, loading, reload, setData } = useLoad(loadLeads, (list) => (list?.leads.some((l) => isRunning(l)) ? 4000 : null));
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moving, setMoving] = useState<Record<string, boolean>>({});
  const [hidden, setHidden] = useState<Hidden | null>(null);
  const [undoing, setUndoing] = useState(false);
  // Choosing Unqualified on a card asks why first (and an arrow key on the select only opens the question).
  const [asking, setAsking] = useState<Lead | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  // The card and its select are gone once it is marked: focus moves to Undo (or to the notice after an undo).
  const noticeBox = useRef<HTMLDivElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (hidden) (undoButton.current ?? noticeBox.current)?.focus();
  }, [hidden]);

  const setLeads = (change: (leads: Lead[]) => Lead[], unqualifiedBy = 0) =>
    setData((prev) => (prev ? { leads: change(prev.leads), counts: { active: Math.max(0, prev.counts.active - unqualifiedBy), unqualified: Math.max(0, prev.counts.unqualified + unqualifiedBy) } } : prev));

  async function move(lead: Lead, stage: Stage) {
    if (stage === lead.stage) return;
    if (stage === "unqualified") {
      setMarkError(null);
      setAsking(lead);
      return;
    }
    setMoveError(null);
    setMoving((m) => ({ ...m, [lead.id]: true }));
    // Move the card straight away; put it back if the server says no.
    setLeads((leads) => leads.map((l) => (l.id === lead.id ? { ...l, stage } : l)));
    try {
      const saved = await updateLead(lead.id, { stage });
      setLeads((leads) => leads.map((l) => (l.id === lead.id ? saved : l)));
      track("stage_changed", { leadId: lead.id, from: lead.stage, to: stage, surface: "pipeline" });
    } catch (err) {
      setLeads((leads) => leads.map((l) => (l.id === lead.id ? { ...l, stage: lead.stage } : l)));
      setMoveError(`Could not move ${leadName(lead)}: ${errorMessage(err)}`);
    } finally {
      setMoving((m) => ({ ...m, [lead.id]: false }));
    }
  }

  /** The question's answer: marks the card's lead unqualified, and the card leaves the board. */
  async function markUnqualified(reason: UnqualifiedReasonKey | null) {
    const lead = asking;
    if (!lead) return;
    setMarking(true);
    setMarkError(null);
    try {
      const res = await unqualifyLeads([lead.id], reasonLabel(reason));
      const saved = res.leads[0];
      setAsking(null);
      setMoveError(null);
      if (!saved) {
        // Deleted meanwhile: the card goes, and the reload brings the board up to date.
        setLeads((leads) => leads.filter((l) => l.id !== lead.id));
        setMoveError(`${leadName(lead)} is no longer there. It may have been deleted.`);
        void reload();
        return;
      }
      setLeads((leads) => leads.filter((l) => l.id !== lead.id), 1);
      // Undo only for a lead this answer marked; one marked elsewhere first stays unqualified.
      const marked = justMarked(saved);
      if (marked) track("leads_unqualified", { count: 1, reason: reason ?? "none", surface: "pipeline" });
      setHidden({ id: lead.id, name: leadName(lead), already: !marked });
    } catch (err) {
      setMarkError(errorMessage(err));
    } finally {
      setMarking(false);
    }
  }

  async function undo(card: Hidden) {
    setUndoing(true);
    setMoveError(null);
    try {
      const res = await restoreLeads([card.id]);
      if (res.leads.length > 0) track("leads_restored", { count: 1, surface: "pipeline" });
      await reload();
      setHidden(res.leads.length > 0 ? { ...card, restored: true } : null);
    } catch (err) {
      setMoveError(`Could not put ${card.name} back: ${errorMessage(err)}`);
    } finally {
      setUndoing(false);
    }
  }

  const unqualified = data?.counts.unqualified ?? 0;
  /** Quiet line: how many leads the board leaves out, and where they are. */
  const hiddenLine = unqualified > 0 && (
    <p className="mb-4 text-[13px] text-quiet">
      {unqualified === 1 ? "1 unqualified lead is hidden." : `${unqualified.toLocaleString("en-US")} unqualified leads are hidden.`}{" "}
      <Link href="/?view=unqualified" className="text-ink underline underline-offset-2">
        {unqualified === 1 ? "Show it" : "Show them"}
      </Link>
    </p>
  );
  const notices = (
    <div ref={noticeBox} tabIndex={-1} className="mb-4 space-y-3 rounded-lg empty:hidden">
      {(moveError || error) && <Notice>{moveError ?? `Could not refresh: ${error}`}</Notice>}
      {hidden && (
        <Notice
          tone="info"
          action={
            <span className="flex shrink-0 items-center gap-1">
              {!hidden.restored && !hidden.already && (
                <Button ref={undoButton} size="sm" busy={undoing} onClick={() => void undo(hidden)}>
                  Undo
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={undoing} onClick={() => setHidden(null)}>
                Dismiss
              </Button>
            </span>
          }
        >
          {hidden.restored
            ? `${hidden.name} is back on the board.`
            : hidden.already
              ? `${hidden.name} was already unqualified and left the board.`
              : `${hidden.name} was marked unqualified and left the board.`}
        </Notice>
      )}
    </div>
  );

  const sorted = sortNeedsYouFirst((data?.leads ?? []).map(settleLostRun));

  return (
    <>
      <PageTitle title="Pipeline" subtitle="Every active lead by stage. Change a card's stage to move it." />
      <UnqualifyDialog open={asking !== null} count={1} busy={marking} error={markError} onConfirm={(reason) => void markUnqualified(reason)} onCancel={() => setAsking(null)} />

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
      ) : data.leads.length === 0 ? (
        <>
          {notices}
          {hiddenLine}
          <EmptyState
            title={unqualified > 0 ? "No active leads in the pipeline" : "Nothing in the pipeline yet"}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <ButtonLink href="/leads/new" variant="primary">+ New lead</ButtonLink>
                <ButtonLink href="/leads/import">Import</ButtonLink>
              </div>
            }
          >
            {unqualified > 0 ? "Every lead is marked unqualified. Add someone new, or restore a lead from Unqualified." : "Leads appear here by stage once you add them."}
          </EmptyState>
        </>
      ) : (
        <>
          {notices}
          {hiddenLine}
          {/* Wide screens: a board that scrolls sideways. Phones: one column, stage after stage. */}
          <div className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
            <div className="flex flex-col gap-6 md:grid md:grid-flow-col md:auto-cols-[232px] md:gap-3">
              {ACTIVE_STAGES.map((stage) => {
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
  const action = leadAction(lead);
  const sub = titleAtCompany(lead);
  return (
    <li className="card p-3">
      <Link href={`/leads/${lead.id}`} className="block rounded">
        <div className="truncate font-medium hover:underline hover:underline-offset-2">{leadName(lead)}</div>
        {sub && <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-quiet">{sub}</div>}
        {!lead.linkedinUrl && <NoLinkedinChip className="mt-1.5" />}
      </Link>
      <div className={cx("mt-2 text-[12.5px]", action.tone === "urgent" ? "font-medium text-danger" : action.tone === "normal" ? "text-ink" : "text-quiet")}>{action.label}</div>
      <div className="mt-2.5">
        <StageSelect small value={lead.stage} disabled={busy} onChange={onMove} />
      </div>
    </li>
  );
}
