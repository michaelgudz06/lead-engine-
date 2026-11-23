"use client";

import { useEffect, useMemo, useState } from "react";
import { SOURCES, SOURCE_LABELS, type Brief, type CompanyPicture, type Finding, type Lead, type LeadEvent, type Source } from "@/lib/types";
import { elapsed, formatDate, formatDateTime, hostOf, safeUrl, timeAgo } from "../format";
import { Button, Chip, ExternalLink, Skeleton, cx } from "../ui";
import { CitedList, Panel, PlainList, SubHeading } from "./panel";

type FindingMap = Map<string, Finding>;

function newestFirst(events: LeadEvent[]): LeadEvent[] {
  return [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
}

/* ---------- Research in progress ---------- */

export function ResearchProgress({ lead, events }: { lead: Lead; events: LeadEvent[] }) {
  // A ticking clock shows the page is alive between the 2-second polls.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const recent = useMemo(() => {
    const start = lead.researchStartedAt ? Date.parse(lead.researchStartedAt) : NaN;
    const all = newestFirst(events);
    // Only this run's events; allow a little clock skew between app and database.
    const thisRun = Number.isFinite(start) ? all.filter((e) => Date.parse(e.createdAt) >= start - 5000) : all;
    return thisRun.slice(0, 6);
  }, [events, lead.researchStartedAt]);

  return (
    <section className="card" role="status" aria-live="polite" aria-label="Research in progress">
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <span className="spinner" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{lead.researchStep?.trim() || "Starting research"}</div>
          <div className="text-[13px] text-quiet">Usually one to three minutes. You can leave this page; it keeps going.</div>
        </div>
        {now !== null && lead.researchStartedAt && <span className="shrink-0 tabular-nums text-[13px] text-quiet">{elapsed(lead.researchStartedAt, now)}</span>}
      </div>
      {recent.length > 0 && (
        <ol className="border-t border-hairline px-4 py-3 sm:px-5">
          {recent.map((e, i) => (
            <li key={e.id} className={cx("flex items-baseline gap-3 py-[3px] text-[13.5px]", i === 0 ? "text-ink" : "text-quiet")}>
              <span aria-hidden className={cx("mt-[7px] h-1 w-1 shrink-0 self-start rounded-full", i === 0 ? "bg-ink" : "bg-hairline")} />
              <span className="min-w-0 flex-1 wrap-anywhere">{e.message}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-quiet">{new Date(e.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Placeholder for a section whose content arrives when research finishes. */
export function PendingPanel({ title, lines = 4 }: { title: string; lines?: number }) {
  const widths = [92, 78, 85, 64, 72];
  return (
    <Panel title={title} aside={<span className="text-[13px] text-quiet">Appears when research finishes</span>}>
      <div className="space-y-2.5" aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className="h-3.5" style={{ width: `${widths[i % widths.length]}%` }} />
        ))}
      </div>
    </Panel>
  );
}

/* ---------- Brief ---------- */

export function BriefSection({ brief, findings }: { brief: Brief; findings: FindingMap }) {
  const bullets = Array.isArray(brief.bullets) ? brief.bullets : [];
  const pains = Array.isArray(brief.pains) ? brief.pains : [];
  const objections = Array.isArray(brief.objections) ? brief.objections : [];
  const questions = Array.isArray(brief.questions) ? brief.questions : [];
  return (
    <Panel title="Brief" id="brief">
      {brief.summary && <p className="text-[15.5px] leading-relaxed">{brief.summary}</p>}
      {bullets.length > 0 && (
        <div className="mt-4">
          <CitedList items={bullets} findings={findings} />
        </div>
      )}
      {(pains.length > 0 || objections.length > 0 || questions.length > 0) && (
        <div className="mt-5 grid gap-x-8 gap-y-5 border-t border-hairline pt-4 md:grid-cols-2">
          {pains.length > 0 && (
            <div>
              <SubHeading>Pains</SubHeading>
              <CitedList items={pains} findings={findings} />
            </div>
          )}
          {objections.length > 0 && (
            <div>
              <SubHeading>Likely objections</SubHeading>
              <PlainList items={objections} />
            </div>
          )}
          {questions.length > 0 && (
            <div className="md:col-span-2">
              <SubHeading>Questions for the first call</SubHeading>
              <PlainList items={questions} />
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ---------- Company picture ---------- */

export function CompanySection({ company, findings }: { company: CompanyPicture; findings: FindingMap }) {
  const facts: Array<[string, string | null]> = [
    ["Headcount", company.headcount],
    ["Growth", company.growth],
    ["Funding", company.funding],
  ];
  const known = facts.filter(([, v]) => v && v.trim());
  const groups: Array<[string, CompanyPicture["team"]]> = [
    ["Team", company.team],
    ["Hiring", company.hiring],
    ["Robots and models", company.robotsAndModels],
    ["Decision makers", company.decisionMakers],
  ];
  const filled = groups.filter(([, items]) => Array.isArray(items) && items.some((i) => i?.text?.trim()));
  const domainUrl = company.domain ? safeUrl(`https://${company.domain.replace(/^https?:\/\//, "")}`) : null;
  const nothing = !company.oneLiner && known.length === 0 && filled.length === 0;

  return (
    <Panel
      title="Company picture"
      id="company"
      aside={
        (company.name || domainUrl) && (
          <span className="text-[13.5px] text-quiet">
            {company.name}
            {company.name && domainUrl && " · "}
            {domainUrl && <ExternalLink href={domainUrl}>{hostOf(domainUrl)}</ExternalLink>}
          </span>
        )
      }
    >
      {nothing ? (
        <p className="text-quiet">The agent did not find enough about the company. Use Steer below to point it somewhere.</p>
      ) : (
        <>
          {company.oneLiner && <p className="text-[15.5px] leading-relaxed">{company.oneLiner}</p>}
          {known.length > 0 && (
            <dl className={cx("grid gap-x-6 gap-y-3 sm:grid-cols-3", company.oneLiner && "mt-4")}>
              {known.map(([label, value]) => (
                <div key={label}>
                  <dt className="eyebrow">{label}</dt>
                  <dd className="mt-0.5">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {filled.length > 0 && (
            <div className={cx("grid gap-x-8 gap-y-5 md:grid-cols-2", (company.oneLiner || known.length > 0) && "mt-5 border-t border-hairline pt-4")}>
              {filled.map(([label, items]) => (
                <div key={label}>
                  <SubHeading>{label}</SubHeading>
                  <CitedList items={items} findings={findings} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/* ---------- Findings ---------- */

export function FindingsSection({ findings }: { findings: Finding[] }) {
  const [showFiltered, setShowFiltered] = useState(false);
  const filteredCount = findings.filter((f) => !f.passesCriteria).length;
  const visible = showFiltered ? findings : findings.filter((f) => f.passesCriteria);

  // A source link elsewhere on the page may point at a filtered-out finding:
  // reveal those so the jump always lands somewhere.
  useEffect(() => {
    const reveal = () => {
      const id = window.location.hash.replace(/^#finding-/, "");
      if (id && id !== window.location.hash && findings.some((f) => f.id === id && !f.passesCriteria)) setShowFiltered(true);
    };
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [findings]);

  const groups = useMemo(() => {
    const bySource = new Map<Source, Finding[]>();
    for (const f of visible) {
      const list = bySource.get(f.source) ?? [];
      list.push(f);
      bySource.set(f.source, list);
    }
    // Known sources in a fixed order, then anything unexpected.
    const order = [...SOURCES, ...[...bySource.keys()].filter((s) => !SOURCES.includes(s))];
    return order.filter((s) => bySource.has(s)).map((s) => ({ source: s, items: [...(bySource.get(s) ?? [])].sort((a, b) => b.relevance - a.relevance) }));
  }, [visible]);

  return (
    <Panel
      title="Findings"
      id="findings"
      aside={
        <div className="flex items-center gap-3 text-[13px] text-quiet">
          <span>
            {visible.length} {visible.length === 1 ? "finding" : "findings"}
          </span>
          {filteredCount > 0 && (
            <label className="flex cursor-pointer items-center gap-1.5 text-ink">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[#22221f]" checked={showFiltered} onChange={(e) => setShowFiltered(e.target.checked)} />
              Show filtered out ({filteredCount})
            </label>
          )}
        </div>
      }
    >
      {findings.length === 0 ? (
        <p className="text-quiet">No findings yet. They are listed here, with their sources, as research runs.</p>
      ) : visible.length === 0 ? (
        <p className="text-quiet">Every finding was filtered out by your criteria. Tick “Show filtered out” to see them and why.</p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <details key={g.source} open className="group">
              <summary className="flex list-none items-center gap-2 rounded [&::-webkit-details-marker]:hidden">
                <svg aria-hidden viewBox="0 0 10 10" className="h-2.5 w-2.5 text-quiet transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3.5 1.5L7 5 3.5 8.5" />
                </svg>
                <span className="eyebrow">{SOURCE_LABELS[g.source] ?? g.source}</span>
                <span className="text-[12px] text-quiet">{g.items.length}</span>
              </summary>
              <ul className="mt-2 divide-y divide-hairline border-y border-hairline">
                {g.items.map((f) => (
                  <FindingRow key={f.id} finding={f} />
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </Panel>
  );
}

function FindingRow({ finding: f }: { finding: Finding }) {
  const url = safeUrl(f.url);
  const date = formatDate(f.publishedAt);
  return (
    <li id={`finding-${f.id}`} className={cx("scroll-mt-24 py-2.5 wrap-anywhere target:bg-wash", !f.passesCriteria && "opacity-70")}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {f.title && <span className="font-medium">{f.title}</span>}
        <span className="text-[12px] text-quiet">
          {f.kind}
          {date && ` · ${date}`}
        </span>
      </div>
      <p className="mt-0.5 break-words">{f.text}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-quiet">
        {url && <ExternalLink href={url}>{hostOf(url)} ↗</ExternalLink>}
        {!f.passesCriteria && (
          <Chip tone="quiet" className="h-auto min-h-[22px] whitespace-normal py-0.5 leading-snug">
            Filtered out{f.excludedReason ? `: ${f.excludedReason}` : ""}
          </Chip>
        )}
      </div>
    </li>
  );
}

/* ---------- Activity ---------- */

const EVENT_LABELS: Record<string, string> = {
  created: "Added",
  step: "Research",
  tool: "Agent",
  finding: "Finding",
  done: "Done",
  error: "Error",
  steer: "Steer",
  copied: "Copied",
  sent: "Sent",
  stage: "Stage",
  hubspot: "HubSpot",
  note: "Note",
};

export function ActivitySection({ events }: { events: LeadEvent[] }) {
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => newestFirst(events), [events]);
  const LIMIT = 12;
  const shown = all ? sorted : sorted.slice(0, LIMIT);
  return (
    <Panel title="Activity" id="activity">
      {sorted.length === 0 ? (
        <p className="text-quiet">Nothing has happened yet.</p>
      ) : (
        <>
          <ol className="space-y-3">
            {shown.map((e) => (
              <li key={e.id} className="text-[13.5px]">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cx("eyebrow", e.type === "error" && "!text-danger")}>{EVENT_LABELS[e.type] ?? e.type}</span>
                  <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)} className="shrink-0 text-[12px] text-quiet">
                    {timeAgo(e.createdAt)}
                  </time>
                </div>
                <p className={cx("mt-0.5 wrap-anywhere", e.type === "error" && "text-danger")}>{e.message}</p>
              </li>
            ))}
          </ol>
          {sorted.length > LIMIT && (
            <div className="mt-3 border-t border-hairline pt-3">
              <Button size="sm" variant="ghost" className="-ml-2 text-quiet" onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${sorted.length}`}
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

