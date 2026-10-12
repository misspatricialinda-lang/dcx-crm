-- Calls the CRM push dispatcher (/api/notifications?action=dispatch) when a notification is saved,
-- and every 5 minutes to retry failed pushes. The URL and token live in Supabase Vault, not here:
--   select vault.create_secret('https://YOUR-CRM-DOMAIN/api/notifications?action=dispatch', 'crm_push_dispatch_url');
--   select vault.create_secret('<PUSH_DISPATCH_TOKEN>', 'crm_push_dispatch_token');
-- Without both secrets the calls are skipped, so this migration is safe to apply first.
begin;

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.crm_request_push_dispatch()
returns void language plpgsql security definer set search_path = '' as $$
declare
  dispatch_url text;
  dispatch_token text;
begin
  select decrypted_secret into dispatch_url from vault.decrypted_secrets where name = 'crm_push_dispatch_url';
  select decrypted_secret into dispatch_token from vault.decrypted_secrets where name = 'crm_push_dispatch_token';
  if dispatch_url is null or dispatch_token is null then return; end if;
  perform net.http_post(
    url := dispatch_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || dispatch_token),
    timeout_milliseconds := 30000
  );
end $$;

create or replace function public.crm_push_after_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.crm_request_push_dispatch();
  return null;
end $$;

drop trigger if exists crm_push_dispatch_on_notification on public.crm_notifications;
create trigger crm_push_dispatch_on_notification after insert on public.crm_notifications
for each statement execute function public.crm_push_after_notification();

revoke all on function public.crm_request_push_dispatch(), public.crm_push_after_notification() from public, anon, authenticated;

-- Retry: notifications that failed to push are claimed again after 5 minutes, for up to 24 hours.
select cron.unschedule(jobid) from cron.job where jobname = 'crm-push-dispatch-retry';
select cron.schedule('crm-push-dispatch-retry', '*/5 * * * *', 'select public.crm_request_push_dispatch()');

commit;
