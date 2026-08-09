-- Address review feedback on the inbox_rate_counters table:
--
--   1) Add the standard updated_at trigger so any future write path that
--      bypasses the SECURITY DEFINER RPC keeps the column semantically
--      correct (matches every other table in the schema — CLAUDE.md
--      migration rule 2).
--
--   2) Make the "no user access" intent explicit instead of implicit.
--      RLS is enabled on the table but had no policies. The default behavior
--      when RLS is on without policies is to deny everything except the
--      table owner / SECURITY DEFINER functions — which is exactly what we
--      want — but a future admin tool or diagnostic query running under
--      the authenticated role will silently get zero rows, which is hard
--      to debug. The explicit USING (false) policies below state the
--      intent and surface no-access situations more clearly when running
--      EXPLAIN or auditing the schema (CLAUDE.md migration rule 1).
--      Writes still go exclusively through check_and_increment_inbox_quota
--      (SECURITY DEFINER), which bypasses RLS by design.

CREATE TRIGGER update_inbox_rate_counters_updated_at
  BEFORE UPDATE ON public.inbox_rate_counters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY inbox_rate_counters_no_select
  ON public.inbox_rate_counters FOR SELECT
  USING (false);

CREATE POLICY inbox_rate_counters_no_insert
  ON public.inbox_rate_counters FOR INSERT
  WITH CHECK (false);

CREATE POLICY inbox_rate_counters_no_update
  ON public.inbox_rate_counters FOR UPDATE
  USING (false);

CREATE POLICY inbox_rate_counters_no_delete
  ON public.inbox_rate_counters FOR DELETE
  USING (false);

NOTIFY pgrst, 'reload schema';
