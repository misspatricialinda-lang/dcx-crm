-- Search existing email addresses without storing a second address list.
create or replace function public.calendar_email_suggestions(p_query text default '', p_limit integer default 8)
returns table(email text)
language sql stable
set search_path = ''
as $$
  with addresses as (
    select lower(trim(c.email)) as address from public.crm_contacts c
    union all select lower(trim(c.email)) from public.crm_customers c
    union all select lower(trim(m.sender)) from public.email_messages m
    union all select lower(trim(a.address)) from public.email_messages m cross join lateral jsonb_array_elements_text(m.to_addresses) a(address)
    union all select lower(trim(a.address)) from public.email_messages m cross join lateral jsonb_array_elements_text(m.cc_addresses) a(address)
  )
  select address as email
  from addresses
  where position('@' in address) > 1
    and (coalesce(trim(p_query), '') = '' or position(lower(trim(p_query)) in address) > 0)
  group by address
  order by case when left(address, length(lower(trim(coalesce(p_query, ''))))) = lower(trim(coalesce(p_query, ''))) then 0 else 1 end,
           count(*) desc, address
  limit least(greatest(coalesce(p_limit, 8), 1), 8);
$$;

revoke all on function public.calendar_email_suggestions(text,integer) from public, anon, authenticated;
grant execute on function public.calendar_email_suggestions(text,integer) to service_role;
