-- Lead Engine schema. Every table is prefixed le_ so it can share a database.

create table if not exists le_leads (
  id uuid primary key default gen_random_uuid(),
  linkedin_url text not null,
  linkedin_slug text,
  name text,
  title text,
  company_name text,
  company_domain text,
  company_linkedin_url text,
  email text,
  email_confidence integer,
  x_handle text,
  location text,
  notes text,
  stage text not null default 'new',
  owner text,
  next_step_at timestamptz,
  last_contacted_at timestamptz,
  research_status text not null default 'idle',
  research_step text,
  research_error text,
  research_started_at timestamptz,
  research_finished_at timestamptz,
  brief jsonb,
  company_picture jsonb,
  angles jsonb not null default '[]'::jsonb,
  approach jsonb,
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint le_leads_stage_chk check (stage in ('new','researching','researched','contacted','replied','call_booked','nurture','lost')),
  constraint le_leads_research_chk check (research_status in ('idle','running','done','error'))
);

create unique index if not exists le_leads_slug_uq on le_leads (linkedin_slug) where linkedin_slug is not null;
create index if not exists le_leads_stage_idx on le_leads (stage, next_step_at);

create table if not exists le_findings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references le_leads(id) on delete cascade,
  source text not null,
  kind text not null,
  title text,
  text text not null,
  url text,
  published_at text,
  confidence real not null default 0.7,
  relevance real not null default 0.5,
  passes_criteria boolean not null default true,
  excluded_reason text,
  created_at timestamptz not null default now()
);
create index if not exists le_findings_lead_idx on le_findings (lead_id, created_at);

create table if not exists le_events (
  id bigserial primary key,
  lead_id uuid not null references le_leads(id) on delete cascade,
  type text not null,
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists le_events_lead_idx on le_events (lead_id, id);

create table if not exists le_raw (
  id bigserial primary key,
  lead_id uuid not null references le_leads(id) on delete cascade,
  provider text not null,
  request jsonb,
  response jsonb,
  created_at timestamptz not null default now()
);
create index if not exists le_raw_lead_idx on le_raw (lead_id, provider);

create table if not exists le_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
