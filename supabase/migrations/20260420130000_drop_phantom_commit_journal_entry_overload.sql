-- Drop phantom 4-argument overload of commit_journal_entry.
--
-- The canonical definition in 20260402100200_atomic_commit_entry.sql has the
-- signature (p_company_id uuid, p_entry_id uuid). A 4-argument overload
-- (p_company_id uuid, p_entry_id uuid, p_commit_method text, p_rubric_version text)
-- was observed in at least one database but has never existed in source
-- control. It is orphaned — no code calls it and no migration creates it.
--
-- Its presence causes the 2-argument RPC call in lib/bookkeeping/engine.ts
-- (`supabase.rpc('commit_journal_entry', { p_company_id, p_entry_id })`)
-- to fail with:
--   "Could not choose the best candidate function between:
--    public.commit_journal_entry(p_company_id => uuid, p_entry_id => uuid),
--    public.commit_journal_entry(p_company_id => uuid, p_entry_id => uuid,
--                                p_commit_method => text, p_rubric_version => text)"
-- because PostgREST's named-argument dispatch is ambiguous when both overloads
-- are reachable.
--
-- This migration drops the orphaned overload. IF EXISTS makes it a no-op on
-- databases that never had the phantom function.

DROP FUNCTION IF EXISTS public.commit_journal_entry(uuid, uuid, text, text);

NOTIFY pgrst, 'reload schema';
