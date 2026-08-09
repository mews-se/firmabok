-- =============================================================================
-- Salary Module (Lönehantering)
-- =============================================================================
--
-- Comprehensive payroll module for Swedish AB companies:
--   - Employee register with personnummer encryption
--   - Salary runs with multi-step workflow
--   - Per-employee calculation results and line items
--   - Tax table reference data
--   - Annual payroll configuration (statutory rates)
--   - AGI declaration tracking
--
-- All tables are company-scoped with RLS via user_company_ids().
-- Soft-delete only for employees (BFL 7 kap, 7-year retention).

-- =============================================================================
-- 1. salary_payroll_config — Year-specific statutory rates (system table)
-- =============================================================================

CREATE TABLE public.salary_payroll_config (
  id                              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_year                     integer NOT NULL UNIQUE,

  -- Arbetsgivaravgifter breakdown
  avgifter_total                  numeric NOT NULL,
  avgifter_alderspension          numeric NOT NULL,
  avgifter_sjukforsakring         numeric NOT NULL,
  avgifter_foraldraforsakring     numeric NOT NULL,
  avgifter_efterlevandepension    numeric NOT NULL,
  avgifter_arbetsmarknad          numeric NOT NULL,
  avgifter_arbetsskada            numeric NOT NULL,
  avgifter_allman_loneavgift      numeric NOT NULL,
  avgifter_reduced_65plus         numeric NOT NULL,
  avgifter_youth_rate             numeric,
  avgifter_youth_salary_cap       numeric,
  avgifter_vaxa_stod_rate         numeric,
  avgifter_vaxa_stod_cap          numeric,
  avgifter_minimum_annual         numeric NOT NULL,

  -- Egenavgifter for EF
  egenavgifter_total              numeric NOT NULL,

  -- SLP on pensions
  slp_rate                        numeric NOT NULL,

  -- Thresholds
  prisbasbelopp                   numeric NOT NULL,
  inkomstbasbelopp                numeric NOT NULL,
  max_pgi                         numeric NOT NULL,
  sgi_ceiling                     numeric NOT NULL,
  statlig_skatt_brytpunkt         numeric NOT NULL,

  -- Traktamente
  traktamente_heldag              numeric NOT NULL,
  traktamente_halvdag             numeric NOT NULL,
  traktamente_natt                numeric NOT NULL,

  -- Milersättning
  milersattning_egen_bil          numeric NOT NULL,
  milersattning_formansbil_fossil numeric NOT NULL,
  milersattning_formansbil_el     numeric NOT NULL,

  -- Benefits
  kostforman_heldag               numeric NOT NULL,
  kostforman_lunch                numeric NOT NULL,
  kostforman_frukost              numeric NOT NULL,
  friskvard_cap                   numeric NOT NULL,
  bilforman_slr                   numeric NOT NULL,

  -- Sjuklön
  sjuklon_rate                    numeric NOT NULL DEFAULT 0.80,
  karensavdrag_factor             numeric NOT NULL DEFAULT 0.20,
  max_karensavdrag_per_year       integer NOT NULL DEFAULT 10,

  -- Age thresholds
  reduced_avgift_age              integer NOT NULL,

  created_at                      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.salary_payroll_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payroll_config_select" ON public.salary_payroll_config
  FOR SELECT USING (auth.role() = 'authenticated');

-- Seed 2026 values
INSERT INTO public.salary_payroll_config (
  config_year,
  avgifter_total, avgifter_alderspension, avgifter_sjukforsakring,
  avgifter_foraldraforsakring, avgifter_efterlevandepension,
  avgifter_arbetsmarknad, avgifter_arbetsskada, avgifter_allman_loneavgift,
  avgifter_reduced_65plus, avgifter_youth_rate, avgifter_youth_salary_cap,
  avgifter_vaxa_stod_rate, avgifter_vaxa_stod_cap, avgifter_minimum_annual,
  egenavgifter_total, slp_rate,
  prisbasbelopp, inkomstbasbelopp, max_pgi, sgi_ceiling, statlig_skatt_brytpunkt,
  traktamente_heldag, traktamente_halvdag, traktamente_natt,
  milersattning_egen_bil, milersattning_formansbil_fossil, milersattning_formansbil_el,
  kostforman_heldag, kostforman_lunch, kostforman_frukost,
  friskvard_cap, bilforman_slr,
  sjuklon_rate, karensavdrag_factor, max_karensavdrag_per_year,
  reduced_avgift_age
) VALUES (
  2026,
  0.3142, 0.1021, 0.0355,
  0.0200, 0.0030,
  0.0264, 0.0010, 0.1262,
  0.1021, 0.2081, 25000,
  0.1021, 35000, 1000,
  0.2897, 0.2426,
  59200, 83400, 625500, 592000, 660400,
  300, 150, 150,
  25, 12, 9.50,
  310, 124, 62,
  5000, 0.0255,
  0.80, 0.20, 10,
  67
);

-- =============================================================================
-- 2. tax_table_rates — Skatteverket annual tax tables (system table)
-- =============================================================================

CREATE TABLE public.tax_table_rates (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_year            integer NOT NULL,
  table_number          integer NOT NULL,
  column_number         integer NOT NULL,
  income_from           numeric NOT NULL,
  income_to             numeric NOT NULL,
  tax_amount            numeric NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (table_year, table_number, column_number, income_from)
);

ALTER TABLE public.tax_table_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tax_tables_select" ON public.tax_table_rates
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE INDEX idx_tax_table_rates_lookup
  ON public.tax_table_rates (table_year, table_number, column_number, income_from);

-- =============================================================================
-- 3. employees — Company-scoped employee register
-- =============================================================================

CREATE TABLE public.employees (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identity
  first_name            text NOT NULL,
  last_name             text NOT NULL,
  personnummer          text NOT NULL,
  personnummer_last4    text NOT NULL,

  -- Employment
  employment_type       text NOT NULL DEFAULT 'employee'
    CHECK (employment_type IN ('employee', 'company_owner', 'board_member')),
  employment_start      date NOT NULL,
  employment_end        date,
  employment_degree     numeric NOT NULL DEFAULT 100
    CHECK (employment_degree > 0 AND employment_degree <= 100),

  -- Salary
  salary_type           text NOT NULL DEFAULT 'monthly'
    CHECK (salary_type IN ('monthly', 'hourly')),
  monthly_salary        numeric,
  hourly_rate           numeric,

  -- Tax
  tax_table_number      integer,
  tax_column            integer DEFAULT 1
    CHECK (tax_column BETWEEN 1 AND 6),
  tax_municipality      text,
  jamkning_percentage   numeric,
  jamkning_valid_from   date,
  jamkning_valid_to     date,
  is_sidoinkomst        boolean NOT NULL DEFAULT false,

  -- F-skatt
  f_skatt_status        text DEFAULT 'a_skatt'
    CHECK (f_skatt_status IN ('a_skatt', 'f_skatt', 'fa_skatt', 'not_verified')),
  f_skatt_verified_at   date,

  -- Bank
  clearing_number       text,
  bank_account_number   text,

  -- Vacation
  vacation_rule         text NOT NULL DEFAULT 'procentregeln'
    CHECK (vacation_rule IN ('procentregeln', 'sammaloneregeln')),
  vacation_days_per_year integer NOT NULL DEFAULT 25,
  vacation_days_saved   integer NOT NULL DEFAULT 0,
  semestertillagg_rate  numeric NOT NULL DEFAULT 0.0043,

  -- Contact
  email                 text,
  phone                 text,
  address_line1         text,
  postal_code           text,
  city                  text,

  -- AGI
  specification_number  integer,

  -- Växa-stöd
  vaxa_stod_eligible    boolean NOT NULL DEFAULT false,
  vaxa_stod_start       date,
  vaxa_stod_end         date,

  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, personnummer)
);

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employees_select" ON public.employees
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "employees_insert" ON public.employees
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "employees_update" ON public.employees
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "employees_delete" ON public.employees
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_employees_company ON public.employees (company_id);
CREATE INDEX idx_employees_active ON public.employees (company_id, is_active) WHERE is_active = true;

CREATE TRIGGER employees_updated_at
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 4. salary_runs — Monthly salary batch container
-- =============================================================================

CREATE TABLE public.salary_runs (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  period_year           integer NOT NULL,
  period_month          integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  payment_date          date NOT NULL,

  status                text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'approved', 'paid', 'booked')),

  voucher_series        text NOT NULL DEFAULT 'A'
    CHECK (voucher_series ~ '^[A-Z]$'),

  -- Denormalized totals
  total_gross           numeric NOT NULL DEFAULT 0,
  total_tax             numeric NOT NULL DEFAULT 0,
  total_net             numeric NOT NULL DEFAULT 0,
  total_avgifter        numeric NOT NULL DEFAULT 0,
  total_vacation_accrual numeric NOT NULL DEFAULT 0,
  total_employer_cost   numeric NOT NULL DEFAULT 0,

  -- Journal entry refs
  salary_entry_id       uuid REFERENCES public.journal_entries(id),
  avgifter_entry_id     uuid REFERENCES public.journal_entries(id),
  vacation_entry_id     uuid REFERENCES public.journal_entries(id),

  -- AGI tracking
  agi_generated_at      timestamptz,
  agi_submitted_at      timestamptz,

  -- Calculation parameters snapshot
  calculation_params    jsonb,

  -- Audit
  approved_by           uuid REFERENCES auth.users(id),
  approved_at           timestamptz,
  paid_at               timestamptz,
  booked_at             timestamptz,
  booked_by             uuid REFERENCES auth.users(id),
  notes                 text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, period_year, period_month)
);

ALTER TABLE public.salary_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salary_runs_select" ON public.salary_runs
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "salary_runs_insert" ON public.salary_runs
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "salary_runs_update" ON public.salary_runs
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "salary_runs_delete" ON public.salary_runs
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_salary_runs_company ON public.salary_runs (company_id);
CREATE INDEX idx_salary_runs_period ON public.salary_runs (company_id, period_year, period_month);
CREATE INDEX idx_salary_runs_status ON public.salary_runs (status);

CREATE TRIGGER salary_runs_updated_at
  BEFORE UPDATE ON public.salary_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 5. salary_run_employees — Per-employee calculation results
-- =============================================================================

CREATE TABLE public.salary_run_employees (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  salary_run_id         uuid NOT NULL REFERENCES public.salary_runs(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Snapshots
  employment_degree     numeric NOT NULL,
  monthly_salary        numeric NOT NULL,
  salary_type           text NOT NULL,
  hours_worked          numeric,

  -- Calculation results
  gross_salary          numeric NOT NULL DEFAULT 0,
  gross_deductions      numeric NOT NULL DEFAULT 0,
  benefit_values        numeric NOT NULL DEFAULT 0,
  taxable_income        numeric NOT NULL DEFAULT 0,
  tax_withheld          numeric NOT NULL DEFAULT 0,
  net_deductions        numeric NOT NULL DEFAULT 0,
  net_salary            numeric NOT NULL DEFAULT 0,

  -- Employer contributions
  avgifter_rate         numeric NOT NULL DEFAULT 0.3142,
  avgifter_amount       numeric NOT NULL DEFAULT 0,
  avgifter_basis        numeric NOT NULL DEFAULT 0,

  -- Vacation
  vacation_accrual      numeric NOT NULL DEFAULT 0,
  vacation_accrual_avgifter numeric NOT NULL DEFAULT 0,

  -- Tax snapshot
  tax_table_number      integer,
  tax_column            integer,
  tax_table_year        integer,

  -- Absence summary
  sick_days             numeric NOT NULL DEFAULT 0,
  vab_days              numeric NOT NULL DEFAULT 0,
  parental_days         numeric NOT NULL DEFAULT 0,
  vacation_days_taken   numeric NOT NULL DEFAULT 0,

  -- Calculation breakdown
  calculation_breakdown jsonb,

  -- YTD tracking
  ytd_gross             numeric NOT NULL DEFAULT 0,
  ytd_tax               numeric NOT NULL DEFAULT 0,
  ytd_net               numeric NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (salary_run_id, employee_id)
);

ALTER TABLE public.salary_run_employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sre_select" ON public.salary_run_employees
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "sre_insert" ON public.salary_run_employees
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "sre_update" ON public.salary_run_employees
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "sre_delete" ON public.salary_run_employees
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_sre_salary_run ON public.salary_run_employees (salary_run_id);
CREATE INDEX idx_sre_employee ON public.salary_run_employees (employee_id);
CREATE INDEX idx_sre_company ON public.salary_run_employees (company_id);

CREATE TRIGGER sre_updated_at
  BEFORE UPDATE ON public.salary_run_employees
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 6. salary_line_items — Individual pay slip line items
-- =============================================================================

CREATE TABLE public.salary_line_items (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  salary_run_employee_id  uuid NOT NULL REFERENCES public.salary_run_employees(id) ON DELETE CASCADE,
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  item_type               text NOT NULL
    CHECK (item_type IN (
      'monthly_salary', 'hourly_salary', 'overtime', 'bonus', 'commission',
      'gross_deduction_pension', 'gross_deduction_other',
      'benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness', 'benefit_other',
      'sick_karens', 'sick_day2_14', 'sick_day15_plus',
      'vab', 'parental_leave', 'vacation',
      'traktamente_taxfree', 'traktamente_taxable',
      'mileage_taxfree', 'mileage_taxable',
      'net_deduction_advance', 'net_deduction_union', 'net_deduction_benefit_payment',
      'net_deduction_other',
      'correction', 'other'
    )),

  description             text NOT NULL,
  quantity                numeric,
  unit_price              numeric,
  amount                  numeric NOT NULL,

  -- Compliance flags
  is_taxable              boolean NOT NULL DEFAULT true,
  is_avgift_basis         boolean NOT NULL DEFAULT true,
  is_vacation_basis       boolean NOT NULL DEFAULT true,
  is_gross_deduction      boolean NOT NULL DEFAULT false,
  is_net_deduction        boolean NOT NULL DEFAULT false,

  -- Account mapping
  account_number          text,
  sort_order              integer NOT NULL DEFAULT 0,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.salary_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sli_select" ON public.salary_line_items
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "sli_insert" ON public.salary_line_items
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "sli_update" ON public.salary_line_items
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "sli_delete" ON public.salary_line_items
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_sli_sre ON public.salary_line_items (salary_run_employee_id);
CREATE INDEX idx_sli_company ON public.salary_line_items (company_id);

CREATE TRIGGER sli_updated_at
  BEFORE UPDATE ON public.salary_line_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 7. agi_declarations — AGI filing tracking
-- =============================================================================

CREATE TABLE public.agi_declarations (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  salary_run_id         uuid REFERENCES public.salary_runs(id),

  period_year           integer NOT NULL,
  period_month          integer NOT NULL,
  xml_content           text NOT NULL,
  status                text NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'exported', 'submitted', 'accepted', 'rejected')),

  individuppgifter      jsonb NOT NULL,

  total_gross           numeric NOT NULL DEFAULT 0,
  total_tax             numeric NOT NULL DEFAULT 0,
  total_avgifter_basis  numeric NOT NULL DEFAULT 0,
  total_avgifter        numeric NOT NULL DEFAULT 0,
  employee_count        integer NOT NULL DEFAULT 0,

  kvittensnummer        text,
  submitted_at          timestamptz,
  submitted_by          uuid REFERENCES auth.users(id),
  response_data         jsonb,

  is_correction         boolean NOT NULL DEFAULT false,
  corrects_agi_id       uuid REFERENCES public.agi_declarations(id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, period_year, period_month)
);

ALTER TABLE public.agi_declarations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agi_select" ON public.agi_declarations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agi_insert" ON public.agi_declarations
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agi_update" ON public.agi_declarations
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_agi_company ON public.agi_declarations (company_id);
CREATE INDEX idx_agi_period ON public.agi_declarations (company_id, period_year, period_month);

CREATE TRIGGER agi_updated_at
  BEFORE UPDATE ON public.agi_declarations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- Auto-assign specification_number for AGI FK570
-- =============================================================================

CREATE OR REPLACE FUNCTION public.assign_specification_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.specification_number IS NULL THEN
    SELECT COALESCE(MAX(specification_number), 0) + 1
    INTO NEW.specification_number
    FROM public.employees
    WHERE company_id = NEW.company_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER employees_assign_spec_number
  BEFORE INSERT ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.assign_specification_number();

-- Schema reload for PostgREST
NOTIFY pgrst, 'reload schema';
