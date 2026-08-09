/**
 * Drop fields from the in-process event payload that have no value to an
 * external consumer. Currently strips:
 *   - userId: an internal Supabase auth.users.id UUID: no value to the
 *     receiver, identifies the gnubok-side actor not the resource. The
 *     companyId stays (it's the tenant scope, useful for multi-tenant
 *     receivers).
 *
 * Centralising the projection here means a future tightening (e.g.
 * stripping personnummer fields from payroll payloads) lands in one
 * place rather than per-emit-site. GDPR Art.5(1)(c) data minimisation.
 */
export function minimisePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'userId') continue
    projected[key] = value
  }
  return projected
}
