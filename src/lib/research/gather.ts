import "server-only";
import { abstractStatus, inspectCheckpoint, type InspectResult } from "../providers/abstract";
import { apolloStatus, enrichOrganization, getJobPostings, type ApolloJob, type ApolloOrg } from "../providers/apollo";
import { exaSearch, exaStatus, type ExaResult } from "../providers/exa";
import {
  getHubDatasets,
  getHubModels,
  hubStatus,
  searchHubAccounts,
  type HubAccount,
  type HubDataset,
  type HubModel,
} from "../providers/huggingface";
import { findEmail, hunterStatus, type FoundEmailStatus } from "../providers/hunter";
import { getLinkedInPosts, linkedinStatus, type LinkedInPost } from "../providers/linkedin";
import { findXHandle, getXPosts, xStatus, type XPost } from "../providers/xsearch";
import { addUsage, saveFoundEmail, updateLead } from "../repo/leads";
import { creditUnits, LOOKUP_MAX_UNITS, releaseQuota, reserveQuota, settleQuota } from "../repo/quota";
import type { Person } from "./context";
import { attempt, isConfigured, note, raw, step, type RunContext } from "./context";
import { sameCompanyName } from "./domain";
import { givenEmail } from "./identify";
import { cleanXHandle, compact, emailScore, isoDateMonthsAgo, normaliseName, truncate, uniqueBy, urlKey } from "./util";

/**
 * Step 2: collect raw material from every source, in parallel. Each source is
 * optional and isolated: one that is not configured, fails or times out is
 * reported as an event and the others carry on. Never throws.
 */

export interface Gathered {
  posts: LinkedInPost[];
  apolloOrg: ApolloOrg | null;
  jobs: ApolloJob[];
  exaPeople: ExaResult[];
  exaTalks: ExaResult[];
  exaNews: ExaResult[];
  /** A web search for what the teammate asked a re-run to look into (empty without a focus). */
  exaFocus: ExaResult[];
  hub: {
    accounts: Array<HubAccount & { matched: "company" | "person" }>;
    models: HubModel[];
    datasets: HubDataset[];
    inspections: Array<{ repoId: string; result: InspectResult }>;
  };
  email: {
    email: string;
    score: number | null;
    status: string | null;
    sources: string[];
    /** found: Hunter's Email Finder; verified or guess: built from the company's email pattern. */
    emailStatus?: FoundEmailStatus | null;
    pattern?: string | null;
  } | null;
  x: { handle: string; confidence: number; evidence: string | null; posts: XPost[]; summary: string | null } | null;
}

export function emptyGathered(): Gathered {
  return {
    posts: [],
    apolloOrg: null,
    jobs: [],
    exaPeople: [],
    exaTalks: [],
    exaNews: [],
    exaFocus: [],
    hub: { accounts: [], models: [], datasets: [], inspections: [] },
    email: null,
    x: null,
  };
}

/** Only hand an X handle to the (paid, per-post) X search when the match is solid. */
export const X_MIN_CONFIDENCE = 0.7;
const GATHER_CAP_MS = 85_000;
/** Kept back for extract, the agent, writing and verifying. */
const RESERVE_AFTER_GATHER_MS = 95_000;

type Outcome = { label: string; status: "ok" | "empty" | "skipped" | "failed"; detail?: string };

export async function gather(ctx: RunContext): Promise<Gathered> {
  const { leadId, person, deadline } = ctx;
  const out = emptyGathered();
  await step(leadId, "Searching LinkedIn, the web, Hugging Face and X");

  const budget = deadline.budget(GATHER_CAP_MS, RESERVE_AFTER_GATHER_MS);
  // One clock for the whole phase: a call that starts late (job postings after the company
  // lookup) only gets what is left, so sequential calls cannot add up past the budget.
  const endsAt = Date.now() + budget;
  const within = (ms: number) => Math.max(0, Math.min(ms, endsAt - Date.now()));
  const searchName = person.name;
  const count = (delta: Record<string, number>) => addUsage(leadId, delta).catch(() => undefined);

  const tasks: Array<Promise<Outcome>> = [
    // LinkedIn posts
    (async (): Promise<Outcome> => {
      const label = "LinkedIn posts";
      if (!isConfigured(linkedinStatus)) return { label, status: "skipped", detail: "LinkedIn not connected" };
      const profileUrl = person.linkedinUrl;
      if (!profileUrl) return { label, status: "skipped", detail: "no LinkedIn URL" };
      const res = await attempt(label, within(80_000), () =>
        getLinkedInPosts(profileUrl, { limit: 15, providerId: ctx.profile?.providerId ?? null }),
      );
      if (!res.ok) return { label, status: "failed", detail: res.error };
      await raw(leadId, "linkedin.posts", { url: person.linkedinUrl }, res.value);
      out.posts = (res.value.posts ?? []).filter((p) => p?.text?.trim());
      if (!out.posts.length && res.value.error) return { label, status: "failed", detail: res.value.error };
      return { label, status: out.posts.length ? "ok" : "empty", detail: `${out.posts.length} posts` };
    })(),

    // Apollo: company facts and open roles
    (async (): Promise<Outcome> => {
      const label = "Apollo company data";
      if (!isConfigured(apolloStatus)) return { label, status: "skipped", detail: "Apollo not connected" };
      // identify may already hold Apollo's record, matched by the company's LinkedIn URL.
      out.apolloOrg = ctx.apolloOrg ?? null;
      if (!out.apolloOrg) {
        if (!person.domain) return { label, status: "skipped", detail: "company website unknown" };
        const org = await attempt(label, within(30_000), () => enrichOrganization(person.domain!));
        if (!org.ok) return { label, status: "failed", detail: org.error };
        await raw(leadId, "apollo.org", { domain: person.domain }, org.value);
        out.apolloOrg = org.value.org;
        if (!out.apolloOrg) return { label, status: org.value.error ? "failed" : "empty", detail: org.value.error ?? "no match" };
        // A domain that was only guessed can belong to another company (a country site, a
        // namesake). Company facts about the wrong company are worse than none.
        const guessed = person.domainSource === "search" || person.domainSource === "previous";
        if (guessed && out.apolloOrg.name && person.company && !sameCompanyName(out.apolloOrg.name, person.company)) {
          const other = out.apolloOrg.name;
          out.apolloOrg = null;
          return { label, status: "empty", detail: `Apollo has ${person.domain} as "${other}", not ${person.company}; left out` };
        }
      }
      if (out.apolloOrg.id) {
        const jobs = await attempt("Apollo job postings", within(30_000), () => getJobPostings(out.apolloOrg!.id!, 40));
        if (jobs.ok) {
          await raw(leadId, "apollo.jobs", { orgId: out.apolloOrg.id }, jobs.value);
          out.jobs = (jobs.value.jobs ?? []).filter((j) => j?.title?.trim());
        }
      }
      return { label, status: "ok", detail: `${out.jobs.length} open roles` };
    })(),

    // Web: the person
    exaTask("Web search for the person", "exa.people", () => {
      if (!searchName) return null;
      const query = compact([searchName, person.company, person.title]).join(" ");
      return { query, opts: { category: "people" as const, numResults: 5, textChars: 1500 } };
    }, (r) => (out.exaPeople = r)),

    // Web: talks, podcasts, papers, interviews
    exaTask("Web search for talks and interviews", "exa.talks", () => {
      if (!searchName || person.nameIsGuess) return null;
      const query = `"${searchName}" ${person.company ?? ""} talk OR podcast OR interview OR paper OR keynote`.replace(/\s+/g, " ");
      return { query, opts: { numResults: 6, textChars: 2000, excludeDomains: ["linkedin.com"] } };
    }, (r) => (out.exaTalks = r)),

    // Web: company news, last 12 months
    exaTask("Web search for company news", "exa.news", () => {
      if (!person.company) return null;
      const query = `${person.company}${person.domain ? ` (${person.domain})` : ""} robotics AI announcement: funding, launch, robots, models, pilots`;
      return { query, opts: { category: "news" as const, numResults: 6, textChars: 2000, startPublishedDate: isoDateMonthsAgo(12) } };
    }, (r) => (out.exaNews = r)),

    // Web: what the teammate asked this re-run to look into. Only on a re-run with a reason, so a
    // plain run reports no skipped search for it.
    ...(ctx.focus?.trim()
      ? [
          exaTask("Web search for what you asked", "exa.focus", () => {
            const query = focusQuery(person, ctx.focus);
            return query ? { query, opts: { numResults: 6, textChars: 2000 } } : null;
          }, (r) => (out.exaFocus = r)),
        ]
      : []),

    // Hugging Face: accounts, models, datasets, and the Abstract inspect check
    (async (): Promise<Outcome> => {
      const label = "Hugging Face";
      if (!isConfigured(hubStatus)) return { label, status: "skipped", detail: "not available" };
      if (!person.company && !searchName) return { label, status: "skipped", detail: "no name to search" };
      const res = await attempt(label, within(45_000), () => gatherHub(ctx, out));
      if (!res.ok) return { label, status: "failed", detail: res.error };
      await raw(leadId, "huggingface", { company: person.company, name: searchName }, out.hub);
      if (!out.hub.accounts.length) return { label, status: "empty", detail: "no matching account" };
      return {
        label,
        status: "ok",
        detail: `${out.hub.accounts.map((a) => a.id).join(", ")}: ${out.hub.models.length} models, ${out.hub.datasets.length} datasets`,
      };
    })(),

    // Hunter: the finder, then the company's email pattern. None when an email is already known:
    // one the team typed in or imported is never replaced, and one an earlier run found stays.
    (async (): Promise<Outcome> => {
      const label = "Email lookup";
      if (ctx.lead.email) return { label, status: "skipped", detail: givenEmail(ctx.lead) ? "you gave an email" : "email already known" };
      if (!isConfigured(hunterStatus)) return { label, status: "skipped", detail: "Hunter not connected" };
      // Hunter credits come out of the same daily budget as "Find email" on the lead page: the
      // most a lookup can cost first, settled to what Hunter charged once it answers.
      const slot = await reserveQuota("email_lookup", LOOKUP_MAX_UNITS, leadId).catch(() => null);
      if (!slot) return { label, status: "failed", detail: "could not check the Hunter credit budget" };
      if (!slot.ok) return { label, status: "skipped", detail: slot.limit === 0 ? "email lookups are paused" : "today's Hunter credit budget is used up" };
      const res = await attempt(label, within(55_000), () =>
        findEmail({
          linkedinUrl: person.linkedinUrl,
          fullName: person.nameIsGuess ? null : person.name,
          firstName: person.nameIsGuess ? null : person.firstName,
          lastName: person.nameIsGuess ? null : person.lastName,
          domain: person.domain,
          company: person.company,
          budgetMs: within(50_000),
        }),
      );
      await count({ hunterCalls: res.ok ? Math.max(1, res.value.requests ?? 1) : 1 });
      // A lookup that failed or timed out keeps the whole slot: Hunter may have charged anyway.
      if (res.ok && !res.value.requests) await releaseQuota(slot.id);
      else if (res.ok && !res.value.error) await settleQuota(slot.id, creditUnits(res.value.credits));
      if (!res.ok) return { label, status: "failed", detail: res.error };
      await raw(leadId, "hunter", { linkedinUrl: person.linkedinUrl, domain: person.domain }, res.value);
      if (!res.value.email) return { label, status: res.value.error ? "failed" : "empty", detail: res.value.error ?? res.value.reason ?? "no email found" };
      out.email = {
        email: res.value.email,
        score: res.value.score,
        status: res.value.status,
        sources: res.value.sources ?? [],
        emailStatus: res.value.emailStatus ?? "found",
        pattern: res.value.pattern ?? null,
      };
      return { label, status: "ok", detail: EMAIL_DETAIL[out.email.emailStatus ?? "found"] };
    })(),

    // X: find the handle (or reuse a known one), then read recent posts pinned to it
    (async (): Promise<Outcome> => {
      const label = "X posts";
      if (!isConfigured(xStatus)) return { label, status: "skipped", detail: "X search not connected" };
      const res = await attempt(label, within(80_000), () => gatherX(ctx, out));
      if (!res.ok) return { label, status: "failed", detail: res.error };
      return res.value;
    })(),
  ];

  function exaTask(
    label: string,
    rawKey: string,
    build: () => { query: string; opts: Parameters<typeof exaSearch>[1] } | null,
    assign: (results: ExaResult[]) => void,
  ): Promise<Outcome> {
    return (async (): Promise<Outcome> => {
      if (!isConfigured(exaStatus)) return { label, status: "skipped", detail: "Exa not connected" };
      const req = build();
      if (!req) return { label, status: "skipped", detail: "not enough known to search" };
      const res = await attempt(label, within(35_000), () => exaSearch(req.query, req.opts));
      await count({ exaSearches: 1 });
      if (!res.ok) return { label, status: "failed", detail: res.error };
      await raw(leadId, rawKey, { query: req.query }, res.value);
      const results = uniqueBy(
        (res.value ?? []).filter((r) => r?.url),
        (r) => urlKey(r.url),
      );
      assign(results);
      return { label, status: results.length ? "ok" : "empty", detail: `${results.length} results` };
    })();
  }

  // allSettled as a second safety net: each task already converts its own failures.
  const settled = await Promise.allSettled(tasks);
  const outcomes: Outcome[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { label: `Source ${i + 1}`, status: "failed", detail: String(s.reason).slice(0, 200) },
  );

  for (const o of outcomes) {
    if (o.status === "ok") await note(leadId, "tool", `${o.label}: ${o.detail ?? "done"}`);
    else if (o.status === "failed") await note(leadId, "tool", `${o.label} failed (${o.detail ?? "unknown error"}). Skipped.`);
    else if (o.status === "empty") await note(leadId, "tool", `${o.label}: nothing found`);
  }
  const skipped = outcomes.filter((o) => o.status === "skipped");
  if (skipped.length) {
    await note(leadId, "tool", `Skipped: ${skipped.map((o) => `${o.label} (${o.detail})`).join("; ")}`);
  }

  // Contact details go on the lead as soon as they are known.
  try {
    if (out.email && !ctx.lead.email) {
      // Only onto a lead that still has no email: the teammate may have typed one in meanwhile.
      ctx.lead =
        (await saveFoundEmail(leadId, {
          email: out.email.email,
          emailStatus: out.email.emailStatus ?? "found",
          // le_leads.email_confidence is an integer 0..100 (Hunter's score scale; 50 for a guess).
          emailConfidence: emailScore(out.email.score),
        })) ?? ctx.lead;
    }
    if (out.x?.handle && ctx.lead.xHandle !== out.x.handle) {
      ctx.lead = (await updateLead(leadId, { xHandle: out.x.handle })) ?? ctx.lead;
    }
  } catch {
    await note(leadId, "tool", "Could not save the contact details found");
  }

  return out;
}

const EMAIL_DETAIL: Record<FoundEmailStatus, string> = {
  found: "found",
  verified: "built from the company's email pattern and verified",
  guess: "built from the company's email pattern (a best guess: their mail server accepts every address)",
};

/**
 * The web search for a re-run's focus: who and where, then the teammate's words (cut to about
 * 200 characters). Null without a focus, or when neither the name nor the company is known. Pure.
 */
export function focusQuery(person: Pick<Person, "name" | "nameIsGuess" | "company">, focus: string | null | undefined): string | null {
  const text = focus?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const who = compact([person.nameIsGuess ? null : person.name, person.company]).join(" ");
  if (!who) return null;
  return `${who}: ${truncate(text, 200).replace(/…$/, "")}`;
}

/** Hub accounts whose name matches the company (org) or the person (user). Pure. */
export function matchHubAccounts(
  accounts: HubAccount[],
  target: string,
  kind: "company" | "person",
): Array<HubAccount & { matched: "company" | "person" }> {
  const want = normaliseName(target);
  if (want.length < 3) return [];
  const idOf = (a: HubAccount) => normaliseName(a.id);
  const fullOf = (a: HubAccount) => normaliseName(a.fullName);
  if (kind === "person") {
    // A personal account must carry the person's full name: handles alone collide too easily.
    return accounts
      .filter((a) => a.type === "user" && fullOf(a) === want)
      .slice(0, 1)
      .map((a) => ({ ...a, matched: kind }));
  }
  // A company is matched only among organisations: anyone can name a personal account
  // "Amazon", and its models would then be attributed to the company.
  const orgs = accounts.filter((a) => a.type === "org");
  const exact = orgs.filter((a) => idOf(a) === want || fullOf(a) === want);
  // Prefix matches ("amazon-sagemaker-community" for "Amazon") are other teams or communities
  // more often than the company: use them only when no organisation carries the exact name.
  const loose = exact.length ? [] : orgs.filter((a) => want.length >= 5 && (idOf(a).startsWith(want) || fullOf(a).startsWith(want)));
  return [...exact, ...loose].slice(0, 2).map((a) => ({ ...a, matched: kind }));
}

async function gatherHub(ctx: RunContext, out: Gathered): Promise<void> {
  const { person } = ctx;
  const [companyAccounts, personAccounts] = await Promise.all([
    person.company ? searchHubAccounts(person.company).catch(() => []) : Promise.resolve([]),
    person.name && !person.nameIsGuess ? searchHubAccounts(person.name).catch(() => []) : Promise.resolve([]),
  ]);
  const accounts = uniqueBy(
    [
      ...(person.company ? matchHubAccounts(companyAccounts ?? [], person.company, "company") : []),
      ...(person.name ? matchHubAccounts(personAccounts ?? [], person.name, "person") : []),
    ],
    (a) => a.id.toLowerCase(),
  ).slice(0, 3);
  out.hub.accounts = accounts;
  if (!accounts.length) return;

  const lists = await Promise.all(
    accounts.map(async (a) => ({
      models: await getHubModels(a.id, 20).catch(() => [] as HubModel[]),
      datasets: await getHubDatasets(a.id, 20).catch(() => [] as HubDataset[]),
    })),
  );
  out.hub.models = uniqueBy(lists.flatMap((l) => l.models ?? []), (m) => m.id);
  out.hub.datasets = uniqueBy(lists.flatMap((l) => l.datasets ?? []), (d) => d.id);

  // The inspect check only reads repo metadata (no weights, no GPU), but keep it to a few models.
  if (isConfigured(abstractStatus)) {
    const candidates = out.hub.models.filter((m) => m.servedBase).slice(0, 3);
    const results = await Promise.all(
      candidates.map(async (m) => {
        try {
          return { repoId: m.id, result: await inspectCheckpoint(m.id) };
        } catch {
          return null;
        }
      }),
    );
    out.hub.inspections = results.filter((r): r is { repoId: string; result: InspectResult } => Boolean(r && r.result?.configured));
  }
}

async function gatherX(ctx: RunContext, out: Gathered): Promise<Outcome> {
  const { leadId, person } = ctx;
  const label = "X posts";
  let handle = cleanXHandle(ctx.lead.xHandle) ?? cleanXHandle(ctx.apolloPerson?.twitterUrl);
  let confidence = handle ? 1 : 0;
  let evidence: string | null = handle ? "already known for this lead" : null;

  if (!handle) {
    if (!person.name || person.nameIsGuess) return { label, status: "skipped", detail: "name not confirmed" };
    const hints = compact([person.linkedinUrl, ...(ctx.profile?.websites ?? []), ctx.apolloPerson?.githubUrl, person.domain ? `https://${person.domain}` : null]).slice(0, 6);
    const found = await findXHandle({ name: person.name, company: person.company, title: person.title, hints });
    await raw(leadId, "x.handle", { name: person.name, company: person.company }, found);
    handle = cleanXHandle(found.handle);
    confidence = typeof found.confidence === "number" ? found.confidence : 0;
    evidence = found.evidence ?? null;
    if (!handle) return { label, status: found.error ? "failed" : "empty", detail: found.error ?? "no X account found" };
    if (confidence < X_MIN_CONFIDENCE) {
      return { label, status: "empty", detail: `@${handle} might be them, but the match is not certain enough to read posts` };
    }
  }

  const posts = await getXPosts(handle, {
    fromDate: isoDateMonthsAgo(6),
    focus: "robotics, robot models, ML inference, GPUs, infrastructure, hiring, product and company announcements",
    maxPosts: 15,
  });
  await raw(leadId, "x.posts", { handle }, posts);
  const list = (posts.posts ?? []).filter((p) => p?.text?.trim());
  out.x = { handle, confidence, evidence, posts: list, summary: posts.summary ?? null };
  await addUsage(leadId, { xSearches: 1, xPosts: list.length }).catch(() => undefined);
  if (!list.length && posts.error) return { label, status: "failed", detail: posts.error };
  return { label, status: list.length ? "ok" : "empty", detail: `@${handle}, ${list.length} posts` };
}
