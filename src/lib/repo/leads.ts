import "server-only";
import { json, query } from "../db";
import { linkedinSlug, normaliseLinkedinUrl } from "../http";
import type { EmailStatus, Lead, LeadSource, ResearchStatus } from "../types";
import { toLead } from "./map";

export interface CreateLeadInput {
  /** The single-add form always has one; imports go through importLeads (src/lib/repo/import.ts). */
  linkedinUrl: string;
  name?: string | null;
  companyName?: string | null;
  notes?: string | null;
  owner?: string | null;
  /** Default "manual" (the single-add form). */
  source?: LeadSource;
}

export class DuplicateLeadError extends Error {
  constructor(public existingId: string) {
    super("A lead with this LinkedIn profile already exists");
  }
}

/** Postgres unique_violation, as the Neon driver reports it. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

async function leadIdWithSlug(slug: string | null, exceptId?: string): Promise<string | null> {
  if (!slug) return null;
  const rows = await query<{ id: string }>(
    "select id from le_leads where linkedin_slug = $1 and ($2::uuid is null or id <> $2::uuid) limit 1",
    [slug, exceptId ?? null],
  );
  return rows[0]?.id ?? null;
}

export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const url = normaliseLinkedinUrl(input.linkedinUrl);
  if (!url) throw new Error("That does not look like a LinkedIn profile URL (linkedin.com/in/...)");
  const slug = linkedinSlug(url);
  const existing = await leadIdWithSlug(slug);
  if (existing) throw new DuplicateLeadError(existing);
  const rows = await query(
    `insert into le_leads (linkedin_url, linkedin_slug, name, company_name, notes, owner, source)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [
      url,
      slug,
      input.name?.trim() || null,
      input.companyName?.trim() || null,
      input.notes?.trim() || null,
      input.owner?.trim() || null,
      input.source ?? "manual",
    ],
  );
  return toLead(rows[0]);
}

/**
 * Sets (or, with null, clears) the lead's LinkedIn profile: the normalised URL and its slug.
 * Throws DuplicateLeadError when another lead already has the profile, and an Error for a URL
 * that is not a LinkedIn profile. `onlyIfMissing` changes nothing when the lead got a URL in
 * the meantime (research saving a profile it found). Null when the lead does not exist, or
 * (with onlyIfMissing) already had a URL.
 */
export async function setLeadLinkedin(id: string, linkedinUrl: string | null, opts: { onlyIfMissing?: boolean } = {}): Promise<Lead | null> {
  const url = linkedinUrl === null ? null : normaliseLinkedinUrl(linkedinUrl);
  if (linkedinUrl !== null && !url) throw new Error("That does not look like a LinkedIn profile URL (linkedin.com/in/...)");
  const slug = url ? linkedinSlug(url) : null;
  const other = await leadIdWithSlug(slug, id);
  if (other) throw new DuplicateLeadError(other);
  try {
    const rows = await query(
      `update le_leads set linkedin_url = $2, linkedin_slug = $3, updated_at = now()
        where id = $1 ${opts.onlyIfMissing ? "and linkedin_url is null" : ""}
        returning *`,
      [id, url, slug],
    );
    return rows[0] ? toLead(rows[0]) : null;
  } catch (err) {
    // Another lead took the profile between the check and the update: the unique index stopped it.
    if (isUniqueViolation(err)) {
      const raced = await leadIdWithSlug(slug, id);
      if (raced) throw new DuplicateLeadError(raced);
    }
    throw err;
  }
}

/** Addresses a lookup may replace: none at all, or one an earlier lookup found. Never one the team typed in or imported. */
const REPLACEABLE_EMAIL = `(email is null
  or email_status in ('found', 'verified', 'guess')
  or (email_status is null and email_confidence is not null))`;

/**
 * Saves an address an email lookup found, with its kind and confidence. `replace` "empty" saves
 * only when the lead has no email (a research run: the teammate may have typed one in while it
 * ran); "lookup" may also replace an address an earlier lookup found. An address the team typed
 * in or imported is never replaced. Null when nothing was saved.
 */
export async function saveFoundEmail(
  id: string,
  found: { email: string; emailStatus: Extract<EmailStatus, "found" | "verified" | "guess">; emailConfidence: number | null },
  replace: "empty" | "lookup" = "empty",
): Promise<Lead | null> {
  const rows = await query(
    `update le_leads set email = $2, email_status = $3, email_confidence = $4, updated_at = now()
      where id = $1 and ${replace === "empty" ? "email is null" : REPLACEABLE_EMAIL}
      returning *`,
    [id, found.email, found.emailStatus, found.emailConfidence],
  );
  return rows[0] ? toLead(rows[0]) : null;
}

export async function getLead(id: string): Promise<Lead | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await query("select * from le_leads where id = $1", [id]);
  return rows[0] ? toLead(rows[0]) : null;
}

export async function listLeads(): Promise<Lead[]> {
  const rows = await query("select * from le_leads order by updated_at desc limit 500");
  return rows.map(toLead);
}

/** Columns the app may patch, camelCase -> snake_case. jsonb columns are flagged. */
const PATCHABLE: Record<string, { col: string; json?: boolean }> = {
  name: { col: "name" },
  title: { col: "title" },
  companyName: { col: "company_name" },
  companyDomain: { col: "company_domain" },
  companyLinkedinUrl: { col: "company_linkedin_url" },
  email: { col: "email" },
  emailConfidence: { col: "email_confidence" },
  emailStatus: { col: "email_status" },
  xHandle: { col: "x_handle" },
  location: { col: "location" },
  notes: { col: "notes" },
  stage: { col: "stage" },
  owner: { col: "owner" },
  nextStepAt: { col: "next_step_at" },
  lastContactedAt: { col: "last_contacted_at" },
  researchStatus: { col: "research_status" },
  researchStep: { col: "research_step" },
  researchError: { col: "research_error" },
  researchStartedAt: { col: "research_started_at" },
  researchFinishedAt: { col: "research_finished_at" },
  brief: { col: "brief", json: true },
  companyPicture: { col: "company_picture", json: true },
  angles: { col: "angles", json: true },
  approach: { col: "approach", json: true },
  usage: { col: "usage", json: true },
};

/** The LinkedIn profile changes through setLeadLinkedin (it must stay unique); source and HubSpot id are set once, on import. */
export type LeadPatch = Partial<Omit<Lead, "id" | "linkedinUrl" | "linkedinSlug" | "source" | "hubspotContactId" | "createdAt" | "updatedAt">>;

export async function updateLead(id: string, patch: LeadPatch): Promise<Lead | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const spec = PATCHABLE[key];
    if (!spec || value === undefined) continue;
    params.push(spec.json ? json(value) : value);
    sets.push(`${spec.col} = $${params.length}${spec.json ? "::jsonb" : ""}`);
  }
  if (!sets.length) return getLead(id);
  params.push(id);
  const rows = await query(
    `update le_leads set ${sets.join(", ")}, updated_at = now() where id = $${params.length} returning *`,
    params,
  );
  return rows[0] ? toLead(rows[0]) : null;
}

export async function deleteLead(id: string): Promise<boolean> {
  const rows = await query("delete from le_leads where id = $1 returning id", [id]);
  return rows.length > 0;
}

/**
 * Atomically marks research as running. Returns false if a run is already in
 * progress (started less than 15 minutes ago), so two clicks never start two runs.
 */
export async function claimResearch(id: string): Promise<boolean> {
  const rows = await query(
    `update le_leads
        set research_status = 'running', research_step = 'Starting', research_error = null,
            research_started_at = now(), research_finished_at = null,
            stage = case when stage in ('new', 'researched') then 'researching' else stage end,
            updated_at = now()
      where id = $1
        and (research_status <> 'running' or research_started_at < now() - interval '15 minutes')
      returning id`,
    [id],
  );
  return rows.length > 0;
}

export async function setResearchStep(id: string, step: string): Promise<void> {
  await query("update le_leads set research_step = $2, updated_at = now() where id = $1", [id, step]);
}

/**
 * SQL: the lead still has a brief or angles from an earlier run. A run that ends
 * without 'done' (a failed re-run or steer) then leaves the lead 'researched', not
 * 'new'. Typed checks, so a JSON null or an odd shape counts as nothing instead of
 * failing the update.
 */
const HAS_RESEARCH = `(jsonb_typeof(brief) = 'object'
  or (case when jsonb_typeof(angles) = 'array' then jsonb_array_length(angles) > 0 else false end))`;

export async function finishResearch(
  id: string,
  status: Exclude<ResearchStatus, "running" | "idle">,
  error?: string,
): Promise<void> {
  await query(
    `update le_leads
        set research_status = $2, research_error = $3, research_step = null, research_finished_at = now(),
            stage = case when stage = 'researching' then (case when $2 = 'done' or ${HAS_RESEARCH} then 'researched' else 'new' end) else stage end,
            updated_at = now()
      where id = $1`,
    [id, status, error ?? null],
  );
}

/**
 * Marks a run that has been 'running' for longer than `olderThanMs` as failed (it was
 * lost: the function was killed or the server restarted), with finishResearch's stage
 * rule. False when there is no such run: it finished meanwhile, or it is younger.
 */
export async function failStaleResearch(id: string, olderThanMs: number, error: string): Promise<boolean> {
  const rows = await query(
    `update le_leads
        set research_status = 'error', research_error = $2, research_step = null, research_finished_at = now(),
            stage = case when stage = 'researching' then (case when ${HAS_RESEARCH} then 'researched' else 'new' end) else stage end,
            updated_at = now()
      where id = $1 and research_status = 'running'
        and research_started_at < now() - make_interval(secs => $3)
      returning id`,
    [id, error, olderThanMs / 1000],
  );
  return rows.length > 0;
}

/** Adds to the lead's usage counters, e.g. { claudeInputTokens: 1200 }. */
export async function addUsage(id: string, delta: Record<string, number>): Promise<void> {
  if (!Object.keys(delta).length) return;
  await query(
    `update le_leads
        set usage = usage || (
          select coalesce(jsonb_object_agg(d.key, coalesce((le_leads.usage ->> d.key)::numeric, 0) + d.value::numeric), '{}'::jsonb)
            from jsonb_each_text($2::jsonb) as d
        )
      where id = $1`,
    [id, json(delta)],
  );
}
