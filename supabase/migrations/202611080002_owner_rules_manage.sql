-- Owner rules can be edited, switched off and removed from the CRM, and record where they came from:
-- 'learn' (typed /learn), 'chat' (the owner accepted a rule the AI proposed from a correction) or 'setup'.
begin;
alter table public.ai_owner_rules
 add column source text not null default 'learn' check(source in ('learn','chat','setup')),
 add column updated_at timestamptz not null default now(),
 add column updated_by text;
commit;
