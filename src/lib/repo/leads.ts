import "server-only";
import { json, query } from "../db";
import { linkedinSlug, normaliseLinkedinUrl } from "../http";
import type { Lead, ResearchStatus } from "../types";
import { toLead } from "./map";

export interface CreateLeadInput {
  linkedinUrl: string;
  name?: string | null;
  companyName?: string | null;
  notes?: string | null;
  owner?: string | null;
}

export class DuplicateLeadError extends Error {
  constructor(public existingId: string) {
    super("A lead with this LinkedIn profile already exists");
  }
}

export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const url = normaliseLinkedinUrl(input.linkedinUrl);
  if (!url) throw new Error("That does not look like a LinkedIn profile URL (linkedin.com/in/...)");
  const slug = linkedinSlug(url);
  const existing = await query<{ id: string }>("select id from le_leads where linkedin_slug = $1", [slug]);
  if (existing[0]) throw new DuplicateLeadError(existing[0].id);
  const rows = await query(
    `insert into le_leads (linkedin_url, linkedin_slug, name, company_name, notes, owner)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [
      url,
      slug,
      input.name?.trim() || null,
      input.companyName?.trim() || null,
      input.notes?.trim() || null,
      input.owner?.trim() || null,
    ],
  );
  return toLead(rows[0]);
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

export type LeadPatch = Partial<Omit<Lead, "id" | "linkedinUrl" | "linkedinSlug" | "createdAt" | "updatedAt">>;

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

export async function finishResearch(
  id: string,
  status: Exclude<ResearchStatus, "running" | "idle">,
  error?: string,
): Promise<void> {
  await query(
    `update le_leads
        set research_status = $2, research_error = $3, research_step = null, research_finished_at = now(),
            stage = case when stage = 'researching' then (case when $2 = 'done' then 'researched' else 'new' end) else stage end,
            updated_at = now()
      where id = $1`,
    [id, status, error ?? null],
  );
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
