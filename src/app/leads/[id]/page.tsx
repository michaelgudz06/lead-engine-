"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { daysFromNow, track } from "@/lib/analytics";
import { ApiError, deleteLead, errorMessage, getLead, getStatusCached, pushToHubspot, rerunResearch, restoreLeads, steerLead, unqualifyLeads, updateLead, type LeadPatch, type StatusResponse } from "@/lib/api-client";
import { justMarked } from "@/lib/qualify";
import { STAGE_LABELS, UNQUALIFIED_REASONS, type Finding, type Lead, type LeadDetail, type Stage, type UnqualifiedReasonKey } from "@/lib/types";
import { formatDate, formatDateTime, fromDateInput, hostOf, isRunning, leadName, safeUrl, settleLostRun, titleAtCompany, toDateInput } from "@/components/format";
import { AnglesSection } from "@/components/lead/angles";
import { AddLinkedinCard, EmailControl, LinkedinForm, NoLinkedinChip, emailKindText } from "@/components/lead/contact";
import { Panel } from "@/components/lead/panel";
import { RerunPanel } from "@/components/lead/rerun";
import { leadAction } from "@/components/lead/status";
import { ReasonChips, UnqualifyDialog, reasonLabel, unqualifiedSummary } from "@/components/lead/unqualify";
import { ActivitySection, BriefSection, CompanySection, FindingsSection, PendingPanel, ResearchProgress } from "@/components/lead/sections";
import { Button, Chip, ConfirmDialog, ErrorState, ExternalLink, Label, Modal, Notice, Skeleton, StageSelect } from "@/components/ui";
import { useLoad } from "@/components/use-load";

type Loaded = LeadDetail | "missing";

export default function LeadPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";

  // Poll every 2 seconds while research runs so progress shows live. A lost run
  // (see isRunning) never finishes, so polling stops for it.
  const { data, error, loading, reload, setData } = useLoad<Loaded>(
    async () => {
      try {
        return await getLead(id);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return "missing";
        throw err;
      }
    },
    (d) => (d && d !== "missing" && isRunning(d.lead) ? 2000 : null),
  );

  if (loading) return <PageSkeleton />;
  if (data === "missing") {
    return (
      <ErrorState title="This lead does not exist" message="It may have been deleted, or the link is wrong." />
    );
  }
  if (!data) return <ErrorState title="This lead did not load" message={error ?? "Please try again."} onRetry={reload} />;

  const setLead = (lead: Lead) => setData((prev) => (prev && prev !== "missing" ? { ...prev, lead } : prev));
  return <LeadView detail={data} refreshError={error} reload={reload} setLead={setLead} />;
}

function LeadView({ detail, refreshError, reload, setLead }: { detail: LeadDetail; refreshError: string | null; reload: () => Promise<void>; setLead: (lead: Lead) => void }) {
  const { lead, findings, events } = detail;
  const router = useRouter();
  const running = isRunning(lead);
  // A run that never finished (server time limit or restart) is a failed run: it can be retried.
  const lost = lead.researchStatus === "running" && !running;
  const failed = lead.researchStatus === "error" || lost;

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getStatusCached().then(
      (s) => alive && setStatus(s),
      () => alive && setStatusFailed(true),
    );
    return () => {
      alive = false;
    };
  }, []);

  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [editingLinkedin, setEditingLinkedin] = useState(false);
  // Focus goes back to what opened a panel or form when it closes.
  const rerunButton = useRef<HTMLButtonElement>(null);
  const linkedinReturn = useRef(false);
  const focusLinkedinChange = (el: HTMLButtonElement | null) => {
    if (el && linkedinReturn.current) {
      linkedinReturn.current = false;
      el.focus();
    }
  };
  function closeLinkedin() {
    linkedinReturn.current = true;
    setEditingLinkedin(false);
  }
  function closeRerun() {
    setRerunOpen(false);
    rerunButton.current?.focus();
  }
  const [pushing, setPushing] = useState(false);
  const unqualified = lead.stage === "unqualified";
  // "Remove" opens one dialog with both ways out: mark unqualified, or delete for good.
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState<"unqualify" | "delete" | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Choosing Unqualified in the Stage select asks why first, so an arrow key on the select only opens the question.
  const [askUnqualify, setAskUnqualify] = useState(false);
  const [savingReason, setSavingReason] = useState(false);
  // Said to screen readers when a lead is marked: a live region that is always there, so the
  // change of its text is announced (a notice that appears with its text may not be). Cleared
  // when the lead is restored, so marking it again is said again.
  const [said, setSaid] = useState("");
  // After a lead is marked or restored, focus moves to the notice that says so (its Restore
  // button when there is one). An effect, so it runs after the dialog has closed.
  const notices = useRef<HTMLDivElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const [focusNotices, setFocusNotices] = useState(0);
  useEffect(() => {
    if (focusNotices > 0) (restoreButton.current ?? notices.current)?.focus();
  }, [focusNotices]);

  const findingMap = useMemo(() => new Map<string, Finding>(findings.map((f) => [f.id, f])), [findings]);

  useEffect(() => {
    document.title = `${leadName(lead)} · Lead Engine`;
  }, [lead]);

  /** Starts a run, with the reason for it when there is one. Rejects when the server refuses. */
  async function startRun(focus?: string) {
    await rerunResearch(lead.id, focus);
    track("research_rerun", { leadId: lead.id, hadResearch: hasResearch, afterFailure: failed });
    // Show the running state at once; the next poll brings the real step.
    setLead({ ...lead, researchStatus: "running", researchStep: "Starting research", researchError: null, researchStartedAt: new Date().toISOString() });
  }

  /** A first run or a retry: starts at once. */
  async function rerun() {
    setStarting(true);
    setActionError(null);
    setNotice(null);
    setRerunOpen(false);
    try {
      await startRun();
    } catch (err) {
      // 409 means a run is already going: just show it.
      if (!(err instanceof ApiError && err.status === 409)) setActionError(errorMessage(err));
    } finally {
      setStarting(false);
      void reload();
    }
  }

  /** A re-run from the panel: its errors (the run limits) show in the panel. */
  async function rerunWithReason(focus: string, picks: number) {
    setActionError(null);
    setNotice(null);
    try {
      await startRun(focus);
    } catch (err) {
      void reload();
      throw err;
    }
    track("research_rerun_requested", { hasFocus: focus.length > 0, focusLength: focus.length, picks });
    setRerunOpen(false);
    void reload();
  }

  /** Saves a change. Resolves to false (after putting the old value back) when it fails. */
  async function patch(change: LeadPatch, alsoShow: Partial<Lead> = {}): Promise<boolean> {
    setActionError(null);
    const before = lead;
    setLead({ ...lead, ...change, ...alsoShow } as Lead);
    try {
      setLead(await updateLead(lead.id, change));
      if (change.stage) void reload(); // brings in the new "stage" event
      return true;
    } catch (err) {
      setLead(before);
      setActionError(`That change was not saved: ${errorMessage(err)}`);
      return false;
    }
  }

  async function hubspot() {
    setPushing(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await pushToHubspot(lead.id);
      if (res.ok === false) throw new Error("HubSpot did not accept the lead.");
      track("hubspot_pushed", { leadId: lead.id, ok: true });
      setNotice("Pushed to HubSpot.");
      void reload();
    } catch (err) {
      track("hubspot_pushed", { leadId: lead.id, ok: false });
      setActionError(`HubSpot: ${errorMessage(err)}`);
    } finally {
      setPushing(false);
    }
  }

  /**
   * The Stage select. Unqualified opens the question that Remove asks (why, then mark); nothing is
   * saved until it is answered, and the select shows the old stage again if it is cancelled. Any
   * other stage on an unqualified lead restores it to that stage.
   */
  async function changeStage(stage: Stage) {
    const from = lead.stage;
    if (stage === from) return;
    if (stage === "unqualified") {
      setRemoveError(null);
      setAskUnqualify(true);
      return;
    }
    setNotice(null);
    // Shown at once, with the fields the server will clear; patch() puts the old lead back if the save fails.
    const shown: Partial<Lead> = from === "unqualified" ? { unqualifiedAt: null, unqualifiedReason: null, stageBeforeUnqualified: null } : {};
    const ok = await patch({ stage }, shown);
    if (!ok) return;
    if (from === "unqualified") {
      track("leads_restored", { count: 1, surface: "lead" });
      setSaid("");
      setNotice(`Restored to ${STAGE_LABELS[stage]}. This lead is back in Active and on the pipeline.`);
    } else {
      track("stage_changed", { leadId: lead.id, from, to: stage, surface: "lead" });
    }
  }

  /** A quick pick on an unqualified lead's notice: sets the reason, or clears it when pressed again. */
  async function saveReason(key: UnqualifiedReasonKey | null) {
    setSavingReason(true);
    setNotice(null);
    await patch({ unqualifiedReason: reasonLabel(key) });
    setSavingReason(false);
  }

  /** Mark as sent on an unqualified lead puts it back as contacted: say so, as Restore does. */
  function onAnglesChange(next: Lead) {
    if (unqualified && next.stage !== "unqualified") {
      track("leads_restored", { count: 1, surface: "lead" });
      setSaid("");
      setNotice(`Marked as sent. This lead is back in Active and on the pipeline, as ${STAGE_LABELS[next.stage]}.`);
    }
    setLead(next);
  }

  function openRemove() {
    setRemoveError(null);
    setRemoveOpen(true);
  }

  async function markUnqualified(reason: UnqualifiedReasonKey | null) {
    setRemoving("unqualify");
    setRemoveError(null);
    try {
      const res = await unqualifyLeads([lead.id], reasonLabel(reason));
      const marked = res.leads[0];
      if (!marked) throw new Error("This lead is no longer there. It may have been deleted.");
      // Counted once: not when someone else had marked it already.
      if (justMarked(marked)) track("leads_unqualified", { count: 1, reason: reason ?? "none", surface: "lead" });
      setActionError(null);
      setNotice(null);
      setLead(marked);
      setRemoveOpen(false);
      setAskUnqualify(false);
      setSaid("Marked unqualified. This lead is hidden from Active and the pipeline.");
      setFocusNotices((n) => n + 1);
      void reload(); // brings in the "Marked unqualified" event
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setRemoving(null);
    }
  }

  async function restore() {
    setRestoring(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await restoreLeads([lead.id]);
      const restored = res.leads[0];
      if (restored) {
        track("leads_restored", { count: 1, surface: "lead" });
        setSaid("");
        setLead(restored);
        setNotice(`Restored to ${STAGE_LABELS[restored.stage]}. This lead is back in Active and on the pipeline.`);
        setFocusNotices((n) => n + 1);
      }
      // Not restored: someone else already did, or deleted it. The reload shows which.
      void reload();
    } catch (err) {
      setActionError(`Could not restore: ${errorMessage(err)}`);
    } finally {
      setRestoring(false);
    }
  }

  async function remove() {
    setRemoving("delete");
    setRemoveError(null);
    try {
      await deleteLead(lead.id);
      track("leads_deleted", { count: 1, surface: "lead" });
      router.push(unqualified ? "/?view=unqualified" : "/");
      // Stay busy while the list loads, so nothing on this page can be pressed again.
    } catch (err) {
      setRemoveError(errorMessage(err));
      setRemoving(null);
    }
  }

  const hubspotProvider = status?.providers.find((p) => p.id === "hubspot");
  const hubspotReason = statusFailed
    ? "Could not check whether HubSpot is set up. Reload the page to try again."
    : !status
      ? "Checking whether HubSpot is set up…"
      : !hubspotProvider?.configured
        ? `HubSpot is not set up. ${hubspotProvider?.detail || "Add the HubSpot token on the server to turn this on."}`
        : running
          ? "Wait for research to finish first."
          : null;

  const sub = titleAtCompany(lead);
  const linkedin = safeUrl(lead.linkedinUrl);
  const companyUrl = lead.companyDomain ? safeUrl(`https://${lead.companyDomain.replace(/^https?:\/\//, "")}`) : null;
  const xHandle = lead.xHandle?.replace(/^@/, "").trim();
  const action = leadAction(settleLostRun(lead));
  const hasResearch = Boolean(lead.brief || lead.companyPicture || lead.angles.length > 0);
  const emailKind = emailKindText(lead, "short");
  const unqualifiedNote = unqualifiedSummary(lead);

  return (
    <>
      <Link href={unqualified ? "/?view=unqualified" : "/"} className="mb-4 inline-block text-[13.5px] text-quiet hover:text-ink">
        ← {unqualified ? "Unqualified leads" : "Leads"}
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="break-words font-serif text-[32px] leading-[1.15] tracking-[-0.01em]">{leadName(lead)}</h1>
          {(sub || lead.location) && (
            <p className="mt-1 text-[15px] text-quiet wrap-anywhere">
              {sub}
              {sub && lead.location && " · "}
              {lead.location}
            </p>
          )}
          <div
            className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] wrap-anywhere"
            onClick={(e) => {
              if (linkedin && e.target instanceof Element && e.target.closest("a")?.getAttribute("href") === linkedin) track("linkedin_profile_opened", { leadId: lead.id, from: "header" });
            }}
          >
            {linkedin ? <ExternalLink href={linkedin}>LinkedIn ↗</ExternalLink> : <NoLinkedinChip />}
            {lead.email && (
              <span>
                <a href={`mailto:${encodeURIComponent(lead.email)}`} className="text-link underline-offset-2 hover:underline">
                  {lead.email}
                </a>
                {emailKind && <span className="text-quiet"> · {emailKind}</span>}
              </span>
            )}
            {xHandle && <ExternalLink href={`https://x.com/${encodeURIComponent(xHandle)}`}>@{xHandle} ↗</ExternalLink>}
            {companyUrl && <ExternalLink href={companyUrl}>{hostOf(companyUrl)} ↗</ExternalLink>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A lead with research is asked why first; a first run or a retry starts at once. */}
          <Button
            ref={rerunButton}
            onClick={hasResearch ? () => setRerunOpen((open) => !open) : rerun}
            busy={starting}
            aria-expanded={hasResearch ? rerunOpen : undefined}
            disabledReason={running ? "Research is already running." : null}
          >
            {hasResearch || failed ? "Re-run research" : "Run research"}
          </Button>
          <Button onClick={hubspot} busy={pushing} disabledReason={hubspotReason} tipEnd>
            Push to HubSpot
          </Button>
          <Button variant="danger" onClick={openRemove} aria-haspopup="dialog">
            Remove
          </Button>
        </div>
      </header>

      <div ref={notices} tabIndex={-1} className="mb-5 space-y-3 rounded-lg empty:hidden">
        {unqualified && (
          <Notice
            tone="info"
            action={
              <Button ref={restoreButton} size="sm" onClick={() => void restore()} busy={restoring}>
                Restore
              </Button>
            }
          >
            <span className="font-medium">Unqualified.</span> <bdi>{unqualifiedNote.reason}</bdi> · {unqualifiedNote.marked}. This lead is hidden from Active and the pipeline, and imports skip it.
            <div className="mt-2.5">
              <ReasonChips value={UNQUALIFIED_REASONS.find((r) => r.label === lead.unqualifiedReason)?.key ?? null} onChange={(key) => void saveReason(key)} disabled={savingReason} />
            </div>
          </Notice>
        )}
        {actionError && <Notice>{actionError}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
        {refreshError && <Notice>Live updates paused: {refreshError} Retrying…</Notice>}
        {rerunOpen && !running && (
          <RerunPanel
            onSubmit={rerunWithReason}
            onCancel={closeRerun}
            onWrongPerson={
              lead.linkedinUrl
                ? () => {
                    setRerunOpen(false);
                    setEditingLinkedin(true);
                  }
                : undefined
            }
          />
        )}
        {failed && (
          <Notice action={<Button size="sm" onClick={rerun} busy={starting}>Retry research</Button>}>
            <span className="font-medium">Research failed.</span>{" "}
            {lost ? "It stopped before it finished (server time limit or restart)." : lead.researchError || "The agent stopped before it finished."}
          </Notice>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_296px] lg:gap-8">
        <div className="min-w-0 space-y-6">
          {running && <ResearchProgress lead={lead} events={events} />}

          {!lead.linkedinUrl && !running && <AddLinkedinCard lead={lead} onLeadChange={setLead} />}

          {!running && !hasResearch && !failed && (
            <div className="card px-5 py-8 text-center">
              <h2 className="font-serif text-[21px]">No research yet</h2>
              <p className="mx-auto mt-1.5 max-w-md text-quiet">
                Run research to get a sourced brief, a picture of the company and drafted outreach.
                {!lead.linkedinUrl && " It starts by looking for their LinkedIn profile."}
              </p>
              <div className="mt-4">
                <Button variant="primary" onClick={rerun} busy={starting}>
                  Run research
                </Button>
              </div>
            </div>
          )}

          {lead.brief ? <BriefSection brief={lead.brief} findings={findingMap} /> : running && <PendingPanel title="Brief" lines={5} />}
          {lead.companyPicture ? <CompanySection company={lead.companyPicture} findings={findingMap} /> : running && <PendingPanel title="Company picture" lines={3} />}
          {lead.angles.length > 0 ? (
            <AnglesSection lead={lead} findings={findingMap} locked={running} onLeadChange={onAnglesChange} onActivity={() => void reload()} />
          ) : (
            running && <PendingPanel title="Angles" lines={4} />
          )}

          {(hasResearch || findings.length > 0) && <SteerSection leadId={lead.id} running={running} onStarted={() => { setLead({ ...lead, researchStatus: "running", researchStep: "Reading your instruction", researchStartedAt: new Date().toISOString() }); void reload(); }} />}

          {(findings.length > 0 || hasResearch || running) && <FindingsSection findings={findings} />}
        </div>

        <aside className="min-w-0 space-y-6">
          <Panel title="Details">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={action.tone === "urgent" ? "urgent" : action.tone === "quiet" ? "quiet" : "default"}>{action.label}</Chip>
              </div>
              <div>
                <Label htmlFor="stage">Stage</Label>
                <StageSelect
                  id="stage"
                  value={lead.stage}
                  onChange={(stage) => void changeStage(stage)}
                />
              </div>
              <EmailControl lead={lead} running={running} onLeadChange={setLead} onActivity={() => void reload()} />
              {lead.linkedinUrl && (
                <div>
                  {editingLinkedin ? (
                    <LinkedinForm lead={lead} label="LinkedIn URL" autoFocus onLeadChange={setLead} onDone={closeLinkedin} onCancel={closeLinkedin} />
                  ) : (
                    <>
                      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px] font-medium">
                        <span>LinkedIn</span>
                        <button
                          ref={focusLinkedinChange}
                          type="button"
                          className="font-normal text-quiet underline underline-offset-2 hover:text-ink disabled:no-underline disabled:opacity-60"
                          disabled={running}
                          title={running ? "Wait for research to finish first." : "Wrong profile? Change the URL, then re-run research."}
                          onClick={() => setEditingLinkedin(true)}
                        >
                          Change
                        </button>
                      </div>
                      <p className="wrap-anywhere text-quiet">{lead.linkedinSlug ? `linkedin.com/in/${lead.linkedinSlug}` : hostOf(lead.linkedinUrl)}</p>
                    </>
                  )}
                </div>
              )}
              <SavedField
                id="owner"
                label="Owner"
                initial={lead.owner ?? ""}
                placeholder="Who is on this lead"
                onSave={async (v) => {
                  const ok = await patch({ owner: v.trim() || null });
                  if (ok) track("owner_set", { leadId: lead.id, cleared: !v.trim() });
                  return ok;
                }}
              />
              <div>
                <Label
                  htmlFor="nextStepAt"
                  hint={
                    lead.nextStepAt ? (
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-ink"
                        onClick={() =>
                          void patch({ nextStepAt: null }).then((ok) => {
                            if (ok) track("followup_set", { leadId: lead.id, cleared: true });
                          })
                        }
                      >
                        Clear
                      </button>
                    ) : undefined
                  }
                >
                  Follow up on
                </Label>
                <input
                  id="nextStepAt"
                  type="date"
                  className="field"
                  value={toDateInput(lead.nextStepAt)}
                  onChange={(e) => {
                    const nextStepAt = e.target.value ? fromDateInput(e.target.value) : null;
                    void patch({ nextStepAt }).then((ok) => {
                      if (ok) track("followup_set", { leadId: lead.id, cleared: !nextStepAt, inDays: daysFromNow(nextStepAt) });
                    });
                  }}
                />
              </div>
              <SavedField
                id="notes"
                label="Your notes"
                multiline
                initial={lead.notes ?? ""}
                placeholder="How you know them, what was said, what you want"
                onSave={async (v) => {
                  const ok = await patch({ notes: v.trim() || null });
                  if (ok) track("notes_saved", { leadId: lead.id, cleared: !v.trim(), length: v.trim().length });
                  return ok;
                }}
              />
              <dl className="space-y-1 border-t border-hairline pt-3 text-[13px] text-quiet">
                <Meta label="Added" value={formatDate(lead.createdAt)} />
                {lead.lastContactedAt && <Meta label="Last contacted" value={formatDate(lead.lastContactedAt)} />}
                {lead.researchFinishedAt && <Meta label="Researched" value={formatDateTime(lead.researchFinishedAt)} />}
              </dl>
            </div>
          </Panel>
          <ActivitySection events={events} />
        </aside>
      </div>

      <p role="status" className="sr-only">
        {said}
      </p>
      {/* The Stage select's question: the same one Remove asks, for this lead. */}
      <UnqualifyDialog open={askUnqualify} count={1} busy={removing === "unqualify"} error={removeError} onConfirm={(reason) => void markUnqualified(reason)} onCancel={() => setAskUnqualify(false)} />
      {/* An unqualified lead is already hidden, so the only way further is to delete it. */}
      <ConfirmDialog open={removeOpen && unqualified} title="Delete this lead for good?" confirmLabel="Delete for good" busy={removing === "delete"} error={removeError} onConfirm={() => void remove()} onCancel={() => setRemoveOpen(false)}>
        {leadName(lead)} goes with the research, drafts and activity, and a later import can add them again. Left unqualified, the lead stays hidden and out of imports.
      </ConfirmDialog>
      <RemoveDialog
        open={removeOpen && !unqualified}
        name={leadName(lead)}
        busy={removing}
        error={removeError}
        onUnqualify={(reason) => void markUnqualified(reason)}
        onDelete={() => void remove()}
        onCancel={() => setRemoveOpen(false)}
      />
    </>
  );
}

/** Two ways to take a lead off the lists: mark it unqualified (it can come back), or delete it for good. */
function RemoveDialog({
  open,
  name,
  busy,
  error,
  onUnqualify,
  onDelete,
  onCancel,
}: {
  open: boolean;
  name: string;
  busy: "unqualify" | "delete" | null;
  error: string | null;
  onUnqualify: (reason: UnqualifiedReasonKey | null) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<UnqualifiedReasonKey | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setReason(null);
  }
  const titleId = useId();
  const reasonId = useId();
  return (
    <Modal open={open} busy={busy !== null} onClose={onCancel} labelledBy={titleId}>
      <div className="p-5">
        <h2 id={titleId} className="break-words font-serif text-[21px] leading-snug">
          Remove {name}?
        </h2>

        <section className="mt-4" aria-label="Mark unqualified">
          <h3 className="font-medium">Mark unqualified</h3>
          <p className="mt-1 text-[13.5px] text-quiet">Hides the lead from Active and the pipeline and keeps it out of future imports. The research stays, and you can restore it any time.</p>
          <p id={reasonId} className="mb-1.5 mt-3 text-[13px] font-medium">
            Reason <span className="font-normal text-quiet">Optional</span>
          </p>
          <ReasonChips value={reason} onChange={setReason} disabled={busy !== null} labelledBy={reasonId} />
          <div className="mt-4">
            <Button variant="primary" onClick={() => onUnqualify(reason)} busy={busy === "unqualify"} disabled={busy === "delete"}>
              Mark unqualified
            </Button>
          </div>
        </section>

        <section className="mt-5 border-t border-hairline pt-4" aria-label="Delete for good">
          <h3 className="font-medium">Delete for good</h3>
          <p className="mt-1 text-[13.5px] text-quiet">Removes the lead with its research, drafts and activity. A later import can add them again.</p>
          <div className="mt-3">
            <Button variant="danger" onClick={onDelete} busy={busy === "delete"} disabled={busy === "unqualify"}>
              Delete for good
            </Button>
          </div>
        </section>

        {error && (
          <div className="mt-4">
            <Notice>{error}</Notice>
          </div>
        )}
        <div className="mt-5 flex justify-end border-t border-hairline pt-4">
          <Button onClick={onCancel} disabled={busy !== null}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

/** A text field that saves when focus leaves it, and says so. */
function SavedField({ id, label, initial, placeholder, multiline, onSave }: { id: string; label: string; initial: string; placeholder?: string; multiline?: boolean; onSave: (value: string) => Promise<boolean> }) {
  const [value, setValue] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");

  // The saved value changed underneath (a save came back, or a refresh brought
  // someone else's edit): follow it unless the person is part-way through typing.
  if (initial !== seen) {
    setSeen(initial);
    if (value === seen) setValue(initial);
  }

  async function commit() {
    const next = value.trim();
    if (next !== value) setValue(next);
    if (next === initial || state === "saving") return;
    setState("saving");
    const ok = await onSave(next);
    setState(ok ? "saved" : "idle");
  }

  const hint = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : value !== initial ? "Unsaved" : undefined;
  return (
    <div>
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      {multiline ? (
        <textarea id={id} rows={4} className="field" maxLength={5000} placeholder={placeholder} value={value} onChange={(e) => { setValue(e.target.value); setState("idle"); }} onBlur={() => void commit()} />
      ) : (
        <input
          id={id}
          className="field"
          maxLength={120}
          placeholder={placeholder}
          value={value}
          onChange={(e) => { setValue(e.target.value); setState("idle"); }}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      )}
    </div>
  );
}

function SteerSection({ leadId, running, onStarted }: { leadId: string; running: boolean; onStarted: () => void }) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = instruction.trim();
    if (!text || busy || running) return;
    setBusy(true);
    setError(null);
    try {
      await steerLead(leadId, text);
      track("steer_sent", { leadId, instructionLength: text.length });
      setInstruction("");
      onStarted();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "The agent is already working on this lead. Try again when it finishes." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Steer" id="steer">
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="steer-input" className="sr-only">
          Tell the agent what to change or dig into
        </label>
        <input
          id="steer-input"
          className="field"
          placeholder="Tell the agent what to change or dig into"
          value={instruction}
          maxLength={1000}
          disabled={running}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <Button type="submit" variant="primary" busy={busy} className="shrink-0" disabledReason={running ? "The agent is working. Wait for it to finish." : !instruction.trim() ? "Type an instruction first." : null} tipEnd>
          Send to agent
        </Button>
      </form>
      <p className="mt-2 text-[13px] text-quiet">For example: “Shorter, and lead with their Franka fleet” or “Find out how they run inference today”.</p>
      {error && (
        <div className="mt-3">
          <Notice>{error}</Notice>
        </div>
      )}
    </Panel>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading lead">
      <Skeleton className="mb-5 h-4 w-16" />
      <Skeleton className="h-9 w-64 max-w-full" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_296px] lg:gap-8">
        <div className="space-y-6">
          {[5, 3, 6].map((n, i) => (
            <div key={i} className="card p-5">
              <Skeleton className="h-5 w-32" />
              <div className="mt-4 space-y-2.5">
                {Array.from({ length: n }, (_, j) => (
                  <Skeleton key={j} className="h-3.5" style={{ width: `${[92, 80, 86, 64, 74, 58][j % 6]}%` }} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="card h-72 p-5">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="mt-4 h-9" />
          <Skeleton className="mt-3 h-9" />
          <Skeleton className="mt-3 h-9" />
        </div>
      </div>
    </div>
  );
}

