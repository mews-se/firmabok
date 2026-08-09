-- Fix UPDATE RLS policy on skattekonto_transactions to include WITH CHECK.
--
-- The original migration (20260504160000_skattekonto_transactions) only
-- declared USING on the UPDATE policy. Without WITH CHECK, a row that
-- satisfies USING can be mutated to set company_id to a value the user
-- doesn't belong to, defeating tenant isolation.
--
-- Drop + recreate the policy with both clauses.

DROP POLICY IF EXISTS "Users update skattekonto transactions for their companies"
  ON public.skattekonto_transactions;

CREATE POLICY "Users update skattekonto transactions for their companies"
  ON public.skattekonto_transactions FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

NOTIFY pgrst, 'reload schema';
