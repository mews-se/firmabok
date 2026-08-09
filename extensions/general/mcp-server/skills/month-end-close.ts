import type { Skill } from './types'

const body = `# Month-End Close: Accounted

Run this at the end of each calendar month to ensure books are clean before locking the period.

## When to use

Trigger this workflow when the user says any of:

- "Close out [month]"
- "Stäng [månad]"
- "Month-end close"
- "Lock [period]"

Run it on the **last business day** of the month (or first business day of the next month). Locking too early prevents legitimate late entries; locking too late risks period-skew on VAT filings.

## Workflow

### Step 1: Book every business event

Goal: every affärshändelse in the period has a posted verifikat. Bookkeeping here is manual-voucher based: stage vouchers via \`gnubok_create_voucher\`, and settle invoices via \`gnubok_mark_invoice_as_paid\` / \`gnubok_link_invoice_to_voucher\`. The user approves each staged operation: staging is non-negotiable for legal compliance (BFL 5 kap.).

### Step 2: Check voucher gaps

Run \`gnubok_list_voucher_gaps\` for the fiscal period. **Every gap must have an explanation** per BFNAR 2013:2. Use \`gnubok_explain_voucher_gap\` to document each one (e.g., "Voucher number reserved but not used because invoice was cancelled before posting").

### Step 3: Run VAT report (monthly filers)

If the company files VAT monthly (beskattningsunderlag > 40M SEK, or voluntarily), run \`gnubok_get_vat_report\` with \`period_type: 'monthly'\`. Sanity-check ruta49 ("att betala/återfå"). Use \`gnubok_vat_review_widget\` for a visual review.

If quarterly or annual filer: skip: VAT happens on its own cadence (see the quarterly-vat-review skill).

### Step 4: Lock the period

Stage the lock via \`gnubok_lock_period(fiscal_period_id)\`. After user approval, no new entries can be posted into the period: late corrections must use \`gnubok_unlock_period\` (also high-risk, also staged).

## Critical rules

- **Never delete journal entries.** Use \`gnubok_reverse_journal_entry\` (storno reversal) to undo. DB triggers enforce this: direct deletes will fail.
- **Posted entries are immutable.** Once a JE is posted, even amounts are locked. Use \`gnubok_correct_entry\` for corrections.
- **Money math:** \`Math.round(x * 100) / 100\`, never \`toFixed()\`. The voucher tools handle this; if you compute manually, follow the same pattern.
- **Locking ≠ closing.** Locking blocks new entries; closing (after year-end) is irreversible. This skill stops at locking.

## Common errors

- **"Period must be locked before closing"**: \`gnubok_close_period\` requires \`gnubok_lock_period\` first AND the year-end closing entry. Don't try to close mid-year periods.

## Tools

- \`gnubok_create_voucher\`: stage a manual voucher
- \`gnubok_mark_invoice_as_paid\`: settle a customer invoice
- \`gnubok_link_invoice_to_voucher\`: link a payment already booked on a verifikat
- \`gnubok_list_voucher_gaps\`: BFNAR 2013:2 audit check
- \`gnubok_explain_voucher_gap\`: document a gap
- \`gnubok_get_vat_report\`: momsdeklaration data
- \`gnubok_vat_review_widget\`: interactive VAT review
- \`gnubok_lock_period\`: stage period lock
- \`gnubok_reverse_journal_entry\`: undo a posted entry (storno)
`

export const monthEndCloseSkill: Skill = {
  slug: 'month-end-close',
  name: 'Month-End Close',
  summary: 'End-of-month workflow: book vouchers, verify voucher gaps, file VAT (monthly filers), lock period.',
  tags: ['monthly', 'close', 'vat'],
  body,
  tier: 'workflow',
  // Universal: both AB and EF run a monthly close. VAT step is conditional
  // inside the body so non-VAT-registered companies aren't blocked.
  applicability: { entity_type: 'both' },
}
