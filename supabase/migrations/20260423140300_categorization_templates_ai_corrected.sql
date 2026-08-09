-- Extend categorization_templates.source to include 'ai_corrected'.
--
-- When a user edits an AI-generated booking proposal and then agrees to
-- "remember this for <counterparty> in future", the resulting
-- categorization_templates row is inserted with source='ai_corrected' so
-- the origin of the template is distinguishable from the existing
-- silent-learning paths (user_approved, auto_learned, sie_import, sni_default).
--
-- This distinction matters for downstream confidence calibration: AI-
-- corrected templates carry stronger user-validation signal than auto_learned
-- (which is inferred purely by the AI without explicit user review) and
-- comparable signal to user_approved.

ALTER TABLE public.categorization_templates
  DROP CONSTRAINT IF EXISTS categorization_templates_source_check;

ALTER TABLE public.categorization_templates
  ADD CONSTRAINT categorization_templates_source_check
  CHECK (source IN (
    'sie_import',
    'user_approved',
    'sni_default',
    'auto_learned',
    'ai_corrected'
  ));

NOTIFY pgrst, 'reload schema';
