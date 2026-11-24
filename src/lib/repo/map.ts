import "server-only";
import { EMAIL_STATUSES, LEAD_SOURCES, type Finding, type Lead, type LeadEvent } from "../types";

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
/** One of a fixed set of values, else null (the database checks these too). */
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

export function toLead(r: Row): Lead {
  return {
    id: String(r.id),
    linkedinUrl: str(r.linkedin_url),
    linkedinSlug: str(r.linkedin_slug),
    name: str(r.name),
    title: str(r.title),
    companyName: str(r.company_name),
    companyDomain: str(r.company_domain),
    companyLinkedinUrl: str(r.company_linkedin_url),
    email: str(r.email),
    emailConfidence: num(r.email_confidence),
    emailStatus: oneOf(r.email_status, EMAIL_STATUSES),
    source: oneOf(r.source, LEAD_SOURCES),
    hubspotContactId: str(r.hubspot_contact_id),
    xHandle: str(r.x_handle),
    location: str(r.location),
    notes: str(r.notes),
    stage: r.stage as Lead["stage"],
    owner: str(r.owner),
    nextStepAt: iso(r.next_step_at),
    lastContactedAt: iso(r.last_contacted_at),
    researchStatus: r.research_status as Lead["researchStatus"],
    researchStep: str(r.research_step),
    researchError: str(r.research_error),
    researchStartedAt: iso(r.research_started_at),
    researchFinishedAt: iso(r.research_finished_at),
    brief: (r.brief as Lead["brief"]) ?? null,
    companyPicture: (r.company_picture as Lead["companyPicture"]) ?? null,
    angles: (r.angles as Lead["angles"]) ?? [],
    approach: (r.approach as Lead["approach"]) ?? null,
    usage: (r.usage as Lead["usage"]) ?? {},
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export function toFinding(r: Row): Finding {
  return {
    id: String(r.id),
    leadId: String(r.lead_id),
    source: r.source as Finding["source"],
    kind: r.kind as Finding["kind"],
    title: str(r.title),
    text: String(r.text),
    url: str(r.url),
    publishedAt: str(r.published_at),
    confidence: Number(r.confidence),
    relevance: Number(r.relevance),
    passesCriteria: Boolean(r.passes_criteria),
    excludedReason: str(r.excluded_reason),
    createdAt: iso(r.created_at)!,
  };
}

export function toEvent(r: Row): LeadEvent {
  return {
    id: Number(r.id),
    leadId: String(r.lead_id),
    type: r.type as LeadEvent["type"],
    message: String(r.message),
    data: r.data ?? null,
    createdAt: iso(r.created_at)!,
  };
}
