-- Add line_type to invoice_items: support free-text and blank spacer rows.
--
-- A 'text' row carries only a description (which may be empty, for a visual
-- spacer) and has no amounts. It is excluded from invoice totals and from the
-- bookkeeping the engine generates — the entry generators filter it out, so a
-- text row never produces a zero-amount journal line. Existing rows and every
-- non-text line default to 'product', preserving current behaviour.

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS line_type text NOT NULL DEFAULT 'product'
  CHECK (line_type IN ('product', 'text'));

COMMENT ON COLUMN public.invoice_items.line_type IS
  'product = normal billable line; text = free-text/blank row (description only, no amounts, excluded from totals and bookkeeping).';

NOTIFY pgrst, 'reload schema';
