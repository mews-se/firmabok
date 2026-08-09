-- Fix reserve_voucher_range: p_user_id was not updated to p_company_id
-- during the multi-tenant migration (20260330130000). The parameter mismatch
-- caused SIE imports to silently fail to update the voucher sequence,
-- leading to duplicate voucher number errors on subsequent operations.
--
-- Also adds release_voucher_range for rolling back burned numbers on partial
-- import failure (reserve-then-adjust pattern).

-- =============================================================================
-- 1. Fix reserve_voucher_range: p_user_id -> p_company_id
-- =============================================================================
DROP FUNCTION IF EXISTS public.reserve_voucher_range(uuid, uuid, text, integer);

CREATE OR REPLACE FUNCTION public.reserve_voucher_range(
  p_company_id uuid,
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
  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, auth.uid(), p_fiscal_period_id, p_series, p_highest_used)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = GREATEST(public.voucher_sequences.last_number, EXCLUDED.last_number),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_voucher_range(uuid, uuid, text, integer) TO authenticated;

-- =============================================================================
-- 2. release_voucher_range: roll back sequence on partial import failure
-- Only decreases last_number (never increases), preventing race conditions
-- with concurrent operations that may have legitimately advanced the sequence.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.release_voucher_range(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text,
  p_actual_last integer,
  p_reserved_highest integer  -- the ceiling this import originally reserved
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only release within the range this import originally reserved.
  -- The upper-bound guard (last_number <= p_reserved_highest) prevents rolling
  -- back past numbers that a concurrent operation has legitimately claimed.
  UPDATE public.voucher_sequences
  SET last_number = p_actual_last,
      updated_at = now()
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND voucher_series = p_series
    AND last_number > p_actual_last
    AND last_number <= p_reserved_highest;
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_voucher_range(uuid, uuid, text, integer, integer) TO authenticated;
