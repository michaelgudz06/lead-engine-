/**
 * Typed fetch helpers for every endpoint in BUILD_SPEC section 7.
 * Client-safe: imports types only, never server modules or secrets.
 */
import type { ImportRow } from "./import/columns";
import type { ConnectionTuple } from "./paths/csv";
import { cleanWarmPathSummary } from "./paths/summary";
import {
  CONNECTIONS_MAX_PARTS,
  CONNECTIONS_PART_MAX_BYTES,
  CONNECTIONS_ROWS_PER_PART,
  WARM_STRENGTHS,
  type LinkedinAccountState,
  type NetworkStatus,
  type WarmLink,
  type WarmPath,
  type WarmPaths,
  type WarmPathSource,
  type WarmStrength,
} from "./paths/types";
import type { Angle, EmailStatus, ImportSource, Lead, LeadCounts, LeadDetail, LeadView, ProviderStatus, Settings, Stage } from "./types";

/** An API failure with the HTTP status and the server's `{ error }` message. */
export class ApiError extends Error {
  readonly status: number;
  /** Set on a 409 from POST /api/leads or PATCH /api/leads/[id]: the lead that already has this LinkedIn URL. */
  readonly existingId: string | null;
  /** With existingId: that lead's stage, e.g. "unqualified" (the page can offer to restore it). Null when the server did not say. */
  readonly existingStage: Stage | null;
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
    this.existingStage = details && typeof details.existingStage === "string" ? (details.existingStage as Stage) : null;
  }
}

export interface StatusResponse {
  providers: ProviderStatus[];
  model: { name: string; effort: string };
  authEnabled: boolean;
  /**
   * Your own LinkedIn on Unipile for warm paths (step 2, UNIPILE_NETWORK_ACCOUNT_ID). not_set_up
   * when it is off; unavailable when Unipile did not answer. detail says why, in a sentence.
   */
  linkedinAccount: { state: "not_set_up" | "connected" | "needs_reconnect" | "unavailable"; detail: string | null };
}

export interface NewLeadInput {
  linkedinUrl: string;
  name?: string;
  companyName?: string;
  notes?: string;
}

export type LeadPatch = Partial<{
  /** "unqualified" marks the lead (as unqualifyLeads does, with one "Marked unqualified" event); any other stage clears the unqualified fields. */
  stage: Stage;
  /**
   * Why the lead is unqualified: trimmed, at most 200 characters; "" or null clears it. Only while
   * the lead is unqualified, or with stage "unqualified" in the same patch: otherwise a 400.
   */
  unqualifiedReason: string | null;
  notes: string | null;
  owner: string | null;
  nextStepAt: string | null;
  /** Saved lower case, as an address the team added (emailStatus "manual"); null clears it. */
  email: string | null;
  /** A LinkedIn profile URL; null or "" clears it. 400 when it is not a profile URL, 409 (ApiError.existingId) when another lead has it. */
  linkedinUrl: string | null;
  /**
   * The lead's X handle: "@ada_kim", "ada_kim" or an x.com link, saved without "@"; null or ""
   * clears it. 400 (code "bad_handle") when it is not an X handle. A different handle drops the
   * lead's cached X check, and its warm paths are redone without the old X evidence.
   */
  xHandle: string | null;
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
  /**
   * The stage of the lead in existingId ("new" for one this import created). "unqualified" means
   * the row matched an unqualified lead: it was not added again, and the reason says so.
   */
  existingStage: Stage | null;
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

/** GET /api/leads[?view=]: one list (at most 500 leads) and how many leads each list has in all. */
export interface LeadList {
  leads: Lead[];
  counts: LeadCounts;
}

/** POST /api/leads/bulk, unqualify and restore: the leads as they are now, and the ids that matched no lead (restore: no unqualified lead). */
export interface BulkLeadsResult {
  leads: Lead[];
  missing: string[];
}

/** POST /api/leads/bulk, delete: the ids deleted, and the ids that matched no lead. */
export interface BulkDeleteResult {
  deleted: string[];
  missing: string[];
}

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
// Warm paths: a check takes up to 50 s on the server (60 s limit); an intro draft gets 30 s of
// Claude; a connections part is one transaction of up to 5,000 rows; refreshing your X lists takes
// up to 50 s. Reading your own profile is one Unipile read, but its Apify fallback can take about
// three minutes (the route may run 300 s): stopping sooner would report a read that went through.
const WARM_PATHS_TIMEOUT_MS = 65_000;
const INTRO_DRAFT_TIMEOUT_MS = 35_000;
const CONNECTIONS_PART_TIMEOUT_MS = 60_000;
const X_SYNC_TIMEOUT_MS = 65_000;
const OWN_PROFILE_TIMEOUT_MS = 200_000;

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
    unqualifiedAt: lead.unqualifiedAt ?? null,
    unqualifiedReason: lead.unqualifiedReason ?? null,
    stageBeforeUnqualified: lead.stageBeforeUnqualified ?? null,
    warmPath: cleanWarmPathSummary(lead.warmPath),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = count;
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

function leadFrom(data: unknown): Lead {
  return normalizeLead(isRecord(data) ? data.lead : null);
}

const enc = encodeURIComponent;

/**
 * One list of leads. "active" (the default): every lead that is not unqualified, as the Leads and
 * Pipeline pages show them, most recently updated first. "unqualified": most recently marked
 * first. At most 500 leads; counts are the totals of both lists.
 */
export async function listLeads(view: LeadView = "active"): Promise<LeadList> {
  const data = await request<{ leads?: unknown; counts?: unknown }>(view === "active" ? "/api/leads" : `/api/leads?view=${enc(view)}`);
  const leads = Array.isArray(data.leads) ? data.leads.map(normalizeLead) : [];
  const counts: Record<string, unknown> = isRecord(data.counts) ? data.counts : {};
  return {
    leads,
    counts: {
      active: count(counts.active) ?? (view === "active" ? leads.length : 0),
      unqualified: count(counts.unqualified) ?? (view === "unqualified" ? leads.length : 0),
    },
  };
}

export async function createLead(input: NewLeadInput): Promise<Lead> {
  return leadFrom(await request("/api/leads", { method: "POST", body: input }));
}

/** paths, with the warm-paths panel: null before the first research run of a lead never checked. */
export async function getLead(id: string): Promise<LeadDetail> {
  const data = await request<Partial<LeadDetail>>(`/api/leads/${enc(id)}`);
  return {
    lead: normalizeLead(data.lead),
    findings: Array.isArray(data.findings) ? data.findings : [],
    events: Array.isArray(data.events) ? data.events : [],
    paths: warmPathsFrom(data.paths),
  };
}

export async function updateLead(id: string, patch: LeadPatch): Promise<Lead> {
  return leadFrom(await request(`/api/leads/${enc(id)}`, { method: "PATCH", body: patch }));
}

export async function deleteLead(id: string): Promise<void> {
  await request(`/api/leads/${enc(id)}`, { method: "DELETE" });
}

function bulkLeadsFrom(data: Record<string, unknown>): BulkLeadsResult {
  return { leads: Array.isArray(data.leads) ? data.leads.map(normalizeLead) : [], missing: strings(data.missing) };
}

/**
 * Marks leads unqualified (1 to BULK_LEADS_MAX ids): they leave the Leads and Pipeline pages for the
 * Unqualified view. reason: a label from UNQUALIFIED_REASONS or the team's own words (at most 200
 * characters); without one a lead already unqualified keeps its own. Each newly marked lead logs
 * one "Marked unqualified[: reason]" event.
 */
export async function unqualifyLeads(ids: readonly string[], reason?: string | null): Promise<BulkLeadsResult> {
  const text = reason?.trim();
  const body = text ? { action: "unqualify", ids, reason: text } : { action: "unqualify", ids };
  return bulkLeadsFrom(await request<Record<string, unknown>>("/api/leads/bulk", { method: "POST", body }));
}

/** Puts unqualified leads back on the lists, on the stage they had (restoredStage in src/lib/qualify.ts). Ids of leads that are not unqualified come back in missing. */
export async function restoreLeads(ids: readonly string[]): Promise<BulkLeadsResult> {
  return bulkLeadsFrom(await request<Record<string, unknown>>("/api/leads/bulk", { method: "POST", body: { action: "restore", ids } }));
}

/** Deletes leads for good (1 to BULK_LEADS_MAX ids), with their findings and activity. */
export async function deleteLeads(ids: readonly string[]): Promise<BulkDeleteResult> {
  const data = await request<Record<string, unknown>>("/api/leads/bulk", { method: "POST", body: { action: "delete", ids } });
  return { deleted: strings(data.deleted), missing: strings(data.missing) };
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
      existingStage: typeof d.existingStage === "string" ? (d.existingStage as Stage) : null,
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
    xHandle: str(s.xHandle),
    instagramHandle: str(s.instagramHandle),
    linkedinUrl: str(s.linkedinUrl),
  };
}

export async function getSettings(): Promise<Settings> {
  return settingsFrom(await request("/api/settings"));
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return settingsFrom(await request("/api/settings", { method: "PUT", body: patch }));
}

const ACCOUNT_STATES = ["not_set_up", "connected", "needs_reconnect", "unavailable"] as const;

export async function getStatus(): Promise<StatusResponse> {
  const data = await request<Partial<StatusResponse>>("/api/status");
  const model: Record<string, unknown> = isRecord(data.model) ? data.model : {};
  const account: Record<string, unknown> = isRecord(data.linkedinAccount) ? data.linkedinAccount : {};
  return {
    providers: Array.isArray(data.providers) ? data.providers.filter((p) => isRecord(p) && typeof p.id === "string") : [],
    model: { name: typeof model.name === "string" ? model.name : "", effort: typeof model.effort === "string" ? model.effort : "" },
    authEnabled: data.authEnabled === true,
    linkedinAccount: {
      state: oneOf(account.state, ACCOUNT_STATES, "not_set_up"),
      detail: str(account.detail),
    },
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

// ------------------------------------------------------------------ warm paths

function warmLinkFrom(raw: Record<string, unknown>): WarmLink {
  const strength = (WARM_STRENGTHS as readonly string[]).includes(String(raw.strength)) ? (raw.strength as WarmStrength) : null;
  // Evidence is rendered with the copy helpers (src/lib/paths/copy.ts), which switch on its kind.
  return { strength, evidence: records(raw.evidence).filter((e) => typeof e.kind === "string") as unknown as WarmLink["evidence"] };
}

/** One warm path as the UI renders it, or null when the server sent something else. */
function warmPathFrom(raw: unknown): WarmPath | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || (raw.hops !== 1 && raw.hops !== 2)) return null;
  const c = isRecord(raw.connector) ? raw.connector : null;
  const draft = isRecord(raw.introDraft) && typeof raw.introDraft.message === "string" ? raw.introDraft : null;
  return {
    id: raw.id,
    rank: num(raw.rank) ?? 0,
    hops: raw.hops,
    strength: (WARM_STRENGTHS as readonly string[]).includes(String(raw.strength)) ? (raw.strength as WarmStrength) : null,
    connector: c
      ? {
          name: str(c.name) ?? "",
          title: str(c.title),
          company: str(c.company),
          linkedinUrl: str(c.linkedinUrl),
          xHandle: str(c.xHandle),
          leadId: str(c.leadId),
          leadStage: str(c.leadStage) as Stage | null,
        }
      : null,
    links: records(raw.links).map(warmLinkFrom),
    introDraft: draft ? { message: String(draft.message), createdAt: str(draft.createdAt) ?? "" } : null,
    askedAt: str(raw.askedAt),
  };
}

const PATHS_STATUSES = ["idle", "running", "done", "error"] as const;
const SOURCE_NETWORKS = ["linkedin", "x", "instagram"] as const;
const SOURCE_STATES = ["checked", "cached", "not_set_up", "lead_unknown", "skipped", "failed"] as const;
const HISTORY_STATES = ["compared", "no_profile", "own_unread", "lead_unread"] as const;

/**
 * The warm-paths panel's data with every list and object filled in, so a partial reply cannot
 * crash the page. Null for anything that is not an object (no panel). Also reads the `paths` an
 * error carries (warmPathsFromError).
 */
export function warmPathsFrom(raw: unknown): WarmPaths | null {
  if (!isRecord(raw)) return null;
  const links: Record<string, unknown> = isRecord(raw.links) ? raw.links : {};
  const limits: Record<string, unknown> = isRecord(raw.limits) ? raw.limits : {};
  const setup: Record<string, unknown> = isRecord(raw.setup) ? raw.setup : {};
  const shared = isRecord(raw.linkedinShared) ? raw.linkedinShared : null;
  const ig = isRecord(raw.instagram) && typeof raw.instagram.handle === "string" ? raw.instagram : null;
  const paths = (v: unknown) => (Array.isArray(v) ? v.map(warmPathFrom).filter((p): p is WarmPath => p !== null) : []);
  return {
    status: oneOf(raw.status, PATHS_STATUSES, "idle"),
    startedAt: str(raw.startedAt),
    checkedAt: str(raw.checkedAt),
    sources: records(raw.sources).map(
      (s): WarmPathSource => ({
        network: oneOf(s.network, SOURCE_NETWORKS, "linkedin"),
        state: oneOf(s.state, SOURCE_STATES, "skipped"),
        reason: str(s.reason) as WarmPathSource["reason"],
        detail: str(s.detail) ?? "",
        counts: isRecord(s.counts) ? (s.counts as WarmPathSource["counts"]) : {},
        at: str(s.at),
        costUsd: num(s.costUsd),
        // What the line compared: the panel's words are built from these (src/lib/paths/copy.ts).
        mutuals: s.mutuals === true,
        ...((HISTORY_STATES as readonly string[]).includes(String(s.history)) ? { history: s.history as WarmPathSource["history"] } : {}),
      }),
    ),
    linkedinShared: shared && num(shared.count) !== null ? { count: num(shared.count)!, shown: num(shared.shown) ?? 0 } : null,
    paths: paths(raw.paths),
    companyPaths: paths(raw.companyPaths),
    links: { linkedinMutuals: str(links.linkedinMutuals), xFollowersYouKnow: str(links.xFollowersYouKnow), instagram: str(links.instagram) },
    limits: { linkedinChecksLeft: num(limits.linkedinChecksLeft), xUsdLeft: num(limits.xUsdLeft) },
    setup: {
      linkedinConnections: setup.linkedinConnections === true,
      linkedinProfile: setup.linkedinProfile === true,
      linkedinAccount: setup.linkedinAccount === true,
      x: setup.x === true,
      instagram: setup.instagram === true,
      any: setup.any === true,
      xAvailable: setup.xAvailable === true,
    },
    leadFirstName: str(raw.leadFirstName) || "them",
    instagram: ig ? { handle: String(ig.handle), source: ig.source === "profile" ? "profile" : "manual" } : null,
    error: str(raw.error),
  };
}

/**
 * The paths a failed check still saved: POST /api/leads/[id]/paths answers 429 warm_path_budget,
 * 502 upstream and 400 not_set_up / nothing_to_check with `paths` (the free part). Null otherwise.
 */
export function warmPathsFromError(err: unknown): WarmPaths | null {
  return err instanceof ApiError ? warmPathsFrom(err.details?.paths) : null;
}

/** POST /api/leads/[id]/paths. message: the line logged to Activity ("Warm paths: best via someone you know (Medium, LinkedIn)"). */
export interface WarmPathsCheck {
  paths: WarmPaths | null;
  message: string;
  outcome: "found" | "none";
}

/**
 * "Find warm paths" / "Check again" (up to about 50 s; waits 65 s). Rejects with ApiError, code:
 * 400 nothing_to_check / not_set_up, 404, 409 research_running / checking / changed, 429
 * warm_path_budget, 502 upstream, 500 error. 400, 429 and 502 still carry the saved paths: read
 * them with warmPathsFromError(err).
 */
export async function findWarmPaths(id: string): Promise<WarmPathsCheck> {
  const data = await request<Record<string, unknown>>(`/api/leads/${enc(id)}/paths`, { method: "POST", timeoutMs: WARM_PATHS_TIMEOUT_MS });
  return { paths: warmPathsFrom(data.paths), message: str(data.message) ?? "", outcome: data.outcome === "found" ? "found" : "none" };
}

/** The lead's Instagram handle ("@ada.kim", "ada.kim" or a profile link); null or "" clears it. 400 bad_handle, 409 checking. */
export async function setInstagramHandle(id: string, handle: string | null): Promise<WarmPaths | null> {
  const data = await request<Record<string, unknown>>(`/api/leads/${enc(id)}/paths`, { method: "PATCH", body: { instagramHandle: handle } });
  return warmPathsFrom(data.paths);
}

function pathFromReply(data: Record<string, unknown>): WarmPath {
  const path = warmPathFrom(data.path);
  if (!path) throw new ApiError("The server sent a path in an unexpected shape.", 200);
  return path;
}

/**
 * Drafts the intro request for one path (one Claude call; waits 35 s). Nothing is sent. Rejects
 * with ApiError, code: 400 direct, 404, 409 drafting, 429 intro_budget (100 drafts a day across
 * the app), 502 claude ("Could not draft the request: ...").
 */
export async function draftIntro(id: string, pathId: string): Promise<WarmPath> {
  return pathFromReply(await request<Record<string, unknown>>(`/api/leads/${enc(id)}/paths/${enc(pathId)}/intro`, { method: "POST", timeoutMs: INTRO_DRAFT_TIMEOUT_MS }));
}

/**
 * Saves an edited intro draft (at most 2,000 characters; "" or null clears it) and/or the "asked"
 * mark. asked true logs "Asked <name> for an intro" to Activity once. 400 direct, 404, 409 marking.
 */
export async function saveIntro(id: string, pathId: string, patch: { introDraft?: string | null; asked?: boolean }): Promise<WarmPath> {
  return pathFromReply(await request<Record<string, unknown>>(`/api/leads/${enc(id)}/paths/${enc(pathId)}`, { method: "PATCH", body: patch }));
}

/** GET /api/network: counts and states only (Settings > Your network). */
export async function getNetwork(): Promise<NetworkStatus> {
  const data = await request<Record<string, unknown>>("/api/network");
  const li: Record<string, unknown> = isRecord(data.linkedin) ? data.linkedin : {};
  const conn = isRecord(li.connections) ? li.connections : null;
  const self = isRecord(li.self) ? li.self : null;
  const acc: Record<string, unknown> = isRecord(li.account) ? li.account : {};
  const x: Record<string, unknown> = isRecord(data.x) ? data.x : {};
  const ig: Record<string, unknown> = isRecord(data.instagram) ? data.instagram : {};
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    linkedin: {
      connections: conn ? { count: num(conn.count) ?? 0, exportedAt: str(conn.exportedAt), uploadedAt: str(conn.uploadedAt) ?? "" } : null,
      self: self && typeof self.url === "string" ? { url: self.url, readAt: str(self.readAt), roles: num(self.roles) ?? 0, schools: num(self.schools) ?? 0, error: str(self.error) } : null,
      account: {
        state: oneOf<LinkedinAccountState>(acc.state, ["not_set_up", "connected", "needs_reconnect", "paused"], "not_set_up"),
        premium: bool(acc.premium),
        salesNavigator: bool(acc.salesNavigator),
        pausedUntil: str(acc.pausedUntil),
        pauseKind: acc.pauseKind === "rate_limited" || acc.pauseKind === "auth" || acc.pauseKind === "error" ? acc.pauseKind : null,
        checksToday: num(acc.checksToday) ?? 0,
        checksLimit: num(acc.checksLimit) ?? 0,
      },
    },
    x: {
      configured: x.configured === true,
      handle: str(x.handle),
      following: num(x.following),
      followers: num(x.followers),
      syncedAt: str(x.syncedAt),
      running: x.running === true,
      error: str(x.error),
      usdToday: num(x.usdToday) ?? 0,
      usdLimit: num(x.usdLimit) ?? 0,
    },
    instagram: { handle: str(ig.handle) },
  };
}

/** One part of a connections upload, for a progress line: "Uploading part 2 of 3". */
export interface ConnectionsUploadProgress {
  part: number;
  parts: number;
  /** Rows sent so far, and in all. */
  sent: number;
  total: number;
}

export interface ConnectionsUploadResult {
  /** Connections stored now. */
  total: number;
  /** Leads that got the "Connected" chip. */
  connectedLeads: number;
  parts: number;
}

/** Thrown by uploadConnections when a part fails. Nothing replaces your stored connections until the last part arrives. */
export class ConnectionsUploadError extends ApiError {
  /** The part that failed (1-based), of how many. */
  readonly part: number;
  readonly parts: number;

  constructor(cause: ApiError, part: number, parts: number) {
    super(cause.message, cause.status, cause.existingId, cause.details);
    this.name = "ConnectionsUploadError";
    this.part = part;
    this.parts = parts;
  }
}

/** The bytes one part may take, leaving room for the JSON around the rows. */
const PART_BYTES = CONNECTIONS_PART_MAX_BYTES - 64 * 1024;

/** Rows in parts of at most 5,000 rows and about 4 MB each (UTF-8). */
function connectionParts(rows: ReadonlyArray<ConnectionTuple>): ConnectionTuple[][] {
  const encoder = new TextEncoder();
  const parts: ConnectionTuple[][] = [];
  let current: ConnectionTuple[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1;
    if (current.length && (current.length >= CONNECTIONS_ROWS_PER_PART || bytes + size > PART_BYTES)) {
      parts.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length) parts.push(current);
  return parts;
}

/** A v4 UUID for one upload (crypto.randomUUID needs a secure context; getRandomValues does not). */
function newUploadId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isoOrNull(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const t = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null;
}

/**
 * Uploads your LinkedIn connections: the rows from parseConnectionsCsv as connectionTuples (no
 * email addresses), in parts of at most 5,000 rows and about 4 MB, one PUT per part, one after
 * another (60 s each; a part that times out or meets a server error is sent once more). Pass
 * exportedAt from the file (file.lastModified): it dates the "export of Nov 2" lines. Your stored
 * connections are replaced only when the last part arrives. A failed part rejects with a
 * ConnectionsUploadError (ApiError: 400 bad row, 409 replaced by a newer upload, 413 too large).
 */
export async function uploadConnections(
  rows: ReadonlyArray<ConnectionTuple>,
  opts: { exportedAt?: string | number | Date | null; onProgress?: (p: ConnectionsUploadProgress) => void } = {},
): Promise<ConnectionsUploadResult> {
  if (!rows.length) throw new ApiError("The file has no connections to upload.", 400, null, { code: "empty" });
  const parts = connectionParts(rows);
  if (parts.length > CONNECTIONS_MAX_PARTS) {
    throw new ApiError(`This file is too large: send at most ${(CONNECTIONS_ROWS_PER_PART * CONNECTIONS_MAX_PARTS).toLocaleString("en-US")} connections.`, 413, null, { code: "too_large" });
  }
  const importId = newUploadId();
  const exportedAt = isoOrNull(opts.exportedAt);
  let sent = 0;
  let last: Record<string, unknown> = {};
  for (let i = 0; i < parts.length; i++) {
    const body = { importId, part: i + 1, parts: parts.length, rows: parts[i], exportedAt };
    const send = () => request<Record<string, unknown>>("/api/network/linkedin/connections", { method: "PUT", body, timeoutMs: CONNECTIONS_PART_TIMEOUT_MS });
    try {
      try {
        last = await send();
      } catch (err) {
        // A part is safe to send again: its rows are upserted under the same upload.
        if (!(err instanceof ApiError) || !(err.status === 0 || err.status >= 500)) throw err;
        last = await send();
      }
    } catch (err) {
      if (err instanceof ApiError) throw new ConnectionsUploadError(err, i + 1, parts.length);
      throw err;
    }
    sent += parts[i].length;
    opts.onProgress?.({ part: i + 1, parts: parts.length, sent, total: rows.length });
  }
  return { total: num(last.total) ?? 0, connectedLeads: num(last.connectedLeads) ?? 0, parts: parts.length };
}

/** Removes every stored connection, and every path that may name one. */
export async function deleteConnections(): Promise<{ removed: number }> {
  const data = await request<Record<string, unknown>>("/api/network/linkedin/connections", { method: "DELETE" });
  return { removed: num(data.removed) ?? 0 };
}

/**
 * Reads your own LinkedIn profile now (the URL in Settings) for your roles and schools: counts
 * only. Rejects with ApiError, code: 400 no_url, 409 busy, 429 too_soon, 502 failed.
 */
export async function readOwnProfile(): Promise<{ readAt: string; roles: number; schools: number }> {
  const data = await request<Record<string, unknown>>("/api/network/linkedin/self", { method: "POST", timeoutMs: OWN_PROFILE_TIMEOUT_MS });
  return { readAt: str(data.readAt) ?? new Date().toISOString(), roles: num(data.roles) ?? 0, schools: num(data.schools) ?? 0 };
}

/** POST /api/network/x/sync. refreshed false (with a note) when the stored lists were kept. */
export interface XSyncResult {
  following: number;
  followers: number;
  syncedAt: string | null;
  creditsUsed: number;
  refreshed: boolean;
  note: string | null;
}

/**
 * Refreshes your X lists now (twitterapi.io, within the daily X budget; waits 65 s). Rejects with
 * ApiError, code: 400 not_configured / no_handle, 409 syncing, 429 warm_path_budget, 502 upstream.
 */
export async function syncX(): Promise<XSyncResult> {
  const data = await request<Record<string, unknown>>("/api/network/x/sync", { method: "POST", timeoutMs: X_SYNC_TIMEOUT_MS });
  return {
    following: num(data.following) ?? 0,
    followers: num(data.followers) ?? 0,
    syncedAt: str(data.syncedAt),
    creditsUsed: num(data.creditsUsed) ?? 0,
    refreshed: data.refreshed !== false,
    note: str(data.note),
  };
}

// ------------------------------------------------------------------ session

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
