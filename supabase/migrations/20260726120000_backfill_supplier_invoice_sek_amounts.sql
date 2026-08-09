-- Backfill supplier_invoices.subtotal_sek / vat_amount_sek / total_sek.
--
-- Root cause (fixed in code in the same change): every supplier-invoice write
-- path gated the three SEK columns on an exchange rate existing:
--
--     total_sek = exchangeRate ? total * exchangeRate : null
--
-- A SEK invoice never has an exchange rate, so total_sek stayed NULL for every
-- ordinary Swedish supplier invoice ever registered, and readers that report
-- amounts in SEK (the KPI "Största leverantörer" panel among them) had nothing
-- to read. The writers now resolve a rate up front (SEK resolves to 1), so new
-- rows are correct; this migration repairs the history.
--
-- Prod state when this was written: 1 595 supplier invoices, 1 247 with
-- total_sek IS NULL spread over 540 companies. 1 238 of those are SEK
-- invoices (repaired by the first statement); the remaining 9 are
-- foreign-currency invoices with no exchange_rate on file and are
-- deliberately left untouched.
--
-- Only deterministic arithmetic is applied. No exchange rate is ever invented:
--
--   1. currency = 'SEK'                       -> the SEK columns ARE the
--      invoice columns. 1 SEK = 1 SEK is arithmetic, not an estimate.
--   2. currency <> 'SEK' with a stored rate   -> multiply by the rate already
--      recorded on the row. Prod has zero such rows today; the statement is
--      here so staging and self-hosted installs with a different history
--      converge on the same rule.
--   3. currency <> 'SEK' with NO rate         -> left NULL on purpose. Picking
--      a rate after the fact would translate the beskattningsunderlag at a day
--      nobody can defend, and under omvänd skattskyldighet that lands straight
--      in rutorna 20-24 + 30-32 of the momsdeklaration. Those rows are
--      repaired by setting the invoice's exchange_rate (the booking path
--      already refuses them loudly with SI_FX_RATE_MISSING), not here.
--
-- Nothing else changes: the invoice-currency amounts (subtotal, vat_amount,
-- total) are read-only here, and no posted verifikat is touched. Only the SEK
-- mirror columns are filled in.
--
-- Two intentional side effects:
--   * audit_supplier_invoices writes one audit_log row per updated invoice.
--     That IS the behandlingshistorik for this correction (BFNAR 2013:2
--     kap 8); the rows are tagged actor_type = 'system' so they do not read as
--     something the invoice's owner did.
--   * set_updated_at_supplier_invoices bumps updated_at on the touched rows.
--
-- Re-runnable: both statements only touch rows that still have a NULL.

do $$
begin
  perform set_config('gnubok.actor_type', 'system', true);
  perform set_config(
    'gnubok.actor_label',
    'migration 20260726120000 backfill_supplier_invoice_sek_amounts',
    true
  );

  -- 1. SEK invoices: the SEK columns mirror the invoice columns exactly.
  update public.supplier_invoices
     set subtotal_sek   = round(subtotal, 2),
         vat_amount_sek = round(vat_amount, 2),
         total_sek      = round(total, 2)
   where currency = 'SEK'
     and (subtotal_sek is null or vat_amount_sek is null or total_sek is null);

  -- 2. Foreign invoices that already carry the rate they were booked at.
  --    Each column is repaired independently (COALESCE keeps a non-NULL
  --    value): the row qualifies when ANY of the three is NULL, and deriving
  --    the already-filled columns again would restate correct historical
  --    figures from the CURRENT exchange_rate, silently rewriting them if the
  --    rate was corrected after they were written.
  update public.supplier_invoices
     set subtotal_sek   = coalesce(subtotal_sek,   round(subtotal * exchange_rate, 2)),
         vat_amount_sek = coalesce(vat_amount_sek, round(vat_amount * exchange_rate, 2)),
         total_sek      = coalesce(total_sek,      round(total * exchange_rate, 2))
   where currency <> 'SEK'
     and exchange_rate is not null
     and exchange_rate > 0
     and (subtotal_sek is null or vat_amount_sek is null or total_sek is null);
end $$;
