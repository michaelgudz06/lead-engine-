import "server-only";
import { hasEnv, optionalEnv } from "../env";
import { fetchJson, HttpError, linkedinSlug, normaliseLinkedinUrl } from "../http";
import type { ProviderStatus } from "../types";

/**
 * Apollo. Organization enrich and job postings work on the free plan.
 * people/match returns 403 on the free plan: report that as planBlocked, never as an error.
 * CONTRACT: signatures fixed; owned by the apollo-hunter agent.
 *
 * Docs: https://docs.apollo.io (organizations/enrich, organizations/{id}/job_postings, people/match).
 * Auth is the `x-api-key` header only, so the key never appears in a URL or an error message.
 * None of the exported functions throw: failures come back in `error`.
 */

export interface ApolloOrg {
  id: string | null;
  name: string | null;
  domain: string | null;
  website: string | null;
  linkedinUrl: string | null;
  industry: string | null;
  employees: number | null;
  foundedYear: number | null;
  description: string | null;
  city: string | null;
  country: string | null;
  /** USD, e.g. 1915000000. */
  totalFunding: number | null;
  latestFundingStage: string | null;
  /** YYYY-MM-DD. */
  latestFundingDate: string | null;
  /** Fraction, as Apollo returns it: 0.45 means headcount grew 45% in six months. */
  headcountGrowth6m: number | null;
  /** Fraction: 0.98 means headcount grew 98% in twelve months. */
  headcountGrowth12m: number | null;
  /** Apollo department keys (e.g. engineering, data_science), largest first, zeros dropped. */
  departmentHeadcount: Record<string, number>;
  /** Cloud, GPU, ML and robotics tools first, then the rest in Apollo's order. */
  technologies: string[];
  keywords: string[];
}

export interface ApolloJob {
  title: string;
  url: string | null;
  location: string | null;
  postedAt: string | null;
}

export interface ApolloPerson {
  name: string | null;
  title: string | null;
  headline: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  githubUrl: string | null;
  city: string | null;
  country: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  employmentHistory: Array<{
    title: string | null;
    organization: string | null;
    startDate: string | null;
    endDate: string | null;
    current: boolean;
  }>;
}

const BASE = "https://api.apollo.io/api/v1";
/** Apollo usually answers in 1-2 s; fetchJson retries once on 429/5xx/network errors. */
const TIMEOUT_MS = 15_000;
/** Apollo bills job postings per page, not per posting, so one big page costs the same as a small one. */
const JOB_PAGE_SIZE = 100;
/** After a 403 from people/match, skip the endpoint for this long (saves a round trip per lead). */
const PLAN_BLOCK_TTL_MS = 60 * 60 * 1000;
const NOT_CONFIGURED = "Apollo is not configured (APOLLO_API_KEY is not set)";

let personMatchBlockedUntil = 0;

/**
 * Company data by domain. Also accepts a website URL ("https://www.figure.ai/careers"), an
 * email address, or a LinkedIn company URL (linkedin.com/company/...), which Apollo can match
 * when the domain is not known yet. `{ org: null }` without `error` means Apollo has no match.
 */
export async function enrichOrganization(domain: string): Promise<{ org: ApolloOrg | null; error?: string }> {
  try {
    if (!hasEnv("APOLLO_API_KEY")) return { org: null, error: NOT_CONFIGURED };
    const companyLinkedin = linkedinCompanyUrl(domain);
    const cleanDomain = companyLinkedin ? null : companyDomain(domain);
    if (!companyLinkedin && !cleanDomain) {
      return { org: null, error: `Apollo enrich needs a company domain; got "${clip(String(domain ?? ""), 80)}"` };
    }
    const body = await apolloRequest("GET", "/organizations/enrich", cleanDomain ? { domain: cleanDomain } : { linkedin_url: companyLinkedin });
    const raw = isRec(body) ? body.organization : null;
    // Apollo answers 200 with an empty object when it has no company for the identifier.
    if (!isRec(raw) || (!str(raw.id) && !str(raw.name))) return { org: null };
    return { org: mapOrg(raw, cleanDomain) };
  } catch (err) {
    return { org: null, error: describeError(err, "organization enrich") };
  }
}

/**
 * Open job postings for an Apollo organization id (ApolloOrg.id), at most `limit` (default 25,
 * max 100). Roles that matter for Abstract (ML, AI, robot learning, inference, infrastructure)
 * come first, then the newest. One Apollo request.
 */
export async function getJobPostings(orgId: string, limit?: number): Promise<{ jobs: ApolloJob[]; error?: string }> {
  const { jobs, error } = await getHiring(orgId, limit);
  return error ? { jobs, error } : { jobs };
}

/** getJobPostings plus the total number of open postings Apollo reports for the company. */
export async function getHiring(
  orgId: string,
  limit?: number,
): Promise<{ jobs: ApolloJob[]; total: number | null; error?: string }> {
  try {
    if (!hasEnv("APOLLO_API_KEY")) return { jobs: [], total: null, error: NOT_CONFIGURED };
    const id = typeof orgId === "string" ? orgId.trim() : "";
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
      return { jobs: [], total: null, error: `Not an Apollo organization id: "${clip(String(orgId ?? ""), 40)}"` };
    }
    const max = clampInt(limit, 1, 100, 25);
    const body = await apolloRequest("GET", `/organizations/${encodeURIComponent(id)}/job_postings`, {
      page: 1,
      per_page: JOB_PAGE_SIZE,
    });
    const rawJobs = isRec(body) && Array.isArray(body.organization_job_postings) ? body.organization_job_postings : [];
    // Apollo lists the same role once per job board (Greenhouse, LinkedIn): keep the newest copy.
    const byRole = new Map<string, ApolloJob & { score: number; time: number }>();
    for (const item of rawJobs) {
      if (!isRec(item)) continue;
      const job = mapJob(item);
      if (!job) continue;
      const key = `${job.title}|${job.location ?? ""}`.toLowerCase();
      const time = job.postedAt ? Date.parse(job.postedAt) : 0;
      const existing = byRole.get(key);
      if (!existing || time > existing.time) byRole.set(key, { ...job, score: jobRelevance(job.title), time });
    }
    const jobs = [...byRole.values()].sort((a, b) => b.score - a.score || b.time - a.time);
    const pagination = isRec(body) && isRec(body.pagination) ? body.pagination : null;
    const total = int(pagination?.total_entries) ?? (rawJobs.length < JOB_PAGE_SIZE ? jobs.length : null);
    return { jobs: jobs.slice(0, max).map(({ title, url, location, postedAt }) => ({ title, url, location, postedAt })), total };
  } catch (err) {
    return { jobs: [], total: null, error: describeError(err, "job postings") };
  }
}

/**
 * Person match by LinkedIn URL (best), or by name plus company domain or name. On the free plan
 * Apollo answers 403: that returns `{ person: null, planBlocked: true }` with no error. A match
 * whose LinkedIn profile differs from the one asked about is dropped as the wrong person.
 */
export async function matchPerson(input: {
  linkedinUrl?: string | null;
  name?: string | null;
  domain?: string | null;
  organizationName?: string | null;
}): Promise<{ person: ApolloPerson | null; planBlocked: boolean; error?: string }> {
  try {
    if (!hasEnv("APOLLO_API_KEY")) return { person: null, planBlocked: false, error: NOT_CONFIGURED };
    if (Date.now() < personMatchBlockedUntil) return { person: null, planBlocked: true };
    const linkedinUrl = safe(() => (input?.linkedinUrl ? normaliseLinkedinUrl(input.linkedinUrl) : null));
    const name = str(input?.name, 120);
    const domain = companyDomain(input?.domain);
    const organizationName = str(input?.organizationName, 160);
    if (!linkedinUrl && !(name && (domain || organizationName))) {
      return {
        person: null,
        planBlocked: false,
        error: "Apollo person match needs a LinkedIn URL, or a name plus a company domain or name",
      };
    }
    // The current docs define these as query parameters, also on this POST endpoint. Apollo
    // matches better with more identifiers; domain and organization_name may be a past employer.
    const body = await apolloRequest("POST", "/people/match", {
      linkedin_url: linkedinUrl,
      name,
      domain,
      organization_name: organizationName,
      reveal_personal_emails: false,
      reveal_phone_number: false,
    });
    const raw = isRec(body) ? body.person : null;
    if (!isRec(raw)) return { person: null, planBlocked: false };
    const confidence = str(raw.match_confidence)?.toLowerCase() ?? null;
    if (confidence === "none") return { person: null, planBlocked: false };
    // Without a LinkedIn URL to anchor identity, a low-confidence name match is too risky to use.
    if (!linkedinUrl && confidence === "low") return { person: null, planBlocked: false };
    const person = mapPerson(raw);
    const askedSlug = safe(() => linkedinSlug(linkedinUrl ?? ""));
    const gotSlug = safe(() => linkedinSlug(person.linkedinUrl ?? ""));
    if (askedSlug && gotSlug && askedSlug !== gotSlug) return { person: null, planBlocked: false };
    return { person, planBlocked: false };
  } catch (err) {
    if (err instanceof HttpError && err.status === 403) {
      // "The api/v1/people/match API is not included in your Free plan" (error_code API_INACCESSIBLE).
      personMatchBlockedUntil = Date.now() + PLAN_BLOCK_TTL_MS;
      return { person: null, planBlocked: true };
    }
    return { person: null, planBlocked: false, error: describeError(err, "person match") };
  }
}

export function apolloStatus(): ProviderStatus {
  const configured = hasEnv("APOLLO_API_KEY");
  const blocked = Date.now() < personMatchBlockedUntil;
  return {
    id: "apollo",
    label: "Apollo",
    configured,
    detail: !configured
      ? "Off: set APOLLO_API_KEY for company headcount, growth, funding and job postings."
      : blocked
        ? "Company headcount, growth, funding and job postings. Person match is not included in this Apollo plan."
        : "Company headcount, growth, funding and job postings. Person match needs a paid Apollo plan.",
  };
}

/** Short, factual strings for the company picture and for code-made findings (no Claude needed). */
export interface ApolloOrgSummary {
  /** "About 960 employees (Apollo estimate)" */
  headcount: string | null;
  /** "Headcount +45% in 6 months, +98% in 12 months" */
  growth: string | null;
  /** "$1.9B raised in total; latest round Series C (Sep 2025)" */
  funding: string | null;
  /** "Largest teams: engineering 261, operations 74, information technology 63" */
  teams: string | null;
}

export function apolloOrgSummary(org: ApolloOrg): ApolloOrgSummary {
  const growthParts = [
    org.headcountGrowth6m != null ? `${formatGrowth(org.headcountGrowth6m)} in 6 months` : null,
    org.headcountGrowth12m != null ? `${formatGrowth(org.headcountGrowth12m)} in 12 months` : null,
  ].filter(Boolean);
  const when = org.latestFundingDate ? monthYear(org.latestFundingDate) : null;
  const stage = org.latestFundingStage && !/^(other|unknown|undisclosed|n\/?a|none)$/i.test(org.latestFundingStage) ? org.latestFundingStage : null;
  const fundingParts = [
    org.totalFunding != null && org.totalFunding > 0 ? `${formatUsd(org.totalFunding)} raised in total` : null,
    stage
      ? `latest round ${stage}${when ? ` (${when})` : ""}`
      : when
        ? `latest round in ${when}`
        : null,
  ].filter(Boolean);
  const teams = Object.entries(org.departmentHeadcount)
    .slice(0, 5)
    .map(([dept, n]) => `${dept.replace(/_/g, " ").replace(/commmunication/, "communication")} ${n}`);
  const funding = fundingParts.join("; ");
  return {
    headcount: org.employees != null ? `About ${org.employees.toLocaleString("en-US")} employees (Apollo estimate)` : null,
    growth: growthParts.length ? `Headcount ${growthParts.join(", ")}` : null,
    funding: funding ? funding.charAt(0).toUpperCase() + funding.slice(1) : null,
    teams: teams.length ? `Largest teams: ${teams.join(", ")}` : null,
  };
}

/** 0.4517 -> "+45%", 0.045 -> "+4.5%", -0.1 -> "-10%". */
export function formatGrowth(fraction: number): string {
  const pct = fraction * 100;
  const abs = Math.abs(pct);
  const shown = abs < 10 ? Math.round(abs * 10) / 10 : Math.round(abs);
  if (shown === 0) return "0%";
  return `${pct < 0 ? "-" : "+"}${shown}%`;
}

/** 1915000000 -> "$1.9B", 13000000 -> "$13M". */
export function formatUsd(amount: number): string {
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (Math.abs(amount) >= size) return `$${trimZero((amount / size).toFixed(1))}${suffix}`;
  }
  return `$${Math.round(amount)}`;
}

/**
 * A company's domain from a domain, website URL or work email:
 * "https://www.Figure.ai/careers", "www.figure.ai", "@figure.ai", "jane@figure.ai" -> "figure.ai".
 * Null for junk, IPs, localhost, LinkedIn profile or post URLs, consumer mailboxes (gmail.com,
 * outlook.com, ...) and addresses at mail providers (jane@yahoo.com), so a wrong input never
 * enriches or searches the wrong company. A bare "yahoo.com" stays: Yahoo is a company too.
 */
export function companyDomain(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase().replace(/^mailto:/, "");
  if (!s || /\s/.test(s)) return null;
  if (/linkedin\.com\/(?!company\/|school\/|showcase\/)[a-z]/.test(s)) return null;
  const wasEmail = s.includes("@");
  if (wasEmail) s = s.slice(s.lastIndexOf("@") + 1);
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname; // also converts unicode hostnames to punycode
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\d*\./, "");
  if (!DOMAIN_RE.test(host) || MAILBOX_ONLY.has(host) || (wasEmail && MAILBOX_PROVIDERS.has(host))) return null;
  return host;
}

// ---------------------------------------------------------------------------------------------
// Private helpers

type Rec = Record<string, unknown>;
type Params = Record<string, string | number | boolean | null | undefined>;

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/** Consumer mailbox domains that are never a company's own domain. */
const MAILBOX_ONLY = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com",
  "mac.com", "ymail.com", "protonmail.com", "pm.me",
]);
/** Mail providers that are also companies: an address there says nothing about the employer. */
const MAILBOX_PROVIDERS = new Set([
  ...MAILBOX_ONLY,
  "yahoo.com", "aol.com", "proton.me", "gmx.com", "gmx.de", "gmx.net", "mail.com", "yandex.ru", "yandex.com",
  "qq.com", "163.com", "126.com", "zoho.com", "fastmail.com", "hey.com", "web.de", "free.fr", "orange.fr", "naver.com",
]);

/** Tools worth surfacing first: where they compute, train and serve. */
const PRIORITY_TECH =
  /\b(aws|amazon web services|amazon ec2|azure|google cloud|gcp|oracle cloud|nvidia|cuda|jetson|kubernetes|docker|pytorch|tensorflow|jax|ros2?|robot operating system|hugging ?face|openai|anthropic|databricks|snowflake|weights (?:&|and) biases|wandb|coreweave|lambda labs|runpod|modal|replicate|ray|triton|onnx|mlflow|sagemaker|vertex ai|bedrock|slurm|terraform)\b/i;

/** Job titles that signal ML, robot learning or infrastructure work (score 2), or engineering (1). */
const STRONG_JOB =
  /\b(machine learning|ml|ai|artificial intelligence|deep learning|inference|model serving|mlops|gpu|cuda|research (?:scientist|engineer)|robot learning|reinforcement learning|imitation learning|perception|computer vision|foundation models?|vla|llm|embodied|autonomy|training infra\w*|ml infra\w*|ai infra\w*)\b/i;
const MEDIUM_JOB =
  /\b(infrastructure|platform|cloud|devops|sre|site reliability|data engineer\w*|software engineer\w*|robotics|controls?|simulation|embedded|firmware|systems engineer\w*)\b/i;

async function apolloRequest(method: "GET" | "POST", path: string, params: Params): Promise<unknown> {
  const key = optionalEnv("APOLLO_API_KEY");
  if (!key) throw new Error(NOT_CONFIGURED);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  }
  const query = qs.toString();
  return fetchJson<unknown>(`${BASE}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: { "x-api-key": key, "cache-control": "no-cache" },
    timeoutMs: TIMEOUT_MS,
  });
}

function mapOrg(o: Rec, requestedDomain: string | null): ApolloOrg {
  const website = httpUrl(o.website_url);
  const events = (Array.isArray(o.funding_events) ? o.funding_events : [])
    .filter(isRec)
    .map((e) => ({ type: str(e.type, 80), date: isoDate(e.date) }))
    .filter((e) => e.date)
    .sort((a, b) => (b.date! < a.date! ? -1 : b.date! > a.date! ? 1 : 0));
  return {
    id: str(o.id, 64),
    name: str(o.name, 200),
    domain: companyDomain(str(o.primary_domain)) ?? companyDomain(website) ?? requestedDomain,
    website,
    linkedinUrl: linkedinCompanyUrl(str(o.linkedin_url, 500)) ?? httpUrl(o.linkedin_url),
    industry: str(o.industry, 120) ?? (Array.isArray(o.industries) ? str(o.industries.find((i) => str(i)), 120) : null),
    employees: positiveInt(o.estimated_num_employees),
    foundedYear: year(o.founded_year),
    description: str(o.short_description, 1200) ?? str(o.seo_description, 1200),
    city: str(o.city, 120),
    country: str(o.country, 120),
    totalFunding: money(o.total_funding) ?? money(o.total_funding_printed),
    latestFundingStage: str(o.latest_funding_stage, 80) ?? events[0]?.type ?? null,
    latestFundingDate: isoDate(o.latest_funding_round_date) ?? events[0]?.date ?? null,
    headcountGrowth6m: ratio(o.organization_headcount_six_month_growth),
    headcountGrowth12m: ratio(o.organization_headcount_twelve_month_growth),
    departmentHeadcount: departments(o.departmental_head_count),
    technologies: technologies(o.technology_names, o.current_technologies),
    keywords: uniqueStrings(Array.isArray(o.keywords) ? o.keywords : [], 60, 80),
  };
}

function mapJob(j: Rec): ApolloJob | null {
  const title = str(j.title, 200);
  if (!title) return null;
  const parts: string[] = [];
  for (const p of [str(j.city, 80), str(j.state, 80), str(j.country, 80)]) {
    if (p && !parts.some((x) => x.toLowerCase() === p.toLowerCase())) parts.push(p);
  }
  return { title, url: httpUrl(j.url), location: parts.length ? parts.join(", ") : null, postedAt: isoTime(j.posted_at) };
}

function mapPerson(p: Rec): ApolloPerson {
  const org = isRec(p.organization) ? p.organization : null;
  const history = (Array.isArray(p.employment_history) ? p.employment_history : []).filter(isRec).map((h) => ({
    title: str(h.title, 200),
    organization: str(h.organization_name, 200),
    startDate: isoDate(h.start_date),
    endDate: isoDate(h.end_date),
    current: h.current === true || (h.current == null && h.end_date == null && h.start_date != null),
  }));
  history.sort(
    (a, b) => Number(b.current) - Number(a.current) || (b.startDate ?? "").localeCompare(a.startDate ?? ""),
  );
  const current = history.find((h) => h.current);
  const fullName = str(p.name, 200) ?? str([p.first_name, p.last_name].filter((x) => typeof x === "string").join(" "), 200);
  const linkedin = str(p.linkedin_url, 500);
  return {
    name: fullName,
    title: str(p.title, 200),
    headline: str(p.headline, 300),
    email: realEmail(p.email),
    emailStatus: str(p.email_status, 40),
    linkedinUrl: (linkedin ? safe(() => normaliseLinkedinUrl(linkedin)) : null) ?? httpUrl(linkedin),
    twitterUrl: httpUrl(p.twitter_url),
    githubUrl: httpUrl(p.github_url),
    city: str(p.city, 120),
    country: str(p.country, 120),
    organizationName: str(org?.name, 200) ?? current?.organization ?? null,
    organizationDomain: companyDomain(str(org?.primary_domain)) ?? companyDomain(str(org?.website_url)),
    employmentHistory: history.slice(0, 15),
  };
}

/** Turns any thrown value into one clear line. Never includes headers or the key. */
function describeError(err: unknown, what: string): string {
  if (err instanceof HttpError) {
    const body = parseJson(err.bodySnippet);
    const details = isRec(body) && isRec(body.error_details) ? body.error_details : null;
    const code = str(details?.code, 80) ?? (isRec(body) ? str(body.error_code, 80) : null);
    const message =
      str(details?.message, 200) ??
      (isRec(body) ? (str(body.error, 200) ?? str(body.message, 200)) : str(err.bodySnippet.replace(/<[^>]*>/g, " "), 160));
    switch (err.status) {
      case 401:
        return `Apollo rejected the API key (401). Check APOLLO_API_KEY.`;
      case 403:
        return `Apollo ${what} is not available with this key or plan (403${code ? ` ${code}` : ""}).`;
      case 404:
        return `Apollo ${what}: not found (404).`;
      case 422:
        return `Apollo could not process the ${what} request (422)${message ? `: ${message}` : ""}.`;
      case 429: {
        const windowName = str(isRec(details?.context) && isRec(details.context.window) ? details.context.window.value : null, 20);
        return `Apollo rate limit reached (429${windowName ? `, per ${windowName}` : ""}); try again later.`;
      }
      default:
        return `Apollo ${what} failed (HTTP ${err.status})${message ? `: ${message}` : ""}.`;
    }
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `Apollo ${what} timed out after ${TIMEOUT_MS / 1000} s.`;
    }
    if (err instanceof SyntaxError) return `Apollo ${what} returned a response that is not JSON.`;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    return `Apollo ${what} failed: ${clip(err.message, 160)}${code}.`;
  }
  return `Apollo ${what} failed: ${clip(String(err), 160)}.`;
}

/** linkedin.com/company/<slug> (or school/showcase) -> canonical https URL, else null. */
function linkedinCompanyUrl(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const m = input.trim().match(/linkedin\.com\/(company|school|showcase)\/([^/?#\s]+)/i);
  return m ? `https://www.linkedin.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}

function departments(v: unknown): Record<string, number> {
  if (!isRec(v)) return {};
  const entries: Array<[string, number]> = [];
  for (const [k, raw] of Object.entries(v)) {
    const n = positiveInt(raw);
    const key = k.trim().toLowerCase();
    if (n && key) entries.push([key, n]);
  }
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries);
}

function technologies(names: unknown, current: unknown): string[] {
  const all = [
    ...(Array.isArray(names) ? names : []),
    ...(Array.isArray(current) ? current.map((t) => (isRec(t) ? t.name : null)) : []),
  ];
  const unique = uniqueStrings(all, 400, 80);
  const first = unique.filter((t) => PRIORITY_TECH.test(t));
  const rest = unique.filter((t) => !PRIORITY_TECH.test(t));
  return [...first, ...rest].slice(0, 100);
}

function jobRelevance(title: string): number {
  if (STRONG_JOB.test(title)) return 2;
  if (MEDIUM_JOB.test(title)) return 1;
  return 0;
}

function uniqueStrings(values: unknown[], max: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = str(v, maxLen);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Apollo hides locked emails behind placeholders such as email_not_unlocked@domain.com. */
function realEmail(v: unknown): string | null {
  const s = str(v, 254)?.toLowerCase();
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(s)) return null;
  if (s.includes("not_unlocked") || s.endsWith("@domain.com")) return null;
  return s;
}

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Trimmed single-line string, clipped to `max`, or null. Numbers become strings. */
function str(v: unknown, max = 300): string | null {
  const raw = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
  if (raw === null) return null;
  const s = raw.replace(/\s+/g, " ").trim();
  return s ? clip(s, max) : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function positiveInt(v: unknown): number | null {
  const n = int(v);
  return n !== null && n > 0 ? n : null;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = int(v);
  return n === null ? fallback : Math.max(min, Math.min(max, n));
}

function year(v: unknown): number | null {
  const n = int(v);
  return n !== null && n >= 1600 && n <= new Date().getUTCFullYear() + 1 ? n : null;
}

/** Growth fractions, rounded to 4 decimals. */
function ratio(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n * 10_000) / 10_000;
}

/** 251200000, "251200000" or "251.2M" -> 251200000. */
function money(v: unknown): number | null {
  const direct = num(v);
  if (direct !== null) return direct > 0 ? direct : null;
  const s = str(v, 40);
  const m = s?.match(/^\$?\s*([\d.,]+)\s*([kmbt])?$/i);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b" | "t"] ?? 1;
  return Number.isFinite(base) && base > 0 ? Math.round(base * mult) : null;
}

function isoDate(v: unknown): string | null {
  const t = parseTime(v);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

function isoTime(v: unknown): string | null {
  const t = parseTime(v);
  return t === null ? null : new Date(t).toISOString();
}

function parseTime(v: unknown): number | null {
  const s = str(v, 64);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function httpUrl(v: unknown): string | null {
  const s = str(v, 2000);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s) ? `https://${s}` : null;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? withScheme : null;
  } catch {
    return null;
  }
}

function monthYear(isoDay: string): string {
  const [y, m] = isoDay.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const name = months[Number(m) - 1];
  return name ? `${name} ${y}` : y;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Runs fn and turns a throw (e.g. a malformed %-escape in a URL) into null. */
function safe<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
