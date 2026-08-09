-- Validate the operation_type CHECK re-added NOT VALID in 20260717090000.
-- Runs in its own transaction so the scan takes SHARE UPDATE EXCLUSIVE only
-- (same split as 20260713123000 after 20260713121000).

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
