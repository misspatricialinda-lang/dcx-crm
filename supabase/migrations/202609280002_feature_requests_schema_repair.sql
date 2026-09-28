begin;

alter table public.crm_feature_requests
  add column if not exists created_by text not null default 'legacy',
  add column if not exists version integer not null default 1;

update public.crm_feature_requests set owner_notes = '' where owner_notes is null;
alter table public.crm_feature_requests
  alter column owner_notes set default '',
  alter column owner_notes set not null;

commit;

notify pgrst, 'reload schema';
