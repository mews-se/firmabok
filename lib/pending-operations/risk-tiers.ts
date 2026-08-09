/**
 * Risk tier classification for pending_operations.
 *
 * Used by lib/pending-operations/should-auto-commit.ts to decide whether a
 * staged proposal from a trusted agent can be auto-committed without human
 * review.
 *
 * Tiering principles:
 *   - **low**: no booking impact, no external side-effects, no audit risk.
 *     A reasonable bookkeeper would never want to manually approve these.
 *   - **medium**: reversible booking impact (drafts, transaction
 *     categorization that can be uncategorized). Auto-commit is allowed for
 *     trusted agents under a configurable monetary threshold.
 *   - **high**: irreversible or compliance-critical. Sends external messages,
 *     locks/closes periods, or affects tax filings. NEVER auto-committed,
 *     regardless of company opt-in or trust level.
 */

export type RiskLevel = 'low' | 'medium' | 'high'

export const OPERATION_RISK_TIERS: Record<string, RiskLevel> = {
  // ── Low: pure data, no booking impact ─────────────────────────────
  create_customer: 'low',
  update_customer: 'low',
  // Article catalog (artikelregister) is app-level master data: no journal
  // impact, no external side-effect. Unlike create_supplier it carries no
  // payment-routing fields, so there's no BEC/fraud surface; both create and
  // update sit at the lowest tier next to create_customer.
  create_article: 'low',
  update_article: 'low',
  // Dimension values (kostnadsställe/projekt object codes, SIE #OBJEKT) are
  // reporting master data: no journal impact, no external side-effect, no
  // payment-routing surface. Staged (agents never silently mint reporting
  // values) but at the lowest tier next to create_customer/create_article.
  create_dimension_value: 'low',
  // Kontoplan reference data: adding an account has no journal impact (a
  // wrong account only becomes bookable, nothing is booked), and update is
  // limited to name/description/VAT-default/SRU/is_active: the same surface
  // update_article covers for articles. No payment routing, no external
  // side-effects.
  create_account: 'low',
  update_account: 'low',
  // Verifikat notes are annotation metadata, not räkenskapsinformation: the
  // journal_entries immutability trigger (20260608120000) permits exactly a
  // notes-only diff on committed entries and rejects anything more, so the
  // op cannot touch booking data even if tampered with.
  set_voucher_note: 'low',

  // ── Medium: reversible booking ─────────────────────────────────────
  // Link an existing posted verifikat as payment for an invoice. Reversible by
  // deleting the invoice_payments row and reverting invoice status; no journal
  // entry is created or modified. Sits next to match_transaction_invoice
  // semantically: both attach an existing booking to an invoice.
  link_invoice_voucher: 'medium',
  // Supplier-side mirror of link_invoice_voucher: link an existing posted
  // verifikat (Dr 2440) as payment for a leverantörsfaktura. Reversible by
  // deleting the supplier_invoice_payments row and reverting status; no journal
  // entry is created or modified.
  link_supplier_invoice_voucher: 'medium',
  create_invoice: 'medium', // creates as draft; sending is a separate op
  // Rewrites a DRAFT in place (header + full item replace). Same tier as
  // create_invoice: the target has no verifikat yet (isEditableInvoiceDraft
  // is re-checked at commit), so the edit is fully reversible by editing again.
  update_invoice: 'medium',
  // Recurring invoice schedules: the commit only creates/edits the monthly
  // template (nothing is booked or sent at commit time), and the schedule is
  // pausable/deletable before the next cron run. Not 'low' because an
  // approved schedule keeps generating numbered invoices without any further
  // approval. With params.auto_send === true the schedule also keeps EMAILING
  // the customer every cycle: a standing order for the same external
  // side-effect that puts one-off send_invoice at 'high', so getRiskLevel
  // escalates these two to 'high' when it can see that param.
  create_recurring_schedule: 'medium',
  update_recurring_schedule: 'medium',
  // Supplier master data carries payment-routing fields (IBAN, BIC, bankgiro,
  // bank_account) that drive outgoing payment files and supplier invoice
  // postings. A wrong account or org_number can enable supplier-fraud / BEC
  // (silently rerouting payment), so always require explicit human approval
  // rather than auto-commit.
  create_supplier: 'medium',
  // Company payment settings control where customers send money on future
  // invoices. Treat changes like supplier payment-routing data: reversible,
  // but never eligible for silent low-risk auto-commit.
  update_company_settings: 'medium',
  // Linking a doc to a posted verifikation is part of räkenskapsinformation
  // (BFL 5 kap 6 §) and becomes immutable once the JE is posted. Medium so a
  // human confirms the doc-to-verifikat pairing before it locks.
  link_document_to_voucher: 'medium',
  // Dimension-only diff on posted lines (verifikat stays immutable), fully
  // audited via dimension_retag_log, but it rewrites reporting history, so
  // it crosses a human at medium.
  retag_line_dimensions: 'medium',

  // ── High: irreversible, compliance-critical, or external side-effects
  send_invoice: 'high',          // emails the customer
  mark_invoice_paid: 'high',     // posts payment journal entry
  mark_invoice_sent: 'high',     // assigns invoice number, accrual JE

  // ── Stream 1 Phase 1 ops (added when those tools land) ─────────────
  close_period: 'high',
  lock_period: 'high',
  unlock_period: 'high',
  set_opening_balances: 'high',
  run_year_end: 'high',
  run_currency_revaluation: 'high',
  // Planenlig avskrivning: one journal entry per asset, each independently
  // reversible (storno). Mid-stakes bokslut posting: staged and human-reviewed,
  // but not the irreversible tier that year-end close / period lock occupy.
  post_annual_depreciation: 'medium',
  import_sie: 'high',
  // Hard-deletes the import's journal entries + resets voucher sequences.
  // Same destructive reach as replace_sie_import; never auto-commit.
  undo_sie_import: 'high',
  explain_voucher_gap: 'medium',
  approve_supplier_invoice: 'high',
  credit_supplier_invoice: 'high',
  // Create supplier invoice from inbox: stages a `registered` supplier invoice
  // + its line items + document attachment. Reversible until approved (the
  // approval is a separate high-risk op) but creates a leverantörsskuld row,
  // so we route it through human review at medium tier.
  create_supplier_invoice_from_inbox: 'medium',
  credit_invoice: 'high',
  convert_invoice: 'medium',

  // ── Phase 4: arbitrary-line bookkeeping primitives ─────────────────
  // Both accept caller-supplied account/amount/period: unlike
  // uncategorize_transaction (medium), which mirrors an existing entry.
  // The arbitrary-line capability is what makes these compliance-critical.
  create_voucher: 'high',
  correct_entry: 'high',
  reverse_entry: 'high',
}

/**
 * Op types whose tier depends on the staged params, not just the type.
 * Checked inside getRiskLevel so every caller that can pass params gets the
 * escalation for free; callers without params in scope fall back to the
 * static (never lower) tier.
 */
function paramEscalatedRisk(
  operationType: string,
  params: Record<string, unknown> | undefined,
): RiskLevel | null {
  // A recurring schedule with auto_send=true is indefinite outbound email
  // with no further approval per send: the exact external side-effect that
  // makes one-off send_invoice 'high'.
  if (
    (operationType === 'create_recurring_schedule' ||
      operationType === 'update_recurring_schedule') &&
    params?.auto_send === true
  ) {
    return 'high'
  }
  return null
}

export function getRiskLevel(
  operationType: string,
  params?: Record<string, unknown>,
): RiskLevel {
  const escalated = paramEscalatedRisk(operationType, params)
  if (escalated) return escalated
  // Default to 'high' for unknown ops, fail-safe: unknown means human review.
  return OPERATION_RISK_TIERS[operationType] ?? 'high'
}

/**
 * High-risk operations are NEVER auto-committed, regardless of company opt-in
 * or actor trust. Encoded here (not in DB config) so it can't be bypassed.
 */
export function isHighRisk(operationType: string, params?: Record<string, unknown>): boolean {
  return getRiskLevel(operationType, params) === 'high'
}
