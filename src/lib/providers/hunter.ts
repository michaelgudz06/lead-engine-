import "server-only";
import { hasEnv, optionalEnv } from "../env";
import { fetchJson, HttpError } from "../http";
import type { ProviderStatus } from "../types";
import { companyDomain } from "./apollo";

/**
 * Hunter: a work email from a LinkedIn handle, or from name + company domain.
 * Free plan: 50 credits a month, so callers make at most one call per lead.
 * CONTRACT: signatures fixed; owned by the apollo-hunter agent.
 *
 * Docs: https://hunter.io/api-documentation/v2#email-finder. One request carries everything we
 * know: `linkedin_handle` plus the name and the company domain (or name). Hunter resolves the
 * handle first and, when it does not know the handle, falls back to the name on its side, so a
 * lead never costs two calls. The key goes in the X-API-KEY header, never in the URL.
 * Hunter charges only when it finds an email; requests are never retried here, to keep the
 * one-call-per-lead budget exact.
 */

export interface EmailResult {
  email: string | null;
  /** Hunter's confidence, 0 to 100. */
  score: number | null;
  /** Hunter's verification status ("valid", "accept_all", "unknown"), or "claimed" after a 451. */
  status: string | null;
  /** Public pages where Hunter saw the address (at most 10). */
  sources: string[];
  error?: string;
}

const ENDPOINT = "https://api.hunter.io/v2/email-finder";
/** Hunter searches for up to max_duration seconds (3-20, default 10); the timeout leaves headroom. */
const MAX_DURATION_S = 10;
const TIMEOUT_MS = 25_000;
const NOT_CONFIGURED = "Hunter is not configured (HUNTER_API_KEY is not set)";

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
}): Promise<{ email: string | null; score: number | null; status: string | null; sources: string[]; error?: string }> {
  const none: EmailResult = { email: null, score: null, status: null, sources: [] };
  try {
    const key = optionalEnv("HUNTER_API_KEY");
    if (!key) return { ...none, error: NOT_CONFIGURED };
    if (Date.now() < pausedUntil) return { ...none, error: pausedReason };

    const handle = linkedinHandle(input?.linkedinUrl);
    const domain = companyDomain(input?.domain);
    const company = domain ? null : companyName(input?.company);
    const name = personName(input ?? {});
    if (!handle && !(name && (domain || company))) {
      return { ...none, error: "Hunter needs a LinkedIn URL, or a full name plus a company domain or name" };
    }

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

    const body = await fetchJson<unknown>(`${ENDPOINT}?${params.toString()}`, {
      headers: { "X-API-KEY": key },
      timeoutMs: TIMEOUT_MS,
      retry: false,
    });
    return mapResult(body);
  } catch (err) {
    return describeError(err, none);
  }
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
        : "Work email from the LinkedIn handle, or name plus company domain. One call per lead (free plan: 50 a month).",
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
const HONORIFIC = /^(?:dr|prof|professor|mr|mrs|ms|mx|sir|dame)\.?\s+/i;
const CREDENTIAL = /\s+(?:ph\.?\s?d\.?|mba|m\.?d\.?|msc|m\.?s\.?|bsc|cfa|cpa|pmp|esq\.?|jr\.?|sr\.?|ii|iii|iv)$/i;
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
