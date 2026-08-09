-- Raise statement_timeout inside the atomic SIE import RPC so a large
-- Fortnox/provider migration is not cancelled mid-import.
--
-- Same failure class and fix as 20260629160100 (replace_sie_import /
-- undo_sie_import): a PostgREST request runs under the authenticator
-- role's 8s statement_timeout, and import_sie_journal_entries commits an
-- entire SIE file in one call (per-voucher loop, per-line inserts, audit
-- triggers). A real-world multi-year migration (thousands of vouchers)
-- exceeds 8s, the statement is cancelled ("canceling statement due to
-- statement timeout"), and the whole import rolls back with
-- "SIE-verifikationer kunde inte importeras atomiskt".
--
-- A function-scoped SET re-arms the timer for the duration of the call and
-- is restored on exit. 290s sits just under the calling routes' maxDuration
-- = 300 ceiling (/api/extensions/ext/[...path], /api/import/sie/execute,
-- /api/v1/.../imports/sie), so the serverless layer stays the effective
-- bound. Function body is unchanged; only configuration is altered.

ALTER FUNCTION public.import_sie_journal_entries(uuid, uuid, uuid, jsonb)
  SET statement_timeout = '290s';

NOTIFY pgrst, 'reload schema';
