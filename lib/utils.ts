import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { format as formatDateFns, parseISO, isValid } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Shown by the date formatters when handed an Invalid Date. We fail closed:
 * render a neutral placeholder rather than the raw malformed string: so a
 * corrupted value is never surfaced to the UI, and never throws either. After
 * the server validation + DB CHECK landed, a bad date shouldn't reach here at
 * all; this is the last-resort guard.
 */
const INVALID_DATE_PLACEHOLDER = '-'

/**
 * Money with a currency symbol, sv-SE grouping: `1234.5` -> `1 234,50 kr`.
 *
 * `currency` defaults to SEK with sv-SE grouping: that is a Swedish
 * accounting convention (.claude/rules/i18n.md), and the
 * single-argument form is the correct call on the hundreds of values that ARE
 * kronor (ledger amounts, KPI aggregates, salary, tax).
 *
 * What the default cannot know is that the number came off a record carrying
 * its own currency. `formatCurrency(invoice.total)` on a 1 000 EUR invoice
 * prints "1 000,00 kr", and nothing downstream can tell that apart from a real
 * SEK total. So: pass `record.currency` whenever the record has one, or format
 * the kronor twin (`total_sek` / `amount_sek`). Journal entry line amounts are
 * always SEK already (lib/bookkeeping/ledger-line-amount.ts).
 *
 * scripts/checks/format-currency-sek-label.mjs fails CI on a new single-argument
 * call whose value is read off a record the same file reads `.currency` from.
 */
export function formatCurrency(
  amount: number,
  currency?: string | null,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number },
): string {
  // A `= 'SEK'` default only covers undefined. `transactions.currency` is a
  // nullable column whose NULL is legacy for the 'SEK' default (see migration
  // 20260726100000), yet the Transaction type declares it required, so a NULL
  // reached Intl unguarded: `currency: null` throws RangeError and a single
  // legacy row blanked the whole transactions list into the error boundary.
  const code = currency || 'SEK'
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: options?.minimumFractionDigits ?? 0,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(amount)
}

export function formatDate(date: Date | string): string {
  // parseISO interprets bare 'yyyy-MM-dd' as local midnight, not UTC midnight.
  // Using new Date() would shift the displayed day by one in timezones west of
  // UTC for bare date strings: that's an off-by-one we don't want for
  // accounting data.
  const d = typeof date === 'string' ? parseISO(date) : date
  // A malformed value (e.g. a 6-digit year fat-fingered into a native
  // <input type="date">, stored by Postgres as year 202403) yields an Invalid
  // Date, and date-fns `format` THROWS a RangeError on that. One bad row must
  // never crash an entire route via the error boundary: degrade to the raw
  // input instead.
  if (!isValid(d)) return INVALID_DATE_PLACEHOLDER
  return formatDateFns(d, 'yyyy-MM-dd')
}

/**
 * Bare amount with sv-SE grouping and exactly two decimals, no currency symbol:
 * `1234.5` → `1 234,50`. Use in table cells / inputs where the column header or
 * surrounding context already conveys "kr" and `formatCurrency`'s symbol would
 * be noise. sv-SE like `formatCurrency` (Swedish accounting convention). When
 * you need the SEK symbol, use `formatCurrency`.
 */
export function formatAmount(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

/**
 * Long-form date for metadata/audit contexts (e.g. "9 maj 2026").
 * Use formatDate for transaction/voucher/invoice dates that need to align in tables.
 */
export function formatDateLong(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date
  if (!isValid(d)) return INVALID_DATE_PLACEHOLDER
  return d.toLocaleDateString('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatOrgNumber(orgNumber: string): string {
  // Format Swedish org number: XXXXXX-XXXX
  const cleaned = orgNumber.replace(/\D/g, '')
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 6)}-${cleaned.slice(6)}`
  }
  return orgNumber
}
