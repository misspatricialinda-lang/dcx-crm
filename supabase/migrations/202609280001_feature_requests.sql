begin;

create table if not exists public.crm_feature_requests (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 3 and 160),
  description text not null check (length(trim(description)) between 10 and 5000),
  area text not null default 'general' check (area in ('general','inbox','customers','quotations','calendar','reporting','other')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  status text not null default 'new' check (status in ('new','reviewing','planned','in_progress','completed','declined')),
  owner_notes text not null default '' check (length(owner_notes) <= 3000),
  created_by text not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_feature_requests_recent on public.crm_feature_requests(created_at desc);
create index if not exists crm_feature_requests_status on public.crm_feature_requests(status, created_at desc);

alter table public.crm_feature_requests enable row level security;
revoke all on public.crm_feature_requests from anon, authenticated;
grant select, insert, update on public.crm_feature_requests to service_role;

commit;
