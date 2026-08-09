'use client'

import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

/**
 * Soft warning shown when the booking-time duplicate guard fires
 * (TRANSACTION_BOOK_POSSIBLE_DUPLICATE): a voucher already books the same
 * date + amount on the same account. Never a hard block: genuinely repeated
 * same-day payments (e.g. several identical Swish transfers) are legitimate,
 * so the user can review the existing verifikat or book anyway.
 *
 * The caller owns the retry: "Bokför ändå" must re-issue the request with
 * force=true bound to `candidate.journal_entry_id` via
 * `expected_duplicate_journal_entry_id`, and the server re-detects it so a
 * stale id can't wave the guard away.
 */
export default function DuplicateBookingDialog({
  candidate,
  processing = false,
  onBookAnyway,
  onCancel,
}: {
  /** The already-booked sibling, or null to keep the dialog closed. */
  candidate: BookedDuplicateCandidate | null
  processing?: boolean
  onBookAnyway: () => void
  onCancel: () => void
}) {
  const t = useTranslations('transactions')

  return (
    <Dialog
      open={candidate !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialog_duplicate_title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('dialog_duplicate_body')}</p>
          {candidate && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {candidate.voucher_label
                    ? t('dialog_duplicate_voucher_label', { label: candidate.voucher_label })
                    : t('dialog_duplicate_voucher_generic')}
                </span>
                {/* candidate.amount is ALWAYS SEK or null, never a foreign
                    number (booking-duplicate-detection.ts): the explicit 'SEK'
                    states that contract at the call site. When the sibling is
                    foreign and carries no stored rate, amount is null and the
                    honest figure is the sibling's own amount in its own
                    currency, explicitly labelled. */}
                <span className="tabular-nums">
                  {candidate.amount != null
                    ? formatCurrency(candidate.amount, 'SEK')
                    : candidate.currency && candidate.amount_in_currency != null
                      ? formatCurrency(candidate.amount_in_currency, candidate.currency)
                      : t('dialog_duplicate_amount_unknown')}
                </span>
              </div>
              {/* Verified FX sibling: the kr figure above is the sibling's own
                  booked SEK value; show the foreign original beneath it so the
                  user can recognise their EUR/USD line at a glance. */}
              {candidate.amount != null &&
                candidate.currency &&
                candidate.amount_in_currency != null && (
                  <div className="text-right text-xs text-muted-foreground tabular-nums">
                    {formatCurrency(candidate.amount_in_currency, candidate.currency)}
                  </div>
                )}
              <div className="text-xs text-muted-foreground tabular-nums">
                {formatDate(candidate.entry_date)}
              </div>
              {candidate.description && (
                <div className="truncate text-xs text-muted-foreground">{candidate.description}</div>
              )}
              {/* Rateless foreign sibling: the amounts matched exactly in the
                  shared currency, but no SEK value exists for it, so say that
                  instead of printing an authoritative-looking kr figure.
                  Gated on candidate.currency: the sentence names the currency,
                  and interpolating an empty string renders broken Swedish
                  ("samma belopp i , men..."). A null-currency candidate with a
                  null amount already shows dialog_duplicate_amount_unknown. */}
              {candidate.amount == null && candidate.currency && (
                <div className="flex items-start gap-2 pt-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-warning-foreground leading-snug">
                    {t('dialog_duplicate_sek_unavailable', { currency: candidate.currency })}
                  </p>
                </div>
              )}
              {/* Ledger-only candidate whose amount could not be compared:
                  the match rests on date + account + direction alone. */}
              {candidate.amount != null && !candidate.amount_verified && (
                <div className="flex items-start gap-2 pt-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-warning-foreground leading-snug">
                    {t('dialog_duplicate_amount_unverified')}
                  </p>
                </div>
              )}
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            {candidate && (
              <Button asChild variant="ghost" size="sm" className="text-muted-foreground sm:mr-auto">
                <a
                  href={`/bookkeeping/${encodeURIComponent(candidate.journal_entry_id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('dialog_duplicate_view_voucher')}
                </a>
              </Button>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={onCancel} disabled={processing}>
                {t('dialog_duplicate_cancel')}
              </Button>
              <Button onClick={onBookAnyway} disabled={processing}>
                {t('dialog_duplicate_book_anyway')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
