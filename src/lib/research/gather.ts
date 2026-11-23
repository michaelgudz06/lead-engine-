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
import { findEmail, hunterStatus } from "../providers/hunter";
import { getLinkedInPosts, linkedinStatus, type LinkedInPost } from "../providers/linkedin";
import { findXHandle, getXPosts, xStatus, type XPost } from "../providers/xsearch";
import { addUsage, updateLead } from "../repo/leads";
import { attempt, isConfigured, note, raw, step, type RunContext } from "./context";
import { cleanXHandle, compact, isoDateMonthsAgo, normaliseName, uniqueBy, urlKey } from "./util";

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
  hub: {
    accounts: Array<HubAccount & { matched: "company" | "person" }>;
    models: HubModel[];
    datasets: HubDataset[];
    inspections: Array<{ repoId: string; result: InspectResult }>;
  };
  email: { email: string; score: number | null; status: string | null; sources: string[] } | null;
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
  const within = (ms: number) => Math.min(ms, budget);
  const searchName = person.name;
  const count = (delta: Record<string, number>) => addUsage(leadId, delta).catch(() => undefined);

  const tasks: Array<Promise<Outcome>> = [
    // LinkedIn posts
    (async (): Promise<Outcome> => {
      const label = "LinkedIn posts";
      if (!isConfigured(linkedinStatus)) return { label, status: "skipped", detail: "LinkedIn not connected" };
      const res = await attempt(label, within(80_000), () =>
        getLinkedInPosts(person.linkedinUrl, { limit: 15, providerId: ctx.profile?.providerId ?? null }),
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
      if (!person.domain) return { label, status: "skipped", detail: "company website unknown" };
      const org = await attempt(label, within(30_000), () => enrichOrganization(person.domain!));
      if (!org.ok) return { label, status: "failed", detail: org.error };
      await raw(leadId, "apollo.org", { domain: person.domain }, org.value);
      out.apolloOrg = org.value.org;
      if (!out.apolloOrg) return { label, status: org.value.error ? "failed" : "empty", detail: org.value.error ?? "no match" };
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
      const query = `${person.company}${person.domain ? ` (${person.domain})` : ""} announcement funding launch robots news`;
      return { query, opts: { category: "news" as const, numResults: 6, textChars: 2000, startPublishedDate: isoDateMonthsAgo(12) } };
    }, (r) => (out.exaNews = r)),

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

    // Hunter: one call per lead, and none when an email is already known
    (async (): Promise<Outcome> => {
      const label = "Email lookup";
      if (ctx.lead.email) return { label, status: "skipped", detail: "email already known" };
      if (!isConfigured(hunterStatus)) return { label, status: "skipped", detail: "Hunter not connected" };
      const res = await attempt(label, within(30_000), () =>
        findEmail({
          linkedinUrl: person.linkedinUrl,
          fullName: person.nameIsGuess ? null : person.name,
          firstName: person.nameIsGuess ? null : person.firstName,
          lastName: person.nameIsGuess ? null : person.lastName,
          domain: person.domain,
          company: person.company,
        }),
      );
      await count({ hunterCalls: 1 });
      if (!res.ok) return { label, status: "failed", detail: res.error };
      await raw(leadId, "hunter", { linkedinUrl: person.linkedinUrl, domain: person.domain }, res.value);
      if (!res.value.email) return { label, status: res.value.error ? "failed" : "empty", detail: res.value.error ?? "no email found" };
      out.email = { email: res.value.email, score: res.value.score, status: res.value.status, sources: res.value.sources ?? [] };
      return { label, status: "ok", detail: "found" };
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
      const score = out.email.score;
      ctx.lead =
        (await updateLead(leadId, {
          email: out.email.email,
          // le_leads.email_confidence is an integer 0..100 (Hunter's score scale).
          emailConfidence: score == null ? null : Math.round(score <= 1 ? score * 100 : score),
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

/** Hub accounts whose name matches the company (org) or the person (user). Pure. */
export function matchHubAccounts(
  accounts: HubAccount[],
  target: string,
  kind: "company" | "person",
): Array<HubAccount & { matched: "company" | "person" }> {
  const want = normaliseName(target);
  if (want.length < 3) return [];
  return accounts
    .filter((a) => {
      const id = normaliseName(a.id);
      const full = normaliseName(a.fullName);
      if (kind === "person") {
        // A personal account must carry the person's full name: handles alone collide too easily.
        return a.type === "user" && full === want;
      }
      return id === want || full === want || (want.length >= 5 && (id.startsWith(want) || full.startsWith(want)));
    })
    .slice(0, kind === "company" ? 2 : 1)
    .map((a) => ({ ...a, matched: kind }));
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
