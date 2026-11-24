import "server-only";
import { hasEnv, optionalEnv } from "../env";
import { fetchJson, HttpError } from "../http";
import { metered } from "../usage/ledger";
import { creditCost, HUNTER_CREDITS_PER_FOUND_EMAIL, HUNTER_PLAN } from "../usage/prices";
import type { ProviderStatus } from "../types";
import { companyDomain } from "./apollo";

/**
 * Hunter: a work email from a LinkedIn handle, or from name + company domain, with a fallback
 * built from the company's email pattern. Free plan: 50 credits a month.
 * CONTRACT: signatures fixed; owned by the apollo-hunter agent.
 *
 * Docs: https://hunter.io/api-documentation/v2. The key goes in the X-API-KEY header, never in
 * the URL. Requests are never retried here, to keep the credit budget exact.
 *
 * 1. Email Finder (1 credit, only when it finds an address). One request carries everything we
 *    know: `linkedin_handle` plus the name and the company domain (or name). Hunter tries the
 *    handle and, when it does not know it, the name. It answers with no address when the person
 *    is not in its index, which is common at small companies whose mail server accepts every
 *    address (nothing to verify against).
 * 2. Fallback, when the finder found nothing and the domain and a usable name are known:
 *    Domain Search (`limit=1`, 1 credit when Hunter knows the domain) gives the domain's
 *    pattern ("{first}", "{f}{last}", "{first}.{last}" ...) and whether it accepts every address.
 *    The address is built from the name. On a domain that accepts every address it cannot be
 *    verified, so it is kept as a guess (confidence 50). Otherwise the Email Verifier (0.5
 *    credit) checks it, and it is kept only when deliverable ("valid"), with the verifier's score.
 * A person who asked Hunter not to process their data (451) gets no fallback either. Each call
 * is one usage-ledger row with the credits Hunter reports in X-Credits-Used (or the documented
 * price when it does not).
 */

/** How an address was found. Stored as le_leads.email_status. */
export type FoundEmailStatus = "found" | "verified" | "guess";

export interface EmailResult {
  email: string | null;
  /** Hunter's confidence, 0 to 100 (the verifier's score for a verified pattern address, 50 for a guess). */
  score: number | null;
  /** Hunter's verification status ("valid", "accept_all", "unknown"), or "claimed" after a 451. */
  status: string | null;
  /** Public pages where Hunter saw the address (at most 10). */
  sources: string[];
  error?: string;
  /** found: the Email Finder. verified: built from the pattern and verified. guess: built from the pattern on a domain that accepts every address. */
  emailStatus?: FoundEmailStatus | null;
  /** The domain's pattern, when the address was built from it, e.g. "{first}.{last}". */
  pattern?: string | null;
  /** The domain accepts every address (so nothing on it can be verified). */
  acceptAll?: boolean | null;
  /** Why no address came back, in one line for the team, when there was no error. */
  reason?: string | null;
  /** Requests sent to Hunter for this lookup. */
  requests?: number;
  /** Credits those requests used (as Hunter reported them, else the documented price). */
  credits?: number;
}

const API = "https://api.hunter.io/v2";
const ENDPOINT = `${API}/email-finder`;
/** Hunter searches for up to max_duration seconds (3-20, default 10); the timeout leaves headroom. */
const MAX_DURATION_S = 10;
const TIMEOUT_MS = 25_000;
const DOMAIN_SEARCH_TIMEOUT_MS = 15_000;
/** Hunter's verifier works up to 20 s before it answers 202 ("still in progress"). */
const VERIFY_TIMEOUT_MS = 25_000;
/** How long the whole lookup (finder, pattern and verification) may take unless the caller says. */
const DEFAULT_BUDGET_MS = 50_000;
const NOT_CONFIGURED = "Hunter is not configured (HUNTER_API_KEY is not set)";

/** Domain Search: 1 credit when it returns addresses (1 to 10 of them), none when Hunter knows nothing; a repeat in the same month is free. */
export const HUNTER_CREDITS_PER_DOMAIN_SEARCH = 1;
/** Email Verifier: half a credit, none for an "unknown" or disposable result. */
export const HUNTER_CREDITS_PER_VERIFICATION = 0.5;
/** The confidence stored with a guess built on a domain that accepts every address. */
export const GUESS_CONFIDENCE = 50;

/** After a rejected key (401) or exhausted credits (429), stop calling for a while. */
let pausedUntil = 0;
let pausedReason = "";

export async function findEmail(input: {
  linkedinUrl?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  domain?: string | null;
  company?: string | null;
  /** Build an address from the company's email pattern when the finder has none. Default true. */
  fallback?: boolean;
  /** The most time the whole lookup may take, in ms (default 50 s). Steps that do not fit are skipped. */
  budgetMs?: number;
}): Promise<EmailResult> {
  const none: EmailResult = { email: null, score: null, status: null, sources: [] };
  const spent = { requests: 0, credits: 0 };
  try {
    const key = optionalEnv("HUNTER_API_KEY");
    if (!key) return { ...none, error: NOT_CONFIGURED, ...spent };
    if (Date.now() < pausedUntil) return { ...none, error: pausedReason, ...spent };

    const handle = linkedinHandle(input?.linkedinUrl);
    const domain = companyDomain(input?.domain);
    const company = domain ? null : companyName(input?.company);
    const name = personName(input ?? {});
    if (!handle && !(name && (domain || company))) {
      return { ...none, error: "Hunter needs a LinkedIn URL, or a full name plus a company domain or name", ...spent };
    }
    const endsAt = Date.now() + Math.max(5_000, Number(input?.budgetMs) || DEFAULT_BUDGET_MS);
    const left = () => endsAt - Date.now();

    const params = new URLSearchParams();
    if (handle) params.set("linkedin_handle", handle);
    if (domain) params.set("domain", domain);
    else if (company) params.set("company", company);
    if (name?.first && name.last) {
      params.set("first_name", name.first);
      params.set("last_name", name.last);
    } else if (name?.full) {
      params.set("full_name", name.full);
    }
    params.set("max_duration", String(MAX_DURATION_S));

    // Usage ledger: every lookup is counted; a credit is used only when an address came back.
    const used = (credits: number) => ({ units: { lookups: 1, credits }, ...creditCost(credits, HUNTER_PLAN) });
    spent.requests++;
    let body: unknown = null;
    try {
      body = await metered(
        {
          provider: "hunter",
          operation: "email-finder",
          onOk: (answer) => used(mapResult(answer).email ? HUNTER_CREDITS_PER_FOUND_EMAIL : 0),
          onFail: () => used(0),
        },
        () =>
          fetchJson<unknown>(`${ENDPOINT}?${params.toString()}`, {
            headers: { "X-API-KEY": key },
            timeoutMs: Math.max(3_000, Math.min(TIMEOUT_MS, left())),
            retry: false,
          }),
      );
    } catch (err) {
      // 404: Hunter does not know the LinkedIn handle (and had no name to try). Not an error:
      // there is simply no address, and the pattern may still give one.
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
    const found = mapResult(body);
    if (found.email) {
      spent.credits += HUNTER_CREDITS_PER_FOUND_EMAIL;
      return { ...found, emailStatus: "found", ...spent };
    }
    const nothing = "Hunter's Email Finder has no address for them.";
    if (input?.fallback === false) return { ...none, reason: nothing, ...spent };
    if (!domain) return { ...none, reason: `${nothing} No company website is known, so an address could not be built from the company's email pattern.`, ...spent };
    const parts = patternName(input ?? {});
    if (!parts.first) {
      return { ...none, reason: `${nothing} Their first name is not known, so an address could not be built from the company's email pattern.`, ...spent };
    }
    return await fromPattern({ key, domain, parts, left, spent, none });
  } catch (err) {
    return { ...describeError(err, none), ...spent };
  }
}

/**
 * The fallback: the domain's pattern from Domain Search, the address built from it, and a check
 * with the Email Verifier unless the domain accepts every address. Throws HTTP errors to the
 * caller, which turns them into one line.
 */
async function fromPattern(ctx: {
  key: string;
  domain: string;
  parts: { first: string | null; last: string | null };
  left: () => number;
  spent: { requests: number; credits: number };
  none: EmailResult;
}): Promise<EmailResult> {
  const { key, domain, parts, left, spent, none } = ctx;
  const done = (fields: Partial<EmailResult>): EmailResult => ({ ...none, ...fields, ...spent });
  if (left() < 4_000) return done({ reason: "Hunter's Email Finder has no address for them, and there was no time left to try the company's email pattern." });

  spent.requests++;
  const search = await metered(
    {
      provider: "hunter",
      operation: "domain-search",
      onOk: (answer: HunterAnswer) => hunterUnits(answer.credits ?? (domainHasEmails(answer.body) ? HUNTER_CREDITS_PER_DOMAIN_SEARCH : 0)),
      onFail: () => hunterUnits(0),
    },
    () => hunterGet(key, "/domain-search", { domain, limit: "1" }, Math.min(DOMAIN_SEARCH_TIMEOUT_MS, left())),
  );
  spent.credits += search.credits ?? (domainHasEmails(search.body) ? HUNTER_CREDITS_PER_DOMAIN_SEARCH : 0);
  const info = domainInfo(search.body);
  if (info.webmail || info.disposable) return done({ reason: `${domain} is a free or disposable mail provider, not a company domain.` });
  if (!info.pattern) return done({ reason: `Hunter's Email Finder has no address for them, and Hunter does not know the email pattern at ${domain}.` });
  const built = emailFromPattern(info.pattern, parts, domain);
  if ("error" in built) return done({ reason: built.error, pattern: info.pattern, acceptAll: info.acceptAll });

  if (info.acceptAll) {
    // Every address is accepted, so a check would say nothing: keep it as a guess.
    return done({ email: built.email, score: GUESS_CONFIDENCE, status: "accept_all", emailStatus: "guess", pattern: info.pattern, acceptAll: true });
  }
  if (left() < 6_000) {
    return done({ reason: `Built ${built.email} from the pattern ${info.pattern}, but there was no time left to verify it, so it was not kept.`, pattern: info.pattern, acceptAll: false });
  }
  const check = await verifyEmail(key, built.email, left, spent);
  if (check.status === "valid") {
    return done({ email: built.email, score: check.score, status: "valid", emailStatus: "verified", pattern: info.pattern, acceptAll: false });
  }
  if (check.status === "accept_all") {
    // The mail server accepts every address after all: the same guess as above.
    return done({ email: built.email, score: GUESS_CONFIDENCE, status: "accept_all", emailStatus: "guess", pattern: info.pattern, acceptAll: true });
  }
  return done({
    reason: `Built ${built.email} from the pattern ${info.pattern}, but Hunter's check says it ${VERIFY_WORDS[check.status] ?? "could not be verified"}, so it was not kept.`,
    status: check.status,
    pattern: info.pattern,
    acceptAll: false,
  });
}

const VERIFY_WORDS: Record<string, string> = {
  invalid: "does not exist",
  unknown: "could not be verified",
  webmail: "is a free mail address",
  disposable: "is a disposable address",
};

/** Email Verifier, polling up to twice more while Hunter answers 202 ("still in progress") and time allows. One ledger row for the whole check. */
async function verifyEmail(
  key: string,
  email: string,
  left: () => number,
  spent: { requests: number; credits: number },
): Promise<{ status: string; score: number | null }> {
  spent.requests++;
  const answer = await metered(
    {
      provider: "hunter",
      operation: "email-verifier",
      onOk: (a: HunterAnswer) => hunterUnits(a.credits ?? verifierCredits(a.body)),
      onFail: () => hunterUnits(0),
    },
    async () => {
      let a = await hunterGet(key, "/email-verifier", { email }, Math.min(VERIFY_TIMEOUT_MS, left()));
      // 202: still checking. Polls of the same address count as one request.
      for (let poll = 0; a.status === 202 && left() > 8_000 && poll < 2; poll++) {
        await new Promise((r) => setTimeout(r, 3_000));
        a = await hunterGet(key, "/email-verifier", { email }, Math.min(VERIFY_TIMEOUT_MS, left()));
      }
      return a;
    },
  );
  spent.credits += answer.credits ?? verifierCredits(answer.body);
  // 202 (still checking when time ran out) and 222 (the mail server answered oddly) say nothing.
  if (answer.status !== 200) return { status: "unknown", score: null };
  const data = isRec(answer.body) && isRec(answer.body.data) ? answer.body.data : null;
  const status = typeof data?.status === "string" ? data.status : data?.result === "deliverable" ? "valid" : "unknown";
  return { status, score: emailScoreOf(data?.score) };
}

interface HunterAnswer {
  status: number;
  body: unknown;
  /** X-Credits-Used, when Hunter sent it in credits. */
  credits: number | null;
}

/** GET on Hunter's API with the key in a header. Throws HttpError on a non-2xx answer; 202 and 222 are answers. */
async function hunterGet(key: string, path: string, query: Record<string, string>, timeoutMs: number): Promise<HunterAnswer> {
  const url = `${API}${path}?${new URLSearchParams(query).toString()}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "X-API-KEY": key },
    signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, url);
  const unit = (res.headers.get("x-credits-unit") ?? "credits").trim().toLowerCase();
  const usedHeader = Number(res.headers.get("x-credits-used"));
  const credits = res.headers.has("x-credits-used") && Number.isFinite(usedHeader) && /^credits?$/.test(unit) ? usedHeader : null;
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null, credits };
}

function hunterUnits(credits: number) {
  return { units: { lookups: 1, credits }, ...creditCost(credits, HUNTER_PLAN) };
}

function domainHasEmails(body: unknown): boolean {
  const data = isRec(body) && isRec(body.data) ? body.data : null;
  return Array.isArray(data?.emails) && data.emails.length > 0;
}

function verifierCredits(body: unknown): number {
  const data = isRec(body) && isRec(body.data) ? body.data : null;
  const status = typeof data?.status === "string" ? data.status : null;
  return status === null || status === "unknown" || status === "disposable" ? 0 : HUNTER_CREDITS_PER_VERIFICATION;
}

/** The parts of a Domain Search answer the fallback needs. Pure. */
export function domainInfo(body: unknown): { pattern: string | null; acceptAll: boolean; webmail: boolean; disposable: boolean } {
  const data = isRec(body) && isRec(body.data) ? body.data : null;
  const pattern = typeof data?.pattern === "string" && data.pattern.trim() ? data.pattern.trim() : null;
  return { pattern, acceptAll: data?.accept_all === true, webmail: data?.webmail === true, disposable: data?.disposable === true };
}

function emailScoreOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// ---------------------------------------------------------------------------------------------
// Building an address from a pattern (pure)

/** Letters that do not decompose into a base letter plus a mark. */
const SPECIAL_LETTERS: Record<string, string> = { ß: "ss", æ: "ae", ø: "o", œ: "oe", đ: "d", ð: "d", ł: "l", þ: "th", ı: "i" };

/** A name part as it goes into an address: lower case, accents stripped, only a-z and 0-9 kept ("Zoë O'Brien-Núñez" -> "zoeobriennunez"). */
export function emailPart(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[ßæøœđðłþı]/g, (c) => SPECIAL_LETTERS[c] ?? c)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** "J." or "J" alone: an initial, not a name. */
function isInitial(value: string | null | undefined): boolean {
  return /^\p{L}\.?$/u.test((value ?? "").trim());
}

/**
 * First and last name for a pattern: the first word of the first name, and the whole last
 * name ("van der Berg" becomes "vanderberg" in the address). Cleans titles, credentials and
 * taglines the way the finder does. Pure.
 */
export function patternName(input: { fullName?: string | null; firstName?: string | null; lastName?: string | null }): { first: string | null; last: string | null } {
  let first = cleanName(input.firstName);
  let last = cleanName(input.lastName);
  if (!first || !last) {
    const full = cleanName(input.fullName);
    const words = full ? full.split(" ").filter(Boolean) : [];
    // A one-word full name is the last name when that is already known ("Ms Doe"), not the first.
    if (!first && (words.length >= 2 || !last)) first = words[0] ?? null;
    if (!last && words.length >= 2) last = words.slice(1).join(" ");
  }
  first = first ? first.split(" ")[0] : null;
  return { first: first || null, last: last || null };
}

const TOKEN = /\{(first|last|f|l)\}/g;
const ONLY_TOKENS = /^(?:\{(?:first|last|f|l)\}|[._-])+$/;
const HAS_TOKEN = /\{(?:first|last|f|l)\}/;

/**
 * Builds an address from Hunter's pattern ("{first}.{last}", "{f}{last}", "{first}") and a
 * name: lower case, accents stripped, characters an address cannot hold dropped. A full first
 * or last name is needed where the pattern uses it; an initial does only for {f} or {l}.
 * Returns the address or the reason it cannot be built. Pure.
 */
export function emailFromPattern(pattern: string, name: { first: string | null; last: string | null }, domain: string): { email: string } | { error: string } {
  const p = (pattern ?? "").trim().toLowerCase();
  if (!ONLY_TOKENS.test(p) || !HAS_TOKEN.test(p)) {
    return { error: `Hunter's email pattern for ${domain} (${pattern}) is not one this app can fill in.` };
  }
  const first = emailPart(name.first);
  const last = emailPart(name.last);
  const needs = (token: string) => p.includes(`{${token}}`);
  if (needs("first") && (first.length < 2 || isInitial(name.first))) {
    return { error: `The email pattern at ${domain} (${pattern}) needs their full first name, and ${first ? "only an initial" : "none"} is known.` };
  }
  if (needs("f") && !first) return { error: `The email pattern at ${domain} (${pattern}) needs their first name, and none is known.` };
  if (needs("last") && (last.length < 2 || isInitial(name.last))) {
    return { error: `The email pattern at ${domain} (${pattern}) needs their full last name, and ${last ? "only an initial" : "none"} is known.` };
  }
  if (needs("l") && !last) return { error: `The email pattern at ${domain} (${pattern}) needs their last name, and none is known.` };
  const local = p.replace(TOKEN, (_, token: string) => (token === "first" ? first : token === "last" ? last : token === "f" ? first.charAt(0) : last.charAt(0)));
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(local) || local.length > 64) {
    return { error: `Their name does not give a valid address with the email pattern at ${domain} (${pattern}).` };
  }
  return { email: `${local}@${domain.toLowerCase()}` };
}

export function hunterStatus(): ProviderStatus {
  const configured = hasEnv("HUNTER_API_KEY");
  const paused = configured && Date.now() < pausedUntil;
  return {
    id: "hunter",
    label: "Hunter",
    configured,
    detail: !configured
      ? "Off: set HUNTER_API_KEY to look up work emails."
      : paused
        ? pausedReason
        : "Work email from the LinkedIn handle, or name plus company domain. When Hunter has none, an address is built from the company's email pattern. Up to 1.5 credits a lead (free plan: 50 a month).",
  };
}

// ---------------------------------------------------------------------------------------------
// Private helpers

type Rec = Record<string, unknown>;

function mapResult(body: unknown): EmailResult {
  const data = isRec(body) && isRec(body.data) ? body.data : null;
  const email = validEmail(data?.email);
  // No address found: Hunter answers 200 with email null and charges nothing.
  if (!data || !email) return { email: null, score: null, status: null, sources: [] };
  // Number(null) is 0, so only numbers and numeric strings count as a score.
  const rawScore =
    typeof data.score === "number" ? data.score : typeof data.score === "string" && data.score.trim() ? Number(data.score) : NaN;
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : null;
  const verification = isRec(data.verification) ? data.verification : null;
  const status = typeof verification?.status === "string" && verification.status.trim() ? verification.status.trim() : null;
  const sources: string[] = [];
  for (const s of Array.isArray(data.sources) ? data.sources : []) {
    const uri = isRec(s) && typeof s.uri === "string" ? s.uri.trim() : "";
    if (/^https?:\/\//i.test(uri) && !sources.includes(uri)) sources.push(uri.slice(0, 500));
    if (sources.length >= 10) break;
  }
  return { email, score, status, sources };
}

/** One clear line per failure; pauses calls after 401/429 so a bad key or empty plan fails fast. */
function describeError(err: unknown, none: EmailResult): EmailResult {
  if (err instanceof HttpError) {
    const first = firstHunterError(err.bodySnippet);
    const detail = first?.details ? `: ${first.details}` : "";
    switch (err.status) {
      case 400:
        return { ...none, error: `Hunter rejected the search (${first?.id ?? "400"})${detail}` };
      case 401:
        return pause(none, "Hunter rejected the API key (401). Check HUNTER_API_KEY.", 10 * 60 * 1000);
      case 403:
        return { ...none, error: "Hunter rate limit reached (403); try again in a minute." };
      case 429:
        return pause(none, "Hunter's monthly credits are used up (429). Email lookup resumes when they reset.", 60 * 60 * 1000);
      case 451:
        // The person asked Hunter not to process their data: do not look for it elsewhere either.
        return { ...none, status: "claimed", error: "This person asked Hunter not to process their data (451)." };
      default:
        return { ...none, error: `Hunter email search failed (HTTP ${err.status})${detail}` };
    }
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { ...none, error: `Hunter timed out after ${TIMEOUT_MS / 1000} s.` };
    }
    if (err instanceof SyntaxError) return { ...none, error: "Hunter returned a response that is not JSON." };
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    return { ...none, error: `Hunter email search failed: ${clip(err.message, 160)}${code}` };
  }
  return { ...none, error: `Hunter email search failed: ${clip(String(err), 160)}` };
}

function pause(none: EmailResult, reason: string, ms: number): EmailResult {
  pausedUntil = Date.now() + ms;
  pausedReason = reason;
  return { ...none, error: reason };
}

/** Hunter errors look like { errors: [{ id, code, details }] }. */
function firstHunterError(text: string): { id: string | null; details: string | null } | null {
  try {
    const body: unknown = JSON.parse(text);
    const first = isRec(body) && Array.isArray(body.errors) && isRec(body.errors[0]) ? body.errors[0] : null;
    if (!first) return null;
    return {
      id: typeof first.id === "string" ? clip(first.id, 60) : null,
      details: typeof first.details === "string" ? clip(first.details.replace(/\s+/g, " ").trim(), 200) : null,
    };
  } catch {
    return null;
  }
}

/**
 * The part after linkedin.com/in/ (a bare handle is accepted too). Hunter rejects handles that
 * are "." or "..", or contain whitespace, control characters, "/", "?", "#" or "\".
 */
function linkedinHandle(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const s = url.trim();
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  let handle = m ? m[1] : BARE_HANDLE.test(s) ? s : null;
  if (!handle) return null;
  try {
    handle = decodeURIComponent(handle);
  } catch {
    return null; // malformed %-escape: Hunter would reject it
  }
  handle = handle.trim().toLowerCase();
  if (!handle || handle === "." || handle === ".." || /[\s/?#\\\u0000-\u001f\u007f]/.test(handle)) return null;
  return handle.length <= 100 ? handle : null;
}

/**
 * First and last name when we can be sure of them (Hunter: "first and last name give better
 * results"), else a cleaned full name for Hunter to split. Strips titles, credentials, pronouns,
 * emoji and taglines that LinkedIn names often carry ("Dr. Jane Doe, PhD | Robotics").
 */
function personName(input: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): { first: string | null; last: string | null; full: string | null } | null {
  const first = cleanName(input.firstName);
  const last = cleanName(input.lastName);
  if (first && last) return { first, last, full: `${first} ${last}` };
  const full = cleanName(input.fullName);
  if (!full) return null;
  const parts = full.split(" ");
  if (parts.length < 2) return null; // one word is not enough for Hunter to build an address
  if (parts.length === 2) return { first: parts[0], last: parts[1], full };
  return { first: null, last: null, full };
}

/** A handle given without the URL, e.g. "jane-doe-1a2b3c" (letters in any script, digits, - _ %). */
const BARE_HANDLE = new RegExp("^[\\p{L}\\p{M}\\p{N}_%-]{3,100}$", "u");
// Both also match a field that is only the title or credential ("Dr.", "PhD"), which then cleans to
// nothing, so the cleaned full name is used instead of building dr.doe@ or jane.phd@.
const HONORIFIC = /^(?:dr|prof|professor|mr|mrs|ms|mx|sir|dame)\.?(?:\s+|$)/i;
const CREDENTIAL = /(?:^|\s+)(?:ph\.?\s?d\.?|mba|m\.?d\.?|msc|m\.?s\.?|bsc|cfa|cpa|pmp|esq\.?|jr\.?|sr\.?|ii|iii|iv)$/i;
const NOT_NAME_CHARS = new RegExp("[^\\p{L}\\p{M}'’.\\- ]", "gu");

function cleanName(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  let s = v.normalize("NFC");
  s = s.split(/\s[|•·–—-]\s|,/)[0] ?? ""; // drop "| tagline", "- title", ", PhD"
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, " "); // (she/her), [nickname]
  s = s.replace(NOT_NAME_CHARS, " ").replace(/\s+/g, " ").trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(HONORIFIC, "").replace(CREDENTIAL, "").trim();
  }
  s = s.replace(/^[.'’-]+|[.'’-]+$/g, "").trim();
  return s.length >= 2 ? clip(s, 100) : null;
}

function companyName(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length >= 2 ? clip(s, 120) : null;
}

function validEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(s) && s.length <= 254 ? s : null;
}

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
