import "server-only";
import { db } from "../db";
import type { ImportCandidate, ImportMatch } from "../import/prepare";
import type { ImportSource, Stage } from "../types";
import { QUOTA_LOCK_KEYS, quotaLimit } from "./quota";

/**
 * Inserts the leads of one import in one transaction:
 *
 *   1. an advisory lock, so imports run one at a time (the duplicate check and the daily
 *      limit cannot race)
 *   2. one statement that, for each candidate, looks for an existing lead with the same
 *      LinkedIn slug, HubSpot contact id or (case-insensitive) email, or for a row with none of
 *      those, the same name and company (as imported: le_leads.import_key, migration 005, or
 *      as the lead reads now), whatever its stage (an unqualified lead is matched too, so it
 *      does not come back, and its stage is returned); inserts the rest when the
 *      daily import limit allows all of them; logs one "created" event per new lead; and
 *      records the batch in le_quota_uses (units = leads created)
 *
 * When the limit does not allow the whole batch nothing is inserted (allowed: false). Research
 * is never started here.
 */

export interface ImportOutcome {
  allowed: boolean;
  /** Leads imported in the last 24 hours before this batch. */
  used: number;
  limit: number;
  /** Candidates that matched no existing lead (inserted when allowed). */
  fresh: number;
  created: Array<{ index: number; id: string }>;
  existing: Array<{ index: number; existingId: string; match: ImportMatch; existingStage: Stage }>;
}

export const IMPORT_EVENT_MESSAGES: Record<ImportSource, string> = {
  csv: "Imported from a CSV file",
  sheet: "Imported from a Google Sheet",
  hubspot: "Imported from HubSpot",
};

const IMPORT_SQL = `
with input as (
  select *
    from unnest($1::uuid[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $14::text[])
      as t(id, idx, linkedin_url, linkedin_slug, name, company_name, title, email, notes, hubspot_contact_id, name_key)
), matched as materialized (
  select i.*, m.existing_id, m.match, m.existing_stage
    from input i
    left join lateral (
      -- One arm per key, so each uses its index; an arm whose key the row lacks is skipped.
      select c.existing_id, c.match, c.existing_stage
        from (
          select l.id as existing_id, 'linkedin' as match, 1 as rank, l.created_at, l.stage as existing_stage
            from le_leads l where i.linkedin_slug is not null and l.linkedin_slug = i.linkedin_slug
          union all
          select l.id, 'hubspot', 2, l.created_at, l.stage
            from le_leads l where i.hubspot_contact_id is not null and l.hubspot_contact_id = i.hubspot_contact_id
          union all
          select l.id, 'email', 3, l.created_at, l.stage
            from le_leads l where i.email is not null and lower(l.email) = i.email
          union all
          -- Only for a row with none of the keys above: the same name and company, case aside,
          -- as an earlier import saved them (research may have renamed the lead since), or as
          -- the lead reads now.
          select l.id, 'name', 4, l.created_at, l.stage
            from le_leads l where i.name_key is not null and l.import_key = i.name_key
          union all
          select l.id, 'name', 4, l.created_at, l.stage
            from le_leads l where i.name_key is not null and lower(btrim(l.name)) || '|' || lower(btrim(l.company_name)) = i.name_key
        ) c
       order by c.rank, c.created_at
       limit 1
    ) m on true
), fresh as materialized (
  select * from matched where existing_id is null
), used as (
  select coalesce(sum(units), 0)::bigint as n
    from le_quota_uses
   where kind = 'import' and created_at > now() - interval '24 hours'
), allowed as (
  select (select count(*) from fresh) = 0 or (select n from used) + (select count(*) from fresh) <= $12::bigint as ok
), ins as (
  insert into le_leads (id, linkedin_url, linkedin_slug, name, company_name, title, email, email_status, notes, source, hubspot_contact_id, import_key)
  select f.id, f.linkedin_url, f.linkedin_slug, f.name, f.company_name, f.title, f.email,
         case when f.email is not null then 'imported' end, f.notes, $11::text, f.hubspot_contact_id, f.name_key
    from fresh f
   where (select ok from allowed)
  returning id
), created_events as (
  insert into le_events (lead_id, type, message, data)
  select ins.id, 'created', $13::text, jsonb_build_object('source', $11::text) from ins
), quota as (
  insert into le_quota_uses (kind, units, lead_id)
  select 'import', count(*)::int, (select f.id from fresh f order by f.idx limit 1)
    from ins
  having count(*) > 0
)
select (select ok from allowed) as allowed,
       (select n from used) as used,
       (select count(*) from fresh)::int as fresh,
       coalesce((select json_agg(id) from ins), '[]'::json) as inserted,
       coalesce((select json_agg(json_build_object('idx', idx, 'existingId', existing_id, 'match', match, 'existingStage', existing_stage) order by idx)
                   from matched where existing_id is not null), '[]'::json) as existing`;

interface ImportRowResult {
  allowed: boolean;
  used: string | number;
  fresh: number;
  inserted: string[];
  existing: Array<{ idx: number; existingId: string; match: ImportMatch; existingStage: Stage }>;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

export async function insertImportedLeads(source: ImportSource, candidates: readonly ImportCandidate[]): Promise<ImportOutcome> {
  const limit = quotaLimit("import");
  if (!candidates.length) return { allowed: true, used: 0, limit, fresh: 0, created: [], existing: [] };
  const col = <K extends keyof ImportCandidate>(key: K) => candidates.map((c) => c[key]);
  const params = [
    col("id"),
    col("index"),
    col("linkedinUrl"),
    col("linkedinSlug"),
    col("name"),
    col("companyName"),
    col("title"),
    col("email"),
    col("notes"),
    col("hubspotContactId"),
    source,
    limit,
    IMPORT_EVENT_MESSAGES[source],
    col("nameKey"),
  ];
  const sql = db();
  const run = async (): Promise<ImportRowResult> => {
    const [, rows] = await sql.transaction([sql.query(`select pg_advisory_xact_lock(${QUOTA_LOCK_KEYS.import})`), sql.query(IMPORT_SQL, params)]);
    return (rows as ImportRowResult[])[0];
  };
  let row: ImportRowResult;
  try {
    row = await run();
  } catch (err) {
    // A single add (or a LinkedIn URL saved on a lead) took the same profile or HubSpot contact
    // between the check and the insert. Nothing was written; run again, and it is a duplicate.
    if (!isUniqueViolation(err)) throw err;
    row = await run();
  }
  const inserted = new Set(row.inserted);
  return {
    allowed: row.allowed,
    used: Number(row.used ?? 0),
    limit,
    fresh: Number(row.fresh ?? 0),
    created: candidates.filter((c) => inserted.has(c.id)).map((c) => ({ index: c.index, id: c.id })),
    existing: row.existing.map((e) => ({ index: e.idx, existingId: e.existingId, match: e.match, existingStage: e.existingStage })),
  };
}
