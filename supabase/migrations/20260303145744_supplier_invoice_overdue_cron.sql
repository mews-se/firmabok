-- Migration: supplier_invoice_overdue_cron
-- Sets overdue status on supplier invoices past due_date via pg_cron

-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- Grant usage to postgres role (required by Supabase)
GRANT USAGE ON SCHEMA cron TO postgres;

-- Function to update overdue supplier invoices
CREATE OR REPLACE FUNCTION public.update_overdue_supplier_invoices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE supplier_invoices
  SET status = 'overdue',
      updated_at = NOW()
  WHERE due_date < CURRENT_DATE
    AND status IN ('registered', 'approved');
END;
$$;

-- Schedule daily at 06:00 UTC (matches existing banking sync timing)
SELECT cron.schedule(
  'update-overdue-supplier-invoices',
  '0 6 * * *',
  $$SELECT public.update_overdue_supplier_invoices()$$
);
