/**
 * Typed fetch helpers for every endpoint in BUILD_SPEC section 7.
 * Client-safe: imports types only, never server modules or secrets.
 */
import type { Angle, Lead, LeadDetail, ProviderStatus, Settings, Stage } from "./types";

/** An API failure with the HTTP status and the server's `{ error }` message. */
export class ApiError extends Error {
  readonly status: number;
  /** Set on a 409 from POST /api/leads: the lead that already has this LinkedIn URL. */
  readonly existingId: string | null;

  constructor(message: string, status: number, existingId: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.existingId = existingId;
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
  email: string | null;
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

// Requests only read or write our own database, so they are quick. Research itself
// runs in the background after the response, which is why 30 s is generous.
const TIMEOUT_MS = 30_000;
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
    throw new ApiError(message, res.status, existingId);
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
