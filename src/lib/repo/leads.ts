import "server-only";
import { json, query } from "../db";
import { linkedinSlug, normaliseLinkedinUrl } from "../http";
import { cleanUnqualifiedReason, stageEventMessages } from "../qualify";
import { LEAD_LIST_LIMIT, type EmailStatus, type Lead, type LeadCounts, type LeadSource, type LeadView, type ResearchStatus, type Stage } from "../types";
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
  /** existingStage: the other lead's stage (null when not known), so a reply can say it is unqualified. */
  constructor(
    public existingId: string,
    public existingStage: Stage | null = null,
  ) {
    super("A lead with this LinkedIn profile already exists");
  }
}

/** Postgres unique_violation, as the Neon driver reports it. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** The lead (other than exceptId) that has this LinkedIn slug, with its stage. */
export async function leadWithSlug(slug: string | null, exceptId?: string): Promise<{ id: string; stage: Stage } | null> {
  if (!slug) return null;
  const rows = await query<{ id: string; stage: Stage }>(
    "select id, stage from le_leads where linkedin_slug = $1 and ($2::uuid is null or id <> $2::uuid) limit 1",
    [slug, exceptId ?? null],
  );
  return rows[0] ? { id: String(rows[0].id), stage: rows[0].stage } : null;
}

export async function createLead(input: CreateLeadInput): Promise<Lead> {
  const url = normaliseLinkedinUrl(input.linkedinUrl);
  if (!url) throw new Error("That does not look like a LinkedIn profile URL (linkedin.com/in/...)");
  const slug = linkedinSlug(url);
  const existing = await leadWithSlug(slug);
  if (existing) throw new DuplicateLeadError(existing.id, existing.stage);
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
 * A different profile is a different person to reach: the lead's warm paths (le_warm_paths) are
 * deleted and its list summary cleared, in the same statement (clearing the URL counts as a
 * change). A first profile for a lead that had none is the same person: its paths, intro drafts,
 * typed Instagram handle and X check are kept, and the next view redoes the free part.
 */
export async function setLeadLinkedin(id: string, linkedinUrl: string | null, opts: { onlyIfMissing?: boolean } = {}): Promise<Lead | null> {
  const url = linkedinUrl === null ? null : normaliseLinkedinUrl(linkedinUrl);
  if (linkedinUrl !== null && !url) throw new Error("That does not look like a LinkedIn profile URL (linkedin.com/in/...)");
  const slug = url ? linkedinSlug(url) : null;
  const other = await leadWithSlug(slug, id);
  if (other) throw new DuplicateLeadError(other.id, other.stage);
  try {
    const rows = await query(
      `with prev as materialized (
         select id as prev_id, linkedin_slug as prev_slug from le_leads where id = $1::uuid for update
       ), updated as (
         update le_leads l
            set linkedin_url = $2, linkedin_slug = $3::text,
                warm_path = case when prev.prev_slug is not null and prev.prev_slug is distinct from $3::text then null else l.warm_path end,
                updated_at = now()
           from prev
          where l.id = prev.prev_id ${opts.onlyIfMissing ? "and l.linkedin_url is null" : ""}
         returning l.*, prev.prev_slug
       ), gone as (
         delete from le_warm_paths w using updated u where w.lead_id = u.id and u.prev_slug is not null and u.prev_slug is distinct from $3::text
       )
       select * from updated`,
      [id, url, slug],
    );
    return rows[0] ? toLead(rows[0]) : null;
  } catch (err) {
    // Another lead took the profile between the check and the update: the unique index stopped it.
    if (isUniqueViolation(err)) {
      const raced = await leadWithSlug(slug, id);
      if (raced) throw new DuplicateLeadError(raced.id, raced.stage);
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

/**
 * One list, at most LEAD_LIST_LIMIT (500) leads. "active" (the Leads and Pipeline pages): every
 * stage but unqualified, most recently updated first. "unqualified" (the Unqualified view): most
 * recently marked first. The id breaks ties, so a batch marked or restored at once keeps its
 * order between polls. The predicates are literals, so the partial indexes from migration 006 apply.
 */
export async function listLeads(view: LeadView = "active"): Promise<Lead[]> {
  const rows =
    view === "unqualified"
      ? await query(`select * from le_leads where stage = 'unqualified' order by unqualified_at desc, id limit ${LEAD_LIST_LIMIT}`)
      : await query(`select * from le_leads where stage <> 'unqualified' order by updated_at desc, id limit ${LEAD_LIST_LIMIT}`);
  return rows.map(toLead);
}

/** How many leads each list has in all (not capped at LEAD_LIST_LIMIT), in one query. */
export async function countLeads(): Promise<LeadCounts> {
  const rows = await query<{ active: number; unqualified: number }>(
    `select count(*) filter (where stage <> 'unqualified')::int as active,
            count(*) filter (where stage = 'unqualified')::int as unqualified
       from le_leads`,
  );
  return { active: Number(rows[0]?.active ?? 0), unqualified: Number(rows[0]?.unqualified ?? 0) };
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
  warmPath: { col: "warm_path", json: true },
};

/**
 * The LinkedIn profile changes through setLeadLinkedin (it must stay unique); source and HubSpot
 * id are set once, on import; unqualifiedAt and stageBeforeUnqualified follow the stage.
 */
export type LeadPatch = Partial<
  Omit<Lead, "id" | "linkedinUrl" | "linkedinSlug" | "source" | "hubspotContactId" | "unqualifiedAt" | "stageBeforeUnqualified" | "createdAt" | "updatedAt">
>;

/**
 * SET clauses for patch.stage and patch.unqualifiedReason. In SQL, from the row as it is, so
 * every caller obeys the unqualified rules (migration 006 checks them as well):
 * - to "unqualified": unqualified_at and stage_before_unqualified are set when the lead is
 *   marked. Marking a lead that is already unqualified keeps both, and its reason unless the
 *   patch has one.
 * - to any other stage: all three unqualified fields are cleared.
 * - unqualifiedReason (cleaned with cleanUnqualifiedReason) is saved only when the lead is
 *   unqualified after the update (the PATCH route refuses it otherwise); null or "" clears it.
 */
function stageSets(patch: LeadPatch, param: (value: unknown) => string): string[] {
  const sets: string[] = [];
  const stage = patch.stage === undefined ? "stage" : `${param(patch.stage)}::text`;
  if (patch.stage !== undefined) {
    sets.push(
      `stage = ${stage}`,
      `unqualified_at = case when ${stage} = 'unqualified' then coalesce(unqualified_at, now()) end`,
      `stage_before_unqualified = case when ${stage} = 'unqualified' then (case when stage = 'unqualified' then stage_before_unqualified else stage end) end`,
    );
  }
  if (patch.unqualifiedReason !== undefined) {
    sets.push(`unqualified_reason = case when ${stage} = 'unqualified' then ${param(cleanUnqualifiedReason(patch.unqualifiedReason))}::text end`);
  } else if (patch.stage !== undefined) {
    sets.push(`unqualified_reason = case when ${stage} = 'unqualified' then unqualified_reason end`);
  }
  return sets;
}

export interface UpdateLeadOptions {
  /**
   * When the stage changes, write its one "stage" event in the same statement (the PATCH route):
   * "Marked unqualified[: reason]" { from, to: "unqualified", reason } when the lead becomes
   * unqualified, else "Stage changed from X to Y" { from, to }. Nothing when the stage stays.
   * The event is written after the row lock, as the bulk actions write theirs, so the Activity
   * log lists stage changes in the order they happened, even when a bulk action races this update.
   */
  logStage?: boolean;
}

/**
 * updateLead, plus the stage the lead had just before this update: read and locked in the same
 * statement (FOR UPDATE), so a concurrent change cannot make it stale. Null when the lead does
 * not exist.
 */
export async function updateLeadWithPrevious(id: string, patch: LeadPatch, opts: UpdateLeadOptions = {}): Promise<{ lead: Lead; previousStage: Stage } | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  for (const [key, value] of Object.entries(patch)) {
    const spec = PATCHABLE[key];
    if (!spec || value === undefined) continue;
    sets.push(`${spec.col} = ${param(spec.json ? json(value) : value)}${spec.json ? "::jsonb" : ""}`);
  }
  sets.push(...stageSets(patch, param));
  if (!sets.length) {
    const lead = await getLead(id);
    return lead ? { lead, previousStage: lead.stage } : null;
  }
  const idRef = `${param(id)}::uuid`;
  if (patch.stage === undefined) {
    // The stage does not change here, so the one it had is the one it has.
    const rows = await query(`update le_leads set ${sets.join(", ")}, updated_at = now() where id = ${idRef} returning *`, params);
    if (!rows[0]) return null;
    const lead = toLead(rows[0]);
    return { lead, previousStage: lead.stage };
  }
  // A lead that becomes unqualified here was not unqualified before, so its reason once marked is
  // the patch's (cleaned as stageSets saves it) or none.
  const messages = opts.logStage
    ? param(json(stageEventMessages(patch.stage, patch.unqualifiedReason === undefined ? null : cleanUnqualifiedReason(patch.unqualifiedReason))))
    : null;
  const rows = await query(
    `with prev as materialized (
       select id as prev_id, stage as prev_stage from le_leads where id = ${idRef} for update
     ), updated as (
       update le_leads set ${sets.join(", ")}, updated_at = now()
         from prev
        where le_leads.id = prev.prev_id
       returning le_leads.*, prev.prev_stage
     )${
       messages
         ? `, logged as (
       insert into le_events (lead_id, type, message, data)
       select id, 'stage', coalesce(${messages}::jsonb ->> prev_stage, 'Stage changed'),
              case when stage = 'unqualified'
                   then jsonb_build_object('from', prev_stage, 'to', stage, 'reason', unqualified_reason)
                   else jsonb_build_object('from', prev_stage, 'to', stage) end
         from updated
        where prev_stage <> stage
     )`
         : ""
     }
     select * from updated`,
    params,
  );
  return rows[0] ? { lead: toLead(rows[0]), previousStage: rows[0].prev_stage as Stage } : null;
}

export async function updateLead(id: string, patch: LeadPatch, opts: UpdateLeadOptions = {}): Promise<Lead | null> {
  return (await updateLeadWithPrevious(id, patch, opts))?.lead ?? null;
}

/** Deletes the lead for good: its findings, events and raw data go with it (on delete cascade); usage rows keep its name. */
export async function deleteLead(id: string): Promise<boolean> {
  const rows = await query("delete from le_leads where id = $1 returning id", [id]);
  return rows.length > 0;
}

/**
 * Atomically marks research as running. Returns false if a run is already in
 * progress (started less than 15 minutes ago), so two clicks never start two runs.
 * Only "new" and "researched" move to "researching": any other stage, "unqualified" included,
 * stays as it is.
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
export const HAS_RESEARCH_SQL = `(jsonb_typeof(brief) = 'object'
  or (case when jsonb_typeof(angles) = 'array' then jsonb_array_length(angles) > 0 else false end))`;

/**
 * Records how a run ended. Only a lead still "researching" moves on (to "researched" or "new"):
 * a stage changed during the run, "unqualified" included, is kept, and the run's other writes
 * (brief, angles, research_status) land either way.
 */
export async function finishResearch(
  id: string,
  status: Exclude<ResearchStatus, "running" | "idle">,
  error?: string,
): Promise<void> {
  await query(
    `update le_leads
        set research_status = $2, research_error = $3, research_step = null, research_finished_at = now(),
            stage = case when stage = 'researching' then (case when $2 = 'done' or ${HAS_RESEARCH_SQL} then 'researched' else 'new' end) else stage end,
            updated_at = now()
      where id = $1`,
    [id, status, error ?? null],
  );
}

/**
 * Marks a run that has been 'running' for longer than `olderThanMs` as failed (it was
 * lost: the function was killed or the server restarted), with finishResearch's stage
 * rule (an unqualified lead stays unqualified). False when there is no such run: it finished
 * meanwhile, or it is younger.
 */
export async function failStaleResearch(id: string, olderThanMs: number, error: string): Promise<boolean> {
  const rows = await query(
    `update le_leads
        set research_status = 'error', research_error = $2, research_step = null, research_finished_at = now(),
            stage = case when stage = 'researching' then (case when ${HAS_RESEARCH_SQL} then 'researched' else 'new' end) else stage end,
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
