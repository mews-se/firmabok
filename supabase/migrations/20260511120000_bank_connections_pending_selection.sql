-- Add 'pending_selection' to bank_connections.status CHECK constraint.
--
-- New PSD2 connections start in 'pending_selection' so the user can pick
-- which accounts to actually sync before any transactions are pulled.
-- Once the user confirms their selection the connection flips to 'active'.

ALTER TABLE public.bank_connections
  DROP CONSTRAINT IF EXISTS bank_connections_status_check;

ALTER TABLE public.bank_connections
  ADD CONSTRAINT bank_connections_status_check
  CHECK (status IN ('pending', 'pending_selection', 'active', 'expired', 'error', 'revoked'));

-- Backfill existing rows: every account gets enabled=true so current
-- connections keep syncing exactly the accounts they were syncing before.
-- Users can later prune accounts via the picker dialog.
UPDATE public.bank_connections
SET accounts_data = (
  SELECT jsonb_agg(
    CASE
      WHEN elem ? 'enabled' THEN elem
      ELSE elem || jsonb_build_object('enabled', true)
    END
  )
  FROM jsonb_array_elements(accounts_data) AS elem
)
WHERE accounts_data IS NOT NULL
  AND jsonb_typeof(accounts_data) = 'array'
  AND jsonb_array_length(accounts_data) > 0;

NOTIFY pgrst, 'reload schema';
