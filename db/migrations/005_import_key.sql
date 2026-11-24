-- 005: the name and company an import matched a lead on, kept as they were imported.
-- Research rewrites a lead's name and company (the profile's full name, the company's own
-- name), so a re-import of the same row without a LinkedIn URL, HubSpot id or email must
-- still find the lead by what the file said. Additive: the deployed code never reads it.

alter table le_leads add column if not exists import_key text;

create index if not exists le_leads_import_key_idx on le_leads (import_key) where import_key is not null;
