-- Drop 36 unused tables — zero .from() calls, zero rows.
-- Grouped by module; children before parents.

-- HR / Payroll
DROP TABLE IF EXISTS public.salary_additions CASCADE;
DROP TABLE IF EXISTS public.salary_run_items CASCADE;
DROP TABLE IF EXISTS public.salary_payments CASCADE;
DROP TABLE IF EXISTS public.salary_runs CASCADE;
DROP TABLE IF EXISTS public.absence_records CASCADE;
DROP TABLE IF EXISTS public.mileage_entries CASCADE;
DROP TABLE IF EXISTS public.employees CASCADE;

-- Asset Management
DROP TABLE IF EXISTS public.depreciation_schedule CASCADE;
DROP TABLE IF EXISTS public.assets CASCADE;
DROP TABLE IF EXISTS public.asset_categories CASCADE;

-- Bank Reconciliation
DROP TABLE IF EXISTS public.bank_reconciliation_items CASCADE;
DROP TABLE IF EXISTS public.bank_reconciliation_sessions CASCADE;
DROP TABLE IF EXISTS public.account_balances CASCADE;

-- Budgeting / Forecasting
DROP TABLE IF EXISTS public.budget_entries CASCADE;
DROP TABLE IF EXISTS public.budgets CASCADE;
DROP TABLE IF EXISTS public.cash_flow_forecasts CASCADE;

-- Orders / Quotes
DROP TABLE IF EXISTS public.order_items CASCADE;
DROP TABLE IF EXISTS public.orders CASCADE;
DROP TABLE IF EXISTS public.quote_items CASCADE;
DROP TABLE IF EXISTS public.quotes CASCADE;

-- Analytics / KPI
DROP TABLE IF EXISTS public.ai_insights_cache CASCADE;
DROP TABLE IF EXISTS public.financial_insights CASCADE;
DROP TABLE IF EXISTS public.kpi_snapshots CASCADE;

-- Tax / Compliance
DROP TABLE IF EXISTS public.agi_declarations CASCADE;
DROP TABLE IF EXISTS public.annual_reports CASCADE;
DROP TABLE IF EXISTS public.tax_rates CASCADE;
DROP TABLE IF EXISTS public.year_end_closings CASCADE;

-- Supplier Payments
DROP TABLE IF EXISTS public.supplier_payment_items CASCADE;
DROP TABLE IF EXISTS public.supplier_payments CASCADE;

-- Module System
DROP TABLE IF EXISTS public.module_configs CASCADE;
DROP TABLE IF EXISTS public.module_imports CASCADE;
DROP TABLE IF EXISTS public.module_kpi_targets CASCADE;

-- Other
DROP TABLE IF EXISTS public.onboarding_checklist CASCADE;
DROP TABLE IF EXISTS public.payment_methods CASCADE;
DROP TABLE IF EXISTS public.recurring_invoices CASCADE;
DROP TABLE IF EXISTS public.supplier_invoice_attestations CASCADE;
