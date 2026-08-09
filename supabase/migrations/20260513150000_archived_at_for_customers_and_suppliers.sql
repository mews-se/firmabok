-- Migration: archived_at + vat_number_validated_at for customers + archived_at for suppliers
--
-- Phase 4 PR-1 (AP world) introduces a soft-archive flow for suppliers
-- analogous to the customers vertical from Phase 2. Both v1 routes treat
-- `archived_at IS NULL` as the canonical "active" filter.
--
-- This migration also retroactively adds the two columns that the Phase 2
-- v1 customer routes (PR #451 / #452 / #460) already reference but that no
-- prior migration installed in production:
--   - customers.archived_at       (soft-archive timestamp)
--   - customers.vat_number_validated_at (last successful VIES check)
--
-- `suppliers.is_active` (legacy boolean from migration 025) is preserved;
-- the v1 layer treats it as a back-compat companion. Archive sets
-- archived_at = now() AND is_active = false; un-archive flips both back.
--
-- BFL 7 kap 2 § (7-year retention) and ML 17 kap 24 § (invoice metadata
-- preservation) both want the archived row to remain queryable; this is a
-- soft-delete, never a hard one. Trigger-level retention protection on
-- documents and journal entries is unchanged.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS archived_at              timestamptz,
  ADD COLUMN IF NOT EXISTS vat_number_validated_at  timestamptz;

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS archived_at              timestamptz;

-- Partial indexes on archived_at NULL — the list endpoint's default filter.
-- A partial index is roughly half the size of a full one and covers the
-- common case (active rows only).
CREATE INDEX IF NOT EXISTS idx_customers_company_active
  ON public.customers (company_id, created_at)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_suppliers_company_active
  ON public.suppliers (company_id, created_at)
  WHERE archived_at IS NULL;

NOTIFY pgrst, 'reload schema';
