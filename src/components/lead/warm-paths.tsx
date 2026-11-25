"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { ApiError, draftIntro, errorMessage, findWarmPaths, logEvent, saveIntro, warmPathsFromError } from "@/lib/api-client";
import {
  SEE_MUTUALS_ON_LINKEDIN,
  STRENGTH_LABELS,
  STRENGTH_TOOLTIPS,
  anythingChecked,
  companyPeopleIntro,
  connectorLine,
  directBoxLines,
  directOverlapLine,
  evidencePhrase,
  firstNameOf,
  linkPhrases,
  lookingTitle,
  mutualsNotChecked,
  noPathsCopy,
  notSetUpText,
  pathSummaryLine,
  shortDate,
  sourceLine,
} from "@/lib/paths/copy";
import { xProfileUrl } from "@/lib/paths/links";
import { isConfirmedDirect, panelPaths, pathNetwork } from "@/lib/paths/score";
import { INTRO_DRAFT_MAX, type WarmLink, type WarmPath, type WarmPaths, type WarmSourceNetwork, type WarmStrength } from "@/lib/paths/types";
import { cleanXHandle } from "@/lib/research/util";
import { STAGE_LABELS, type Lead } from "@/lib/types";
import { AutoTextarea } from "../auto-textarea";
import { formatDateTime, leadName, safeUrl, timeAgo, titleAtCompany } from "../format";
import { Button, ButtonLink, Chip, ConfirmDialog, Label, Notice, Skeleton, cx } from "../ui";
import { copyText, countWords } from "./angles";
import { Panel } from "./panel";

/**
 * Warm paths: who can introduce you to this lead. A list of ways in, best first; each opens into
 * the chain You, the person in between, the lead, with the evidence for each link and how strong
 * it is. The words come from src/lib/paths/copy.ts, so they match the server's.
 *
 * States, the first that matches wins: not set up, looking, ready (never checked), then what was
 * found (or that nothing was), with a notice on top when the last check failed.
 */

/** An X check reserves this much of the daily budget, so less than this left means no X check. */
const X_CHECK_USD = 0.15;

/** The best path for the page header and analytics: "direct" for a confirmed tie, else the strongest one. */
export function bestWarmPath(paths: WarmPaths | null | undefined): { path: WarmPath; best: WarmStrength | "direct" } | null {
  const first = paths?.paths[0];
  if (!first) return null;
  if (isConfirmedDirect(first)) return { path: first, best: "direct" };
  // A weak direct overlap (the same school) is listed first, so look past it for a better path.
  const path = paths.paths.find((p) => p.strength === "strong") ?? paths.paths.find((p) => p.strength === "medium") ?? first;
  return path.strength ? { path, best: path.strength } : null;
}

/**
 * The header link's words: "You're connected" for a direct tie, "Warm path via Priya Shah" for a
 * Strong or Medium path. Null for anything weaker, and while a check runs.
 */
export function warmPathHeadline(paths: WarmPaths | null | undefined): string | null {
  if (!paths || paths.status === "running") return null;
  const best = bestWarmPath(paths);
  if (!best) return null;
  if (best.best === "direct") return "You're connected";
  if (best.best === "weak") return null;
  return best.path.hops === 2 && best.path.connector ? `Warm path via ${best.path.connector.name}` : "Warm path";
}

/** Why "Find warm paths" / "Check again" cannot run now, or null when it can. */
function checkBlockedReason(lead: Pick<Lead, "linkedinUrl" | "xHandle">, paths: WarmPaths, researchRunning: boolean, checking: boolean): string | null {
  if (researchRunning) return "Research is running. It checks warm paths too.";
  if (checking) return "Checking now.";
  // As the server: a check needs their LinkedIn profile or X handle.
  if (!lead.linkedinUrl && !cleanXHandle(lead.xHandle)) return "Add their LinkedIn profile or X handle under Details first.";
  // A first check always saves the free part (your connections, work history and schools), even
  // with no budget left (the server answers 429 with it), so budgets only hold back a check again.
  if (!paths.checkedAt) return null;
  const { setup, limits } = paths;
  const anyLive = setup.linkedinAccount || setup.x;
  const linkedinSpent = !setup.linkedinAccount || limits.linkedinChecksLeft === 0;
  const xSpent = !setup.x || (limits.xUsdLeft ?? 0) < X_CHECK_USD;
  if (anyLive && linkedinSpent && xSpent) return "Today's warm-path budgets are used up. Try again tomorrow.";
  return null;
}

/** "your LinkedIn connections and X follows": only what is set up. */
function lookingAt(paths: WarmPaths): string {
  const { setup } = paths;
  const parts: string[] = [];
  if (setup.linkedinConnections) parts.push("your LinkedIn connections");
  else if (setup.linkedinProfile) parts.push("your work history");
  else if (setup.linkedinAccount) parts.push("your LinkedIn account");
  if (setup.x) parts.push(parts.length ? "X follows" : "your X follows");
  return parts.join(" and ");
}

// A short hash of the message a draft came back with, kept in this browser so "Redraft" only asks
// before it replaces text that was edited. Never the text: a hash is enough to tell an edit, and
// the path id is opaque (it names nobody). Unknown (another browser, cleared storage) counts as edited.
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
const draftKey = (leadId: string, pathId: string) => `le-intro:${leadId}:${pathId}`;
function rememberDraft(leadId: string, pathId: string, message: string) {
  try {
    window.localStorage.setItem(draftKey(leadId, pathId), shortHash(message));
  } catch {
    // Private mode or blocked storage: Redraft asks first, which is the safe side.
  }
}
function isUneditedDraft(leadId: string, pathId: string, text: string): boolean {
  try {
    return window.localStorage.getItem(draftKey(leadId, pathId)) === shortHash(text);
  } catch {
    return false;
  }
}

/** A quiet line whose word "Settings" links to Settings > Your network (the copy says where; this makes it a link). */
function WithSettingsLink({ text }: { text: string }) {
  const at = text.indexOf("Settings");
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <Link href="/settings#network" className="text-link underline-offset-2 hover:underline">
        Settings
      </Link>
      {text.slice(at + "Settings".length)}
    </>
  );
}

/**
 * The failed check's notice: the stored reason, framed as "Could not check for warm paths. ...
 * Try again in a few minutes." unless it already ends by saying to try again.
 */
function failedNotice(error: string | null): string {
  if (!error) return "Could not check for warm paths. Try again in a few minutes.";
  return /(?:^|[.!?]\s+)Try again\b[^.]*\.\s*$/.test(error) ? error : `Could not check for warm paths. ${error} Try again in a few minutes.`;
}

export function WarmPathsPanel({
  lead,
  paths,
  researchRunning,
  hasAngles,
  onPaths,
  onActivity,
}: {
  lead: Lead;
  paths: WarmPaths;
  /** Research is running: it checks warm paths itself, so the button waits. */
  researchRunning: boolean;
  /** Angles exist, so the direct box can point to the drafted LinkedIn message. */
  hasAngles: boolean;
  onPaths: (paths: WarmPaths) => void;
  /** Something was logged to Activity, or the paths changed on the server: reload the lead. */
  onActivity: () => void;
}) {
  const name = leadName(lead);
  const first = paths.leadFirstName || firstNameOf(lead.name);
  const [requesting, setRequesting] = useState(false);
  const [checkNotice, setCheckNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [drafting, setDrafting] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  // After a check, focus goes to the result (the button that started it is gone or was disabled).
  const body = useRef<HTMLDivElement>(null);
  const [focusBody, setFocusBody] = useState(0);
  useEffect(() => {
    if (focusBody === 0) return;
    const active = document.activeElement;
    // Only when focus was lost or is still in this panel: never pull it out of another field.
    if (!active || active === document.body || body.current?.closest("section")?.contains(active)) body.current?.focus();
  }, [focusBody]);

  // "Show N more": focus goes to the first row it revealed.
  const list = useRef<HTMLOListElement>(null);
  const [focusMore, setFocusMore] = useState(0);
  useEffect(() => {
    if (focusMore > 0) list.current?.querySelector<HTMLElement>("[data-more-first] summary")?.focus();
  }, [focusMore]);

  const checking = requesting || paths.status === "running";
  const looking = checking || (researchRunning && paths.setup.any && !paths.checkedAt);
  const blocked = checkBlockedReason(lead, paths, researchRunning, checking);

  async function check(trigger: "find" | "again") {
    if (requesting) return;
    setRequesting(true);
    setCheckNotice(null);
    // The button goes while the check runs: keep focus in the panel, and say the check started in
    // the status that is always there (the looking state's own status appears already filled).
    setSaid("Checking for warm paths.");
    body.current?.focus();
    try {
      const res = await findWarmPaths(lead.id);
      if (res.paths) onPaths(res.paths);
      const best = bestWarmPath(res.paths);
      const found = res.paths?.paths.length ?? 0;
      track("warm_paths_checked", { leadId: lead.id, found, best: best?.best ?? "none", trigger });
      // Never "no one you know" unless people you both know were really looked for (noPathsCopy).
      const none = res.paths ? [noPathsCopy(res.paths, { researched: Boolean(lead.researchFinishedAt) }).title, companyPeopleIntro(res.paths)].filter(Boolean).join(" ") : "The check finished.";
      setSaid(best?.best === "direct" ? `You're already connected to ${first}.` : found > 0 ? `Found ${found === 1 ? "1 way" : `${found} ways`} to reach ${first}.` : none);
    } catch (err) {
      // A check that was refused or partly failed still carries what was saved (the free part).
      const carried = warmPathsFromError(err);
      if (carried) onPaths(carried);
      const code = err instanceof ApiError ? err.code : null;
      // A budget refusal still saved the free part, and says so: information, not an error.
      const calm = code === "nothing_to_check" || code === "not_set_up" || code === "research_running" || code === "checking" || code === "changed" || code === "warm_path_budget" || code === "warm_path_check_limit";
      // The notice speaks for itself (an alert, or a status for the calm ones).
      setSaid("");
      setCheckNotice({ tone: calm ? "info" : "error", text: errorMessage(err) });
      track("warm_paths_checked", { leadId: lead.id, found: carried?.paths.length ?? 0, best: bestWarmPath(carried)?.best ?? "none", trigger });
    } finally {
      setRequesting(false);
      setFocusBody((n) => n + 1);
      onActivity();
    }
  }

  function replacePath(next: WarmPath) {
    const swap = (p: WarmPath) => (p.id === next.id ? { ...next, rank: p.rank } : p);
    onPaths({ ...paths, paths: paths.paths.map(swap), companyPaths: paths.companyPaths.map(swap) });
  }

  function linkOpened(network: WarmSourceNetwork, kind: "check_yourself" | "connector" | "lead") {
    track("warm_path_link_opened", { leadId: lead.id, network, kind });
  }

  const yourself = (
    [
      paths.links.linkedinMutuals ? { network: "linkedin" as const, href: paths.links.linkedinMutuals, label: "Mutual connections on LinkedIn" } : null,
      paths.links.xFollowersYouKnow ? { network: "x" as const, href: paths.links.xFollowersYouKnow, label: "Followers you know on X" } : null,
      paths.links.instagram ? { network: "instagram" as const, href: paths.links.instagram, label: "Instagram" } : null,
    ] as const
  ).filter((l) => l !== null);
  const checkYourself = (intro: string, opts: { withoutLinkedin?: boolean } = {}) => {
    const shown = opts.withoutLinkedin ? yourself.filter((l) => l.network !== "linkedin") : yourself;
    return (
      shown.length > 0 && (
        <p className="text-[13px] leading-relaxed text-quiet wrap-anywhere" onClick={(e) => {
          const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[data-network]") : null;
          if (a) linkOpened(a.dataset.network as WarmSourceNetwork, "check_yourself");
        }}>
          {intro}{" "}
          {shown.map((l, i) => (
            <span key={l.network}>
              {i > 0 && " · "}
              <a href={l.href} data-network={l.network} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-link underline-offset-2 hover:underline">
                {l.label} ↗
              </a>
            </span>
          ))}
        </p>
      )
    );
  };
  // LinkedIn's own list of the people you share, for where they would be listed when the app did not check them.
  const seeOnLinkedin = paths.links.linkedinMutuals && (
    <a href={paths.links.linkedinMutuals} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-link underline-offset-2 hover:underline" onClick={() => linkOpened("linkedin", "check_yourself")}>
      {SEE_MUTUALS_ON_LINKEDIN} ↗
    </a>
  );

  // ---- what was found
  const direct = paths.paths[0] && isConfirmedDirect(paths.paths[0]) ? paths.paths[0] : null;
  const directLines = direct ? directBoxLines(direct, first) : null;
  const rest = direct ? paths.paths.slice(1) : paths.paths;
  const { shown, more } = panelPaths(rest);
  const rows = showAll ? [...shown, ...more] : shown;
  // People at their company, unless you are already connected (no intro needed).
  const people = direct ? [] : paths.companyPaths;
  const nothing = paths.paths.length === 0;
  const checked = Boolean(paths.checkedAt);
  const failed = paths.status === "error";
  const persistedError = failed ? failedNotice(paths.error) : null;
  const notice = checkNotice ?? (persistedError ? { tone: "error" as const, text: persistedError } : null);
  const isOpen = (p: WarmPath, i: number, group: "path" | "company") => opened[p.id] ?? (group === "path" && i === 0 && !direct);

  function toggled(p: WarmPath, open: boolean, was: boolean) {
    if (open === was) return;
    setOpened((o) => ({ ...o, [p.id]: open }));
    if (open) track("warm_path_opened", { leadId: lead.id, rank: p.rank, strength: p.strength ?? "none", hops: p.hops });
  }

  const rowProps = { lead, first, drafting, onDrafting: setDrafting, onPath: replacePath, onActivity, onLink: linkOpened, onSay: setSaid };
  // Only when a source was really checked (or its earlier result used): never in the not-set-up state.
  const checkedAside = checked && !looking && paths.setup.any && anythingChecked(paths) && paths.checkedAt && (
    <time dateTime={paths.checkedAt} title={formatDateTime(paths.checkedAt)} className="text-[12.5px] text-quiet">
      Updated {timeAgo(paths.checkedAt)}
    </time>
  );
  // Nothing found: the words say exactly what was compared (noPathsCopy).
  const none = nothing && !failed ? noPathsCopy(paths, { researched: Boolean(lead.researchFinishedAt) }) : null;
  // Something found, but people you both know were not looked for: say so where they would be listed.
  const mutualsNote = !nothing && !failed ? mutualsNotChecked(paths) : "";
  const noteShowsLinkedin = Boolean((none?.mutuals || (mutualsNote && paths.links.linkedinMutuals)) && seeOnLinkedin);

  let content: React.ReactNode;
  if (!paths.setup.any) {
    content = (
      <div>
        <p className="max-w-prose">{notSetUpText({ setup: paths.setup, leadFirstName: first })}</p>
        <div className="mt-3.5">
          <ButtonLink href="/settings#network" size="sm">
            Set up warm paths
          </ButtonLink>
        </div>
        {yourself.length > 0 && <div className="mt-4 border-t border-hairline pt-3">{checkYourself("Or check yourself:")}</div>}
      </div>
    );
  } else if (looking) {
    const what = lookingAt(paths);
    // "People you both know" only when a source of them can run for this lead.
    const mutualsPossible = (paths.setup.x && Boolean(cleanXHandle(lead.xHandle))) || (paths.setup.linkedinAccount && Boolean(lead.linkedinUrl));
    content = (
      <div role="status" aria-live="polite">
        <div className="flex items-center gap-2.5">
          <span className="spinner" aria-hidden />
          <span className="font-medium">{lookingTitle({ leadFirstName: first }, { mutuals: mutualsPossible })}</span>
        </div>
        <p className="mt-1 text-[13px] text-quiet">{what ? `Checking ${what}. ` : ""}Usually under a minute.</p>
        <div className="mt-4 space-y-3.5" aria-hidden>
          {[62, 48].map((w) => (
            <div key={w}>
              <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
              <Skeleton className="mt-2 h-3" style={{ width: `${w + 22}%` }} />
            </div>
          ))}
        </div>
      </div>
    );
  } else if (!checked && !failed) {
    content = (
      <div>
        <p>Look for people who can introduce you to {first}.</p>
        <div className="mt-3.5">
          <Button variant="primary" onClick={() => void check("find")} disabledReason={blocked}>
            Find warm paths
          </Button>
        </div>
        {yourself.length > 0 && <div className="mt-4 border-t border-hairline pt-3">{checkYourself("Or check yourself:")}</div>}
      </div>
    );
  } else {
    content = (
      <div>
        {directLines && direct && (
          <DirectBox lead={lead} first={first} path={direct} lines={directLines} hasAngles={hasAngles} onLink={linkOpened} />
        )}

        {none && (
          <div>
            <p className="font-medium">{none.title}</p>
            {none.detail && (
              <p className="mt-1 text-[13px] leading-relaxed text-quiet">
                <WithSettingsLink text={none.detail} />
              </p>
            )}
            {none.mutuals && (
              <p className="mt-1 text-[13px] leading-relaxed text-quiet wrap-anywhere">
                {none.mutuals}
                {seeOnLinkedin && <> {seeOnLinkedin}</>}
              </p>
            )}
            {none.setUp && (
              <p className="mt-1 text-[13px] leading-relaxed text-quiet">
                <WithSettingsLink text={none.setUp} />
              </p>
            )}
          </div>
        )}
        {/* Something was found, but nobody in between was looked for: say so, quietly, with LinkedIn's own list. */}
        {mutualsNote && seeOnLinkedin && rest.length === 0 && (
          <p className={cx("text-[13px] leading-relaxed text-quiet wrap-anywhere", direct && "mt-4")}>
            {mutualsNote} {seeOnLinkedin}
          </p>
        )}
        {nothing && failed && !checked && <p className="text-quiet">Nothing has been checked for {first} yet.</p>}

        {rest.length > 0 && (
          <div className={cx(direct && "mt-5")}>
            {direct && <h3 className="eyebrow mb-1">Or through someone you both know</h3>}
            {paths.linkedinShared && (
              <p className="mb-1 text-[13px] text-quiet">
                {paths.linkedinShared.count.toLocaleString("en-US")} mutual {paths.linkedinShared.count === 1 ? "connection" : "connections"} on LinkedIn
                {paths.linkedinShared.shown > 0 && paths.linkedinShared.shown < paths.linkedinShared.count ? ` (${paths.linkedinShared.shown} shown)` : ""}.{" "}
                {paths.links.linkedinMutuals && (
                  <a href={paths.links.linkedinMutuals} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-link underline-offset-2 hover:underline" onClick={() => linkOpened("linkedin", "check_yourself")}>
                    See all on LinkedIn ↗
                  </a>
                )}
              </p>
            )}
            <ol ref={list} aria-label={`Ways to reach ${name}, best first`} className="divide-y divide-hairline">
              {rows.map((p, i) => (
                <li key={p.id} data-more-first={i === shown.length ? "" : undefined}>
                  <PathRow {...rowProps} path={p} group="path" open={isOpen(p, i, "path")} onToggle={(open) => toggled(p, open, isOpen(p, i, "path"))} />
                </li>
              ))}
            </ol>
            {mutualsNote && seeOnLinkedin && (
              <p className="border-t border-hairline py-3 text-[13px] leading-relaxed text-quiet wrap-anywhere">
                {mutualsNote} {seeOnLinkedin}
              </p>
            )}
            {more.length > 0 && !showAll && (
              <div className="border-t border-hairline pt-3">
                <Button
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setShowAll(true);
                    setFocusMore((n) => n + 1);
                  }}
                >
                  Show {more.length} more
                </Button>
              </div>
            )}
          </div>
        )}

        {people.length > 0 && (
          <div className={cx((rest.length > 0 || nothing) && "mt-5")}>
            <p>{companyPeopleIntro({ companyPaths: people, sources: paths.sources })}</p>
            <ul aria-label={people.some((p) => p.links[0]?.evidence[0]?.kind === "works_at" && p.links[0].evidence[0].leadLeftYear) ? `People you know at companies ${first} works or worked at` : `People you know at ${first}'s company`} className="mt-1 divide-y divide-hairline">
              {people.map((p, i) => (
                <li key={p.id}>
                  <PathRow {...rowProps} path={p} group="company" open={isOpen(p, i, "company")} onToggle={(open) => toggled(p, open, isOpen(p, i, "company"))} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t border-hairline pt-3">
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            {paths.sources.length > 0 && (
              <ul className="space-y-1 text-[13px] leading-relaxed text-quiet wrap-anywhere">
                {paths.sources.map((s) => (
                  <li key={s.network}>
                    {sourceLine(s)}
                    {/* X off on this server (no TWITTERAPI_IO_KEY): nothing in Settings turns it on. */}
                    {s.state === "not_set_up" && s.reason !== "not_configured" && (
                      <>
                        {" "}
                        <Link href="/settings#network" className="whitespace-nowrap text-link underline-offset-2 hover:underline" aria-label={`Set up ${s.network === "x" ? "X" : s.network === "linkedin" ? "LinkedIn" : "Instagram"} in Settings`}>
                          Set up
                        </Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {checkYourself("Check yourself:", { withoutLinkedin: noteShowsLinkedin })}
          </div>
          {/* Kept at the right edge at every width, so the reason's tooltip opens inwards. */}
          <div className="-mr-2 ml-auto shrink-0">
            <Button size="sm" variant="ghost" onClick={() => void check("again")} disabledReason={blocked} tipEnd>
              {failed ? "Try again" : "Check again"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Panel title="Warm paths" id="warm-paths" className="scroll-mt-28 sm:scroll-mt-20" aside={checkedAside || undefined}>
      <div ref={body} tabIndex={-1} className="rounded outline-offset-4">
        {notice && paths.setup.any && !looking && (
          <div className="mb-4">
            <Notice tone={notice.tone}>{notice.text}</Notice>
          </div>
        )}
        {content}
      </div>
      <p role="status" className="sr-only">
        {said}
      </p>
    </Panel>
  );
}

/** "You're already connected to Ada." on the wash, with what to do next. Quiet text is a shade darker here (4.5:1). */
function DirectBox({
  lead,
  first,
  path,
  lines,
  hasAngles,
  onLink,
}: {
  lead: Lead;
  first: string;
  path: WarmPath;
  lines: { headline: string; evidence: string };
  hasAngles: boolean;
  onLink: (network: WarmSourceNetwork, kind: "lead") => void;
}) {
  const xOnly = pathNetwork(path) === "x";
  const xUrl = xProfileUrl(lead.xHandle);
  const linkedin = safeUrl(lead.linkedinUrl);
  return (
    <div className="rounded-lg bg-wash px-4 py-3.5">
      <p className="font-medium">{lines.headline}</p>
      <p className="mt-0.5 text-[13.5px] leading-relaxed text-[#6b6b65] wrap-anywhere">{lines.evidence}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {xOnly && xUrl ? (
          <>
            <span className="text-[13.5px]">No intro needed.</span>
            <ButtonLink external size="sm" href={xUrl} onClick={() => onLink("x", "lead")}>
              Open {first} on X ↗
            </ButtonLink>
          </>
        ) : hasAngles ? (
          <>
            <span className="text-[13.5px]">No intro needed: send the LinkedIn message from Angles.</span>
            <a href="#angles" className="btn btn-secondary btn-sm">
              Go to Angles
            </a>
          </>
        ) : (
          <>
            <span className="text-[13.5px]">No intro needed.</span>
            {linkedin && (
              <ButtonLink external size="sm" href={linkedin} onClick={() => onLink("linkedin", "lead")}>
                Open {first} on LinkedIn ↗
              </ButtonLink>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StrengthChip({ strength }: { strength: WarmStrength }) {
  return (
    <Chip tone={strength === "weak" ? "quiet" : "default"} className={cx("shrink-0", strength === "strong" && "font-medium")} title={STRENGTH_TOOLTIPS[strength]}>
      {STRENGTH_LABELS[strength]}
    </Chip>
  );
}

/** One way in: a row that opens into the chain, with the intro request for a two-hop path. */
function PathRow({
  lead,
  first,
  path,
  group,
  open,
  onToggle,
  drafting,
  onDrafting,
  onPath,
  onActivity,
  onLink,
  onSay,
}: {
  lead: Lead;
  first: string;
  path: WarmPath;
  /** "company": someone at the lead's company from your export, not a rated path. */
  group: "path" | "company";
  open: boolean;
  onToggle: (open: boolean) => void;
  /** The path whose draft is being written, if any: one at a time per lead. */
  drafting: string | null;
  onDrafting: (pathId: string | null) => void;
  onPath: (path: WarmPath) => void;
  onActivity: () => void;
  onLink: (network: WarmSourceNetwork, kind: "connector" | "lead") => void;
  /** Says what happened in the panel's status (screen readers): a busy button drops focus, and Saved or Copied is not announced. */
  onSay: (text: string) => void;
}) {
  const c = path.connector;
  const company = group === "company";
  const heading = c ? c.name : directOverlapLine(path, first);
  const role = connectorLine(c);
  const summaryLine = company ? (path.links[0]?.evidence[0] ? evidencePhrase(path.links[0].evidence[0], "company", first) : "") : c ? pathSummaryLine(path, first) : "";
  const asked = shortDate(path.askedAt);
  const connectorFirst = c ? firstNameOf(c.name) : "";

  // ---- the intro request
  const fieldId = useId();
  const serverText = path.introDraft?.message ?? "";
  const [text, setText] = useState(serverText);
  const [seen, setSeen] = useState(serverText);
  // A saved draft changed underneath (a save came back, a poll): follow it unless mid-edit.
  if (serverText !== seen) {
    setSeen(serverText);
    if (text === seen) setText(serverText);
  }
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRedraft, setConfirmRedraft] = useState(false);
  const [marking, setMarking] = useState(false);
  const [focusDraft, setFocusDraft] = useState(0);
  useEffect(() => {
    if (focusDraft === 0) return;
    // Only when focus was lost (the busy button) or is still in this row: never pull it out of another field.
    const active = document.activeElement;
    if (active && active !== document.body && !root.current?.contains(active)) return;
    const el = document.getElementById(fieldId);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  }, [focusDraft, fieldId]);

  // A busy button is disabled, which drops focus: give it back to the control that takes its place
  // (Mark as asked or Undo; Draft or Redraft) once the action settles.
  const root = useRef<HTMLDetailsElement>(null);
  const [refocus, setRefocus] = useState<{ what: "asked" | "draft"; n: number } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    const active = document.activeElement;
    if (!active || active === document.body || root.current?.contains(active)) root.current?.querySelector<HTMLElement>(`[data-focus="${refocus.what}"]`)?.focus();
  }, [refocus]);
  const giveFocus = (what: "asked" | "draft") => setRefocus((r) => ({ what, n: (r?.n ?? 0) + 1 }));

  const canDraft = path.hops === 2 && Boolean(c?.name.trim());
  const draftingThis = drafting === path.id;
  const draftBlocked = drafting && !draftingThis ? "Drafting another request." : null;

  async function draft() {
    if (drafting) return;
    onDrafting(path.id);
    setError(null);
    onSay(`Drafting a message to ${connectorFirst}.`);
    try {
      const next = await draftIntro(lead.id, path.id);
      const message = next.introDraft?.message ?? "";
      rememberDraft(lead.id, path.id, message);
      setText(message);
      setSeen(message);
      setSaveState("idle");
      onPath(next);
      track("warm_path_intro_drafted", { leadId: lead.id, rank: path.rank, ok: true });
      setFocusDraft((n) => n + 1);
      onSay("Draft ready.");
    } catch (err) {
      onSay("");
      setError(errorMessage(err));
      track("warm_path_intro_drafted", { leadId: lead.id, rank: path.rank, ok: false });
      giveFocus("draft");
    } finally {
      onDrafting(null);
      setConfirmRedraft(false);
    }
  }

  function redraft() {
    // Ask only before replacing text that was edited (or that this browser cannot vouch for).
    if (!isUneditedDraft(lead.id, path.id, text)) setConfirmRedraft(true);
    else void draft();
  }

  /** Saves the edited message. Resolves to the text that is saved now. */
  async function save(): Promise<string> {
    const next = text.trim();
    // An emptied message is not saved: the last saved one stays until there is text again.
    if (!next || next === serverText || saveState === "saving") return next || serverText;
    setSaveState("saving");
    setError(null);
    try {
      const saved = await saveIntro(lead.id, path.id, { introDraft: next });
      setSeen(saved.introDraft?.message ?? next);
      setText(saved.introDraft?.message ?? next);
      onPath(saved);
      setSaveState("saved");
      onSay("Saved.");
      return saved.introDraft?.message ?? next;
    } catch (err) {
      setSaveState("idle");
      setError(`The message was not saved: ${errorMessage(err)}`);
      return next;
    }
  }

  async function copy() {
    const message = text.trim() || serverText;
    const ok = await copyText(message);
    if (!ok) {
      setError("Could not copy. Select the text and copy it by hand.");
      return;
    }
    setError(null);
    setCopied(true);
    onSay("Copied.");
    setTimeout(() => setCopied(false), 1800);
    track("warm_path_intro_copied", { leadId: lead.id, rank: path.rank, length: message.length });
    // The copy itself already worked; logging it is best effort.
    logEvent(lead.id, "copied", `Copied the intro request to ${c?.name ?? "them"}`).then(onActivity, () => {});
  }

  async function markAsked(askedNow: boolean) {
    if (marking) return;
    setMarking(true);
    setError(null);
    try {
      onPath(await saveIntro(lead.id, path.id, { asked: askedNow }));
      onSay(askedNow ? "Marked as asked." : "Mark removed.");
      if (askedNow) track("warm_path_marked_asked", { leadId: lead.id, rank: path.rank });
      onActivity();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMarking(false);
      giveFocus("asked");
    }
  }

  // The connector's own page: the network that carries the strongest evidence on your link.
  const connectorLinkedin = safeUrl(c?.linkedinUrl);
  const connectorX = xProfileUrl(c?.xHandle);
  const yourBest = path.links[0]?.evidence[0]?.kind;
  const preferX = !company && (yourBest === "mutual_follow" || yourBest === "follows");
  const openConnector = c
    ? preferX && connectorX
      ? { network: "x" as const, href: connectorX, label: `Open ${connectorFirst} on X ↗` }
      : connectorLinkedin
        ? { network: "linkedin" as const, href: connectorLinkedin, label: `Open ${connectorFirst}'s LinkedIn ↗` }
        : connectorX
          ? { network: "x" as const, href: connectorX, label: `Open ${connectorFirst} on X ↗` }
          : null
    : null;

  const hint = saveState === "saving" ? "Saving…" : !text.trim() ? "Not saved while empty" : text.trim() !== serverText ? "Unsaved" : saveState === "saved" ? "Saved" : null;
  const words = countWords(text);

  return (
    <details ref={root} className="group" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className="flex min-h-[44px] list-none items-start gap-2.5 rounded py-3 [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 10 10" className="mt-[7px] h-2.5 w-2.5 shrink-0 text-quiet transition-transform group-open:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 1.5L7 5 3.5 8.5" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block wrap-anywhere sm:flex sm:flex-wrap sm:items-baseline sm:gap-x-2">
            <span className="block font-medium sm:inline">{heading}</span>
            {role && <span className="block text-[13.5px] text-quiet sm:inline">{role}</span>}
          </span>
          {(summaryLine || asked) && (
            <span className="mt-0.5 block text-[13px] leading-relaxed text-quiet wrap-anywhere">
              {summaryLine}
              {summaryLine && asked && " · "}
              {asked && <span className="text-ink">Asked {asked}</span>}
            </span>
          )}
        </span>
        {!company && path.strength && <StrengthChip strength={path.strength} />}
      </summary>

      <div className="pb-4 pl-5">
        <Chain lead={lead} first={first} path={path} company={company} onLink={onLink} />

        {(canDraft || openConnector) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {canDraft && !path.introDraft && (
              <Button data-focus="draft" onClick={() => void draft()} busy={draftingThis} disabledReason={draftBlocked}>
                Draft intro request
              </Button>
            )}
            {openConnector && (
              <ButtonLink external href={openConnector.href} onClick={() => onLink(openConnector.network, "connector")}>
                {openConnector.label}
              </ButtonLink>
            )}
          </div>
        )}

        {canDraft && path.introDraft && (
          <div className="mt-4">
            <Label htmlFor={fieldId} hint={<span>{hint ? `${hint} · ` : ""}{words} {words === 1 ? "word" : "words"}</span>}>
              Message to {connectorFirst}
            </Label>
            <AutoTextarea
              id={fieldId}
              className="field"
              rows={6}
              maxLength={INTRO_DRAFT_MAX}
              value={text}
              readOnly={draftingThis}
              onChange={(e) => {
                setText(e.target.value);
                setSaveState("idle");
              }}
              onBlur={() => void save()}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
              {path.askedAt ? (
                <span className="inline-flex items-center gap-1 pl-1 text-[13.5px]">
                  Asked {asked}
                  <Button data-focus="asked" size="sm" variant="ghost" className="text-quiet" onClick={() => void markAsked(false)} busy={marking} aria-label={`Undo marking ${connectorFirst} as asked`}>
                    Undo
                  </Button>
                </span>
              ) : (
                <Button data-focus="asked" onClick={() => void markAsked(true)} busy={marking}>
                  Mark as asked
                </Button>
              )}
              <Button data-focus="draft" variant="ghost" onClick={redraft} busy={draftingThis} disabledReason={draftBlocked}>
                Redraft
              </Button>
            </div>
            <p className="mt-2 text-[13px] text-quiet">Nothing is sent from here. Send it to {connectorFirst} yourself.</p>
          </div>
        )}

        {error && (
          <div className="mt-3">
            <Notice>{error}</Notice>
          </div>
        )}
      </div>

      <ConfirmDialog open={confirmRedraft} title="Replace your edits?" confirmLabel="Redraft" busy={draftingThis} onConfirm={() => void draft()} onCancel={() => setConfirmRedraft(false)}>
        Redrafting writes a new message to {connectorFirst}. The one you edited is replaced.
      </ConfirmDialog>
    </details>
  );
}

/**
 * The chain: You, the person in between, the lead. Dots in one column joined by a hairline, with
 * the evidence for each link beside the line. Hollow dots are you and the lead; the solid one is
 * the person who can introduce you. The same layout at every width.
 */
function Chain({ lead, first, path, company, onLink }: { lead: Lead; first: string; path: WarmPath; company: boolean; onLink: (network: WarmSourceNetwork, kind: "connector" | "lead") => void }) {
  const c = path.connector;
  const name = leadName(lead);
  const leadRole = titleAtCompany(lead);
  const connectorLinkedin = safeUrl(c?.linkedinUrl);
  const connectorX = xProfileUrl(c?.xHandle);
  const role = connectorLine(c);
  return (
    <ol aria-label={`Path from you to ${name}`} className="leading-[1.6]">
      <Node kind="end" position="first">
        <span className="font-medium">You</span>
      </Node>
      {path.hops === 1 || !c ? (
        <LinkRow link={path.links[0]} phrases={path.links[0] ? linkPhrases(path.links[0], "you", first) : []} />
      ) : (
        <>
          {company ? <LinkRow link={null} phrases={["One of your LinkedIn connections"]} /> : <LinkRow link={path.links[0]} phrases={path.links[0] ? linkPhrases(path.links[0], "you", first) : []} />}
          <Node kind="connector">
            <span className="font-medium">{c.name}</span>
            {role && <span className="text-quiet"> · {role}</span>}
            {connectorLinkedin && (
              <>
                <span className="text-quiet"> · </span>
                <a href={connectorLinkedin} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-link underline-offset-2 hover:underline" aria-label={`${c.name} on LinkedIn`} onClick={() => onLink("linkedin", "connector")}>
                  LinkedIn ↗
                </a>
              </>
            )}
            {connectorX && (
              <>
                <span className="text-quiet"> · </span>
                <a href={connectorX} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-link underline-offset-2 hover:underline" aria-label={`${c.name} on X`} onClick={() => onLink("x", "connector")}>
                  X ↗
                </a>
              </>
            )}
            {c.leadId && c.leadId !== lead.id && (
              <span className="block text-[13px] text-quiet">
                Also a lead:{" "}
                <Link href={`/leads/${c.leadId}`} className="text-link underline-offset-2 hover:underline" aria-label={`${c.name} is also a lead${c.leadStage ? `, ${STAGE_LABELS[c.leadStage]}` : ""}`}>
                  {c.leadStage ? STAGE_LABELS[c.leadStage] : "open"}
                </Link>
              </span>
            )}
          </Node>
          {company ? (
            <LinkRow link={null} phrases={path.links[0] ? linkPhrases(path.links[0], "company", first) : []} />
          ) : (
            <LinkRow link={path.links[1]} phrases={path.links[1] ? linkPhrases(path.links[1], "lead", first) : []} />
          )}
        </>
      )}
      <Node kind="end" position="last">
        <span className="font-medium">{name}</span>
        {leadRole && <span className="text-quiet"> · {leadRole}</span>}
      </Node>
    </ol>
  );
}

/** A person in the chain. The line runs through the dot's column, so wrapped text never breaks it. */
function Node({ kind, position, children }: { kind: "end" | "connector"; position?: "first" | "last"; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[9px_minmax(0,1fr)] gap-x-3">
      <span aria-hidden className="flex flex-col items-center">
        <span className={cx("h-[7px] w-px", position !== "first" && "bg-hairline")} />
        <span className={cx("h-[9px] w-[9px] shrink-0 rounded-full border-[1.5px] border-ink", kind === "connector" ? "bg-ink" : "bg-paper")} />
        <span className={cx("w-px flex-1", position !== "last" && "bg-hairline")} />
      </span>
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </li>
  );
}

/** A link of the chain: why it is real, and how strong it is as a word. */
function LinkRow({ link, phrases }: { link: WarmLink | null | undefined; phrases: string[] }) {
  return (
    <li className="grid grid-cols-[9px_minmax(0,1fr)] gap-x-3">
      <span aria-hidden className="flex justify-center">
        <span className="w-px bg-hairline" />
      </span>
      <span className="flex min-w-0 items-baseline justify-between gap-3 py-1.5 text-[13px] leading-relaxed text-quiet">
        <span className="min-w-0 wrap-anywhere">{phrases.length ? phrases.join(" · ") : "No evidence recorded"}</span>
        {link?.strength && (
          <span className="shrink-0" title={STRENGTH_TOOLTIPS[link.strength]}>
            <span className="sr-only">, strength: </span>
            {STRENGTH_LABELS[link.strength]}
          </span>
        )}
      </span>
    </li>
  );
}
