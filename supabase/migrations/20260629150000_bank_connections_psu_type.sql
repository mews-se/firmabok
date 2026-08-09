-- Persist the PSD2 PSU type (personal|business) chosen at authorization.
--
-- Why: the enable-banking /connect handler re-derives psu_type from the company
-- entity_type on every call (aktiebolag -> 'business', enskild firma ->
-- 'personal'). On a reconnect (90-day consent renewal, or a retry after a failed
-- authorization) that silently overrides whatever the user actually authorized
-- with. A connection that only works as 'personal' -- common for AB owners who
-- sign Handelsbanken with a personal Mobile BankID -- then flips back to
-- 'business' on every renewal and fails at the bank's signing step, with no way
-- to switch type short of disconnecting. Storing the chosen type lets reconnect
-- reuse what worked, and lets the user switch type in place.
--
-- Nullable, no default: legacy rows stay NULL and fall back to the existing
-- entity_type derivation, so behaviour is unchanged until a row is
-- (re)authorized. Idempotent so it is safe to re-apply on diverged branches.

alter table bank_connections
  add column if not exists psu_type text;

alter table bank_connections
  drop constraint if exists bank_connections_psu_type_check;

alter table bank_connections
  add constraint bank_connections_psu_type_check
  check (psu_type is null or psu_type in ('personal', 'business'));

comment on column bank_connections.psu_type is
  'PSD2 PSU type chosen at authorization (personal|business). Reused on reconnect so consent renewals keep the account type that actually worked; NULL on legacy rows falls back to company entity_type derivation in the /connect handler.';
