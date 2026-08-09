-- Hardening follow-up to 20260420000000_arcim_inbox and 20260420180000_inbox_smart_match.
--
-- Fixes identified in PR #286 review:
--   1. Non-atomic rotation in rotateCompanyInbox() — replaced with a
--      SECURITY DEFINER RPC so deprecate/generate/insert happen in one
--      Postgres transaction.
--   2. Overly permissive RLS on company_inboxes (any member, including
--      viewers, could INSERT/UPDATE). Tightened to owner/admin only.
--   3. Dual-match race in inbox-smart-match (two receipts could both pair
--      themselves to the same transaction). Enforced by partial unique
--      index; process-match catches 23505 and falls back to pending.

-- =============================================================================
-- 1. Tighten RLS on company_inboxes to owner/admin only (for INSERT + UPDATE)
-- =============================================================================

DROP POLICY IF EXISTS "company_inboxes_insert" ON public.company_inboxes;
CREATE POLICY "company_inboxes_insert" ON public.company_inboxes
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "company_inboxes_update" ON public.company_inboxes;
CREATE POLICY "company_inboxes_update" ON public.company_inboxes
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

-- Note: auto_provision_company_inbox() and rotate_company_inbox() are
-- SECURITY DEFINER and bypass these policies; the policies only gate
-- direct client-side writes (defense-in-depth).

-- =============================================================================
-- 2. Atomic rotate RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rotate_company_inbox(p_company_id uuid)
RETURNS public.company_inboxes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_name text;
  v_local_part text;
  v_slug_seed text;
  v_new_row public.company_inboxes;
BEGIN
  -- Authorization: caller must be owner/admin of the company.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE company_id = p_company_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized to rotate inbox for this company'
      USING ERRCODE = '42501';
  END IF;

  SELECT name INTO v_company_name
  FROM public.companies
  WHERE id = p_company_id;

  IF v_company_name IS NULL THEN
    RAISE EXCEPTION 'Company not found' USING ERRCODE = 'P0002';
  END IF;

  -- All three steps share one transaction — a failure on any of them
  -- rolls the whole thing back, so the company never ends up without
  -- an active inbox.

  UPDATE public.company_inboxes
  SET status = 'deprecated',
      deprecated_at = now()
  WHERE company_id = p_company_id
    AND status = 'active';

  v_local_part := public.generate_inbox_local_part(v_company_name);
  v_slug_seed := regexp_replace(v_local_part, '-[^-]+$', '');

  INSERT INTO public.company_inboxes (company_id, local_part, slug_seed, status)
  VALUES (p_company_id, v_local_part, v_slug_seed, 'active')
  RETURNING * INTO v_new_row;

  RETURN v_new_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rotate_company_inbox(uuid) TO authenticated;

-- =============================================================================
-- 3. Prevent two inbox items from claiming the same transaction
-- =============================================================================

-- Partial unique index: once a row has matched_transaction_id set for a
-- given company, no other row in that company may claim the same one.
-- Concurrent UPDATEs from smart-match will get a 23505 and the handler
-- gracefully downgrades the loser to pending_transaction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_matched_transaction_unique
  ON public.invoice_inbox_items(company_id, matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
