'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import {
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  FileWarning,
  Inbox,
  ReceiptText,
  ShieldCheck,
  Stamp,
} from 'lucide-react'
import type { WorklistCounts } from '@/lib/worklist/types'

/**
 * AttGoraSection: the dashboard's unified worklist ("Att göra").
 *
 * One flat ledger of everything actionable, grouped into three bands by
 * session intent: Bokför (the daily loop), Granska & komplettera (close the
 * gaps), Bevaka (time-driven). Every count comes from lib/worklist (the same
 * source as the sidebar badges) so the numbers can never disagree.
 */

interface AttGoraSectionProps {
  worklist: WorklistCounts
  /**
   * True when the company has zero posted journal entries. An empty ledger
   * is not an achievement: the all-clear state then says "nothing here yet"
   * instead of a false "all caught up".
   */
  emptyLedger?: boolean
}

interface WorklistRowProps {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  detail?: string
  count: number
  badge?: React.ReactNode
}

function WorklistRow({ href, icon: Icon, label, detail, count, badge }: WorklistRowProps) {
  return (
    <Link
      href={href}
      className="group flex w-full items-start gap-3 border-b border-border px-1 py-3.5 transition-colors duration-150 hover:bg-secondary/30"
    >
      <span className="mt-px w-[18px] shrink-0 text-muted-foreground" aria-hidden>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px]">{label}</p>
        {detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      <span className="ml-auto flex shrink-0 items-center gap-2.5 pt-px">
        {badge}
        <Badge variant="secondary" className="font-normal tabular-nums">
          {count}
        </Badge>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      </span>
    </Link>
  )
}

function BandHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 pt-5 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
      {children}
    </p>
  )
}

export default function AttGoraSection({
  worklist,
  emptyLedger = false,
}: AttGoraSectionProps) {
  const t = useTranslations('dashboard')
  const { counts, total } = worklist

  const showInboxDocuments = counts.inbox_document > 0
  const bokforRows = showInboxDocuments
  const granskaRows =
    counts.supplier_invoice_approval > 0 ||
    counts.verifikat_missing_document > 0 ||
    counts.pending_operations > 0
  const bevakaRows = counts.overdue_invoice > 0 || counts.deadline_action > 0
  const allClear = !bokforRows && !granskaRows && !bevakaRows

  return (
    <section aria-label={t('att_gora_title')}>
      {/* Pane header: Geist title + quiet count over a hairline */}
      <div className="flex items-baseline justify-between border-b border-border px-1 pb-2.5">
        <h2 className="font-sans text-sm font-medium">{t('att_gora_title')}</h2>
        <p className="text-xs text-muted-foreground tabular-nums" role="status" aria-live="polite">
          {allClear
            ? emptyLedger
              ? t('att_gora_new_status')
              : t('all_done')
            : t('att_gora_left', { count: total })}
        </p>
      </div>

      <div>
          {allClear ? (
            emptyLedger ? (
              <EmptyState
                icon={BookOpen}
                title={t('att_gora_new_title')}
                description={t('att_gora_new_body')}
                className="py-10"
              />
            ) : (
              <EmptyState
                icon={CheckCircle2}
                title={t('att_gora_empty_title')}
                description={t('att_gora_empty_body')}
                className="py-10"
              />
            )
          ) : (
            <div className="pb-2">
              {bokforRows && (
                <div>
                  <BandHeader>{t('band_bokfor')}</BandHeader>
                  <div>
                    {showInboxDocuments && (
                      <WorklistRow
                        href="/inbox"
                        icon={Inbox}
                        label={t('row_inbox_documents')}
                        detail={t('row_inbox_documents_detail')}
                        count={counts.inbox_document}
                      />
                    )}
                  </div>
                </div>
              )}

              {granskaRows && (
                <div>
                  <BandHeader>{t('band_granska')}</BandHeader>
                  <div>
                    {counts.supplier_invoice_approval > 0 && (
                      <WorklistRow
                        href="/supplier-invoices"
                        icon={Stamp}
                        label={t('row_supplier_approval')}
                        count={counts.supplier_invoice_approval}
                      />
                    )}
                    {counts.verifikat_missing_document > 0 && (
                      <WorklistRow
                        href="/bookkeeping"
                        icon={FileWarning}
                        label={t('row_missing_underlag')}
                        count={counts.verifikat_missing_document}
                      />
                    )}
                    {counts.pending_operations > 0 && (
                      <WorklistRow
                        href="/pending"
                        icon={ShieldCheck}
                        label={t('row_pending_ops')}
                        count={counts.pending_operations}
                      />
                    )}
                  </div>
                </div>
              )}

              {bevakaRows && (
                <div>
                  <BandHeader>{t('band_bevaka')}</BandHeader>
                  <div>
                    {counts.overdue_invoice > 0 && (
                      <WorklistRow
                        href="/invoices?status=unpaid"
                        icon={ReceiptText}
                        label={t('row_overdue_invoices')}
                        count={counts.overdue_invoice}
                      />
                    )}
                    {counts.deadline_action > 0 && (
                      <WorklistRow
                        href="/deadlines"
                        icon={CalendarClock}
                        label={t('row_deadlines')}
                        count={counts.deadline_action}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
      </div>
    </section>
  )
}
