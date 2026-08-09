-- =============================================================================
-- Booking Template Usage: add updated_at column + trigger
-- =============================================================================
--
-- Follow-up to 20260421160000_booking_template_usage.sql. The project
-- migration rules (CLAUDE.md) require every table to carry an updated_at
-- column maintained by the shared update_updated_at_column() trigger. The
-- initial migration omitted it because the row is touched via upsert
-- (which bumps last_used_at) — but the audit convention applies regardless.

ALTER TABLE public.booking_template_usage
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Seed updated_at for existing rows to match last_used_at so history is
-- coherent from day one.
UPDATE public.booking_template_usage
   SET updated_at = last_used_at
 WHERE updated_at < last_used_at;

CREATE TRIGGER btu_updated_at
  BEFORE UPDATE ON public.booking_template_usage
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
