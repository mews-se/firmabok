-- Migration: payment_match_log
-- Append-only audit trail for all payment matching state transitions.
-- Required by BFL 7:1 — all match/unmatch events are räkenskapsinformation.
-- Do NOT add cleanup/DELETE jobs — 7-year retention is legally required.
-- Partition by created_at (yearly) when volume exceeds ~100k rows.

CREATE TABLE public.payment_match_log (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  transaction_id        uuid NOT NULL REFERENCES public.transactions ON DELETE CASCADE,
  invoice_id            uuid REFERENCES public.invoices ON DELETE SET NULL,
  supplier_invoice_id   uuid REFERENCES public.supplier_invoices ON DELETE SET NULL,
  action                text NOT NULL CHECK (action IN (
    'matched',
    'unmatched',
    'auto_suggested',
    'suggestion_cleared',
    'storno_conflict_resolved'
  )),
  match_confidence      numeric,
  match_method          text,
  previous_state        jsonb,
  new_state             jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
  -- Intentionally NO updated_at: append-only
);

ALTER TABLE public.payment_match_log ENABLE ROW LEVEL SECURITY;

-- Users can read their own match log entries
CREATE POLICY "payment_match_log_select" ON public.payment_match_log
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own match log entries
CREATE POLICY "payment_match_log_insert" ON public.payment_match_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- NO UPDATE or DELETE policies — immutability enforced by triggers below

-- Indexes
CREATE INDEX idx_payment_match_log_user_id ON public.payment_match_log (user_id);
CREATE INDEX idx_payment_match_log_transaction_id ON public.payment_match_log (transaction_id);
CREATE INDEX idx_payment_match_log_invoice_id ON public.payment_match_log (invoice_id);
CREATE INDEX idx_payment_match_log_supplier_invoice_id ON public.payment_match_log (supplier_invoice_id);
CREATE INDEX idx_payment_match_log_created_at ON public.payment_match_log (created_at);

-- Immutability triggers: reuse audit_log_immutable() from migration 014
CREATE TRIGGER payment_match_log_no_update
  BEFORE UPDATE ON public.payment_match_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();

CREATE TRIGGER payment_match_log_no_delete
  BEFORE DELETE ON public.payment_match_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();
