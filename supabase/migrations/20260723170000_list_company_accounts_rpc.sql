-- Single-round-trip chart-of-accounts listing for the app layer.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- app/api/bookkeeping/accounts (GET) fetches chart_of_accounts through
-- fetchAllRows(): sequential 1000-row PostgREST pages, one HTTP round trip
-- each (Vercel iad1 to Supabase eu-north-1). 95/1250 prod companies have
-- more than 1000 active accounts, so their list requests pay 2-5 sequential
-- cross-region round trips while Postgres itself needs ~5ms per page.
-- Returning the whole list as ONE json scalar bypasses PostgREST's
-- db-max-rows=1000 cap, so every company size costs exactly one round trip.
--
-- INVARIANTS (do not break these when editing):
--   1. SECURITY INVOKER: the existing chart_of_accounts RLS select policy
--      (company_id IN (SELECT user_company_ids())) must keep applying. The
--      explicit p_company_id filter is defense in depth on top of RLS, same
--      as the route's .eq('company_id', ...) today.
--   2. to_json(c) emits every column with its column name: the exact field
--      set select('*') returns today. Do not switch to an explicit column
--      list; the pg-real parity test locks this.
--   3. Ordering is (sort_order, id): sort_order is today's route order; id
--      is only a deterministic tiebreaker (tie order was previously
--      unspecified, so this is not a behavior change).
--   4. Filters mirror the route exactly: p_active_only true keeps
--      is_active rows only; p_account_class NULL means no class filter.

create or replace function public.list_company_accounts(
  p_company_id uuid,
  p_active_only boolean default true,
  p_account_class integer default null
) returns json
language sql stable security invoker
set search_path = public
as $$
  select coalesce(json_agg(to_json(c) order by c.sort_order, c.id), '[]'::json)
  from public.chart_of_accounts c
  where c.company_id = p_company_id
    and (not p_active_only or c.is_active)
    and (p_account_class is null or c.account_class = p_account_class)
$$;

revoke all on function public.list_company_accounts(uuid, boolean, integer) from public, anon;
grant execute on function public.list_company_accounts(uuid, boolean, integer) to authenticated;
grant execute on function public.list_company_accounts(uuid, boolean, integer) to service_role;

NOTIFY pgrst, 'reload schema';
