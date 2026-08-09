-- Periodisering (accrual/deferral) of supplier & customer invoice lines.
--
-- A schedule spreads one invoice line's net amount (ex VAT) over the months
-- of a service period, Fortnox-style:
--
--   Supplier invoice (förutbetald kostnad): the registration entry debits a
--   17xx interim asset account instead of the line's cost account; one
--   monthly "upplösning" entry (Dr cost / Cr 17xx) per calendar month.
--
--   Customer invoice (förutbetald intäkt): the revenue entry credits a 29xx
--   interim liability account instead of the line's 3xxx account; monthly
--   dissolution is Dr 29xx / Cr 3xxx.
--
-- VAT is never deferred (ML: redovisas på fakturadatum) — only the net line
-- amount moves to the interim account. All dissolution entries are created
-- through lib/bookkeeping/engine.ts with source_type='accrual'; this module
-- adds that source type, the schedule tables, and the per-line period fields
-- on both invoice item tables.
--
-- Legal basis: ÅRL 2 kap 4 § (periodiseringsprincipen). K2 (BFNAR 2016:10)
-- allows skipping accruals < 5 000 kr — enforced as a UI hint, never a block.

-- ============================================================
-- accrual_schedules — one row per deferred invoice line
-- ============================================================

CREATE TABLE public.accrual_schedules (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id                uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- 'expense' = förutbetald kostnad (17xx), 'revenue' = förutbetald intäkt (29xx)
  direction                 text NOT NULL CHECK (direction IN ('expense', 'revenue')),
  -- Exactly one source: a supplier invoice line or a customer invoice line.
  -- ON DELETE RESTRICT: a booked invoice with a schedule must be credited
  -- (which cancels the schedule via the service layer), never hard-deleted.
  supplier_invoice_id       uuid REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  supplier_invoice_item_id  uuid REFERENCES public.supplier_invoice_items(id) ON DELETE SET NULL,
  invoice_id                uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
  invoice_item_id           uuid REFERENCES public.invoice_items(id) ON DELETE SET NULL,
  -- Interim balance account (17xx/29xx) and the P&L account the amount
  -- dissolves to. Account numbers are strings, per project convention.
  balance_account           text NOT NULL,
  target_account            text NOT NULL,
  -- Net amount in SEK as booked (ex VAT). Exchange differences never touch
  -- the schedule; they are realized on payment like any other invoice.
  total_amount              numeric(15, 2) NOT NULL CHECK (total_amount > 0),
  period_start              date NOT NULL,
  period_end                date NOT NULL,
  -- Number of calendar months touched by [period_start, period_end]; equals
  -- the number of installment rows. Denormalized for list views.
  months                    integer NOT NULL CHECK (months >= 1),
  -- The registration/revenue entry that put the amount on balance_account.
  origin_journal_entry_id   uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  -- Floor for dissolution entry dates (= the origin entry's entry_date).
  -- Catch-up installments for already-elapsed months are dated
  -- max(period_month, posting_floor_date) so the interim account can never
  -- go negative before the origin entry exists.
  posting_floor_date        date NOT NULL DEFAULT CURRENT_DATE,
  status                    text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'completed', 'cancelled')),
  description               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accrual_schedules_period_valid CHECK (period_end >= period_start),
  CONSTRAINT accrual_schedules_one_source CHECK (
    (supplier_invoice_id IS NOT NULL)::int + (invoice_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT accrual_schedules_direction_matches_source CHECK (
    (direction = 'expense' AND supplier_invoice_id IS NOT NULL)
    OR (direction = 'revenue' AND invoice_id IS NOT NULL)
  ),
  -- Mirror the item-level account-range rules: förutbetalda kostnader live on
  -- 17xx (interimsfordringar), förutbetalda intäkter on 29xx (interimsskulder).
  CONSTRAINT accrual_schedules_balance_account_range CHECK (
    (direction = 'expense' AND balance_account ~ '^17[0-9]{2}$')
    OR (direction = 'revenue' AND balance_account ~ '^29[0-9]{2}$')
  ),
  -- The dissolution target must be a plausible 4-digit BAS account (class
  -- 1–8); the engine still validates it against chart_of_accounts at booking.
  CONSTRAINT accrual_schedules_target_account_range CHECK (
    target_account ~ '^[1-8][0-9]{3}$'
  )
);

CREATE INDEX idx_accrual_schedules_company ON public.accrual_schedules (company_id);
CREATE INDEX idx_accrual_schedules_company_status ON public.accrual_schedules (company_id, status);
CREATE INDEX idx_accrual_schedules_supplier_invoice ON public.accrual_schedules (supplier_invoice_id)
  WHERE supplier_invoice_id IS NOT NULL;
CREATE INDEX idx_accrual_schedules_invoice ON public.accrual_schedules (invoice_id)
  WHERE invoice_id IS NOT NULL;

ALTER TABLE public.accrual_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company accrual_schedules"
  ON public.accrual_schedules FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company accrual_schedules"
  ON public.accrual_schedules FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company accrual_schedules"
  ON public.accrual_schedules FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()));
-- The DELETE policy references accrual_schedule_installments and is created
-- after that table exists (policies resolve table references at CREATE time).

CREATE TRIGGER set_updated_at_accrual_schedules
  BEFORE UPDATE ON public.accrual_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_accrual_schedules
  AFTER INSERT OR UPDATE OR DELETE ON public.accrual_schedules
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ============================================================
-- accrual_schedule_installments — one row per calendar month
-- ============================================================

CREATE TABLE public.accrual_schedule_installments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  schedule_id       uuid NOT NULL REFERENCES public.accrual_schedules(id) ON DELETE CASCADE,
  -- First day of the month the installment belongs to.
  period_month      date NOT NULL,
  amount            numeric(15, 2) NOT NULL CHECK (amount > 0),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'posted', 'cancelled')),
  -- ON DELETE RESTRICT: the dissolution verifikat cannot be deleted while an
  -- installment references it (storno produces a new entry instead).
  journal_entry_id  uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  posted_at         timestamptz,
  -- Populated by the posting cron when an installment cannot be booked
  -- (e.g. no open fiscal period); surfaced in the periodiseringar UI.
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accrual_installments_unique UNIQUE (schedule_id, period_month),
  CONSTRAINT accrual_installments_month_normalized CHECK (
    period_month = date_trunc('month', period_month)::date
  ),
  CONSTRAINT accrual_installments_posted_consistent CHECK (
    status <> 'posted' OR journal_entry_id IS NOT NULL
  )
);

CREATE INDEX idx_accrual_installments_company ON public.accrual_schedule_installments (company_id);
CREATE INDEX idx_accrual_installments_schedule ON public.accrual_schedule_installments (schedule_id);
-- Hot path for the posting cron: all pending installments due by today.
CREATE INDEX idx_accrual_installments_due ON public.accrual_schedule_installments (period_month)
  WHERE status = 'pending';

ALTER TABLE public.accrual_schedule_installments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company accrual_installments"
  ON public.accrual_schedule_installments FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company accrual_installments"
  ON public.accrual_schedule_installments FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company accrual_installments"
  ON public.accrual_schedule_installments FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()));
-- Posted installments persist for audit; only unposted rows may be removed.
CREATE POLICY "delete own-company accrual_installments"
  ON public.accrual_schedule_installments FOR DELETE
  USING (
    company_id IN (SELECT user_company_ids())
    AND journal_entry_id IS NULL
  );

-- Hard delete of a schedule only while nothing has been posted; cancellation
-- is a status change. Mirrors the depreciation_schedules audit posture.
CREATE POLICY "delete own-company accrual_schedules"
  ON public.accrual_schedules FOR DELETE
  USING (
    company_id IN (SELECT user_company_ids())
    AND NOT EXISTS (
      SELECT 1 FROM public.accrual_schedule_installments i
      WHERE i.schedule_id = accrual_schedules.id
        AND i.journal_entry_id IS NOT NULL
    )
  );

CREATE TRIGGER set_updated_at_accrual_installments
  BEFORE UPDATE ON public.accrual_schedule_installments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_accrual_installments
  AFTER INSERT OR UPDATE OR DELETE ON public.accrual_schedule_installments
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- Once an installment is materialized as a verifikat its financial fields are
-- frozen — same posture as enforce_depreciation_schedule_immutability.
CREATE OR REPLACE FUNCTION public.enforce_accrual_installment_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    IF NEW.amount            IS DISTINCT FROM OLD.amount
       OR NEW.period_month   IS DISTINCT FROM OLD.period_month
       OR NEW.schedule_id    IS DISTINCT FROM OLD.schedule_id
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
      RAISE EXCEPTION 'Cannot modify a posted accrual installment (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path TO 'public';

CREATE TRIGGER enforce_accrual_installment_immutability
  BEFORE UPDATE ON public.accrual_schedule_installments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_accrual_installment_immutability();

-- ============================================================
-- Per-line period fields on both invoice item tables
-- ============================================================
-- The line generators read these to swap the P&L account for the interim
-- account at booking time. They are written by the create-invoice APIs and
-- frozen thereafter (booked invoices are immutable). Credit notes never copy
-- them — crediting cancels the schedule instead.

ALTER TABLE public.supplier_invoice_items
  ADD COLUMN IF NOT EXISTS accrual_period_start date,
  ADD COLUMN IF NOT EXISTS accrual_period_end date,
  ADD COLUMN IF NOT EXISTS accrual_balance_account text;

ALTER TABLE public.supplier_invoice_items
  DROP CONSTRAINT IF EXISTS supplier_invoice_items_accrual_atomic;
ALTER TABLE public.supplier_invoice_items
  ADD CONSTRAINT supplier_invoice_items_accrual_atomic CHECK (
    (accrual_period_start IS NULL AND accrual_period_end IS NULL)
    OR (
      accrual_period_start IS NOT NULL
      AND accrual_period_end IS NOT NULL
      AND accrual_period_end >= accrual_period_start
    )
  );
-- Förutbetalda kostnader live on 17xx (interimsfordringar).
ALTER TABLE public.supplier_invoice_items
  DROP CONSTRAINT IF EXISTS supplier_invoice_items_accrual_account_range;
ALTER TABLE public.supplier_invoice_items
  ADD CONSTRAINT supplier_invoice_items_accrual_account_range CHECK (
    accrual_balance_account IS NULL OR accrual_balance_account ~ '^17[0-9]{2}$'
  );

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS accrual_period_start date,
  ADD COLUMN IF NOT EXISTS accrual_period_end date,
  ADD COLUMN IF NOT EXISTS accrual_balance_account text;

ALTER TABLE public.invoice_items
  DROP CONSTRAINT IF EXISTS invoice_items_accrual_atomic;
ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_accrual_atomic CHECK (
    (accrual_period_start IS NULL AND accrual_period_end IS NULL)
    OR (
      accrual_period_start IS NOT NULL
      AND accrual_period_end IS NOT NULL
      AND accrual_period_end >= accrual_period_start
    )
  );
-- Förutbetalda intäkter live on 29xx (interimsskulder).
ALTER TABLE public.invoice_items
  DROP CONSTRAINT IF EXISTS invoice_items_accrual_account_range;
ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_accrual_account_range CHECK (
    accrual_balance_account IS NULL OR accrual_balance_account ~ '^29[0-9]{2}$'
  );

-- ============================================================
-- journal_entries.source_type: add 'accrual'
-- ============================================================
-- See 20260526120400 for the previous expansion pattern. We preserve all
-- pre-existing source_type values and append the new one.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual'
  ));

-- ============================================================
-- Voucher series default for the new source type
-- ============================================================

ALTER TABLE public.company_settings
  ALTER COLUMN default_voucher_series_per_source_type
  SET DEFAULT '{
    "manual": "A",
    "invoice_created": "A",
    "invoice_paid": "A",
    "invoice_cash_payment": "A",
    "credit_note": "A",
    "supplier_invoice_registered": "A",
    "supplier_invoice_paid": "A",
    "supplier_invoice_cash_payment": "A",
    "supplier_invoice_privately_paid": "A",
    "supplier_credit_note": "A",
    "salary_payment": "A",
    "bank_transaction": "A",
    "reminder_fee": "A",
    "opening_balance": "A",
    "year_end": "A",
    "currency_revaluation": "A",
    "inbox_item": "A",
    "import": "A",
    "system": "A",
    "storno": "A",
    "correction": "A",
    "accrual": "A"
  }'::jsonb;

-- Backfill existing rows so the settings UI shows the new key. The resolver
-- falls back to 'A' for missing keys, so this is cosmetic-but-consistent.
UPDATE public.company_settings
SET default_voucher_series_per_source_type =
      default_voucher_series_per_source_type || '{"accrual": "A"}'::jsonb
WHERE NOT (default_voucher_series_per_source_type ? 'accrual');

NOTIFY pgrst, 'reload schema';
