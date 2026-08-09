-- Migration 50: Separate invoice and delivery note number sequences
-- BFL requires sequential, gap-free numbering within each document series.
-- Separate series per document type is standard Swedish practice.

-- =============================================================================
-- 1. Add delivery note sequence column to company_settings
-- =============================================================================
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS next_delivery_note_number INTEGER DEFAULT 1;

-- =============================================================================
-- 2. Create generate_invoice_number RPC
-- Atomically reads invoice_prefix + next_invoice_number, increments, returns
-- formatted number. Uses UPDATE ... RETURNING for concurrent safety.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.generate_invoice_number(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix TEXT;
  v_number INTEGER;
  v_year TEXT;
BEGIN
  UPDATE public.company_settings
  SET next_invoice_number = next_invoice_number + 1,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING invoice_prefix, next_invoice_number - 1
  INTO v_prefix, v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for user %', p_user_id;
  END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;

  RETURN COALESCE(v_prefix, '') || v_year || LPAD(v_number::TEXT, 3, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_invoice_number(UUID) TO authenticated;

-- =============================================================================
-- 3. Create generate_delivery_note_number RPC
-- Same pattern as invoice numbers but uses next_delivery_note_number.
-- Returns FS-{year}{padded_number} format.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.generate_delivery_note_number(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_number INTEGER;
  v_year TEXT;
BEGIN
  UPDATE public.company_settings
  SET next_delivery_note_number = next_delivery_note_number + 1,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING next_delivery_note_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for user %', p_user_id;
  END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;

  RETURN 'FS-' || v_year || LPAD(v_number::TEXT, 3, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_delivery_note_number(UUID) TO authenticated;
