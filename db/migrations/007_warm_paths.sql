-- 007: warm paths. Who can introduce the owner to a lead, from the owner's own side of the graph
-- (a LinkedIn Connections.csv export, the owner's own LinkedIn profile, the owner's X follows)
-- compared with what research knows about the lead.
--
-- Additive and safe for the code that was live before it: that code never reads or writes the new
-- tables or the new le_leads column (its inserts leave warm_path null), and the widened
-- le_quota_uses kind check still accepts every kind it writes ('import', 'email_lookup').
--
-- The migration runner splits this file on a semicolon at a line end, so every statement below is
-- plain SQL, and no comment line ends in a semicolon.

-- The owner's side of the graph. LinkedIn: one row per connection from the Connections.csv
-- export (external_id is the profile slug, as linkedinSlug() makes it). An upload in progress
-- keeps its rows as connection_pending, which nothing matches, until its last part arrives. X: one
-- row per account the owner follows or that follows the owner (external_id is the numeric X id as
-- text). No email address is ever stored here.
create table if not exists le_network_contacts (
  id bigserial primary key,
  network text not null
    constraint le_network_contacts_network_chk check (network in ('linkedin', 'x')),
  relation text not null
    constraint le_network_contacts_relation_chk check (relation in ('connection', 'connection_pending', 'following', 'follower')),
  external_id text not null
    constraint le_network_contacts_external_id_chk check (char_length(external_id) between 1 and 200),
  handle text,
  name text,
  -- LinkedIn only: the name's words as nameTokens reads them (lower case, accents dropped), space
  -- separated, so an X account's name finds the connection by whole words: "Jose Garcia" for "José García".
  name_key text,
  company text,
  position text,
  profile_url text,
  -- normaliseName(company): the key sameCompanyName compares.
  company_key text,
  -- X only: the account's follower count, to damp very large accounts.
  followers_count integer,
  -- LinkedIn only: the export's "Connected On".
  connected_on date,
  -- Which upload or sync wrote the row. An upload replaces the older rows once its last part arrives.
  import_id text,
  seen_at timestamptz not null default now(),
  constraint le_network_contacts_uq unique (network, relation, external_id)
);

-- "People at their company": an exact key, and the lead's key as a prefix (company_key like key%).
create index if not exists le_network_contacts_company_idx
  on le_network_contacts (network, company_key text_pattern_ops) where company_key is not null;

-- One row per source of the owner's. data holds, by key: linkedin_csv { importId, exportedAt,
-- uploadedAt, pending }, linkedin_self { url, roles, schools, readAt }, linkedin_account
-- { premium, salesNavigator, pausedUntil, pauseReason, searchForm }, x_self { userId, handle,
-- following, followers }. Never a token or a cookie.
create table if not exists le_network_sources (
  key text primary key
    constraint le_network_sources_key_chk check (key in ('linkedin_csv', 'linkedin_self', 'linkedin_account', 'x_self', 'x_following', 'x_followers')),
  status text not null default 'ok'
    constraint le_network_sources_status_chk check (status in ('ok', 'running', 'error')),
  detail text,
  item_count integer,
  cursor text,
  data jsonb not null default '{}'::jsonb,
  synced_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One row per lead: what is known about the lead's side (target), the cached live checks, and the
-- computed paths. The lead's own follow lists are never stored, only the paths and counts.
create table if not exists le_warm_paths (
  lead_id uuid primary key references le_leads(id) on delete cascade,
  status text not null default 'idle'
    constraint le_warm_paths_status_chk check (status in ('idle', 'running', 'done', 'error')),
  -- The lead's keys: LinkedIn slug, public id and member id, roles, schools, company size, X handle
  -- and id, Instagram handle. Lets a check run outside a research run.
  target jsonb,
  -- The owner's LinkedIn account (optional, step 2): degree and shared connections. Kept 30 days.
  linkedin_live jsonb,
  -- X: the lead's counts, your relation to them and the connectors found. Kept 7 days.
  x_live jsonb,
  paths jsonb not null default '[]'::jsonb,
  company_paths jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  -- Which of the owner's sources were set up when the paths were computed (booleans only). When
  -- that changes (a key added on the server, a handle or URL in Settings) the next view redoes the
  -- free part, so the footer follows what is set up now.
  setup jsonb,
  -- Intro drafts and "asked" dates by path id, so they outlive a recompute.
  intros jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  computed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The list chip: the best Strong or Medium path in a few fields (strength, hops, via, network,
-- connected, label, checkedAt), or null. Small, so the Leads list needs no join.
alter table le_leads add column if not exists warm_path jsonb;

-- Daily budgets for the warm-path checks (LinkedIn checks on the owner's account, twitterapi.io
-- credits), for intro drafts, and for LinkedIn profile reads on the research account made outside
-- a research run (a lead researched before warm paths, the owner's own profile, Read now). Dropped
-- and added again in this one transaction.
alter table le_quota_uses drop constraint if exists le_quota_uses_kind_chk;

alter table le_quota_uses add constraint le_quota_uses_kind_chk
  check (kind in ('import', 'email_lookup', 'warm_path_linkedin', 'warm_path_x', 'intro_draft', 'profile_read', 'warm_path_check'));
