-- Decouple arsredovisning_narratives and arsredovisning_signature_requests
-- from the auth.users lifecycle. Both tables hold räkenskapsinformation that
-- BFL 7 kap 1 § requires to be retained for 7 years; without this change,
-- ON DELETE CASCADE on user_id would delete the filed årsredovisning content
-- (and the signature evidence) the moment the authoring user is deleted —
-- e.g. on GDPR Art.17 erasure or membership revocation. That's a direct
-- conflict between two compliance regimes; BFL wins for filed financial
-- records, so the user FK becomes optional and SET NULL on delete.
--
-- The company FK keeps its CASCADE: when a company is deleted, its
-- räkenskapsinformation goes with it (separate workflow, e.g. liquidation
-- archive handover, handles BFL retention at that level).

-- arsredovisning_narratives
ALTER TABLE public.arsredovisning_narratives
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.arsredovisning_narratives
  DROP CONSTRAINT IF EXISTS arsredovisning_narratives_user_id_fkey;

ALTER TABLE public.arsredovisning_narratives
  ADD CONSTRAINT arsredovisning_narratives_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE SET NULL;

-- arsredovisning_signature_requests
ALTER TABLE public.arsredovisning_signature_requests
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.arsredovisning_signature_requests
  DROP CONSTRAINT IF EXISTS arsredovisning_signature_requests_user_id_fkey;

ALTER TABLE public.arsredovisning_signature_requests
  ADD CONSTRAINT arsredovisning_signature_requests_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
