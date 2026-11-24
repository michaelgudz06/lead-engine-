-- 006: unqualified leads. Marking a lead unqualified keeps it in the database (so a re-import
-- still finds it and it does not come back) but takes it off the Leads and Pipeline pages, into
-- an Unqualified view, until someone restores it. "unqualified" is its own stage, apart from
-- "lost" (a real opportunity that did not close).
--
-- Additive and safe for the code that was live before it: that code never writes 'unqualified'
-- and never reads or writes the new columns, so every row it inserts or updates keeps them null,
-- and null passes every check below. That code cannot show an unqualified lead, though: its Leads
-- and Pipeline pages fail while any lead is unqualified. Before rolling back to it (a Vercel
-- Instant Rollback, or any older build on this database), restore every unqualified lead first
-- (README, "Rolling back"). This migration can stay applied.

-- The stage list gains 'unqualified', last. Dropped and added again in this one transaction.
alter table le_leads drop constraint if exists le_leads_stage_chk;

alter table le_leads add constraint le_leads_stage_chk
  check (stage in ('new', 'researching', 'researched', 'contacted', 'replied', 'call_booked', 'nurture', 'lost', 'unqualified'));

-- When the lead was marked unqualified.
alter table le_leads add column if not exists unqualified_at timestamptz;

-- Why: a reason's label ("Not a fit") or the team's own words, at most 200 characters.
alter table le_leads add column if not exists unqualified_reason text;

-- The stage the lead had just before it was marked, where restoring puts it back.
alter table le_leads add column if not exists stage_before_unqualified text;

-- Never 'unqualified' itself: it is one of the other stages, or null.
alter table le_leads drop constraint if exists le_leads_stage_before_unqualified_chk;

alter table le_leads add constraint le_leads_stage_before_unqualified_chk
  check (stage_before_unqualified in ('new', 'researching', 'researched', 'contacted', 'replied', 'call_booked', 'nurture', 'lost'));

-- unqualified_at is set exactly while the stage is 'unqualified'.
alter table le_leads drop constraint if exists le_leads_unqualified_at_chk;

alter table le_leads add constraint le_leads_unqualified_at_chk
  check ((stage = 'unqualified') = (unqualified_at is not null));

-- The reason and the earlier stage belong to an unqualified lead only: both are null otherwise.
alter table le_leads drop constraint if exists le_leads_unqualified_fields_chk;

alter table le_leads add constraint le_leads_unqualified_fields_chk
  check (stage = 'unqualified' or (unqualified_reason is null and stage_before_unqualified is null));

-- A reason is 1 to 200 characters (the API trims it and saves an empty one as null).
alter table le_leads drop constraint if exists le_leads_unqualified_reason_chk;

alter table le_leads add constraint le_leads_unqualified_reason_chk
  check (char_length(unqualified_reason) between 1 and 200);

-- The two lists, 500 rows each: the Leads and Pipeline pages read the most recently updated
-- active leads, and poll every 4 seconds while research runs; the Unqualified view reads the most
-- recently marked. Imports add up to 2,000 leads a day, so without these each read would sort
-- the whole table. With them it reads the first 500 entries in order and stops. Partial, so
-- each index holds only the rows its list can show.
create index if not exists le_leads_active_idx on le_leads (updated_at desc, id) where stage <> 'unqualified';

create index if not exists le_leads_unqualified_idx on le_leads (unqualified_at desc, id) where stage = 'unqualified';
