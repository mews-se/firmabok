/**
 * First-fiscal-year end-date options, ported from the wizard's
 * Step3TaxRegistration rules (BFL 3 kap.):
 * - EF always ends 31 December; the first year may run up to 18 months
 *   (a start after 30 June may roll into next year's December).
 *
 * BFL 3 kap sets NO minimum length for a first räkenskapsår: it may be
 * shorter than 12 months when bokföringsskyldigheten begins, with no floor
 * (Bolagsverket: "hur kort som helst"). See DECISIONS.md 2026-07-25 / PR
 * #1165, which removed the same invented 6-month floor from the validator.
 * The `>= 1` guards below are structural, not legal.
 */

export interface FirstYearEndOption {
  /** ISO date, last day of the month. */
  date: string
  months: number
  year: number
  month: number
  day: number
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function efFirstYearEndOptions(startYear: number, startMonth: number): FirstYearEndOption[] {
  const out: FirstYearEndOption[] = []
  const m1 = 12 - startMonth + 1
  if (m1 >= 1 && m1 <= 18) {
    out.push({ date: iso(startYear, 12, 31), months: m1, year: startYear, month: 12, day: 31 })
  }
  const m2 = m1 + 12
  if (m2 >= 1 && m2 <= 18 && startMonth > 6) {
    out.push({ date: iso(startYear + 1, 12, 31), months: m2, year: startYear + 1, month: 12, day: 31 })
  }
  return out
}
