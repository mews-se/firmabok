-- Restore company_settings.invoice_default_notes, lost from the repo (not from
-- the database) by the 2026-04-15 migration consolidation.
--
-- History, established from git:
--   2026-04-07  20260407120100_add_missing_company_settings_columns.sql adds
--               `invoice_default_notes text` (plus 18 siblings) and lands on
--               main via "Mobile view fixes (#188)", so Supabase branching
--               applies it to production.
--   2026-04-15  "chore: remove Sentry, consolidate migrations" (#244) deletes
--               that file along with 21 others and replaces them with
--               20260415000000_schema_sync.sql, which does NOT carry any of the
--               company_settings additions forward. The column stays in the
--               database; it disappears from the repo's migration history.
--
-- Net effect: the repo is BEHIND the database for this column, the inverse of
-- the orphan case CLAUDE.md warns about. Hosted production still has it, so the
-- feature works there, but every database built from this repo (self-hosted
-- Docker, the pg-real CI job, any branch created from the migrations rather
-- than forked from prod) lacks it. On those, PostgREST answers 42703 and
-- rejects the WHOLE eleven-column select in components/invoices/InvoiceEditor.tsx,
-- so ten unrelated and entirely real settings (logo_url, ore_rounding,
-- bankgiro, clearing_number, account_number, accounting_method, vat_registered,
-- dimensions_enabled, invoice_payment_links_enabled, default_our_reference)
-- silently read as null on every invoice-editor load.
--
-- IF NOT EXISTS is load-bearing, not defensive habit: on production the column
-- is already there, and a bare ADD COLUMN would raise 42701 and abort the whole
-- pending migration batch behind it.
--
-- The rest of the feature already assumes this column: the settings textarea
-- (components/settings/InvoiceSettingsForm.tsx), the save payload
-- (components/settings/sections/InvoicingSettingsContent.tsx),
-- UpdateSettingsSchema in lib/api/schemas.ts, the CompanySettings type, and the
-- makeCompanySettings fixture. Nothing else changes here.
--
-- pg-test: skip (plain column addition; no trigger, RPC, RLS policy or
-- DEFERRABLE constraint is touched). tests/schema/no-phantom-columns.test.ts
-- replays this file and proves the editor's select resolves.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_default_notes text;

COMMENT ON COLUMN public.company_settings.invoice_default_notes IS
  'Company default free-text notes prefilled into new invoices (the "notes" field). Display text only: it never affects amounts, VAT or bookkeeping. Prefill applies to fresh invoices only, never when editing or copying an existing one, so a saved invoice keeps its own text.';

NOTIFY pgrst, 'reload schema';
