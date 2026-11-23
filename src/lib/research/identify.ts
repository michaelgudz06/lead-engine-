import "server-only";
import { apolloStatus, enrichOrganization, matchPerson, type ApolloOrg, type ApolloPerson } from "../providers/apollo";
import { exaSearch, exaStatus, type ExaResult } from "../providers/exa";
import {
  getLinkedInCompany,
  getLinkedInProfile,
  linkedinStatus,
  type LinkedInCompany,
  type LinkedInProfile,
} from "../providers/linkedin";
import { addUsage, updateLead, type LeadPatch } from "../repo/leads";
import type { Lead, Settings } from "../types";
import { attempt, isConfigured, note, raw, step, type Person, type RunContext } from "./context";
import { chooseCompanyDomain, emailOnStaleDomain, pickCompanyDomain, type DomainCandidate } from "./domain";
import {
  cleanXHandle,
  Deadline,
  domainFromUrl,
  nameFromSlug,
  parseLinkedInTitle,
  splitName,
  urlKey,
} from "./util";

/**
 * Step 1: who is this? Reads the LinkedIn profile, fills the lead's name, title,
 * company and location, and finds the company's domain. Never throws: when the
 * profile cannot be read the run continues from the URL slug, the user's notes
 * and web search.
 */

/** Apify runs for a profile can take one to two minutes; leave the rest of the 300 s for everything else. */
const PROFILE_TIMEOUT_MS = 110_000;
const SECONDARY_TIMEOUT_MS = 40_000;
/** Time kept back for gather, extract, the agent, writing and verifying. */
const RESERVE_AFTER_IDENTIFY_MS = 150_000;

export async function identify(leadId: string, lead: Lead, settings: Settings, deadline: Deadline): Promise<RunContext> {
  await step(leadId, "Reading LinkedIn profile");

  let profile: LinkedInProfile | null = null;
  if (isConfigured(linkedinStatus)) {
    const res = await attempt("LinkedIn profile", deadline.budget(PROFILE_TIMEOUT_MS, RESERVE_AFTER_IDENTIFY_MS), () =>
      getLinkedInProfile(lead.linkedinUrl),
    );
    if (res.ok && res.value.profile) {
      profile = res.value.profile;
      await raw(leadId, "linkedin.profile", { url: lead.linkedinUrl }, profile);
      await note(leadId, "tool", `Read the LinkedIn profile${profile.fullName ? ` of ${profile.fullName}` : ""} (via ${profile.via})`);
    } else {
      const why = res.ok ? (res.value.error ?? "no profile returned") : res.error;
      await note(leadId, "tool", `Could not read the LinkedIn profile (${why}). Continuing from the URL, your notes and web search.`);
    }
  } else {
    await note(leadId, "tool", "LinkedIn is not connected. Continuing from the URL, your notes and web search.");
  }

  const person = personFrom(lead, profile);

  // Without a profile, a people search for the profile URL usually returns the
  // person's name and headline, which is enough to anchor every later search.
  let searchHit: ExaResult | null = null;
  if (!profile && (!person.name || person.nameIsGuess || !person.company) && isConfigured(exaStatus)) {
    searchHit = await findProfileBySearch(leadId, lead, person, deadline);
    if (searchHit) {
      const parsed = parseLinkedInTitle(searchHit.title);
      if (parsed.name && (!person.name || person.nameIsGuess)) {
        person.name = parsed.name;
        person.nameIsGuess = false;
        Object.assign(person, namesOf(parsed.name));
      }
      person.title ??= parsed.title;
      person.company ??= parsed.company;
    }
  }

  await step(leadId, person.company ? `Looking up ${person.company}` : "Looking up the company");

  // The company page, the Apollo person match and the Apollo company lookup do not depend on each other.
  const companyKey = person.companyLinkedinUrl ?? person.company;
  // Apollo matches a company by its LinkedIn URL, which is an exact identifier: its primary
  // domain is the fallback when the LinkedIn page lists no website. Gather reuses the result.
  const companyLinkedinUrl = person.companyLinkedinUrl;
  const [companyRes, apolloRes, apolloOrgRes] = await Promise.all([
    companyKey && isConfigured(linkedinStatus)
      ? attempt("LinkedIn company page", deadline.budget(SECONDARY_TIMEOUT_MS, RESERVE_AFTER_IDENTIFY_MS - 20_000), () =>
          getLinkedInCompany(companyKey),
        )
      : null,
    isConfigured(apolloStatus)
      ? attempt("Apollo person match", deadline.budget(25_000, RESERVE_AFTER_IDENTIFY_MS - 20_000), () =>
          matchPerson({
            linkedinUrl: lead.linkedinUrl,
            name: person.nameIsGuess ? null : person.name,
            // The saved domain is not passed on: it may be the mistake this run corrects.
            domain: profile?.currentCompanyDomain ?? null,
            organizationName: person.company,
          }),
        )
      : null,
    companyLinkedinUrl && isConfigured(apolloStatus)
      ? attempt("Apollo company lookup", deadline.budget(25_000, RESERVE_AFTER_IDENTIFY_MS - 20_000), () => enrichOrganization(companyLinkedinUrl))
      : null,
  ]);

  let company: LinkedInCompany | null = null;
  if (companyRes) {
    if (companyRes.ok && companyRes.value.company) {
      company = companyRes.value.company;
      await raw(leadId, "linkedin.company", { key: companyKey }, company);
    } else {
      await note(leadId, "tool", `LinkedIn company page not available (${companyRes.ok ? (companyRes.value.error ?? "not found") : companyRes.error})`);
    }
  }

  let apolloPerson: ApolloPerson | null = null;
  if (apolloRes) {
    if (apolloRes.ok) {
      await raw(leadId, "apollo.person", { linkedinUrl: lead.linkedinUrl }, apolloRes.value);
      apolloPerson = apolloRes.value.person;
      // A plan block is expected on the free plan and is not worth an event; a real error is.
      if (!apolloPerson && apolloRes.value.error && !apolloRes.value.planBlocked) {
        await note(leadId, "tool", `Apollo person match failed (${apolloRes.value.error})`);
      }
    } else {
      await note(leadId, "tool", `Apollo person match failed (${apolloRes.error})`);
    }
  }

  if (apolloPerson) {
    if (!person.name || person.nameIsGuess) {
      if (apolloPerson.name) {
        person.name = apolloPerson.name;
        person.nameIsGuess = false;
        Object.assign(person, namesOf(apolloPerson.name));
      }
    }
    person.title ??= apolloPerson.title ?? apolloPerson.headline;
    person.company ??= apolloPerson.organizationName;
    person.location ??= [apolloPerson.city, apolloPerson.country].filter(Boolean).join(", ") || null;
  }
  person.company ??= company?.name ?? null;
  person.companyLinkedinUrl ??= company?.linkedinUrl ?? null;

  let apolloOrg: ApolloOrg | null = apolloOrgRes?.ok ? apolloOrgRes.value.org : null;
  // The profile gave a numeric company URL that Apollo did not know: try the page's own URL once.
  if (!apolloOrg && !company?.domain && company?.linkedinUrl && urlKey(company.linkedinUrl) !== urlKey(companyLinkedinUrl ?? "") && isConfigured(apolloStatus)) {
    const again = await attempt("Apollo company lookup", deadline.budget(20_000, RESERVE_AFTER_IDENTIFY_MS - 20_000), () =>
      enrichOrganization(company!.linkedinUrl!),
    );
    apolloOrg = again.ok ? again.value.org : null;
  }
  if (apolloOrg) await raw(leadId, "apollo.org", { linkedinUrl: company?.linkedinUrl ?? companyLinkedinUrl }, apolloOrg);

  // Company domain: every candidate, ranked by how directly its source identifies the company (see domain.ts).
  const candidates: DomainCandidate[] = [
    { value: company?.website, source: "linkedin_company" },
    { value: company?.domain, source: "linkedin_company" },
    { value: apolloOrg?.domain, source: "apollo_org" },
    { value: apolloOrg?.website, source: "apollo_org" },
    { value: profile?.currentCompanyDomain, source: "linkedin_profile" },
    { value: apolloPerson?.organizationDomain, source: "apollo_person" },
  ];
  let choice = chooseCompanyDomain({ company: person.company, personName: person.name, candidates });
  if (!choice && person.company && isConfigured(exaStatus)) {
    const urls = await findDomainBySearch(leadId, person.company, deadline);
    candidates.push(...urls.map((value) => ({ value, source: "search" as const })));
    choice = chooseCompanyDomain({ company: person.company, personName: person.name, candidates });
  }
  // What an earlier run saved is the last resort: it may be the very mistake this run corrects.
  choice ??= chooseCompanyDomain({ company: person.company, personName: person.name, candidates: [{ value: lead.companyDomain, source: "previous" }] });
  person.domain = choice?.domain ?? null;
  person.domainSource = choice?.source ?? null;
  if (choice?.note) await note(leadId, "tool", `Company website: ${choice.note}`);
  if (lead.companyDomain && person.domain && lead.companyDomain !== person.domain) {
    await note(leadId, "tool", `Company website corrected from ${lead.companyDomain} to ${person.domain}`);
  }

  const patch: LeadPatch = {};
  // The user's own entries are kept when research found nothing better; a guessed name is never saved over a real one.
  if (person.name && (!person.nameIsGuess || !lead.name)) patch.name = person.name;
  if (person.title) patch.title = person.title;
  if (person.company) patch.companyName = person.company;
  if (person.location) patch.location = person.location;
  if (person.companyLinkedinUrl) patch.companyLinkedinUrl = person.companyLinkedinUrl;
  if (person.domain) patch.companyDomain = person.domain;
  // An address found on a rejected variant of the domain (jane@amazon.de for amazon.com) was
  // derived from the wrong site: clear it so the email lookup runs again with the right one.
  const staleEmail = emailOnStaleDomain(lead.email, lead.companyDomain, person.domain);
  if (staleEmail) {
    patch.email = null;
    patch.emailConfidence = null;
  }
  if (apolloPerson?.email && (!lead.email || staleEmail)) {
    patch.email = apolloPerson.email;
    patch.emailConfidence = apolloPerson.emailStatus === "verified" ? 95 : 70;
  }
  const apolloHandle = cleanXHandle(apolloPerson?.twitterUrl);
  if (apolloHandle && !lead.xHandle) patch.xHandle = apolloHandle;

  let current = lead;
  try {
    current = (await updateLead(leadId, patch)) ?? lead;
  } catch (err) {
    await note(leadId, "tool", `Could not save the profile details (${err instanceof Error ? err.message : "database error"})`);
  }

  const who = [person.name, person.title, person.company].filter(Boolean).join(", ");
  await note(
    leadId,
    "step",
    who
      ? `Identified: ${who}${person.domain ? ` (${person.domain})` : ""}${person.nameIsGuess ? ". The name is a guess from the URL." : ""}`
      : "Could not identify the person yet. Research continues from the URL and your notes.",
  );

  return { leadId, lead: current, settings, deadline, person, profile, company, apolloPerson, apolloOrg };
}

function namesOf(full: string): { firstName: string | null; lastName: string | null } {
  const { first, last } = splitName(full);
  return { firstName: first, lastName: last };
}

/** The best picture of the person from the lead row and the profile, before any search. Pure. */
export function personFrom(lead: Lead, profile: LinkedInProfile | null): Person {
  const slugName = nameFromSlug(lead.linkedinSlug);
  const name = profile?.fullName?.trim() || lead.name?.trim() || slugName;
  const nameIsGuess = !profile?.fullName?.trim() && !lead.name?.trim() && Boolean(slugName);
  const split = splitName(name);
  return {
    name: name ?? null,
    nameIsGuess,
    firstName: profile?.firstName?.trim() || split.first,
    lastName: profile?.lastName?.trim() || split.last,
    title: profile?.currentTitle?.trim() || profile?.headline?.trim() || lead.title,
    company: profile?.currentCompany?.trim() || lead.companyName,
    // identify() replaces this once every source has been asked; steering reuses the saved value.
    domain: domainFromUrl(profile?.currentCompanyDomain) ?? lead.companyDomain,
    location: profile?.location?.trim() || lead.location,
    linkedinUrl: lead.linkedinUrl,
    companyLinkedinUrl: profile?.currentCompanyLinkedinUrl ?? lead.companyLinkedinUrl,
  };
}

async function findProfileBySearch(leadId: string, lead: Lead, person: Person, deadline: Deadline): Promise<ExaResult | null> {
  const query = [person.name, person.company, "LinkedIn", lead.linkedinSlug].filter(Boolean).join(" ");
  const res = await attempt("People search", deadline.budget(25_000, RESERVE_AFTER_IDENTIFY_MS), () =>
    exaSearch(query, { category: "people", numResults: 5, textChars: 1500 }),
  );
  await addUsage(leadId, { exaSearches: 1 }).catch(() => undefined);
  if (!res.ok) {
    await note(leadId, "tool", `People search failed (${res.error})`);
    return null;
  }
  await raw(leadId, "exa.identify", { query }, res.value);
  const wanted = urlKey(lead.linkedinUrl);
  // Only an exact profile-URL match is trusted here: a namesake would poison every later step.
  const hit = res.value.find((r) => urlKey(r.url) === wanted || (lead.linkedinSlug && urlKey(r.url).endsWith(`/in/${lead.linkedinSlug}`)));
  if (hit) await note(leadId, "tool", "Found the profile through web search");
  return hit ?? null;
}

/** Result URLs of a web search for the company's own site, best first. Empty when the search fails. */
async function findDomainBySearch(leadId: string, company: string, deadline: Deadline): Promise<string[]> {
  const res = await attempt("Company website search", deadline.budget(20_000, RESERVE_AFTER_IDENTIFY_MS - 20_000), () =>
    exaSearch(`${company} official website`, { category: "company", numResults: 5, textChars: 300 }),
  );
  await addUsage(leadId, { exaSearches: 1 }).catch(() => undefined);
  if (!res.ok) return [];
  await raw(leadId, "exa.domain", { company }, res.value.map((r) => ({ url: r.url, title: r.title })));
  return res.value.map((r) => r.url);
}

// Kept as an export of this module for callers and tests that import it from here.
export { pickCompanyDomain };
