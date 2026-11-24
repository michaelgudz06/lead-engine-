/**
 * Product analytics (PostHog), browser side. Client-safe: no secrets, no server imports.
 *
 * Off unless NEXT_PUBLIC_POSTHOG_KEY (a public "phc_" project key) was set at build time.
 * Off means off: track() returns at once, posthog-js is never downloaded, nothing is sent.
 *
 * On: src/instrumentation-client.ts loads posthog-js in its own chunk, starts it with
 * posthogInitOptions() and hands it over with attachAnalytics(). The browser only talks to
 * /ingest on this site; next.config.ts rewrites that to PostHog's hosts (a reverse proxy).
 *
 * Privacy rules (the owner wants to see how the app is used, not what is in it):
 * - Explicit events only, plus pageviews and pageleaves. No autocapture, session recording,
 *   heatmaps, rage or dead clicks, web vitals, exception capture, surveys or feature flags.
 * - Properties are ids, counts, durations, enums and booleans. sanitizeProps() drops anything
 *   that looks like an email, a URL, a domain or free text, so a lead's name, email, notes,
 *   drafts or LinkedIn URL cannot ride along by mistake. Angles are named by their library id
 *   only ("custom" otherwise: a made-up id may echo the lead or their company).
 * - beforeSend() drops every event not listed in CLIENT_EVENTS, and the page title, which
 *   holds the lead's name on lead pages.
 * - Nobody is identified: each browser is an anonymous visitor (localStorage, no cookie),
 *   reset on log out. The access password and keys are never part of an event.
 */
import type { CaptureResult, PostHogConfig } from "posthog-js";
import type { ImportSource, Settings, Stage, UnqualifiedReasonKey } from "./types";

// ------------------------------------------------------------------ events

/** A lead's database id (a UUID). */
type LeadId = string;

/** One angle of a lead: its library id or "custom", and its tab position (0-based). */
export interface AngleRef {
  leadId: LeadId;
  angleId: string;
  angleIndex: number;
}

export type DraftField = "subject" | "body" | "linkedin";

export const SETTINGS_FIELDS = ["senderName", "senderEmail", "calendlyUrl", "signature", "followUpDays", "criteria"] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];

type NoProps = Record<never, never>;

/** Where leads were marked, restored or deleted: the Leads list, a lead's page or the pipeline board. */
export type LeadSurface = "list" | "lead" | "pipeline";

/** Every client event and its properties. Only these (plus $pageview and $pageleave) are sent. */
export interface ClientEventProps {
  lead_created: { leadId: LeadId; withName: boolean; withCompany: boolean; withNotes: boolean };
  research_rerun: { leadId: LeadId; hadResearch: boolean; afterFailure: boolean };
  steer_sent: { leadId: LeadId; instructionLength: number };
  email_copied: AngleRef;
  linkedin_message_copied: AngleRef & { length: number; overLimit: boolean };
  gmail_opened: AngleRef & { withRecipient: boolean };
  linkedin_profile_opened: { leadId: LeadId; from: "angles" | "header" };
  marked_sent: AngleRef & { channel: "email" | "linkedin" };
  /** An ordinary stage change. A change to or from Unqualified sends leads_unqualified or leads_restored instead. */
  stage_changed: { leadId: LeadId; from: Stage; to: Stage; surface: "lead" | "pipeline" };
  /** Leads were marked unqualified. reason: the quick pick's key or "none", never the text. */
  leads_unqualified: { count: number; reason: UnqualifiedReasonKey | "none"; surface: LeadSurface };
  /** Unqualified leads were put back (Restore, Undo, or another stage chosen). */
  leads_restored: { count: number; surface: LeadSurface };
  leads_deleted: { count: number; surface: "list" | "lead" };
  owner_set: { leadId: LeadId; cleared: boolean };
  /** inDays: days from today to the chosen date (negative for a past date). */
  followup_set: { leadId: LeadId; cleared: boolean; inDays?: number };
  notes_saved: { leadId: LeadId; cleared: boolean; length: number };
  draft_edited: AngleRef & { fields: DraftField[] };
  angle_viewed: AngleRef & { recommended: boolean };
  findings_filter_toggled: { leadId: LeadId | null; showFiltered: boolean; filteredOut: number };
  /** Which settings changed, never their values. */
  settings_saved: { fields: SettingsField[]; fieldCount: number; criteriaCount: number };
  hubspot_pushed: { leadId: LeadId; ok: boolean };
  /** A file, sheet or HubSpot list was read into the import screen. rows: how many it holds. */
  import_source_loaded: { source: ImportSource; rows: number };
  /** An import finished (in part, when a batch failed). Counts only. */
  import_completed: { source: ImportSource; created: number; duplicates: number; skipped: number };
  linkedin_url_added: NoProps;
  /** A re-run sent from the "why re-run" panel. picks: how many quick picks were used. Never the reason itself. */
  research_rerun_requested: { hasFocus: boolean; focusLength: number; picks: number };
  /** "Find email" was pressed and came back. found: whether an address was saved. */
  email_lookup_requested: { found: boolean };
  email_edited: NoProps;
  login_succeeded: NoProps;
  logged_out: NoProps;
}

export type ClientEvent = keyof ClientEventProps;

// A Record over the keys, so the compiler insists every event is listed (and nothing else).
const EVENT_LIST: Record<ClientEvent, true> = {
  lead_created: true,
  research_rerun: true,
  steer_sent: true,
  email_copied: true,
  linkedin_message_copied: true,
  gmail_opened: true,
  linkedin_profile_opened: true,
  marked_sent: true,
  stage_changed: true,
  leads_unqualified: true,
  leads_restored: true,
  leads_deleted: true,
  owner_set: true,
  followup_set: true,
  notes_saved: true,
  draft_edited: true,
  angle_viewed: true,
  findings_filter_toggled: true,
  settings_saved: true,
  hubspot_pushed: true,
  import_source_loaded: true,
  import_completed: true,
  linkedin_url_added: true,
  research_rerun_requested: true,
  email_lookup_requested: true,
  email_edited: true,
  login_succeeded: true,
  logged_out: true,
};
export const CLIENT_EVENTS = Object.keys(EVENT_LIST) as ClientEvent[];

/** Events beforeSend() lets through: ours, plus PostHog's pageview and pageleave. */
const ALLOWED_EVENTS: ReadonlySet<string> = new Set<string>([...CLIENT_EVENTS, "$pageview", "$pageleave"]);

// ------------------------------------------------------------------ property sanitiser

export type SafeValue = string | number | boolean | string[];
export type SafeProps = Record<string, SafeValue>;

/** camelCase or snake_case; no "$" (PostHog's own properties are not ours to set). */
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** Keys that name content. Their strings are never sent, whatever they look like (booleans and counts are fine). */
const CONTENT_KEY_RE = /name|mail|note|text|body|subject|message|url|uri|href|link|instruction|draft|signature|password|secret|token|apikey|phone|address|company|title/i;
/** An id, an enum value or a field name: no spaces, no "@", no "/", at most 64 characters. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** "linkedin.com", "abstract.inc", "mail.google": anything domain-like. */
const DOMAIN_RE = /[A-Za-z0-9-]\.[A-Za-z]{2,}/;
const MAX_PROPS = 30;
const MAX_LIST = 20;

/** True for a short identifier-like string; false for an email, a URL, a domain or free text. */
export function isSafeToken(value: string): boolean {
  return TOKEN_RE.test(value) && !DOMAIN_RE.test(value);
}

function cleanValue(key: string, value: unknown): SafeValue | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (CONTENT_KEY_RE.test(key)) return undefined;
  if (typeof value === "string") return isSafeToken(value) ? value : undefined;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && isSafeToken(v)).slice(0, MAX_LIST);
  return undefined;
}

/**
 * Keeps ids, counts, durations, enums and booleans. Drops nulls, objects, strings that look
 * like an email, a URL or free text, any string under a content key (name, email, notes,
 * message, url...), and keys PostHog reserves ("$..."). Never throws.
 */
export function sanitizeProps(input?: Readonly<Record<string, unknown>> | null): SafeProps {
  const out: SafeProps = {};
  if (!input || typeof input !== "object") return out;
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_PROPS) break;
    if (!KEY_RE.test(key)) continue;
    const clean = cleanValue(key, value);
    if (clean === undefined) continue;
    out[key] = clean;
    count += 1;
  }
  return out;
}

// ------------------------------------------------------------------ helpers for call sites

/**
 * The ids of ANGLE_LIBRARY in src/lib/abstract-context.ts. Copied, not imported, so the prompt
 * text kept next to them stays out of the browser bundle; scripts/test-analytics.ts fails if
 * the two lists drift apart.
 */
export const LIBRARY_ANGLE_IDS = ["checkpoint-runs-here", "drop-onboard-gpu", "one-key-many-models", "no-cold-starts", "open-llms-for-less", "gpus-for-less"] as const;
const LIBRARY_IDS: ReadonlySet<string> = new Set(LIBRARY_ANGLE_IDS);

/** An angle for analytics. A repeated library angle ("drop-onboard-gpu-2") counts as its library id. */
export function angleRef(leadId: string, angleId: string, angleIndex: number): AngleRef {
  const base = angleId.replace(/-\d+$/, "");
  const id = LIBRARY_IDS.has(angleId) ? angleId : LIBRARY_IDS.has(base) ? base : "custom";
  return { leadId, angleId: id, angleIndex };
}

/** The settings fields whose values differ between two versions (names only). */
export function changedSettingsFields(before: Settings, after: Partial<Settings>): SettingsField[] {
  return SETTINGS_FIELDS.filter((field) => after[field] !== undefined && JSON.stringify(after[field]) !== JSON.stringify(before[field]));
}

/** Whole days from now until an ISO date (rounded; negative for the past), or undefined. */
export function daysFromNow(iso: string | null | undefined): number | undefined {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.round((at - Date.now()) / 86_400_000) : undefined;
}

// ------------------------------------------------------------------ configuration

/** The same-origin path the browser sends events to; next.config.ts proxies it to PostHog. */
export const INGEST_PATH = "/ingest";

/** The config defaults snapshot this app was written against (the latest in posthog-js 1.454). */
export const POSTHOG_DEFAULTS = "2026-08-30" as const;

/** The project key, or "" when analytics is off. Only a public project key ("phc_...") is ever used. */
export function analyticsKey(): string {
  // Written out in full so Next.js inlines the value into the browser bundle at build time.
  const key = (process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "").trim();
  return /^phc_[A-Za-z0-9_-]+$/.test(key) ? key : "";
}

export interface PosthogHosts {
  region: "us" | "eu" | "custom";
  /** Ingestion API: events, flags. */
  api: string;
  /** Static assets and remote config. */
  assets: string;
  /** The PostHog app, for links. */
  ui: string;
}

const US: PosthogHosts = { region: "us", api: "https://us.i.posthog.com", assets: "https://us-assets.i.posthog.com", ui: "https://us.posthog.com" };
const EU: PosthogHosts = { region: "eu", api: "https://eu.i.posthog.com", assets: "https://eu-assets.i.posthog.com", ui: "https://eu.posthog.com" };

/**
 * PostHog's hosts for NEXT_PUBLIC_POSTHOG_HOST: US Cloud by default, EU Cloud when the host
 * names it (eu.i.posthog.com, eu.posthog.com), and any other http(s) origin as a self-hosted
 * instance. next.config.ts mirrors this for its rewrites; scripts/test-analytics.ts checks
 * that the two agree.
 */
export function posthogHosts(raw?: string | null): PosthogHosts {
  const value = raw?.trim();
  if (!value) return US;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return US;
  }
  const host = url.hostname.toLowerCase();
  if (host === "posthog.com" || host.endsWith(".posthog.com")) return /^eu[.-]/.test(host) ? EU : US;
  if (url.protocol !== "https:" && url.protocol !== "http:") return US;
  return { region: "custom", api: url.origin, assets: url.origin, ui: url.origin };
}

/**
 * PostHog's last look at every event before it is queued: anything not on our list is
 * dropped, and so is the page title (lead pages are titled with the lead's name). Nobody
 * is identified, so person properties never go out either.
 */
export function beforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!event || !ALLOWED_EVENTS.has(event.event)) return null;
  if (event.properties) delete event.properties.title;
  delete event.$set;
  delete event.$set_once;
  return event;
}

/** posthog.init() options: explicit events, pageviews and pageleaves, through /ingest, nothing else. */
export function posthogInitOptions(): Partial<PostHogConfig> {
  return {
    api_host: INGEST_PATH,
    ui_host: posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST).ui,
    defaults: POSTHOG_DEFAULTS,
    // Pageviews on every client-side route change, and a pageleave when the tab closes or
    // reloads; onRouterTransitionStart adds one when a client-side navigation leaves a page.
    capture_pageview: "history_change",
    capture_pageleave: true,
    // Explicit events only.
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    // No extra scripts and no /flags or remote-config calls: events are the only traffic.
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    // Anonymous visitors only, kept in localStorage: no cookie rides along with app requests.
    person_profiles: "identified_only",
    persistence: "localStorage",
    // The 2026 defaults would tag localhost visitors with a person property; we send none.
    internal_or_test_user_hostname: null,
    mask_personal_data_properties: true,
    save_campaign_params: false,
    before_send: beforeSend,
  };
}

// ------------------------------------------------------------------ the client

/** What this module needs from posthog-js (its default export fits). */
export interface AnalyticsClient {
  capture(
    event: string,
    properties?: Record<string, unknown> | null,
    options?: { timestamp?: Date; transport?: "XHR" | "fetch" | "sendBeacon"; send_instantly?: boolean },
  ): unknown;
  reset(): void;
}

export interface TrackOptions {
  /** A full page load follows at once (log in, log out): send now, with sendBeacon. */
  beforeUnload?: boolean;
}

interface Pending {
  event: ClientEvent;
  props: SafeProps;
  options?: TrackOptions;
  at: Date;
}

/** Events tracked before posthog-js has loaded wait here, briefly. */
const MAX_PENDING = 50;

let client: AnalyticsClient | null = null;
let pending: Pending[] = [];

function send(event: string, props: SafeProps, options?: TrackOptions, at?: Date): void {
  if (!client) return;
  try {
    client.capture(event, props, {
      ...(at ? { timestamp: at } : {}),
      ...(options?.beforeUnload ? { transport: "sendBeacon" as const, send_instantly: true } : {}),
    });
  } catch {
    // Analytics must never break the app.
  }
}

/** Called by src/instrumentation-client.ts once posthog-js has started (null detaches, for tests). */
export function attachAnalytics(next: AnalyticsClient | null): void {
  client = next;
  if (!next) return;
  const queued = pending;
  pending = [];
  for (const p of queued) send(p.event, p.props, p.options, p.at);
}

type TrackArgs<E extends ClientEvent> = [keyof ClientEventProps[E]] extends [never]
  ? [props?: ClientEventProps[E], options?: TrackOptions]
  : [props: ClientEventProps[E], options?: TrackOptions];

/** Records a product event. A no-op when analytics is off. Never throws. */
export function track<E extends ClientEvent>(event: E, ...args: TrackArgs<E>): void {
  try {
    if (!analyticsKey()) return;
    const [props, options] = args;
    const clean = sanitizeProps(props as Readonly<Record<string, unknown>> | undefined);
    if (client) send(event, clean, options);
    else if (typeof window !== "undefined" && pending.length < MAX_PENDING) pending.push({ event, props: clean, options, at: new Date() });
  } catch {
    // Analytics must never break the app.
  }
}

/**
 * For onRouterTransitionStart: a client-side navigation is about to leave this page, so
 * record the pageleave PostHog itself only sends when the tab closes. Back and forward
 * (traverse) are skipped: the address has already changed by then.
 */
export function trackNavigationStart(url: string, navigationType: string): void {
  try {
    if (!client || !analyticsKey() || navigationType === "traverse" || typeof window === "undefined") return;
    const next = new URL(url, window.location.href);
    if (next.origin === window.location.origin && next.pathname === window.location.pathname) return;
    client.capture("$pageleave");
  } catch {
    // Analytics must never break navigation.
  }
}

/** Log out: forget this browser's anonymous id, so whoever logs in next starts fresh. */
export function resetAnalytics(): void {
  try {
    if (analyticsKey()) client?.reset();
  } catch {
    // Nothing to do.
  }
}

/**
 * draft_edited fires once per angle per page view, when the typing pauses (debounced), with
 * the fields touched by then. Make one per angles editor and flush() it on unmount.
 */
export class DraftEditTracker {
  private readonly waitMs: number;
  private readonly sent = new Set<string>();
  private readonly waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; ref: AngleRef; fields: Set<DraftField> }>();

  constructor(waitMs = 2000) {
    this.waitMs = waitMs;
  }

  /** key: the angle's own id (unique on the page); ref: what is sent. */
  edited(key: string, ref: AngleRef, field: DraftField): void {
    if (!analyticsKey() || this.sent.has(key)) return;
    const entry = this.waiting.get(key);
    if (entry) clearTimeout(entry.timer);
    const fields = entry?.fields ?? new Set<DraftField>();
    fields.add(field);
    this.waiting.set(key, { timer: setTimeout(() => this.fire(key), this.waitMs), ref, fields });
  }

  /** Sends whatever is still waiting (the page is going away). */
  flush(): void {
    for (const key of [...this.waiting.keys()]) this.fire(key);
  }

  private fire(key: string): void {
    const entry = this.waiting.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.waiting.delete(key);
    this.sent.add(key);
    track("draft_edited", { ...entry.ref, fields: [...entry.fields] });
  }
}
