/**
 * First-fiscal-year defaults derived from TIC lookup data.
 *
 * Extracted from WelcomeOnboarding so both the wizard and the journey
 * onboarding can share them (dev_docs/onboarding_migration_plan.md, PR A).
 */

/**
 * Parse TIC v2's `startMonthDay` ("MM-DD": e.g. "07-01") into a month
 * number 1-12. Returns null on missing / malformed input so the caller
 * can fall through to the manual picker default.
 */
export function parseStartMonthDay(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{1,2})-\d{1,2}$/.exec(value)
  if (!match) return null
  const month = Number(match[1])
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return month
}

/**
 * Derive the first-year defaults from TIC's `registrationDate`.
 * A company is treated as "first year" when registered less than 12 months
 * ago: comfortably inside BFL's 18-month cap on a first räkenskapsår, which
 * has no minimum length. Returns both the toggle state and a seeded
 * `first_year_start` (always the 1st of the registration month, the format
 * the date inputs expect).
 *
 * `now` exists for tests; production callers omit it.
 */
export function deriveFirstYearDefaults(
  registrationDate: number | null | undefined,
  now: number = Date.now(),
): {
  isFirstFiscalYear: boolean
  firstYearStart: string | undefined
} {
  if (!registrationDate || !Number.isFinite(registrationDate)) {
    return { isFirstFiscalYear: false, firstYearStart: undefined }
  }
  const regDate = new Date(registrationDate)
  if (Number.isNaN(regDate.getTime())) {
    return { isFirstFiscalYear: false, firstYearStart: undefined }
  }
  const monthsAgo = (now - regDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
  if (monthsAgo >= 12) return { isFirstFiscalYear: false, firstYearStart: undefined }
  const year = regDate.getUTCFullYear()
  const month = String(regDate.getUTCMonth() + 1).padStart(2, '0')
  return { isFirstFiscalYear: true, firstYearStart: `${year}-${month}-01` }
}
