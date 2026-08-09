-- SIE Import Fixes
-- 1. Add missing columns to sie_imports
-- 2. Add reserve_voucher_range RPC for batch voucher number reservation

-- =============================================================================
-- 1. Add missing columns
-- =============================================================================
ALTER TABLE public.sie_imports
  ADD COLUMN IF NOT EXISTS migration_documentation jsonb,
  ADD COLUMN IF NOT EXISTS file_storage_path text;

-- =============================================================================
-- 2. reserve_voucher_range: advance voucher sequence to at least p_highest_used
-- Used by SIE import to reserve a contiguous block of voucher numbers.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.reserve_voucher_range(
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_series text,
  p_highest_used integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.voucher_sequences (user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_user_id, p_fiscal_period_id, p_series, p_highest_used)
  ON CONFLICT (user_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = GREATEST(public.voucher_sequences.last_number, EXCLUDED.last_number),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_voucher_range(uuid, uuid, text, integer) TO authenticated;
