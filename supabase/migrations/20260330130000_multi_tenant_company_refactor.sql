-- Migration: Multi-tenant (multi-company) refactor (GNU-19)
--
-- Introduces companies, company_members, user_preferences tables.
-- Adds company_id to all data tables, backfills from existing users,
-- rewrites RLS policies, and updates RPCs.
--
-- Execution order:
--   1. Create new tables + helper function
--   2. Add company_id column (nullable) to all existing tables
--   3. Backfill: one company per existing user
--   4. NOT NULL constraints + unique constraint swaps
--   5. Drop all old RLS policies
--   6. Create new company-based RLS policies
--   7. Update RPCs
--   8. Update audit/enforcement triggers
--   9. Indexes

-- =============================================================================
-- 1. NEW TABLES
-- =============================================================================

CREATE TABLE public.companies (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            text NOT NULL,
  org_number      text,
  entity_type     text NOT NULL CHECK (entity_type IN ('enskild_firma', 'aktiebolag')),
  created_by      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.company_members (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, user_id)
);

ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_preferences (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  active_company_id uuid REFERENCES public.companies(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- updated_at triggers
CREATE TRIGGER companies_updated_at
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER company_members_updated_at
  BEFORE UPDATE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. HELPER FUNCTION: user_company_ids()
-- Returns company_ids the authenticated user is a member of.
-- STABLE + SECURITY DEFINER: result cached per statement, bypasses RLS.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.user_company_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company_id FROM public.company_members WHERE user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.user_company_ids() TO authenticated;

-- =============================================================================
-- 3. RLS FOR NEW TABLES
-- =============================================================================

-- companies
CREATE POLICY "companies_select" ON public.companies
  FOR SELECT USING (id IN (SELECT public.user_company_ids()));
CREATE POLICY "companies_insert" ON public.companies
  FOR INSERT WITH CHECK (created_by = auth.uid());
CREATE POLICY "companies_update" ON public.companies
  FOR UPDATE USING (id IN (SELECT public.user_company_ids()));

-- company_members
CREATE POLICY "company_members_select" ON public.company_members
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_members_insert" ON public.company_members
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_members_update" ON public.company_members
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_members_delete" ON public.company_members
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

-- user_preferences
CREATE POLICY "user_preferences_select" ON public.user_preferences
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_preferences_insert" ON public.user_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "user_preferences_update" ON public.user_preferences
  FOR UPDATE USING (auth.uid() = user_id);

-- =============================================================================
-- 4. ADD company_id COLUMN TO ALL EXISTING TABLES
-- =============================================================================

DO $$
DECLARE
  tbl TEXT;
  tables_to_update TEXT[] := ARRAY[
    'company_settings', 'chart_of_accounts', 'fiscal_periods',
    'journal_entries', 'account_balances', 'voucher_sequences',
    'transactions', 'bank_connections', 'bank_file_imports',
    'customers', 'invoices', 'invoice_reminders', 'invoice_payments',
    'suppliers', 'supplier_invoices', 'supplier_invoice_payments',
    'receipts', 'document_attachments', 'invoice_inbox_items',
    'mapping_rules', 'categorization_templates',
    'deadlines', 'cost_centers', 'projects',
    'salary_payments', 'mileage_entries',
    'sie_imports', 'sie_account_mappings',
    'calendar_feeds', 'chat_sessions', 'chat_messages',
    'ai_usage_tracking', 'extension_data', 'api_keys',
    'skatteverket_tokens', 'pending_operations', 'payment_match_log',
    'event_log', 'notification_log', 'audit_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_to_update
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE',
        tbl
      );
    END IF;
  END LOOP;
END $$;

-- Add onboarding_step column (tracks multi-step onboarding progress)
ALTER TABLE public.company_settings ADD COLUMN IF NOT EXISTS onboarding_step integer NOT NULL DEFAULT 1;

-- =============================================================================
-- 5. BACKFILL: Create one company per existing user
-- =============================================================================

-- Temporary mapping table
CREATE TEMP TABLE _user_company_map AS
SELECT
  cs.user_id,
  uuid_generate_v4() AS new_company_id,
  COALESCE(cs.company_name, 'Mitt företag') AS company_name,
  cs.org_number,
  COALESCE(cs.entity_type, 'enskild_firma') AS entity_type
FROM public.company_settings cs;

-- Insert companies
INSERT INTO public.companies (id, name, org_number, entity_type, created_by)
SELECT new_company_id, company_name, org_number, entity_type, user_id
FROM _user_company_map;

-- Insert owner memberships
INSERT INTO public.company_members (company_id, user_id, role)
SELECT new_company_id, user_id, 'owner'
FROM _user_company_map;

-- Insert user preferences
INSERT INTO public.user_preferences (user_id, active_company_id)
SELECT user_id, new_company_id
FROM _user_company_map;

-- Backfill company_id on all tables using the mapping
DO $$
DECLARE
  tbl TEXT;
  tables_to_backfill TEXT[] := ARRAY[
    'company_settings', 'chart_of_accounts', 'fiscal_periods',
    'journal_entries', 'account_balances', 'voucher_sequences',
    'transactions', 'bank_connections', 'bank_file_imports',
    'customers', 'invoices', 'invoice_reminders', 'invoice_payments',
    'suppliers', 'supplier_invoices', 'supplier_invoice_payments',
    'receipts', 'document_attachments', 'invoice_inbox_items',
    'mapping_rules', 'categorization_templates',
    'deadlines', 'cost_centers', 'projects',
    'salary_payments', 'mileage_entries',
    'sie_imports', 'sie_account_mappings',
    'calendar_feeds', 'chat_sessions', 'chat_messages',
    'ai_usage_tracking', 'extension_data', 'api_keys',
    'skatteverket_tokens', 'pending_operations', 'payment_match_log',
    'event_log', 'notification_log', 'audit_log'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_to_backfill
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format(
        'UPDATE public.%I t SET company_id = m.new_company_id FROM _user_company_map m WHERE t.user_id = m.user_id AND t.company_id IS NULL',
        tbl
      );
    END IF;
  END LOOP;
END $$;

DROP TABLE _user_company_map;

-- =============================================================================
-- 6. NOT NULL CONSTRAINTS + UNIQUE CONSTRAINT SWAPS
-- =============================================================================

-- Add NOT NULL on company_id (except tables where NULL is valid)
DO $$
DECLARE
  tbl TEXT;
  not_null_tables TEXT[] := ARRAY[
    'company_settings', 'chart_of_accounts', 'fiscal_periods',
    'journal_entries', 'account_balances', 'voucher_sequences',
    'transactions', 'bank_connections', 'bank_file_imports',
    'customers', 'invoices', 'invoice_reminders', 'invoice_payments',
    'suppliers', 'supplier_invoices', 'supplier_invoice_payments',
    'receipts', 'document_attachments', 'invoice_inbox_items',
    'categorization_templates',
    'deadlines', 'cost_centers', 'projects',
    'salary_payments', 'mileage_entries',
    'sie_imports', 'sie_account_mappings',
    'calendar_feeds', 'chat_sessions', 'chat_messages',
    'ai_usage_tracking', 'extension_data', 'api_keys',
    'skatteverket_tokens', 'pending_operations'
  ];
BEGIN
  FOREACH tbl IN ARRAY not_null_tables
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN company_id SET NOT NULL', tbl);
    END IF;
  END LOOP;
END $$;
-- mapping_rules, audit_log, event_log, notification_log, payment_match_log: company_id stays nullable
-- audit_log.user_id: nullable because some tables (e.g. company_settings) no longer carry user_id
ALTER TABLE public.audit_log ALTER COLUMN user_id DROP NOT NULL;

-- Drop old unique constraints and create new ones with company_id
-- company_settings: (user_id) → (company_id)
ALTER TABLE public.company_settings DROP CONSTRAINT IF EXISTS company_settings_user_id_key;
ALTER TABLE public.company_settings ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.company_settings ADD CONSTRAINT company_settings_company_id_key UNIQUE (company_id);

-- transactions: (user_id, external_id) → (company_id, external_id)
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_user_id_external_id_key;
DROP INDEX IF EXISTS transactions_user_id_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_company_external_id
  ON public.transactions (company_id, external_id) WHERE external_id IS NOT NULL;

-- invoices: (user_id, invoice_number) → (company_id, invoice_number)
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_user_id_invoice_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_company_invoice_number
  ON public.invoices (company_id, invoice_number) WHERE invoice_number IS NOT NULL;

-- supplier_invoices: (user_id, arrival_number) → (company_id, arrival_number)
ALTER TABLE public.supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_user_id_arrival_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_company_arrival_number
  ON public.supplier_invoices (company_id, arrival_number);

-- supplier_invoices: (user_id, supplier_id, supplier_invoice_number) → (company_id, supplier_id, supplier_invoice_number)
ALTER TABLE public.supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_user_id_supplier_id_supplier_invoice_numbe_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_company_supplier_number
  ON public.supplier_invoices (company_id, supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL;

-- chart_of_accounts: (user_id, account_number) → (company_id, account_number)
ALTER TABLE public.chart_of_accounts DROP CONSTRAINT IF EXISTS chart_of_accounts_user_id_account_number_key;
ALTER TABLE public.chart_of_accounts ADD CONSTRAINT chart_of_accounts_company_id_account_number_key
  UNIQUE (company_id, account_number);

-- fiscal_periods: (user_id, period_start, period_end) → (company_id, period_start, period_end)
ALTER TABLE public.fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_periods_user_id_period_start_period_end_key;
ALTER TABLE public.fiscal_periods ADD CONSTRAINT fiscal_periods_company_id_period_start_period_end_key
  UNIQUE (company_id, period_start, period_end);

-- account_balances: (user_id, fiscal_period_id, account_number) → (company_id, fiscal_period_id, account_number)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'account_balances') THEN
    ALTER TABLE public.account_balances DROP CONSTRAINT IF EXISTS account_balances_user_id_fiscal_period_id_account_number_key;
    ALTER TABLE public.account_balances ADD CONSTRAINT account_balances_company_id_fiscal_period_id_account_number_key
      UNIQUE (company_id, fiscal_period_id, account_number);
  END IF;
END $$;

-- voucher_sequences: (user_id, fiscal_period_id, voucher_series) → (company_id, fiscal_period_id, voucher_series)
ALTER TABLE public.voucher_sequences DROP CONSTRAINT IF EXISTS voucher_sequences_user_id_fiscal_period_id_voucher_series_key;
ALTER TABLE public.voucher_sequences ADD CONSTRAINT voucher_sequences_company_id_fiscal_period_id_voucher_series_key
  UNIQUE (company_id, fiscal_period_id, voucher_series);

-- cost_centers: (user_id, code) → (company_id, code)
ALTER TABLE public.cost_centers DROP CONSTRAINT IF EXISTS cost_centers_user_id_code_key;
ALTER TABLE public.cost_centers ADD CONSTRAINT cost_centers_company_id_code_key
  UNIQUE (company_id, code);

-- projects: (user_id, code) → (company_id, code)
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_user_id_code_key;
ALTER TABLE public.projects ADD CONSTRAINT projects_company_id_code_key
  UNIQUE (company_id, code);

-- categorization_templates: (user_id, counterparty_name) → (company_id, counterparty_name)
ALTER TABLE public.categorization_templates DROP CONSTRAINT IF EXISTS categorization_templates_user_id_counterparty_name_key;
ALTER TABLE public.categorization_templates ADD CONSTRAINT categorization_templates_company_id_counterparty_name_key
  UNIQUE (company_id, counterparty_name);

-- sie_account_mappings: (user_id, source_account) → (company_id, source_account)
ALTER TABLE public.sie_account_mappings DROP CONSTRAINT IF EXISTS sie_account_mappings_user_id_source_account_key;
ALTER TABLE public.sie_account_mappings ADD CONSTRAINT sie_account_mappings_company_id_source_account_key
  UNIQUE (company_id, source_account);

-- sie_imports: (user_id, file_hash) → (company_id, file_hash)
ALTER TABLE public.sie_imports DROP CONSTRAINT IF EXISTS sie_imports_user_id_file_hash_key;
ALTER TABLE public.sie_imports ADD CONSTRAINT sie_imports_company_id_file_hash_key
  UNIQUE (company_id, file_hash);

-- calendar_feeds: (user_id) → (company_id)
ALTER TABLE public.calendar_feeds DROP CONSTRAINT IF EXISTS calendar_feeds_user_id_key;
ALTER TABLE public.calendar_feeds ADD CONSTRAINT calendar_feeds_company_id_key
  UNIQUE (company_id);

-- skatteverket_tokens: (user_id) → (company_id)
ALTER TABLE public.skatteverket_tokens DROP CONSTRAINT IF EXISTS skatteverket_tokens_user_id_key;
ALTER TABLE public.skatteverket_tokens ADD CONSTRAINT skatteverket_tokens_company_id_key
  UNIQUE (company_id);

-- extension_data: (user_id, extension_id, key) → (company_id, extension_id, key)
ALTER TABLE public.extension_data DROP CONSTRAINT IF EXISTS extension_data_user_id_extension_id_key_key;
ALTER TABLE public.extension_data ADD CONSTRAINT extension_data_company_id_extension_id_key_key
  UNIQUE (company_id, extension_id, key);

-- =============================================================================
-- 7. DROP ALL OLD RLS POLICIES ON AFFECTED TABLES
-- =============================================================================

DO $$
DECLARE
  pol RECORD;
  affected_tables TEXT[] := ARRAY[
    'company_settings', 'chart_of_accounts', 'fiscal_periods',
    'journal_entries', 'journal_entry_lines',
    'account_balances', 'voucher_sequences',
    'transactions', 'bank_connections', 'bank_file_imports',
    'customers', 'invoices', 'invoice_items',
    'invoice_reminders', 'invoice_payments',
    'suppliers', 'supplier_invoices', 'supplier_invoice_items',
    'supplier_invoice_payments',
    'receipts', 'receipt_line_items',
    'document_attachments', 'invoice_inbox_items',
    'mapping_rules', 'categorization_templates',
    'deadlines', 'cost_centers', 'projects',
    'salary_payments', 'mileage_entries',
    'sie_imports', 'sie_account_mappings',
    'calendar_feeds', 'chat_sessions', 'chat_messages',
    'ai_usage_tracking', 'extension_data', 'api_keys',
    'skatteverket_tokens', 'pending_operations', 'payment_match_log',
    'event_log', 'notification_log', 'audit_log'
  ];
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY affected_tables
  LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE tablename = tbl AND schemaname = 'public'
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, tbl);
    END LOOP;
  END LOOP;
END $$;

-- =============================================================================
-- 8. CREATE NEW company_id-BASED RLS POLICIES
-- =============================================================================

-- Helper: standard company-scoped policies (SELECT, INSERT, UPDATE)
-- We create them per-table for clarity and auditability.

-- company_settings
CREATE POLICY "company_settings_select" ON public.company_settings
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_settings_insert" ON public.company_settings
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_settings_update" ON public.company_settings
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- chart_of_accounts
CREATE POLICY "chart_of_accounts_select" ON public.chart_of_accounts
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "chart_of_accounts_insert" ON public.chart_of_accounts
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "chart_of_accounts_update" ON public.chart_of_accounts
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- fiscal_periods
CREATE POLICY "fiscal_periods_select" ON public.fiscal_periods
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "fiscal_periods_insert" ON public.fiscal_periods
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "fiscal_periods_update" ON public.fiscal_periods
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- journal_entries
CREATE POLICY "journal_entries_select" ON public.journal_entries
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "journal_entries_insert" ON public.journal_entries
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "journal_entries_update" ON public.journal_entries
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- journal_entry_lines (child: join to parent journal_entries)
CREATE POLICY "journal_entry_lines_select" ON public.journal_entry_lines
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.journal_entries je
            WHERE je.id = journal_entry_lines.journal_entry_id
              AND je.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "journal_entry_lines_insert" ON public.journal_entry_lines
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.journal_entries je
            WHERE je.id = journal_entry_lines.journal_entry_id
              AND je.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "journal_entry_lines_update" ON public.journal_entry_lines
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.journal_entries je
            WHERE je.id = journal_entry_lines.journal_entry_id
              AND je.company_id IN (SELECT public.user_company_ids()))
  );

-- account_balances (may not exist on fresh DBs)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'account_balances') THEN
    EXECUTE 'CREATE POLICY "account_balances_select" ON public.account_balances FOR SELECT USING (company_id IN (SELECT public.user_company_ids()))';
    EXECUTE 'CREATE POLICY "account_balances_insert" ON public.account_balances FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()))';
    EXECUTE 'CREATE POLICY "account_balances_update" ON public.account_balances FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))';
  END IF;
END $$;

-- voucher_sequences
CREATE POLICY "voucher_sequences_select" ON public.voucher_sequences
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "voucher_sequences_insert" ON public.voucher_sequences
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "voucher_sequences_update" ON public.voucher_sequences
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- transactions
CREATE POLICY "transactions_select" ON public.transactions
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "transactions_insert" ON public.transactions
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "transactions_update" ON public.transactions
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- bank_connections
CREATE POLICY "bank_connections_select" ON public.bank_connections
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "bank_connections_insert" ON public.bank_connections
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "bank_connections_update" ON public.bank_connections
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- bank_file_imports
CREATE POLICY "bank_file_imports_select" ON public.bank_file_imports
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "bank_file_imports_insert" ON public.bank_file_imports
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "bank_file_imports_update" ON public.bank_file_imports
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- customers
CREATE POLICY "customers_select" ON public.customers
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "customers_insert" ON public.customers
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "customers_update" ON public.customers
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- invoices
CREATE POLICY "invoices_select" ON public.invoices
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoices_insert" ON public.invoices
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoices_update" ON public.invoices
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- invoice_items (child: join to parent invoices)
CREATE POLICY "invoice_items_select" ON public.invoice_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.invoices i
            WHERE i.id = invoice_items.invoice_id
              AND i.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "invoice_items_insert" ON public.invoice_items
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.invoices i
            WHERE i.id = invoice_items.invoice_id
              AND i.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "invoice_items_update" ON public.invoice_items
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.invoices i
            WHERE i.id = invoice_items.invoice_id
              AND i.company_id IN (SELECT public.user_company_ids()))
  );

-- invoice_reminders
CREATE POLICY "invoice_reminders_select" ON public.invoice_reminders
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoice_reminders_insert" ON public.invoice_reminders
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoice_reminders_update" ON public.invoice_reminders
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- invoice_payments
CREATE POLICY "invoice_payments_select" ON public.invoice_payments
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoice_payments_insert" ON public.invoice_payments
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoice_payments_update" ON public.invoice_payments
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- suppliers
CREATE POLICY "suppliers_select" ON public.suppliers
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "suppliers_insert" ON public.suppliers
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "suppliers_update" ON public.suppliers
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- supplier_invoices
CREATE POLICY "supplier_invoices_select" ON public.supplier_invoices
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "supplier_invoices_insert" ON public.supplier_invoices
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "supplier_invoices_update" ON public.supplier_invoices
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- supplier_invoice_items (child: join to parent supplier_invoices)
CREATE POLICY "supplier_invoice_items_select" ON public.supplier_invoice_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.supplier_invoices si
            WHERE si.id = supplier_invoice_items.supplier_invoice_id
              AND si.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "supplier_invoice_items_insert" ON public.supplier_invoice_items
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.supplier_invoices si
            WHERE si.id = supplier_invoice_items.supplier_invoice_id
              AND si.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "supplier_invoice_items_update" ON public.supplier_invoice_items
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.supplier_invoices si
            WHERE si.id = supplier_invoice_items.supplier_invoice_id
              AND si.company_id IN (SELECT public.user_company_ids()))
  );

-- supplier_invoice_payments
CREATE POLICY "supplier_invoice_payments_select" ON public.supplier_invoice_payments
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "supplier_invoice_payments_insert" ON public.supplier_invoice_payments
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "supplier_invoice_payments_update" ON public.supplier_invoice_payments
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- receipts
CREATE POLICY "receipts_select" ON public.receipts
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "receipts_insert" ON public.receipts
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "receipts_update" ON public.receipts
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- receipt_line_items (child: join to parent receipts)
CREATE POLICY "receipt_line_items_select" ON public.receipt_line_items
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.receipts r
            WHERE r.id = receipt_line_items.receipt_id
              AND r.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "receipt_line_items_insert" ON public.receipt_line_items
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.receipts r
            WHERE r.id = receipt_line_items.receipt_id
              AND r.company_id IN (SELECT public.user_company_ids()))
  );
CREATE POLICY "receipt_line_items_update" ON public.receipt_line_items
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.receipts r
            WHERE r.id = receipt_line_items.receipt_id
              AND r.company_id IN (SELECT public.user_company_ids()))
  );

-- document_attachments (no DELETE policy — blocked by trigger)
CREATE POLICY "document_attachments_select" ON public.document_attachments
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "document_attachments_insert" ON public.document_attachments
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "document_attachments_update" ON public.document_attachments
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- invoice_inbox_items
CREATE POLICY "invoice_inbox_items_select" ON public.invoice_inbox_items
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoice_inbox_items_insert" ON public.invoice_inbox_items
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "invoice_inbox_items_update" ON public.invoice_inbox_items
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- mapping_rules (system rules have company_id IS NULL)
CREATE POLICY "mapping_rules_select" ON public.mapping_rules
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()) OR company_id IS NULL);
CREATE POLICY "mapping_rules_insert" ON public.mapping_rules
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "mapping_rules_update" ON public.mapping_rules
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- categorization_templates
CREATE POLICY "categorization_templates_select" ON public.categorization_templates
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "categorization_templates_insert" ON public.categorization_templates
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "categorization_templates_update" ON public.categorization_templates
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- deadlines
CREATE POLICY "deadlines_select" ON public.deadlines
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "deadlines_insert" ON public.deadlines
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "deadlines_update" ON public.deadlines
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- cost_centers
CREATE POLICY "cost_centers_select" ON public.cost_centers
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "cost_centers_insert" ON public.cost_centers
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "cost_centers_update" ON public.cost_centers
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- projects
CREATE POLICY "projects_select" ON public.projects
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "projects_insert" ON public.projects
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "projects_update" ON public.projects
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- salary_payments (may not exist on fresh DBs)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'salary_payments') THEN
    EXECUTE 'CREATE POLICY "salary_payments_select" ON public.salary_payments FOR SELECT USING (company_id IN (SELECT public.user_company_ids()))';
    EXECUTE 'CREATE POLICY "salary_payments_insert" ON public.salary_payments FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()))';
    EXECUTE 'CREATE POLICY "salary_payments_update" ON public.salary_payments FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))';
  END IF;
END $$;

-- mileage_entries (may not exist on fresh DBs)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'mileage_entries') THEN
    EXECUTE 'CREATE POLICY "mileage_entries_select" ON public.mileage_entries FOR SELECT USING (company_id IN (SELECT public.user_company_ids()))';
    EXECUTE 'CREATE POLICY "mileage_entries_insert" ON public.mileage_entries FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()))';
    EXECUTE 'CREATE POLICY "mileage_entries_update" ON public.mileage_entries FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))';
  END IF;
END $$;

-- sie_imports
CREATE POLICY "sie_imports_select" ON public.sie_imports
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "sie_imports_insert" ON public.sie_imports
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "sie_imports_update" ON public.sie_imports
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- sie_account_mappings
CREATE POLICY "sie_account_mappings_select" ON public.sie_account_mappings
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "sie_account_mappings_insert" ON public.sie_account_mappings
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "sie_account_mappings_update" ON public.sie_account_mappings
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- calendar_feeds
CREATE POLICY "calendar_feeds_select" ON public.calendar_feeds
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "calendar_feeds_insert" ON public.calendar_feeds
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "calendar_feeds_update" ON public.calendar_feeds
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- chat_sessions
CREATE POLICY "chat_sessions_select" ON public.chat_sessions
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "chat_sessions_insert" ON public.chat_sessions
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "chat_sessions_update" ON public.chat_sessions
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- chat_messages
CREATE POLICY "chat_messages_select" ON public.chat_messages
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "chat_messages_insert" ON public.chat_messages
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "chat_messages_update" ON public.chat_messages
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- ai_usage_tracking
CREATE POLICY "ai_usage_tracking_select" ON public.ai_usage_tracking
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "ai_usage_tracking_insert" ON public.ai_usage_tracking
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

-- extension_data
CREATE POLICY "extension_data_select" ON public.extension_data
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "extension_data_insert" ON public.extension_data
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "extension_data_update" ON public.extension_data
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- api_keys
CREATE POLICY "api_keys_select" ON public.api_keys
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "api_keys_insert" ON public.api_keys
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "api_keys_update" ON public.api_keys
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "api_keys_delete" ON public.api_keys
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

-- skatteverket_tokens
CREATE POLICY "skatteverket_tokens_select" ON public.skatteverket_tokens
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "skatteverket_tokens_insert" ON public.skatteverket_tokens
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "skatteverket_tokens_update" ON public.skatteverket_tokens
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- pending_operations (SELECT + UPDATE only, writes via service role)
CREATE POLICY "pending_operations_select" ON public.pending_operations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "pending_operations_update" ON public.pending_operations
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()));

-- payment_match_log (nullable company_id)
CREATE POLICY "payment_match_log_select" ON public.payment_match_log
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "payment_match_log_insert" ON public.payment_match_log
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()) OR company_id IS NULL);

-- event_log (SELECT only for users)
CREATE POLICY "event_log_select" ON public.event_log
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- notification_log
CREATE POLICY "notification_log_select" ON public.notification_log
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()) OR company_id IS NULL);

-- audit_log (SELECT only for users, writes via SECURITY DEFINER triggers)
CREATE POLICY "audit_log_select" ON public.audit_log
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- =============================================================================
-- 9. UPDATE RPCs
-- =============================================================================

-- next_voucher_number: p_user_id → p_company_id
DROP FUNCTION IF EXISTS public.next_voucher_number(uuid, uuid, text);
CREATE OR REPLACE FUNCTION public.next_voucher_number(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
BEGIN
  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, auth.uid(), p_fiscal_period_id, p_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  RETURN v_next;
END;
$$;

-- seed_chart_of_accounts: p_user_id → p_company_id
DROP FUNCTION IF EXISTS public.seed_chart_of_accounts(uuid, text);
CREATE OR REPLACE FUNCTION public.seed_chart_of_accounts(p_company_id uuid, p_entity_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_account_count integer;
  v_user_id uuid;
BEGIN
  -- Determine user_id from company
  SELECT created_by INTO v_user_id FROM public.companies WHERE id = p_company_id;

  SELECT count(*) INTO v_account_count
  FROM public.chart_of_accounts
  WHERE company_id = p_company_id;

  IF v_account_count > 0 THEN
    RETURN;
  END IF;

  -- Assets (1xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1930', 'Foretagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true),
    (v_user_id, p_company_id, '1940', 'Ovriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true);

  -- Equity (2xxx)
  IF p_entity_type = 'enskild_firma' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2010', 'Eget kapital', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2013', 'Ovriga egna uttag', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2018', 'Ovriga egna insattningar', 2, '20', 'equity', 'credit', 'k1', true);
  END IF;

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true),
      (v_user_id, p_company_id, '2099', 'Arets resultat', 2, '20', 'equity', 'credit', 'k1', true);
  END IF;

  -- Liabilities (2xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '2440', 'Leverantorsskulder', 2, '24', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2610', 'Utgaende moms 25%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2611', 'Utgaende moms 12%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2612', 'Utgaende moms 6%', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2641', 'Debiterad ingaende moms', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2650', 'Redovisningskonto for moms', 2, '26', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true),
    (v_user_id, p_company_id, '2731', 'Avrakning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true);

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '2893', 'Skuld till aktieagare', 2, '28', 'liability', 'credit', 'k1', true);
  END IF;

  -- Revenue (3xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '3001', 'Forsaljning tjanster 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3002', 'Forsaljning varor 25%', 3, '30', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3100', 'Momsfri forsaljning', 3, '31', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3900', 'Ovriga rorelseintakter', 3, '39', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true);

  -- COGS (4xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '4000', 'Varuinkop', 4, '40', 'expense', 'debit', 'k1', true);

  -- External expenses (5xxx-6xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5410', 'Forbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5460', 'Forbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6530', 'Redovisningstjanster', 6, '65', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true),
    (v_user_id, p_company_id, '6991', 'Ovriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true);

  -- Personnel (7xxx)
  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
    VALUES
      (v_user_id, p_company_id, '7010', 'Loner', 7, '70', 'expense', 'debit', 'k1', true),
      (v_user_id, p_company_id, '7210', 'Semesterloner', 7, '72', 'expense', 'debit', 'k1', true),
      (v_user_id, p_company_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true);
  END IF;

  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '7960', 'Valutakursforluster', 7, '79', 'expense', 'debit', 'k1', true);

  -- Financial (8xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account)
  VALUES
    (v_user_id, p_company_id, '8310', 'Ranteintakter', 8, '83', 'revenue', 'credit', 'k1', true),
    (v_user_id, p_company_id, '8410', 'Rantekostnader', 8, '84', 'expense', 'debit', 'k1', true);
END;
$$;

-- detect_voucher_gaps: p_user_id → p_company_id
DROP FUNCTION IF EXISTS public.detect_voucher_gaps(uuid, uuid, text);
CREATE OR REPLACE FUNCTION public.detect_voucher_gaps(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'
)
RETURNS TABLE (gap_start integer, gap_end integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH numbered AS (
    SELECT voucher_number,
           LEAD(voucher_number) OVER (ORDER BY voucher_number) AS next_number
    FROM public.journal_entries
    WHERE company_id = p_company_id
      AND fiscal_period_id = p_fiscal_period_id
      AND voucher_series = p_series
      AND status != 'draft'
    ORDER BY voucher_number
  )
  SELECT
    voucher_number + 1 AS gap_start,
    next_number - 1 AS gap_end
  FROM numbered
  WHERE next_number IS NOT NULL
    AND next_number > voucher_number + 1;
END;
$$;

-- generate_invoice_number: p_user_id → p_company_id
DROP FUNCTION IF EXISTS public.generate_invoice_number(uuid);
CREATE OR REPLACE FUNCTION public.generate_invoice_number(p_company_id UUID)
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
  WHERE company_id = p_company_id
  RETURNING invoice_prefix, next_invoice_number - 1
  INTO v_prefix, v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
  RETURN COALESCE(v_prefix, '') || v_year || LPAD(v_number::TEXT, 3, '0');
END;
$$;

-- generate_delivery_note_number: p_user_id → p_company_id
DROP FUNCTION IF EXISTS public.generate_delivery_note_number(uuid);
CREATE OR REPLACE FUNCTION public.generate_delivery_note_number(p_company_id UUID)
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
  WHERE company_id = p_company_id
  RETURNING next_delivery_note_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
  RETURN 'FS-' || v_year || LPAD(v_number::TEXT, 3, '0');
END;
$$;

-- get_next_arrival_number: p_user_id → p_company_id
DROP FUNCTION IF EXISTS public.get_next_arrival_number(uuid);
CREATE OR REPLACE FUNCTION public.get_next_arrival_number(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
BEGIN
  SELECT COALESCE(MAX(arrival_number), 0) + 1
  INTO v_next
  FROM public.supplier_invoices
  WHERE company_id = p_company_id;

  RETURN v_next;
END;
$$;

-- validate_and_increment_api_key: add company_id to return type
DROP FUNCTION IF EXISTS public.validate_and_increment_api_key(text);

CREATE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(user_id uuid, company_id uuid, rate_limited boolean, scopes text[])
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
BEGIN
  SELECT ak.user_id, ak.company_id, ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes
  INTO v_user_id, v_company_id, v_rate_limit_rpm, v_request_count, v_window_start, v_scopes
  FROM public.api_keys ak
  WHERE ak.key_hash = p_key_hash AND ak.revoked_at IS NULL
  FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
    SET request_count = 1,
        rate_limit_window_start = now(),
        last_used_at = now()
    WHERE key_hash = p_key_hash;

    RETURN QUERY SELECT v_user_id, v_company_id, false, v_scopes;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, true, v_scopes;
    RETURN;
  END IF;

  UPDATE public.api_keys
  SET request_count = request_count + 1,
      last_used_at = now()
  WHERE key_hash = p_key_hash;

  RETURN QUERY SELECT v_user_id, v_company_id, false, v_scopes;
END;
$$;

-- =============================================================================
-- 10. UPDATE AUDIT/ENFORCEMENT TRIGGERS
-- =============================================================================

-- write_audit_log: include company_id from record (via jsonb extraction)
CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  -- Fall back to auth.uid() when the row does not carry user_id
  v_user_id := COALESCE(v_user_id, auth.uid());

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description)
  VALUES (v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- block_document_deletion: include company_id in audit_log writes
CREATE OR REPLACE FUNCTION public.block_document_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_entry_status text;
  v_retention_expires date;
BEGIN
  IF OLD.journal_entry_id IS NOT NULL THEN
    SELECT je.status INTO v_entry_status
    FROM public.journal_entries je
    WHERE je.id = OLD.journal_entry_id;

    IF v_entry_status IN ('posted', 'reversed') THEN
      INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
      VALUES (OLD.user_id, OLD.company_id, 'DOCUMENT_DELETE_BLOCKED', 'document_attachments', OLD.id,
        'Attempted deletion of document linked to ' || v_entry_status || ' journal entry ' || OLD.journal_entry_id);

      RAISE EXCEPTION 'Cannot delete document linked to a % journal entry (Bokföringslagen)',
        v_entry_status;
    END IF;
  END IF;

  IF OLD.journal_entry_id IS NOT NULL THEN
    SELECT fp.retention_expires_at INTO v_retention_expires
    FROM public.journal_entries je
    JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
    WHERE je.id = OLD.journal_entry_id;

    IF v_retention_expires IS NOT NULL AND v_retention_expires > CURRENT_DATE THEN
      INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
      VALUES (OLD.user_id, OLD.company_id, 'RETENTION_BLOCK', 'document_attachments', OLD.id,
        'Attempted deletion within retention period (expires ' || v_retention_expires || ')');

      RAISE EXCEPTION 'Cannot delete document within 7-year retention period (expires %)',
        v_retention_expires;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

-- enforce_retention_journal_entries: include company_id in audit_log writes
CREATE OR REPLACE FUNCTION public.enforce_retention_journal_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_retention_expires date;
BEGIN
  SELECT fp.retention_expires_at INTO v_retention_expires
  FROM public.fiscal_periods fp
  WHERE fp.id = OLD.fiscal_period_id;

  IF v_retention_expires IS NOT NULL AND v_retention_expires > CURRENT_DATE THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (OLD.user_id, OLD.company_id, 'RETENTION_BLOCK', 'journal_entries', OLD.id,
      'Attempted deletion within retention period (expires ' || v_retention_expires || ')');

    RAISE EXCEPTION 'Cannot delete journal entry within 7-year retention period (expires %)',
      v_retention_expires;
  END IF;

  RETURN OLD;
END;
$$;

-- =============================================================================
-- 11. INDEXES
-- =============================================================================

-- company_id indexes for key tables (high-query-volume)
CREATE INDEX IF NOT EXISTS idx_company_settings_company_id ON public.company_settings (company_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_company_id ON public.journal_entries (company_id);
CREATE INDEX IF NOT EXISTS idx_transactions_company_id ON public.transactions (company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON public.invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_customers_company_id ON public.customers (company_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_company_id ON public.suppliers (company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_company_id ON public.supplier_invoices (company_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company_id ON public.fiscal_periods (company_id);
CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_company_id ON public.chart_of_accounts (company_id);
CREATE INDEX IF NOT EXISTS idx_receipts_company_id ON public.receipts (company_id);
CREATE INDEX IF NOT EXISTS idx_document_attachments_company_id ON public.document_attachments (company_id);
CREATE INDEX IF NOT EXISTS idx_deadlines_company_id ON public.deadlines (company_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_company_id ON public.api_keys (company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_company_id ON public.audit_log (company_id);
CREATE INDEX IF NOT EXISTS idx_company_members_user_id ON public.company_members (user_id);
CREATE INDEX IF NOT EXISTS idx_company_members_company_id ON public.company_members (company_id);

-- Composite indexes replacing user_id-based ones
CREATE INDEX IF NOT EXISTS idx_transactions_company_date ON public.transactions (company_id, date)
  WHERE journal_entry_id IS NULL;
