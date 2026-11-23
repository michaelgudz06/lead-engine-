-- Usage ledger: one row per paid or metered call to an outside API (see src/lib/usage).
-- lead_id goes null when the lead is deleted; lead_name keeps the name it had when the row was written.

create table if not exists le_usage (
  id bigserial primary key,
  lead_id uuid references le_leads(id) on delete set null,
  lead_name text,
  provider text not null,
  operation text not null,
  units jsonb not null default '{}'::jsonb,
  cost_usd numeric(12,6),
  cost_basis text not null default 'unknown',
  ok boolean not null default true,
  ms integer,
  created_at timestamptz not null default now(),
  constraint le_usage_basis_chk check (cost_basis in ('reported','estimated','free','unknown'))
);

create index if not exists le_usage_created_idx on le_usage (created_at);
create index if not exists le_usage_lead_idx on le_usage (lead_id, created_at);
create index if not exists le_usage_provider_idx on le_usage (provider, created_at);
