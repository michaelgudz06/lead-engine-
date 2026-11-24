-- Bulk import (a CSV file, a Google Sheet or HubSpot) and what kind of email a lead has.
-- Additive and safe for the code that was live before it: that code always writes
-- linkedin_url, never reads the new columns, and leaves them null.

-- An imported contact may have no LinkedIn URL yet: research looks for the profile first.
alter table le_leads alter column linkedin_url drop not null;

-- Where the lead came from: the single-add form (manual), a CSV file, a Google Sheet or HubSpot.
-- Null for leads added before this migration.
alter table le_leads add column if not exists source text
  constraint le_leads_source_chk check (source in ('manual', 'csv', 'sheet', 'hubspot'));

-- The HubSpot contact a lead was imported from, so importing that contact again is a duplicate.
alter table le_leads add column if not exists hubspot_contact_id text;

create unique index if not exists le_leads_hubspot_uq on le_leads (hubspot_contact_id) where hubspot_contact_id is not null;

-- What kind of address le_leads.email is. found: Hunter's Email Finder. verified: built from the
-- company's email pattern and verified. guess: built from the pattern on a domain that accepts
-- every address, so it cannot be verified. imported: from an import. manual: typed in on the lead page.
alter table le_leads add column if not exists email_status text
  constraint le_leads_email_status_chk check (email_status in ('found', 'verified', 'guess', 'imported', 'manual'));

-- Imports look for existing leads by email, case-insensitively.
create index if not exists le_leads_email_lower_idx on le_leads (lower(email));

-- Addresses saved before this migration: a lookup stored a confidence with the address, and an
-- address typed in by hand had its confidence cleared.
update le_leads
   set email_status = case when email_confidence is not null then 'found' else 'manual' end
 where email is not null and email_status is null;

-- One row per use of a daily limit that has no natural row of its own: leads added by import
-- (units = leads created by one import) and email lookups from the lead page (units = 1).
-- Counted and inserted in one transaction behind an advisory lock, like le_run_starts. No
-- foreign key on purpose: deleting leads does not give the uses back.
create table if not exists le_quota_uses (
  id bigserial primary key,
  kind text not null constraint le_quota_uses_kind_chk check (kind in ('import', 'email_lookup')),
  units integer not null default 1 constraint le_quota_uses_units_chk check (units > 0),
  lead_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists le_quota_uses_kind_created_idx on le_quota_uses (kind, created_at desc);

create index if not exists le_quota_uses_lead_idx on le_quota_uses (lead_id);
