/**
 * The words of the warm-paths panel. Pure and client-safe: the server writes footer lines and
 * activity events with it, and the UI renders evidence with it, so both say the same thing.
 *
 * Evidence reads as "your link | the lead's link", e.g. "LinkedIn 1st degree" | "LinkedIn 1st
 * degree with Ada". Years are the overlap's, joined by an en dash ("2019–2022"); a single year
 * reads "in 2021"; one still going reads "now". Short plain sentences, no jargon.
 */

import type { Evidence, WarmConnector, WarmLink, WarmPath, WarmPathSource, WarmPaths, WarmSourceNetwork, WarmStrength } from "./types";
import { companyWords } from "./overlap";
import { isConfirmedDirect, isConfirmedTie, pathNetwork } from "./score";

export const STRENGTH_LABELS: Record<WarmStrength, string> = { strong: "Strong", medium: "Medium", weak: "Weak" };

export const STRENGTH_TOOLTIPS: Record<WarmStrength, string> = {
  strong: "Solid evidence on both links: worked together, or two signals each.",
  medium: "One clear signal on each link, such as LinkedIn 1st degree or a mutual follow.",
  weak: "Thin evidence on a link, such as a one-way follow or the same school.",
};

export const SOURCE_LABELS: Record<WarmSourceNetwork, string> = { linkedin: "LinkedIn", x: "X", instagram: "Instagram" };

const count = (n: number) => n.toLocaleString("en-US");

/** "Ada" from "Ada Kim" (titles such as "Dr" dropped); "them" when there is no name. */
export function firstNameOf(name: string | null | undefined): string {
  const words = (name ?? "")
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean)
    .filter((w) => !/^(dr|prof|mr|mrs|ms|mx)\.?$/i.test(w));
  return words[0] ?? "them";
}

/** "2019–2022", "in 2021" (one year), "now" (still going), "" (unknown). */
export function yearsText(fromYear: number | null, toYear: number | null): string {
  if (fromYear === null && toYear === null) return "";
  if (toYear === null) return "now";
  if (fromYear === null || fromYear === toYear) return `in ${toYear}`;
  return `${fromYear}–${toYear}`;
}

/** "Nov 2" this year, "Nov 2, 2025" another year (UTC); "" for a missing or bad date. */
export function shortDate(iso: string | null | undefined, now: Date = new Date()): string {
  const t = iso ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** The year of a "since" date ("2019-03-14" -> "2019"), or "". */
function sinceYear(since: string | null): string {
  const m = /^(\d{4})/.exec(since ?? "");
  return m ? m[1] : "";
}

/** Where a phrase is shown: your link (also the one link of a direct path), the lead's link, or a company person's row. */
export type EvidenceSide = "you" | "lead" | "company";

/**
 * One piece of evidence as a phrase. `lead` is the lead's first name ("Ada").
 * your link: "LinkedIn 1st degree since 2019", "Worked together at Northwind, 2019–2022", "Work
 * together at Nimbus now", "Same school: Stanford, 2014–2016", "Mutual follow on X", "Follows you
 * on X", "You follow them on X".
 * the lead's link: "LinkedIn 1st degree with Ada", "Worked with Ada at Northwind, 2019–2022",
 * "Works with Ada at Acme Robotics now", "Same school as Ada: MIT, 2012–2016", "Mutual follow with
 * Ada on X", "Ada follows them on X", "Follows Ada on X".
 * a company person: "Works at Acme Robotics (your export, Nov 2)".
 */
export function evidencePhrase(e: Evidence, side: EvidenceSide, lead: string, now: Date = new Date()): string {
  switch (e.kind) {
    case "linkedin_1st": {
      if (side === "lead") return `LinkedIn 1st degree with ${lead}`;
      const year = sinceYear(e.since);
      return year ? `LinkedIn 1st degree since ${year}` : "LinkedIn 1st degree";
    }
    case "worked_together": {
      if (e.toYear === null) return side === "lead" ? `Works with ${lead} at ${e.org} now` : `Work together at ${e.org} now`;
      const years = yearsText(e.fromYear, e.toYear);
      return side === "lead" ? `Worked with ${lead} at ${e.org}, ${years}` : `Worked together at ${e.org}, ${years}`;
    }
    case "works_at": {
      if (side === "company") {
        const when = shortDate(e.asOf, now);
        // A company the lead has left: say so, or nothing explains why this person leads to them.
        const left = typeof e.leadLeftYear === "number" ? `, where ${lead} worked until ${e.leadLeftYear}` : "";
        return when ? `Works at ${e.org}${left} (your export, ${when})` : `Works at ${e.org}${left}`;
      }
      return side === "lead" ? `Works with ${lead} at ${e.org} now` : `Work together at ${e.org} now`;
    }
    case "same_school": {
      const years = yearsText(e.fromYear, e.toYear);
      const tail = years ? `, ${years}` : "";
      return side === "lead" ? `Same school as ${lead}: ${e.org}${tail}` : `Same school: ${e.org}${tail}`;
    }
    case "mutual_follow":
      return side === "lead" ? `Mutual follow with ${lead} on X` : "Mutual follow on X";
    case "follows":
      switch (e.who) {
        case "connector_follows_you":
          return "Follows you on X";
        case "you_follow_connector":
          return "You follow them on X";
        case "lead_follows_connector":
          return `${lead} follows them on X`;
        case "connector_follows_lead":
          return `Follows ${lead} on X`;
      }
  }
}

/** Every piece of evidence of a link, as phrases, best first. */
export function linkPhrases(link: WarmLink, side: EvidenceSide, lead: string, now: Date = new Date()): string[] {
  return link.evidence.map((e) => evidencePhrase(e, side, lead, now));
}

/** All evidence of a link joined by " · ": "LinkedIn 1st degree since 2019 · Mutual follow on X". */
export function linkLine(link: WarmLink, side: EvidenceSide, lead: string, now: Date = new Date()): string {
  return linkPhrases(link, side, lead, now).join(" · ");
}

/**
 * The evidence a collapsed row shows for a link: the best, except that "LinkedIn 1st degree" gives
 * way to a shared employer that ties with it ("Works with Ada at Acme Robotics now"), which says
 * how the two know each other. The chain inside the row keeps every piece, in order.
 */
function summaryEvidence(link: WarmLink): Evidence | undefined {
  const best = link.evidence[0];
  if (best?.kind !== "linkedin_1st") return best;
  return link.evidence.find((e) => e.kind === "worked_together" || e.kind === "works_at") ?? best;
}

/** A path row's second line: the best evidence of each link (summaryEvidence), joined by " · ". */
export function pathSummaryLine(path: Pick<WarmPath, "hops" | "links">, lead: string, now: Date = new Date()): string {
  const sides: EvidenceSide[] = path.hops === 1 ? ["you"] : ["you", "lead"];
  return path.links
    .slice(0, sides.length)
    .map((l, i) => {
      const e = summaryEvidence(l);
      return e ? evidencePhrase(e, sides[i], lead, now) : "";
    })
    .filter(Boolean)
    .join(" · ");
}

/** "Head of Operations at Nimbus", "Head of Operations", "Nimbus", or "". A headline is kept as it is. */
export function connectorLine(c: Pick<WarmConnector, "title" | "company"> | null): string {
  if (!c) return "";
  const title = c.title?.trim() ?? "";
  const company = c.company?.trim() ?? "";
  if (title && company && !title.toLowerCase().includes(company.toLowerCase())) return `${title} at ${company}`;
  return title || company;
}

/** The direct box: "You're already connected to Ada." and its evidence line. Null when the direct path has no confirmed tie. */
export function directBoxLines(path: Pick<WarmPath, "hops" | "links">, lead: string, now: Date = new Date()): { headline: string; evidence: string } | null {
  if (!isConfirmedDirect(path)) return null;
  return { headline: `You're already connected to ${lead}.`, evidence: linkLine(path.links[0], "you", lead, now) };
}

/**
 * The first row's title for a direct path without a confirmed tie (a shared employer or school):
 * "You and Ada both worked at Northwind, 2019–2022", "You and Ada both work at Nimbus now",
 * "You and Ada went to the same school: MIT, 2012–2016".
 */
export function directOverlapLine(path: Pick<WarmPath, "hops" | "links">, lead: string): string {
  const e = path.links[0]?.evidence[0];
  if (!e) return "";
  if (e.kind === "worked_together") {
    return e.toYear === null ? `You and ${lead} both work at ${e.org} now` : `You and ${lead} both worked at ${e.org}, ${yearsText(e.fromYear, e.toYear)}`;
  }
  if (e.kind === "works_at") return `You and ${lead} both work at ${e.org} now`;
  if (e.kind === "same_school") {
    const years = yearsText(e.fromYear, e.toYear);
    return `You and ${lead} went to the same school: ${e.org}${years ? `, ${years}` : ""}`;
  }
  if (e.kind === "follows" && e.who === "connector_follows_you") return `${lead} follows you on X`;
  return evidencePhrase(e, "you", lead);
}

/** The list chip's tooltip: "Medium path via Priya Shah", "LinkedIn 1st degree", "Worked together at Northwind, 2019–2022". */
export function summaryLabel(path: Pick<WarmPath, "hops" | "links" | "strength" | "connector">, lead: string): string {
  if (path.hops === 2) return `${STRENGTH_LABELS[path.strength ?? "weak"]} path via ${path.connector?.name ?? "someone you know"}`;
  const evidence = path.links[0]?.evidence ?? [];
  // A direct tie names the tie ("LinkedIn 1st degree"), else the best overlap.
  const tie = evidence.find(isConfirmedTie);
  const first = tie ?? evidence[0];
  return first ? evidencePhrase(first, "you", lead) : "Connected";
}

/** Which network a path comes from, as a word for the activity log: "LinkedIn", "X", "LinkedIn and X". */
export function networkWord(path: Pick<WarmPath, "links">): string {
  const n = pathNetwork(path);
  return n === "mixed" ? "LinkedIn and X" : n === "x" ? "X" : "LinkedIn";
}

/** "LinkedIn: matched your 1,240 connections (export of Nov 2)." */
export function sourceLine(s: Pick<WarmPathSource, "network" | "detail">): string {
  return `${SOURCE_LABELS[s.network]}: ${s.detail}`;
}

// ------------------------------------------------------------------ what was compared (the panel and Activity)

const ran = (s: Pick<WarmPathSource, "state">) => s.state === "checked" || s.state === "cached";
const connectionsWord = (n: number) => (n === 1 ? "connection" : "connections");
/** "a", "a and b", "a, b and c". */
const listOf = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/**
 * True when a source that looks for people you both know really ran for this lead, now or on an
 * earlier check that still counts: LinkedIn on your own account (the lead's degree, and for a
 * 2nd-degree lead the shared connections, confirmed) or X (the lead's follows against your lists).
 * Until one has, the panel never says or implies that nobody links you to the lead.
 */
export function mutualsChecked(paths: Pick<WarmPaths, "sources">): boolean {
  return paths.sources.some((s) => ran(s) && s.mutuals === true);
}

/** True when at least one source was really checked, or its earlier result used: only then does the panel say "Updated 2h ago". */
export function anythingChecked(paths: Pick<WarmPaths, "sources">): boolean {
  return paths.sources.some((s) => s.network !== "instagram" && ran(s));
}

/**
 * Exactly what was checked, when nobody was found and a source of mutual connections ran: "Checked
 * your 1,240 LinkedIn connections, your work and school history and the 380 accounts you follow on
 * X." Empty when nothing was checked.
 */
export function checkedSummary(paths: Pick<WarmPaths, "sources">): string {
  const parts: string[] = [];
  for (const s of paths.sources) {
    if (!ran(s)) continue;
    if (s.network === "linkedin") {
      if (typeof s.counts.connections === "number") parts.push(`your ${count(s.counts.connections)} LinkedIn ${connectionsWord(s.counts.connections)}`);
      if (s.history === "compared") parts.push("your work and school history");
      if (s.mutuals) {
        const shared = s.counts.shared ?? 0;
        parts.push(shared > 0 ? `the ${count(shared)} ${connectionsWord(shared)} LinkedIn says you share` : "the connections you share on LinkedIn");
      }
    }
    if (s.network === "x" && s.mutuals && typeof s.counts.following === "number") {
      parts.push(`the ${count(s.counts.following)} ${s.counts.following === 1 ? "account" : "accounts"} you follow on X`);
    }
  }
  return parts.length ? `Checked ${listOf(parts)}.` : "";
}

/** The link to LinkedIn's own list of the people you share with the lead (it opens in your browser). */
export const SEE_MUTUALS_ON_LINKEDIN = "See mutual connections on LinkedIn";

/**
 * When no source of people you both know ran: the quiet sentence that says so, for the place
 * where they would be listed. The panel adds LinkedIn's own mutual-connections link after it
 * (SEE_MUTUALS_ON_LINKEDIN). "" when one ran.
 */
export function mutualsNotChecked(paths: Pick<WarmPaths, "sources" | "setup" | "leadFirstName">): string {
  if (mutualsChecked(paths)) return "";
  return paths.setup.x || paths.setup.linkedinAccount ? `Mutual connections were not checked for ${paths.leadFirstName || "them"}.` : "Mutual connections are not checked here.";
}

/**
 * Where to turn on the sources of people you both know that are not set up: "To check them here,
 * set up X or your LinkedIn account in Settings." ("Settings" is the link). "" when both are.
 */
export function mutualsSetUp(paths: Pick<WarmPaths, "setup">): string {
  const missing = [paths.setup.x ? null : "X", paths.setup.linkedinAccount ? null : "your LinkedIn account"].filter((m): m is string => m !== null);
  return missing.length ? `To check them here, set up ${missing.join(" or ")} in Settings.` : "";
}

/** What would add the comparison of employers and schools, by why it was not made. */
function historyHint(history: WarmPathSource["history"], researched: boolean): string {
  switch (history) {
    case "no_profile":
      return "Add your LinkedIn profile in Settings to compare employers and schools.";
    case "own_unread":
      return "Read your LinkedIn profile in Settings to compare employers and schools.";
    case "lead_unread":
      return `${researched ? "Re-run" : "Run"} research to compare employers and schools.`;
    default:
      return "";
  }
}

/** The panel when no path was found: a title in medium weight, then quiet lines. "Settings" in a line is a link. */
export interface NoPathsCopy {
  title: string;
  /** What was compared, or what would add more. "" when there is nothing to say. */
  detail: string;
  /** Mutual connections were not checked, or could not be listed: the panel adds LinkedIn's own link after it. "" when they were checked. */
  mutuals: string;
  /** Where to set up what would check them here. "" when there is nothing to set up. */
  setUp: string;
}

/**
 * The words when no path was found, built only from what really ran:
 * - a source of mutual connections ran: "No one you know is linked to Ada yet." and exactly what
 *   was checked;
 * - LinkedIn says you share people but they could not be listed: it says so;
 * - otherwise: "No direct link to Ada yet.", what was compared ("Ada is not one of your 6,208
 *   LinkedIn connections, and you share no employer or school."), that mutual connections are not
 *   checked here, and where to set up what would check them.
 * `researched`: research has run on the lead ("Run research" before the first run).
 */
export function noPathsCopy(paths: Pick<WarmPaths, "sources" | "setup" | "leadFirstName" | "linkedinShared"> & Partial<Pick<WarmPaths, "companyPaths">>, opts: { researched?: boolean } = {}): NoPathsCopy {
  const first = paths.leadFirstName || "them";
  const unlisted = paths.linkedinShared && paths.linkedinShared.count > 0 && paths.linkedinShared.shown === 0 ? paths.linkedinShared.count : 0;
  if (unlisted) {
    return {
      title: `LinkedIn says you share ${count(unlisted)} ${connectionsWord(unlisted)} with ${first}.`,
      detail: "",
      mutuals: `${unlisted === 1 ? "It" : "They"} could not be listed here.`,
      setUp: "",
    };
  }
  if (mutualsChecked(paths)) {
    // People at their company are listed right below: never "no one you know" above them.
    const title = paths.companyPaths?.length ? `No mutual connections found for ${first} yet.` : `No one you know is linked to ${first} yet.`;
    return { title, detail: checkedSummary(paths), mutuals: "", setUp: "" };
  }

  const li = paths.sources.find((s) => s.network === "linkedin");
  const liRan = Boolean(li && ran(li));
  const connections = liRan && typeof li?.counts.connections === "number" ? li.counts.connections : null;
  const compared = liRan && li?.history === "compared";
  const notConnected = connections !== null ? `${first} is not one of your ${count(connections)} LinkedIn ${connectionsWord(connections)}` : "";
  const found = notConnected && compared ? `${notConnected}, and you share no employer or school.` : notConnected ? `${notConnected}.` : compared ? `You and ${first} share no employer or school.` : "";
  const hint = compared ? "" : historyHint(li?.history, opts.researched !== false);
  return {
    // The LinkedIn line ran: your connections, your work history or your account's degree was compared.
    title: liRan ? `No direct link to ${first} yet.` : `Nothing could be compared for ${first} yet.`,
    detail: [found, hint].filter(Boolean).join(" "),
    mutuals: mutualsNotChecked(paths),
    setUp: mutualsSetUp(paths),
  };
}

/** The not-set-up state: "See who can introduce you to Ada. Add your LinkedIn connections or your X handle in Settings, and research will look for links to Ada." */
export function notSetUpText(paths: Pick<WarmPaths, "setup" | "leadFirstName">): string {
  const first = paths.leadFirstName || "them";
  // An X handle only helps when X checks are on for this server (TWITTERAPI_IO_KEY).
  const what = paths.setup.xAvailable ? "Add your LinkedIn connections or your X handle in Settings" : "Upload your LinkedIn connections or add your profile link in Settings";
  return `See who can introduce you to ${first}. ${what}, and research will look for links to ${first}.`;
}

/** The looking state's title: "Looking for people you both know" only when a source of them can run for this lead. */
export function lookingTitle(paths: Pick<WarmPaths, "leadFirstName">, opts: { mutuals: boolean }): string {
  return opts.mutuals ? "Looking for people you both know" : `Looking for links to ${paths.leadFirstName || "them"}`;
}

/**
 * "You know 2 people at Acme Robotics." for the company people list, "You know 40 people at Fathom
 * Robotics (5 shown)." when more than the 5 listed work there; "" when there are none.
 */
export function companyPeopleIntro(paths: Pick<WarmPaths, "companyPaths"> & Partial<Pick<WarmPaths, "sources">>): string {
  const people = paths.companyPaths;
  if (!people.length) return "";
  // One name per company: "Acme Robotics" and "ACME Robotics Inc." are one.
  const orgs = new Map<string, string>();
  for (const p of people) {
    const e = p.links[0]?.evidence[0];
    if (e?.kind === "works_at" && !orgs.has(companyWords(e.org).join(""))) orgs.set(companyWords(e.org).join(""), e.org);
  }
  // "Pallet & Pine, Inc." ends the sentence with its own full stop.
  const where = orgs.size === 1 ? [...orgs.values()][0].replace(/\.$/, "") : "their companies";
  const total = Math.max(people.length, paths.sources?.find((s) => s.network === "linkedin")?.counts.atCompanies ?? 0);
  const shown = total > people.length ? ` (${people.length} shown)` : "";
  return `You know ${total === 1 ? "1 person" : `${count(total)} people`} at ${where}${shown}. They could introduce you, or point you to the right person.`;
}

// ------------------------------------------------------------------ footer details (server writes them)

/** "matched your 1,240 connections (export of Nov 2)." */
export function linkedinCsvDetail(connections: number, exportedAt: string | null, now: Date = new Date()): string {
  const when = shortDate(exportedAt, now);
  return `matched your ${count(connections)} ${connections === 1 ? "connection" : "connections"}${when ? ` (export of ${when})` : ""}.`;
}

const DEGREE_WORDS: Record<string, string> = {
  FIRST_DEGREE: "1st degree",
  SECOND_DEGREE: "2nd degree",
  THIRD_DEGREE: "3rd degree",
  OUT_OF_NETWORK: "outside your network",
};

/** "2nd degree, checked on your account Nov 25." */
export function linkedinLiveDetail(distance: string | null, checkedAt: string | null, now: Date = new Date()): string {
  const words = (distance && DEGREE_WORDS[distance]) || "degree unknown";
  const when = shortDate(checkedAt, now);
  return `${words}, checked on your account${when ? ` ${when}` : ""}.`;
}

/** "checked @jane (380 follows) against @ada (900 follows), $0.01." */
export function xCheckedDetail(input: { ownHandle: string; ownFollowing: number; leadHandle: string; leadFollowing: number; costUsd: number | null }): string {
  const cost = input.costUsd === null ? "" : `, ${usd(input.costUsd)}`;
  return `checked @${input.ownHandle} (${count(input.ownFollowing)} ${input.ownFollowing === 1 ? "follow" : "follows"}) against @${input.leadHandle} (${count(input.leadFollowing)} ${input.leadFollowing === 1 ? "follow" : "follows"})${cost}.`;
}

/** A daily budget in dollars: "$1", "$2.50". */
export function dollars(value: number): string {
  return Number.isInteger(value) ? `$${value.toLocaleString("en-US")}` : usd(value);
}

/** "$0.01", "<$0.01", "$1.20". */
export function usd(value: number): string {
  if (!(value > 0)) return "$0";
  if (value < 0.01) return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ------------------------------------------------------------------ the activity log

/** A direct path that is not a confirmed tie, in plain words: "a shared employer", "a shared school", "an X follow". */
function directLinkWords(path: Pick<WarmPath, "links">): string {
  switch (path.links[0]?.evidence[0]?.kind) {
    case "worked_together":
    case "works_at":
      return "a shared employer";
    case "same_school":
      return "a shared school";
    case "follows":
    case "mutual_follow":
      return "an X follow";
    default:
      return "a direct link";
  }
}

/**
 * The one 'tool' event a check logs. It never names the person: the activity log outlives a removed
 * upload, and the panel shows who it is. Like the panel, it says that nobody was found only when a
 * source of mutual connections ran.
 * "Warm paths: best via someone you know (Medium, LinkedIn)", "Warm paths: you're connected (LinkedIn)",
 * "Warm paths: best is a shared employer (Medium, LinkedIn; mutual connections not checked)",
 * "Warm paths: none found (checked 1,240 LinkedIn connections, 380 X follows)",
 * "Warm paths: no direct link (checked 6,208 LinkedIn connections; mutual connections not checked)",
 * "Warm paths skipped: nothing set up", "Warm paths: could not check; X failed: did not answer (...)".
 * Failures and skipped sources are added after a semicolon.
 */
export function warmPathsEventMessage(input: {
  outcome: "found" | "none" | "not_set_up" | "failed";
  best: Pick<WarmPath, "hops" | "links" | "strength" | "connector"> | null;
  sources: ReadonlyArray<Pick<WarmPathSource, "network" | "state" | "detail" | "counts" | "mutuals" | "history">>;
}): string {
  if (input.outcome === "not_set_up") return "Warm paths skipped: nothing set up";
  const notes = input.sources
    .filter((s) => s.state === "failed" || (s.state === "skipped" && s.network !== "instagram"))
    .map((s) => `${SOURCE_LABELS[s.network]} ${s.state === "failed" ? "failed" : "skipped"}: ${s.detail.replace(/\.$/, "")}`);
  const tail = notes.length ? `; ${notes.join("; ")}` : "";
  if (input.outcome === "failed") return `Warm paths: could not check${tail}`;
  const mutualsRan = input.sources.some((s) => ran(s) && s.mutuals === true);
  if (input.outcome === "found" && input.best) {
    const b = input.best;
    if (b.hops === 1 && isConfirmedDirect(b)) return `Warm paths: you're connected (${networkWord(b)})${tail}`;
    const strength = STRENGTH_LABELS[b.strength ?? "weak"];
    if (b.hops === 1) return `Warm paths: best is ${directLinkWords(b)} (${strength}, ${networkWord(b)}${mutualsRan ? "" : "; mutual connections not checked"})${tail}`;
    return `Warm paths: best via someone you know (${strength}, ${networkWord(b)})${tail}`;
  }
  const li = input.sources.find((s) => s.network === "linkedin" && ran(s));
  // People at their company (counted, never named), listed on the panel.
  const atCompanies = li?.counts.atCompanies ?? 0;
  const company = atCompanies ? `; ${count(atCompanies)} ${atCompanies === 1 ? "person" : "people"} you know at their company` : "";
  if (mutualsRan) {
    const checked: string[] = [];
    for (const s of input.sources) {
      if (!ran(s)) continue;
      if (s.network === "linkedin" && typeof s.counts.connections === "number") checked.push(`${count(s.counts.connections)} LinkedIn connections`);
      if (s.network === "linkedin" && s.mutuals && typeof s.counts.shared === "number") checked.push(`${count(s.counts.shared)} shared LinkedIn connections`);
      if (s.network === "x" && s.mutuals && typeof s.counts.following === "number") checked.push(`${count(s.counts.following)} X follows`);
    }
    return `Warm paths: ${company ? "no mutual connections found" : "none found"}${checked.length ? ` (checked ${checked.join(", ")})` : ""}${company}${tail}`;
  }
  // No source of mutual connections ran: what was compared, and that mutual connections were not.
  const compared: string[] = [];
  if (li && typeof li.counts.connections === "number") compared.push(`${count(li.counts.connections)} LinkedIn connections`);
  if (li?.history === "compared") compared.push("employers and schools");
  const what = compared.length ? `checked ${compared.join(", ")}; ` : "";
  const unlisted = li && typeof li.counts.shared === "number" && li.counts.shared > 0 ? li.counts.shared : 0;
  if (unlisted) return `Warm paths: ${count(unlisted)} shared LinkedIn ${connectionsWord(unlisted)}, not confirmed (${what}open them on LinkedIn)${tail}`;
  return `Warm paths: ${compared.length || li ? "no direct link" : "nothing compared yet"} (${what}mutual connections not checked)${company}${tail}`;
}
