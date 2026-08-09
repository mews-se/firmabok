-- Long-tail deadline opt-ins ("Fler deadlines" in tax settings).
--
-- Each flag enables a niche statutory deadline type that applies to a small
-- minority of companies, so all are explicit opt-in and default false:
--   - oss_enabled: OSS quarterly declaration (ML 22 kap. / Art. 369f VAT
--     directive), due the last day of the month after the quarter. EU-law
--     deadline: never moves to the next banking day.
--   - ioss_enabled: IOSS monthly declaration (Art. 369s), due the last day
--     of the following month, same no-shift rule.
--   - intrastat_enabled: SCB Intrastat monthly report, ~10th working day of
--     the following month.
--   - punktskatt_enabled: monthly punktskattedeklaration on the ordinary
--     skattedeklaration schedule (SFL 26 kap.).
--   - fyllnadsinbetalning_enabled: extra preliminary tax payments to avoid
--     kostnadsränta (SFL 62 kap. 8 §, 65 kap.): parts over 30 000 kr by the
--     12th of the second month after FY end, the rest by the 3rd of the
--     fifth month.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS oss_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ioss_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS intrastat_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS punktskatt_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS fyllnadsinbetalning_enabled BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
