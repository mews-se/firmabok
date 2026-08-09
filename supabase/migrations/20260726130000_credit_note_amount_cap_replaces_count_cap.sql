-- Replace the "at most ONE credit note per invoice, ever" cap with the rule the
-- law actually imposes: you may not credit MORE than the original invoice.
--
-- 20260715120000 created uq_invoices_company_credited_invoice, a UNIQUE index on
-- (company_id, credited_invoice_id). The concern it addressed is legitimate:
-- two credit notes that each mirror the full original would post two reversing
-- verifikat and double-reverse revenue and utgaende moms. The implementation was
-- over-broad: it capped the COUNT of credit notes at one, which also forbids the
-- delkreditering that ML (2023:200) 17 kap 22-23 SS explicitly permits (a
-- aendringsfaktura may cover a partial return, a partial price reduction or a
-- partial cancellation, and nothing in ML caps how many aendringsfakturor may
-- reference one original).
--
-- The invariant enforced here instead:
--
--   For any original invoice O, the sum of ABS(total) over all non-cancelled
--   invoices with credited_invoice_id = O.id must not exceed ABS(O.total).
--
-- This cannot be an index (it is a cross-row aggregate) and cannot be a CHECK
-- constraint (a CHECK may not read other rows), so it is a trigger. That is the
-- honest option, not a workaround.
--
-- Note what this does and does not change in practice:
--   * Today every code path (POST /api/invoices, POST /api/v1/.../credit) mirrors
--     the FULL original. Under the new rule two full mirrors sum to 2x the total
--     and are still refused, so behaviour is unchanged for existing flows.
--   * Once the app can issue a partial credit note, several partials that stay
--     within the original total become possible without further DDL.
--
-- Concurrency: the trigger takes FOR UPDATE on the original invoice row before
-- summing its credit notes. Without that lock two concurrent inserts under READ
-- COMMITTED would each read the pre-insert sum and both pass. The lock serialises
-- credit-note writes per original invoice and nothing else.
--
-- Currency: the amount cap only means something if both sides are denominated in
-- the same currency. Both credit-note creation paths copy the original's currency
-- onto the credit note, so this is an assertion of existing behaviour rather than
-- a new restriction; it is enforced so a future path cannot silently defeat the
-- cap by switching currency. A NULL currency resolves to 'SEK' on both sides
-- rather than waiving the assert, because invoices.currency is nullable with
-- `default 'SEK'` and waiving on NULL is how the cap would end up comparing two
-- different units.
--
-- Tenancy: the trigger is SECURITY DEFINER (see below), so its read of the
-- original invoice bypasses RLS. The lookup therefore requires
-- o.company_id = NEW.company_id, which is the correct integrity rule anyway (a
-- kreditfaktura corrects an invoice in its own bokföring) AND the control that
-- stops the definer read from being aimed at another tenant: without it, an
-- insert in the attacker's own company could FOR UPDATE-lock a victim's invoice
-- and read its total/currency back through the exception texts. For the same
-- reason the exception messages below never print the ORIGINAL invoice's
-- figures, only the credit note's own.

DROP INDEX IF EXISTS public.uq_invoices_company_credited_invoice;

CREATE OR REPLACE FUNCTION public.enforce_credit_note_total_within_original()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY DEFINER so RLS can never blind the aggregate: a caller who can see
-- only some of the sibling credit notes must not be able to under-count them and
-- slip past the cap. Tenancy is enforced by the calling paths and by RLS on the
-- INSERT/UPDATE itself; this function only READS totals.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_original_total    numeric;
  v_original_currency text;
  v_existing_credited numeric;
  v_new_credit        numeric;
BEGIN
  IF NEW.credited_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A cancelled credit note consumes no credit capacity. This also keeps the
  -- "reopen a cancelled, unissued credit-note draft" path in
  -- app/api/invoices/route.ts working: the row goes cancelled -> draft and is
  -- re-checked on the way back in.
  --
  -- A NULL NEW.status makes this comparison NULL, so the row falls through and
  -- IS capped. That is the direction to fail in: invoices.status is nullable
  -- (`status text default 'draft'`, no NOT NULL), and treating an unknown status
  -- as cancelled would hand out free credit capacity.
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Skip the locking read for updates that cannot affect the invariant. The
  -- credit-note flow issues several such updates per credit note (linking
  -- journal_entry_id, flipping creation_complete, rewriting notes/dates), and
  -- none of them should serialise against the original invoice.
  --
  -- The OLD.status term exists for exactly one transition: cancelled -> not
  -- cancelled, where the row goes from uncounted to counted and must be
  -- re-checked. COALESCE spells out that a NULL-status row is not that
  -- transition (it was counted before this UPDATE and, since NEW.status is not
  -- 'cancelled' by the check above, it is counted after), so it may take the
  -- fast path. A bare `OLD.status <> 'cancelled'` is NULL there and falls out of
  -- the skip, which is harmless but is three-valued logic standing in for a
  -- decision.
  IF TG_OP = 'UPDATE'
     AND NEW.credited_invoice_id IS NOT DISTINCT FROM OLD.credited_invoice_id
     AND NEW.total IS NOT DISTINCT FROM OLD.total
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency
     AND COALESCE(OLD.status, '') <> 'cancelled'
  THEN
    RETURN NEW;
  END IF;

  -- Company match: see the tenancy note in the header. A credit note may only
  -- reference an original in its own company; the SECURITY DEFINER read must
  -- never lock or reveal another tenant's row.
  SELECT o.total, o.currency
    INTO v_original_total, v_original_currency
  FROM public.invoices o
  WHERE o.id = NEW.credited_invoice_id
    AND o.company_id = NEW.company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Not found now means "no such invoice in this company": either a
    -- cross-tenant reference (rejected, and indistinguishable from a missing
    -- row on purpose) or an id the FK would refuse anyway. Failing open here
    -- would let a credit note bypass the cap entirely by pointing at a row
    -- outside its company.
    RAISE EXCEPTION
      'Original invoice % not found for credit note',
      NEW.credited_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- COALESCE to the column default instead of skipping the assert when either
  -- side is NULL. invoices.currency is nullable (`currency text default 'SEK'`),
  -- and the earlier IS NOT NULL guards turned a NULL on either side into "no
  -- opinion", so a NULL-currency credit note could be capped against a EUR
  -- original in a unit nobody had agreed on. Every read path already treats a
  -- NULL currency as SEK, which is what the column default encodes, so that is
  -- the assumption to make explicit rather than to opt out of.
  -- The message prints only the credit note's OWN currency, not the
  -- original's: exception texts must never carry another row's figures out
  -- of a SECURITY DEFINER read.
  IF COALESCE(NEW.currency, 'SEK') <> COALESCE(v_original_currency, 'SEK') THEN
    RAISE EXCEPTION
      'Credit note currency (%) does not match the currency of original invoice %',
      COALESCE(NEW.currency, 'SEK'),
      NEW.credited_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every term in this aggregate is NULL-safe on purpose, because a NULL that
  -- drops a sibling out of the sum under-counts the credited total and hands out
  -- credit capacity that has already been used:
  --   * COALESCE(c.status, ''), not a bare <>: invoices.status is nullable, and
  --     `status <> 'cancelled'` is NULL for such a row, which silently excludes
  --     it from the sum.
  --   * IS DISTINCT FROM, not <>, on the self-exclusion: `c.id <> NEW.id` is
  --     NULL for every row if NEW.id were ever NULL, which excludes ALL siblings
  --     and makes the cap unconditionally pass. Column defaults are applied
  --     before BEFORE-INSERT triggers fire, so NEW.id is in practice never NULL;
  --     this removes the dependency on that reasoning rather than restating it.
  --   * COALESCE(c.total, 0) inside ABS, and COALESCE(SUM(...), 0) outside, so
  --     an all-NULL total and an empty sibling set both read as 0 instead of
  --     NULL (a NULL v_existing_credited makes the comparison below NULL and the
  --     cap passes).
  SELECT COALESCE(SUM(ABS(COALESCE(c.total, 0))), 0)
    INTO v_existing_credited
  FROM public.invoices c
  WHERE c.credited_invoice_id = NEW.credited_invoice_id
    AND c.id IS DISTINCT FROM NEW.id
    AND COALESCE(c.status, '') <> 'cancelled';

  v_new_credit := ABS(COALESCE(NEW.total, 0));

  -- Half-oere tolerance: totals are rounded to oere, and a multi-rate original
  -- split across several partial credit notes can land a rounding step away from
  -- the original total. Matches the 0.005 tolerance used by match_batch_allocate.
  -- The message states the credited sum (the caller's own side of the
  -- comparison) but not the original invoice's total: see the tenancy note.
  IF v_existing_credited + v_new_credit > ABS(COALESCE(v_original_total, 0)) + 0.005 THEN
    RAISE EXCEPTION
      'Credit notes for invoice % would total %, which exceeds the invoice total (ML 17 kap 22-23 SS permits partial credits, not over-crediting)',
      NEW.credited_invoice_id,
      v_existing_credited + v_new_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS check_credit_note_total_within_original ON public.invoices;
CREATE TRIGGER check_credit_note_total_within_original
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW
  WHEN (NEW.credited_invoice_id IS NOT NULL)
  EXECUTE FUNCTION public.enforce_credit_note_total_within_original();

COMMENT ON FUNCTION public.enforce_credit_note_total_within_original() IS
  'Caps the summed ABS(total) of all non-cancelled credit notes for one original invoice at the original ABS(total). The original is resolved within the credit note''s own company; a cross-company reference is treated as not found and rejected. Replaces uq_invoices_company_credited_invoice, which capped the credit-note COUNT at one and thereby forbade the partial kreditfaktura permitted by ML (2023:200) 17 kap 22-23 SS.';

NOTIFY pgrst, 'reload schema';
