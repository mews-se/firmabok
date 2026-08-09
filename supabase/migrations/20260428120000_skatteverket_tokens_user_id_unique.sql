-- Add the UNIQUE(user_id) constraint that the original migration
-- 20260324120001_skatteverket_tokens.sql declared but that is missing
-- on at least one deployed environment.
--
-- The application now uses DELETE+INSERT instead of UPSERT for token
-- storage so it works without this constraint, but adding it is still
-- correct: it documents the one-row-per-user invariant and prevents
-- accidental duplicates from any future code path that does INSERT.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.skatteverket_tokens'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%(user_id)%'
  ) THEN
    -- Defensive: if duplicates somehow exist, keep one row per user.
    -- Uses ctid (Postgres physical row identifier) to break ties when
    -- multiple rows share the same created_at timestamp — without this,
    -- duplicates inserted in the same second wouldn't be deduped and the
    -- ALTER TABLE … ADD CONSTRAINT below would fail.
    DELETE FROM public.skatteverket_tokens t
    USING (
      SELECT user_id, max(ctid) AS keep_ctid
      FROM public.skatteverket_tokens
      GROUP BY user_id
      HAVING count(*) > 1
    ) d
    WHERE t.user_id = d.user_id
      AND t.ctid <> d.keep_ctid;

    ALTER TABLE public.skatteverket_tokens
      ADD CONSTRAINT skatteverket_tokens_user_id_key UNIQUE (user_id);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
