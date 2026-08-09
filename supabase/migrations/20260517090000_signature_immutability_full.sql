-- Extend the signed-immutability trigger on
-- arsredovisning_signature_requests to cover EVERY audit-critical column,
-- not just the role/signer_name/signed_at/status subset the original
-- migration (20260516170000) protected.
--
-- Without this, a row with status='signed' could be UPDATEd to change
-- bankid_signature_data, signer_personnummer_encrypted, or
-- signer_personnummer_hash — silently altering the audit trail and
-- breaking the "signed = immutable" guarantee that the application layer
-- relies on for fastställelseintyg evidence.

CREATE OR REPLACE FUNCTION public.enforce_signed_signature_request_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    IF NEW.role                          IS DISTINCT FROM OLD.role
       OR NEW.signer_name                IS DISTINCT FROM OLD.signer_name
       OR NEW.signed_at                  IS DISTINCT FROM OLD.signed_at
       OR NEW.status                     IS DISTINCT FROM OLD.status
       OR NEW.bankid_signature_data      IS DISTINCT FROM OLD.bankid_signature_data
       OR NEW.signer_personnummer_encrypted IS DISTINCT FROM OLD.signer_personnummer_encrypted
       OR NEW.signer_personnummer_hash   IS DISTINCT FROM OLD.signer_personnummer_hash
       OR NEW.fiscal_period_id           IS DISTINCT FROM OLD.fiscal_period_id
       OR NEW.company_id                 IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Cannot modify a signed signature request (id=%)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

NOTIFY pgrst, 'reload schema';
