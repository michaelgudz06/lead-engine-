import "server-only";
import { optionalEnv, type EnvKey } from "../env";
import { fetchJson, HttpError } from "../http";
import { formatCount, formatUsd, plural } from "./format";
import { emptyStats, ledgerStats, type LedgerProviderStats, type LedgerStats } from "./ledger-stats";
import { USAGE_PROVIDERS, type ProviderBalance, type UsageProvider } from "./types";
import { BALANCE_CACHE_MS, BALANCE_MIN_REFRESH_MS } from "./view";

/**
 * Live balances and quotas for the Usage tab: one ProviderBalance per usage provider.
 *
 * Live, from the provider's own API (every one of these calls is free, spends no credits and
 * never touches LinkedIn):
 *   - Hunter      GET  https://api.hunter.io/v2/account                  credits (or searches) left
 *   - OpenRouter  GET  https://openrouter.ai/api/v1/key                  key limit and usage
 *   - Apify       GET  https://api.apify.com/v2/users/me/limits          monthly usage vs the plan limit
 *   - Apollo      POST https://api.apollo.io/api/v1/usage_stats/credit_usage_stats
 *                 (0 credits; needs a master key or one scoped to that endpoint, else 403 ->
 *                 "unavailable" with the reason)
 *   - Unipile     GET  {UNIPILE_DSN}/api/v1/accounts                     the LinkedIn account's status,
 *                 plus LinkedIn requests today from the ledger against Unipile's ~100 a day
 * From the ledger (no balance API this app's keys can read):
 *   - Anthropic   usage and cost reports need an Admin API key
 *   - Exa         the team credits endpoint needs a Team Management service key
 *   - Hugging Face, Abstract, HubSpot: free to call; requests counted
 *
 * Rules: at most one call per provider per refresh, all in parallel with an 8 s timeout and no
 * retry; results cached in this server's memory for 60 s (BALANCE_CACHE_MS), and a forced
 * refresh only goes out when the last checks are 30 s old (BALANCE_MIN_REFRESH_MS, both in
 * view.ts so the tab knows them too), so however many people open or reload the tab, each
 * provider is asked at most twice a minute per server instance; concurrent readers share one
 * round. Never throws; keys travel in headers only and never appear in a summary or a note
 * (failures are described by status code, and every string is scrubbed of key values).
 * Balance checks are not written to the usage ledger: they are free reads of account data,
 * and logging them would turn page views of the tab into provider calls and failures.
 */

const LIVE_TIMEOUT_MS = 8_000;

/** Unipile's guidance for one connected LinkedIn account: about this many requests a day. */
export const LINKEDIN_DAILY_GUIDANCE = 100;

const KEY_NAMES: Partial<Record<UsageProvider, EnvKey>> = {
  hunter: "HUNTER_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  apify: "APIFY_TOKEN",
  apollo: "APOLLO_API_KEY",
  unipile: "UNIPILE_API_KEY",
};

/** Values that must never appear in anything this module returns. */
const SECRET_KEYS: EnvKey[] = [
  "ANTHROPIC_API_KEY",
  "EXA_API_KEY",
  "UNIPILE_API_KEY",
  "APIFY_TOKEN",
  "APOLLO_API_KEY",
  "HUNTER_API_KEY",
  "OPENROUTER_API_KEY",
  "ABSTRACT_API_KEY",
  "HUBSPOT_ACCESS_TOKEN",
  "HF_TOKEN",
  "DATABASE_URL",
  "APP_PASSWORD",
  "SESSION_SECRET",
];

// ------------------------------------------------------------------ public API

export interface BalancesResult {
  balances: ProviderBalance[];
  checkedAt: string;
  cached: boolean;
  /** Until then a forced refresh answers from the cache too. */
  refreshableAt: string;
}

let cache: { at: number; balances: ProviderBalance[] } | null = null;
let inflight: Promise<{ at: number; balances: ProviderBalance[] }> | null = null;

function result(round: { at: number; balances: ProviderBalance[] }, cached: boolean): BalancesResult {
  return {
    balances: round.balances,
    checkedAt: new Date(round.at).toISOString(),
    cached,
    refreshableAt: new Date(round.at + BALANCE_MIN_REFRESH_MS).toISOString(),
  };
}

/**
 * Every provider's balance, in USAGE_PROVIDERS order. Served from memory for 60 s; with
 * `refresh` the cache is bypassed once it is 30 s old. Concurrent callers share one round of
 * calls. Never throws.
 */
export async function getBalances(opts: { refresh?: boolean } = {}): Promise<BalancesResult> {
  if (cache && Date.now() - cache.at < (opts.refresh ? BALANCE_MIN_REFRESH_MS : BALANCE_CACHE_MS)) return result(cache, true);
  if (!inflight) {
    inflight = loadAll()
      .then((balances) => (cache = { at: Date.now(), balances }))
      .finally(() => {
        inflight = null;
      });
  }
  return result(await inflight, false);
}

/** Tests only: forget the cached balances. */
export function resetBalanceCache(): void {
  cache = null;
}

// ------------------------------------------------------------------ loading

type StatsPromise = Promise<LedgerStats | null>;
type Loader = (stats: StatsPromise) => Promise<ProviderBalance>;

const LOADERS: Record<UsageProvider, Loader> = {
  anthropic: async (stats) =>
    ledgerBalance("anthropic", await statsFor(stats, "anthropic"), {
      kind: "cost",
      note: "No live balance: Anthropic's usage and cost reports need an Admin API key. Costs are estimated from token counts and the price table.",
    }),
  exa: async (stats) =>
    ledgerBalance("exa", await statsFor(stats, "exa"), {
      kind: "cost",
      requiredKey: "EXA_API_KEY",
      note: "No live balance: Exa's credits endpoint needs a Team Management service key, which a regular API key is not. Exa reports each call's cost and the ledger keeps it.",
    }),
  unipile: unipileBalance,
  apify: apifyBalance,
  apollo: apolloBalance,
  hunter: hunterBalance,
  openrouter: openrouterBalance,
  huggingface: async (stats) =>
    ledgerBalance("huggingface", await statsFor(stats, "huggingface"), {
      kind: "requests",
      note: optionalEnv("HF_TOKEN")
        ? "Free to call. Requests are counted in the ledger."
        : "Free to call, anonymously (HF_TOKEN would raise the rate limit). Requests are counted in the ledger.",
    }),
  abstract: async (stats) =>
    ledgerBalance("abstract", await statsFor(stats, "abstract"), {
      kind: "requests",
      requiredKey: "ABSTRACT_API_KEY",
      note: "Free to call. Inspect requests are counted in the ledger.",
    }),
  hubspot: async (stats) =>
    ledgerBalance("hubspot", await statsFor(stats, "hubspot"), {
      kind: "requests",
      requiredKey: "HUBSPOT_ACCESS_TOKEN",
      note: "Free to call. CRM requests are counted in the ledger.",
    }),
};

async function loadAll(): Promise<ProviderBalance[]> {
  const stats: StatsPromise = ledgerStats().catch((err: unknown) => {
    console.warn(`[usage] could not read the usage ledger for balances: ${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}`);
    return null;
  });
  return Promise.all(
    USAGE_PROVIDERS.map(async (provider) => {
      let result: ProviderBalance;
      try {
        result = await LOADERS[provider](stats);
      } catch (err) {
        result = unavailable(provider, "Live balance not available", describeFailure(err, KEY_NAMES[provider]));
      }
      return scrub(result);
    }),
  );
}

async function statsFor(stats: StatsPromise, provider: UsageProvider): Promise<LedgerProviderStats | null> {
  const all = await stats;
  return all ? (all.get(provider) ?? emptyStats(provider)) : null;
}

function getJson(url: string, init: { method?: "GET" | "POST"; headers: Record<string, string> }): Promise<unknown> {
  return fetchJson<unknown>(url, { method: init.method ?? "GET", headers: init.headers, timeoutMs: LIVE_TIMEOUT_MS, retry: false });
}

// ------------------------------------------------------------------ Hunter

async function hunterBalance(): Promise<ProviderBalance> {
  const key = optionalEnv("HUNTER_API_KEY");
  if (!key) return notConfigured("hunter", "HUNTER_API_KEY is not set.");
  return hunterBalanceFrom(await getJson("https://api.hunter.io/v2/account", { headers: { "X-API-KEY": key } }));
}

/**
 * Hunter's /v2/account (free): data.requests.credits when the team has one credits pool,
 * else data.requests.searches (Email Finder spends searches). `remaining` matches the
 * dashboard; `available` includes credit packs and does not shrink as credits are used.
 */
export function hunterBalanceFrom(body: unknown): ProviderBalance {
  const data = rec(rec(body).data);
  const requests = rec(data.requests);
  const credits = quota(requests.credits);
  const pool = credits ?? quota(requests.searches);
  if (!pool) throw new ShapeError();
  const unit = credits ? "credits" : "searches";
  const plan = safeLabel(data.plan_name);
  const resets = dayLabel(data.reset_date);
  const notes = [plan ? `${plan} plan` : null, resets ? `resets ${resets}` : null].filter(Boolean).join(", ");
  return {
    provider: "hunter",
    source: "live",
    summary: `${formatCount(pool.remaining)} of ${formatCount(pool.available)} ${unit} left`,
    usedShare: pool.available > 0 ? clamp01(1 - pool.remaining / pool.available) : null,
    numbers: { used: pool.used, available: pool.available, remaining: pool.remaining },
    note: `${notes ? `${capitalise(notes)}. ` : ""}Hunter spends 1 credit when the Email Finder finds an address, and up to 1.5 when it builds one from the company's pattern (Domain Search and the verifier).`,
    checkedAt: nowIso(),
  };
}

function quota(v: unknown): { used: number; available: number; remaining: number } | null {
  const b = rec(v);
  const used = num(b.used);
  const available = num(b.available);
  if (used === null || available === null) return null;
  return { used, available, remaining: num(b.remaining) ?? Math.max(0, available - used) };
}

// ------------------------------------------------------------------ OpenRouter

async function openrouterBalance(): Promise<ProviderBalance> {
  const key = optionalEnv("OPENROUTER_API_KEY");
  if (!key) return notConfigured("openrouter", "OPENROUTER_API_KEY is not set.");
  return openrouterBalanceFrom(await getJson("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } }));
}

/**
 * OpenRouter's /api/v1/key: the key's spending limit (null when it has none), what is left,
 * and its usage in USD in total and for the current UTC day, week and month. The key's label
 * (a masked key) is never read.
 */
export function openrouterBalanceFrom(body: unknown): ProviderBalance {
  const d = rec(rec(body).data);
  const limit = num(d.limit);
  const remaining = num(d.limit_remaining);
  const usage = num(d.usage);
  const daily = num(d.usage_daily);
  const weekly = num(d.usage_weekly);
  const monthly = num(d.usage_monthly);
  if (limit === null && usage === null && monthly === null) throw new ShapeError();

  const numbers = pick({ limit, limitRemaining: remaining, usage, usageDaily: daily, usageWeekly: weekly, usageMonthly: monthly });
  let summary: string;
  let usedShare: number | null = null;
  const extra: string[] = [];
  if (limit !== null && limit > 0) {
    const left = remaining ?? Math.max(0, limit - (usage ?? 0));
    summary = `${formatUsd(left)} of ${formatUsd(limit)} key limit left`;
    usedShare = clamp01(1 - left / limit);
    const reset = safeLabel(d.limit_reset);
    if (reset) extra.push(`The limit resets ${reset.toLowerCase()}.`);
  } else {
    // No key limit: a workspace or member budget may still apply.
    const budget = rec(d.effective_budget);
    const budgetLimit = num(budget.limit_usd);
    const budgetLeft = num(budget.remaining_usd);
    if (budgetLimit !== null && budgetLimit > 0 && budgetLeft !== null) {
      summary = `${formatUsd(budgetLeft)} of ${formatUsd(budgetLimit)} budget left`;
      usedShare = clamp01(1 - budgetLeft / budgetLimit);
      Object.assign(numbers, { budgetLimit, budgetRemaining: budgetLeft });
    } else {
      summary = monthly !== null ? `No limit on this key · ${formatUsd(monthly)} this month` : "No limit on this key";
    }
  }
  const usageParts = [
    daily !== null ? `${formatUsd(daily)} today` : null,
    weekly !== null ? `${formatUsd(weekly)} this week` : null,
    monthly !== null ? `${formatUsd(monthly)} this month` : null,
    usage !== null ? `${formatUsd(usage)} in total` : null,
  ].filter(Boolean);
  const notes = [usageParts.length ? `Key usage: ${usageParts.join(", ")} (UTC).` : null, ...extra, d.is_free_tier === true ? "Free tier key." : null];
  return { provider: "openrouter", source: "live", summary, usedShare, numbers, note: notes.filter(Boolean).join(" ") || null, checkedAt: nowIso() };
}

// ------------------------------------------------------------------ Apify

async function apifyBalance(): Promise<ProviderBalance> {
  const token = optionalEnv("APIFY_TOKEN");
  if (!token) return notConfigured("apify", "APIFY_TOKEN is not set.");
  return apifyBalanceFrom(await getJson("https://api.apify.com/v2/users/me/limits", { headers: { authorization: `Bearer ${token}` } }));
}

/** Apify's /v2/users/me/limits: usage this billing cycle in USD against the plan's monthly limit. */
export function apifyBalanceFrom(body: unknown): ProviderBalance {
  const d = rec(rec(body).data);
  const used = num(rec(d.current).monthlyUsageUsd);
  const limit = num(rec(d.limits).maxMonthlyUsageUsd);
  if (used === null) throw new ShapeError();
  const ends = dayLabel(rec(d.monthlyUsageCycle).endAt);
  return {
    provider: "apify",
    source: "live",
    summary: limit !== null && limit > 0 ? `${formatUsd(used)} of ${formatUsd(limit)} used this cycle` : `${formatUsd(used)} used this cycle`,
    usedShare: limit !== null && limit > 0 ? clamp01(used / limit) : null,
    numbers: pick({ monthlyUsageUsd: used, maxMonthlyUsageUsd: limit }),
    note: `${ends ? `The cycle ends ${ends}. ` : ""}Usage covers every actor run on the account, not only this app's.`,
    checkedAt: nowIso(),
  };
}

// ------------------------------------------------------------------ Apollo

async function apolloBalance(stats: StatsPromise): Promise<ProviderBalance> {
  const key = optionalEnv("APOLLO_API_KEY");
  if (!key) return notConfigured("apollo", "APOLLO_API_KEY is not set.");
  try {
    const body = await getJson("https://api.apollo.io/api/v1/usage_stats/credit_usage_stats", {
      method: "POST",
      headers: { "x-api-key": key, "cache-control": "no-cache" },
    });
    return apolloBalanceFrom(body);
  } catch (err) {
    if (!(err instanceof HttpError) || (err.status !== 403 && err.status !== 401)) throw err;
    const s = await statsFor(stats, "apollo");
    const ledger = s ? ` The ledger counts ${plural(s.monthUnits.credits ?? 0, "credit")} used by this app this month.` : "";
    const why =
      err.status === 403
        ? "Apollo only shows credit usage to a master API key, or to a key scoped to usage_stats/credit_usage_stats; this key is neither (403)."
        : "Apollo refused the key (401). Check APOLLO_API_KEY.";
    return {
      provider: "apollo",
      source: "unavailable",
      summary: "Live balance not available for this key",
      usedShare: null,
      numbers: s ? { ledgerCreditsThisMonth: s.monthUnits.credits ?? 0 } : {},
      note: `${why}${ledger}`,
      checkedAt: nowIso(),
    };
  }
}

/**
 * Apollo's credit usage stats: lead_credit is the main pool (company enrichment and each page
 * of job postings use one credit; on unified plans every credit type draws on it).
 */
export function apolloBalanceFrom(body: unknown): ProviderBalance {
  const lead = rec(rec(rec(body).credit_usage_stats).lead_credit);
  const limit = num(lead.limit);
  const consumed = num(lead.consumed);
  const leftOver = num(lead.left_over);
  if (limit === null && leftOver === null) throw new ShapeError();
  const left = leftOver ?? Math.max(0, (limit ?? 0) - (consumed ?? 0));
  const ends = dayLabel(rec(rec(body).current_credit_cycle).end_date);
  return {
    provider: "apollo",
    source: "live",
    summary: limit !== null && limit > 0 ? `${formatCount(left)} of ${formatCount(limit)} credits left` : `${formatCount(left)} credits left`,
    usedShare: limit !== null && limit > 0 ? clamp01(1 - left / limit) : null,
    numbers: pick({ limit, consumed, leftOver: left }),
    note: `Lead credits, Apollo's main pool: company enrichment and each page of job postings use one.${ends ? ` The cycle ends ${ends}.` : ""}`,
    checkedAt: nowIso(),
  };
}

// ------------------------------------------------------------------ Unipile

export interface UnipileRoute {
  /** https://host[:port], no trailing slash. */
  base: string;
  /** Set when the DSN's custom port travels as ?port= on 443 instead (Unipile documents this route). */
  portParam: string | null;
}

/** The DSN as given, then the same host on 443 with ?port=, as src/lib/providers/linkedin.ts does. */
export function unipileRoutes(dsn: string | undefined): UnipileRoute[] {
  if (!dsn) return [];
  let s = dsn.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return [];
  }
  if (!url.hostname) return [];
  const routes: UnipileRoute[] = [{ base: url.origin, portParam: null }];
  if (url.port && url.port !== "443") routes.push({ base: `https://${url.hostname}`, portParam: url.port });
  return routes;
}

/** The route that answered last time, tried first next time. */
let unipileRouteIndex = 0;

async function unipileAccounts(key: string, routes: UnipileRoute[]): Promise<unknown> {
  let lastError: unknown = new Error("no route");
  const start = Math.min(unipileRouteIndex, routes.length - 1);
  const order = [...routes.slice(start), ...routes.slice(0, start)];
  for (const route of order) {
    const qs = new URLSearchParams({ limit: "100" });
    if (route.portParam) qs.append("port", route.portParam);
    try {
      const body = await getJson(`${route.base}/api/v1/accounts?${qs}`, { headers: { "X-API-KEY": key } });
      unipileRouteIndex = routes.indexOf(route);
      return body;
    } catch (err) {
      // An HTTP status means Unipile answered; another route would say the same.
      if (err instanceof HttpError) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

async function unipileBalance(stats: StatsPromise): Promise<ProviderBalance> {
  const key = optionalEnv("UNIPILE_API_KEY");
  const routes = unipileRoutes(optionalEnv("UNIPILE_DSN"));
  if (!key || !routes.length) return notConfigured("unipile", "Set UNIPILE_API_KEY and a valid UNIPILE_DSN.");
  const s = await statsFor(stats, "unipile");
  let accounts: unknown = null;
  let failure: string | null = null;
  try {
    accounts = await unipileAccounts(key, routes);
  } catch (err) {
    failure = describeFailure(err, "UNIPILE_API_KEY");
  }
  return unipileBalanceFrom(accounts, s?.linkedinRequestsToday ?? null, failure);
}

/**
 * The connected LinkedIn account's status from Unipile's accounts list (UNIPILE_ACCOUNT_ID when
 * pinned, else the first LinkedIn account, as linkedin.ts picks it), plus today's LinkedIn
 * requests from the ledger against Unipile's guidance of roughly 100 a day.
 */
export function unipileBalanceFrom(accounts: unknown, requestsToday: number | null, failure: string | null): ProviderBalance {
  const guidance = LINKEDIN_DAILY_GUIDANCE;
  const summary = requestsToday === null ? "LinkedIn requests today unknown" : `${formatCount(requestsToday)} of ~${guidance} LinkedIn requests today`;
  const usedShare = requestsToday === null ? null : clamp01(requestsToday / guidance);
  const numbers: Record<string, number> = requestsToday === null ? { dailyGuidance: guidance } : { linkedinRequestsToday: requestsToday, dailyGuidance: guidance };
  const pace = `Unipile is a flat monthly fee; LinkedIn watches the connected account, so stay near ${guidance} profile and post requests a day.`;

  if (failure !== null || accounts === null) {
    return {
      provider: "unipile",
      source: requestsToday === null ? "unavailable" : "ledger",
      summary,
      usedShare,
      numbers,
      note: `Could not check the account: ${failure ?? "no answer"} ${pace}`,
      checkedAt: nowIso(),
    };
  }

  const items = arr(rec(accounts).items).map(rec);
  const linkedin = items.filter((a) => String(a.type ?? "").toUpperCase() === "LINKEDIN");
  const statuses = (a: Record<string, unknown>) => arr(a.sources).map((x) => safeStatus(rec(x).status));
  const running = linkedin.filter((a) => statuses(a).length > 0 && statuses(a).every((st) => st === "OK"));
  const pinned = optionalEnv("UNIPILE_ACCOUNT_ID");
  const chosen = pinned ? linkedin.find((a) => a.id === pinned) : (running[0] ?? linkedin[0]);
  numbers.linkedinAccounts = linkedin.length;
  numbers.runningAccounts = running.length;

  let state: string;
  if (!linkedin.length) state = "No LinkedIn account is connected in Unipile.";
  else if (pinned && !chosen) state = "UNIPILE_ACCOUNT_ID does not match a LinkedIn account in this Unipile workspace.";
  else {
    const st = chosen ? statuses(chosen) : [];
    const ok = st.length > 0 && st.every((x) => x === "OK");
    state = ok
      ? `The LinkedIn account is connected and running.`
      : `The LinkedIn account needs attention in the Unipile dashboard (status ${[...new Set(st)].join("/") || "unknown"}).`;
  }
  return { provider: "unipile", source: "live", summary, usedShare, numbers, note: `${state} ${pace}`, checkedAt: nowIso() };
}

// ------------------------------------------------------------------ ledger-only providers

function ledgerBalance(
  provider: UsageProvider,
  s: LedgerProviderStats | null,
  opts: { kind: "cost" | "requests"; note: string; requiredKey?: EnvKey },
): ProviderBalance {
  if (opts.requiredKey && !optionalEnv(opts.requiredKey)) return notConfigured(provider, `${opts.requiredKey} is not set.`);
  if (!s) return unavailable(provider, "No balance to show", "Could not read the usage ledger.");
  if (opts.kind === "cost") {
    return {
      provider,
      source: "ledger",
      summary: `${formatUsd(s.monthUsd)}${s.monthEstimated ? " (est.)" : ""} this month · ${plural(s.todayCalls, "call")} today`,
      usedShare: null,
      numbers: { monthUsd: s.monthUsd, monthCalls: s.monthCalls, todayUsd: s.todayUsd, todayCalls: s.todayCalls },
      note: opts.note,
      checkedAt: nowIso(),
    };
  }
  return {
    provider,
    source: "ledger",
    summary: `${plural(s.monthCalls, "request")} this month · ${formatCount(s.todayCalls)} today`,
    usedShare: null,
    numbers: { monthCalls: s.monthCalls, todayCalls: s.todayCalls },
    note: opts.note,
    checkedAt: nowIso(),
  };
}

// ------------------------------------------------------------------ helpers

class ShapeError extends Error {
  constructor() {
    super("unexpected answer");
  }
}

function notConfigured(provider: UsageProvider, note: string): ProviderBalance {
  return unavailable(provider, "Not configured", note);
}

function unavailable(provider: UsageProvider, summary: string, note: string): ProviderBalance {
  return { provider, source: "unavailable", summary, usedShare: null, numbers: {}, note, checkedAt: nowIso() };
}

/** One readable sentence. Status codes and error kinds only: never a URL, header, body or key. */
export function describeFailure(err: unknown, keyName?: EnvKey): string {
  if (err instanceof HttpError) {
    const s = err.status;
    if (s === 401) return `The key was refused (401).${keyName ? ` Check ${keyName}.` : ""}`;
    if (s === 403) return "This key may not read its balance (403).";
    if (s === 404) return "The balance endpoint was not found (404).";
    if (s === 429) return "Rate-limited (429). Try again in a minute.";
    if (s >= 500) return `The provider had a server error (${s}).`;
    return `The provider answered ${s}.`;
  }
  if (err instanceof ShapeError) return "The provider answered in a shape this app does not know.";
  if (err instanceof SyntaxError) return "The provider sent an unreadable answer.";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return `No answer within ${LIVE_TIMEOUT_MS / 1000} s.`;
  return "Could not reach the provider.";
}

/** Belt and braces: no configured key or password may leave this module, whatever a provider echoed. */
function scrub(b: ProviderBalance): ProviderBalance {
  const secrets = SECRET_KEYS.map((k) => optionalEnv(k)).filter((v): v is string => typeof v === "string" && v.length >= 8);
  const clean = (text: string | null): string | null => {
    if (text === null) return null;
    let out = text;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("[hidden]");
    return out;
  };
  return { ...b, summary: clean(b.summary) ?? "", note: clean(b.note) };
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function pick(values: Record<string, number | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** A plan name or reset word as the provider sent it, if it looks like one ("Free", "monthly"). */
function safeLabel(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/.test(v.trim()) ? v.trim() : null;
}

function safeStatus(v: unknown): string {
  const s = String(v ?? "").toUpperCase();
  return /^[A-Z_]{2,30}$/.test(s) ? s : "UNKNOWN";
}

/** "2026-12-01" or an ISO timestamp -> "Dec 1" (UTC); null when not a date. */
function dayLabel(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T00:00:00Z` : v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function nowIso(): string {
  return new Date().toISOString();
}
