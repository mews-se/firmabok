-- Single-round-trip active-company resolution for the app layer.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- lib/company/context.ts (getActiveCompanyId) and lib/supabase/middleware.ts
-- (resolveCompanyForMiddleware) both resolve the active company with one
-- parallel round trip (user_preferences + first membership) plus a SECOND,
-- sequential validation round trip for every multi-company/consultant user.
-- This function collapses the whole resolution into one RPC call.
--
-- INVARIANTS (do not break these when editing):
--   1. This function must stay SEMANTICALLY IDENTICAL to
--      public.current_active_company_id() (20260702093000). RLS reads that
--      function; the app reads this one. If they diverge, Next.js and RLS
--      disagree about which company is active and tenant isolation desyncs.
--      Resolution order, in both: validated preference (user_preferences.
--      active_company_id backed by a live membership in a non-archived
--      company) wins, else the earliest non-archived membership by
--      company_members.created_at, else NULL.
--   2. NULL auth.uid() (service-role clients: createServiceClient /
--      createServiceClientNoCookies are cookieless, so auth.uid() is NULL in
--      RPCs) returns ZERO ROWS by design; the WHERE clause below produces
--      that. JS callers treat zero rows as "use the query fallback path".
--   3. No table writes inside: middleware does its own conditional
--      write-back using the used_fallback flag; read paths must stay reads.
--
-- used_fallback is true exactly when the validated preference is absent
-- (no prefs row, NULL active_company_id, archived company, or membership
-- gone), which is exactly the condition under which middleware writes the
-- resolved company back to user_preferences today.
--
-- locale is NULL only when the user has no user_preferences row (the column
-- itself is NOT NULL DEFAULT 'sv', 20260521120000), matching what the
-- middleware's own query returns today.

CREATE OR REPLACE FUNCTION public.resolve_active_company()
  RETURNS TABLE(company_id uuid, locale text, used_fallback boolean)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  WITH pref AS (
    SELECT up.active_company_id, up.locale
    FROM public.user_preferences up
    WHERE up.user_id = auth.uid()
  ),
  validated AS (
    SELECT cm.company_id
    FROM pref p
    JOIN public.company_members cm
      ON cm.user_id = auth.uid() AND cm.company_id = p.active_company_id
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    LIMIT 1
  ),
  fallback AS (
    SELECT cm.company_id
    FROM public.company_members cm
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = auth.uid()
    ORDER BY cm.created_at ASC
    LIMIT 1
  )
  SELECT
    COALESCE((SELECT v.company_id FROM validated v), (SELECT f.company_id FROM fallback f)) AS company_id,
    (SELECT p.locale FROM pref p) AS locale,
    ((SELECT v.company_id FROM validated v) IS NULL) AS used_fallback
  WHERE auth.uid() IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION public.resolve_active_company() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_active_company() TO authenticated;

NOTIFY pgrst, 'reload schema';
