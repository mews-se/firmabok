-- Migration: supplier_invoice_overdue_cron
-- Sets overdue status on supplier invoices past due_date. Scheduling lives
-- in the cron container (/api/supplier-invoices/overdue/cron), so the
-- database needs no cron extension.

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
