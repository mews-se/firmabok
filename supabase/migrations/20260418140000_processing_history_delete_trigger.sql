-- Add the missing BEFORE DELETE immutability trigger on processing_history.
--
-- Mirrors the pattern from migration 014 (audit_log) where both UPDATE and
-- DELETE are blocked via audit_log_immutable(). Without this trigger the
-- service role could silently remove rows, contradicting BFNAR 2013:2 kap 8
-- behandlingshistorik immutability requirements.

CREATE TRIGGER processing_history_no_delete
  BEFORE DELETE ON public.processing_history
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();

NOTIFY pgrst, 'reload schema';
