"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { deleteLeads, errorMessage, listLeads, restoreLeads, unqualifyLeads, type LeadList } from "@/lib/api-client";
import { sortNeedsYouFirst } from "@/lib/next-action";
import { justMarked } from "@/lib/qualify";
import type { Lead, LeadCounts, LeadView, UnqualifiedReasonKey } from "@/lib/types";
import { isRunning, leadName, settleLostRun, timeAgo, titleAtCompany } from "@/components/format";
import { NoLinkedinChip } from "@/components/lead/contact";
import { leadAction, notResearched } from "@/components/lead/status";
import { UnqualifyDialog, leadCount, reasonLabel, unqualifiedSummary } from "@/components/lead/unqualify";
import { Button, ButtonLink, ConfirmDialog, EmptyState, ErrorState, Notice, PageTitle, Skeleton, StageChip, cx } from "@/components/ui";
import { useLoad } from "@/components/use-load";

const SUBTITLES: Record<LeadView, string> = {
  active: "Needs you first: replies, then due follow-ups, then drafts ready to send.",
  unqualified: "Hidden from Active and the pipeline. Imports skip them too.",
};

/** The tab title for each view. A change of title is what Next's route announcer reads out, so switching views is announced. */
const TITLES: Record<LeadView, string> = {
  active: "Leads · Lead Engine",
  unqualified: "Unqualified leads · Lead Engine",
};

export default function LeadsPage() {
  // useSearchParams needs a Suspense boundary above it for the build.
  return (
    <Suspense
      fallback={
        <>
          <PageTitle title="Leads" subtitle={SUBTITLES.active} actions={<ButtonLink href="/leads/import">Import</ButtonLink>} />
          <ListSkeleton />
        </>
      }
    >
      <LeadsScreen />
    </Suspense>
  );
}

function LeadsScreen() {
  // The view lives in the URL (?view=unqualified), so Back works and a view can be linked.
  const view: LeadView = useSearchParams().get("view") === "unqualified" ? "unqualified" : "active";
  const [counts, setCounts] = useState<LeadCounts | null>(null);
  // A team with no leads at all sees the plain first-run screen, without a switch.
  const showSwitch = view === "unqualified" || !counts || counts.active + counts.unqualified > 0;
  // Each view has its own title; leaving the page puts the app's own title back for the next one.
  useEffect(() => {
    document.title = TITLES[view];
    return () => {
      document.title = "Lead Engine";
    };
  }, [view]);

  return (
    <>
      <PageTitle title="Leads" subtitle={SUBTITLES[view]} actions={<ButtonLink href="/leads/import">Import</ButtonLink>} />
      {showSwitch && <ViewSwitch view={view} counts={counts} />}
      {/* A new list per view: its rows, search, selection and notices all start again. */}
      <LeadsList key={view} view={view} onCounts={setCounts} />
    </>
  );
}

const VIEWS: Array<{ id: LeadView; label: string; href: string }> = [
  { id: "active", label: "Active", href: "/" },
  { id: "unqualified", label: "Unqualified", href: "/?view=unqualified" },
];

/** Active or Unqualified, each with how many leads it holds. Links, so each view has its own URL. */
function ViewSwitch({ view, counts }: { view: LeadView; counts: LeadCounts | null }) {
  return (
    <nav aria-label="Lead views" className="-mt-1 mb-5 inline-grid grid-cols-2 rounded-lg border border-hairline p-0.5">
      {VIEWS.map((v) => {
        const on = v.id === view;
        return (
          <Link
            key={v.id}
            href={v.href}
            scroll={false}
            aria-current={on ? "page" : undefined}
            className={cx("flex h-8 items-center justify-center gap-1.5 rounded-md px-3.5 text-[13.5px] font-medium transition-colors", on ? "bg-ink text-white" : "text-quiet hover:bg-wash hover:text-ink")}
          >
            {v.label}
            {counts && (
              <span className={cx("font-normal tabular-nums", on && "opacity-70")}>
                <span className="sr-only">, </span>
                {counts[v.id].toLocaleString("en-US")}
                <span className="sr-only"> {counts[v.id] === 1 ? "lead" : "leads"}</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

interface Done {
  text: string;
  /** Leads just marked unqualified: Undo restores exactly these. */
  undoIds?: string[];
  /** Where the leads went, when that is another view. */
  link?: { href: string; label: string };
}

function LeadsList({ view, onCounts }: { view: LeadView; onCounts: (counts: LeadCounts) => void }) {
  // Refresh while any lead is being researched so its row updates by itself.
  const { data, error, loading, reload, setData } = useLoad<LeadList>(
    () => listLeads(view),
    (list) => (list?.leads.some((l) => isRunning(l)) ? 4000 : null),
  );
  const [query, setQuery] = useState("");
  // Ids ticked. Rows that have left the list since are ignored (see `chosen`), so a refresh never breaks a selection.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const lastTicked = useRef<string | null>(null);
  // The selection's actions go when the selection does: Clear and Escape send focus to the top of the list first.
  const listBox = useRef<HTMLDivElement>(null);
  const selectAllBox = useRef<HTMLInputElement | null>(null);
  const clearSearchButton = useRef<HTMLButtonElement>(null);

  // The dialog that is open, and the leads it is about (fixed when it opens).
  const [dialog, setDialog] = useState<"unqualify" | "delete" | null>(null);
  const [target, setTarget] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  // Restore and Undo have no dialog: their state shows in the bar and above the list.
  const [restoring, setRestoring] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const counts = data?.counts;
  useEffect(() => {
    if (counts) onCounts(counts);
  }, [counts, onCounts]);

  // After an action the rows and the bar it came from are gone: focus moves to the notice
  // about it (its Undo button when there is one). An effect, so it runs after a dialog has closed.
  const noticeBox = useRef<HTMLDivElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (done) (undoButton.current ?? noticeBox.current)?.focus();
  }, [done]);
  // A failed Restore or Undo keeps its button, but disabling it while busy took focus away: give
  // it back. The actions show in one of two places by screen width, so take the copy on screen.
  useEffect(() => {
    if (!actionError || document.activeElement !== document.body) return;
    const restoreButton = [...(listBox.current?.querySelectorAll<HTMLButtonElement>("[data-restore]") ?? [])].find((el) => el.getClientRects().length > 0);
    (restoreButton ?? undoButton.current)?.focus();
  }, [actionError]);

  const leads = data?.leads;
  // Active: needs you first. Unqualified: as the server sends them, most recently marked first.
  const sorted = useMemo(() => (view === "active" ? sortNeedsYouFirst((leads ?? []).map(settleLostRun)) : (leads ?? [])), [leads, view]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((l) => [l.name, l.title, l.companyName, l.linkedinSlug, l.email, l.owner, l.unqualifiedReason].some((v) => v?.toLowerCase().includes(q)));
  }, [sorted, query]);

  /** The ticked leads still in the list, in list order. */
  const chosen = useMemo(() => sorted.filter((l) => selected.has(l.id)).map((l) => l.id), [sorted, selected]);
  const chosenShown = useMemo(() => visible.filter((l) => selected.has(l.id)).length, [visible, selected]);
  const notShown = chosen.length - chosenShown;
  // A dialog says when some of the leads it acts on are hidden by the search.
  const visibleIds = useMemo(() => new Set(visible.map((l) => l.id)), [visible]);
  const targetHidden = target.filter((id) => !visibleIds.has(id)).length;
  const hiddenNote =
    targetHidden === 0
      ? ""
      : targetHidden === target.length
        ? ` ${target.length === 1 ? "It is" : "They are"} hidden by your search.`
        : ` ${targetHidden.toLocaleString("en-US")} of them ${targetHidden === 1 ? "is" : "are"} hidden by your search.`;

  function toggle(id: string, on: boolean, range: boolean) {
    // Shift-click ticks every row between the last one ticked and this one.
    const from = range && lastTicked.current ? visible.findIndex((l) => l.id === lastTicked.current) : -1;
    const to = visible.findIndex((l) => l.id === id);
    const ids = from >= 0 && to >= 0 ? visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((l) => l.id) : [id];
    lastTicked.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const each of ids) {
        if (on) next.add(each);
        else next.delete(each);
      }
      return next;
    });
  }

  /** Ticks or clears the rows the search shows; rows it hides keep their state. */
  function toggleAll(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const l of visible) {
        if (on) next.add(l.id);
        else next.delete(l.id);
      }
      return next;
    });
  }

  function clearSelection() {
    if (document.activeElement?.closest("[data-selection-actions]")) (selectAllBox.current ?? clearSearchButton.current)?.focus();
    setSelected(new Set());
    lastTicked.current = null;
  }

  function open(kind: "unqualify" | "delete") {
    setTarget(chosen);
    setDialogError(null);
    setActionError(null);
    setDialog(kind);
  }

  /** Takes rows out of this list at once and moves the counts; the reload that follows brings the server's truth. */
  function leave(ids: readonly string[], change: Partial<LeadCounts>) {
    const gone = new Set(ids);
    setData((prev) =>
      prev
        ? {
            leads: prev.leads.filter((l) => !gone.has(l.id)),
            counts: { active: Math.max(0, prev.counts.active + (change.active ?? 0)), unqualified: Math.max(0, prev.counts.unqualified + (change.unqualified ?? 0)) },
          }
        : prev,
    );
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
    void reload();
  }

  /**
   * "1 was no longer there." when the server did not find every lead. A restore's missing leads
   * may still be there, back in Active (a teammate restored them first): it says so instead.
   */
  const missingNote = (n: number, what = "no longer there") => (n > 0 ? ` ${n.toLocaleString("en-US")} ${n === 1 ? "was" : "were"} ${what}.` : "");

  async function markUnqualified(reason: UnqualifiedReasonKey | null) {
    setBusy(true);
    setDialogError(null);
    try {
      const res = await unqualifyLeads(target, reasonLabel(reason));
      const ids = res.leads.map((l) => l.id);
      // Undo restores only the leads this action marked, never one that was unqualified already
      // (a teammate or another tab marked it while this list was open).
      const marked = res.leads.filter(justMarked).map((l) => l.id);
      const already = ids.length - marked.length;
      if (marked.length > 0) track("leads_unqualified", { count: marked.length, reason: reason ?? "none", surface: "list" });
      setDialog(null);
      // Every one of them leaves this list, whoever marked it.
      leave(target, { active: -ids.length, unqualified: ids.length });
      const alreadyNote = already > 0 ? ` ${already.toLocaleString("en-US")} ${already === 1 ? "was" : "were"} already unqualified.` : "";
      setDone(
        marked.length > 0
          ? { text: `Marked ${leadCount(marked.length)} unqualified.${alreadyNote}${missingNote(res.missing.length)}`, undoIds: marked }
          : { text: ids.length > 0 ? `${ids.length === 1 ? "That lead was" : "Those leads were"} already unqualified.${missingNote(res.missing.length)}` : "Those leads are no longer there." },
      );
    } catch (err) {
      setDialogError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeForGood() {
    setBusy(true);
    setDialogError(null);
    try {
      const res = await deleteLeads(target);
      const n = res.deleted.length;
      if (n > 0) track("leads_deleted", { count: n, surface: "list" });
      setDialog(null);
      leave(target, { [view]: -n });
      setDone({ text: n > 0 ? `Deleted ${leadCount(n)}.${missingNote(res.missing.length)}` : "Those leads were already gone." });
    } catch (err) {
      setDialogError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    const ids = chosen;
    setRestoring(true);
    setActionError(null);
    try {
      const res = await restoreLeads(ids);
      const n = res.leads.length;
      if (n > 0) track("leads_restored", { count: n, surface: "list" });
      leave(ids, { active: n, unqualified: -n });
      setDone(
        n > 0
          ? { text: `Restored ${leadCount(n)}. ${n === 1 ? "It is" : "They are"} back in Active, on the stage ${n === 1 ? "it" : "they"} had.${missingNote(res.missing.length, "already restored or deleted")}`, link: { href: "/", label: "Go to Active" } }
          : { text: "Those leads are no longer unqualified." },
      );
    } catch (err) {
      setActionError(`Could not restore: ${errorMessage(err)}`);
    } finally {
      setRestoring(false);
    }
  }

  async function undo(ids: string[]) {
    setUndoing(true);
    setActionError(null);
    try {
      const res = await restoreLeads(ids);
      const n = res.leads.length;
      if (n > 0) track("leads_restored", { count: n, surface: "list" });
      setDone({ text: n > 0 ? `Restored ${leadCount(n)}.${missingNote(res.missing.length, "already restored or deleted")}` : "Those leads are no longer unqualified." });
      await reload();
    } catch (err) {
      setActionError(`Could not undo: ${errorMessage(err)}`);
    } finally {
      setUndoing(false);
    }
  }

  const dialogs = (
    <>
      <UnqualifyDialog open={dialog === "unqualify"} count={target.length} note={hiddenNote} busy={busy} error={dialogError} onConfirm={(reason) => void markUnqualified(reason)} onCancel={() => setDialog(null)} />
      <ConfirmDialog
        open={dialog === "delete"}
        title={`Delete ${leadCount(target.length)}?`}
        confirmLabel={`Delete ${leadCount(target.length)}`}
        busy={busy}
        error={dialogError}
        onConfirm={() => void removeForGood()}
        onCancel={() => setDialog(null)}
      >
        {target.length === 1 ? "Its" : "Their"} research, drafts and activity go for good, and a later import can add {target.length === 1 ? "this person" : "these people"} again.{" "}
        {view === "active"
          ? `Marking ${target.length === 1 ? "the lead" : "them"} unqualified hides ${target.length === 1 ? "it" : "them"} and keeps ${target.length === 1 ? "it" : "them"} out of imports.`
          : `Left unqualified, ${target.length === 1 ? "the lead stays" : "they stay"} hidden and out of imports.`}
        {hiddenNote}
      </ConfirmDialog>
    </>
  );

  if (loading) return <ListSkeleton />;
  if (!data) return <ErrorState title="Leads did not load" message={error ?? "Please try again."} onRetry={reload} />;

  const total = data.leads.length;
  const inAll = data.counts[view];
  const allShownTicked = visible.length > 0 && chosenShown === visible.length;
  const working = busy || restoring;

  /**
   * The count and what to do with the ticked leads. One copy shows at a time: from sm up in the
   * "Select all" row, ahead of the rows (so Tab reaches it straight after Select all); on phones,
   * and whenever a search hides every row, in a bar at the bottom of the screen.
   */
  const selectionActions = (
    <>
      <span className="mr-auto text-[13.5px]">
        <span className="font-medium">{chosen.length.toLocaleString("en-US")} selected</span>
        {notShown > 0 && <span className="text-quiet">, {notShown.toLocaleString("en-US")} not shown</span>}
      </span>
      {view === "active" ? (
        <Button size="sm" onClick={() => open("unqualify")} disabled={working}>
          Mark unqualified
        </Button>
      ) : (
        <Button size="sm" data-restore onClick={() => void restore()} busy={restoring} disabled={busy}>
          Restore
        </Button>
      )}
      <Button size="sm" variant="danger" onClick={() => open("delete")} disabled={working}>
        Delete
      </Button>
      <Button size="sm" variant="ghost" className="text-quiet" onClick={clearSelection} disabled={working}>
        Clear
      </Button>
    </>
  );

  return (
    <>
      {/* Says the selection to screen readers as it changes. */}
      <p role="status" aria-live="polite" className="sr-only">
        {chosen.length > 0 ? `${leadCount(chosen.length)} selected.` : ""}
      </p>

      <div ref={noticeBox} tabIndex={-1} className="mb-4 space-y-3 rounded-lg empty:hidden">
        {error && <Notice>Could not refresh: {error}</Notice>}
        {actionError && <Notice>{actionError}</Notice>}
        {done && (
          <Notice
            tone="info"
            action={
              <span className="flex shrink-0 items-center gap-1">
                {done.undoIds && (
                  <Button ref={undoButton} size="sm" busy={undoing} onClick={() => void undo(done.undoIds ?? [])}>
                    Undo
                  </Button>
                )}
                {done.link && (
                  <ButtonLink href={done.link.href} size="sm">
                    {done.link.label}
                  </ButtonLink>
                )}
                <Button size="sm" variant="ghost" disabled={undoing} onClick={() => setDone(null)}>
                  Dismiss
                </Button>
              </span>
            }
          >
            {done.text}
          </Notice>
        )}
      </div>

      {total === 0 ? (
        view === "unqualified" ? (
          <EmptyState title="No unqualified leads" action={<ButtonLink href="/">Go to Active</ButtonLink>}>
            Mark a lead unqualified when it is not a fit. It leaves Active and the pipeline, keeps its research, and imports keep skipping it.
          </EmptyState>
        ) : (
          <EmptyState
            title={data.counts.unqualified > 0 ? "No active leads" : "No leads yet"}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <ButtonLink href="/leads/new" variant="primary">+ New lead</ButtonLink>
                <ButtonLink href="/leads/import">Import</ButtonLink>
              </div>
            }
          >
            {data.counts.unqualified > 0
              ? "Every lead is marked unqualified. Add someone new, or restore a lead from Unqualified."
              : "Add one person by their LinkedIn URL, or import a list from a CSV file, a Google Sheet or HubSpot. The agent researches each person and their company, then drafts outreach for you to review and send."}
          </EmptyState>
        )
      ) : (
        <>
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
                placeholder={view === "unqualified" ? "Search by name, company or reason" : "Search by name, company or title"}
                aria-label={view === "unqualified" ? "Search unqualified leads" : "Search leads"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <span className="ml-auto shrink-0 text-[13px] text-quiet">{visible.length === total ? leadCount(total) : `${visible.length} of ${total}`}</span>
          </div>

          {/* Escape clears the selection while focus is in the list or its actions. */}
          <div
            ref={listBox}
            onKeyDown={(e) => {
              if (e.key === "Escape" && chosen.length > 0 && !working) {
                e.preventDefault();
                clearSelection();
              }
            }}
          >
            {visible.length === 0 ? (
              <div className="card px-6 py-10 text-center text-quiet">
                No {view === "unqualified" ? "unqualified " : ""}leads match “{query.trim()}”.{" "}
                <button ref={clearSearchButton} type="button" className="text-ink underline underline-offset-2" onClick={() => setQuery("")}>
                  Clear search
                </button>
              </div>
            ) : (
              // overflow-clip, not overflow-hidden: it still rounds the corners, and leaves the
              // "Select all" row free to stick under the app header while the rows scroll.
              <div className="card overflow-clip">
                <div className="flex items-center gap-3 border-b border-hairline bg-white px-4 sm:sticky sm:top-14 sm:z-10 sm:h-12 sm:pl-5 sm:pr-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch py-2.5 text-[13px] text-quiet">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-[#22221f]"
                      aria-label={visible.length === total ? `Select all ${leadCount(total)}` : `Select the ${leadCount(visible.length)} shown`}
                      checked={allShownTicked}
                      ref={(el) => {
                        selectAllBox.current = el;
                        if (el) el.indeterminate = chosenShown > 0 && !allShownTicked;
                      }}
                      disabled={working}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                    <span aria-hidden className="truncate">
                      {visible.length === total ? "Select all" : `Select the ${visible.length.toLocaleString("en-US")} shown`}
                    </span>
                  </label>
                  {chosen.length > 0 && (
                    <div role="group" aria-label="Selected leads" data-selection-actions className="hidden shrink-0 items-center gap-2 sm:flex">
                      {selectionActions}
                    </div>
                  )}
                </div>
                <ul className="divide-y divide-hairline">
                  {visible.map((lead) => (
                    <LeadRow key={lead.id} lead={lead} view={view} selected={selected.has(lead.id)} disabled={working} onToggle={toggle} />
                  ))}
                </ul>
              </div>
            )}

            {inAll > total && (
              <p className="mt-3 text-[13px] text-quiet">
                Showing {total.toLocaleString("en-US")} of {inAll.toLocaleString("en-US")} leads, the most recent first.
              </p>
            )}

            {/* Phones, and any width while a search hides every row: the actions stick to the bottom of the screen while the list scrolls under them, and sit below the last row at the end. Rows keep room below them when focused (LeadRow), so this never covers the one with focus. */}
            {chosen.length > 0 && (
              <div
                role="group"
                aria-label="Selected leads"
                data-selection-actions
                className={cx("sticky bottom-3 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-[10px] border border-ink bg-white py-2 pl-4 pr-2 shadow-[0_8px_24px_rgb(34_34_31/0.14)]", visible.length > 0 && "sm:hidden")}
              >
                {selectionActions}
              </div>
            )}
          </div>
        </>
      )}
      {dialogs}
    </>
  );
}

/**
 * One lead. The tick box and the link sit side by side (nothing interactive is nested), and
 * between them they fill the row: the box's cell selects, everything else opens the lead.
 * Both keep 7rem of room above and below them when focus scrolls them into view, so keyboard
 * focus never lands under the sticky header and "Select all" row, or under the phone's bottom bar.
 * A ticked row keeps the wash, so its grey text is a shade darker there (4.5:1 contrast).
 */
function LeadRow({ lead, view, selected, disabled, onToggle }: { lead: Lead; view: LeadView; selected: boolean; disabled: boolean; onToggle: (id: string, on: boolean, range: boolean) => void }) {
  const name = leadName(lead);
  const sub = titleAtCompany(lead);
  return (
    <li className={cx("flex items-stretch transition-colors hover:bg-wash", selected && "bg-wash [&_.text-quiet]:text-[#6b6b65]")}>
      <label className="flex shrink-0 cursor-pointer items-center pl-4 pr-3 sm:pl-5">
        <input
          type="checkbox"
          className="h-4 w-4 scroll-mt-28 scroll-mb-28 accent-[#22221f]"
          aria-label={`Select ${name}`}
          checked={selected}
          disabled={disabled}
          onChange={(e) => onToggle(lead.id, e.target.checked, (e.nativeEvent as MouseEvent).shiftKey === true)}
        />
      </label>
      <Link
        href={`/leads/${lead.id}`}
        className={cx(
          "grid min-w-0 flex-1 scroll-mt-28 scroll-mb-28 items-center gap-x-4 gap-y-1.5 py-3.5 pr-4 -outline-offset-2 sm:pr-5",
          view === "active" ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_190px]" : "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,240px)]",
        )}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{name}</span>
            {!lead.linkedinUrl && <NoLinkedinChip className="shrink-0" />}
          </div>
          <div className="truncate text-[13.5px] text-quiet">{sub || (notResearched(lead) ? "Details appear after research" : "Details appear once research finishes")}</div>
        </div>
        {view === "active" ? <ActiveCells lead={lead} /> : <UnqualifiedCells lead={lead} />}
      </Link>
    </li>
  );
}

function ActiveCells({ lead }: { lead: Lead }) {
  const action = leadAction(lead);
  return (
    <>
      <div className="row-span-1 justify-self-end">
        <StageChip stage={lead.stage} />
      </div>
      <div className="col-span-2 flex items-center gap-2 sm:col-span-1 sm:justify-end">
        {isRunning(lead) ? <span className="spinner" aria-hidden /> : <span aria-hidden className={cx("h-1.5 w-1.5 shrink-0 rounded-full", action.tone === "urgent" ? "bg-danger" : action.tone === "normal" ? "bg-ink" : "bg-hairline")} />}
        <span className={cx("truncate text-[13.5px]", action.tone === "urgent" ? "font-medium text-danger" : action.tone === "normal" ? "text-ink" : "text-quiet")}>{action.label}</span>
        <span className="ml-auto text-[12.5px] text-quiet sm:hidden">{timeAgo(lead.updatedAt)}</span>
      </div>
    </>
  );
}

/** Why the lead was marked, and when. */
function UnqualifiedCells({ lead }: { lead: Lead }) {
  const { reason, marked } = unqualifiedSummary(lead);
  return (
    <div className="flex min-w-0 items-baseline gap-x-2 text-[13.5px] sm:flex-col sm:items-end sm:gap-0">
      <span className={cx("truncate sm:max-w-full", lead.unqualifiedReason ? "text-ink" : "text-quiet")} title={lead.unqualifiedReason ?? undefined}>
        {reason}
      </span>
      <span className="ml-auto shrink-0 text-[12.5px] text-quiet sm:ml-0">{marked}</span>
    </div>
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
