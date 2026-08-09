-- Migration: invoice_partial_payments
-- Adds remaining_amount to invoices, 'partially_paid' status, and invoice_payments table.
-- Mirrors the existing supplier_invoice_payments pattern for customer invoices.

-- 1. Add remaining_amount column to invoices
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS remaining_amount numeric;

-- 2. Drop and re-add status CHECK to include 'partially_paid'
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'sent', 'paid', 'partially_paid', 'overdue', 'cancelled', 'credited'));

-- 3. Backfill remaining_amount from existing data
UPDATE public.invoices
  SET remaining_amount = GREATEST(0, total - COALESCE(paid_amount, 0));

-- 4. Make remaining_amount NOT NULL with default
ALTER TABLE public.invoices
  ALTER COLUMN remaining_amount SET NOT NULL,
  ALTER COLUMN remaining_amount SET DEFAULT 0;

-- 5. Create invoice_payments table (mirrors supplier_invoice_payments)
CREATE TABLE public.invoice_payments (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  invoice_id        uuid NOT NULL REFERENCES public.invoices ON DELETE CASCADE,
  payment_date      date NOT NULL,
  amount            numeric NOT NULL,
  currency          text DEFAULT 'SEK',
  exchange_rate     numeric,
  exchange_rate_difference numeric DEFAULT 0,
  journal_entry_id  uuid REFERENCES public.journal_entries ON DELETE SET NULL,
  transaction_id    uuid REFERENCES public.transactions ON DELETE SET NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER update_invoice_payments_updated_at
  BEFORE UPDATE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE POLICY "invoice_payments_select" ON public.invoice_payments
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "invoice_payments_insert" ON public.invoice_payments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_invoice_payments_user_id ON public.invoice_payments (user_id);
CREATE INDEX idx_invoice_payments_invoice_id ON public.invoice_payments (invoice_id);
CREATE INDEX idx_invoice_payments_transaction_id ON public.invoice_payments (transaction_id);

-- Prevent same transaction matched to same invoice twice
CREATE UNIQUE INDEX idx_invoice_payments_tx_inv_unique
  ON public.invoice_payments (transaction_id, invoice_id);

-- 6. Add unique constraint to supplier_invoice_payments if not present
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoice_payments_tx_inv_unique
  ON public.supplier_invoice_payments (transaction_id, supplier_invoice_id);

-- 7. Add user_id to supplier_invoice_payments if not present (denormalized for RLS perf)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'supplier_invoice_payments'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.supplier_invoice_payments
      ADD COLUMN user_id uuid REFERENCES auth.users ON DELETE CASCADE;

    -- Backfill user_id from parent supplier_invoices
    UPDATE public.supplier_invoice_payments sip
      SET user_id = si.user_id
      FROM public.supplier_invoices si
      WHERE sip.supplier_invoice_id = si.id;
  END IF;
END
$$;

ALTER TABLE public.supplier_invoice_payments
  ALTER COLUMN user_id SET NOT NULL;
