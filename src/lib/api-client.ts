/**
 * Typed fetch helpers for every endpoint in BUILD_SPEC section 7.
 * Client-safe: imports types only, never server modules or secrets.
 */
import type { ImportRow } from "./import/columns";
import type { Angle, EmailStatus, ImportSource, Lead, LeadDetail, ProviderStatus, Settings, Stage } from "./types";

/** An API failure with the HTTP status and the server's `{ error }` message. */
export class ApiError extends Error {
  readonly status: number;
  /** Set on a 409 from POST /api/leads or PATCH /api/leads/[id]: the lead that already has this LinkedIn URL. */
  readonly existingId: string | null;
  /** The server's machine-readable reason, when it sends one (e.g. "not_shared" for a private Google Sheet). */
  readonly code: string | null;
  /** The whole error body, for extra fields such as { limit, remaining } on an import's 429. */
  readonly details: Record<string, unknown> | null;

  constructor(message: string, status: number, existingId: string | null = null, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.existingId = existingId;
    this.details = details;
    this.code = details && typeof details.code === "string" ? details.code : null;
  }
}

export interface StatusResponse {
  providers: ProviderStatus[];
  model: { name: string; effort: string };
  authEnabled: boolean;
}

export interface NewLeadInput {
  linkedinUrl: string;
  name?: string;
  companyName?: string;
  notes?: string;
}

export type LeadPatch = Partial<{
  stage: Stage;
  notes: string | null;
  owner: string | null;
  nextStepAt: string | null;
  /** Saved lower case, as an address the team added (emailStatus "manual"); null clears it. */
  email: string | null;
  /** A LinkedIn profile URL; null or "" clears it. 400 when it is not a profile URL, 409 (ApiError.existingId) when another lead has it. */
  linkedinUrl: string | null;
  name: string | null;
  title: string | null;
  companyName: string | null;
  angles: Angle[];
}>;

export interface HubspotResult {
  ok: boolean;
  contactId?: string;
  companyId?: string;
  dealId?: string;
}

/** A sheet, file or HubSpot list as the import screen reads it: a header and rows of cells. */
export interface ImportTable {
  headers: string[];
  rows: string[][];
  /** Data rows in the source (rows may hold fewer when the sheet was cut short). */
  total: number;
}

/** POST /api/import/sheet. */
export interface SheetTable extends ImportTable {
  /** Only the first rows came back (the sheet has more than 5,000, or is very wide). */
  truncated: boolean;
  /** The header's row number in the sheet; the first data row is headerRow + 1 (for toImportRows). */
  headerRow: number;
}

/** GET /api/import/hubspot. Headers: HubSpot ID, First name, Last name, Email, Company, Job title, LinkedIn URL. */
export interface HubSpotContacts extends ImportTable {
  /** HubSpot has more contacts than the limit allowed. */
  more: boolean;
  /** The contact properties read for LinkedIn URLs. */
  linkedinProperties: string[];
  /** Problems that did not stop the listing, e.g. a missing scope. */
  warnings: string[];
}

/** A row that named a lead that already exists, or an earlier row of the same import. */
export interface ImportDuplicate {
  /** Index into the rows that were sent. */
  index: number;
  /** The lead that has this person: an existing lead, or the one this import created for an earlier row. */
  existingId: string | null;
  reason: string;
  /** The key that matched. "name" (same name and company) is used only for rows with no LinkedIn URL, HubSpot id or email. */
  match: "linkedin" | "hubspot" | "email" | "name";
  /** For a repeat inside the import: the index of the earlier row. */
  duplicateOf: number | null;
}

/** POST /api/leads/import. */
export interface ImportResult {
  created: number;
  createdIds: string[];
  /** Which row became which lead. */
  createdRows: Array<{ index: number; id: string }>;
  duplicates: ImportDuplicate[];
  /** Rows that cannot become a lead, with the reason. */
  skipped: Array<{ index: number; reason: string }>;
}

/** POST /api/leads/[id]/email. email is null when nothing was found; message says what happened either way. */
export interface EmailLookupResult {
  email: string | null;
  emailStatus: EmailStatus | null;
  emailConfidence: number | null;
  message: string;
  /** Hunter credits the lookup used. */
  creditsUsed: number;
  /** The lead after the lookup. */
  lead: Lead;
}

/** The most rows one import request may carry (the server refuses more). */
export const IMPORT_BATCH_MAX = 1000;

// Requests only read or write our own database, so they are quick. Research itself
// runs in the background after the response, which is why 30 s is generous.
const TIMEOUT_MS = 30_000;
// Calls that wait on another service: the server gives a Google Sheet 15 s, a HubSpot listing
// 45 s and an email lookup 50 s; an import is one database transaction of up to 1,000 rows.
const SHEET_TIMEOUT_MS = 40_000;
const HUBSPOT_LIST_TIMEOUT_MS = 65_000;
const IMPORT_TIMEOUT_MS = 60_000;
const EMAIL_LOOKUP_TIMEOUT_MS = 65_000;
// The HubSpot push is the exception: the server gives it up to 45 s of HubSpot calls
// inside a 60 s function limit. Stopping sooner would report a push that went through
// as failed, and a retry would log a second note.
const HUBSPOT_TIMEOUT_MS = 65_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusMessage(status: number): string {
  if (status === 401) return "Your session has ended. Please log in again.";
  if (status === 404) return "Not found.";
  if (status >= 500) return "The server had a problem. Please try again.";
  return `Request failed (${status}).`;
}

async function request<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    throw new ApiError(timedOut ? "The request took too long. Please try again." : "Could not reach the server. Check your connection.", 0);
  } finally {
    clearTimeout(timer);
  }

  // The body may be empty or HTML (a crash page), so parse it without trusting it.
  let data: unknown = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    // The access gate answers 401 for API calls: send the person to the login page
    // and bring them back to where they were.
    if (res.status === 401 && path !== "/api/login" && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      const next = window.location.pathname + window.location.search;
      // A full page load on purpose: it drops every piece of in-memory lead data.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    }
    const message = isRecord(data) && typeof data.error === "string" && data.error ? data.error : statusMessage(res.status);
    const existingId = isRecord(data) && typeof data.existingId === "string" ? data.existingId : null;
    throw new ApiError(message, res.status, existingId, isRecord(data) ? data : null);
  }
  if (data === null) throw new ApiError("The server sent an empty or unreadable reply.", res.status);
  return data as T;
}

/** Fill in the collections the UI iterates over, so a partial row cannot crash a page. */
function normalizeLead(raw: unknown): Lead {
  if (!isRecord(raw) || typeof raw.id !== "string") throw new ApiError("The server sent a lead in an unexpected shape.", 200);
  const lead = raw as unknown as Lead;
  return {
    ...lead,
    angles: Array.isArray(lead.angles) ? lead.angles : [],
    usage: isRecord(lead.usage) ? (lead.usage as Record<string, number>) : {},
    stage: lead.stage ?? "new",
    researchStatus: lead.researchStatus ?? "idle",
  };
}

function leadFrom(data: unknown): Lead {
  return normalizeLead(isRecord(data) ? data.lead : null);
}

const enc = encodeURIComponent;

export async function listLeads(): Promise<Lead[]> {
  const data = await request<{ leads?: unknown }>("/api/leads");
  return Array.isArray(data.leads) ? data.leads.map(normalizeLead) : [];
}

export async function createLead(input: NewLeadInput): Promise<Lead> {
  return leadFrom(await request("/api/leads", { method: "POST", body: input }));
}

export async function getLead(id: string): Promise<LeadDetail> {
  const data = await request<Partial<LeadDetail>>(`/api/leads/${enc(id)}`);
  return {
    lead: normalizeLead(data.lead),
    findings: Array.isArray(data.findings) ? data.findings : [],
    events: Array.isArray(data.events) ? data.events : [],
  };
}

export async function updateLead(id: string, patch: LeadPatch): Promise<Lead> {
  return leadFrom(await request(`/api/leads/${enc(id)}`, { method: "PATCH", body: patch }));
}

export async function deleteLead(id: string): Promise<void> {
  await request(`/api/leads/${enc(id)}`, { method: "DELETE" });
}

/** Starts a new research run. Rejects with status 409 when one is already running. */
export async function startResearch(id: string): Promise<void> {
  await request(`/api/leads/${enc(id)}/research`, { method: "POST" });
}

/**
 * Re-runs research with a reason: what to look into or try again (at most 1,200 characters).
 * The agent searches for it first and the drafts lean on it; it shows in the activity as
 * "Re-run: <focus>". An empty focus is a plain re-run. 409 while a run is going, 429 over the run caps.
 */
export async function rerunResearch(id: string, focus?: string | null): Promise<void> {
  const text = focus?.trim();
  await request(`/api/leads/${enc(id)}/research`, text ? { method: "POST", body: { focus: text } } : { method: "POST" });
}

/**
 * Looks up the lead's work email with Hunter now (no research run) and saves what it finds.
 * Resolves with email null and a message when nothing was found. 409 when the lead has an
 * address the team added or research is running, 429 when the daily lookup limit is reached.
 */
export async function findEmail(id: string): Promise<EmailLookupResult> {
  const data = await request<Record<string, unknown>>(`/api/leads/${enc(id)}/email`, { method: "POST", timeoutMs: EMAIL_LOOKUP_TIMEOUT_MS });
  return {
    email: typeof data.email === "string" ? data.email : null,
    emailStatus: typeof data.emailStatus === "string" ? (data.emailStatus as EmailStatus) : null,
    emailConfidence: typeof data.emailConfidence === "number" ? data.emailConfidence : null,
    message: typeof data.message === "string" ? data.message : "",
    creditsUsed: typeof data.creditsUsed === "number" ? data.creditsUsed : 0,
    lead: normalizeLead(data.lead),
  };
}

function tableFrom(data: Record<string, unknown>): ImportTable {
  const headers = Array.isArray(data.headers) ? data.headers.map((h) => (typeof h === "string" ? h : "")) : [];
  const rows = Array.isArray(data.rows) ? data.rows.filter(Array.isArray).map((r) => (r as unknown[]).map((c) => (typeof c === "string" ? c : c == null ? "" : String(c)))) : [];
  return { headers, rows, total: typeof data.total === "number" ? data.total : rows.length };
}

/**
 * Reads a Google Sheet shared as "anyone with the link" (its header and rows). A private sheet
 * rejects with status 400 and code "not_shared"; others: bad_link, not_found, too_large (400),
 * timeout (504), upstream (502).
 */
export async function parseSheet(url: string): Promise<SheetTable> {
  const data = await request<Record<string, unknown>>("/api/import/sheet", { method: "POST", body: { url }, timeoutMs: SHEET_TIMEOUT_MS });
  return { ...tableFrom(data), truncated: data.truncated === true, headerRow: typeof data.headerRow === "number" ? data.headerRow : 1 };
}

/** Lists HubSpot contacts for an import (1 to 2,000, default 500). 400 with code "not_connected" when HubSpot has no token. */
export async function getHubSpotContacts(limit = 500): Promise<HubSpotContacts> {
  const data = await request<Record<string, unknown>>(`/api/import/hubspot?limit=${enc(String(limit))}`, { timeoutMs: HUBSPOT_LIST_TIMEOUT_MS });
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { ...tableFrom(data), more: data.more === true, linkedinProperties: strings(data.linkedinProperties), warnings: strings(data.warnings) };
}

function importResultFrom(data: Record<string, unknown>): ImportResult {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : []);
  return {
    created: typeof data.created === "number" ? data.created : 0,
    createdIds: Array.isArray(data.createdIds) ? data.createdIds.filter((x): x is string => typeof x === "string") : [],
    createdRows: list(data.createdRows).map((r) => ({ index: Number(r.index), id: String(r.id) })),
    duplicates: list(data.duplicates).map((d) => ({
      index: Number(d.index),
      existingId: typeof d.existingId === "string" ? d.existingId : null,
      reason: typeof d.reason === "string" ? d.reason : "",
      match: d.match === "linkedin" || d.match === "hubspot" || d.match === "name" ? d.match : "email",
      duplicateOf: typeof d.duplicateOf === "number" ? d.duplicateOf : null,
    })),
    skipped: list(data.skipped).map((k) => ({ index: Number(k.index), reason: typeof k.reason === "string" ? k.reason : "" })),
  };
}

/**
 * Adds leads from up to 1,000 rows (toImportRows in src/lib/import/columns.ts). Never starts
 * research. Rejects with 429 (ApiError.details: limit, remaining, wanted) when the batch would
 * pass the daily import limit; nothing is added then.
 */
export async function importLeads(source: ImportSource, rows: ImportRow[]): Promise<ImportResult> {
  return importResultFrom(await request<Record<string, unknown>>("/api/leads/import", { method: "POST", body: { source, rows }, timeoutMs: IMPORT_TIMEOUT_MS }));
}

/** Thrown by importLeadsInBatches when a batch fails: the batches before it were imported. */
export class ImportBatchError extends ApiError {
  /** What the earlier batches did, with indexes into the full list of rows. */
  readonly partial: ImportResult;
  /** Index of the first row that was not imported. */
  readonly failedAt: number;

  constructor(cause: ApiError, partial: ImportResult, failedAt: number) {
    super(cause.message, cause.status, cause.existingId, cause.details);
    this.name = "ImportBatchError";
    this.partial = partial;
    this.failedAt = failedAt;
  }
}

/**
 * importLeads for any number of rows: batches of at most `batchSize` (default 500) rows and
 * about 2 MB each, one after another, merged into one result with indexes into `rows`. A
 * failed batch stops the import with an ImportBatchError that carries what was done.
 */
export async function importLeadsInBatches(
  source: ImportSource,
  rows: ImportRow[],
  opts: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<ImportResult> {
  const size = Math.max(1, Math.min(IMPORT_BATCH_MAX, opts.batchSize ?? 500));
  const total: ImportResult = { created: 0, createdIds: [], createdRows: [], duplicates: [], skipped: [] };
  let start = 0;
  while (start < rows.length) {
    let end = start;
    let bytes = 0;
    while (end < rows.length && end - start < size) {
      bytes += JSON.stringify(rows[end]).length;
      if (end > start && bytes > 2_000_000) break;
      end++;
    }
    let part: ImportResult;
    try {
      part = await importLeads(source, rows.slice(start, end));
    } catch (err) {
      if (err instanceof ApiError) throw new ImportBatchError(err, total, start);
      throw err;
    }
    total.created += part.created;
    total.createdIds.push(...part.createdIds);
    total.createdRows.push(...part.createdRows.map((r) => ({ ...r, index: r.index + start })));
    total.duplicates.push(...part.duplicates.map((d) => ({ ...d, index: d.index + start, duplicateOf: d.duplicateOf === null ? null : d.duplicateOf + start })));
    total.skipped.push(...part.skipped.map((k) => ({ ...k, index: k.index + start })));
    start = end;
    opts.onProgress?.(start, rows.length);
  }
  return total;
}

export async function steerLead(id: string, instruction: string): Promise<void> {
  await request(`/api/leads/${enc(id)}/steer`, { method: "POST", body: { instruction } });
}

export async function markSent(id: string, angleId: string, channel: "email" | "linkedin"): Promise<Lead> {
  return leadFrom(await request(`/api/leads/${enc(id)}/sent`, { method: "POST", body: { angleId, channel } }));
}

export async function logEvent(id: string, type: "copied" | "note", message: string): Promise<void> {
  await request(`/api/leads/${enc(id)}/events`, { method: "POST", body: { type, message } });
}

export async function pushToHubspot(id: string): Promise<HubspotResult> {
  return request<HubspotResult>(`/api/leads/${enc(id)}/hubspot`, { method: "POST", timeoutMs: HUBSPOT_TIMEOUT_MS });
}

function settingsFrom(data: unknown): Settings {
  const s = isRecord(data) && isRecord(data.settings) ? data.settings : null;
  if (!s) throw new ApiError("The server sent settings in an unexpected shape.", 200);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const days = Number(s.followUpDays);
  return {
    senderName: str(s.senderName),
    senderEmail: str(s.senderEmail),
    calendlyUrl: str(s.calendlyUrl),
    signature: str(s.signature),
    criteria: Array.isArray(s.criteria) ? s.criteria.filter((c): c is string => typeof c === "string") : [],
    followUpDays: Number.isFinite(days) && days > 0 ? days : 4,
  };
}

export async function getSettings(): Promise<Settings> {
  return settingsFrom(await request("/api/settings"));
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return settingsFrom(await request("/api/settings", { method: "PUT", body: patch }));
}

export async function getStatus(): Promise<StatusResponse> {
  const data = await request<Partial<StatusResponse>>("/api/status");
  const model: Record<string, unknown> = isRecord(data.model) ? data.model : {};
  return {
    providers: Array.isArray(data.providers) ? data.providers.filter((p) => isRecord(p) && typeof p.id === "string") : [],
    model: { name: typeof model.name === "string" ? model.name : "", effort: typeof model.effort === "string" ? model.effort : "" },
    authEnabled: data.authEnabled === true,
  };
}

// Several components on one page need the status (shell, lead actions). It only
// changes on a redeploy, so share one request per page load; a failure is not cached.
let statusPromise: Promise<StatusResponse> | null = null;
export function getStatusCached(): Promise<StatusResponse> {
  if (!statusPromise) {
    statusPromise = getStatus().catch((err) => {
      statusPromise = null;
      throw err;
    });
  }
  return statusPromise;
}

export async function login(password: string): Promise<void> {
  await request("/api/login", { method: "POST", body: { password } });
}

export async function logout(): Promise<void> {
  await request("/api/logout", { method: "POST" });
}

/** A short message for any thrown value, for error banners. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Please try again.";
}
