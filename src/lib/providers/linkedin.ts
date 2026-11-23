import "server-only";
import { hasEnv, optionalEnv } from "../env";
import { fetchJson, HttpError, normaliseLinkedinUrl } from "../http";
import type { ProviderStatus } from "../types";

/**
 * LinkedIn data. Primary: Unipile (a separate LinkedIn account connected in the
 * Unipile dashboard). Fallback: an Apify actor that reads public profiles.
 * CONTRACT: signatures below are fixed; implementations are owned by the linkedin agent.
 *
 * Unipile (https://developer.unipile.com): header X-API-KEY, base URL from UNIPILE_DSN.
 *  - GET  /api/v1/accounts                     pick the LinkedIn account (cached in memory)
 *  - GET  /api/v1/users/{public id}            profile, with linkedin_sections
 *  - GET  /api/v1/users/{provider id}/posts    posts (needs the ACo... internal id)
 *  - GET  /api/v1/linkedin/company/{id|slug}   company page
 *  - POST /api/v1/linkedin/search              company name -> id
 * The DSN uses a custom port (e.g. :14914). Networks that block it can reach the same API
 * on 443 with `?port=14914` (documented by Unipile); we switch to that route automatically.
 *
 * Apify (fallback, public data, no cookies, pay per event, works on the free plan):
 * see APIFY_ACTORS. Called with run-sync-get-dataset-items and a cost cap per run.
 *
 * None of the exported functions throw: failures come back in `error`.
 * Keys only travel in headers, so they never appear in a URL, a log line or an error.
 */

export interface LinkedInExperience {
  title: string | null;
  company: string | null;
  companyLinkedinUrl: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
}

export interface LinkedInEducation {
  school: string | null;
  degree: string | null;
  field: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface LinkedInProfile {
  url: string;
  publicId: string | null;
  /** Provider-internal id (Unipile provider_id / urn). Needed for posts on Unipile. */
  providerId: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  about: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  currentCompanyLinkedinUrl: string | null;
  currentCompanyDomain: string | null;
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
  skills: string[];
  websites: string[];
  followers: number | null;
  connections: number | null;
  via: "unipile" | "apify";
}

export interface LinkedInPost {
  url: string | null;
  text: string;
  postedAt: string | null;
  reactions: number | null;
  comments: number | null;
  isRepost: boolean;
}

export interface LinkedInCompany {
  name: string | null;
  linkedinUrl: string | null;
  website: string | null;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  employeeRange: string | null;
  headquarters: string | null;
  description: string | null;
  specialties: string[];
  foundedYear: number | null;
  via: "unipile" | "apify";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Previews of every section, plus the full work history and About. Each full section is an
 * extra LinkedIn request on the connected account and LinkedIn throttles heavy use, so keep
 * this list short. Sent as repeated query keys: Unipile rejects the comma-joined form that
 * its own Node SDK sends (400 invalid_parameters, checked live in Nov 2026).
 */
const UNIPILE_PROFILE_SECTIONS = ["*_preview", "experience", "about"];

/**
 * Apify fallback actors, all by HarvestAPI: public data without cookies or a LinkedIn account,
 * pay per event, ~99.9% successful runs, usable on the free plan. Ids are stable across renames.
 * Free plans may scrape at most 200 profiles in total with the profile actor (its README).
 */
export const APIFY_ACTORS = {
  /** $0.004 per profile. Input: { profileScraperMode, queries: [url] }. */
  profile: { id: "LpVuK3Zozwuipa5bp", name: "harvestapi/linkedin-profile-scraper" },
  /** $0.002 per post. Input: { targetUrls: [url], maxPosts, ... }. */
  posts: { id: "A3cAPGpwBEG8RJwse", name: "harvestapi/linkedin-profile-posts" },
  /** $0.004 per company. Input: { companies: [url] } or { searches: [name] }. */
  company: { id: "UwSdACBp7ymaGUJjS", name: "harvestapi/linkedin-company" },
} as const;
type ApifyActor = (typeof APIFY_ACTORS)[keyof typeof APIFY_ACTORS];

const APIFY_API = "https://api.apify.com/v2";
/** The cheap mode: the email search costs 2.5x and Hunter covers email. */
const APIFY_PROFILE_MODE = "Profile details no email ($4 per 1k)";

const DEFAULT_POST_LIMIT = 10;
const MAX_POST_LIMIT = 50;

/** Optional hook for tests and debugging: receives the raw provider response. */
export interface LinkedInDebug {
  onRaw?: (raw: unknown) => void;
}

type Json = Record<string, unknown>;
type ProfileResult = { profile: LinkedInProfile | null; error?: string };
type PostsResult = { posts: LinkedInPost[]; error?: string };
type CompanyResult = { company: LinkedInCompany | null; error?: string };

/** A failure we already phrased for people (bad input, account state, odd response). */
class LinkedInError extends Error {}

// ---------------------------------------------------------------------------
// Public API (contract)
// ---------------------------------------------------------------------------

/** Full profile for a linkedin.com/in/... URL. Never throws: errors come back in `error`. */
export async function getLinkedInProfile(profileUrl: string): Promise<{ profile: LinkedInProfile | null; error?: string }> {
  try {
    if (!profileIdentifier(profileUrl)) {
      return { profile: null, error: "Not a LinkedIn profile URL (expected linkedin.com/in/...)" };
    }
    return await withFallback<ProfileResult>(
      "profile",
      (r) => r.profile !== null,
      () => getProfileViaUnipile(profileUrl),
      () => getProfileViaApify(profileUrl),
      (error) => ({ profile: null, error }),
    );
  } catch (err) {
    return { profile: null, error: describeError(err, "LinkedIn profile") };
  }
}

/** Recent posts by the person, newest first. Never throws. */
export async function getLinkedInPosts(
  profileUrl: string,
  opts?: { limit?: number; providerId?: string | null },
): Promise<{ posts: LinkedInPost[]; error?: string }> {
  try {
    if (!profileIdentifier(profileUrl) && !str(opts?.providerId)) {
      return { posts: [], error: "Not a LinkedIn profile URL (expected linkedin.com/in/...)" };
    }
    return await withFallback<PostsResult>(
      "posts",
      (r) => !r.error,
      () => getPostsViaUnipile(profileUrl, opts),
      () => getPostsViaApify(profileUrl, opts),
      (error) => ({ posts: [], error }),
    );
  } catch (err) {
    return { posts: [], error: describeError(err, "LinkedIn posts") };
  }
}

/** Company page by linkedin.com/company/... URL or company name. Never throws. */
export async function getLinkedInCompany(companyUrlOrName: string): Promise<{ company: LinkedInCompany | null; error?: string }> {
  try {
    if (!parseCompanyTarget(companyUrlOrName)) {
      return { company: null, error: "Give a linkedin.com/company/... URL or a company name" };
    }
    return await withFallback<CompanyResult>(
      "company",
      (r) => r.company !== null,
      () => getCompanyViaUnipile(companyUrlOrName),
      () => getCompanyViaApify(companyUrlOrName),
      (error) => ({ company: null, error }),
    );
  } catch (err) {
    return { company: null, error: describeError(err, "LinkedIn company") };
  }
}

export function linkedinStatus(): ProviderStatus {
  const unipile = unipileSettings();
  const unipilePartial = !unipile && (hasEnv("UNIPILE_API_KEY") || hasEnv("UNIPILE_DSN"));
  const apify = hasEnv("APIFY_TOKEN");
  const account = optionalEnv("UNIPILE_ACCOUNT_ID")
    ? "the account pinned in UNIPILE_ACCOUNT_ID"
    : "the first connected LinkedIn account";
  let detail: string;
  if (unipile && apify) {
    detail = `Unipile is primary (${account}); Apify actors are the fallback for profiles, posts and company pages.`;
  } else if (unipile) {
    detail = `Unipile is primary (${account}). No fallback: set APIFY_TOKEN to add the Apify actors.`;
  } else if (apify) {
    detail = unipilePartial
      ? "Apify fallback only. Unipile, the primary path, is off: it needs both UNIPILE_API_KEY and a valid UNIPILE_DSN."
      : "Apify fallback only (public data, no cookies). Unipile is the primary path: set UNIPILE_API_KEY and UNIPILE_DSN.";
  } else {
    detail = unipilePartial
      ? "Off. Unipile needs both UNIPILE_API_KEY and a valid UNIPILE_DSN; or set APIFY_TOKEN for the fallback."
      : "Off. Set UNIPILE_API_KEY and UNIPILE_DSN (primary), or APIFY_TOKEN (fallback).";
  }
  return { id: "linkedin", label: "LinkedIn", configured: Boolean(unipile) || apify, detail };
}

/**
 * Unipile first, then Apify on any Unipile failure. Both errors are kept so the caller
 * can see why nothing came back.
 */
async function withFallback<R extends { error?: string }>(
  what: string,
  ok: (r: R) => boolean,
  viaUnipile: () => Promise<R>,
  viaApify: () => Promise<R>,
  fail: (error: string) => R,
): Promise<R> {
  const errors: string[] = [];
  if (unipileSettings()) {
    if (Date.now() < unipileCooldown.until) {
      errors.push(`Unipile skipped after a recent failure (${unipileCooldown.reason})`);
    } else {
      const r = await viaUnipile();
      if (ok(r)) return r;
      errors.push(r.error ?? "Unipile returned nothing");
    }
  }
  if (hasEnv("APIFY_TOKEN")) {
    if (errors.length) console.warn(`[linkedin] ${what}: falling back to Apify. ${errors[0]}`);
    const r = await viaApify();
    if (ok(r)) return r;
    errors.push(r.error ?? "Apify returned nothing");
  }
  if (!errors.length) {
    return fail("LinkedIn is not configured: set UNIPILE_API_KEY and UNIPILE_DSN, or APIFY_TOKEN");
  }
  return fail(errors.join(" | "));
}

// ---------------------------------------------------------------------------
// Unipile
// ---------------------------------------------------------------------------

interface UnipileRoute {
  /** https://host[:port], no trailing slash. */
  base: string;
  /** Set when the custom port travels as ?port= on 443 instead. */
  portParam: string | null;
}
interface UnipileConnection extends UnipileRoute {
  accountId: string;
}

/** Key plus the routes to try, or null when Unipile is not (validly) configured. */
function unipileSettings(): { key: string; routes: UnipileRoute[] } | null {
  const key = optionalEnv("UNIPILE_API_KEY");
  const dsn = optionalEnv("UNIPILE_DSN");
  if (!key || !dsn) return null;
  let s = dsn.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const routes: UnipileRoute[] = [{ base: url.origin, portParam: null }];
  if (url.port && url.port !== "443") routes.push({ base: `https://${url.hostname}`, portParam: url.port });
  return { key, routes };
}

type QueryValue = string | number | boolean | string[] | null | undefined;

function unipileUrl(route: UnipileRoute, path: string, query: Record<string, QueryValue> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    // Arrays as repeated keys (linkedin_sections=a&linkedin_sections=b): the only form Unipile accepts.
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x));
  }
  if (route.portParam) qs.append("port", route.portParam);
  const q = qs.toString();
  return `${route.base}/api/v1${path}${q ? `?${q}` : ""}`;
}

const CONNECTION_TTL_MS = 10 * 60_000;
let connectionPromise: Promise<UnipileConnection> | null = null;
let connectionAt = 0;
/** Which settings the cached connection belongs to (in memory only, never logged). */
let connectionFor = "";

/** Route + account, resolved once and shared by concurrent callers (profile, posts, company). */
function unipileConnection(settings: { key: string; routes: UnipileRoute[] }): Promise<UnipileConnection> {
  const forSettings = `${settings.routes[0]?.base}|${settings.key}|${optionalEnv("UNIPILE_ACCOUNT_ID") ?? ""}`;
  if (connectionPromise && connectionFor === forSettings && Date.now() - connectionAt < CONNECTION_TTL_MS) {
    return connectionPromise;
  }
  connectionFor = forSettings;
  connectionAt = Date.now();
  const p = resolveUnipileConnection(settings);
  connectionPromise = p;
  p.catch(() => {
    if (connectionPromise === p) connectionPromise = null;
  });
  return p;
}

function resetUnipileConnection(): void {
  connectionPromise = null;
}

/**
 * After an outage-type failure the public functions skip Unipile for a while and go straight
 * to Apify: no 12-45 s wait per call while Unipile is down, and no repeated LinkedIn requests
 * on the owner's account while LinkedIn rate-limits it. Per-item errors (404, 422) do not count.
 */
const unipileCooldown = { until: 0, reason: "" };

function noteUnipileFailure(err: unknown): void {
  const status = err instanceof HttpError ? err.status : 0;
  const outage = !(err instanceof HttpError) || status === 401 || status === 429 || status >= 500;
  if (!outage) return;
  unipileCooldown.until = Date.now() + (status === 429 ? 15 * 60_000 : 2 * 60_000);
  unipileCooldown.reason = describeError(err, "Unipile");
}

/**
 * Lists accounts on each route until one answers. The accounts list never touches LinkedIn,
 * so it is a safe reachability probe. Only network failures move on to the next route: an
 * HTTP status means Unipile answered and another route would say the same.
 */
async function resolveUnipileConnection(settings: { key: string; routes: UnipileRoute[] }): Promise<UnipileConnection> {
  let lastError: unknown = new LinkedInError("Unipile has no route to try");
  for (const route of settings.routes) {
    try {
      const list = await fetchJson<unknown>(unipileUrl(route, "/accounts", { limit: 250 }), {
        headers: { "X-API-KEY": settings.key },
        timeoutMs: 12_000,
        retry: false,
      });
      return { ...route, accountId: pickLinkedInAccount(list) };
    } catch (err) {
      if (err instanceof HttpError || err instanceof LinkedInError) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/** UNIPILE_ACCOUNT_ID when set, else the first LinkedIn account whose sources are all OK. */
function pickLinkedInAccount(list: unknown): string {
  const items = arr(obj(list).items).filter(isObj);
  const statuses = (a: Json) => arr(a.sources).filter(isObj).map((s) => String(s.status ?? "UNKNOWN").toUpperCase());
  const isLinkedIn = (a: Json) => String(a.type ?? "").toUpperCase() === "LINKEDIN";
  const pinned = optionalEnv("UNIPILE_ACCOUNT_ID");
  if (pinned) {
    const acc = items.find((a) => a.id === pinned);
    if (!acc) throw new LinkedInError("UNIPILE_ACCOUNT_ID does not match any account in this Unipile workspace");
    if (!isLinkedIn(acc)) throw new LinkedInError("UNIPILE_ACCOUNT_ID is not a LinkedIn account");
    if (!statuses(acc).includes("OK")) {
      throw new LinkedInError(
        `The pinned Unipile LinkedIn account is not running (status ${statuses(acc).join("/") || "unknown"}); reconnect it in the Unipile dashboard`,
      );
    }
    return pinned;
  }
  const linkedin = items.filter(isLinkedIn);
  if (!linkedin.length) throw new LinkedInError("No LinkedIn account is connected in Unipile");
  const allOk = (a: Json) => statuses(a).length > 0 && statuses(a).every((s) => s === "OK");
  const chosen = linkedin.find(allOk) ?? linkedin.find((a) => statuses(a).includes("OK"));
  const id = chosen ? str(chosen.id) : null;
  if (!id) {
    const seen = [...new Set(linkedin.flatMap(statuses))].join("/") || "unknown";
    throw new LinkedInError(`No connected LinkedIn account is running in Unipile (status ${seen}); reconnect it in the Unipile dashboard`);
  }
  return id;
}

async function unipileRequest<T>(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, QueryValue>; body?: unknown; timeoutMs: number },
): Promise<T> {
  const settings = unipileSettings();
  if (!settings) throw new LinkedInError("Unipile is not configured");
  let conn: UnipileConnection;
  try {
    conn = await unipileConnection(settings);
  } catch (err) {
    noteUnipileFailure(err); // unreachable, bad key, or no running LinkedIn account
    throw err;
  }
  try {
    return await fetchJson<T>(unipileUrl(conn, path, { ...opts.query, account_id: conn.accountId }), {
      method,
      headers: { "X-API-KEY": settings.key },
      body: opts.body,
      timeoutMs: opts.timeoutMs,
      // No blind retry: each call is a LinkedIn request on the owner's account, and Apify is the fallback.
      retry: false,
    });
  } catch (err) {
    // The cached route or account may be stale (network change, reconnected account): re-resolve next time.
    if (!(err instanceof HttpError) || err.status === 401 || err.status === 403) resetUnipileConnection();
    noteUnipileFailure(err);
    throw err;
  }
}

/** public id or ACo... id -> provider id, so posts do not need a second profile visit. */
const providerIds = new Map<string, string>();

function rememberProviderId(keys: Array<string | null | undefined>, providerId: string | null): void {
  if (!providerId) return;
  for (const k of keys) if (k) providerIds.set(k.toLowerCase(), providerId);
  while (providerIds.size > 1000) {
    const oldest = providerIds.keys().next().value;
    if (oldest === undefined) break;
    providerIds.delete(oldest);
  }
}

const isProviderId = (s: string) => /^A[CD]o[A-Za-z0-9_-]{8,}$/.test(s);

/** Profile via Unipile only (no fallback). Exported for tests and diagnostics. */
export async function getProfileViaUnipile(profileUrl: string, debug?: LinkedInDebug): Promise<ProfileResult> {
  const ident = profileIdentifier(profileUrl);
  if (!ident) return { profile: null, error: "Not a LinkedIn profile URL (expected linkedin.com/in/...)" };
  try {
    const raw = await unipileRequest<unknown>("GET", `/users/${encodeURIComponent(ident)}`, {
      // notify=false: the person is not told their profile was viewed (also Unipile's default).
      query: { linkedin_sections: UNIPILE_PROFILE_SECTIONS, notify: false },
      timeoutMs: 45_000,
    });
    debug?.onRaw?.(raw);
    const profile = mapUnipileProfile(raw, profileUrl);
    if (!profile) return { profile: null, error: "Unipile returned a profile in an unexpected shape" };
    rememberProviderId([ident, profile.publicId], profile.providerId);
    const throttled = strList(obj(raw).throttled_sections);
    if (throttled.length) console.warn(`[linkedin] Unipile: LinkedIn throttled these profile sections: ${throttled.join(", ")}`);
    return { profile };
  } catch (err) {
    return { profile: null, error: describeError(err, "Unipile profile") };
  }
}

/** Posts via Unipile only (no fallback). Exported for tests and diagnostics. */
export async function getPostsViaUnipile(
  profileUrl: string,
  opts?: { limit?: number; providerId?: string | null },
  debug?: LinkedInDebug,
): Promise<PostsResult> {
  const limit = postLimit(opts?.limit);
  const ident = profileIdentifier(profileUrl);
  try {
    let providerId = str(opts?.providerId) ?? (ident ? (providerIds.get(ident.toLowerCase()) ?? null) : null);
    if (!providerId && ident && isProviderId(ident)) providerId = ident;
    if (!providerId) {
      if (!ident) return { posts: [], error: "Not a LinkedIn profile URL (expected linkedin.com/in/...)" };
      // The posts route only takes the internal id. A profile call without sections is the light way to get it.
      const raw = await unipileRequest<unknown>("GET", `/users/${encodeURIComponent(ident)}`, {
        query: { notify: false },
        timeoutMs: 30_000,
      });
      providerId = str(obj(raw).provider_id);
      if (!providerId) return { posts: [], error: "Unipile could not resolve the profile's internal id" };
      rememberProviderId([ident, str(obj(raw).public_identifier)], providerId);
    }
    const raw = await unipileRequest<unknown>("GET", `/users/${encodeURIComponent(providerId)}/posts`, {
      query: { limit: Math.min(100, limit) },
      timeoutMs: 40_000,
    });
    debug?.onRaw?.(raw);
    if (!Array.isArray(obj(raw).items)) return { posts: [], error: "Unipile returned posts in an unexpected shape" };
    const posts = arr(obj(raw).items)
      .map(mapUnipilePost)
      .filter((p): p is LinkedInPost => p !== null);
    return { posts: newestFirst(posts).slice(0, limit) };
  } catch (err) {
    return { posts: [], error: describeError(err, "Unipile posts") };
  }
}

/** Company via Unipile only (no fallback). Exported for tests and diagnostics. */
export async function getCompanyViaUnipile(companyUrlOrName: string, debug?: LinkedInDebug): Promise<CompanyResult> {
  const target = parseCompanyTarget(companyUrlOrName);
  if (!target) return { company: null, error: "Give a linkedin.com/company/... URL or a company name" };
  try {
    let identifier: string | null = target.kind === "name" ? null : target.value;
    if (target.kind === "name") {
      const found = await unipileRequest<unknown>("POST", "/linkedin/search", {
        query: { limit: 5 },
        body: { api: "classic", category: "companies", keywords: target.value },
        timeoutMs: 30_000,
      });
      const hits = arr(obj(found).items)
        .filter(isObj)
        .filter((i) => String(i.type ?? "COMPANY").toUpperCase() === "COMPANY");
      const best = pickBestByName(hits, target.value, (i) => str(i.name));
      identifier = best ? (str(best.id) ?? parseCompanyTarget(str(best.profile_url) ?? "")?.value ?? null) : null;
      if (!identifier) return { company: null, error: `Unipile found no LinkedIn company named "${clip(target.value, 80)}"` };
    }
    const raw = await unipileRequest<unknown>("GET", `/linkedin/company/${encodeURIComponent(identifier ?? "")}`, {
      timeoutMs: 30_000,
    });
    debug?.onRaw?.(raw);
    const company = mapUnipileCompany(raw);
    if (!company) return { company: null, error: "Unipile returned a company in an unexpected shape" };
    return { company };
  } catch (err) {
    return { company: null, error: describeError(err, "Unipile company") };
  }
}

// ---------------------------------------------------------------------------
// Apify
// ---------------------------------------------------------------------------

/**
 * One synchronous actor run; resolves to the dataset items. The run timeout is passed to
 * Apify so a stuck run stops (and stops billing) on its own; the HTTP timeout is a bit longer
 * so Apify can still answer. Never retried: a retry would start and pay for a second run.
 */
async function runApifyActor(actor: ApifyActor, input: Json, opts: { runTimeoutSecs: number; maxTotalChargeUsd: number }): Promise<unknown[]> {
  const token = optionalEnv("APIFY_TOKEN");
  if (!token) throw new LinkedInError("APIFY_TOKEN is not set");
  const qs = new URLSearchParams({
    timeout: String(opts.runTimeoutSecs),
    maxTotalChargeUsd: opts.maxTotalChargeUsd.toFixed(3),
    clean: "true",
    format: "json",
  });
  const data = await fetchJson<unknown>(`${APIFY_API}/acts/${actor.id}/run-sync-get-dataset-items?${qs}`, {
    method: "POST",
    // The token goes in a header, not in ?token=: HttpError keeps the URL and could be logged.
    headers: { authorization: `Bearer ${token}` },
    body: input,
    timeoutMs: (opts.runTimeoutSecs + 25) * 1000,
    retry: false,
  });
  if (!Array.isArray(data)) throw new LinkedInError(`${actor.name} returned an unexpected response (not a list)`);
  return data;
}

/** Profile via Apify only. Exported for tests and diagnostics. Costs one actor run. */
export async function getProfileViaApify(profileUrl: string, debug?: LinkedInDebug): Promise<ProfileResult> {
  const ident = profileIdentifier(profileUrl);
  if (!ident) return { profile: null, error: "Not a LinkedIn profile URL (expected linkedin.com/in/...)" };
  try {
    const target = apifyProfileUrl(profileUrl, ident);
    const items = await runApifyActor(
      APIFY_ACTORS.profile,
      { profileScraperMode: APIFY_PROFILE_MODE, queries: [target] },
      { runTimeoutSecs: 120, maxTotalChargeUsd: 0.02 },
    );
    debug?.onRaw?.(items);
    const candidates = items.filter(isObj).filter((i) => Boolean(str(i.firstName) || str(i.lastName) || str(i.publicIdentifier)));
    const wanted = ident.toLowerCase();
    const item =
      candidates.find((i) => str(i.publicIdentifier)?.toLowerCase() === wanted || str(i.id) === ident) ?? candidates[0];
    if (!item) {
      return { profile: null, error: apifyItemError(items) ?? "Apify found no public profile at that URL (private, removed or mistyped?)" };
    }
    const profile = mapApifyProfile(item, profileUrl);
    if (!profile) return { profile: null, error: "Apify returned a profile in an unexpected shape" };
    rememberProviderId([ident, profile.publicId], profile.providerId);
    return { profile };
  } catch (err) {
    return { profile: null, error: describeError(err, `Apify ${APIFY_ACTORS.profile.name}`) };
  }
}

/** Posts via Apify only. Exported for tests and diagnostics. Costs one actor run. */
export async function getPostsViaApify(
  profileUrl: string,
  opts?: { limit?: number },
  debug?: LinkedInDebug,
): Promise<PostsResult> {
  const ident = profileIdentifier(profileUrl);
  if (!ident) return { posts: [], error: "Not a LinkedIn profile URL (expected linkedin.com/in/...)" };
  const limit = postLimit(opts?.limit);
  try {
    const target = apifyProfileUrl(profileUrl, ident);
    const items = await runApifyActor(
      APIFY_ACTORS.posts,
      {
        targetUrls: [target],
        maxPosts: limit,
        includeReposts: true,
        includeQuotePosts: true,
        scrapeReactions: false,
        scrapeComments: false,
      },
      // $0.002 per post, plus room for the start and "no result" events.
      { runTimeoutSecs: 120, maxTotalChargeUsd: limit * 0.002 + 0.01 },
    );
    debug?.onRaw?.(items);
    const postItems = items.filter(isObj).filter((i) => !i.type || String(i.type).toLowerCase() === "post");
    if (!postItems.length) {
      // No posts is a normal answer; an error item is not.
      const err = apifyItemError(items);
      return err ? { posts: [], error: err } : { posts: [] };
    }
    const posts = postItems.map((i) => mapApifyPost(i, ident)).filter((p): p is LinkedInPost => p !== null);
    return { posts: newestFirst(posts).slice(0, limit) };
  } catch (err) {
    return { posts: [], error: describeError(err, `Apify ${APIFY_ACTORS.posts.name}`) };
  }
}

/** Company via Apify only (URL, or a name the actor searches for). Exported for tests. Costs one actor run. */
export async function getCompanyViaApify(companyUrlOrName: string, debug?: LinkedInDebug): Promise<CompanyResult> {
  const target = parseCompanyTarget(companyUrlOrName);
  if (!target) return { company: null, error: "Give a linkedin.com/company/... URL or a company name" };
  try {
    const input = target.kind === "name" ? { searches: [target.value] } : { companies: [target.url] };
    const items = await runApifyActor(APIFY_ACTORS.company, input, { runTimeoutSecs: 100, maxTotalChargeUsd: 0.02 });
    debug?.onRaw?.(items);
    const candidates = items.filter(isObj).filter((i) => Boolean(str(i.name) || str(i.linkedinUrl)));
    const item =
      target.kind === "name"
        ? pickBestByName(candidates, target.value, (i) => str(i.name))
        : (candidates.find(
            (i) =>
              str(i.universalName)?.toLowerCase() === target.value.toLowerCase() || str(i.id) === target.value,
          ) ?? candidates[0]);
    if (!item) return { company: null, error: apifyItemError(items) ?? "Apify found no LinkedIn company for that input" };
    const company = mapApifyCompany(item);
    if (!company) return { company: null, error: "Apify returned a company in an unexpected shape" };
    return { company };
  } catch (err) {
    return { company: null, error: describeError(err, `Apify ${APIFY_ACTORS.company.name}`) };
  }
}

/**
 * The profile URL to hand an actor. Member-id URLs (/in/ACoAA...) keep their case, which
 * normaliseLinkedinUrl would lower and so break; vanity URLs are normalised.
 */
function apifyProfileUrl(profileUrl: string, ident: string): string {
  if (isProviderId(ident)) return `https://www.linkedin.com/in/${ident}`;
  return normaliseLinkedinUrl(profileUrl) ?? `https://www.linkedin.com/in/${encodeURIComponent(ident)}`;
}

/** An error message the actor put in a dataset item (e.g. profile not found), if any. */
function apifyItemError(items: unknown[]): string | null {
  for (const it of items) {
    const o = obj(it);
    const msg = str(o.error, 200) ?? str(obj(o.error).message, 200) ?? str(o.errorMessage, 200) ?? str(o.message, 200);
    if (msg) {
      const status = num(o.status);
      return `Apify: ${msg}${status && status >= 400 ? ` (status ${status})` : ""}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mapping (pure, exported for tests). Unknown shapes become null, never a throw.
// ---------------------------------------------------------------------------

export function mapUnipileProfile(raw: unknown, requestedUrl: string): LinkedInProfile | null {
  const o = obj(raw);
  const providerId = str(o.provider_id, 200);
  const publicId = str(o.public_identifier, 200);
  const firstName = str(o.first_name, 200);
  const lastName = str(o.last_name, 200);
  if (!providerId && !publicId && !firstName && !lastName) return null;
  const expRaw = arr(o.work_experience).filter(isObj);
  const experience: LinkedInExperience[] = expRaw.map((e) => ({
    title: str(e.position, 300),
    company: str(e.company, 300),
    companyLinkedinUrl: companyUrl(e.company_url, e.company_id, null),
    location: str(e.location, 200),
    startDate: normaliseLinkedInDate(e.start),
    endDate: normaliseLinkedInDate(e.end),
    description: str(e.description, 4000),
  }));
  const current = currentExperienceIndex(experience, expRaw.map((e) => (typeof e.current === "boolean" ? e.current : null)));
  const education: LinkedInEducation[] = arr(o.education)
    .filter(isObj)
    .map((e) => ({
      school: str(e.school, 300),
      degree: str(e.degree, 300),
      field: str(e.field_of_study, 300),
      startDate: normaliseLinkedInDate(e.start),
      endDate: normaliseLinkedInDate(e.end),
    }));
  return buildProfile({
    requestedUrl,
    publicId,
    providerId,
    firstName,
    lastName,
    headline: str(o.headline, 500),
    location: str(o.location, 200),
    about: str(o.summary, 6000),
    experience,
    current,
    education,
    skills: strList(o.skills, "name"),
    websites: urlList(o.websites, obj(o.creator_website).url),
    followers: num(o.follower_count),
    connections: num(o.connections_count),
    via: "unipile",
  });
}

export function mapApifyProfile(raw: unknown, requestedUrl: string): LinkedInProfile | null {
  const o = obj(raw);
  const firstName = str(o.firstName, 200);
  const lastName = str(o.lastName, 200);
  const publicId = str(o.publicIdentifier, 200);
  if (!firstName && !lastName && !publicId) return null;
  const rawId = str(o.id, 200) ?? str(obj(o.query).profileId, 200);
  const providerId = rawId && isProviderId(rawId) ? rawId : null;
  const loc = o.location;
  const location =
    typeof loc === "string" ? str(loc, 200) : (str(obj(loc).linkedinText, 200) ?? str(obj(obj(loc).parsed).text, 200));
  const expRaw = arr(o.experience).filter(isObj);
  const experience: LinkedInExperience[] = expRaw.map((e) => ({
    title: str(e.position ?? e.title, 300),
    company: str(e.companyName ?? e.company, 300),
    companyLinkedinUrl: companyUrl(e.companyLinkedinUrl ?? e.companyUrl, e.companyId, e.companyUniversalName),
    location: str(e.location, 200),
    startDate: normaliseLinkedInDate(e.startDate),
    endDate: normaliseLinkedInDate(e.endDate),
    description: str(e.description, 4000),
  }));
  // Apify marks current roles with endDate { text: "Present" } and lists them in currentPosition.
  const currentNames = arr(o.currentPosition)
    .map((p) => str(obj(p).companyName)?.toLowerCase())
    .filter((s): s is string => Boolean(s));
  let current = currentExperienceIndex(experience, expRaw.map(() => null));
  if (currentNames.length) {
    const byName = experience.findIndex(
      (e, i) => (e.company ? currentNames.includes(e.company.toLowerCase()) : false) && (e.endDate === null || i === current),
    );
    if (byName >= 0) current = byName;
  }
  const skills = strList(o.skills, "name");
  if (!skills.length) {
    for (const s of String(str(o.topSkills, 1000) ?? "").split(/\s*[•·,|]\s*/)) if (s.trim()) skills.push(s.trim());
  }
  const education: LinkedInEducation[] = arr(o.education)
    .filter(isObj)
    .map((e) => ({
      school: str(e.schoolName ?? e.school, 300),
      degree: str(e.degree, 300),
      field: str(e.fieldOfStudy ?? e.field, 300),
      startDate: normaliseLinkedInDate(e.startDate),
      endDate: normaliseLinkedInDate(e.endDate),
    }));
  return buildProfile({
    requestedUrl,
    publicId,
    providerId,
    firstName,
    lastName,
    headline: str(o.headline, 500),
    location,
    about: str(o.about ?? o.summary, 6000),
    experience,
    current,
    education,
    skills,
    websites: urlList(o.websites, o.website, obj(o.creatorWebsite).url, obj(o.contactInfo).websites),
    followers: num(o.followerCount ?? o.followersCount),
    connections: num(o.connectionsCount ?? o.connections),
    via: "apify",
  });
}

export function mapUnipilePost(raw: unknown): LinkedInPost | null {
  const o = obj(raw);
  const isRepost = o.is_repost === true;
  let text = str(o.text, 6000) ?? "";
  // A share with commentary: keep the shared post too, it is usually what the commentary is about.
  const quoted = obj(o.repost_content);
  const quotedText = str(quoted.text, 3000);
  if (quotedText && quotedText !== text) {
    const by = str(obj(quoted.author).name, 120);
    text = `${text}\n\n[Shared post${by ? ` by ${by}` : ""}] ${quotedText}`.trim();
  }
  if (!text) {
    const article = obj(o.article);
    text = [str(article.title, 300), str(article.excerpt, 1000)].filter(Boolean).join(": ") || (str(o.title, 300) ?? "");
  }
  if (!text) return null;
  // Reposts carry someone else's words: say whose, so nothing gets attributed to the lead.
  const author = str(obj(o.author).name, 120);
  if (isRepost && author) text = `[Reposted from ${author}] ${text}`;
  const socialId = str(o.social_id, 200);
  const url =
    cleanPostUrl(o.share_url) ??
    (socialId?.startsWith("urn:li:") ? `https://www.linkedin.com/feed/update/${socialId}` : null);
  return {
    url,
    text,
    // For a repost, when the lead shared it: that is the activity we care about.
    postedAt: isoDateTime(isRepost ? (o.repost_parsed_datetime ?? o.parsed_datetime) : o.parsed_datetime),
    reactions: num(o.reaction_counter),
    comments: num(o.comment_counter),
    isRepost,
  };
}

export function mapApifyPost(raw: unknown, profileIdent: string | null): LinkedInPost | null {
  const o = obj(raw);
  const author = obj(o.author);
  const authorPublicId = str(author.publicIdentifier, 200);
  const authorId = authorPublicId ? safeDecode(authorPublicId).toLowerCase() : null;
  const authorIsCompany = String(author.type ?? "").toLowerCase() === "company" || Boolean(str(author.universalName));
  const flag = [o.isRepost, o.repost === true ? true : undefined, o.reposted, o.isReshare].find((v) => typeof v === "boolean");
  const marker = Boolean(o.repostedBy || o.repostedAt || isObj(o.reposter) || /reposted/i.test(str(obj(o.header).text) ?? ""));
  const want = profileIdent?.toLowerCase() ?? null;
  const isRepost =
    typeof flag === "boolean"
      ? flag
      : marker || (want !== null && !isProviderId(profileIdent ?? "") && (authorIsCompany || (authorId !== null && authorId !== want)));
  let text = str(o.content ?? o.text, 6000) ?? "";
  const shared = obj(o.repost ?? o.resharedPost ?? o.sharedPost);
  const sharedText = str(shared.content ?? shared.text, 3000);
  if (sharedText && sharedText !== text) {
    const by = str(obj(shared.author).name, 120);
    text = `${text}\n\n[Shared post${by ? ` by ${by}` : ""}] ${sharedText}`.trim();
  }
  if (!text) text = str(obj(o.article).title, 300) ?? str(obj(o.document).title, 300) ?? "";
  if (!text) return null;
  const authorName = str(author.name, 120);
  if (isRepost && authorName) text = `[Reposted from ${authorName}] ${text}`;
  const posted = obj(o.postedAt);
  // For a repost, when the lead shared it (repostedAt), as on Unipile; else when it was posted.
  const reposted = isRepost ? obj(o.repostedAt) : {};
  const repostedAt = isRepost
    ? isoDateTime(reposted.date ?? reposted.timestamp ?? (isObj(o.repostedAt) ? null : o.repostedAt))
    : null;
  const engagement = obj(o.engagement);
  let reactions = num(engagement.likes ?? engagement.reactionsCount ?? o.reactionsCount);
  if (reactions === null && Array.isArray(engagement.reactions)) {
    reactions = engagement.reactions.reduce<number>((sum, r) => sum + (num(obj(r).count) ?? 0), 0);
  }
  return {
    url: cleanPostUrl(o.linkedinUrl ?? o.url) ?? cleanPostUrl(obj(o.socialContent).shareUrl),
    text,
    postedAt: repostedAt ?? isoDateTime(posted.date ?? posted.timestamp ?? (isObj(o.postedAt) ? null : o.postedAt)),
    reactions,
    comments: num(engagement.comments ?? o.commentsCount),
    isRepost,
  };
}

export function mapUnipileCompany(raw: unknown): LinkedInCompany | null {
  const o = obj(raw);
  const name = str(o.name, 300);
  const linkedinUrl = companyUrl(o.profile_url, o.id, o.public_identifier);
  if (!name && !linkedinUrl) return null;
  const website = str(o.website, 500);
  return {
    name,
    linkedinUrl,
    website,
    domain: domainFromWebsite(website),
    industry: labelList(o.industry).join(", ") || null,
    employeeCount: num(o.employee_count) ?? num(obj(obj(o.insights).employeesCount).totalCount),
    employeeRange: rangeText(o.employee_count_range),
    headquarters: headquartersText(o.locations),
    description: str(o.description, 6000) ?? str(o.tagline, 500),
    specialties: labelList(o.specialities ?? o.specialties ?? o.activities),
    foundedYear: yearOf(o.foundation_date ?? o.founded_on),
    via: "unipile",
  };
}

export function mapApifyCompany(raw: unknown): LinkedInCompany | null {
  const o = obj(raw);
  const name = str(o.name, 300);
  const linkedinUrl = companyUrl(o.linkedinUrl ?? o.url, o.id, o.universalName);
  if (!name && !linkedinUrl) return null;
  const website = str(o.website, 500);
  return {
    name,
    linkedinUrl,
    website,
    domain: domainFromWebsite(website),
    industry: labelList(o.industries).join(", ") || labelList([o.industry]).join(", ") || null,
    employeeCount: num(o.employeeCount),
    employeeRange: rangeText(o.employeeCountRange),
    headquarters: headquartersText(o.locations) ?? str(o.headquarter, 200) ?? str(o.headquarters, 200),
    description: str(o.description, 6000) ?? str(o.tagline, 500),
    specialties: labelList(o.specialities ?? o.specialties),
    foundedYear: yearOf(o.foundedOn ?? o.foundedYear),
    via: "apify",
  };
}

function buildProfile(p: {
  requestedUrl: string;
  publicId: string | null;
  providerId: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  about: string | null;
  experience: LinkedInExperience[];
  current: number;
  education: LinkedInEducation[];
  skills: string[];
  websites: string[];
  followers: number | null;
  connections: number | null;
  via: "unipile" | "apify";
}): LinkedInProfile {
  const cur = p.current >= 0 ? p.experience[p.current] : undefined;
  const url =
    (p.publicId ? normaliseLinkedinUrl(`https://www.linkedin.com/in/${p.publicId}`) : null) ??
    normaliseLinkedinUrl(p.requestedUrl) ??
    p.requestedUrl.trim();
  const fullName = [p.firstName, p.lastName].filter(Boolean).join(" ") || null;
  return {
    url,
    publicId: p.publicId,
    providerId: p.providerId,
    fullName,
    firstName: p.firstName,
    lastName: p.lastName,
    headline: p.headline,
    location: p.location,
    about: p.about,
    currentTitle: cur?.title ?? null,
    currentCompany: cur?.company ?? null,
    currentCompanyLinkedinUrl: cur?.companyLinkedinUrl ?? null,
    // Profiles do not carry the employer's website; the company page does (see getLinkedInCompany).
    currentCompanyDomain: null,
    experience: p.experience,
    education: p.education,
    skills: p.skills.slice(0, 100),
    websites: p.websites,
    followers: p.followers,
    connections: p.connections,
    via: p.via,
  };
}

/**
 * The current role: an explicit flag wins, else the first open-ended role (LinkedIn lists
 * current roles first). -1 when nothing looks current.
 */
function currentExperienceIndex(experience: LinkedInExperience[], flags: Array<boolean | null>): number {
  const flagged = flags.findIndex((f) => f === true);
  if (flagged >= 0) return flagged;
  return experience.findIndex((e, i) => flags[i] !== false && e.endDate === null && e.startDate !== null);
}

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function str(v: unknown, max = 20_000): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.replace(/[,\s]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return null;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Distinct non-empty strings from an array of strings or of objects with `key`. */
function strList(v: unknown, key?: string): string[] {
  const out: string[] = [];
  for (const x of arr(v)) {
    const s = str(isObj(x) && key ? x[key] : x, 300);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Distinct labels from strings or label objects. The Apify company actor documents
 * `industries: ["..."]` but sent objects in a live run (Nov 2026), so accept both.
 */
function labelList(v: unknown): string[] {
  const out: string[] = [];
  for (const x of arr(v)) {
    const o = obj(x);
    const s = isObj(x)
      ? str(o.name ?? o.title ?? o.label ?? o.localizedName ?? o.value ?? o.text, 300)
      : str(x, 300);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Distinct http(s) URLs from strings, objects with url/link, or arrays of either. */
function urlList(...values: unknown[]): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(add);
    const s = isObj(v) ? str(v.url ?? v.link ?? v.href, 500) : str(v, 500);
    if (!s) return;
    const u = /^https?:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) ? `https://${s}` : null;
    if (u && !out.includes(u)) out.push(u);
  };
  values.forEach(add);
  return out.slice(0, 20);
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The /in/<id> part of a profile URL (case kept: ACo... ids are case-sensitive), or a bare id. */
function profileIdentifier(input: string): string | null {
  const s = String(input ?? "").trim();
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (m) return safeDecode(m[1]);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,99}$/.test(s) ? s : null;
}

type CompanyTarget = { kind: "slug" | "id"; value: string; url: string } | { kind: "name"; value: string };

function parseCompanyTarget(input: string): CompanyTarget | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const m = s.match(/linkedin\.com\/(company|school|showcase)\/([^/?#\s]+)/i);
  if (m) {
    const value = safeDecode(m[2]);
    return { kind: /^\d+$/.test(value) ? "id" : "slug", value, url: `https://www.linkedin.com/${m[1].toLowerCase()}/${value}` };
  }
  if (/linkedin\.com\//i.test(s) || /^https?:\/\//i.test(s)) return null; // some other URL, not a company page
  const urn = s.match(/^urn:li:(?:fsd_)?(?:company|organization):(\d+)$/i);
  const id = urn ? urn[1] : /^\d+$/.test(s) ? s : null;
  if (id) return { kind: "id", value: id, url: `https://www.linkedin.com/company/${id}` };
  return { kind: "name", value: s.slice(0, 200) };
}

/** Canonical company page URL from a URL, else from a numeric id or slug. */
function companyUrl(url: unknown, id: unknown, slug: unknown): string | null {
  const t = parseCompanyTarget(str(url, 500) ?? "");
  if (t && t.kind !== "name") return t.url;
  const s = str(slug, 200);
  if (s && /^[\w.%-]+$/.test(s)) return `https://www.linkedin.com/company/${s}`;
  const i = str(id, 50);
  return i && /^\d+$/.test(i) ? `https://www.linkedin.com/company/${i}` : null;
}

/** Post permalink without tracking parameters (share URLs carry utm_* and the viewer's member id). */
function cleanPostUrl(v: unknown): string | null {
  const s = str(v, 1000);
  if (!s || !/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

const NOT_A_COMPANY_SITE =
  /(^|\.)(linkedin\.com|lnkd\.in|bit\.ly|linktr\.ee|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|github\.com|medium\.com|substack\.com|notion\.site|google\.com|wixsite\.com)$/i;

/** "https://www.example.com/x" -> "example.com". Null for social and link-shortener sites. */
export function domainFromWebsite(v: unknown): string | null {
  const s = str(v, 500);
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    let host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || /^\d+(\.\d+){3}$/.test(host) || NOT_A_COMPANY_SITE.test(host)) return null;
    host = host.replace(/^www\d?\./, "");
    const labels = host.split(".");
    // jobs.netflix.com -> netflix.com: LinkedIn pages often link a careers subdomain.
    if (labels.length >= 3 && /^(jobs|careers?|about|corporate|corp|home|en|go|get|try|info|hello|join|web)$/.test(labels[0])) {
      host = labels.slice(1).join(".");
    }
    return host;
  } catch {
    return null;
  }
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthOf(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n;
  const s = str(v, 20);
  return s ? (MONTHS[s.slice(0, 3).toLowerCase()] ?? null) : null;
}

function yearMonth(year: number, month: number | null): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  return month && month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}` : String(year);
}

/**
 * Experience and education dates as "YYYY-MM" (or "YYYY"); null when open-ended ("Present")
 * or missing. Unipile sends "9/1/2024" (month/day/year, day always 1); Apify sends
 * { month: "Jan", year: 2024, text: "Jan 2024" }. Unknown formats are kept as text.
 */
export function normaliseLinkedInDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (v >= 1900 && v <= 2100) return String(Math.trunc(v));
    const ms = v > 1e11 ? v : v > 1e8 ? v * 1000 : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 7) : null;
  }
  if (isObj(v)) {
    const year = num(v.year);
    if (year !== null) return yearMonth(year, monthOf(v.month));
    return normaliseLinkedInDate(v.text ?? v.date ?? null);
  }
  const s = str(v, 80);
  if (!s || /^(present|current|now|today)$/i.test(s)) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return yearMonth(Number(m[3]), a > 12 && b <= 12 ? b : a);
  }
  m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?(?:[T ].*)?$/);
  if (m) return yearMonth(Number(m[1]), Number(m[2]));
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) return yearMonth(Number(m[2]), monthOf(m[1]));
  if (/^\d{4}$/.test(s)) return yearMonth(Number(s), null);
  return s;
}

/** Full ISO timestamp from an ISO string or a Unix time (s or ms). Relative text ("2w") -> null. */
function isoDateTime(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 1e8) {
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = str(v, 80);
  if (!s) return null;
  if (/^\d{9,13}$/.test(s)) return isoDateTime(Number(s));
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function yearOf(v: unknown): number | null {
  if (isObj(v)) return yearOf(v.year ?? v.date ?? null);
  const n = num(v);
  if (n !== null) return Number.isInteger(n) && n >= 1800 && n <= 2100 ? n : null;
  const m = String(str(v, 80) ?? "").match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/** { from: 51, to: 200 } -> "51-200"; { start: 10001 } -> "10001+". */
function rangeText(v: unknown): string | null {
  if (typeof v === "string") return str(v, 50);
  const o = obj(v);
  const from = num(o.from ?? o.start ?? o.min);
  const to = num(o.to ?? o.end ?? o.max);
  if (from !== null && to !== null) return `${from}-${to}`;
  if (from !== null) return `${from}+`;
  if (to !== null) return `1-${to}`;
  return null;
}

/** The headquarters (else the first location) as "City, Area, Country". */
function headquartersText(v: unknown): string | null {
  const list = arr(v).filter(isObj);
  const hq = list.find((l) => l.is_headquarter === true || l.headquarter === true || l.isHeadquarter === true) ?? list[0];
  if (!hq) return null;
  const parsed = str(obj(hq.parsed).text, 200);
  if (parsed) return parsed;
  const parts = [str(hq.city, 100), str(hq.area ?? hq.geographicArea, 100), str(hq.country, 100)].filter(Boolean);
  return parts.length ? parts.join(", ") : str(hq.description, 200);
}

function postLimit(v: unknown): number {
  const n = num(v);
  return n === null ? DEFAULT_POST_LIMIT : Math.max(1, Math.min(MAX_POST_LIMIT, Math.trunc(n)));
}

/** Newest first; undated posts keep their provider order after the dated ones. */
function newestFirst(posts: LinkedInPost[]): LinkedInPost[] {
  return posts
    .map((p, i) => ({ p, i, t: p.postedAt ? Date.parse(p.postedAt) : NaN }))
    .sort((a, b) => {
      const at = Number.isNaN(a.t) ? -Infinity : a.t;
      const bt = Number.isNaN(b.t) ? -Infinity : b.t;
      return bt - at || a.i - b.i;
    })
    .map((x) => x.p);
}

const COMPANY_WORDS = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|sas|bv|plc|pbc|the)\b/g;

function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(COMPANY_WORDS, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/** Exact name match first, then prefix, then substring, then the provider's own ranking. */
function pickBestByName<T>(items: T[], name: string, nameOf: (t: T) => string | null): T | null {
  if (!items.length) return null;
  const want = normName(name);
  if (!want) return items[0];
  const score = (t: T): number => {
    const n = normName(nameOf(t) ?? "");
    if (!n) return 0;
    if (n === want) return 3;
    if (n.startsWith(want) || want.startsWith(n)) return 2;
    return n.includes(want) || want.includes(n) ? 1 : 0;
  };
  return items
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)[0].t;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const UNIPILE_HINTS: Record<number, string> = {
  401: "check UNIPILE_API_KEY",
  403: "the LinkedIn account lacks access or needs attention in the Unipile dashboard",
  404: "not found on LinkedIn",
  422: "LinkedIn refused the identifier",
  429: "LinkedIn rate limit on the connected account; space out requests",
  500: "Unipile or LinkedIn had an error",
  503: "the LinkedIn session is not running; check the account in the Unipile dashboard",
  504: "LinkedIn did not answer in time",
};

const APIFY_HINTS: Record<number, string> = {
  401: "check APIFY_TOKEN",
  402: "out of Apify credits or over the plan limit",
  403: "the token may not run this actor; check APIFY_TOKEN",
  404: "actor not found; it may have been renamed or removed",
  408: "the run took longer than Apify's 300 s limit for synchronous runs",
  429: "Apify rate limit; try again shortly",
};

/** One readable line. Never includes keys, tokens or request headers. */
function describeError(err: unknown, label: string): string {
  if (err instanceof LinkedInError) return `${label}: ${err.message}`;
  if (err instanceof HttpError) {
    let body: unknown = null;
    try {
      body = JSON.parse(err.bodySnippet);
    } catch {
      body = null;
    }
    const b = obj(body);
    const e = obj(b.error);
    const type = str(b.type, 80) ?? str(e.type, 80);
    const message = str(b.title, 200) ?? str(b.detail, 200) ?? str(e.message, 200) ?? str(b.message, 200) ?? clip(err.bodySnippet.trim(), 160);
    const hints = label.startsWith("Apify") ? APIFY_HINTS : UNIPILE_HINTS;
    const hint = hints[err.status] ?? (err.status >= 500 ? "server error, try again later" : "");
    return `${label}: HTTP ${err.status}${type ? ` ${type}` : ""}${message ? `: ${clip(message, 200)}` : ""}${hint ? ` (${hint})` : ""}`;
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return `${label}: timed out`;
    if (err instanceof SyntaxError) return `${label}: the response was not valid JSON`;
    const cause = (err as Error & { cause?: unknown }).cause;
    const code = str(obj(cause).code, 60) ?? str(obj(cause).message, 160);
    return `${label}: ${code ? `network error (${code})` : clip(err.message, 200)}`;
  }
  return `${label}: ${clip(String(err), 200)}`;
}
