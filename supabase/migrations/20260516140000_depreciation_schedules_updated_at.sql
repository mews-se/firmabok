-- Adds the missing updated_at column + trigger to depreciation_schedules.
-- The previous migration (20260516120000_assets_and_depreciation) seeded the
-- table without it, which violates the project convention requiring every
-- table to have updated_at managed by update_updated_at_column(). Since rows
-- there only mutate twice (insert, then later when the post handler fills
-- in journal_entry_id + posted_at), updated_at lets audits trace the latest
-- state change without joining against journal_entries.created_at.

ALTER TABLE public.depreciation_schedules
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS depreciation_schedules_updated_at
  ON public.depreciation_schedules;

CREATE TRIGGER depreciation_schedules_updated_at
  BEFORE UPDATE ON public.depreciation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
