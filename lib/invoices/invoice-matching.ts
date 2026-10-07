/**
 * Shared scoring primitives for matching an amount and a counterparty name
 * against an invoice: used by the existing-verifikat candidate search
 * (voucher-matching.ts, supplier-voucher-matching.ts).
 */

/**
 * Confidence thresholds for ranking invoice match candidates.
 */
export const CONFIDENCE = {
  OCR_REFERENCE_MATCH: 0.99,
  EXACT_AMOUNT_CUSTOMER: 0.95,
  EXACT_AMOUNT_ONLY: 0.80,
  FUZZY_AMOUNT_CUSTOMER: 0.70,
  FUZZY_AMOUNT_ONLY: 0.50,
  MIN_THRESHOLD: 0.50,
}

/**
 * Fuzzy amount tolerance (±1% for FX fees)
 */
const FUZZY_TOLERANCE = 0.01

/**
 * Check if two amounts match exactly (within rounding)
 */
export function amountsMatchExact(amount: number, invoiceTotal: number): boolean {
  // Round to 2 decimal places for comparison
  const amountRounded = Math.round(amount * 100) / 100
  const invRounded = Math.round(invoiceTotal * 100) / 100
  return amountRounded === invRounded
}

/**
 * Check if two amounts match within fuzzy tolerance (±1%)
 */
export function amountsMatchFuzzy(amount: number, invoiceTotal: number): boolean {
  if (invoiceTotal === 0) return false
  const diff = Math.abs(amount - invoiceTotal)
  // Cap fuzzy tolerance at 500 SEK to prevent false positives on large invoices
  const tolerance = Math.min(invoiceTotal * FUZZY_TOLERANCE, 500)
  return diff <= tolerance
}

/**
 * Check if the customer name appears in a description / counterparty text
 */
export function customerNameMatches(
  customerName: string | undefined,
  description: string,
  counterparty: string | null
): boolean {
  if (!customerName) return false

  const searchTerms = customerName.toLowerCase().split(/\s+/).filter(term => term.length > 2)
  const searchText = `${description} ${counterparty || ''}`.toLowerCase()

  // Check if any significant word from the customer name appears in the text
  return searchTerms.some(term => searchText.includes(term))
}
