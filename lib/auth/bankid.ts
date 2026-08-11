/**
 * BankID is only available on the hosted deployment (requires TIC
 * Identity API). Self-hosted deployments never show the BankID option.
 */

export function isBankIdEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true') return false
  return process.env.NEXT_PUBLIC_BANKID_ENABLED === 'true'
}
