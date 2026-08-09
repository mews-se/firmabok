# Authorization Policy: Privileged RPCs

This document records the access-control model of database functions that run
with elevated privileges (SECURITY DEFINER) and can mutate or destroy tenant
data. It exists so the authorization contract of each function is reviewable
without reading migration SQL, and so changes to that contract are deliberate.

No machine-readable authorization matrix (authorization-matrix.csv or similar)
exists in this repository yet; this document is currently the authoritative
inventory. If such a matrix is introduced, every function listed here must get
a row in it.

## SIE bulk-delete pair: `replace_sie_import` and `undo_sie_import`

Defined in:

- `supabase/migrations/20260727120000_replace_sie_import_authorize_actor.sql`
- `supabase/migrations/20260727121000_undo_sie_import_caller_guard.sql`

Both functions hard-delete a completed SIE import's verifikationer so a fiscal
period can be re-imported (replace) or restored to its pre-import state (undo).
To do that they call `set_config('gnubok.allow_delete', 'true', true)`, which
disarms the BFL immutability and 7-year retention triggers for the transaction.
That makes them the two most dangerous entry points in the schema, and their
authorization model is correspondingly strict.

### Why SECURITY DEFINER

The functions must bypass RLS and the enforcement triggers to perform the
sanctioned bulk delete atomically. Running as the function owner is what allows
the `gnubok.allow_delete` escape hatch to work; the compensating control is the
in-function authorization gate described below, which runs before any mutation.

### Actor resolution

Each function takes `p_user_id uuid DEFAULT NULL` and resolves the acting user
as follows:

- If `auth.role() = 'service_role'`: the actor is
  `COALESCE(p_user_id, auth.uid())`. The service-role client is the cookieless
  server client (`rpcClientForBulkDelete` in `lib/import/sie-import.ts`), used
  to escape the authenticator role's 8s statement timeout. Inside it
  `auth.uid()` is NULL, so the application passes the human user it already
  authenticated as `p_user_id`.
- Every other caller is pinned to its own `auth.uid()`, regardless of what it
  passes as `p_user_id`. This closes the impersonation hole where an
  authenticated PostgREST caller could pass an owner's UUID and walk through
  the gate (the pre-fix behavior of `undo_sie_import`).

This is the same shape as `list_invoice_delivery_summaries_for_service`
(migration `20260727100000`); treat it as the house pattern for any
SECURITY DEFINER function that must accept a caller-asserted actor.

### Authorization gate

The resolved actor must hold the `owner` or `admin` role in
`company_members` for `p_company_id`. The gate fails closed:

- An anon or unauthenticated caller has no membership row, `v_caller_role`
  resolves NULL, and the function raises before any mutation and before
  `gnubok.allow_delete` is ever set.
- The raise uses `ERRCODE 42501` (insufficient_privilege) so application
  routes can map it to a 403.

### Grants

Supabase's default privileges grant EXECUTE on every new public function to
PUBLIC and to anon/authenticated/service_role, and CREATE OR REPLACE
re-introduces those grants. Both migrations therefore end with an explicit:

- `REVOKE EXECUTE ... FROM PUBLIC, anon` (revoking anon alone is not enough;
  anon is a member of PUBLIC and would stay callable through the PUBLIC grant)
- `GRANT EXECUTE ... TO authenticated, service_role`

`authenticated` retains EXECUTE on purpose: on self-hosted installs without a
`SUPABASE_SERVICE_ROLE_KEY`, the application falls back to running these RPCs
on the caller's own session client. The in-function owner/admin gate scopes
such callers to companies they actually administer, so this is tenant-scoped
access, not a privilege escalation.

### Tenant isolation contract

Every mutation inside both functions filters on `p_company_id`, and the gate
guarantees the actor administers that company. A caller can therefore never
reach another tenant's data: the pre-fix `replace_sie_import` (no gate,
EXECUTE held by anon) was a cross-tenant data-destruction primitive, and the
gate plus the REVOKEs are what closed it.

### Verification

The contract is pinned by pg-real tests (run with `npm run test:pg`):

- `lib/import/__tests__/sie-import.replace.pg.test.ts`
- `lib/import/__tests__/undo-sie-import-actor.pg.test.ts` (spoofed
  `p_user_id` rejection, the 42501 errcode, and the tightened grants)

Any change to either function's signature, gate, or grants must update these
tests and this document in the same change.
