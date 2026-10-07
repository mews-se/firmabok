import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Resume list ("Fortsätt") for the homepage: in-progress work derived purely
 * from draft/mid-lifecycle state (dev_docs/last_session_resume.md §6).
 * No event log, no presence table: a completed flow can never render here
 * because only draft-state rows are ever fetched (the reliability invariant).
 *
 * Lives in lib/worklist (owns pending-work predicates) but is deliberately
 * NOT part of WorklistCounts.total: Att göra = obligations the system
 * imposes; Fortsätt = work the user started and left. An item renders in
 * exactly one surface.
 */

export type ResumeItemKind =
  | 'journal_draft'
  | 'invoice_draft'
  | 'invoice_unsent'

export interface ResumeItem {
  kind: ResumeItemKind
  /** Stable reference, e.g. 'invoice:<uuid>'. */
  ref: string
  href: string
  /** Free-text context: verifikat description, customer name, or period. */
  context: string | null
  /** Invoice number (unsent invoices). */
  number?: string | null
  amount?: number | null
  currency?: string | null
  /** Deadline boost: unsent invoices outrank newer trivial drafts (Iqbal &
   *  Horvitz: deadline-tied tasks matter more). */
  late?: boolean
  updated_at: string
}

export const RESUME_MAX_ROWS = 3

/**
 * Pure ordering + cap: late items first (deadline boost), then most recently
 * touched. Deterministic and explainable: no scoring, no ML.
 */
export function mergeResumeItems(items: ResumeItem[]): ResumeItem[] {
  return [...items]
    .sort((a, b) => {
      if (Boolean(a.late) !== Boolean(b.late)) return a.late ? -1 : 1
      return b.updated_at.localeCompare(a.updated_at)
    })
    .slice(0, RESUME_MAX_ROWS)
}

/**
 * Fetch resume candidates for a company. Every query soft-fails to empty:
 * the worst case is a missing pane, never a broken homepage.
 */
export async function listResumeItems(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ResumeItem[]> {
  const [journalRes, invoiceRes] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('id, description, updated_at')
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .order('updated_at', { ascending: false })
      .limit(RESUME_MAX_ROWS + 1)
      .then((r) => r, () => ({ data: null })),
    supabase
      .from('invoices')
      .select('id, invoice_number, total, currency, updated_at, customer:customers(name)')
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .order('updated_at', { ascending: false })
      .limit(RESUME_MAX_ROWS + 1)
      .then((r) => r, () => ({ data: null })),
  ])

  const items: ResumeItem[] = []

  for (const row of (journalRes.data ?? []) as Array<{
    id: string
    description: string | null
    updated_at: string
  }>) {
    items.push({
      kind: 'journal_draft',
      ref: `journal:${row.id}`,
      href: `/bookkeeping/${row.id}`,
      context: row.description,
      updated_at: row.updated_at,
    })
  }

  for (const row of (invoiceRes.data ?? []) as Array<{
    id: string
    invoice_number: string | null
    total: number | null
    currency: string | null
    updated_at: string
    customer: { name: string } | { name: string }[] | null
  }>) {
    const customer = Array.isArray(row.customer) ? row.customer[0] : row.customer
    const unsent = !!row.invoice_number
    items.push({
      kind: unsent ? 'invoice_unsent' : 'invoice_draft',
      ref: `invoice:${row.id}`,
      href: `/invoices/${row.id}`,
      context: customer?.name ?? null,
      number: row.invoice_number,
      amount: row.total,
      currency: row.currency,
      late: unsent,
      updated_at: row.updated_at,
    })
  }

  return mergeResumeItems(items)
}
