import "server-only";
import { hasEnv, requireEnv } from "../env";
import { fetchJson, HttpError } from "../http";
import { metered } from "../usage/ledger";
import { exaEstimateUsd, exaReportedCostUsd } from "../usage/prices";
import type { ProviderStatus } from "../types";

/**
 * Exa: web search, people search (category "people") and page contents.
 * CONTRACT: signatures fixed; owned by the exa-hub agent.
 *
 * Docs (checked Nov 2026): https://exa.ai/docs/reference/search.md and
 * https://exa.ai/docs/reference/get-contents.md; the OpenAPI spec (exa.ai/docs/exa-spec.yaml) is
 * the source of truth.
 * - The key goes in the x-api-key header.
 * - Search asks for capped page text plus highlights (query-relevant excerpts). Both come with the
 *   search price, which covers up to 10 results a request, so results are capped at 10.
 * - The people and company categories run on dedicated indices that reject some filters with a
 *   400 ("The people category does not support the following filters: excludeDomains"): people
 *   takes no excludeDomains, and neither takes published-date filters. Those filters are applied
 *   here to the results instead. If Exa rejects another filter the same way, the search is retried
 *   once with that filter applied locally.
 * - `research paper` is now `publication` on Exa's side; `pdf` is deprecated but still accepted.
 * - Contents asks for text only: /contents bills every content type per page, and its callers
 *   only read the text.
 */

export interface ExaResult {
  url: string;
  title: string | null;
  publishedDate: string | null;
  author: string | null;
  /** Page text, capped by textChars. */
  text: string | null;
  highlights: string[];
}

export type ExaCategory = "people" | "company" | "news" | "research paper" | "pdf" | "personal site" | "financial report";

/** Throws on HTTP/config errors so callers can log them. */
export async function exaSearch(
  query: string,
  opts?: {
    numResults?: number;
    category?: ExaCategory;
    includeDomains?: string[];
    excludeDomains?: string[];
    /** ISO date; only results published on or after it. */
    startPublishedDate?: string;
    textChars?: number;
  },
): Promise<ExaResult[]> {
  const key = apiKey();
  const q = cleanQuery(query);
  if (!q) throw new ExaError("Exa search needs a non-empty query");
  const o = opts ?? {};
  const numResults = clampInt(o.numResults, 1, MAX_RESULTS, DEFAULT_RESULTS);
  const textChars = clampInt(o.textChars, 100, MAX_SEARCH_TEXT_CHARS, DEFAULT_SEARCH_TEXT_CHARS);
  const category = apiCategory(o.category);
  const filters: Filters = {
    includeDomains: cleanDomains(o.includeDomains),
    excludeDomains: cleanDomains(o.excludeDomains),
    startPublishedDate: isoDateTime(o.startPublishedDate),
  };
  // Filters this category is known to reject are applied to the results instead of being sent.
  const local = new Set<FilterName>((category && UNSUPPORTED_FILTERS[category]) || []);

  let body: unknown = null;
  for (let attempt = 0; ; attempt++) {
    const request = searchBody(q, category, filters, local, numResults, textChars);
    try {
      body = await call(key, "/search", request, SEARCH_TIMEOUT_MS);
      break;
    } catch (err) {
      // One self-heal for a filter Exa newly refuses for this category; any other error is final.
      const refused = attempt === 0 ? refusedFilters(err).filter((f) => isSet(filters, f) && !local.has(f)) : [];
      if (!refused.length) throw toExaError(err, "search");
      for (const f of refused) local.add(f);
    }
  }

  logWarnings(body);
  let results = mapResults(body, textChars).filter((r) => passesLocalFilters(r, filters, local));
  if (hasNotice(body, "RESTRICTIONS_RELAXED")) {
    // Exa found nothing that contains the quoted phrases and searched again without the quotes.
    // A quoted name is an identity check: keep only results that still mention every word of it.
    const phrases = quotedPhrases(q);
    if (phrases.length) results = results.filter((r) => mentionsAll(r, phrases));
  }
  return uniqueByUrl(results).slice(0, numResults);
}

/** Fetches page text for known URLs. Throws on HTTP/config errors. */
export async function exaContents(urls: string[], opts?: { textChars?: number }): Promise<ExaResult[]> {
  const key = apiKey();
  const list = cleanUrls(urls).slice(0, MAX_CONTENTS_URLS);
  if (!list.length) return [];
  const textChars = clampInt(opts?.textChars, 100, MAX_CONTENTS_TEXT_CHARS, DEFAULT_CONTENTS_TEXT_CHARS);
  let body: unknown;
  try {
    body = await call(key, "/contents", { urls: list, text: { maxCharacters: textChars } }, CONTENTS_TIMEOUT_MS);
  } catch (err) {
    throw toExaError(err, "contents");
  }
  // A page Exa could not fetch (404, 403, timeout) is listed in `statuses` and missing from
  // `results`; that is not an API error, so the caller simply gets fewer pages back.
  const results = uniqueByUrl(mapResults(body, textChars));
  const order = new Map(list.map((u, i) => [urlKey(u), i]));
  const rank = (r: ExaResult) => order.get(urlKey(r.url)) ?? list.length;
  return results.sort((a, b) => rank(a) - rank(b));
}

export function exaStatus(): ProviderStatus {
  const configured = hasEnv("EXA_API_KEY");
  const paused = configured && Date.now() < pausedUntil;
  return {
    id: "exa",
    label: "Exa",
    configured,
    detail: !configured
      ? "Off: set EXA_API_KEY to search the web, news and public profiles."
      : paused
        ? `${pausedReason} Calls resume in about ${Math.max(1, Math.ceil((pausedUntil - Date.now()) / 60_000))} min.`
        : "Web, news and people search, and page text for the research agent.",
  };
}

/** An Exa API failure, with the HTTP status and Exa's machine-readable tag when there is one. */
export class ExaError extends Error {
  constructor(
    message: string,
    public status: number | null = null,
    public tag: string | null = null,
    public requestId: string | null = null,
  ) {
    super(message);
    this.name = "ExaError";
  }
}

// ---------------------------------------------------------------------------------------------
// Request building

const API = "https://api.exa.ai";
/**
 * Per attempt; fetchJson retries once on 429/5xx/network errors. Searches answer in 1 to 5 s, and
 * two attempts still fit the research pipeline's 35 s budget for a search.
 */
const SEARCH_TIMEOUT_MS = 15_000;
/** /contents fetches uncached pages live, and Exa's own crawl timeout defaults to 10 s. */
const CONTENTS_TIMEOUT_MS = 20_000;
/** The search price covers up to 10 results; more cost extra and no caller needs them. */
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const DEFAULT_SEARCH_TEXT_CHARS = 2_000;
const MAX_SEARCH_TEXT_CHARS = 20_000;
const DEFAULT_CONTENTS_TEXT_CHARS = 8_000;
const MAX_CONTENTS_TEXT_CHARS = 50_000;
const MAX_CONTENTS_URLS = 20;
const MAX_HIGHLIGHTS = 4;
const MAX_HIGHLIGHT_CHARS = 1_000;

type FilterName = "includeDomains" | "excludeDomains" | "startPublishedDate";
const FILTER_NAMES: FilterName[] = ["includeDomains", "excludeDomains", "startPublishedDate"];

interface Filters {
  includeDomains: string[];
  excludeDomains: string[];
  startPublishedDate: string | null;
}

/** Filters Exa answers with a 400 for these categories ("dedicated indices that only support semantic search"). */
const UNSUPPORTED_FILTERS: Record<string, FilterName[]> = {
  people: ["excludeDomains", "startPublishedDate"],
  company: ["startPublishedDate"],
};

function apiKey(): string {
  const key = requireEnv("EXA_API_KEY");
  if (Date.now() < pausedUntil) throw new ExaError(pausedReason);
  return key;
}

function searchBody(
  query: string,
  category: string | null,
  filters: Filters,
  local: Set<FilterName>,
  numResults: number,
  textChars: number,
): Record<string, unknown> {
  // Ask for a few extra results when some will be dropped by a filter applied here.
  const filtersLocally =
    (local.has("excludeDomains") && filters.excludeDomains.length > 0) ||
    (local.has("includeDomains") && filters.includeDomains.length > 0) ||
    (local.has("startPublishedDate") && filters.startPublishedDate !== null);
  const body: Record<string, unknown> = {
    query,
    type: "auto",
    numResults: filtersLocally ? Math.min(MAX_RESULTS, numResults + Math.max(2, Math.ceil(numResults / 2))) : numResults,
    contents: { text: { maxCharacters: textChars }, highlights: true },
  };
  if (category) body.category = category;
  if (filters.includeDomains.length && !local.has("includeDomains")) body.includeDomains = filters.includeDomains;
  if (filters.excludeDomains.length && !local.has("excludeDomains")) body.excludeDomains = filters.excludeDomains;
  if (filters.startPublishedDate && !local.has("startPublishedDate")) body.startPublishedDate = filters.startPublishedDate;
  return body;
}

function isSet(filters: Filters, name: FilterName): boolean {
  return name === "startPublishedDate" ? filters.startPublishedDate !== null : filters[name].length > 0;
}

function apiCategory(category: ExaCategory | undefined): string | null {
  if (!category) return null;
  const c = String(category).trim().toLowerCase();
  if (!c) return null;
  return c === "research paper" ? "publication" : c;
}

function cleanQuery(query: unknown): string {
  return typeof query === "string" ? query.replace(/\s+/g, " ").trim() : "";
}

/** "https://www.Example.com/docs/" -> "example.com/docs". Keeps path prefixes and *.wildcards. */
export function cleanDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  v = v.replace(/^www\./, "");
  const [host, ...path] = v.split("/");
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return path.length ? `${host}/${path.join("/")}` : host;
}

function cleanDomains(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const d of list) {
    const c = cleanDomain(d);
    if (c) out.add(c);
  }
  return [...out].slice(0, 1200);
}

/** "2025-11-23" (midnight UTC) or any parseable date -> full ISO date-time, which Exa requires. */
function isoDateTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00.000Z`) : Date.parse(s);
  if (!Number.isFinite(ms)) throw new ExaError(`startPublishedDate is not a valid date: "${s.slice(0, 40)}"`);
  return new Date(ms).toISOString();
}

function cleanUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    try {
      const u = new URL(raw.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const k = urlKey(u.href);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u.href);
    } catch {
      // not a URL: skip it
    }
  }
  return out;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (value == null || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------------------------
// Calling Exa and reading errors

/** After a rejected key (401) or no credits (402), stop calling for a while: every call would fail. */
const PAUSE_MS = 10 * 60_000;
let pausedUntil = 0;
let pausedReason = "";

async function call(key: string, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  // Usage ledger: one row per call, with the cost Exa reports (costDollars) when it sends one.
  const operation = path === "/contents" ? "contents" : "search";
  return metered(
    {
      provider: "exa",
      operation,
      onOk: (answer) => {
        const results = isRecordForUsage(answer) && Array.isArray(answer.results) ? answer.results.length : 0;
        const units: Record<string, number> = operation === "search" ? { searches: 1, results } : { contents: results };
        const reported = exaReportedCostUsd(answer);
        if (reported !== null) return { units, costUsd: reported, costBasis: "reported" };
        // A search is billed for the results asked for, which can be more than came back.
        const billed = operation === "search" && typeof body.numResults === "number" ? Math.max(results, body.numResults) : results;
        return { units, costUsd: exaEstimateUsd(operation, { results: billed }), costBasis: "estimated" };
      },
      // Exa does not bill a request it answered with an error; a timeout is unknown.
      onFail: (err) => {
        const units: Record<string, number> = operation === "search" ? { searches: 1 } : {};
        return err instanceof HttpError ? { units, costUsd: 0, costBasis: "free" } : { units };
      },
    },
    // fetchJson retries once on 429, 5xx and network errors, never on 4xx answers.
    () => fetchJson<unknown>(`${API}${path}`, { method: "POST", headers: { "x-api-key": key }, body, timeoutMs }),
  );
}

function isRecordForUsage(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface ExaErrorBody {
  error: string | null;
  tag: string | null;
  requestId: string | null;
}

function errorBody(err: HttpError): ExaErrorBody {
  try {
    const parsed: unknown = JSON.parse(err.bodySnippet);
    if (isRec(parsed)) return { error: str(parsed.error), tag: str(parsed.tag), requestId: str(parsed.requestId) };
  } catch {
    // not JSON: use the raw text below
  }
  return { error: err.bodySnippet.trim().slice(0, 300) || null, tag: null, requestId: null };
}

/** Filters a 400 says this category does not support, e.g. "...the following filters: excludeDomains." */
function refusedFilters(err: unknown): FilterName[] {
  if (!(err instanceof HttpError) || err.status !== 400) return [];
  const message = errorBody(err).error ?? "";
  const m = message.match(/does not support the following filters?:\s*([^.|]+)/i);
  if (!m) return [];
  const named = m[1].split(/,|\band\b/).map((s) => s.trim().toLowerCase());
  return FILTER_NAMES.filter((f) => named.includes(f.toLowerCase()));
}

function toExaError(err: unknown, op: "search" | "contents"): ExaError {
  if (err instanceof ExaError) return err;
  if (err instanceof HttpError) {
    const { error, tag, requestId } = errorBody(err);
    const code = `${err.status}${tag ? ` ${tag}` : ""}`;
    const said = error ? `: ${error.slice(0, 300)}` : "";
    let message: string;
    if (err.status === 401) {
      message = `Exa rejected the API key (${code}). Check EXA_API_KEY.`;
      pause(message);
    } else if (err.status === 402) {
      message = `Exa refused the ${op}: the account is out of credits or over its spending budget (${code}).`;
      pause(message);
    } else if (err.status === 429) {
      message = `Exa rate limit reached (${code}). Try again shortly.`;
    } else if (err.status >= 500) {
      message = `Exa is unavailable right now (${code}). Try again shortly.`;
    } else {
      message = `Exa rejected the ${op} request (${code})${said}`;
    }
    return new ExaError(message, err.status, tag, requestId);
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      const s = Math.round((op === "search" ? SEARCH_TIMEOUT_MS : CONTENTS_TIMEOUT_MS) / 1000);
      return new ExaError(`Exa ${op} timed out after ${s} s`);
    }
    if (err instanceof SyntaxError) return new ExaError(`Exa returned an unreadable ${op} response`);
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return new ExaError(`Could not reach Exa for the ${op}: ${err.message}${cause}`);
  }
  return new ExaError(`Exa ${op} failed: ${String(err)}`);
}

function pause(reason: string): void {
  pausedUntil = Date.now() + PAUSE_MS;
  pausedReason = reason;
}

const loggedWarnings = new Set<string>();

/** Exa's `warnings` describe the request (e.g. an ignored field): for developers, never for a model. */
function logWarnings(body: unknown): void {
  if (!isRec(body) || !Array.isArray(body.warnings)) return;
  for (const w of body.warnings) {
    if (!isRec(w)) continue;
    const id = `${str(w.code) ?? "WARNING"}${str(w.path) ?? ""}`;
    if (loggedWarnings.has(id)) continue;
    loggedWarnings.add(id);
    console.warn(`[exa] ${id}: ${(str(w.message) ?? "").slice(0, 300)}`);
  }
}

function hasNotice(body: unknown, code: string): boolean {
  return isRec(body) && Array.isArray(body.notices) && body.notices.some((n) => isRec(n) && n.code === code);
}

// ---------------------------------------------------------------------------------------------
// Response mapping (shapes: SearchResultsResponse and ContentsResponse in the OpenAPI spec)

function mapResults(body: unknown, textChars: number): ExaResult[] {
  if (!isRec(body)) throw new ExaError("Exa returned an unexpected response");
  if (!Array.isArray(body.results)) return [];
  const out: ExaResult[] = [];
  for (const raw of body.results) {
    const r = mapResult(raw, textChars);
    if (r) out.push(r);
  }
  return out;
}

export function mapResult(raw: unknown, textChars: number): ExaResult | null {
  if (!isRec(raw)) return null;
  const url = httpUrl(raw.url) ?? httpUrl(raw.id);
  if (!url) return null;
  const text = clip(str(raw.text), textChars);
  const fromPage: string[] = [];
  if (Array.isArray(raw.highlights)) {
    for (const h of raw.highlights) {
      const clean = clip(str(h), MAX_HIGHLIGHT_CHARS);
      // A highlight that is just the opening of the text (typical for profiles) adds nothing.
      if (!clean || (text && squash(text).startsWith(squash(clean)))) continue;
      if (!fromPage.includes(clean)) fromPage.push(clean);
    }
  }
  const profile = entitySummary(raw.entities);
  return {
    url,
    title: clip(str(raw.title), 500),
    publishedDate: isoDate(raw.publishedDate),
    author: clip(str(raw.author), 200),
    text,
    highlights: [...(profile ? [profile] : []), ...fromPage.slice(0, MAX_HIGHLIGHTS)],
  };
}

/**
 * People and company results carry structured `entities` (work history, headcount, funding).
 * One labelled line keeps that data when the page text is cut short, e.g. a LinkedIn profile
 * capped at 600 characters ends before its experience section.
 */
export function entitySummary(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  for (const e of entities) {
    if (!isRec(e) || !isRec(e.properties)) continue;
    const line = e.type === "person" ? personLine(e.properties) : e.type === "company" ? companyLine(e.properties) : null;
    if (line) return line.slice(0, 700);
  }
  return null;
}

function personLine(p: Record<string, unknown>): string | null {
  const head = [str(p.name), str(p.location)].filter(Boolean).join(", ");
  const jobs = (Array.isArray(p.workHistory) ? p.workHistory : []).filter(isRec);
  // Current roles first, in Exa's order otherwise.
  const ordered = [...jobs.filter((j) => isRec(j.dates) && j.dates.to == null), ...jobs.filter((j) => !(isRec(j.dates) && j.dates.to == null))];
  const roles = ordered
    .map((j) => {
      const title = str(j.title);
      const company = isRec(j.company) ? str(j.company.name) : null;
      if (!title && !company) return null;
      return `${[title, company].filter(Boolean).join(" at ")}${span(j.dates)}`;
    })
    .filter((s): s is string => Boolean(s))
    .slice(0, 4);
  const schools = (Array.isArray(p.educationHistory) ? p.educationHistory : [])
    .filter(isRec)
    .map((s) => {
      const where = isRec(s.institution) ? str(s.institution.name) : null;
      const what = [str(s.degree), where].filter(Boolean).join(", ");
      return what ? `${what}${span(s.dates)}` : null;
    })
    .filter((s): s is string => Boolean(s))
    .slice(0, 2);
  if (!roles.length && !schools.length) return null;
  const parts = [`Profile data (Exa)${head ? `: ${head}` : ""}.`];
  if (roles.length) parts.push(`Roles: ${roles.join("; ")}.`);
  if (schools.length) parts.push(`Education: ${schools.join("; ")}.`);
  return parts.join(" ");
}

function companyLine(p: Record<string, unknown>): string | null {
  const facts: string[] = [];
  const founded = num(p.foundedYear);
  if (founded) facts.push(`founded ${founded}`);
  const staff = isRec(p.workforce) ? num(p.workforce.total) : null;
  if (staff) facts.push(`about ${Math.round(staff).toLocaleString("en-US")} employees`);
  const hq = isRec(p.headquarters) ? [str(p.headquarters.city), str(p.headquarters.country)].filter(Boolean).join(", ") : "";
  if (hq) facts.push(`based in ${hq}`);
  const fin = isRec(p.financials) ? p.financials : null;
  const total = fin ? num(fin.fundingTotal) : null;
  const round = fin && isRec(fin.fundingLatestRound) ? fin.fundingLatestRound : null;
  const roundText = round
    ? [str(round.name), num(round.amount) ? usd(num(round.amount)!) : null, str(round.date)?.slice(0, 7) ?? null].filter(Boolean).join(", ")
    : "";
  const funding = [total ? `${usd(total)} raised in total` : null, roundText ? `latest round ${roundText}` : null].filter(Boolean).join("; ");
  const about = clip(str(p.description), 200);
  if (!facts.length && !funding && !about) return null;
  const name = str(p.name);
  return [
    `Company data (Exa)${name ? `: ${name}` : ""}${facts.length ? `, ${facts.join(", ")}` : ""}.`,
    funding ? `Funding: ${funding}.` : null,
    about,
  ]
    .filter(Boolean)
    .join(" ");
}

/** " (2022-09 to now)" from { from, to }. */
function span(dates: unknown): string {
  if (!isRec(dates)) return "";
  const from = str(dates.from)?.slice(0, 7) ?? null;
  const to = str(dates.to)?.slice(0, 7) ?? null;
  if (!from && !to) return "";
  return ` (${from ?? "?"} to ${to ?? "now"})`;
}

function usd(n: number): string {
  const fmt = (v: number, unit: string) => `$${(v >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "")}${unit}`;
  if (n >= 1e9) return fmt(n / 1e9, "B");
  if (n >= 1e6) return fmt(n / 1e6, "M");
  if (n >= 1e3) return fmt(n / 1e3, "K");
  return `$${Math.round(n)}`;
}

// ---------------------------------------------------------------------------------------------
// Filters applied to the results

function passesLocalFilters(r: ExaResult, filters: Filters, local: Set<FilterName>): boolean {
  if (local.has("excludeDomains") && filters.excludeDomains.some((d) => urlMatchesDomain(r.url, d))) return false;
  if (local.has("includeDomains") && filters.includeDomains.length && !filters.includeDomains.some((d) => urlMatchesDomain(r.url, d))) {
    return false;
  }
  if (local.has("startPublishedDate") && filters.startPublishedDate && r.publishedDate) {
    // Undated results stay: the filter can only judge what has a date.
    if (Date.parse(r.publishedDate) < Date.parse(filters.startPublishedDate)) return false;
  }
  return true;
}

/** True when url is on the domain (or a subdomain), under the entry's path prefix if it has one. */
export function urlMatchesDomain(url: string, entry: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const [rawHost, ...path] = entry.toLowerCase().split("/");
    const want = rawHost.replace(/^\*\./, "");
    if (host !== want && !host.endsWith(`.${want}`)) return false;
    // A path entry ("linkedin.com/company") is a plain prefix of the URL path, as on Exa's side.
    return !path.length || u.pathname.toLowerCase().startsWith(`/${path.join("/")}`);
  } catch {
    return false;
  }
}

/** Words of each "quoted phrase" in the query, folded for matching. */
function quotedPhrases(query: string): string[][] {
  const out: string[][] = [];
  for (const m of query.matchAll(/"([^"]+)"/g)) {
    const words = fold(m[1])
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2);
    if (words.length) out.push(words);
  }
  return out;
}

function mentionsAll(r: ExaResult, phrases: string[][]): boolean {
  const hay = fold([r.title, r.author, r.url, r.text, ...r.highlights].filter(Boolean).join(" "));
  return phrases.every((words) => words.every((w) => hay.includes(w)));
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clip(v: string | null, max: number): string | null {
  if (!v) return null;
  return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
}

function httpUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function fold(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").replace(/…$/, "").trim().toLowerCase();
}

/** host (no www) + path, lowercased: linkedin.com/in/x and www.linkedin.com/in/x/ are one page. */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function uniqueByUrl(results: ExaResult[]): ExaResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = urlKey(r.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
