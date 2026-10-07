-- One company email signature, appended at send time by the app and by n8n Workflow 3.
-- Outlook signatures live in the Outlook app and are never added to Graph sends.
create table if not exists public.crm_email_signature (
  id smallint primary key default 1 check (id = 1),
  fields jsonb not null,
  html text not null,
  enabled boolean not null default true,
  banner_base64 text,
  banner_content_type text not null default 'image/jpeg',
  source text,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.crm_email_signature enable row level security;
revoke all on public.crm_email_signature from anon, authenticated;
grant all on public.crm_email_signature to service_role;
notify pgrst, 'reload schema';
