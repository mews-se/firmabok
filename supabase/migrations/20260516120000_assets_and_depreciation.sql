-- Migration: assets + depreciation_schedules — fixed asset register
--
-- Why this exists: Swedish year-end closing (BFNAR 2016:10 K2, BFNAR 2012:1 K3)
-- requires the company to record planenliga avskrivningar on every fixed
-- asset (anläggningstillgång) each fiscal year. Without an asset register,
-- depreciation must be entered manually as journal entries — accountants
-- get this right, but Gnubok's DIY users typically forget or mis-account.
--
-- The bokslut wizard (lib/bokslut/) wires this register into Phase 3 so
-- depreciation entries are proposed automatically. The K3 component
-- depreciation feature (BFNAR 2012:1 ch.17.4) is reserved via the
-- `k3_components` JSONB column but unused in K2 / Phase 3.
--
-- Disposal handling: gain (3973) / loss (7973) booked against the asset's
-- accumulated depreciation and acquisition cost. Disposal does NOT delete
-- the asset row — BFL retention (7 years) requires the audit trail.

-- ============================================================
-- assets
-- ============================================================

CREATE TABLE public.assets (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id                UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL CHECK (length(name) > 0),
  -- Category groups by BAS account class for default journal accounts and
  -- för K3 component depreciation hints. Free-text instead of enum so new
  -- categories don't require migrations.
  category                  TEXT NOT NULL CHECK (category IN (
    'immaterial',         -- 1010-1099 immateriella
    'building',           -- 1110-1199 byggnader & mark
    'land_improvement',   -- 1150-1159 markanläggningar
    'machinery',          -- 1210-1219 maskiner
    'equipment',          -- 1220-1229 inventarier
    'vehicle',            -- 1240-1249 bilar och transportmedel
    'computer',           -- 1250-1259 datorer
    'other_tangible'      -- 1280-1299 övriga materiella
  )),
  acquisition_date          DATE NOT NULL,
  acquisition_cost          NUMERIC(15, 2) NOT NULL CHECK (acquisition_cost >= 0),
  salvage_value             NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  -- Useful life in months. K2 allows schablon 5 years (60 months) för
  -- inventarier. K3 requires individual assessment.
  useful_life_months        INTEGER NOT NULL CHECK (useful_life_months > 0),
  -- Depreciation method. 'linear' is planenlig raklinje (most common).
  -- The declining_balance_* methods are for skattemässig avskrivning and
  -- only used directly when book and tax depreciation are equal (K2 may);
  -- otherwise överavskrivningar handles the gap (see Phase 2 service).
  depreciation_method       TEXT NOT NULL DEFAULT 'linear' CHECK (depreciation_method IN (
    'linear',
    'declining_balance_30',
    'declining_balance_20'
  )),
  -- BAS account triple. asset = the 12xx anskaffningskonto, accumulated =
  -- the 12x9 ackumulerade avskrivningar, expense = the 78xx avskrivningskonto.
  bas_asset_account         TEXT NOT NULL,
  bas_accumulated_account   TEXT NOT NULL,
  bas_expense_account       TEXT NOT NULL,
  -- Disposal: filled when the asset is sold / scrapped. Once disposed the
  -- row becomes read-only (see trigger below). Keep the row för audit.
  disposed_at               DATE,
  disposed_proceeds         NUMERIC(15, 2),
  -- K3 component depreciation: array of { name, cost, useful_life_months,
  -- method }. Sum of component costs must equal acquisition_cost; enforced
  -- in application layer because PG can't sum JSONB elements in a CHECK.
  -- Empty / NULL for K2 — leaves the door open för Phase 5+ K3 support
  -- without another migration.
  k3_components             JSONB,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Disposal sanity: either both disposal columns set or neither.
  CONSTRAINT assets_disposal_atomic CHECK (
    (disposed_at IS NULL AND disposed_proceeds IS NULL)
    OR (disposed_at IS NOT NULL AND disposed_proceeds IS NOT NULL)
  )
);

CREATE INDEX idx_assets_company ON public.assets (company_id);
CREATE INDEX idx_assets_company_active ON public.assets (company_id) WHERE disposed_at IS NULL;
CREATE INDEX idx_assets_acquisition_date ON public.assets (company_id, acquisition_date);

ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "assets_select" ON public.assets
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "assets_insert" ON public.assets
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "assets_update" ON public.assets
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "assets_delete" ON public.assets
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER assets_updated_at
  BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Read-only after disposal: once disposed_at is set, only the disposal date
-- may not be backtracked. Allow notes edits; block changes to financial
-- attributes (cost, life, method, accounts). Mirrors the journal entry
-- immutability pattern in 20240101000017_enforcement_triggers.sql.
CREATE OR REPLACE FUNCTION public.enforce_asset_post_disposal_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.disposed_at IS NOT NULL THEN
    IF NEW.acquisition_cost     IS DISTINCT FROM OLD.acquisition_cost
       OR NEW.salvage_value     IS DISTINCT FROM OLD.salvage_value
       OR NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months
       OR NEW.depreciation_method IS DISTINCT FROM OLD.depreciation_method
       OR NEW.bas_asset_account IS DISTINCT FROM OLD.bas_asset_account
       OR NEW.bas_accumulated_account IS DISTINCT FROM OLD.bas_accumulated_account
       OR NEW.bas_expense_account IS DISTINCT FROM OLD.bas_expense_account
       OR NEW.acquisition_date  IS DISTINCT FROM OLD.acquisition_date THEN
      RAISE EXCEPTION 'Cannot modify financial attributes of a disposed asset (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_asset_post_disposal_immutability
  BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_post_disposal_immutability();

-- ============================================================
-- depreciation_schedules
-- ============================================================
--
-- One row per (asset, fiscal_period) recording the planenlig avskrivning
-- proposal and the journal entry that materialized it. ON DELETE RESTRICT
-- on journal_entry_id ensures we cannot orphan postings — if a user needs
-- to "redo" a year's depreciation they must reverse the entry (storno)
-- which produces a new entry rather than removing the original. That's
-- BFL-compliant audit behaviour.

CREATE TABLE public.depreciation_schedules (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id               UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_id                 UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  fiscal_period_id         UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE RESTRICT,
  planned_depreciation     NUMERIC(15, 2) NOT NULL CHECK (planned_depreciation >= 0),
  -- Filled when the user commits the proposal to a journal entry. Until
  -- then this row is a "draft" the wizard can re-compute on the fly.
  journal_entry_id         UUID REFERENCES journal_entries(id) ON DELETE RESTRICT,
  posted_at                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One depreciation row per asset per fiscal period (a year cannot have
  -- two planenliga avskrivningar för the same asset).
  CONSTRAINT depreciation_schedules_unique UNIQUE (asset_id, fiscal_period_id)
);

CREATE INDEX idx_depreciation_schedules_company ON public.depreciation_schedules (company_id);
CREATE INDEX idx_depreciation_schedules_period ON public.depreciation_schedules (fiscal_period_id);
CREATE INDEX idx_depreciation_schedules_asset ON public.depreciation_schedules (asset_id);

ALTER TABLE public.depreciation_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "depreciation_schedules_select" ON public.depreciation_schedules
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "depreciation_schedules_insert" ON public.depreciation_schedules
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "depreciation_schedules_update" ON public.depreciation_schedules
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
-- DELETE is intentionally locked down: only allowed för rows without a
-- posted journal entry. Posted rows must persist för audit.
CREATE POLICY "depreciation_schedules_delete" ON public.depreciation_schedules
  FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids())
    AND journal_entry_id IS NULL
  );

-- Block updates that would change the link or financial number after posting.
CREATE OR REPLACE FUNCTION public.enforce_depreciation_schedule_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    IF NEW.planned_depreciation IS DISTINCT FROM OLD.planned_depreciation
       OR NEW.asset_id           IS DISTINCT FROM OLD.asset_id
       OR NEW.fiscal_period_id   IS DISTINCT FROM OLD.fiscal_period_id
       OR NEW.journal_entry_id   IS DISTINCT FROM OLD.journal_entry_id THEN
      RAISE EXCEPTION 'Cannot modify a posted depreciation schedule (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_depreciation_schedule_immutability
  BEFORE UPDATE ON public.depreciation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.enforce_depreciation_schedule_immutability();

NOTIFY pgrst, 'reload schema';
