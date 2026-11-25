/**
 * Work and school overlaps between the owner's profile and the lead's. Pure and client-safe.
 *
 * Dates come as LinkedIn gives them (normaliseLinkedInDate): "YYYY-MM", "YYYY", or null for an
 * open-ended role. A year alone starts in January and ends in December. Months are counted
 * inclusively, so Jan 2020 to Dec 2020 is 12 months.
 */

import { normaliseName } from "../research/util";
import { POINTS, type ScoredEvidence } from "./score";
import type { Evidence, TargetRole, TargetSchool } from "./types";

/** A role on either side (the owner's roles from Settings, the lead's from the target). */
export type RoleLike = Pick<TargetRole, "company" | "from" | "to"> & {
  companyKey?: string | null;
  companyLinkedinUrl?: string | null;
  current?: boolean;
};

export type SchoolLike = Pick<TargetSchool, "school" | "from" | "to"> & { schoolId?: string | null };

/** Months since year 0 (year * 12 + month - 1), or null. A year alone is January at the start, December at the end. */
export function monthIndex(value: string | null | undefined, edge: "start" | "end"): number | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec((value ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1900 || year > 2100) return null;
  const month = m[2] ? Number(m[2]) : edge === "start" ? 1 : 12;
  if (month < 1 || month > 12) return null;
  return year * 12 + month - 1;
}

const yearOfIndex = (i: number) => Math.floor(i / 12);

export function nowIndex(now: Date): number {
  return now.getUTCFullYear() * 12 + now.getUTCMonth();
}

/** The year of a "YYYY" or "YYYY-MM" value, or null. */
export function yearOf(value: string | null | undefined): number | null {
  const m = /^(\d{4})/.exec((value ?? "").trim());
  const y = m ? Number(m[1]) : NaN;
  return y >= 1900 && y <= 2100 ? y : null;
}

/** Canonical form of a LinkedIn company page URL, and whether its id is numeric. Null when it is not one. */
function companyPage(url: string | null | undefined): { key: string; numeric: boolean } | null {
  const m = /linkedin\.com\/(?:company|school|showcase)\/([^/?#\s]+)/i.exec(url ?? "");
  if (!m) return null;
  let id = m[1];
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep as is
  }
  id = id.toLowerCase();
  return { key: id, numeric: /^\d+$/.test(id) };
}

/**
 * True when two roles are at the same company: the same LinkedIn company page, else names that
 * sameCompanyWords matches (whole words, so "Meta" is not "Metaview"). Two pages of the same kind
 * (both numeric ids, or both vanity names) that differ are different companies, whatever the names
 * say ("Apple" is not "Apple Leisure"). A placeholder such as "Self-employed" or "Stealth Startup"
 * is nobody's shared employer, whatever its page.
 */
export function sameEmployer(a: Pick<RoleLike, "company" | "companyLinkedinUrl">, b: Pick<RoleLike, "company" | "companyLinkedinUrl">): boolean {
  if (isPlaceholderEmployer(a.company) || isPlaceholderEmployer(b.company)) return false;
  const pa = companyPage(a.companyLinkedinUrl);
  const pb = companyPage(b.companyLinkedinUrl);
  if (pa && pb) {
    if (pa.key === pb.key) return true;
    if (pa.numeric === pb.numeric) return false;
  }
  return sameCompanyWords(a.company, b.company);
}

/** Employer names that say nothing about where someone works, as companyWords reads them. */
const PLACEHOLDER_EMPLOYERS = new Set([
  "self", "selfemployed", "selfemployment", "myself", "me", "own", "ownbusiness", "personal", "private", "privatepractice",
  "freelance", "freelancer", "freelancing", "freelanceconsultant", "freelancewriter", "freelancedesigner",
  "independent", "independentconsultant", "independentcontractor", "independentadvisor", "independentprofessional",
  "consultant", "consulting", "contractor", "contract", "advisor", "adviser",
  "confidential", "undisclosed", "anonymous", "various", "multiple", "variouscompanies", "variousclients", "multiplecompanies",
  "sabbatical", "careerbreak", "break", "retired", "unemployed", "student", "none", "na", "nil", "tbd", "tba", "unknown", "notapplicable",
  "opentowork", "seekingopportunities", "lookingforopportunities", "lookingfornewopportunities", "jobseeker",
  "family", "familybusiness", "parentalleave", "homemaker", "volunteer", "volunteering",
]);

/**
 * True for an employer name that names no company: "Self-employed", "Freelance", "Independent
 * Consultant", "Stealth Startup", "Confidential", "Various". Two people who both list one did not
 * work together, and nobody else "works at" it.
 */
export function isPlaceholderEmployer(value: string | null | undefined): boolean {
  const words = companyWords(value);
  if (!words.length) return true;
  if (words[0] === "stealth" || words[0] === "stealthmode") return true;
  return PLACEHOLDER_EMPLOYERS.has(words.join(""));
}

/**
 * A company name's words, as normaliseName reads them but with the word breaks kept: lower case,
 * accents and legal suffixes (Inc, LLC, GmbH...) dropped. "Acme Robotics, Inc." -> ["acme", "robotics"].
 */
export function companyWords(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|company|corporation|limited|plc|sas|bv|ab)\b\.?/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when two company names name the same company by their words: the same key (normaliseName),
 * or the shorter name, at least 4 letters, ends where one of the longer name's words ends ("Acme"
 * and "Acme Robotics", "J.P. Morgan" and "JPMorgan Chase"). Never part of a word: "Heli" is not
 * "Helix Motion", "Meta" is not "Metaview", and "AcmeCorp" is not "Acme". Placeholders such as
 * "Self-employed" match nothing (isPlaceholderEmployer). Used wherever warm paths compare employers
 * by name, where a looser match would invent a shared employer.
 */
export function sameCompanyWords(a: string | null | undefined, b: string | null | undefined): boolean {
  const wa = companyWords(a);
  const wb = companyWords(b);
  if (!wa.length || !wb.length || isPlaceholderEmployer(a) || isPlaceholderEmployer(b)) return false;
  const ka = wa.join("");
  const kb = wb.join("");
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, wb] : [kb, wa];
  if (short.length < 4) return false;
  let acc = "";
  for (const w of long) {
    acc += w;
    if (acc === short) return true;
    if (acc.length >= short.length) return false;
  }
  return false;
}

/** True when the company's words appear, in order and as whole words, in a text such as an X bio. */
export function mentionsCompany(text: string | null | undefined, company: string | null | undefined): boolean {
  const words = companyWords(company);
  if (!words.length || words.join("").length < 4 || isPlaceholderEmployer(company)) return false;
  // Whole words on both ends, joined or not: "Open AI" names OpenAI, "open air" does not.
  const target = words.join("");
  const hay = companyWords(text);
  for (let i = 0; i < hay.length; i++) {
    let acc = "";
    for (let j = i; j < hay.length && acc.length < target.length; j++) {
      acc += hay[j];
      if (acc === target) return true;
    }
  }
  return false;
}

/**
 * The keys a stored company (le_network_contacts.company_key, normaliseName) has when it is one
 * of these names or their first whole words of 4 letters or more: "Acme Robotics Labs" ->
 * acmeroboticslabs, acme, acmerobotics. The SQL prefilter for people at the lead's companies.
 */
export function companyKeyPrefixes(name: string | null | undefined): string[] {
  const words = companyWords(name);
  const out: string[] = [];
  for (let i = 1; i <= words.length; i++) {
    const key = words.slice(0, i).join("");
    if (i === words.length || key.length >= 4) out.push(key);
  }
  return out;
}

/** Same school: the same LinkedIn school id when both are known, else names that match by whole words (sameCompanyWords). */
export function sameSchool(a: SchoolLike, b: SchoolLike): boolean {
  if (a.schoolId && b.schoolId) return a.schoolId === b.schoolId;
  return sameCompanyWords(a.school, b.school);
}

/** A role still going: flagged current, else open-ended (no end date). */
export const isCurrentRole = (r: RoleLike): boolean => r.current ?? r.to == null;

export interface OverlapOptions {
  now: Date;
  /** Employees of a company, when known, by normaliseName(company) (the lead's current company page). */
  companySize?: (companyKey: string) => number | null;
}

/**
 * The overlap of two roles at the same employer, as evidence:
 * - both dated: worked_together with the overlap's years (toYear null while both still work
 *   there). 5 points when the overlap is at least 12 months, ended within the last 8 years (or
 *   goes on), and the company is known to have at most 1,000 employees; else 3.
 * - a start date unknown, both current: works_at (both work there now), 3 points.
 * Null when they are not at the same employer, or their dates do not overlap.
 */
export function roleOverlap(mine: RoleLike, theirs: RoleLike, opts: OverlapOptions): ScoredEvidence | null {
  if (!sameEmployer(mine, theirs)) return null;
  const org = theirs.company.trim() || mine.company.trim();
  const now = nowIndex(opts.now);
  const aStart = monthIndex(mine.from, "start");
  const bStart = monthIndex(theirs.from, "start");
  if (aStart === null || bStart === null) {
    // Start dates unknown: only "both work there now" can be said.
    return isCurrentRole(mine) && isCurrentRole(theirs) ? { evidence: { kind: "works_at", org, asOf: null }, points: POINTS.worksAt } : null;
  }
  const aOngoing = mine.to == null;
  const bOngoing = theirs.to == null;
  const aEnd = aOngoing ? now : monthIndex(mine.to, "end");
  const bEnd = bOngoing ? now : monthIndex(theirs.to, "end");
  if (aEnd === null || bEnd === null) return null;
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  if (start > end) return null;
  const months = end - start + 1;
  const ongoing = aOngoing && bOngoing;
  const recent = ongoing || end >= now - 8 * 12;
  const key = normaliseName(theirs.company);
  const size = opts.companySize ? opts.companySize(key) : null;
  const small = typeof size === "number" && size > 0 && size <= 1000;
  const points = months >= 12 && recent && small ? POINTS.workedTogetherStrong : POINTS.workedTogether;
  return {
    evidence: { kind: "worked_together", org, fromYear: yearOfIndex(start), toYear: ongoing ? null : yearOfIndex(end) },
    points,
  };
}

/** Better first: more points, then still going, then the later end, then the longer overlap. */
function betterOverlap(a: ScoredEvidence, b: ScoredEvidence): number {
  if (a.points !== b.points) return b.points - a.points;
  const endOf = (e: Evidence) => (e.kind === "worked_together" ? (e.toYear ?? Infinity) : e.kind === "works_at" ? Infinity : -Infinity);
  const fromOf = (e: Evidence) => (e.kind === "worked_together" ? e.fromYear : Infinity);
  const ea = endOf(a.evidence);
  const eb = endOf(b.evidence);
  if (ea !== eb) return eb - ea;
  return fromOf(a.evidence) - fromOf(b.evidence);
}

/**
 * Every company the owner and the lead both worked at with overlapping dates: one piece of
 * evidence per company (its best overlap), best first.
 */
export function workOverlaps(mine: RoleLike[], theirs: RoleLike[], opts: OverlapOptions): ScoredEvidence[] {
  const best = new Map<string, ScoredEvidence>();
  for (const a of mine) {
    for (const b of theirs) {
      const hit = roleOverlap(a, b, opts);
      if (!hit) continue;
      const key = normaliseName(b.company) || normaliseName(a.company);
      const seen = best.get(key);
      if (!seen || betterOverlap(hit, seen) < 0) best.set(key, hit);
    }
  }
  return [...best.values()].sort(betterOverlap);
}

/**
 * Schools the owner and the lead both went to. Overlapping years: same_school with those years,
 * 2 points. Years unknown on either side: same_school without years, 0 points (shown only next to
 * other evidence). Known years that do not overlap: nothing.
 */
export function schoolOverlaps(mine: SchoolLike[], theirs: SchoolLike[]): ScoredEvidence[] {
  const best = new Map<string, ScoredEvidence>();
  for (const a of mine) {
    for (const b of theirs) {
      if (!sameSchool(a, b)) continue;
      const org = b.school.trim() || a.school.trim();
      const [af, at, bf, bt] = [yearOf(a.from), yearOf(a.to), yearOf(b.from), yearOf(b.to)];
      let hit: ScoredEvidence | null;
      if (af !== null && at !== null && bf !== null && bt !== null) {
        const from = Math.max(af, bf);
        const to = Math.min(at, bt);
        // Years are academic years: one class leaving in 2014 as the next arrives is no overlap,
        // unless someone was there for that one year only.
        const overlap = from < to || (from === to && (af === at || bf === bt));
        hit = overlap ? { evidence: { kind: "same_school", org, fromYear: from, toYear: to }, points: POINTS.sameSchool } : null;
      } else {
        hit = { evidence: { kind: "same_school", org, fromYear: null, toYear: null }, points: 0 };
      }
      if (!hit) continue;
      const key = normaliseName(org);
      const seen = best.get(key);
      if (!seen || hit.points > seen.points) best.set(key, hit);
    }
  }
  return [...best.values()].sort((x, y) => y.points - x.points);
}

/** The roles still going (the owner's current companies, for "Work together at Nimbus now"). */
export function currentRoles<R extends RoleLike>(roles: R[]): R[] {
  return roles.filter(isCurrentRole);
}

/**
 * The lead's companies for "people at their company": the current ones first, then the ones the
 * lead left within the last 8 years, most recent first. One entry per company.
 */
export function leadCompanies(roles: TargetRole[], now: Date): Array<{ company: string; companyKey: string; companyLinkedinUrl: string | null; current: boolean; endYear: number | null }> {
  const year = now.getUTCFullYear();
  const out: Array<{ company: string; companyKey: string; companyLinkedinUrl: string | null; current: boolean; endYear: number | null }> = [];
  const seen = new Set<string>();
  const ordered = [...roles].sort((a, b) => {
    const ca = a.current || a.to == null ? 1 : 0;
    const cb = b.current || b.to == null ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return (yearOf(b.to) ?? 0) - (yearOf(a.to) ?? 0);
  });
  for (const r of ordered) {
    const key = r.companyKey || normaliseName(r.company);
    // "Self-employed" or "Stealth Startup" is no company to find people at.
    if (!key || seen.has(key) || isPlaceholderEmployer(r.company)) continue;
    const current = r.current || r.to == null;
    const endYear = current ? null : yearOf(r.to);
    if (!current && (endYear === null || endYear < year - 8)) continue;
    seen.add(key);
    out.push({ company: r.company, companyKey: key, companyLinkedinUrl: r.companyLinkedinUrl, current, endYear });
  }
  return out;
}
