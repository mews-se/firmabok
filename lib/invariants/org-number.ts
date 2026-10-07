import { luhnValidate } from '@/lib/bankgiro/luhn'

/**
 * Swedish organisationsnummer / personnummer: the one place that decides what
 * "a valid org number" means.
 *
 * ## The rule
 *
 * - **Canonical storage form is 10 digits, no separators** (`5560125790`).
 * - Input may arrive as 10 or 12 digits, with spaces or hyphens, because that
 *   is what users type and what provider APIs return. Both forms normalize to
 *   the same 10 digits; the century prefix is dropped.
 * - The last digit is a Luhn (mod-10) check digit, the structural rule
 *   Bolagsverket and personnummer share.
 *
 * ## Why this module exists
 *
 * Call sites that each had their own idea of the rule drifted apart: one
 * stripped only hyphens, another only the first hyphen, a third skipped the
 * check digit, a fourth rejected the 12-digit form. The rules only stay in
 * agreement if there is exactly one of them.
 */

/**
 * Strip the separators Swedish users and provider APIs put in org numbers.
 * Does not validate: use {@link isOrgNumberShaped} or {@link normalizeOrgNumber}.
 */
export function stripOrgNumberFormatting(raw: string): string {
  return raw.replace(/[\s-]/g, '')
}

/**
 * True when the input is structurally an org number (10 or 12 digits after
 * separators are stripped), regardless of check digit.
 */
export function isOrgNumberShaped(raw: string | null | undefined): boolean {
  if (!raw) return false
  const cleaned = stripOrgNumberFormatting(raw)
  return /^\d{10}$/.test(cleaned) || /^\d{12}$/.test(cleaned)
}

/**
 * Normalize an org number to Accounted's canonical 10-digit storage form.
 *
 * Accepts hyphen/space-formatted input in either of the two shapes Swedish
 * users commonly type:
 *  - 10 digits (5560125790 or 8001011231): stored as-is
 *  - 12 digits (198001011231): century prefix stripped
 *
 * Returns null for any other length, non-digit content, or invalid Luhn check
 * digit. Storing a structurally invalid org number would later be caught by
 * Skatteverket SRU and any receiving SIE4 system: refusing at the boundary
 * keeps Accounted's bookkeeping from accumulating under an unusable identifier.
 */
export function normalizeOrgNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = stripOrgNumberFormatting(raw)
  let canonical: string
  if (/^\d{10}$/.test(cleaned)) {
    canonical = cleaned
  } else if (/^\d{12}$/.test(cleaned)) {
    canonical = cleaned.substring(2)
  } else {
    return null
  }
  return luhnValidate(canonical) ? canonical : null
}

/** True when {@link normalizeOrgNumber} accepts the input. */
export function isValidOrgNumber(raw: string | null | undefined): boolean {
  return normalizeOrgNumber(raw) !== null
}

/**
 * True when the input is shaped like an org number but its check digit is
 * wrong. Lets a validator tell the user *which* problem they have instead of
 * one undifferentiated "ogiltigt organisationsnummer".
 */
export function hasInvalidOrgNumberCheckDigit(raw: string | null | undefined): boolean {
  return isOrgNumberShaped(raw) && !isValidOrgNumber(raw)
}

/**
 * Format a canonical org number for display: `NNNNNN-NNNN`.
 * Returns the input unchanged when it is not org-number shaped.
 */
export function formatOrgNumberDisplay(raw: string | null | undefined): string {
  if (!raw) return ''
  const cleaned = stripOrgNumberFormatting(raw)
  const ten = /^\d{12}$/.test(cleaned) ? cleaned.substring(2) : cleaned
  if (!/^\d{10}$/.test(ten)) return raw
  return `${ten.substring(0, 6)}-${ten.substring(6)}`
}
