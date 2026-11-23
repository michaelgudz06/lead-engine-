"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ApiError, deleteLead, errorMessage, getLead, getStatusCached, pushToHubspot, startResearch, steerLead, updateLead, type LeadPatch, type StatusResponse } from "@/lib/api-client";
import { nextAction } from "@/lib/next-action";
import type { Finding, Lead, LeadDetail } from "@/lib/types";
import { formatDate, formatDateTime, fromDateInput, hostOf, isRunning, leadName, safeUrl, settleLostRun, titleAtCompany, toDateInput } from "@/components/format";
import { AnglesSection } from "@/components/lead/angles";
import { Panel } from "@/components/lead/panel";
import { ActivitySection, BriefSection, CompanySection, FindingsSection, PendingPanel, ResearchProgress } from "@/components/lead/sections";
import { Button, Chip, ConfirmDialog, ErrorState, ExternalLink, Label, Notice, Skeleton, StageSelect } from "@/components/ui";
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
  const [pushing, setPushing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const findingMap = useMemo(() => new Map<string, Finding>(findings.map((f) => [f.id, f])), [findings]);

  useEffect(() => {
    document.title = `${leadName(lead)} · Lead Engine`;
  }, [lead]);

  async function rerun() {
    setStarting(true);
    setActionError(null);
    setNotice(null);
    try {
      await startResearch(lead.id);
      // Show the running state at once; the next poll brings the real step.
      setLead({ ...lead, researchStatus: "running", researchStep: "Starting research", researchError: null, researchStartedAt: new Date().toISOString() });
    } catch (err) {
      // 409 means a run is already going: just show it.
      if (!(err instanceof ApiError && err.status === 409)) setActionError(errorMessage(err));
    } finally {
      setStarting(false);
      void reload();
    }
  }

  /** Saves a change. Resolves to false (after putting the old value back) when it fails. */
  async function patch(change: LeadPatch): Promise<boolean> {
    setActionError(null);
    const before = lead;
    setLead({ ...lead, ...change } as Lead);
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
      setNotice("Pushed to HubSpot.");
      void reload();
    } catch (err) {
      setActionError(`HubSpot: ${errorMessage(err)}`);
    } finally {
      setPushing(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteLead(lead.id);
      router.push("/");
    } catch (err) {
      setDeleteError(errorMessage(err));
      setDeleting(false);
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
  const action = nextAction(settleLostRun(lead));
  const hasResearch = Boolean(lead.brief || lead.companyPicture || lead.angles.length > 0);

  return (
    <>
      <Link href="/" className="mb-4 inline-block text-[13.5px] text-quiet hover:text-ink">
        ← Leads
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
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] wrap-anywhere">
            {linkedin && <ExternalLink href={linkedin}>LinkedIn ↗</ExternalLink>}
            {lead.email && (
              <span>
                <a href={`mailto:${lead.email}`} className="text-link underline-offset-2 hover:underline">
                  {lead.email}
                </a>
                {typeof lead.emailConfidence === "number" && <span className="text-quiet"> · {Math.round(lead.emailConfidence)}% sure</span>}
              </span>
            )}
            {xHandle && <ExternalLink href={`https://x.com/${encodeURIComponent(xHandle)}`}>@{xHandle} ↗</ExternalLink>}
            {companyUrl && <ExternalLink href={companyUrl}>{hostOf(companyUrl)} ↗</ExternalLink>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={rerun} busy={starting} disabledReason={running ? "Research is already running." : null}>
            {hasResearch || failed ? "Re-run research" : "Run research"}
          </Button>
          <Button onClick={hubspot} busy={pushing} disabledReason={hubspotReason} tipEnd>
            Push to HubSpot
          </Button>
          <Button variant="danger" onClick={() => { setDeleteError(null); setConfirmDelete(true); }}>
            Delete
          </Button>
        </div>
      </header>

      <div className="mb-5 space-y-3 empty:hidden">
        {actionError && <Notice>{actionError}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}
        {refreshError && <Notice>Live updates paused: {refreshError} Retrying…</Notice>}
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

          {!running && !hasResearch && !failed && (
            <div className="card px-5 py-8 text-center">
              <h2 className="font-serif text-[21px]">No research yet</h2>
              <p className="mx-auto mt-1.5 max-w-md text-quiet">Run research to get a sourced brief, a picture of the company and drafted outreach.</p>
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
            <AnglesSection lead={lead} findings={findingMap} locked={running} onLeadChange={setLead} onActivity={() => void reload()} />
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
                <StageSelect id="stage" value={lead.stage} onChange={(stage) => void patch({ stage })} />
              </div>
              <SavedField id="owner" label="Owner" initial={lead.owner ?? ""} placeholder="Who is on this lead" onSave={(v) => patch({ owner: v.trim() || null })} />
              <div>
                <Label htmlFor="nextStepAt" hint={lead.nextStepAt ? <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => void patch({ nextStepAt: null })}>Clear</button> : undefined}>
                  Follow up on
                </Label>
                <input id="nextStepAt" type="date" className="field" value={toDateInput(lead.nextStepAt)} onChange={(e) => void patch({ nextStepAt: e.target.value ? fromDateInput(e.target.value) : null })} />
              </div>
              <SavedField id="notes" label="Your notes" multiline initial={lead.notes ?? ""} placeholder="How you know them, what was said, what you want" onSave={(v) => patch({ notes: v.trim() || null })} />
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

      <ConfirmDialog open={confirmDelete} title="Delete this lead?" confirmLabel="Delete lead" busy={deleting} error={deleteError} onConfirm={remove} onCancel={() => setConfirmDelete(false)}>
        {leadName(lead)}, with the brief, drafts, findings and activity, will be removed for good.
      </ConfirmDialog>
    </>
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

