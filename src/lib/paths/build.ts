/**
 * Builds a lead's warm paths from what is known: your connections, your own roles and schools,
 * your X lists, and the lead's side. Pure (no I/O), so every rule is unit-tested; the engine
 * (src/lib/paths/engine.ts) loads the inputs and stores the result.
 *
 * One row per person. LinkedIn and X evidence about the same person merge only when the X account
 * was tied to the LinkedIn person during the X check (the names match and the X bio or link names
 * their LinkedIn slug or company: tieXToLinkedin). People at the lead's company with nothing else
 * tying them to the lead are "company people", never paths.
 */

import { nameTokens, normaliseName, sameName } from "../research/util";
import { currentRoles, leadCompanies, mentionsCompany, sameCompanyWords, schoolOverlaps, workOverlaps, type RoleLike, type SchoolLike } from "./overlap";
import { POINTS, rankPaths, xEvidence, type PathCandidate, type ScoredEvidence } from "./score";
import { MAX_COMPANY_PATHS, MAX_PATHS, type TargetRole, type WarmConnector, type WarmPath, type WarmPathTarget } from "./types";

/** A connection from your export, as the engine loads it. */
export interface ContactLike {
  slug: string;
  name: string | null;
  company: string | null;
  position: string | null;
  profileUrl: string | null;
  /** YYYY-MM-DD. */
  connectedOn: string | null;
}

/** Your own profile (Settings > Your network), read through the research account. */
export interface OwnProfile {
  roles: Array<RoleLike & { companyLinkedinUrl?: string | null }>;
  schools: SchoolLike[];
}

/** A shared connection from your LinkedIn account (step 2), in LinkedIn's order. */
export interface MutualLike {
  memberId: string | null;
  slug: string | null;
  name: string;
  headline: string | null;
  url: string | null;
  company: string | null;
  role: string | null;
}

/** Someone the lead follows on X who is in your lists. */
export interface XConnectorLike {
  id: string;
  handle: string;
  name: string | null;
  followers: number | null;
  youFollow: boolean;
  followsYou: boolean;
  /** Whether they follow the lead back; null when it was not checked. */
  followsLead: boolean | null;
  /** Your LinkedIn connection this account was tied to. */
  linkedinSlug: string | null;
}

export interface BuildInput {
  now: Date;
  /** The lead row's current company, used when the target has no roles. */
  leadCompany: string | null;
  leadSlug: string | null;
  target: WarmPathTarget | null;
  own: OwnProfile | null;
  /** The lead in your export, when they are. */
  directConnection: ContactLike | null;
  /** Your LinkedIn account says the lead is 1st degree (step 2). */
  directFirstDegree: boolean;
  /** Verified shared connections (step 2), in LinkedIn's order. */
  mutuals: MutualLike[];
  /** You and the lead on X, with the lead's follower count (to damp very large accounts). */
  xDirect: { youFollow: boolean; followsYou: boolean; leadFollowers: number | null } | null;
  xConnectors: XConnectorLike[];
  /** Your connections by slug: the mutuals' and the tied X accounts' rows, for since dates and companies. */
  connections: Map<string, ContactLike>;
  /** Your connections that may work at the lead's companies (the SQL prefilter), confirmed here. */
  companyContacts: ContactLike[];
  /** When your export was made (or uploaded), for "your export, Nov 2". */
  exportedAt: string | null;
  /** Connectors who are also leads, by slug and by lower-case X handle. */
  alsoLeads: { bySlug: Map<string, { id: string; stage: string }>; byHandle: Map<string, { id: string; stage: string }> };
}

type BuiltPath = Omit<WarmPath, "introDraft" | "askedAt">;

/** "Head of Operations at Nimbus" -> "Nimbus"; null when a headline names no company. */
export function companyFromHeadline(headline: string | null | undefined): string | null {
  const m = /\b(?:at|@)\s+([^|,·•;(]+)/i.exec(headline ?? "");
  const c = m?.[1]?.replace(/\s+-\s.*$/, "").trim();
  return c && c.length >= 2 ? c.slice(0, 120) : null;
}

/** The lead's roles, or the lead row's current company as one current role when the target has none. */
function leadRoles(input: BuildInput): TargetRole[] {
  if (input.target?.roles.length) return input.target.roles;
  if (!input.leadCompany?.trim()) return [];
  return [{ company: input.leadCompany.trim(), companyKey: normaliseName(input.leadCompany), companyLinkedinUrl: null, from: null, to: null, current: true }];
}

/** "Work together at Nimbus now" on your link: the person's current company is one of yours (whole words: sameCompanyWords). */
function sharedCurrentCompany(company: string | null, own: OwnProfile | null): ScoredEvidence | null {
  if (!company || !own) return null;
  const mine = currentRoles(own.roles).find((r) => sameCompanyWords(r.company, company));
  return mine ? { evidence: { kind: "works_at", org: mine.company, asOf: null }, points: POINTS.worksAt } : null;
}

/** "Works with Ada at Acme Robotics now" on the lead's link: the person's current company is the lead's (whole words). */
function leadCurrentCompany(company: string | null, roles: TargetRole[]): ScoredEvidence | null {
  if (!company) return null;
  const theirs = roles.find((r) => (r.current || r.to == null) && sameCompanyWords(r.company, company));
  return theirs ? { evidence: { kind: "works_at", org: theirs.company, asOf: null }, points: POINTS.worksAt } : null;
}

const linkedin1st = (since: string | null): ScoredEvidence => ({ evidence: { kind: "linkedin_1st", since }, points: POINTS.linkedin1st });

function connectorOf(parts: { name: string; title?: string | null; company?: string | null; linkedinUrl?: string | null; xHandle?: string | null; slug?: string | null }, input: BuildInput): WarmConnector {
  const lead = (parts.slug ? input.alsoLeads.bySlug.get(parts.slug) : undefined) ?? (parts.xHandle ? input.alsoLeads.byHandle.get(parts.xHandle.toLowerCase()) : undefined);
  return {
    name: parts.name,
    title: parts.title ?? null,
    company: parts.company ?? null,
    linkedinUrl: parts.linkedinUrl ?? null,
    xHandle: parts.xHandle ?? null,
    leadId: lead?.id ?? null,
    leadStage: (lead?.stage as WarmConnector["leadStage"]) ?? null,
  };
}

/** Everything about each person, merged, before scoring. */
export function buildCandidates(input: BuildInput): PathCandidate[] {
  const roles = leadRoles(input);
  const out: PathCandidate[] = [];

  // You -> lead.
  const direct: ScoredEvidence[] = [];
  if (input.directConnection) direct.push(linkedin1st(input.directConnection.connectedOn));
  else if (input.directFirstDegree) direct.push(linkedin1st(null));
  if (input.own) {
    // The size is that of the one company page that was read (the lead's main current role), never
    // of their other current roles: a board seat at Google is not a 40-person company.
    const size = input.target?.companySize ?? null;
    const firstCurrent = roles.find((r) => r.current);
    const sizeKey = input.target?.companySizeKey ?? (firstCurrent ? normaliseName(firstCurrent.company) : null);
    direct.push(
      ...workOverlaps(input.own.roles, roles, { now: input.now, companySize: (key) => (sizeKey !== null && key === sizeKey ? size : null) }),
      ...schoolOverlaps(input.own.schools, input.target?.schools ?? []),
    );
  }
  if (input.xDirect) {
    const x = xEvidence("you", { aFollowsB: input.xDirect.youFollow, bFollowsA: input.xDirect.followsYou }, input.xDirect.leadFollowers);
    if (x) direct.push(x);
  }
  if (direct.length) out.push({ id: "direct", hops: 1, connector: null, you: direct, lead: [] });

  // LinkedIn people: your shared connections with the lead (step 2).
  const people = new Map<string, PathCandidate & { company: string | null }>();
  input.mutuals.forEach((m, i) => {
    const key = m.slug ?? m.memberId;
    if (!key || key === input.leadSlug) return;
    const csv = m.slug ? input.connections.get(m.slug) : undefined;
    const company = m.company ?? companyFromHeadline(m.headline) ?? csv?.company ?? null;
    const you: ScoredEvidence[] = [linkedin1st(csv?.connectedOn ?? null)];
    const mine = sharedCurrentCompany(company, input.own);
    if (mine) you.push(mine);
    const lead: ScoredEvidence[] = [linkedin1st(null)];
    const theirs = leadCurrentCompany(company, roles);
    if (theirs) lead.push(theirs);
    people.set(`li:${key}`, {
      id: `li:${key}`,
      hops: 2,
      connector: connectorOf({ name: m.name, title: m.role ?? m.headline, company, linkedinUrl: m.url ?? (m.slug ? `https://www.linkedin.com/in/${encodeURIComponent(m.slug)}` : null), slug: m.slug }, input),
      you,
      lead,
      providerOrder: i,
      company,
    });
  });

  // X: people the lead follows who are in your lists. Tied to a LinkedIn connection: one row.
  for (const c of input.xConnectors) {
    if (input.leadSlug && c.linkedinSlug === input.leadSlug) continue;
    const yourX = xEvidence("you", { aFollowsB: c.youFollow, bFollowsA: c.followsYou }, c.followers);
    const leadX = xEvidence("lead", { aFollowsB: true, bFollowsA: c.followsLead === true }, c.followers);
    const tied = c.linkedinSlug ? `li:${c.linkedinSlug}` : null;
    const existing = tied ? people.get(tied) : undefined;
    if (existing) {
      if (yourX) existing.you.push(yourX);
      if (leadX) existing.lead.push(leadX);
      existing.connector = { ...existing.connector!, xHandle: c.handle };
      continue;
    }
    const csv = c.linkedinSlug ? input.connections.get(c.linkedinSlug) : undefined;
    if (csv) {
      // Your connection (export), followed by the lead on X: one row with both.
      const you: ScoredEvidence[] = [linkedin1st(csv.connectedOn)];
      const mine = sharedCurrentCompany(csv.company, input.own);
      if (mine) you.push(mine);
      if (yourX) you.push(yourX);
      const lead: ScoredEvidence[] = leadX ? [leadX] : [];
      // Their company from your export supports a link that X already shows, never on its own.
      const theirs = lead.length ? leadCurrentCompany(csv.company, roles) : null;
      if (theirs) lead.push(theirs);
      people.set(`li:${csv.slug}`, {
        id: `li:${csv.slug}`,
        hops: 2,
        connector: connectorOf({ name: csv.name ?? c.name ?? c.handle, title: csv.position, company: csv.company, linkedinUrl: csv.profileUrl, xHandle: c.handle, slug: csv.slug }, input),
        you,
        lead,
        company: csv.company,
      });
      continue;
    }
    people.set(`x:${c.id}`, {
      id: `x:${c.id}`,
      hops: 2,
      connector: connectorOf({ name: c.name?.trim() || `@${c.handle}`, xHandle: c.handle }, input),
      you: yourX ? [yourX] : [],
      lead: leadX ? [leadX] : [],
      company: null,
    });
  }
  for (const p of people.values()) {
    const { company: _company, ...candidate } = p;
    void _company;
    out.push(candidate);
  }
  return out;
}

/**
 * Your connections at the lead's current company, then at companies the lead left within 8 years:
 * up to 5. A company matches by its whole words only (the same name, or "Acme" for "Acme
 * Robotics"; never "Heli" for "Helix Motion"), and each row names the connection's own company as
 * your export has it: "Works at Acme Robotics (your export, Nov 2)". Leaves out the lead and anyone
 * who already has a path.
 */
export function buildCompanyPeople(input: BuildInput, taken: ReadonlySet<string>): { people: BuiltPath[]; total: number } {
  const companies = leadCompanies(leadRoles(input), input.now);
  if (!companies.length) return { people: [], total: 0 };
  const rows: Array<{ contact: ContactLike; org: string; order: number }> = [];
  const seen = new Set<string>();
  for (const contact of input.companyContacts) {
    const org = contact.company?.trim();
    if (!org || contact.slug === input.leadSlug || taken.has(`li:${contact.slug}`) || seen.has(contact.slug)) continue;
    const order = companies.findIndex((c) => sameCompanyWords(c.company, org));
    if (order < 0) continue;
    seen.add(contact.slug);
    rows.push({ contact, org, order });
  }
  rows.sort(
    (a, b) =>
      a.order - b.order ||
      (b.contact.connectedOn ?? "").localeCompare(a.contact.connectedOn ?? "") ||
      (a.contact.name ?? "").localeCompare(b.contact.name ?? ""),
  );
  const listed = rows.slice(0, MAX_COMPANY_PATHS);
  // Everyone you know at the companies of the people listed (not only the 5 listed), for "You know 40 people at Fathom Robotics (5 shown)".
  const listedCompanies = new Set(listed.map((r) => r.order));
  const total = rows.filter((r) => listedCompanies.has(r.order)).length;
  const people = listed.map((r, i) => {
    // A company the lead left: say when, so nothing (the intro prompt) calls it the lead's company now.
    const left = companies[r.order].current ? null : companies[r.order].endYear;
    return {
      id: `li:${r.contact.slug}`,
      rank: i + 1,
      hops: 2 as const,
      strength: null,
      connector: connectorOf({ name: r.contact.name ?? r.contact.slug, title: r.contact.position, company: r.contact.company, linkedinUrl: r.contact.profileUrl, slug: r.contact.slug }, input),
      links: [{ strength: null, evidence: [{ kind: "works_at" as const, org: r.org, asOf: input.exportedAt, ...(left !== null ? { leadLeftYear: left } : {}) }] }],
    };
  });
  return { people, total };
}

/** The ranked paths (up to 10) and company people (up to 5), without intro drafts; companyTotal counts them all. */
export function buildPaths(input: BuildInput): { paths: BuiltPath[]; companyPaths: BuiltPath[]; companyTotal: number } {
  const paths = rankPaths(buildCandidates(input), MAX_PATHS);
  const company = buildCompanyPeople(input, new Set(paths.map((p) => p.id)));
  return { paths, companyPaths: company.people, companyTotal: company.total };
}

/**
 * Ties an X account to one of your LinkedIn connections: the names match (sameName) and the X bio
 * or link names the connection's LinkedIn slug or company. Returns the connection's slug, or null.
 * The bio is read during the check only and never stored.
 */
export function tieXToLinkedin(x: { name: string | null; bio: string | null }, candidates: ReadonlyArray<ContactLike>): string | null {
  if (!x.name || !x.bio) return null;
  const bio = x.bio.toLowerCase();
  for (const c of candidates) {
    if (!c.name || !sameName(c.name, x.name)) continue;
    const slugHit = bio.includes(`linkedin.com/in/${c.slug.toLowerCase()}`);
    // The company as whole words ("OpenAI" is not "open air"), never a placeholder.
    const companyHit = mentionsCompany(x.bio, c.company);
    if (slugHit || companyHit) return c.slug;
  }
  return null;
}

/** The first and last name to look your connections up by (as sameName compares them), or null. */
export function nameSearchPair(name: string | null | undefined): { first: string; last: string } | null {
  const t = nameTokens(name);
  if (t.length < 2) return null;
  const first = t[0];
  const last = t[t.length - 1];
  // sameName needs both, at least 2 letters each.
  return first.length >= 2 && last.length >= 2 ? { first, last } : null;
}
