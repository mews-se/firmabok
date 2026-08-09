-- Migration 034: Fix extension_data updated_at trigger
-- Originally fixed a wrong function reference (update_updated_at vs update_updated_at_column).
-- The issue is now fixed directly in migration 020, making this a no-op for fresh deployments.
-- Kept for migration numbering sequence. Safe to re-run: just drops a trigger that may not exist.

DO $$
BEGIN
  -- Drop the incorrectly-named trigger if it exists from an older migration version
  IF EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND event_object_table = 'extension_data'
      AND trigger_name = 'extension_data_updated_at'
  ) THEN
    DROP TRIGGER extension_data_updated_at ON public.extension_data;
  END IF;
END;
$$;
