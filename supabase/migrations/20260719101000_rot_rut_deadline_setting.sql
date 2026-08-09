-- ROT/RUT begäran om utbetalning deadline opt-in.
--
-- A begäran must reach Skatteverket by 31 January the year after the buyer
-- paid (Lag 2009:194 8 §); missing the date forfeits the payout sitting on
-- account 1513. The flag is opt-in and confirmed by the user in tax
-- settings; the settings page suggests it when invoices with ROT/RUT
-- deductions exist. Deadline rows are only generated for years that
-- actually have paid ROT/RUT invoices (payment dates, not invoice dates).
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS rot_rut_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.company_settings.rot_rut_enabled IS
  'Opt-in: generate the ROT/RUT begäran om utbetalning deadline, due 31 January after the payment year (Lag 2009:194 8 §)';
