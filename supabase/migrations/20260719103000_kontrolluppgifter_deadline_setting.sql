-- Kontrolluppgifter (KU10/KU20/KU31) deadline opt-in.
--
-- Kontrolluppgifter are due 31 January after the income year (SFL 24 kap.
-- 1 §). KU31 (utdelning) is never covered by AGI, so a fåmansbolag paying
-- utdelning must file it separately; the app already generates KU10 XML but
-- had no reminder. The flag is opt-in and confirmed by the user in tax
-- settings; the settings page suggests it from ledger signals (2898
-- utdelning, 2393/2893 ägarlån) but never flips it automatically.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS kontrolluppgifter_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.company_settings.kontrolluppgifter_enabled IS
  'Opt-in: generate the annual kontrolluppgifter (KU) deadline, due 31 January (SFL 24 kap. 1 §)';
