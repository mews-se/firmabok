-- Company-level default "Vår referens" (our reference) for invoicing.
--
-- Most companies put the same person/handläggare in "Vår referens" on every
-- invoice. Storing a default on company_settings lets the invoice editor
-- pre-fill the per-invoice our_reference field (it stays editable per invoice).
-- Nullable free text; no behavioural change until a value is set.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS default_our_reference text;

NOTIFY pgrst, 'reload schema';
