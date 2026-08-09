-- Migration 25: Leverantorsreskontra (Accounts Payable)
-- Suppliers, supplier invoices, line items, partial payments
-- BFL 5:6-9 verifikationskrav, ML 17:24 inkommande fakturor

-- =============================================================================
-- 1. suppliers table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.suppliers (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  name            text NOT NULL,
  supplier_type   text NOT NULL DEFAULT 'swedish_business'
                    CHECK (supplier_type IN ('swedish_business', 'eu_business', 'non_eu_business')),
  org_number      text,
  vat_number      text,

  -- Contact
  email           text,
  phone           text,

  -- Address
  address_line1   text,
  address_line2   text,
  postal_code     text,
  city            text,
  country         text DEFAULT 'SE',

  -- Payment details
  bankgiro        text,
  plusgiro         text,
  bank_account    text,
  iban            text,
  bic             text,
  clearing_number text,
  account_number  text,

  -- Defaults
  default_expense_account text,  -- e.g. '5010'
  default_payment_terms   integer DEFAULT 30,
  default_currency        text NOT NULL DEFAULT 'SEK',

  -- Classification
  category        text,
  is_active       boolean DEFAULT true,

  -- Notes
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "suppliers_select"
  ON public.suppliers FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "suppliers_insert"
  ON public.suppliers FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "suppliers_update"
  ON public.suppliers FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "suppliers_delete"
  ON public.suppliers FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_suppliers_user_id ON public.suppliers (user_id);
CREATE INDEX idx_suppliers_name ON public.suppliers (user_id, name);
CREATE INDEX idx_suppliers_is_active ON public.suppliers (user_id, is_active);

-- =============================================================================
-- 2. supplier_invoices table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.supplier_invoices (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id     uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,

  -- Ankomstnummer (BFL running number for incoming invoices)
  arrival_number  integer NOT NULL,

  -- Supplier's reference
  supplier_invoice_number text NOT NULL,

  -- Dates (ML 17:24 requirements)
  invoice_date    date NOT NULL,
  due_date        date NOT NULL,
  received_date   date NOT NULL DEFAULT CURRENT_DATE,
  delivery_date   date,  -- ML krav

  -- Status
  status          text NOT NULL DEFAULT 'registered'
                    CHECK (status IN ('registered', 'approved', 'paid', 'partially_paid', 'overdue', 'disputed', 'credited')),

  -- Currency
  currency        text NOT NULL DEFAULT 'SEK',
  exchange_rate   numeric,
  exchange_rate_date date,

  -- Amounts
  subtotal        numeric NOT NULL DEFAULT 0,
  subtotal_sek    numeric,
  vat_amount      numeric NOT NULL DEFAULT 0,
  vat_amount_sek  numeric,
  total           numeric NOT NULL DEFAULT 0,
  total_sek       numeric,

  -- VAT
  vat_treatment   text NOT NULL DEFAULT 'standard_25',
  reverse_charge  boolean NOT NULL DEFAULT false,

  -- Payment
  payment_reference text,  -- OCR-nummer
  paid_at         timestamptz,
  paid_amount     numeric NOT NULL DEFAULT 0,
  remaining_amount numeric NOT NULL DEFAULT 0,

  -- Credit note
  is_credit_note      boolean NOT NULL DEFAULT false,
  credited_invoice_id uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL,

  -- Bookkeeping links
  registration_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  payment_journal_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,

  -- Transaction link
  transaction_id  uuid REFERENCES public.transactions(id) ON DELETE SET NULL,

  -- Document (verifikationsunderlag)
  document_id     uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,

  -- Notes
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT uq_supplier_invoices_arrival UNIQUE (user_id, arrival_number),
  CONSTRAINT uq_supplier_invoices_ref UNIQUE (user_id, supplier_id, supplier_invoice_number)
);

ALTER TABLE public.supplier_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own supplier invoices"
  ON public.supplier_invoices FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own supplier invoices"
  ON public.supplier_invoices FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own supplier invoices"
  ON public.supplier_invoices FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own supplier invoices"
  ON public.supplier_invoices FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX idx_supplier_invoices_user_id ON public.supplier_invoices (user_id);
CREATE INDEX idx_supplier_invoices_supplier ON public.supplier_invoices (supplier_id);
CREATE INDEX idx_supplier_invoices_status ON public.supplier_invoices (user_id, status);
CREATE INDEX idx_supplier_invoices_due_date ON public.supplier_invoices (user_id, due_date);

-- =============================================================================
-- 3. Per-user arrival number generation (ankomstnummer)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_next_arrival_number(p_user_id uuid)
RETURNS integer AS $$
DECLARE
  next_num integer;
BEGIN
  SELECT COALESCE(MAX(arrival_number), 0) + 1 INTO next_num
  FROM public.supplier_invoices
  WHERE user_id = p_user_id;
  RETURN next_num;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 4. supplier_invoice_items table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.supplier_invoice_items (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  supplier_invoice_id   uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,

  sort_order            integer NOT NULL DEFAULT 0,
  description           text NOT NULL,
  quantity              numeric NOT NULL DEFAULT 1,
  unit                  text NOT NULL DEFAULT 'st',
  unit_price            numeric NOT NULL DEFAULT 0,  -- exkl. moms (ML krav)
  line_total            numeric NOT NULL DEFAULT 0,

  -- Bookkeeping
  account_number        text NOT NULL,  -- BAS expense account (4xxx-6xxx)
  vat_code              text,
  vat_rate              numeric NOT NULL DEFAULT 0.25,
  vat_amount            numeric NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.supplier_invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own supplier invoice items"
  ON public.supplier_invoice_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_id AND si.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own supplier invoice items"
  ON public.supplier_invoice_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_id AND si.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update own supplier invoice items"
  ON public.supplier_invoice_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_id AND si.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own supplier invoice items"
  ON public.supplier_invoice_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_id AND si.user_id = auth.uid()
    )
  );

CREATE INDEX idx_supplier_invoice_items_invoice ON public.supplier_invoice_items (supplier_invoice_id);

-- =============================================================================
-- 5. supplier_invoice_payments table (partial payments)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.supplier_invoice_payments (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  supplier_invoice_id   uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,

  payment_date          date NOT NULL,
  amount                numeric NOT NULL,
  currency              text NOT NULL DEFAULT 'SEK',
  exchange_rate         numeric,
  exchange_rate_difference numeric DEFAULT 0,  -- kursdifferens

  journal_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  transaction_id        uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  notes                 text,

  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.supplier_invoice_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own supplier invoice payments"
  ON public.supplier_invoice_payments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_id AND si.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own supplier invoice payments"
  ON public.supplier_invoice_payments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = supplier_invoice_id AND si.user_id = auth.uid()
    )
  );

CREATE INDEX idx_supplier_invoice_payments_invoice ON public.supplier_invoice_payments (supplier_invoice_id);

-- =============================================================================
-- 6. Add supplier_invoice_id to transactions
-- =============================================================================
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS supplier_invoice_id uuid REFERENCES public.supplier_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_supplier_invoice ON public.transactions (supplier_invoice_id);

-- =============================================================================
-- 7. Expand journal_entries source_type constraint
-- =============================================================================
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note'
  ));

-- =============================================================================
-- 8. Audit triggers for new tables
-- =============================================================================
CREATE TRIGGER audit_suppliers
  AFTER INSERT OR UPDATE OR DELETE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_supplier_invoices
  AFTER INSERT OR UPDATE OR DELETE ON public.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TRIGGER audit_supplier_invoice_items
  AFTER INSERT OR UPDATE OR DELETE ON public.supplier_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 9. Updated_at triggers
-- =============================================================================
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_suppliers
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_updated_at_supplier_invoices
  BEFORE UPDATE ON public.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
