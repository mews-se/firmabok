-- Add 'pending_signature' to agi_declarations.status enum.
--
-- Background: the new AGI flow (POST /underlag → kontrollresultat → spara →
-- skapaGranskningsunderlag → kvittenser) needs a status that captures
-- "underlag has been saved into Skatteverket's Eget utrymme but the user
-- has not yet completed BankID signing in Mina Sidor." Reusing 'exported'
-- for that interval misstates the filing outcome — Eget utrymme is a
-- staging area, not a filing — and that misrepresentation conflicts with
-- the behandlingshistorik faithfulness requirement in BFNAR 2013:2 kap 8
-- and BFL 5 kap 5§.
--
-- Lifecycle after this migration:
--   generated         — XML built but nothing has been sent to Skatteverket
--   pending_signature — underlag accepted into Eget utrymme; awaiting BankID
--   submitted         — kvittens received; AGI is filed
--   exported          — preserved for the legacy manual XML download path
--   accepted          — reserved (Skatteverket does not currently expose this)
--   rejected          — reserved (kontrollresultat DONE_REJECTED could land here)
--
-- Migrations are append-only — we drop and recreate the CHECK constraint
-- with the new value rather than mutating the existing one in place.

ALTER TABLE public.agi_declarations
  DROP CONSTRAINT IF EXISTS agi_declarations_status_check;

ALTER TABLE public.agi_declarations
  ADD CONSTRAINT agi_declarations_status_check
  CHECK (status IN (
    'generated',
    'pending_signature',
    'exported',
    'submitted',
    'accepted',
    'rejected'
  ));

NOTIFY pgrst, 'reload schema';
