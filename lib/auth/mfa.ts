/**
 * MFA (Multi-Factor Authentication) helpers.
 *
 * MFA is only required on the hosted version, never for self-hosted deployments.
 * Enforcement is application-side (middleware + API routes), not RLS.
 */

export function isMfaRequired(): boolean {
  if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true') return false
  return process.env.NEXT_PUBLIC_REQUIRE_MFA === 'true'
}

/**
 * Check if MFA should be enforced for a specific user.
 * BankID-linked users skip TOTP because BankID is inherently 2FA.
 */
export function shouldEnforceMfa(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (!isMfaRequired()) return false
  if (user.app_metadata?.bankid_linked) return false
  return true
}
