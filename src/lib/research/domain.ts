import { domainFromUrl, domainMatchesCompany, normaliseName } from "./util";

/**
 * Choosing the company's website domain. Pure: no I/O, so it is unit-tested directly.
 *
 * The domain drives the email lookup (Hunter), the Apollo company data and the news
 * search, so a wrong one poisons a whole run. Sources are ranked by how directly they
 * identify the company:
 *
 *   1. the website on the LinkedIn company page
 *   2. Apollo's primary domain for the company's LinkedIn URL (an exact identifier)
 *   3. a domain on the LinkedIn profile, then Apollo's person match
 *   4. a web search for the company's site
 *   5. whatever an earlier run saved on the lead
 *
 * Sources 3 to 5 are guesses about which company is meant, so they must also look like
 * the company's name, and a country site (amazon.de) loses to the global one (amazon.com)
 * whenever any source knows the global one.
 */

export type DomainSource = "linkedin_company" | "apollo_org" | "linkedin_profile" | "apollo_person" | "search" | "previous";

export interface DomainCandidate {
  /** A domain or a URL; cleaned here. */
  value: string | null | undefined;
  source: DomainSource;
}

export interface DomainChoice {
  domain: string;
  source: DomainSource;
  /** Why this one, in a few words, when it was not simply the first candidate. For the activity log. */
  note: string | null;
}

const TRUST: Record<DomainSource, number> = {
  linkedin_company: 100,
  apollo_org: 90,
  linkedin_profile: 70,
  apollo_person: 60,
  search: 40,
  previous: 20,
};

/** Sources that identify the company itself (not a guess from a name). */
const isExact = (source: DomainSource) => TRUST[source] >= TRUST.apollo_org;

/**
 * Hosts that are never the company's own site but do turn up as "website": news outlets,
 * personal-page and blog hosts, link pages, paper and code hosts, job boards.
 * (util.domainFromUrl already drops social networks and company databases.)
 */
const NEVER_COMPANY =
  /(^|\.)(github\.io|gitlab\.io|gitlab\.com|wordpress\.com|blogspot\.com|wixsite\.com|squarespace\.com|webflow\.io|carrd\.co|about\.me|netlify\.app|vercel\.app|pages\.dev|herokuapp\.com|readthedocs\.io|sites\.google\.com|arxiv\.org|openreview\.net|researchgate\.net|scholar\.google\.com|semanticscholar\.org|reuters\.com|forbes\.com|wsj\.com|nytimes\.com|ft\.com|cnbc\.com|theverge\.com|wired\.com|venturebeat\.com|businessinsider\.com|theinformation\.com|prnewswire\.com|businesswire\.com|globenewswire\.com|therobotreport\.com|ieee\.org|axios\.com|fortune\.com|siliconangle\.com|geekwire\.com|reddit\.com|quora\.com|lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|myworkdayjobs\.com|calendly\.com|cal\.com|t\.co|lnkd\.in|youtu\.be)$/i;

/** Second-level labels that form a public suffix with a country code: co.uk, com.au, ... */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "edu", "gov", "ne", "or", "go"]);

/** Subdomains that are a department of the same site, not a different company. */
const SITE_SECTION = /^(www\d?|jobs|careers?|about|corporate|corp|home|en|go|get|try|info|hello|join|web|blog|news|press|docs|developer|developers|store|shop|app)$/;

/** "business.amazon.com" -> "amazon.com"; "shop.acme.co.uk" -> "acme.co.uk". */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const twoPartSuffix = tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]);
  return labels.slice(twoPartSuffix ? -3 : -2).join(".");
}

/** The brand part of a domain: "amazon" for amazon.de, amazon.co.uk and business.amazon.com. */
export function brandLabel(domain: string): string {
  return registrableDomain(domain).split(".")[0] ?? "";
}

/** True for a country site: amazon.de, amazon.co.uk. (.ai, .io, .co and friends are used as generic TLDs.) */
export function isCountryDomain(domain: string): boolean {
  const tld = domain.split(".").pop() ?? "";
  return tld.length === 2 && !GENERIC_TWO_LETTER.has(tld);
}
const GENERIC_TWO_LETTER = new Set(["ai", "io", "co", "tv", "me", "so", "sh", "to", "gg", "vc", "ly", "fm", "cc", "ws"]);

/**
 * A candidate value as a clean company domain, or null when it cannot be one.
 * Section subdomains are folded into the main site (careers.acme.com -> acme.com).
 */
export function companySiteDomain(value: string | null | undefined): string | null {
  const host = domainFromUrl(value);
  if (!host || NEVER_COMPANY.test(host)) return null;
  const labels = host.split(".");
  const reg = registrableDomain(host);
  if (host !== reg && labels.slice(0, labels.length - reg.split(".").length).every((l) => SITE_SECTION.test(l))) return reg;
  return host;
}

/** A site named after the person ("janedoe.com" for Jane Doe) is their own page, not their employer's. */
export function looksLikePersonalSite(domain: string, personName: string | null | undefined): boolean {
  const name = normaliseName(personName);
  if (name.length < 6) return false;
  const label = brandLabel(domain).replace(/[^a-z0-9]/g, "");
  if (!label) return false;
  if (label === name) return true;
  const parts = (personName ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z\s-]/g, "").split(/[\s-]+/).filter((p) => p.length >= 2);
  if (parts.length < 2) return false;
  const first = parts[0];
  const last = parts[parts.length - 1];
  // jdoe.com, janed.com, doejane.com
  return label === `${first[0]}${last}` || label === `${first}${last[0]}` || label === `${last}${first}`;
}

/** Higher is better: the .com site, then other global TLDs, then country sites. */
function globalScore(domain: string): number {
  return domain.endsWith(".com") ? 2 : isCountryDomain(domain) ? 0 : 1;
}

/**
 * Picks the company's domain from every candidate the run collected.
 * Returns null when nothing usable was offered.
 */
export function chooseCompanyDomain(input: {
  company: string | null | undefined;
  personName?: string | null;
  candidates: DomainCandidate[];
}): DomainChoice | null {
  const { company, personName } = input;
  const core = normaliseName(company);
  const nameMatches = (domain: string) => Boolean(company) && domainMatchesCompany(registrableDomain(domain), company!);
  const isBrand = (domain: string) => Boolean(core) && brandLabel(domain).replace(/[^a-z0-9]/g, "") === core;

  const usable: Array<{ domain: string; source: DomainSource; order: number }> = [];
  input.candidates.forEach((c, order) => {
    const clean = companySiteDomain(c.value);
    if (!clean) return;
    const matches = nameMatches(clean);
    // A personal page is only acceptable when the company really is named after the person.
    if (!matches && looksLikePersonalSite(clean, personName)) return;
    if (isExact(c.source)) {
      usable.push({ domain: clean, source: c.source, order });
    } else if (!company || matches) {
      // A guessed source has to look like the company, and counts as the site, not a section of it.
      usable.push({ domain: registrableDomain(clean), source: c.source, order });
    }
  });
  if (!usable.length) return null;

  usable.sort((a, b) => TRUST[b.source] - TRUST[a.source] || Number(isBrand(b.domain)) - Number(isBrand(a.domain)) || a.order - b.order);
  const best = usable[0];
  const brand = brandLabel(best.domain);

  if (isExact(best.source)) {
    // The company's own choice of domain is respected, except a country site when
    // another exact source names the global site of the same brand.
    if (!isCountryDomain(best.domain)) return { domain: best.domain, source: best.source, note: null };
    const global = usable.find((u) => isExact(u.source) && brandLabel(u.domain) === brand && !isCountryDomain(u.domain));
    return global
      ? { domain: global.domain, source: global.source, note: `${global.domain} preferred over the country site ${best.domain}` }
      : { domain: best.domain, source: best.source, note: null };
  }

  // Guesses: among the sites of the same brand (amazon.de, amazon.com, amazon.co.uk),
  // the global one wins, then the one most candidates point at, then the first seen.
  const votes = new Map<string, { n: number; order: number; source: DomainSource }>();
  for (const u of usable) {
    if (isExact(u.source) || brandLabel(u.domain) !== brand) continue;
    const seen = votes.get(u.domain);
    if (seen) seen.n++;
    else votes.set(u.domain, { n: 1, order: u.order, source: u.source });
  }
  const ranked = [...votes.entries()].sort(
    ([a, va], [b, vb]) => globalScore(b) - globalScore(a) || vb.n - va.n || TRUST[vb.source] - TRUST[va.source] || va.order - vb.order,
  );
  const [winner, meta] = ranked[0];
  return {
    domain: winner,
    source: meta.source,
    note: winner !== best.domain ? `${winner} preferred over ${isCountryDomain(best.domain) ? "the country site " : ""}${best.domain}` : null,
  };
}

/**
 * The company's own site among web search results: the best name match, the
 * global site before country sites, then the one most results point at. Pure.
 */
export function pickCompanyDomain(company: string, urls: string[]): string | null {
  return chooseCompanyDomain({ company, candidates: urls.map((value) => ({ value, source: "search" as const })) })?.domain ?? null;
}

/**
 * True when `email` sits on a rejected variant of the company's domain (same brand,
 * different site: jane@amazon.de when the company is amazon.com). Such an address was
 * derived from the wrong domain and should be looked up again.
 */
export function emailOnStaleDomain(email: string | null | undefined, previousDomain: string | null | undefined, domain: string | null | undefined): boolean {
  if (!email || !previousDomain || !domain) return false;
  const host = email.split("@").pop()?.toLowerCase().trim();
  if (!host || host !== previousDomain.toLowerCase()) return false;
  return registrableDomain(host) !== registrableDomain(domain) && brandLabel(host) === brandLabel(domain);
}

/** True when two company names plausibly name the same company ("Figure" and "Figure AI, Inc."). */
export function sameCompanyName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // A prefix, not any substring: "CFDT Transports Amazon" is not Amazon.
  return short.length >= 4 && long.startsWith(short);
}
