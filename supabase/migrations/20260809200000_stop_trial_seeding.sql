-- Self-hosted installs bypass the paywall application-side; stop
-- manufacturing 30-day trial grants for every new company and drop the ones
-- already seeded. capability_grants itself stays: it doubles as the
-- per-company module switch, and the DB-level gate remains fail-closed.

DROP TRIGGER IF EXISTS trg_seed_trial_capability_grants ON public.companies;
DROP FUNCTION IF EXISTS public.seed_trial_capability_grants();
DELETE FROM public.capability_grants WHERE source = 'trial';

NOTIFY pgrst, 'reload schema';
