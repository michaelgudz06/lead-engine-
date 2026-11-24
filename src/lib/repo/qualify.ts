import "server-only";
import { query } from "../db";
import { cleanUnqualifiedReason, restoredEventMessages, unqualifiedEventMessage } from "../qualify";
import type { Lead } from "../types";
import { HAS_RESEARCH_SQL } from "./leads";
import { toLead } from "./map";

/**
 * Marking leads unqualified, restoring them, and deleting them, for one lead or up to a whole
 * list at once (POST /api/leads/bulk). Each is one statement: the rows are locked in id order
 * (so two bulk actions never deadlock), then updated with their "stage" events written together,
 * or deleted.
 * The rules are in SQL, and migration 006 checks them on every write:
 *
 * - stage_before_unqualified is the stage the lead had just before it was marked (never
 *   "unqualified"); it and unqualified_reason are null unless the lead is unqualified.
 * - Marking a lead that is already unqualified keeps when it was marked and the stage before;
 *   a reason replaces its old one; it logs no second event.
 * - Restoring follows restoredStage() in src/lib/qualify.ts (RESTORED_STAGE_SQL below).
 * - Research never moves a lead out of "unqualified": claimResearch, finishResearch and
 *   failStaleResearch (src/lib/repo/leads.ts) only move "new", "researched" and "researching".
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lower case, each once, in the order given. Anything that is not a UUID cannot match a lead and is dropped. */
export function uniqueLeadIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && UUID_RE.test(id)).map((id) => id.toLowerCase()))];
}

/** The leads in the order of `ids`. */
function inOrder(ids: readonly string[], leads: Lead[]): Lead[] {
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * restoredStage() (src/lib/qualify.ts) as SQL, for the SET of the restoring UPDATE: it reads
 * the row's values from before the update. The two must agree; scripts/test-api.ts checks it.
 */
export const RESTORED_STAGE_SQL = `case
  when coalesce(stage_before_unqualified, case when last_contacted_at is not null then 'contacted' else 'researching' end) = 'researching'
    or (stage_before_unqualified in ('new', 'researched') and research_started_at > unqualified_at)
  then case when research_status = 'running' then 'researching'
            when research_status = 'done' or ${HAS_RESEARCH_SQL} then 'researched'
            else 'new' end
  else coalesce(stage_before_unqualified, 'contacted')
end`;

const UNQUALIFY_SQL = `
with target as materialized (
  select id as target_id, stage as previous_stage
    from le_leads
   where id = any($1::uuid[])
   order by id
     for update
), marked as (
  update le_leads
     set stage = 'unqualified',
         unqualified_at = coalesce(unqualified_at, now()),
         stage_before_unqualified = case when stage = 'unqualified' then stage_before_unqualified else stage end,
         unqualified_reason = coalesce($2::text, case when stage = 'unqualified' then unqualified_reason end),
         updated_at = now()
    from target
   where le_leads.id = target.target_id
  returning le_leads.*, target.previous_stage
), events as (
  insert into le_events (lead_id, type, message, data)
  select id, 'stage', $3::text, jsonb_build_object('from', previous_stage, 'to', 'unqualified', 'reason', $2::text)
    from marked
   where previous_stage <> 'unqualified'
)
select * from marked`;

/**
 * Marks leads unqualified, with a "stage" event for each lead that was not unqualified yet:
 * "Marked unqualified" or "Marked unqualified: <reason>", data { from, to: "unqualified", reason }.
 * `reason` (cleaned with cleanUnqualifiedReason, at most 200 characters) is saved on every lead;
 * null gives a newly marked lead none and leaves an unqualified lead's reason as it was.
 * Returns the leads, in the order of `ids`; ids that match no lead are left out.
 */
export async function unqualifyLeads(ids: readonly string[], reason: string | null = null): Promise<Lead[]> {
  const unique = uniqueLeadIds(ids);
  if (!unique.length) return [];
  const clean = cleanUnqualifiedReason(reason);
  const rows = await query(UNQUALIFY_SQL, [unique, clean, unqualifiedEventMessage(clean)]);
  return inOrder(unique, rows.map(toLead));
}

const RESTORE_SQL = `
with target as materialized (
  select id as target_id
    from le_leads
   where id = any($1::uuid[]) and stage = 'unqualified'
   order by id
     for update
), restored as (
  update le_leads
     set stage = ${RESTORED_STAGE_SQL},
         unqualified_at = null,
         unqualified_reason = null,
         stage_before_unqualified = null,
         updated_at = now()
    from target
   where le_leads.id = target.target_id and le_leads.stage = 'unqualified'
  returning le_leads.*
), events as (
  insert into le_events (lead_id, type, message, data)
  select id, 'stage', coalesce($2::jsonb ->> stage, 'Restored from unqualified'), jsonb_build_object('from', 'unqualified', 'to', stage)
    from restored
)
select * from restored`;

/**
 * Puts unqualified leads back on the lists, on restoredStage(), with one "stage" event each:
 * "Restored from unqualified to <Label>", data { from: "unqualified", to }. The three
 * unqualified fields are cleared. Returns the restored leads, in the order of `ids`; ids with
 * no unqualified lead (none at all, or one that is not unqualified) are left out.
 */
export async function restoreLeads(ids: readonly string[]): Promise<Lead[]> {
  const unique = uniqueLeadIds(ids);
  if (!unique.length) return [];
  const rows = await query(RESTORE_SQL, [unique, JSON.stringify(restoredEventMessages())]);
  return inOrder(unique, rows.map(toLead));
}

/**
 * The bulk delete. Like the other two it locks its rows in id order first: a plain
 * `delete ... where id = any(...)` locks them in the order a scan meets them, which can
 * deadlock against a bulk unqualify or restore of the same leads. Exported so
 * scripts/test-api.ts can check its plan.
 */
export const DELETE_LEADS_SQL = `
with target as materialized (
  select id as target_id
    from le_leads
   where id = any($1::uuid[])
   order by id
     for update
)
delete from le_leads
 using target
 where le_leads.id = target.target_id
returning le_leads.id`;

/**
 * Deletes leads for good, like DELETE /api/leads/[id]: findings, events and raw data go with
 * them (on delete cascade); usage rows stay, with the lead's name (on delete set null); run and
 * quota rows stay too (no foreign key, so deleting leads gives no runs or imports back).
 * Returns the ids deleted, in the order of `ids`.
 */
export async function deleteLeads(ids: readonly string[]): Promise<string[]> {
  const unique = uniqueLeadIds(ids);
  if (!unique.length) return [];
  const rows = await query<{ id: string }>(DELETE_LEADS_SQL, [unique]);
  const gone = new Set(rows.map((r) => String(r.id)));
  return unique.filter((id) => gone.has(id));
}
