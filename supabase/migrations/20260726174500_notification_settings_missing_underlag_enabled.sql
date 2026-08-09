-- notification_settings: add the missing per-event toggle for 'missing_underlag'.
--
-- 20240101000035 added five per-event toggles (period_locked_enabled,
-- period_year_closed_enabled, invoice_sent_enabled, receipt_extracted_enabled,
-- receipt_matched_enabled). The weekly "saknade underlag" notification shipped
-- later with its notification_log type (20260712090000), its payload builder and
-- its scheduler pass, but its settings column was never created. The
-- push-notifications extension reads and writes it anyway, so PostgREST rejected
-- the whole six-column select with 42703: getSettings() always fell back to
-- defaults and saveSettings() silently wrote nothing, which disabled all six
-- toggles, not just this one.
--
-- notification_settings is user-scoped by design: it has no company_id (see the
-- deliberate omission from the table lists in 20260330130000 and the
-- "User-scoped tables" section of 20260415000000), one row per user, and quiet
-- hours plus category preferences belong to the person rather than the company.
-- This migration does not change that.
--
-- NOT NULL DEFAULT true (the five siblings are nullable with a default): a
-- boolean toggle has no meaningful null state, and on Postgres 11+ adding a
-- NOT NULL column with a constant default does not rewrite the table.

ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS missing_underlag_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.notification_settings.missing_underlag_enabled IS
  'Per-user mute switch for the weekly missing-underlag (saknade underlag) notification.';

NOTIFY pgrst, 'reload schema';
