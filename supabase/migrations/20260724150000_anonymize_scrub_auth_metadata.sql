-- Scrub auth.users metadata inside anonymize_user_account.
--
-- WHY
-- ---
-- app/api/account/delete/route.ts tried to wipe user_metadata/app_metadata
-- after the RPC by calling auth.admin.updateUserById(userId, { user_metadata:
-- {}, app_metadata: {} }). GoTrue MERGES metadata maps on admin update, so
-- passing an empty object is a no-op: the tombstone kept the user's full name
-- in raw_user_meta_data on a row we retain ~100 years (verified on production
-- 2026-07-24). Anonymization must actually remove the PII, so the scrub moves
-- into the SECURITY DEFINER function where a direct UPDATE is deterministic
-- and atomic with the profile scrub.
--
-- raw_user_meta_data is cleared entirely (full_name, avatar, any provider
-- leftovers). raw_app_meta_data only drops our app-specific keys
-- (bankid_linked, has_password): provider/providers stay, GoTrue owns those.

CREATE OR REPLACE FUNCTION public.anonymize_user_account(target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  blocker_count int;
BEGIN
  IF auth.uid() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'Can only delete your own account';
  END IF;

  -- Reject repeat invocations against an already-anonymized tombstone: the
  -- account is gone, re-running would only churn the scrubbed row.
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = target_user_id AND anonymized_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Account is already deleted' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO blocker_count
  FROM public.company_members cm
  JOIN public.companies c ON c.id = cm.company_id
  WHERE cm.user_id = target_user_id
    AND cm.role = 'owner'
    AND c.archived_at IS NULL;

  IF blocker_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete account: user still owns % active compan(y/ies)', blocker_count
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.company_members   WHERE user_id = target_user_id;
  DELETE FROM public.team_members      WHERE user_id = target_user_id;
  DELETE FROM public.bankid_identities WHERE user_id = target_user_id;

  DELETE FROM public.user_preferences WHERE user_id = target_user_id;
  DELETE FROM public.api_keys         WHERE user_id = target_user_id;

  UPDATE public.profiles
     SET email         = NULL,
         full_name     = NULL,
         avatar_url    = NULL,
         deleted_at    = now(),
         anonymized_at = now(),
         updated_at    = now()
   WHERE id = target_user_id;

  -- Scrub PII from the auth tombstone. auth.users.email is intentionally
  -- kept (blocks re-signup + lets support verify identity for BFL-retained
  -- data recovery; documented legitimate interest, see
  -- app/api/account/delete/route.ts).
  UPDATE auth.users
     SET raw_user_meta_data = '{}'::jsonb,
         raw_app_meta_data  = coalesce(raw_app_meta_data, '{}'::jsonb) - 'bankid_linked' - 'has_password'
   WHERE id = target_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.anonymize_user_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_user_account(uuid) TO authenticated;

-- Repair existing tombstones: every already-anonymized profile whose auth row
-- still carries metadata. Guarded by anonymized_at so live users are untouched.
-- The migration runner applies this whole file in a single transaction, so the
-- UPDATE is atomic: it either scrubs all matching rows or none.
UPDATE auth.users u
   SET raw_user_meta_data = '{}'::jsonb,
       raw_app_meta_data  = coalesce(u.raw_app_meta_data, '{}'::jsonb) - 'bankid_linked' - 'has_password'
  FROM public.profiles p
 WHERE p.id = u.id
   AND p.anonymized_at IS NOT NULL
   AND (u.raw_user_meta_data <> '{}'::jsonb
        OR u.raw_app_meta_data ?| array['bankid_linked', 'has_password']);

NOTIFY pgrst, 'reload schema';
