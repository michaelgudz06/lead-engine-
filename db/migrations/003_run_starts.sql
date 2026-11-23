-- One row per research or steer run that was allowed to start. reserveRun()
-- (src/app/api/_lib/api.ts) checks the hourly and daily caps and inserts the row in one
-- transaction behind an advisory lock, so a burst of requests cannot start more runs than
-- the caps allow. No foreign key on purpose: deleting a lead must not give its runs back
-- to the caps.
create table if not exists le_run_starts (
  id bigserial primary key,
  lead_id uuid,
  kind text not null check (kind in ('research', 'steer')),
  created_at timestamptz not null default now()
);

create index if not exists le_run_starts_created_idx on le_run_starts (created_at desc);

create index if not exists le_run_starts_lead_idx on le_run_starts (lead_id);

-- Carry over the runs of the last 24 hours, which were counted from their first step event
-- until now, so the caps hold across the switch.
insert into le_run_starts (lead_id, kind, created_at)
select lead_id, case when message = 'Starting research' then 'research' else 'steer' end, created_at
  from le_events
 where type = 'step'
   and message in ('Starting research', 'Reading your instruction')
   and created_at > now() - interval '24 hours';
