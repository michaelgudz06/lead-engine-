/**
 * Shared domain types. Safe to import from client and server code.
 * Database columns are snake_case; these types are camelCase. The repo layer
 * (src/lib/repo) is the only place that maps between them.
 */
import type { WarmPathSummary, WarmPaths } from "./paths/types";

/**
 * "unqualified" is last and apart from the rest: the lead stays in the database (a re-import
 * still finds it) but leaves the Leads and Pipeline pages for the Unqualified view until it is
 * restored. "lost" is different: a real opportunity that did not close.
 */
export const STAGES = [
  "new",
  "researching",
  "researched",
  "contacted",
  "replied",
  "call_booked",
  "nurture",
  "lost",
  "unqualified",
] as const;
export type Stage = (typeof STAGES)[number];

/** A stage a lead on the Leads and Pipeline pages can have: every stage but "unqualified". */
export type ActiveStage = Exclude<Stage, "unqualified">;

/** STAGES without "unqualified": the Pipeline's columns, and the stages a restore can lead to. */
export const ACTIVE_STAGES: readonly ActiveStage[] = STAGES.filter((s): s is ActiveStage => s !== "unqualified");

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  researching: "Researching",
  researched: "Researched",
  contacted: "Contacted",
  replied: "Replied",
  call_booked: "Call booked",
  nurture: "Nurture",
  lost: "Lost",
  unqualified: "Unqualified",
};

/**
 * Quick picks for why a lead is unqualified. The database stores the text, not the key: one of
 * these labels, or the team's own words (at most UNQUALIFIED_REASON_MAX characters).
 */
export const UNQUALIFIED_REASONS = [
  { key: "not_fit", label: "Not a fit" },
  { key: "wrong_person", label: "Wrong person" },
  { key: "no_need", label: "No need right now" },
  { key: "competitor", label: "Competitor or partner" },
  { key: "bad_data", label: "Bad or duplicate data" },
] as const;
export type UnqualifiedReasonKey = (typeof UNQUALIFIED_REASONS)[number]["key"];

/** The longest reason the API and the database accept. */
export const UNQUALIFIED_REASON_MAX = 200;

/** The two lists GET /api/leads?view= serves: "active" (the Leads and Pipeline pages) and "unqualified". */
export const LEAD_VIEWS = ["active", "unqualified"] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];

/** How many leads each list has in all. A list itself returns at most LEAD_LIST_LIMIT. */
export interface LeadCounts {
  active: number;
  unqualified: number;
}

/** The most leads one list returns. */
export const LEAD_LIST_LIMIT = 500;

/** The most ids POST /api/leads/bulk takes at once: one full list. */
export const BULK_LEADS_MAX = 500;

export type ResearchStatus = "idle" | "running" | "done" | "error";

export const SOURCES = ["linkedin", "apollo", "hunter", "exa", "x", "huggingface", "abstract", "notes", "agent"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  linkedin: "LinkedIn",
  apollo: "Apollo",
  hunter: "Hunter",
  exa: "Web",
  x: "X",
  huggingface: "Hugging Face",
  abstract: "Abstract",
  notes: "Your notes",
  agent: "Agent",
};

export const FINDING_KINDS = [
  "role",
  "career",
  "company",
  "post",
  "talk",
  "paper",
  "news",
  "hiring",
  "product",
  "repo",
  "model",
  "funding",
  "email",
  "personal",
  "other",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** One atomic, sourced fact about the person or their company. */
export interface Finding {
  id: string;
  leadId: string;
  source: Source;
  kind: FindingKind;
  title: string | null;
  text: string;
  url: string | null;
  publishedAt: string | null;
  /** 0..1, how sure we are this is about the right person/company. */
  confidence: number;
  /** 0..1, how useful this is for an Abstract outreach. */
  relevance: number;
  /** False when a criteria rule filtered it out of the brief. */
  passesCriteria: boolean;
  excludedReason: string | null;
  createdAt: string;
}

export interface NewFinding {
  source: Source;
  kind: FindingKind;
  title?: string | null;
  text: string;
  url?: string | null;
  publishedAt?: string | null;
  confidence?: number;
  relevance?: number;
  passesCriteria?: boolean;
  excludedReason?: string | null;
}

/** A claim in the brief. findingIds must reference Finding.id values of this lead. */
export interface Cited {
  text: string;
  findingIds: string[];
}

export interface Brief {
  /** Two or three sentences: who they are and why they matter to Abstract now. */
  summary: string;
  bullets: Cited[];
  pains: Cited[];
  objections: string[];
  questions: string[];
}

export interface CompanyPicture {
  name: string | null;
  domain: string | null;
  oneLiner: string | null;
  headcount: string | null;
  growth: string | null;
  funding: string | null;
  team: Cited[];
  hiring: Cited[];
  robotsAndModels: Cited[];
  decisionMakers: Cited[];
}

export interface Draft {
  subject: string;
  body: string;
}

export interface Angle {
  id: string;
  name: string;
  /** Why this angle fits this person, in one or two sentences. */
  reasoning: string;
  findingIds: string[];
  email: Draft;
  /** Under 300 characters: fits a LinkedIn connection note. */
  linkedinMessage: string;
}

export interface Approach {
  leadAngleId: string | null;
  channel: "email" | "linkedin" | "either";
  why: string;
  firstCallQuestions: string[];
  dealBreakers: string[];
}

/** Where a lead came from: the single-add form, or an import from a CSV file, a Google Sheet or HubSpot. */
export const LEAD_SOURCES = ["manual", "csv", "sheet", "hubspot"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
/** The sources an import can name. */
export type ImportSource = Exclude<LeadSource, "manual">;

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  manual: "Added by hand",
  csv: "CSV file",
  sheet: "Google Sheet",
  hubspot: "HubSpot",
};

/**
 * What kind of address Lead.email is.
 * - found: Hunter's Email Finder returned it (emailConfidence is Hunter's score).
 * - verified: built from the company's email pattern and verified by Hunter (the verifier's score).
 * - guess: built from the pattern on a domain that accepts every address, so it cannot be verified (50).
 * - imported: came with an import. manual: typed in on the lead page. Research never replaces these two.
 */
export const EMAIL_STATUSES = ["found", "verified", "guess", "imported", "manual"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  found: "Found by Hunter",
  verified: "Verified",
  guess: "Best guess",
  imported: "Imported",
  manual: "Added by hand",
};

/** One line on each status, for a tooltip or a note under the address. */
export const EMAIL_STATUS_HINTS: Record<EmailStatus, string> = {
  found: "Hunter found this address.",
  verified: "Built from the company's email pattern, and Hunter checked that it can receive mail.",
  guess: "Built from the company's email pattern. Their mail server accepts every address, so it could not be checked.",
  imported: "This address came with your import.",
  manual: "You added this address.",
};

export interface Lead {
  id: string;
  /** Null for an imported contact whose profile is not known yet: research looks for it first. */
  linkedinUrl: string | null;
  linkedinSlug: string | null;
  name: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyLinkedinUrl: string | null;
  email: string | null;
  emailConfidence: number | null;
  /** What kind of address `email` is; null when there is no email (or for an address from before this was tracked). */
  emailStatus: EmailStatus | null;
  /** Null for leads added before sources were tracked. */
  source: LeadSource | null;
  /** The HubSpot contact the lead was imported from. */
  hubspotContactId: string | null;
  xHandle: string | null;
  location: string | null;
  notes: string | null;
  stage: Stage;
  /** When the lead was marked unqualified. Set exactly while stage is "unqualified", else null. */
  unqualifiedAt: string | null;
  /** Why it was marked (a reason's label or the team's own words); null when none was given, and always null unless unqualified. */
  unqualifiedReason: string | null;
  /** The stage it had just before it was marked, which Restore goes back to (see restoredStage). Null unless unqualified. */
  stageBeforeUnqualified: ActiveStage | null;
  owner: string | null;
  nextStepAt: string | null;
  lastContactedAt: string | null;
  researchStatus: ResearchStatus;
  researchStep: string | null;
  researchError: string | null;
  researchStartedAt: string | null;
  researchFinishedAt: string | null;
  brief: Brief | null;
  companyPicture: CompanyPicture | null;
  angles: Angle[];
  approach: Approach | null;
  /** Running totals, e.g. { claudeInputTokens, claudeOutputTokens, xPosts }. */
  usage: Record<string, number>;
  /** The best Strong or Medium warm path, for the list chips; null when there is none (src/lib/paths/types.ts). */
  warmPath: WarmPathSummary | null;
  createdAt: string;
  updatedAt: string;
}

export const EVENT_TYPES = [
  "created",
  "step",
  "tool",
  "finding",
  "done",
  "error",
  "steer",
  "copied",
  "sent",
  "stage",
  "hubspot",
  "note",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface LeadEvent {
  id: number;
  leadId: string;
  type: EventType;
  message: string;
  data: unknown;
  createdAt: string;
}

export interface Settings {
  senderName: string;
  senderEmail: string;
  calendlyUrl: string;
  signature: string;
  /** Plain-English rules. Findings that break one stay out of the brief. */
  criteria: string[];
  followUpDays: number;
  /**
   * The owner's public usernames for warm paths ("" when not given): their X handle (without "@",
   * [A-Za-z0-9_]{1,15}), Instagram handle ([A-Za-z0-9._]{1,30}, only shows an Instagram row) and
   * LinkedIn profile URL (their roles and schools are read from it). Never a list or a token.
   */
  xHandle: string;
  instagramHandle: string;
  linkedinUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  senderName: "",
  senderEmail: "",
  calendlyUrl: "",
  signature: "",
  xHandle: "",
  instagramHandle: "",
  linkedinUrl: "",
  criteria: [
    "Keep to professional signals. Leave out family, health, relationships, religion, politics and home life.",
    "Prefer the last 12 months. Older items only for career history.",
    "Flag anything about latency, onboard GPUs, inference cost, cold starts, cloud inference or switching models.",
    "Flag the robots, arms and models they use, especially YAM, ARX X5, Franka, pi0.5 and MolmoAct2.",
  ],
  followUpDays: 4,
};

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  /** One line: what it is used for, or why it is off. */
  detail: string;
}

/** Shape returned by GET /api/leads/[id]. paths: the warm-paths panel (null when there is nothing to show yet). */
export interface LeadDetail {
  lead: Lead;
  findings: Finding[];
  events: LeadEvent[];
  paths?: WarmPaths | null;
}
