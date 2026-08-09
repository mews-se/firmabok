/**
 * Shared constants and helpers for the duplicate-payment / SI-match guards
 * used by `/api/supplier-invoices/[id]/mark-paid` and
 * `/api/transactions/[id]/categorize`. Both guards look for a likely-matching
 * counterparty within a fuzzy amount + date window; keeping the thresholds in
 * one place makes them tunable as we learn from real false-positive rates.
 */

/** Acceptable amount drift (±) when matching a bank tx to an invoice amount. */
export const DUPLICATE_AMOUNT_TOLERANCE_PCT = 0.02

/** Date window (±days) around the payment / invoice date. */
export const DUPLICATE_DATE_WINDOW_DAYS = 60

/** Cap on supplier / merchant names before they enter an ILIKE pattern, to
 * bound query work and avoid pathological inputs degrading the index scan. */
const MAX_LIKE_NEEDLE_LENGTH = 200

/**
 * Escape LIKE/ILIKE wildcards (`%`, `_`, `\`) and truncate to a safe length
 * before embedding the value in an ILIKE pattern. SQL-injection is already
 * handled by Supabase's parameterization; this purely prevents silent
 * over-matching on names like "50% Off AB" and bounds DB work on long inputs.
 */
export function escapeLikePattern(value: string): string {
  const truncated = value.length > MAX_LIKE_NEEDLE_LENGTH
    ? value.slice(0, MAX_LIKE_NEEDLE_LENGTH)
    : value
  return truncated.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * Normalize a Swedish payment reference (OCR / fakturanummer) for equality
 * comparison. Banks emit references with varying separators ("2026-0042",
 * "2026 0042", "2026/0042"); the OCR-spec equality is over the digits only.
 * Returns "" for nullish/empty so callers can short-circuit without
 * branching.
 */
export function normalizeOcrReference(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/\D/g, '')
}
