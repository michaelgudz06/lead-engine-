/**
 * Shared domain types. Safe to import from client and server code.
 * Database columns are snake_case; these types are camelCase. The repo layer
 * (src/lib/repo) is the only place that maps between them.
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
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  researching: "Researching",
  researched: "Researched",
  contacted: "Contacted",
  replied: "Replied",
  call_booked: "Call booked",
  nurture: "Nurture",
  lost: "Lost",
};

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

export interface Lead {
  id: string;
  linkedinUrl: string;
  linkedinSlug: string | null;
  name: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  companyLinkedinUrl: string | null;
  email: string | null;
  emailConfidence: number | null;
  xHandle: string | null;
  location: string | null;
  notes: string | null;
  stage: Stage;
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
}

export const DEFAULT_SETTINGS: Settings = {
  senderName: "",
  senderEmail: "",
  calendlyUrl: "",
  signature: "",
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

/** Shape returned by GET /api/leads/[id]. */
export interface LeadDetail {
  lead: Lead;
  findings: Finding[];
  events: LeadEvent[];
}
