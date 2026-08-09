-- One-time cleanup for the rolling generation horizon.
--
-- Deadline rows used to be generated through the end of next calendar year
-- (~17 months of future rows in mid-year). The generator now caps recurring
-- skattekonto obligations at ~6 months ahead and annual obligations at 12
-- months; the daily backfill cron creates rows as they enter the window.
-- Existing pending rows beyond the horizon would otherwise linger until the
-- company's next full regeneration, so delete them here. Completed and
-- dismissed rows are untouched (filing progress and opt-outs survive), and
-- every deleted row is recreated automatically once its due date comes back
-- into view.
DELETE FROM public.deadlines
WHERE source = 'system'
  AND deadline_type = 'tax'
  AND is_completed = FALSE
  AND dismissed_at IS NULL
  AND (
    (
      tax_deadline_type IN (
        'moms_monthly', 'moms_quarterly', 'f_skatt',
        'arbetsgivardeklaration', 'skatteinbetalning', 'periodisk_sammanstallning'
      )
      AND due_date > (CURRENT_DATE + INTERVAL '183 days')
    )
    OR (
      tax_deadline_type NOT IN (
        'moms_monthly', 'moms_quarterly', 'f_skatt',
        'arbetsgivardeklaration', 'skatteinbetalning', 'periodisk_sammanstallning'
      )
      AND due_date > (CURRENT_DATE + INTERVAL '365 days')
    )
  );
