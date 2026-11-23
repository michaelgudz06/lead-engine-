import "server-only";
import { z } from "zod";
import { ClaudeError, generateObject } from "../claude";
import { mapLimit } from "../http";
import type { ApolloOrg } from "../providers/apollo";
import type { LinkedInCompany, LinkedInProfile } from "../providers/linkedin";
import { insertFindings } from "../repo/findings";
import { FINDING_KINDS, SOURCE_LABELS, type Finding, type NewFinding, type Source } from "../types";
import { note, step, type Person, type RunContext } from "./context";
import { dropLowConfidence, normaliseVerdict } from "./criteria";
import type { Gathered } from "./gather";
import { EXTRACT_SYSTEM, extractPrompt } from "./prompts";
import { clamp01, cleanDate, cleanUrl, collectUrls, compact, errorMessage, truncate, uniqueBy, urlKey } from "./util";

/**
 * Step 3: turn raw source data into atomic findings.
 *
 * Structured facts (the LinkedIn role, Apollo headcount, Hugging Face models,
 * the email, the user's notes) become findings in code: they need no judgement
 * and code cannot misquote them. Free text (posts, pages, search results) goes
 * to Haiku, one call per source, a few at a time.
 */

const FindingSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  title: z.string(),
  text: z.string(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
  confidence: z.number(),
  relevance: z.number(),
  passesCriteria: z.boolean(),
  excludedReason: z.string().nullable(),
});
export const ExtractSchema = z.object({ findings: z.array(FindingSchema) });
export type ExtractedFinding = z.infer<typeof FindingSchema>;

/** One batch of free text for Haiku. */
export interface SourceBundle {
  key: string;
  source: Source;
  label: string;
  /** Tells the model what kind of data this is and what to watch for. */
  hint?: string;
  data: unknown;
  /** Used when the model gives no URL for a finding (for example the profile URL for profile text). */
  defaultUrl?: string | null;
  maxFindings: number;
}

const EXTRACT_CONCURRENCY = 4;
const EXTRACT_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------- deterministic findings (pure)

function money(amount: number): string {
  if (amount >= 1e9) return `$${(amount / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (amount >= 1e6) return `$${(amount / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (amount >= 1e3) return `$${Math.round(amount / 1e3)}K`;
  return `$${Math.round(amount)}`;
}

function pct(fraction: number): string {
  // Apollo reports growth as a fraction (0.25); tolerate percentages too.
  const value = Math.abs(fraction) <= 5 ? fraction * 100 : fraction;
  return `${value >= 0 ? "up" : "down"} ${Math.abs(Math.round(value))}%`;
}

function span(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  return ` (${start ?? "?"} to ${end ?? "present"})`;
}

export function notesFinding(notes: string | null | undefined): NewFinding[] {
  const text = notes?.trim();
  if (!text) return [];
  return [
    {
      source: "notes",
      kind: "other",
      title: "Your notes",
      text: truncate(text, 3500),
      confidence: 1,
      relevance: 0.9,
      // The teammate wrote these on purpose; the criteria rules are for collected material.
      passesCriteria: true,
    },
  ];
}

export function profileFindings(profile: LinkedInProfile | null, person: Person): NewFinding[] {
  if (!profile) return [];
  const out: NewFinding[] = [];
  const url = profile.url || person.linkedinUrl;
  const name = profile.fullName ?? person.name ?? "This person";
  const current = profile.experience?.find((e) => !e.endDate && (e.title || e.company)) ?? null;
  const title = profile.currentTitle ?? current?.title ?? null;
  const company = profile.currentCompany ?? current?.company ?? null;

  if (title || company || profile.headline) {
    const role = title && company ? `${name} is ${title} at ${company}` : company ? `${name} works at ${company}` : `${name}: ${title ?? profile.headline}`;
    const since = current?.startDate ? ` since ${current.startDate}` : "";
    const where = profile.location ? `, based in ${profile.location}` : "";
    const headline = profile.headline && profile.headline !== title ? ` LinkedIn headline: "${truncate(profile.headline, 200)}".` : "";
    out.push({
      source: "linkedin",
      kind: "role",
      title: "Current role",
      text: `${role}${since}${where}.${headline}`,
      url,
      publishedAt: current?.startDate ?? null,
      confidence: 1,
      relevance: 0.7,
    });
  }

  const past = (profile.experience ?? []).filter((e) => e !== current && (e.title || e.company)).slice(0, 5);
  if (past.length) {
    out.push({
      source: "linkedin",
      kind: "career",
      title: "Earlier roles",
      text: `Before this: ${past.map((e) => `${e.title ?? "role"} at ${e.company ?? "unknown"}${span(e.startDate, e.endDate)}`).join("; ")}.`,
      url,
      confidence: 1,
      relevance: 0.35,
    });
  }

  const schools = (profile.education ?? []).filter((e) => e.school).slice(0, 3);
  if (schools.length) {
    out.push({
      source: "linkedin",
      kind: "career",
      title: "Education",
      text: `Education: ${schools.map((e) => compact([e.degree, e.field]).join(", ") + (e.degree || e.field ? ", " : "") + e.school).join("; ")}.`,
      url,
      confidence: 1,
      relevance: 0.2,
    });
  }
  return out;
}

export function companyFindings(company: LinkedInCompany | null): NewFinding[] {
  if (!company || !company.name) return [];
  const out: NewFinding[] = [];
  const url = company.linkedinUrl ?? company.website ?? null;
  const size = company.employeeCount ? `${company.employeeCount} employees on LinkedIn` : company.employeeRange ? `${company.employeeRange} employees` : null;
  const facts = compact([
    company.industry ? `industry: ${company.industry}` : null,
    size,
    company.headquarters ? `headquarters: ${company.headquarters}` : null,
    company.foundedYear ? `founded ${company.foundedYear}` : null,
    company.website ? `website: ${company.website}` : null,
  ]);
  if (facts.length) {
    out.push({
      source: "linkedin",
      kind: "company",
      title: `${company.name} at a glance`,
      text: `${company.name} (LinkedIn company page): ${facts.join(", ")}.`,
      url,
      confidence: 0.95,
      relevance: 0.55,
    });
  }
  if (company.description?.trim()) {
    out.push({
      source: "linkedin",
      kind: "company",
      title: `How ${company.name} describes itself`,
      text: `${company.name} describes itself on LinkedIn as: "${truncate(company.description, 600)}"${
        company.specialties?.length ? ` Specialties: ${company.specialties.slice(0, 10).join(", ")}.` : ""
      }`,
      url,
      confidence: 0.95,
      relevance: 0.6,
    });
  }
  return out;
}

export function apolloOrgFindings(org: ApolloOrg | null): NewFinding[] {
  if (!org) return [];
  const out: NewFinding[] = [];
  const name = org.name ?? org.domain ?? "The company";
  const url = org.website ?? (org.domain ? `https://${org.domain}` : null);

  if (org.employees != null) {
    const growth = compact([
      org.headcountGrowth6m != null ? `${pct(org.headcountGrowth6m)} in 6 months` : null,
      org.headcountGrowth12m != null ? `${pct(org.headcountGrowth12m)} in 12 months` : null,
    ]);
    const eng = Object.entries(org.departmentHeadcount ?? {})
      .filter(([, n]) => typeof n === "number" && n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([dept, n]) => `${dept.replace(/_/g, " ")} ${n}`);
    out.push({
      source: "apollo",
      kind: "company",
      title: "Headcount",
      text: `${name} has about ${org.employees} employees (Apollo)${growth.length ? `, headcount ${growth.join(" and ")}` : ""}.${
        eng.length ? ` Largest teams: ${eng.join(", ")}.` : ""
      }`,
      url,
      confidence: 0.9,
      relevance: 0.6,
    });
  }
  if (org.totalFunding != null || org.latestFundingStage) {
    out.push({
      source: "apollo",
      kind: "funding",
      title: "Funding",
      text: `${name}${org.totalFunding != null ? ` has raised ${money(org.totalFunding)} in total` : ""}${
        org.latestFundingStage ? `${org.totalFunding != null ? "; latest round" : " latest round"}: ${org.latestFundingStage}${org.latestFundingDate ? ` (${org.latestFundingDate.slice(0, 10)})` : ""}` : ""
      } (Apollo).`,
      url,
      publishedAt: cleanDate(org.latestFundingDate),
      confidence: 0.85,
      relevance: 0.6,
    });
  }
  const basics = compact([
    org.industry ? `industry: ${org.industry}` : null,
    org.foundedYear ? `founded ${org.foundedYear}` : null,
    org.city || org.country ? `based in ${compact([org.city, org.country]).join(", ")}` : null,
  ]);
  if (org.description?.trim() || basics.length) {
    out.push({
      source: "apollo",
      kind: "company",
      title: "Company profile",
      text: `${name}${basics.length ? ` (${basics.join(", ")})` : ""}${org.description?.trim() ? `: ${truncate(org.description, 500)}` : "."}`,
      url,
      confidence: 0.85,
      relevance: 0.5,
    });
  }
  const tech = uniqueBy([...(org.technologies ?? []), ...(org.keywords ?? [])].filter(Boolean), (t) => t.toLowerCase()).slice(0, 25);
  if (tech.length) {
    out.push({
      source: "apollo",
      kind: "company",
      title: "Technologies and keywords",
      text: `Apollo lists these technologies and keywords for ${name}: ${tech.join(", ")}.`,
      url,
      confidence: 0.8,
      relevance: 0.45,
    });
  }
  return out;
}

export function hubFindings(hub: Gathered["hub"]): NewFinding[] {
  const out: NewFinding[] = [];
  for (const account of hub.accounts) {
    // An org account matched by company name is solid; a personal account matched by name alone less so.
    const confidence = account.matched === "company" ? 0.85 : 0.6;
    const owns = (id: string) => id.toLowerCase().startsWith(`${account.id.toLowerCase()}/`);
    const models = hub.models.filter((m) => owns(m.id));
    const datasets = hub.datasets.filter((d) => owns(d.id));
    const who = account.fullName ? `${account.fullName} (${account.id})` : account.id;

    for (const m of models.filter((x) => x.servedBase).slice(0, 5)) {
      out.push({
        source: "huggingface",
        kind: "model",
        title: `Fine-tune of ${m.servedBase}`,
        text: `${who} publishes ${m.id} on Hugging Face, a fine-tune of ${m.servedBase}, a base model Abstract can serve${
          m.lastModified ? ` (last updated ${m.lastModified.slice(0, 10)})` : ""
        }${m.downloads != null ? `, ${m.downloads} downloads` : ""}.`,
        url: m.url,
        publishedAt: cleanDate(m.lastModified),
        confidence,
        relevance: 0.95,
      });
    }
    if (models.length) {
      const others = models.filter((x) => !x.servedBase);
      const sample = (others.length ? others : models).slice(0, 8).map((m) => (m.baseModels?.length ? `${m.id} (base: ${m.baseModels.slice(0, 2).join(", ")})` : m.id));
      out.push({
        source: "huggingface",
        kind: "model",
        title: "Public models on Hugging Face",
        text: `${who} has ${models.length}${models.length >= 20 ? "+" : ""} public models on Hugging Face, including ${sample.join(", ")}.`,
        url: account.url,
        confidence,
        relevance: 0.65,
      });
    }
    if (datasets.length) {
      const robotics = datasets.filter((d) => (d.tags ?? []).some((t) => /lerobot|robotics|droid|aloha/i.test(t)));
      out.push({
        source: "huggingface",
        kind: "repo",
        title: "Public datasets on Hugging Face",
        text: `${who} has ${datasets.length}${datasets.length >= 20 ? "+" : ""} public datasets on Hugging Face, including ${datasets
          .slice(0, 6)
          .map((d) => d.id)
          .join(", ")}.${robotics.length ? ` ${robotics.length} are tagged as robotics or LeRobot data.` : ""}`,
        url: account.url,
        confidence,
        relevance: robotics.length ? 0.8 : 0.5,
      });
    }
  }
  for (const { repoId, result } of hub.inspections) {
    if (result.error && result.servable == null) continue;
    const text =
      result.servable === true
        ? `Abstract's inspect check says ${repoId} can be served${result.model ? ` on the ${result.model} lane` : ""}${
            result.estimatedVramGib != null ? ` (about ${result.estimatedVramGib} GiB of GPU memory)` : ""
          }.`
        : `Abstract's inspect check says ${repoId} cannot be served as is${result.problems?.length ? `: ${result.problems.slice(0, 3).join("; ")}` : ""}.`;
    out.push({
      source: "abstract",
      kind: "model",
      title: result.servable ? "Their checkpoint can run on Abstract" : "Their checkpoint needs changes to run",
      text,
      url: `https://huggingface.co/${repoId}`,
      confidence: 0.95,
      relevance: result.servable ? 1 : 0.75,
    });
  }
  return out;
}

export function emailFinding(email: Gathered["email"], person: Person): NewFinding[] {
  if (!email) return [];
  const score = email.score == null ? null : Math.round(email.score <= 1 ? email.score * 100 : email.score);
  return [
    {
      source: "hunter",
      kind: "email",
      title: "Work email",
      text: `Hunter suggests ${email.email} for ${person.name ?? "this person"}${score != null ? ` (confidence ${score} of 100` : ""}${
        email.status ? `${score != null ? ", " : " ("}status: ${email.status}` : ""
      }${score != null || email.status ? ")" : ""}.`,
      url: cleanUrl(email.sources?.[0]) ?? null,
      confidence: score != null ? Math.max(0.5, score / 100) : 0.6,
      relevance: 0.3,
    },
  ];
}

/** Every finding that code can state without judgement. Pure. */
export function deterministicFindings(ctx: Pick<RunContext, "lead" | "person" | "profile" | "company">, gathered: Gathered): NewFinding[] {
  return [
    ...notesFinding(ctx.lead.notes),
    ...profileFindings(ctx.profile, ctx.person),
    ...companyFindings(ctx.company),
    ...apolloOrgFindings(gathered.apolloOrg),
    ...hubFindings(gathered.hub),
    ...emailFinding(gathered.email, ctx.person),
  ];
}

// ---------------------------------------------------------------- bundles for Haiku (pure)

const slimResult = (r: { url: string; title: string | null; publishedDate: string | null; author: string | null; text: string | null; highlights: string[] }, chars: number) => ({
  url: r.url,
  title: r.title,
  published: r.publishedDate,
  author: r.author,
  highlights: (r.highlights ?? []).slice(0, 3).map((h) => truncate(h, 400)),
  text: truncate(r.text, chars),
});

export function buildBundles(ctx: Pick<RunContext, "person" | "profile">, gathered: Gathered): SourceBundle[] {
  const bundles: SourceBundle[] = [];
  const { person, profile } = ctx;

  // Profile free text only: role, career and education are already findings in code.
  if (profile) {
    const described = (profile.experience ?? [])
      .filter((e) => e.description?.trim())
      .slice(0, 6)
      .map((e) => ({ title: e.title, company: e.company, from: e.startDate, to: e.endDate, description: truncate(e.description, 1200) }));
    if (profile.about?.trim() || described.length) {
      bundles.push({
        key: "linkedin.profile",
        source: "linkedin",
        label: "LinkedIn profile text (their own words: about section and role descriptions)",
        hint: "Their current role, past job titles and education are already recorded. Extract only what the free text adds: what they work on, the stack, robots, models, scale, responsibilities.",
        data: { headline: profile.headline, about: truncate(profile.about, 4000), roles: described, skills: (profile.skills ?? []).slice(0, 30) },
        defaultUrl: profile.url || person.linkedinUrl,
        maxFindings: 5,
      });
    }
  }

  if (gathered.posts.length) {
    bundles.push({
      key: "linkedin.posts",
      source: "linkedin",
      label: "Their recent LinkedIn posts, newest first",
      hint: "A repost (isRepost true) shows interest, not authorship: say 'reposted'. One finding per post worth knowing; skip congratulations, birthdays and generic reshares.",
      data: gathered.posts.slice(0, 15).map((p) => ({
        url: p.url,
        postedAt: p.postedAt,
        isRepost: p.isRepost,
        reactions: p.reactions,
        text: truncate(p.text, 1500),
      })),
      defaultUrl: person.linkedinUrl,
      maxFindings: 8,
    });
  }

  if (gathered.jobs.length) {
    bundles.push({
      key: "apollo.jobs",
      source: "apollo",
      label: `Open job postings at ${person.company ?? "the company"} (Apollo)`,
      hint: "Return hiring findings only for roles that matter to Abstract: ML, robot learning, ML infrastructure, platform, MLOps, GPU or inference, robotics software, deployment. Group similar roles into one finding and name the titles. Add one finding with the total number of open roles. Ignore sales, HR, finance and similar roles apart from that count.",
      data: { totalOpenRoles: gathered.jobs.length, jobs: gathered.jobs.slice(0, 40).map((j) => ({ title: j.title, url: j.url, location: j.location, postedAt: j.postedAt })) },
      maxFindings: 5,
    });
  }

  if (gathered.exaPeople.length) {
    bundles.push({
      key: "exa.people",
      source: "exa",
      label: "Web search results for the person (people search)",
      hint: "Search results often include other people with the same or a similar name. Use the company, title and location on the card to decide, and score confidence low when a result does not clearly match. Do not repeat the current job title alone.",
      data: gathered.exaPeople.map((r) => slimResult(r, 1500)),
      maxFindings: 6,
    });
  }

  if (gathered.exaTalks.length) {
    bundles.push({
      key: "exa.talks",
      source: "exa",
      label: "Web search results for talks, podcasts, interviews and papers by the person",
      hint: "Keep only items where this person is a speaker, guest, author or is quoted. Results about namesakes get low confidence.",
      data: gathered.exaTalks.map((r) => slimResult(r, 2000)),
      maxFindings: 6,
    });
  }

  if (gathered.exaNews.length) {
    bundles.push({
      key: "exa.news",
      source: "exa",
      label: `News search results about ${person.company ?? "the company"} from the last 12 months`,
      hint: "Confidence here means: is this about the right company (check the website and what the company does)? Prefer funding, launches, pilots, customers, partnerships, robots and models used.",
      data: gathered.exaNews.map((r) => slimResult(r, 2000)),
      maxFindings: 8,
    });
  }

  if (gathered.x?.posts.length) {
    const handle = gathered.x.handle;
    bundles.push({
      key: "x.posts",
      source: "x",
      label: `Their recent posts on X (@${handle})`,
      hint: `The account was matched to this person with confidence ${gathered.x.confidence.toFixed(2)}${gathered.x.evidence ? ` (${truncate(gathered.x.evidence, 200)})` : ""}. Do not give a finding more confidence than that. One finding per post worth knowing.`,
      data: {
        summary: truncate(gathered.x.summary, 1200),
        posts: gathered.x.posts.slice(0, 15).map((p) => ({ url: p.url, postedAt: p.postedAt, text: truncate(p.text, 1000) })),
      },
      defaultUrl: `https://x.com/${handle}`,
      maxFindings: 8,
    });
  }

  return bundles;
}

// ---------------------------------------------------------------- cleaning (pure)

/**
 * Checks model output before it is saved: scores clamped, dates and URLs
 * validated, and a URL kept only when it really appears in the source data, so a
 * made-up link can never reach the brief.
 */
export function cleanExtracted(items: ExtractedFinding[], bundle: Pick<SourceBundle, "source" | "data" | "defaultUrl" | "maxFindings">): NewFinding[] {
  const known = collectUrls(bundle.data);
  const out: NewFinding[] = [];
  for (const item of items.slice(0, bundle.maxFindings)) {
    const text = item.text?.trim();
    if (!text) continue;
    const url = cleanUrl(item.url);
    out.push(
      normaliseVerdict({
        source: bundle.source,
        kind: item.kind,
        title: truncate(item.title, 120) || null,
        text: truncate(text, 900),
        url: url && known.has(urlKey(url)) ? url : (bundle.defaultUrl ?? null),
        publishedAt: cleanDate(item.publishedAt),
        confidence: clamp01(item.confidence, 0.6),
        relevance: clamp01(item.relevance, 0.5),
        passesCriteria: item.passesCriteria,
        excludedReason: item.excludedReason,
      }),
    );
  }
  return out;
}

export function dedupeFindings(items: NewFinding[]): NewFinding[] {
  return uniqueBy(items, (f) => `${f.source}|${f.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160)}`);
}

// ---------------------------------------------------------------- the step

/** Runs one bundle through Haiku. Throws ClaudeError; the caller isolates it. */
export async function extractBundle(input: {
  leadId?: string | null;
  person: Person;
  criteria: string[];
  bundle: SourceBundle;
  timeoutMs?: number;
}): Promise<NewFinding[]> {
  const { bundle } = input;
  const result = await generateObject({
    leadId: input.leadId,
    label: `Reading ${bundle.label}`,
    system: EXTRACT_SYSTEM,
    prompt: extractPrompt({
      person: input.person,
      criteria: input.criteria,
      sourceLabel: bundle.label,
      hint: bundle.hint,
      data: bundle.data,
      maxFindings: bundle.maxFindings,
    }),
    schema: ExtractSchema,
    maxTokens: 6_000,
    timeoutMs: input.timeoutMs ?? EXTRACT_TIMEOUT_MS,
  });
  return cleanExtracted(result.findings ?? [], bundle);
}

/** Step 3. Returns the findings saved by this step. Never throws. */
export async function extract(ctx: RunContext, gathered: Gathered): Promise<Finding[]> {
  const { leadId, person, settings, deadline } = ctx;
  const facts = deterministicFindings(ctx, gathered);
  const bundles = buildBundles(ctx, gathered);

  await step(leadId, bundles.length ? `Reading ${bundles.length} ${bundles.length === 1 ? "source" : "sources"} for facts` : "Recording the facts found");

  // Leave room for writing and verifying even if extraction is slow.
  const timeoutMs = deadline.budget(EXTRACT_TIMEOUT_MS, 75_000);
  let fatal: ClaudeError | null = null;
  const extracted = await mapLimit(bundles, EXTRACT_CONCURRENCY, async (bundle) => {
    // A rejected key or missing config fails every call the same way: stop spending time on the rest.
    if (fatal || timeoutMs < 5_000) return [] as NewFinding[];
    try {
      return await extractBundle({ leadId, person, criteria: settings.criteria, bundle, timeoutMs });
    } catch (err) {
      if (err instanceof ClaudeError && err.kind === "config") fatal = err;
      await note(leadId, "tool", `Could not read ${bundle.label} (${errorMessage(err)}). Skipped.`);
      return [] as NewFinding[];
    }
  });

  const { kept, dropped } = dropLowConfidence(extracted.flat());
  const all = dedupeFindings([...facts.map((f) => normaliseVerdict(f)), ...kept]);

  let saved: Finding[] = [];
  try {
    saved = await insertFindings(leadId, all);
  } catch (err) {
    await note(leadId, "error", `Could not save findings (${errorMessage(err)})`);
  }

  const hidden = saved.filter((f) => !f.passesCriteria).length;
  const bySource = new Map<string, number>();
  for (const f of saved) bySource.set(SOURCE_LABELS[f.source], (bySource.get(SOURCE_LABELS[f.source]) ?? 0) + 1);
  await note(
    leadId,
    "finding",
    saved.length
      ? `${saved.length} ${saved.length === 1 ? "finding" : "findings"} recorded (${[...bySource].map(([s, n]) => `${s} ${n}`).join(", ")})${hidden ? `; ${hidden} filtered out by your criteria` : ""}${
          dropped ? `; ${dropped} dropped as probably about someone else` : ""
        }`
      : "No findings could be recorded from the sources",
    { total: saved.length, filteredOut: hidden, droppedLowConfidence: dropped },
  );
  return saved;
}
