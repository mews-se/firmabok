-- Migration: supplier_invoice_transaction_match
-- Adds potential_supplier_invoice_id to transactions for supplier invoice matching.
-- Note: supplier_invoice_id on transactions is already added by migration 025 (payroll).

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS potential_supplier_invoice_id UUID
  REFERENCES public.supplier_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_potential_supplier_invoice
  ON public.transactions(potential_supplier_invoice_id);
