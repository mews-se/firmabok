import { NextResponse, after } from 'next/server'
import {
  TASKS_EXTENSION_ID,
  isTaskCapableClient,
  createMcpTask,
  resolveMcpTask,
  taskToWire,
  type McpTaskRow,
} from './tasks'
import {
  extractBearerToken,
  validateApiKey,
  createServiceClientNoCookies,
  hasScope,
  TOOL_SCOPE_MAP,
} from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { roundOre, sumOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { applySettlementAccount } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { buildTransactionEntryLines, createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate, findCounterpartyTemplatesBatch, formatCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { canApproveSupplierInvoice } from '@/lib/supplier-invoices/lifecycle'
import { eventBus } from '@/lib/events/bus'
import { getVatRules, getPermittedVatRates } from '@/lib/invoices/vat-rules'
import { fetchExchangeRate, convertToSEK } from '@/lib/currency/riksbanken'
import { getBranding } from '@/lib/branding/service'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import {
  calculateGrossMargin,
  calculateCashPosition,
  calculateExpenseRatio,
  calculateAvgPaymentDays,
  calculateVatLiability,
} from '@/lib/reports/kpi'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import {
  ACCOUNT_RUTA,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  rutorFromTotals,
  rcInputTotalsFromDeclaration,
  calculateVatDeclaration,
} from '@/lib/reports/vat-declaration'
import { fetchDynamicRuta05Accounts } from '@/lib/reports/vat-revenue-accounts'
// The momsdeklaration completeness checks live in core (lib/reports) and are
// shared with the web UI's "Kontroll av underlaget" gate. The MCP surface
// imports them instead of mirroring them: a hand-rolled copy here is exactly
// how the reverse-charge check drifted into an unreachable `ruta48 === 0` test.
import {
  runVatDeclarationChecks,
  type VatCheckAccountTotals,
  type VatDeclarationCheck,
  type VatDeclarationCheckStatus,
} from '@/lib/reports/vat-declaration-checks'
import {
  withRcBasisGapFindings,
  isFilingBlocked,
  rcBasisTotalsByRate,
  type RcBasisGapScan,
} from '@/lib/reports/vat-filing-gate'
import { findRcBasisGaps } from '@/lib/reports/rc-basis-gaps'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, fetchLinesByEntryIds, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'
import { uiWidgets, findUiWidget, WIDGET_MIME_TYPE } from './widgets'
import { dataResources, findResource, parseResourceQuery } from './resources'
import { buildLedgerContext } from '@/lib/agent-context/ledger-context'
import { prompts, findPrompt } from './prompts'
import { findSkill, loadAllSkills, toSummary, SKILL_MIME_TYPE, SKILL_URI_PREFIX, skillUri, skillSlugFromUri } from './skills'
import type { SkillTier } from './skills'
import { RECOMMENDED_WORKFLOW_LOADOUTS, assertRecommendedLoadoutsValid } from './recommended-tools'
import {
  canonicalizeToolReferencesInText,
  projectToolReferences,
  projectToolReferencesInText,
  resolveMcpToolNamespace,
  toCanonicalToolName,
  toPublicToolName,
  type McpToolNamespace,
} from './tool-namespace'
import { getRiskLevel } from '@/lib/pending-operations/risk-tiers'
import { normalizeVatRateToDecimal } from '@/lib/vat/supplier-invoice-line-checks'
import { CreateSupplierParamsSchema } from '@/lib/pending-operations/schemas/create-supplier'
import { accountClassTypeConflict } from '@/lib/pending-operations/schemas/account'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { CreateDimensionValueParamsSchema } from '@/lib/pending-operations/schemas/dimension-value'
import { RetagLineDimensionsParamsSchema, RETAG_MAX_LINES } from '@/lib/pending-operations/schemas/retag-line-dimensions'
import { UpdateCompanySettingsParamsSchema } from '@/lib/pending-operations/schemas/company-settings'
import { UpdateCustomerParamsSchema } from '@/lib/pending-operations/schemas/customer'
import {
  CreateRecurringScheduleParamsSchema,
  UpdateRecurringScheduleParamsSchema,
} from '@/lib/pending-operations/schemas/recurring-schedule'
import { computeInitialRunDate } from '@/lib/invoices/recurring-schedule-service'
import { UpdateInvoiceParamsSchema } from '@/lib/pending-operations/schemas/update-invoice'
import { isEditableInvoiceDraft } from '@/lib/invoices/is-editable-draft'
import {
  ensureCompanyDimensions,
  fetchDimensionRegistry,
  parseDimensionsArg,
  mergeLineDimensions,
  resolveDimensionBags,
  type DimensionResolution,
} from './dimensions'
import { generateDimensionPnl } from '@/lib/reports/dimension-pnl'
import Fuse from 'fuse.js'
import { z } from 'zod'
import {
  checkIdempotencyKey,
  storeIdempotencyResponse,
  hashRequest,
  IdempotencyKeyReuseError,
} from '@/lib/api/idempotency'
import { toToolError, type NextActionHint } from './tool-result'
import {
  addCompanyToNextHint,
  addCompanyToTopLevelNext,
  assertMcpCompanyWriteAccess,
  extractRequestedCompany,
  isCompanyDependentTool,
  projectToolInputSchema,
  resolveMcpCompanyContext,
} from './company-routing'
import { findSupplierCandidates } from './supplier-candidates'
import { assertNoPlaintextPersonnummer } from './staging-pii-guard'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { createInvoicePaymentJournalEntry, createInvoiceCashEntry, createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { findMatchingInvoices } from '@/lib/invoices/invoice-matching'
import { sanitizeDeliveryRecipientStatuses } from '@/lib/invoices/delivery-recipient-statuses'
import { listRotRutCandidates, createRotRutPayoutRequest } from '@/lib/invoices/rot-rut-service'
import { importRotRutBeslutFile } from '@/lib/invoices/rot-rut-beslut-import'
import { RotRutBeslutFileSchema } from '@/lib/api/schemas'
import {
  findMatchingVouchersForInvoice,
  validateVoucherForInvoiceLink,
} from '@/lib/invoices/voucher-matching'
import {
  findMatchingVouchersForSupplierInvoice,
  validateVoucherForSupplierInvoiceLink,
} from '@/lib/invoices/supplier-voucher-matching'
import { findFiscalPeriod, reverseEntry, validateBalance } from '@/lib/bookkeeping/engine'
import { closePeriod, countUnbookedInPeriod, lockPeriod, resolvePeriodStatusForDate, type PeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import { validateYearEndReadiness, previewYearEndClosing } from '@/lib/core/bookkeeping/year-end-service'
import { generateSIEExport } from '@/lib/reports/sie-export'
import { generateFullArchive, estimateArchiveSize } from '@/lib/reports/full-archive-export'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { getEmailService } from '@/lib/email/service'
import { hasCapability, capabilityBlockedError } from '@/lib/entitlements/has-capability'
import { MCP_TOOL_CAPABILITY_MAP } from '@/lib/entitlements/keys'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import {
  completePendingDocumentUpload,
  createPendingDocumentUpload,
  uploadDocument,
  MAX_DOCUMENT_SIZE,
} from '@/lib/core/documents/document-service'
import { AgentExtractionSchema } from './agent-extraction'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { getUserCompanies } from '@/lib/company/context'
// ensureInitialized() is called by the extension router (ext/[...path]/route.ts)
// which dispatches to this handler: no duplicate call needed here.
import type { Transaction, TransactionCategory, EntityType, VatTreatment, Invoice, Currency, CompanySettings, Customer, InvoiceItem, PendingOperation, VatPeriodType, VatDeclarationRutor, YearEndBlockerCode } from '@/types'

// ── Actor context ────────────────────────────────────────────

interface ActorContext {
  type: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
  id?: string
  label?: string
  /**
   * Stable agent-session identifier from the `Mcp-Session-Id` JSON-RPC header
   * when present, otherwise null. Used to correlate `mcp.tool_called`,
   * `mcp.workflow_started`, `mcp.next_hint_followed`, etc. events across a
   * single agent conversation. Not used for auth.
   */
  sessionId?: string | null
  /**
   * Distribution-channel marker from `X-Accounted-Client`, the legacy
   * `X-Gnubok-Client`, or the `client` query param (e.g. 'openclaw').
   * Telemetry-only: same trust level as Mcp-Session-Id, never used for auth or
   * behavior.
   */
  client?: string | null
}

// ── JSON-RPC types ───────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── MCP Tool definition ──────────────────────────────────────

interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

interface McpTool {
  name: string
  // Top-level Tool.title per MCP spec 2025-06-18 (human-facing label for
  // directory listings; distinct from annotations.title). Short Title Case
  // noun phrase. Flows out via the tools/list serializer below.
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: McpToolAnnotations
  /** Wide or specialized tools discoverable through gnubok_search_tools only. */
  catalogVisibility?: 'default' | 'search'
  _meta?: { ui: { resourceUri: string } }
  // Result-level UI hint: when set, a call passing render_ui=true gets a
  // _meta.ui.resourceUri on the RESULT, so the host renders the widget only when
  // asked. (Contrast _meta above, on the definition, which renders on every call.)
  uiResourceUri?: string
  // Tasks extension: when this predicate returns true for a call from a
  // task-capable client, the dispatcher returns a CreateTaskResult and runs
  // execute() after the response instead of blocking on it. Not serialized
  // into tools/list.
  shouldRunAsTask?: (args: Record<string, unknown>) => boolean
  execute: (
    args: Record<string, unknown>,
    companyId: string,
    userId: string,
    supabase: SupabaseClient,
    actor?: ActorContext
  ) => Promise<unknown>
}

// ── Shared constants ─────────────────────────────────────────

const log = createLogger('mcp-server')

// gnubok_feedback rate limit: 1 per 60s per actor. In-memory single-process;
// no Redis dependency. See the gnubok_feedback tool definition below.
const FEEDBACK_RATE_LIMIT_MS = 60_000
const feedbackRateLimit = new Map<string, number>()

const MCP_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const

const MCP_DOCUMENT_MIME_TYPE_SET = new Set<string>(MCP_DOCUMENT_MIME_TYPES)

function resolveMcpDocumentMimeType(fileName: string, requestedMimeType: unknown): string {
  let mimeType = typeof requestedMimeType === 'string' ? requestedMimeType : undefined
  if (!mimeType) {
    const extension = fileName.split('.').pop()?.toLowerCase()
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      heic: 'image/heic',
      webp: 'image/webp',
    }
    mimeType = extension ? mimeMap[extension] : undefined
    if (!mimeType) throw new Error(`Cannot infer MIME type from extension: .${extension}`)
  }
  if (!MCP_DOCUMENT_MIME_TYPE_SET.has(mimeType)) {
    throw new Error(`Unsupported file type: ${mimeType}. Allowed: PDF, JPEG, PNG, HEIC, WebP`)
  }
  return mimeType
}

interface DocumentInboxResult {
  document_id: string
  inbox_item_id: string
  status: string
  extracted_data: Record<string, unknown>
  matched_supplier_id: string | null
}

async function findCompletedDocumentInboxItem(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  inboxItemId: string
): Promise<DocumentInboxResult | null> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, status, extracted_data, matched_supplier_id')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`Failed to check completed document upload: ${error.message}`)
  if (!data) return null
  if (data.document_id !== inboxItemId) {
    throw new Error('Upload ID collides with an unrelated inbox item')
  }
  return {
    document_id: data.document_id,
    inbox_item_id: data.id,
    status: data.status,
    extracted_data: (data.extracted_data ?? {}) as Record<string, unknown>,
    matched_supplier_id: data.matched_supplier_id,
  }
}

async function createDocumentInboxItem(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  documentId: string,
  fileName: string,
  mimeType: string,
  buffer: Buffer,
  reservedInboxItemId?: string
): Promise<DocumentInboxResult> {
  if (reservedInboxItemId) {
    const existing = await findCompletedDocumentInboxItem(
      supabase,
      companyId,
      userId,
      reservedInboxItemId,
    )
    if (existing) return existing
  }

  // No server-side extraction in this fork: the item lands with empty
  // extracted_data and the agent fills it via gnubok_set_inbox_extracted_data.
  const extracted: Record<string, unknown> = {}
  const matchedSupplierId: string | null = null

  const { data: inbox, error: inboxError } = await supabase
    .from('invoice_inbox_items')
    .insert({
      // Literal payload keeps the no-phantom-columns scanner able to resolve
      // every column; the legacy path gets an explicit UUID instead of the DB
      // default.
      id: reservedInboxItemId ?? crypto.randomUUID(),
      company_id: companyId,
      user_id: userId,
      status: 'received',
      source: 'upload',
      document_id: documentId,
      extracted_data: extracted as unknown as Record<string, unknown>,
      matched_supplier_id: matchedSupplierId,
    })
    .select('id, status')
    .single()

  if (inboxError) {
    if (reservedInboxItemId) {
      const concurrent = await findCompletedDocumentInboxItem(
        supabase,
        companyId,
        userId,
        reservedInboxItemId,
      )
      if (concurrent) return concurrent
    }
    throw new Error(`Failed to create inbox item: ${inboxError.message}`)
  }

  return {
    document_id: documentId,
    inbox_item_id: inbox.id,
    status: inbox.status,
    extracted_data: extracted as unknown as Record<string, unknown>,
    matched_supplier_id: matchedSupplierId,
  }
}

// ── Pending operations staging ───────────────────────────────

/**
 * Param-keys we'll scan for an affärshändelse date when the caller doesn't
 * pass `dateForPeriodCheck` explicitly. Ordered: most-specific first. The
 * first ISO yyyy-MM-dd hit wins. Adding a new field is safe: unknown values
 * just fall through to undefined.
 */
const AUTO_PERIOD_DATE_KEYS = [
  'entry_date',
  'payment_date',
  'invoice_date',
  'date',
  'period_end',
  'period_start',
  'voucher_date',
  'paid_date',
  'transfer_date',
] as const

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function autoExtractDateForPeriodCheck(params: Record<string, unknown>): string | undefined {
  for (const key of AUTO_PERIOD_DATE_KEYS) {
    const value = params[key]
    if (typeof value === 'string' && ISO_DATE_RE.test(value)) return value
  }
  return undefined
}

interface StageOptions {
  /**
   * When true, validate inputs and return the would-be preview without
   * inserting into pending_operations or executing any side-effects. Used
   * by agents to preflight an operation before committing to it.
   */
  dryRun?: boolean
  /**
   * Per-operation idempotency key. When supplied, repeat calls with the same
   * key + same payload return the original response and never re-execute.
   * Different payload + same key returns IDEMPOTENCY_KEY_REUSE.
   */
  idempotencyKey?: string
  /**
   * ISO yyyy-MM-dd date used to look up period_status before staging. When
   * provided, the response includes a `period_status` envelope so agents and
   * widgets can detect locked/closed periods without a round-trip. Failure to
   * resolve (DB blip, missing settings row) leaves the response unchanged:
   * the DB triggers remain the authoritative gate.
   */
  dateForPeriodCheck?: string
}

function buildApprovalGuidance(operationId: string, riskLevel: 'low' | 'medium' | 'high'): string {
  if (riskLevel === 'high') {
    return `This is an irreversible posting under BFL 5 kap 5§: surface the irreversibility implications to the user and obtain an explicit acknowledgment before committing. Once the user has acknowledged, call gnubok_approve_pending_operation with operation_id="${operationId}" and confirmed=true.`
  }
  return `When the user authorises, call gnubok_approve_pending_operation with operation_id="${operationId}".`
}

async function stagePendingOperation(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  operationType: string,
  title: string,
  params: Record<string, unknown>,
  previewData: Record<string, unknown>,
  actor: ActorContext = { type: 'user' },
  next?: NextActionHint,
  options: StageOptions = {}
): Promise<{
  staged: boolean
  dry_run?: boolean
  idempotency_replay?: boolean
  operation_id?: string
  risk_level: 'low' | 'medium' | 'high'
  actor: ActorContext
  message: string
  approve?: { tool: string; args: Record<string, unknown> }
  preview: Record<string, unknown>
  period_status?: PeriodStatusForDate
  next?: NextActionHint
}> {
  // PII chokepoint (ISO 27001 A.8.11): no staged payload may persist a
  // plaintext personnummer. Enforced here so every current and future
  // staging tool inherits the rule, not just the ones that remembered it.
  assertNoPlaintextPersonnummer(params, 'params')
  assertNoPlaintextPersonnummer(previewData, 'preview_data')

  // params-aware: create/update_recurring_schedule escalate to 'high' when
  // params.auto_send === true (standing outbound email with no per-send
  // approval, same side-effect that puts one-off send_invoice at 'high').
  // Ops whose persisted params nest the effective fields under `changes`
  // (update_recurring_schedule: { schedule_id, changes }) are flattened for
  // the risk check ONLY, so paramEscalatedRisk sees auto_send; the stored
  // params row is untouched (the commit executor's schema owns that shape).
  const changesBag = params.changes
  const riskParams =
    changesBag && typeof changesBag === 'object' && !Array.isArray(changesBag)
      ? { ...params, ...(changesBag as Record<string, unknown>) }
      : params
  const riskLevel = getRiskLevel(operationType, riskParams)
  const branding = getBranding().appName.toLowerCase()

  // Resolve period_status once. The caller can pass `dateForPeriodCheck`
  // explicitly; otherwise we scan params for a known affärshändelse-date
  // field so every date-bearing operation surfaces a period_status envelope
  // without each tool having to opt in. Failure is non-fatal: DB triggers
  // are the authoritative gate; a missing envelope just degrades preview UX.
  const dateForPeriodCheck = options.dateForPeriodCheck ?? autoExtractDateForPeriodCheck(params)
  let periodStatus: PeriodStatusForDate | undefined
  if (dateForPeriodCheck) {
    try {
      periodStatus = await resolvePeriodStatusForDate(supabase, companyId, dateForPeriodCheck)
    } catch (err) {
      log.warn('resolvePeriodStatusForDate failed', {
        operationType,
        companyId,
        dateForPeriodCheck,
        error: err instanceof Error ? err.message : String(err),
      })
      periodStatus = undefined
    }
  }

  // ── Dry-run path: skip both the cache and the insert. Return the preview
  //    so the agent sees exactly what would happen without committing.
  if (options.dryRun) {
    return {
      staged: false,
      dry_run: true,
      risk_level: riskLevel,
      actor,
      message: `Dry run: would stage "${operationType}" (risk: ${riskLevel}). No changes made.`,
      preview: previewData,
      ...(periodStatus ? { period_status: periodStatus } : {}),
      ...(next ? { next: addCompanyToNextHint(next, companyId) as NextActionHint } : {}),
    }
  }

  // ── Idempotency check: same key + same payload + same company → return
  //    cached response. companyId is folded into the canonical hash so the
  //    same key UUID submitted under a different company is treated as a
  //    fresh request, not a replay.
  const requestHash = options.idempotencyKey
    ? hashRequest({ operationType, params, companyId })
    : null
  if (options.idempotencyKey && requestHash) {
    const cached = await checkIdempotencyKey(supabase, userId, companyId, options.idempotencyKey, requestHash)
    if (cached) {
      const cachedBody = cached.body as Record<string, unknown>
      const cachedOpId = typeof cachedBody.operation_id === 'string' ? cachedBody.operation_id : undefined
      return {
        ...cachedBody,
        idempotency_replay: true,
        risk_level: riskLevel,
        actor,
        message: cachedOpId
          ? `Replayed cached response for idempotency_key "${options.idempotencyKey}": already staged as pending_operation ${cachedOpId}. No new side-effects. ${buildApprovalGuidance(cachedOpId, riskLevel)}`
          : `Replayed cached response for idempotency_key "${options.idempotencyKey}". No new side-effects.`,
        ...(cachedOpId
          ? {
              approve: {
                tool: 'gnubok_approve_pending_operation',
                args: { operation_id: cachedOpId, company_id: companyId },
              },
            }
          : {}),
        preview: periodStatus ? { ...previewData, period_status: periodStatus } : previewData,
        ...(periodStatus ? { period_status: periodStatus } : {}),
      } as Awaited<ReturnType<typeof stagePendingOperation>>
    }
  }

  const { data, error } = await supabase
    .from('pending_operations')
    .insert({
      company_id: companyId,
      user_id: userId,
      operation_type: operationType,
      title,
      params,
      preview_data: previewData,
      actor_type: actor.type,
      actor_id: actor.id ?? null,
      actor_label: actor.label ?? null,
      risk_level: riskLevel,
    })
    .select('*')
    .single()

  if (error) throw new Error(`Failed to stage operation: ${error.message}`)

  // approve.args carries only the operation_id. For high-risk operations the
  // LLM must supply confirmed=true itself after surfacing the BFL 5 kap 5§
  // irreversibility implications to the user: pre-filling it server-side
  // would collapse the explicit-acknowledgment gate (mirrors the web UI's
  // warning dialog). The server-side check in gnubok_approve_pending_operation
  // remains authoritative.
  const response = {
    staged: true,
    operation_id: data.id,
    risk_level: riskLevel,
    actor,
    message: `Staged as pending_operation ${data.id} (risk: ${riskLevel}). ${buildApprovalGuidance(data.id, riskLevel)} The user can also approve at /pending in the ${branding} web app.`,
    approve: {
      tool: 'gnubok_approve_pending_operation',
      args: { operation_id: data.id, company_id: companyId } as Record<string, unknown>,
    },
    preview: periodStatus ? { ...previewData, period_status: periodStatus } : previewData,
    ...(periodStatus ? { period_status: periodStatus } : {}),
    ...(next ? { next: addCompanyToNextHint(next, companyId) as NextActionHint } : {}),
  } as const

  if (options.idempotencyKey && requestHash) {
    await storeIdempotencyResponse(
      supabase, userId, companyId, options.idempotencyKey, requestHash,
      'success', { staged: true, operation_id: data.id, preview: previewData }
    )
  }
  return response
}

// ── Journal entry reference resolution ────────────────────────

/**
 * Resolve a journal entry reference to a journal_entries.id UUID.
 *
 * Accepts either a raw UUID (returned as-is) or a voucher reference like
 * "A-113" / "A113" / "A/113" (resolved by voucher_series + voucher_number
 * scoped to the company).
 *
 * Voucher refs are the preferred input shape for LLM-driven callers: short,
 * semantically meaningful, and resistant to UUID hallucination: a failure
 * mode where the agent reproduces the first 8 hex chars correctly but
 * fabricates the remaining 24, so a downstream lookup rejects the ID even
 * though the entry exists.
 */
async function resolveJournalEntryRef(
  supabase: SupabaseClient,
  companyId: string,
  ref: string
): Promise<string> {
  const trimmed = ref.trim()

  // UUIDs pass through. If the UUID was hallucinated, the caller's own
  // lookup surfaces the "not found" diagnostic with the supplied value.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed
  }

  // Voucher ref: letters (series) + optional separator + digits (number).
  const match = trimmed.match(/^([A-Za-z]+)\s*[-:/ ]?\s*(\d+)$/)
  if (!match) {
    throw new Error(
      `Could not parse entry reference "${ref}". Expected a UUID or a voucher ref like "A-113".`
    )
  }
  const series = match[1].toUpperCase()
  const number = parseInt(match[2], 10)

  const { data, error } = await supabase
    .from('journal_entries')
    .select('id, entry_date, description')
    .eq('company_id', companyId)
    .eq('voucher_series', series)
    .eq('voucher_number', number)
    .order('entry_date', { ascending: false })

  if (error) {
    throw new Error(`Database error resolving voucher "${series}-${number}": ${error.message}`)
  }

  const matches = (data ?? []) as Array<{ id: string; entry_date: string; description: string }>

  if (matches.length === 0) {
    throw new Error(
      `No journal entry found for voucher "${series}-${number}" in this company. ` +
      `Verify the series and number, or supply the full UUID.`
    )
  }

  // Voucher numbers reset per fiscal period. The same (series, number) pair
  // can therefore appear in multiple years: refuse to guess.
  if (matches.length > 1) {
    const summary = matches
      .map((m) => `${m.entry_date} "${m.description}" (id=${m.id})`)
      .join('; ')
    throw new Error(
      `Voucher "${series}-${number}" matches multiple entries across fiscal periods: ${summary}. ` +
      `Supply the specific UUID instead.`
    )
  }

  return matches[0].id
}

// ── Lock-period staging guard ────────────────────────────────────────────────
//
// The staging pre-check runs the exact same countUnbookedInPeriod the commit
// path (lockPeriod) enforces, imported from period-service so the two legal
// guards cannot drift apart. See the DECISIONS.md 2026-07-26 lock-guard entry
// for the predicate semantics.

// ── Output schema helpers ────────────────────────────────────

const PAGINATION_PROPS = {
  count: { type: 'number', description: 'Number of items in this page' },
  total_count: { type: 'number', description: 'Total matching across all pages' },
  has_more: { type: 'boolean' },
  next_offset: { type: 'number', description: 'Offset for the next page (omitted on last page)' },
} as const

const NEXT_ACTION_HINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'object', additionalProperties: true },
    resource: { type: 'string' },
  },
  required: ['description'],
} as const

const STAGED_OPERATION_SCHEMA = {
  type: 'object',
  properties: {
    staged: { type: 'boolean' },
    operation_id: { type: 'string', description: 'UUID of the staged operation, present once persisted' },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
    actor: { type: 'object' },
    dry_run: { type: 'boolean' },
    idempotency_replay: { type: 'boolean' },
    message: { type: 'string' },
    approve: { type: 'object' },
    preview: { type: 'object' },
    period_status: {
      type: 'object',
      description: 'Fiscal period covering the affärshändelse date. Use to detect locked/closed periods without a round-trip.',
      properties: {
        period_id: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['open', 'locked', 'closed'] },
        lock_date: { type: ['string', 'null'] },
      },
    },
    next: NEXT_ACTION_HINT_SCHEMA,
  },
  required: ['staged', 'risk_level', 'actor', 'message', 'preview'],
} as const

/**
 * Staging writes that have a read-only pre-flight an agent should run first.
 * Surfaced as `_meta.preflight` in tools/list so the preview/validate step is
 * discoverable from the staging tool itself, not just from prose. Keep entries
 * to genuine pre-flights (a tool that returns a verdict/proposal before the
 * irreversible write), not recovery/undo tools.
 */
const TOOL_PREFLIGHT_MAP: Record<string, string> = {
  gnubok_run_year_end: 'gnubok_year_end_readiness',
  gnubok_post_annual_depreciation: 'gnubok_propose_annual_depreciation',
}

/**
 * Discovery-time metadata derived from a tool definition, surfaced under `_meta`
 * in tools/list (and gnubok_search_tools detail=full). Lets an agent tell
 * (WITHOUT reading prose) whether a write stages for approval and whether a
 * pre-flight exists. `requires_approval` keys off the staged-operation output
 * schema, the single source of truth for "this write produces a
 * pending_operation you must commit via approve_tool". Returns undefined for
 * tools with no staging contract (reads, direct-commit approve/reject) so we
 * don't bloat the catalog with empty objects.
 */
export function deriveToolMeta(t: { name: string; outputSchema?: Record<string, unknown> }): Record<string, unknown> | undefined {
  if (t.outputSchema !== STAGED_OPERATION_SCHEMA) return undefined
  const preflight = TOOL_PREFLIGHT_MAP[t.name]
  return {
    requires_approval: true,
    approve_tool: 'gnubok_approve_pending_operation',
    ...(preflight ? { preflight } : {}),
  }
}

export function isDefaultCatalogTool(tool: { catalogVisibility?: 'default' | 'search' }): boolean {
  return tool.catalogVisibility !== 'search'
}

function paginatedSchema(itemsKey: string, itemSchema: Record<string, unknown> = { type: 'object' }) {
  return {
    type: 'object',
    properties: {
      [itemsKey]: { type: 'array', items: itemSchema },
      ...PAGINATION_PROPS,
    },
    required: [itemsKey, 'count', 'total_count', 'has_more'],
  } as const
}

const VAT_REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    period: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'] },
        year: { type: 'number' },
        period: { type: 'number' },
        start: { type: 'string', description: 'Period start date (YYYY-MM-DD)' },
        end: { type: 'string', description: 'Period end date (YYYY-MM-DD)' },
      },
      required: ['type', 'year', 'period', 'start', 'end'],
    },
    period_label: { type: 'string', description: 'Human-readable period label (e.g. "Q1 2026")' },
    rutor: {
      type: 'object',
      description: 'SKV 4700 momsdeklaration boxes: absolute values, signs implied by box semantics',
      properties: {
        ruta05: { type: 'number', description: 'Total domestic taxable sales (all rates)' },
        ruta10: { type: 'number', description: 'Output VAT 25 % (account 2611)' },
        ruta11: { type: 'number', description: 'Output VAT 12 % (account 2621)' },
        ruta12: { type: 'number', description: 'Output VAT 6 % (account 2631)' },
        ruta30: { type: 'number', description: 'Reverse-charge output VAT 25 % (account 2614)' },
        ruta31: { type: 'number', description: 'Reverse-charge output VAT 12 % (account 2624)' },
        ruta32: { type: 'number', description: 'Reverse-charge output VAT 6 % (account 2634)' },
        ruta35: { type: 'number', description: 'EU intra-community goods supplies, momsfri (account 3108)' },
        ruta39: { type: 'number', description: 'EU services sold (account 3308)' },
        ruta40: { type: 'number', description: 'Export outside EU (account 3305)' },
        ruta48: { type: 'number', description: 'Total input VAT (2641 + 2645 + 2647)' },
        ruta49: {
          type: 'number',
          description: 'VAT to pay (positive) or refund (negative) = (10+11+12+30+31+32+60+61+62) − 48',
        },
        ruta60: { type: 'number', description: 'Import VAT 25 % (account 2615): non-EU import declared via momsdeklaration' },
        ruta61: { type: 'number', description: 'Import VAT 12 % (account 2625)' },
        ruta62: { type: 'number', description: 'Import VAT 6 % (account 2635)' },
      },
      required: ['ruta05', 'ruta10', 'ruta11', 'ruta12', 'ruta30', 'ruta31', 'ruta32', 'ruta35', 'ruta39', 'ruta40', 'ruta48', 'ruta49', 'ruta60', 'ruta61', 'ruta62'],
    },
    summary: { type: 'string', description: 'One-line Swedish summary string (att betala / att få tillbaka / noll)' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Pre-filing warnings (e.g. one-sided reverse charge). Empty when none.',
    },
  },
  required: ['period', 'period_label', 'rutor', 'summary', 'warnings'],
} as const

// ── Skatteverket filing read-tool output schemas (PR5) ──
// Kept shallow (opaque object/null sub-objects) to stay within the tools/list
// payload budget; the SKV response shapes live in the extension types.
const SKV_VAT_VALIDATE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    redovisare: { type: 'string', description: '12-digit redovisare' },
    redovisningsperiod: { type: 'string', description: 'YYYYMM' },
    momsuppgift: { type: 'object', description: 'The momsuppgift payload sent to Skatteverket' },
    kontrollresultat: { type: 'object', description: 'Skatteverket kontrollresultat (status + per-ruta fel/varningar)' },
    arithmetic_ok: {
      type: 'boolean',
      description: 'Skatteverket found no ERROR: the payload adds up. Says NOTHING about whether the underlag is complete.',
    },
    completeness_ok: {
      type: 'boolean',
      description: 'Local pre-flight found no ERROR. False = materially incomplete (e.g. FK004) even when arithmetic_ok is true.',
    },
    completeness_checks: {
      type: 'array',
      items: { type: 'object' },
      description: 'Local findings: { code, status (ERROR|WARNING), message (Swedish), rutor }.',
    },
    summary: { type: 'string', description: 'One-line Swedish verdict for both results.' },
  },
  required: [
    'redovisare', 'redovisningsperiod', 'momsuppgift', 'kontrollresultat',
    'arithmetic_ok', 'completeness_ok', 'completeness_checks', 'summary',
  ],
} as const

const SKV_VAT_STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    redovisare: { type: 'string', description: '12-digit redovisare' },
    redovisningsperiod: { type: 'string', description: 'YYYYMM' },
    submitted: { type: ['object', 'null'], description: 'Inlämnad deklaration, or null if none on file' },
    decided: { type: ['object', 'null'], description: 'Beslutad deklaration, or null if not yet decided' },
  },
  required: ['redovisare', 'redovisningsperiod', 'submitted', 'decided'],
} as const

// ── VAT report computation (shared by gnubok_get_vat_report + gnubok_vat_review_widget) ──
//
// Maps posted journal entry lines to SKV 4700 rutor. ruta49 covers domestic
// output VAT (10/11/12) AND reverse-charge output VAT (30/31/32) per
// ML 2023:200: both must be displayed and netted against ruta48 (input VAT).
//
// Account → ruta map:
//   3001-3008, 3041-3048, 3051-3058, 3071-3078 → ruta05  (all domestic taxable sales, common BAS revenue accounts)
//   2611           → ruta10  (output VAT 25%)
//   2621           → ruta11  (output VAT 12%)
//   2631           → ruta12  (output VAT 6%)
//   2614           → ruta30  (reverse-charge output VAT 25%)
//   2624           → ruta31  (reverse-charge output VAT 12%)
//   2634           → ruta32  (reverse-charge output VAT 6%)
//   3308           → ruta39  (EU services sold)
//   3305           → ruta40  (export outside EU)
//   2641/2645/2647 → ruta48  (all input VAT)
//
// Posted+reversed status filter: a "reversed" original entry is still part of
// its period's books: Skatteverket files VAT period-by-period under
// faktureringsmetoden (sale's VAT in invoice-date period; kreditfaktura's
// reduction in storno-date period). The original entry stays in its period;
// the storno (status 'posted', dated when the credit was issued) lands in
// its own period. The two periods file independently; across a year they
// arithmetically cancel. *Excluding* 'reversed' would under-report Period N
// (the original sale's VAT silently disappears) and over-credit Period N+M
// (a reversal with no original), incorrect per ML 2023:200.

/** Common BAS taxable-revenue accounts that contribute to ruta 05.
 *
 *  Conservative expansion beyond 3001/3002/3003. Excludes 3004 (momsfri,
 *  exempt) and 3108/3305/3308 (handled by ruta35/40/39). 3106 covers the
 *  rare case of taxable EU goods (momspliktig EU-leverans, e.g. when the
 *  buyer's VAT number is invalid).
 *
 *  This hand-maintained widening predates #1261 and is kept so no company
 *  loses a figure it already saw. It is no longer the only path: a company's
 *  own class 3 konto marked with a moms-sats is resolved at runtime by
 *  fetchDynamicRuta05Accounts and unioned in below, which is what actually
 *  covers non-standard charts (Accounted's BAS chart ships no varugrupp
 *  accounts at all). */
const RUTA_05_ACCOUNTS = [
  // The 30xx gruppkonto. ACCOUNT_RUTA maps it to ruta05, so leaving it out here
  // made a balance on 3000 appear in the filed projection but not in
  // report.rutor.ruta05.
  '3000',
  // Domestic sales by VAT rate (canonical BAS)
  '3001', '3002', '3003', '3005', '3006', '3007', '3008',
  // Taxable EU goods (momspliktig, buyer's VAT number invalid or buyer is private)
  '3106',
  // Domestic services (alternative numbering some companies use)
  '3041', '3042', '3043', '3044', '3045', '3046', '3047', '3048',
  // Domestic goods (alternative numbering)
  '3051', '3052', '3053', '3054', '3055', '3056', '3057', '3058',
  // Other domestic taxable
  '3071', '3072', '3073', '3074', '3075', '3076', '3077', '3078',
] as const

export interface VatReportResult {
  period: { type: string; year: number; period: number; start: string; end: string }
  period_label: string
  rutor: {
    ruta05: number; ruta10: number; ruta11: number; ruta12: number
    ruta30: number; ruta31: number; ruta32: number
    ruta35: number; ruta39: number; ruta40: number
    ruta48: number; ruta49: number
    // Import VAT (post-2015 momsdeklaration path, accounts 2615/2625/2635).
    // Buyer/importer self-assesses output VAT here and deducts the matching
    // input via ruta 48: same mechanic as ruta 30/31/32.
    ruta60: number; ruta61: number; ruta62: number
  }
  summary: string
  warnings: string[]
}

export interface VatReportWithRutor {
  report: VatReportResult
  /**
   * The FULL SKV 4700 projection of the same ledger aggregate, via core's
   * `rutorFromTotals`. `report.rutor` is the trimmed agent-facing view: it has
   * no rutor 20-24 (beskattningsunderlag vid omvänd skattskyldighet) and no
   * ruta 50 (underlag vid import), which are exactly the boxes the
   * completeness checks in lib/reports/vat-declaration-checks.ts compare
   * against rutor 30-32 / 60-62.
   *
   * The two also differ on ruta 05 by design: `report.rutor.ruta05` sums the
   * widened RUTA_05_ACCOUNTS list for display, while this one is the canonical
   * ACCOUNT_RUTA projection, i.e. what would actually be filed. Checks run on
   * the filed shape, never on the display shape. The company's own ruta 05
   * accounts feed BOTH: they are part of the filing, not a display widening.
   */
  declarationRutor: VatDeclarationRutor
  /**
   * The per-account debit/credit totals both projections above are built from,
   * exactly the shape `runVatDeclarationChecks` takes as its optional second
   * argument. Threaded through so the completeness checks compare rutor 30-32
   * against the reverse-charge INPUT accounts (2645/2647) rather than the ruta
   * 48 aggregate, which ordinary debiterad ingående moms on 2641 masks. Internal
   * to the server: no tool puts this map on the wire.
   */
  accountTotals: VatCheckAccountTotals
}

/**
 * Agent-facing VAT report. Thin wrapper over {@link computeVatReportWithRutor}
 * so callers that only need the report keep the old signature.
 */
export async function computeVatReport(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatReportResult> {
  const { report } = await computeVatReportWithRutor(args, companyId, supabase)
  return report
}

export async function computeVatReportWithRutor(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatReportWithRutor> {
  const periodType = args.period_type as string
  const year = Number(args.year)
  const period = Number(args.period)

  if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
    throw new Error('period_type must be: monthly, quarterly, yearly')
  }
  if (!year || year < 2000 || year > 2100) throw new Error('year must be between 2000 and 2100')
  if (periodType === 'monthly' && (period < 1 || period > 12)) throw new Error('period must be 1-12 for monthly')
  if (periodType === 'quarterly' && (period < 1 || period > 4)) throw new Error('period must be 1-4 for quarterly')

  let startDate: string
  let endDate: string

  if (periodType === 'monthly') {
    startDate = `${year}-${String(period).padStart(2, '0')}-01`
    const lastDay = new Date(year, period, 0).getDate()
    endDate = `${year}-${String(period).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  } else if (periodType === 'quarterly') {
    const startMonth = (period - 1) * 3 + 1
    const endMonth = period * 3
    startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`
    const lastDay = new Date(year, endMonth, 0).getDate()
    endDate = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  } else {
    startDate = `${year}-01-01`
    endDate = `${year}-12-31`
  }

  // Two-step fetch (lib/bookkeeping/entry-lines.ts) rather than a
  // `journal_entries!inner` embed: PostgREST compiles that embed into a
  // correlated LATERAL join that walks every tenant's journal_entry_lines.
  // Both steps paginate, so a yearly (or busy quarterly) VAT period with
  // >1000 entry lines is no longer silently truncated at PostgREST's
  // 1000-row default.
  // The helper reattaches the parent entry as an OBJECT under
  // `journal_entries`, so the old "embed may be an object or an array" shape
  // guard is gone with the embed.
  const lines = await fetchEntryLines<{
    journal_entry_id: string
    account_number: string
    debit_amount: number
    credit_amount: number
    journal_entries?: { source_type: string | null }
  }>({
    supabase,
    entryColumns: 'entry_date, status, user_id, source_type',
    lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .in('status', ['posted', 'reversed'])
        // Momsredovisning entries (the settlement verifikat clearing 26xx to
        // 2650/1650) would zero the rutor once booked; exclude them so this
        // report matches lib/reports/vat-declaration.ts (fetchVatAccountTotals).
        .neq('source_type', 'vat_settlement')
        .gte('entry_date', startDate)
        .lte('entry_date', endDate),
  })

  // Settlements booked WITHOUT the vat_settlement tag (manual momsomföring,
  // SIE-imported settlements, stornos of a settlement) are excluded by shape,
  // mirroring fetchVatAccountTotals (#984): an entry touching both a
  // declaration account (ACCOUNT_RUTA) and a settlement net account
  // (2650/1650) is a momsredovisning, not VAT-bearing activity. Opening
  // balances are exempt: carried-in 26xx balances are unsettled VAT that
  // belongs in the next declaration.
  const declarationEntryIds = new Set<string>()
  const netEntryIds = new Set<string>()
  for (const line of lines) {
    if (ACCOUNT_RUTA[line.account_number]) declarationEntryIds.add(line.journal_entry_id)
    else if (VAT_SETTLEMENT_NET_ACCOUNTS.includes(line.account_number)) {
      netEntryIds.add(line.journal_entry_id)
    }
  }
  const settlementShapedIds = new Set<string>()
  for (const line of lines) {
    const id = line.journal_entry_id
    if (!declarationEntryIds.has(id) || !netEntryIds.has(id)) continue
    const entry = line.journal_entries
    if (!entry || entry.source_type === 'opening_balance') continue
    settlementShapedIds.add(id)
  }

  const accountTotals = new Map<string, { debit: number; credit: number }>()
  for (const line of lines) {
    if (settlementShapedIds.has(line.journal_entry_id)) continue
    const acc = line.account_number
    const existing = accountTotals.get(acc) ?? { debit: 0, credit: 0 }
    existing.debit += Number(line.debit_amount) || 0
    existing.credit += Number(line.credit_amount) || 0
    accountTotals.set(acc, existing)
  }

  function creditBalance(acc: string): number {
    const t = accountTotals.get(acc)
    return t ? Math.round((t.credit - t.debit) * 100) / 100 : 0
  }

  function debitBalance(acc: string): number {
    const t = accountTotals.get(acc)
    return t ? Math.round((t.debit - t.credit) * 100) / 100 : 0
  }

  // The company's own momspliktiga intäktskonton join the hand-maintained list.
  // Deduped: an account can appear in both (e.g. 3041 with a moms-sats set),
  // and counting it twice would inflate ruta 05.
  const dynamicRuta05 = await fetchDynamicRuta05Accounts(supabase, companyId)
  const ruta05Accounts = [...new Set([...RUTA_05_ACCOUNTS, ...dynamicRuta05.accounts])]
  const ruta05 = ruta05Accounts.reduce((sum, acc) => sum + creditBalance(acc), 0)
  const ruta10 = creditBalance('2611')
  const ruta11 = creditBalance('2621')
  const ruta12 = creditBalance('2631')
  const ruta30 = creditBalance('2614')
  const ruta31 = creditBalance('2624')
  const ruta32 = creditBalance('2634')
  const ruta35 = creditBalance('3108')   // EU intra-community goods supplies (momsfri leverans till EU)
  const ruta39 = creditBalance('3308')
  const ruta40 = creditBalance('3305')
  // Import VAT (since 2015 declared via momsdeklaration, not Tullverket): the
  // importer books output VAT to 2615/2625/2635 (ruta 60/61/62) and the
  // matching deductible input to 2645 (rolls into ruta 48 below).
  const ruta60 = creditBalance('2615')
  const ruta61 = creditBalance('2625')
  const ruta62 = creditBalance('2635')
  const calculatedInput2645 = debitBalance('2645')
  const calculatedInput2647 = debitBalance('2647')
  const ruta48 = debitBalance('2641') + calculatedInput2645 + calculatedInput2647
  const ruta49 = Math.round(
    (ruta10 + ruta11 + ruta12 + ruta30 + ruta31 + ruta32 + ruta60 + ruta61 + ruta62 - ruta48) * 100
  ) / 100

  const monthNames = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
    'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December']

  let periodLabel: string
  if (periodType === 'monthly') periodLabel = `${monthNames[period - 1]} ${year}`
  else if (periodType === 'quarterly') periodLabel = `Q${period} ${year}`
  else periodLabel = `${year}`

  // Pre-filing warnings: surface common compliance footguns.
  //
  // The matching input for reverse-charge output (2614/2624/2634) lands on
  // 2645 (EU acquisitions) or 2647 (domestic reverse charge per ML 16:13,
  // byggtjänster, electronics > 100k SEK, etc.). Either is a valid mirror;
  // the warning must fire only when *both* are zero.
  const warnings: string[] = []
  const totalReverseChargeOutput = ruta30 + ruta31 + ruta32
  const totalReverseChargeInput = calculatedInput2645 + calculatedInput2647
  if (totalReverseChargeOutput > 0 && totalReverseChargeInput === 0) {
    warnings.push(
      'Omvänd betalningsskyldighet: utgående moms har bokförts (rutor 30/31/32) men ingen ' +
      'beräknad ingående moms (varken 2645 EU eller 2647 inhemsk). Kontrollera att den ' +
      'motsvarande ingående bokningen finns: båda sidor krävs enligt ML 2023:200.'
    )
  }

  const report: VatReportResult = {
    period: { type: periodType, year, period, start: startDate, end: endDate },
    period_label: periodLabel,
    rutor: {
      ruta05: Math.abs(ruta05),
      ruta10: Math.abs(ruta10),
      ruta11: Math.abs(ruta11),
      ruta12: Math.abs(ruta12),
      ruta30: Math.abs(ruta30),
      ruta31: Math.abs(ruta31),
      ruta32: Math.abs(ruta32),
      ruta35: Math.abs(ruta35),
      ruta39: Math.abs(ruta39),
      ruta40: Math.abs(ruta40),
      ruta48: Math.abs(ruta48),
      ruta49,
      ruta60: Math.abs(ruta60),
      ruta61: Math.abs(ruta61),
      ruta62: Math.abs(ruta62),
    },
    summary: ruta49 > 0
      ? `Moms att betala: ${Math.abs(ruta49).toFixed(2)} kr`
      : ruta49 < 0
        ? `Moms att få tillbaka: ${Math.abs(ruta49).toFixed(2)} kr`
        : 'Noll i moms',
    warnings,
  }

  // Same `accountTotals` the report is built from, projected through core's
  // ACCOUNT_RUTA map so the completeness checks see the full declaration
  // (incl. rutor 20-24 and 50) instead of the trimmed report view.
  return {
    report,
    declarationRutor: rutorFromTotals(accountTotals, dynamicRuta05.accounts),
    accountTotals,
  }
}

/**
 * Momsdeklaration completeness pre-flight for gnubok_vat_close_check.
 *
 * Runs core's `runVatDeclarationChecks` (period aggregates, proportional) and
 * folds in the per-verifikat FK004 scan through the SAME gate helper the web
 * UI's "Kontroll av underlaget" banner and its Skicka button read
 * (lib/reports/vat-filing-gate.ts). One check list, one verdict: the MCP
 * surface can no longer give a green light the UI would refuse.
 *
 * The per-verifikat scan is allowed to degrade: a failure becomes
 * `{ status: 'unavailable' }`, which the gate turns into an explicit WARNING
 * finding rather than silence, because an empty list reads as "no problems"
 * and that claim is not earned when the scan never answered.
 *
 * `accountTotals` is the per-account debit/credit aggregate the rutor were
 * projected from. Passing it switches RC_INPUT_VAT_MISMATCH from the ruta 48
 * aggregate to the reverse-charge input accounts (2645/2647). Both call sites
 * have it in hand, so both pass it; the parameter stays optional only because
 * the check itself degrades gracefully without it.
 */
async function runVatCompletenessChecks(
  supabase: SupabaseClient,
  companyId: string,
  rutor: VatDeclarationRutor,
  periodType: VatPeriodType,
  year: number,
  period: number,
  accountTotals?: VatCheckAccountTotals,
): Promise<VatDeclarationCheck[]> {
  let scan: RcBasisGapScan
  try {
    const gaps = await findRcBasisGaps(supabase, companyId, periodType, year, period)
    scan = { status: 'scanned', gapCount: gaps.length }
  } catch {
    scan = { status: 'unavailable' }
  }
  // Downgrade evidence (per-momssats 44xx/45xx balances) only exists when the
  // caller supplied the account totals; without them the per-voucher gaps
  // keep their blocking ERROR tier rather than guessing.
  const evidence = accountTotals
    ? { rutor, rcBasisByRate: rcBasisTotalsByRate(accountTotals) }
    : undefined
  return withRcBasisGapFindings(runVatDeclarationChecks(rutor, accountTotals), scan, evidence)
}

/** Wire shape for a completeness finding on the MCP surface. */
interface VatCompletenessFinding {
  code: VatDeclarationCheck['code']
  status: VatDeclarationCheckStatus
  message: string
  rutor: string[]
}

/**
 * Serialize findings for an agent. Unlike the web UI (which deliberately hides
 * the rule ids as visual noise, DECISIONS 2026-07-24), the machine surface
 * carries `code`: an agent needs a stable key to branch on, not prose.
 */
function toCompletenessFindings(checks: VatDeclarationCheck[]): VatCompletenessFinding[] {
  return checks.map((c) => ({
    code: c.code,
    status: c.status,
    message: c.message,
    rutor: (c.rutor ?? []) as string[],
  }))
}

// ── VAT close check (composes VAT report + blocker scans + sanity ratios) ──
//
// Intent-shaped tool: answers "can I close VAT for this period?" in one call.
// Replaces the 5-7 chained tool calls (vat_report + uncategorized + supplier
// invoices + reconciliation + voucher gaps + prior-period compare) the agent
// would otherwise need to assemble the same answer.

interface VatCloseBlocker {
  kind:
    | 'unapproved_supplier_invoices'
    | 'missing_high_value_receipts'
    | 'reverse_charge_input_missing'
    | 'declaration_incomplete'
  severity: 'high' | 'medium' | 'low'
  count: number
  message: string
  hint: string
  /**
   * Stable rule id when this blocker comes from the shared momsdeklaration
   * completeness checks (lib/reports/vat-declaration-checks.ts), so an agent
   * can branch on the rule rather than parse the Swedish message.
   */
  check_code?: VatDeclarationCheck['code']
}


/**
 * Completeness codes that describe the omvänd-skattskyldighet pair. They keep
 * the pre-existing `reverse_charge_input_missing` blocker kind so clients
 * already switching on it do not lose the case they were watching for.
 */
const RC_COMPLETENESS_CODES = new Set<VatDeclarationCheck['code']>([
  'RC_BASIS_MISSING',
  'RC_OUTPUT_MISSING',
  'RC_INPUT_VAT_MISMATCH',
])

/**
 * gnubok_year_end_readiness: YearEndBlockerCode to the blocker `kind` this
 * tool publishes. The kinds are the public contract agents switch on, so they
 * are deliberately NOT the codes themselves: a code may be renamed or split
 * without breaking a consumer, as long as it keeps mapping to the same kind.
 *
 * UNBOOKED_CHECK_FAILED shares 'unbooked_transactions' with the real count:
 * the fail-closed variant means "we could not tell", and an agent should react
 * to it the same way (go look at the transactions, then re-run readiness).
 *
 * Exported so the tool-description test can assert that every kind an agent
 * can receive is actually named in the description it plans against: the
 * description drifted once already (it advertised FX revaluation, a WARNING,
 * as a blocker and never mentioned unbooked transactions, the common one).
 */
export const YEAR_END_BLOCKER_KIND: Record<YearEndBlockerCode, string> = {
  PERIOD_NOT_FOUND: 'period_not_found',
  PERIOD_NOT_ENDED: 'period_not_ended',
  PERIOD_ALREADY_CLOSED: 'period_already_closed',
  CLOSING_ENTRY_EXISTS: 'closing_entry_exists',
  DRAFT_ENTRIES: 'draft_entries',
  UNEXPLAINED_VOUCHER_GAP: 'unexplained_voucher_gap',
  SEQUENCE_COUNTER_BEHIND: 'sequence_mismatch',
  TRIAL_BALANCE_UNBALANCED: 'trial_balance_unbalanced',
  CONTINUITY_MISMATCH: 'opening_balance_continuity',
  NEXT_PERIOD_HAS_IB: 'next_period_ib_posted',
  UNBOOKED_TRANSACTIONS: 'unbooked_transactions',
  UNBOOKED_CHECK_FAILED: 'unbooked_transactions',
}

/**
 * Wording fallback for a blocker whose code is not in YEAR_END_BLOCKER_KIND.
 * Kept so an unmapped or legacy English message still routes somewhere useful
 * instead of collapsing to 'other'.
 */
function classifyYearEndBlockerMessage(message: string): string {
  if (/draft journal entries|utkast måste bokföras/i.test(message)) return 'draft_entries'
  if (/unbooked transaction|saknar bokföring|obokförda transaktioner/i.test(message)) return 'unbooked_transactions'
  if (/voucher gap|verifikationsnummerglapp/i.test(message)) return 'unexplained_voucher_gap'
  if (/Sequence counter integrity|Nummerserien i serie/i.test(message)) return 'sequence_mismatch'
  if (/Trial balance is not balanced|Råbalansen balanserar inte/i.test(message)) return 'trial_balance_unbalanced'
  if (/already closed|redan stängd/i.test(message)) return 'period_already_closed'
  if (/has not yet ended|slutdatumet har inte passerat/i.test(message)) return 'period_not_ended'
  if (/closing entry already exists|Bokslutsverifikation finns redan/i.test(message)) return 'closing_entry_exists'
  if (/continuity check failed|IB\/UB-kontinuiteten/i.test(message)) return 'opening_balance_continuity'
  if (/opening balances already posted|redan ingående balanser bokförda/i.test(message)) return 'next_period_ib_posted'
  if (/Fiscal period not found|Räkenskapsperioden hittades inte/i.test(message)) return 'period_not_found'
  return 'other'
}

interface VatCloseSanityAnomaly {
  kind: 'output_vat_ratio_drift' | 'input_vat_ratio_drift' | 'revenue_drop' | 'revenue_spike'
  rate?: '25' | '12' | '6'
  current: number
  previous: number
  delta_pct: number
  message: string
}

interface VatCloseCheckResult {
  period: VatReportResult['period']
  period_label: string
  rutor: VatReportResult['rutor']
  payment: {
    net_due: number
    direction: 'pay' | 'refund' | 'zero'
    deadline: string | null
    deadline_label: string | null
    moms_period: 'monthly' | 'quarterly' | 'yearly' | null
  }
  blockers: VatCloseBlocker[]
  /**
   * The momsdeklaration completeness findings behind the
   * declaration_incomplete / reverse_charge_input_missing blockers, verbatim
   * from the shared checks. Empty means the declaration itself looks complete;
   * it says nothing about the other blockers.
   */
  declaration_checks: VatCompletenessFinding[]
  sanity: {
    anomalies: VatCloseSanityAnomaly[]
    ratios: {
      output_vat_ratio_25: number  // ruta10 / domestic 25% revenue
      output_vat_ratio_12: number
      output_vat_ratio_6: number
      previous_period_compared: boolean
    }
  }
  ready_to_close: boolean
  summary: string
}

/** Compute the Skatteverket momsdeklaration deadline for a period.
 *  - monthly: due on the 12th of (period-end-month + 1)
 *  - quarterly: 26th of the month after quarter-end (Q4 → 26 Jan next year)
 *  - yearly: 26 Feb of next year
 */
export function computeMomsDeadline(
  periodType: 'monthly' | 'quarterly' | 'yearly',
  year: number,
  period: number
): { date: string; label: string } | null {
  if (periodType === 'monthly') {
    // period 1-12; deadline = 12th of next month
    const deadlineMonth = period === 12 ? 1 : period + 1
    const deadlineYear = period === 12 ? year + 1 : year
    return {
      date: `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-12`,
      label: `12 ${monthName(deadlineMonth)} ${deadlineYear}`,
    }
  }
  if (periodType === 'quarterly') {
    // Q1→26 apr, Q2→26 jul, Q3→26 okt, Q4→26 jan next year
    const monthByQuarter: Record<number, { m: number; yOffset: number }> = {
      1: { m: 4, yOffset: 0 },
      2: { m: 7, yOffset: 0 },
      3: { m: 10, yOffset: 0 },
      4: { m: 1, yOffset: 1 },
    }
    const cfg = monthByQuarter[period]
    if (!cfg) return null
    return {
      date: `${year + cfg.yOffset}-${String(cfg.m).padStart(2, '0')}-26`,
      label: `26 ${monthName(cfg.m)} ${year + cfg.yOffset}`,
    }
  }
  if (periodType === 'yearly') {
    return {
      date: `${year + 1}-02-26`,
      label: `26 februari ${year + 1}`,
    }
  }
  return null
}

function monthName(m: number): string {
  return ['januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december'][m - 1] ?? ''
}

// ── agent_memory dedup helpers ───────────────────────────────
// Cheap, embedding-free near-duplicate detection for gnubok_remember_fact.
// Lowercase, strip punctuation, drop very short / stop-ish words, and
// compare two memories by Jaccard similarity over their word sets. Good
// enough to catch the agent re-remembering the same fact in slightly
// different words; not a substitute for semantic embeddings, but zero-cost.
const MEMORY_DEDUP_STOPWORDS = new Set([
  'och', 'att', 'det', 'som', 'en', 'ett', 'är', 'för', 'med', 'på', 'av',
  'till', 'den', 'de', 'i', 'om', 'har', 'var', 'kan', 'ska', 'samt',
  'the', 'a', 'an', 'is', 'are', 'for', 'with', 'of', 'to', 'and', 'in',
])

function tokenizeForDedup(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !MEMORY_DEDUP_STOPWORDS.has(t))
  return new Set(tokens)
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Gross floor for the missing-underlag blocker. ML 17 kap 26-28 § (förenklad
 * faktura) expresses 4 000 kr inclusive of moms, so the comparison is against
 * the gross (sum of debits, equal to sum of credits in a balanced entry). For
 * EU acquisitions and domestic reverse-charge buyer entries the calculated VAT
 * lines inflate that sum, which can pull a sub-threshold purchase above 4 000:
 * a false positive in favour of asking for the underlag, the safe direction.
 */
const MISSING_UNDERLAG_MIN_GROSS_SEK = 4000

/** ISO date one day after `isoDate`, in UTC so no local offset can shift it. */
function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** One `verifikat_without_documents` page-of-one, used only for its total. */
async function totalMissingUnderlagSince(
  supabase: SupabaseClient,
  companyId: string,
  since: string
): Promise<number> {
  const { data, error } = await supabase.rpc('verifikat_without_documents', {
    p_company_id: companyId,
    p_since: since,
    p_min_amount: MISSING_UNDERLAG_MIN_GROSS_SEK,
    // p_limit only sizes the page; total_count is computed over the FULL
    // filtered set in an independent CTE, so 1 is the cheapest valid size.
    p_limit: 1,
    p_offset: 0,
  })
  if (error) throw new Error(`verifikat_without_documents failed: ${error.message}`)
  const result = data as { ok?: boolean; code?: string; total_count?: number } | null
  if (!result?.ok) {
    throw new Error(`verifikat_without_documents failed: ${result?.code ?? 'unknown error'}`)
  }
  return result.total_count ?? 0
}

/**
 * Posted verifikat dated within [start, end] that genuinely lack an underlag
 * and whose gross reaches MISSING_UNDERLAG_MIN_GROSS_SEK.
 *
 * BFL 5 kap 6-7 §: every affärshändelse needs a verifikation, and the
 * verifikation must reference its underlag. This delegates to the
 * `verifikat_without_documents` RPC, the SINGLE owner of that predicate: the
 * same SQL behind the web worklist badge (countVerifikatMissingDocument) and
 * behind gnubok_list_verifikat_without_documents. It carries three things a
 * hand-rolled scan here kept getting wrong:
 *
 *   1. the needs-doc source types (mirrors NEEDS_DOC_SOURCE_TYPES,
 *      lib/worklist/categories.ts, pinned by
 *      tests/pg/document-surfaces-unification.pg.test.ts). The local list read
 *      'supplier_invoice' and 'receipt', which are not members of the
 *      journal_entries.source_type CHECK at all: PostgREST matched zero rows,
 *      so supplier-invoice verifikat NEVER surfaced here and the momsperiod
 *      got a clean bill of health on exactly the entry types most likely to be
 *      missing their underlag;
 *   2. is_current_version, so a superseded document version does not silence
 *      the warning, and journal_entry_no_doc_required, so an explicit user
 *      waiver does;
 *   3. BFL 5 kap 7 § hänvisning till underlag: a payment verifikat whose
 *      supplier invoice carries an anchored document is covered by that
 *      document even though the doc row hangs on the registration verifikat.
 *      Without this, adding supplier_invoice_paid to the list would flag every
 *      paid supplier invoice in the period (the 2026-07-24 support case).
 *
 * The RPC takes `since` and no upper bound, so the in-period count is the
 * difference between two filter-respecting totals. Both calls run the same
 * predicate, so the subtraction is exact rather than an estimate.
 */
async function countMissingUnderlagInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string
): Promise<number> {
  const [fromStart, afterEnd] = await Promise.all([
    totalMissingUnderlagSince(supabase, companyId, start),
    totalMissingUnderlagSince(supabase, companyId, dayAfter(end)),
  ])
  return Math.max(0, fromStart - afterEnd)
}

export async function computeVatCloseCheck(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatCloseCheckResult> {
  // 1) VAT report (validates inputs + gives us figures + period dates). The
  //    full SKV 4700 projection rides along for the completeness checks in
  //    step 4b: they need rutor 20-24 and 50, which the report view omits, plus
  //    the per-account totals so the RC input comparison reads 2645/2647
  //    instead of the ruta 48 aggregate.
  const { report: vatReport, declarationRutor, accountTotals } =
    await computeVatReportWithRutor(args, companyId, supabase)
  const { start, end, type: periodType, year, period } = vatReport.period

  // 2) Company settings: moms_period drives deadline labelling
  const { data: settings } = await supabase
    .from('company_settings')
    .select('moms_period')
    .eq('company_id', companyId)
    .single()
  const momsPeriod = (settings?.moms_period as 'monthly' | 'quarterly' | 'yearly' | null) ?? null

  // 3) Deadline: based on the *requested* period type, not company setting,
  //    so the model gets the right deadline even when querying ad-hoc periods.
  const deadline = computeMomsDeadline(
    periodType as 'monthly' | 'quarterly' | 'yearly',
    Number(year),
    Number(period)
  )

  // 4) Blocker scans: run in parallel
  const [unapprovedRes, missingUnderlag] = await Promise.all([
    supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'registered')
      .gte('invoice_date', start).lte('invoice_date', end),
    // Verifikat in the period that genuinely lack an underlag (BFL 5 kap
    // 6-7 §), counted over the SHARED SQL predicate. Never re-derive this
    // locally: countMissingUnderlagInPeriod documents what the hand-rolled
    // scan that used to sit here got wrong.
    countMissingUnderlagInPeriod(supabase, companyId, start, end),
  ])

  const blockers: VatCloseBlocker[] = []
  const unapprovedCount = unapprovedRes.count ?? 0
  if (unapprovedCount > 0) {
    blockers.push({
      kind: 'unapproved_supplier_invoices',
      severity: 'high',
      count: unapprovedCount,
      message: `${unapprovedCount} oattesterade leverantörsfakturor i perioden`,
      hint: 'Attestera via gnubok_approve_supplier_invoice: ingående moms (ruta 48) påverkas.',
    })
  }
  if (missingUnderlag > 0) {
    blockers.push({
      kind: 'missing_high_value_receipts',
      severity: 'medium',
      count: missingUnderlag,
      message: `${missingUnderlag} verifikat över ${MISSING_UNDERLAG_MIN_GROSS_SEK} kr saknar underlag`,
      hint: `BFL 5 kap 6-7 §: varje affärshändelse måste ha en verifikation med hänvisning till sitt underlag. Lista dem med gnubok_list_verifikat_without_documents (since=${start}, min_amount=${MISSING_UNDERLAG_MIN_GROSS_SEK}) och para ihop via gnubok_list_unmatched_documents.`,
    })
  }
  // 4b) Is the DECLARATION itself complete? Everything above is about the
  //     bookkeeping around it; this is about the momsdeklaration.
  //
  //     Until 2026-07 this was a single hand-rolled mirror,
  //     `acquisitionAndImportBase > 0 && ruta48 === 0`, and ruta 48 aggregates
  //     2641/2642/2645/2646/2647/2649: ONE ordinary domestic receipt in the
  //     period made it unreachable, so a declaration with omvänd
  //     skattskyldighet booked on one side only sailed through as "Klart för
  //     stängning". There was no basbelopp check (rutor 20-24 vs 30-32) at all,
  //     which is the FK004 case Skatteverket rejects.
  //
  //     Now the shared core checks run instead, over the full SKV 4700
  //     projection, so the MCP verdict is the SAME verdict the web UI's
  //     "Kontroll av underlaget" gate gives. Never re-derive these locally.
  const declarationChecks = await runVatCompletenessChecks(
    supabase,
    companyId,
    declarationRutor,
    periodType as VatPeriodType,
    Number(year),
    Number(period),
    accountTotals,
  )

  // Zero deductible input VAT against self-assessed utgående moms is
  // unambiguous: rutor 30-32 (omvänd skattskyldighet, 2614/2624/2634) and
  // rutor 60-62 (import since 2015, 2615/2625/2635) each require the matching
  // ingående moms on 2645/2647 (ML 2023:200); with ruta 48 at zero there is no
  // partial-deduction story that explains it.
  //
  // The shared RC_INPUT_VAT_MISMATCH now isolates the RC share exactly (it reads
  // 2645/2647, see the accountTotals argument above) and still stays a WARNING,
  // deliberately: limited avdragsrätt (blandad verksamhet, ML 13 kap 18/24-25 §§)
  // makes a shortfall legally correct for some filers, and no SKV gateway rule
  // rejects it. Both halves of this escalation survive that sharpening:
  //   - the RC half turns the warning into a blocker in the one case where no
  //     deduction story exists at all (ruta 48 itself is zero);
  //   - the IMPORT half (rutor 60-62 against ruta 48, below) is coverage the
  //     shared checks still do not have: they compare import output only against
  //     the tullvärdesunderlag in ruta 50, never against the input side.
  const eps = 0.5
  const rcOutput = declarationRutor.ruta30 + declarationRutor.ruta31 + declarationRutor.ruta32
  const selfAssessedOutput =
    rcOutput + declarationRutor.ruta60 + declarationRutor.ruta61 + declarationRutor.ruta62
  const noInputVatAtAll = selfAssessedOutput > eps && declarationRutor.ruta48 <= eps

  for (const check of declarationChecks) {
    const escalated =
      check.status === 'ERROR' ||
      (check.code === 'RC_INPUT_VAT_MISMATCH' && noInputVatAtAll)
    blockers.push({
      kind: RC_COMPLETENESS_CODES.has(check.code)
        ? 'reverse_charge_input_missing'
        : 'declaration_incomplete',
      severity: escalated ? 'high' : 'medium',
      count: 1,
      message: check.message,
      hint: check.rutor?.length
        ? `Granska ${check.rutor.join(', ')} i huvudboken innan inlämning (gnubok_get_general_ledger).`
        : 'Granska underlaget i huvudboken innan inlämning (gnubok_get_general_ledger).',
      check_code: check.code,
    })
  }

  // Import-only variant of the same defect: no RC output means no
  // RC_INPUT_VAT_MISMATCH finding exists to escalate above.
  if (noInputVatAtAll && rcOutput <= eps) {
    blockers.push({
      kind: 'reverse_charge_input_missing',
      severity: 'high',
      count: 1,
      message:
        'Import: utgående importmoms är bokförd (ruta 60/61/62) men ingen avdragsgill ingående moms alls (ruta 48 är noll)',
      hint: 'ML 2023:200: importören redovisar både beräknad utgående moms (2615/2625/2635) och avdragsgill ingående moms (2645).',
    })
  }

  // 5) Sanity ratios: current period output VAT to revenue per rate, vs prior period
  const ratios = {
    output_vat_ratio_25: vatReport.rutor.ruta05 > 0
      ? Math.round((vatReport.rutor.ruta10 / vatReport.rutor.ruta05) * 10000) / 100
      : 0,
    output_vat_ratio_12: 0,  // no per-rate revenue split available from VAT report
    output_vat_ratio_6: 0,
    previous_period_compared: false,
  }
  const anomalies: VatCloseSanityAnomaly[] = []

  // Compare to previous same-length period
  const prevArgs = previousPeriodArgs(periodType as 'monthly' | 'quarterly' | 'yearly', Number(year), Number(period))
  if (prevArgs) {
    try {
      const prev = await computeVatReport(prevArgs, companyId, supabase)
      ratios.previous_period_compared = true
      // Output VAT ratio 25% drift
      if (vatReport.rutor.ruta05 > 0 && prev.rutor.ruta05 > 0) {
        const cur = vatReport.rutor.ruta10 / vatReport.rutor.ruta05
        const prv = prev.rutor.ruta10 / prev.rutor.ruta05
        if (prv > 0) {
          const deltaPct = Math.round(((cur - prv) / prv) * 10000) / 100
          if (Math.abs(deltaPct) > 20) {
            anomalies.push({
              kind: 'output_vat_ratio_drift',
              rate: '25',
              current: Math.round(cur * 10000) / 100,
              previous: Math.round(prv * 10000) / 100,
              delta_pct: deltaPct,
              message: `Utgående moms 25% / försäljning ändrades ${deltaPct > 0 ? '+' : ''}${deltaPct}% jämfört med föregående period: kontrollera momssatser`,
            })
          }
        }
      }
      // Revenue spike/drop
      if (prev.rutor.ruta05 > 0) {
        const revDelta = Math.round(((vatReport.rutor.ruta05 - prev.rutor.ruta05) / prev.rutor.ruta05) * 10000) / 100
        if (revDelta < -50) {
          anomalies.push({
            kind: 'revenue_drop',
            current: vatReport.rutor.ruta05,
            previous: prev.rutor.ruta05,
            delta_pct: revDelta,
            message: `Försäljning föll ${revDelta}%: bekräfta att alla fakturor är bokförda`,
          })
        } else if (revDelta > 200) {
          anomalies.push({
            kind: 'revenue_spike',
            current: vatReport.rutor.ruta05,
            previous: prev.rutor.ruta05,
            delta_pct: revDelta,
            message: `Försäljning steg ${revDelta}%: kontrollera att inget bokats två gånger`,
          })
        }
      }
    } catch {
      // Previous period unavailable: skip comparison silently
    }
  }

  const highBlockers = blockers.filter((b) => b.severity === 'high').length
  // Two gates, one verdict. `isFilingBlocked` over the SAME check array the web
  // UI gates "Skicka till Skatteverket" on is authoritative for the declaration
  // itself; the blocker scan covers the bookkeeping around it. An ERROR finding
  // is already a high blocker, so this is belt and braces on purpose: the
  // readiness answer must never come from a narrower source than the UI's.
  const declarationBlocked = isFilingBlocked(declarationChecks)
  const readyToClose = highBlockers === 0 && !declarationBlocked
  const netDue = vatReport.rutor.ruta49
  const direction: 'pay' | 'refund' | 'zero' = netDue > 0 ? 'pay' : netDue < 0 ? 'refund' : 'zero'

  const declarationErrors = declarationChecks.filter((c) => c.status === 'ERROR').length
  let summary: string
  if (readyToClose && anomalies.length === 0) {
    summary = `Klart för stängning. ${direction === 'pay' ? `Moms att betala: ${netDue.toFixed(2)} kr` : direction === 'refund' ? `Moms att få tillbaka: ${Math.abs(netDue).toFixed(2)} kr` : 'Noll i moms'}.${deadline ? ` Inlämning senast ${deadline.label}.` : ''}`
  } else if (readyToClose) {
    summary = `Klart för stängning men ${anomalies.length} avvikelse(r) att granska.`
  } else if (declarationBlocked) {
    summary = `Inte klart: deklarationsunderlaget är ofullständigt (${declarationErrors} fel), ${highBlockers} kritiska blockerare totalt.`
  } else {
    summary = `Inte klart: ${highBlockers} kritiska blockerare.`
  }

  return {
    period: vatReport.period,
    period_label: vatReport.period_label,
    rutor: vatReport.rutor,
    payment: {
      net_due: netDue,
      direction,
      deadline: deadline?.date ?? null,
      deadline_label: deadline?.label ?? null,
      moms_period: momsPeriod,
    },
    blockers,
    declaration_checks: toCompletenessFindings(declarationChecks),
    sanity: { anomalies, ratios },
    ready_to_close: readyToClose,
    summary,
  }
}

function previousPeriodArgs(
  periodType: 'monthly' | 'quarterly' | 'yearly',
  year: number,
  period: number
): { period_type: string; year: number; period: number } | null {
  if (periodType === 'monthly') {
    if (period === 1) return { period_type: 'monthly', year: year - 1, period: 12 }
    return { period_type: 'monthly', year, period: period - 1 }
  }
  if (periodType === 'quarterly') {
    if (period === 1) return { period_type: 'quarterly', year: year - 1, period: 4 }
    return { period_type: 'quarterly', year, period: period - 1 }
  }
  if (periodType === 'yearly') {
    return { period_type: 'yearly', year: year - 1, period: 1 }
  }
  return null
}

// Shared by the report tools' optional `dimensions` filter arg: parse the raw
// bag, then resolve value NAMES → registry codes in one pass (resolve-don't-
// select: the exact contract gnubok_create_voucher uses, incl. free-text
// passthrough while dimensions_enabled is off). A DimensionResolutionError
// propagates to the caller with ranked candidates. The resolved bag is echoed
// back as `dimension_filter` so the agent can verify what a name attached to.
async function resolveReportDimensionFilter(
  supabase: SupabaseClient,
  companyId: string,
  raw: unknown,
): Promise<{ filter?: Record<string, string>; resolutions: DimensionResolution[] }> {
  if (!raw || typeof raw !== 'object' || Object.keys(raw as object).length === 0) {
    return { resolutions: [] }
  }
  const parsed = parseDimensionsArg(raw, 'dimensions')
  const { bags, resolutions } = await resolveDimensionBags(supabase, companyId, [parsed])
  return { filter: bags[0], resolutions }
}

// Input-schema fragment for that arg: identical shape on trial balance,
// income statement, and general ledger.
const REPORT_DIMENSIONS_FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Filter: SIE dim no → value (code OR name, resolved server-side), e.g. {"6":"P001"}. P&L view only: opening balances are excluded when set.',
} as const

// Output-schema fragments for the echo fields (never in `required`).
const DIMENSION_FILTER_OUTPUT_PROPS = {
  dimension_filter: {
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Echo of the applied filter, resolved to registry codes.',
  },
  dimension_resolutions: {
    type: 'array',
    items: { type: 'object' },
    description: 'Non-exact name→code resolution echoes (resolve-don\'t-select).',
  },
} as const

let canonicalToolNamesCache: ReadonlySet<string> | undefined

function getCanonicalToolNames(): ReadonlySet<string> {
  canonicalToolNamesCache ??= new Set(tools.map((tool) => tool.name))
  return canonicalToolNamesCache
}

function projectMcpPayload<T>(value: T, namespace: McpToolNamespace): T {
  return projectToolReferences(value, namespace, getCanonicalToolNames())
}

// ── Tools ────────────────────────────────────────────────────

export const tools: McpTool[] = [
  {
    name: 'gnubok_search_tools',
    title: 'Search MCP Tools',
    description: 'Search available tools by keyword and choose the returned schema detail level.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords matched against tool names and descriptions. Empty returns all tools.' },
        detail: { type: 'string', enum: ['name', 'summary', 'full'], description: 'Detail level. name: just names. summary: name + description + scope (default). full: complete schema including inputSchema and outputSchema.' },
        scope: { type: 'string', description: 'Optional filter: only tools requiring this API key scope (e.g. "invoices:write").' },
        limit: { type: 'number', description: 'Max results, 1-50 (default 20).' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tools: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
        total_matched: { type: 'number' },
        detail: { type: 'string' },
      },
      required: ['tools', 'count', 'total_matched', 'detail'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, _companyId, _userId, _supabase, _actor) {
      const namespace: McpToolNamespace =
        args.__toolNamespace === 'accounted' ? 'accounted' : 'gnubok'
      const query = canonicalizeToolReferencesInText(
        ((args.query as string) || '').toLowerCase().trim()
      )
      const detail = ((args.detail as string) || 'summary') as 'name' | 'summary' | 'full'
      const scopeFilter = args.scope as string | undefined
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)

      // Filter results to tools the caller is actually authorized to invoke.
      //
      // The dispatcher injects __keyScopes when it routes to gnubok_search_tools.
      // If the marker is missing (refactor regression, direct execute() invocation
      // outside the dispatcher, etc.), FAIL CLOSED: return only unscoped tools
      // rather than leaking the full inventory. The marker presence is also part
      // of the contract: an explicitly-empty array means "no scopes granted",
      // which still hides scoped tools.
      const rawKeyScopes = (args as Record<string, unknown>).__keyScopes
      const callerScopes: string[] = Array.isArray(rawKeyScopes)
        ? (rawKeyScopes as string[])
        : []
      const scopesInjected = Array.isArray(rawKeyScopes)

      let candidates = tools.filter((t) => {
        const required = TOOL_SCOPE_MAP[t.name]
        if (required) {
          // Scoped tool: visible only if scopes were injected AND the caller has it.
          if (!scopesInjected) return false
          if (!callerScopes.includes(required)) return false
        }
        if (scopeFilter && required !== scopeFilter) return false
        return true
      })

      if (query) {
        // Match: every whitespace-separated term must appear in name or description
        // (for a single-word query this is identical to a literal substring match).
        // Rank by relevance so the most on-point tool comes first instead of
        // whichever happens to be defined earliest: exact-ish name match > full
        // query as a name substring > per-term name hits > description hits. Ties
        // fall back to definition order (stable).
        const terms = query.split(/\s+/).filter(Boolean)
        const ranked = candidates
          .map((t, idx) => {
            const name = t.name.toLowerCase()
            const desc = t.description.toLowerCase()
            const hay = `${name} ${desc}`
            if (!terms.every((term) => hay.includes(term))) return null
            let score = 0
            if (name === query || name === `gnubok_${query}` || name.endsWith(`_${query}`)) score += 100
            if (name.includes(query)) score += 40
            for (const term of terms) {
              if (name.includes(term)) score += 10
              if (desc.includes(term)) score += 1
            }
            return { t, score, idx }
          })
          .filter((x): x is { t: McpTool; score: number; idx: number } => x !== null)
          .sort((a, b) => b.score - a.score || a.idx - b.idx)
        candidates = ranked.map((x) => x.t)
      }

      const totalMatched = candidates.length
      const sliced = candidates.slice(0, limit)

      const projected = sliced.map((t) => {
        const requiredScope = TOOL_SCOPE_MAP[t.name] ?? null
        if (detail === 'name') {
          return { name: toPublicToolName(t.name, namespace), scope: requiredScope }
        }
        if (detail === 'full') {
          const meta = projectMcpPayload(
            { ...(deriveToolMeta(t) ?? {}), ...(t._meta ?? {}) },
            namespace
          )
          return projectMcpPayload(
            {
              name: toPublicToolName(t.name, namespace),
              description: t.description,
              scope: requiredScope,
              inputSchema: projectToolInputSchema(t),
              ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
              annotations: t.annotations,
              ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
            },
            namespace
          )
        }
        // summary (default)
        return projectMcpPayload(
          {
            name: toPublicToolName(t.name, namespace),
            description: t.description,
            scope: requiredScope,
          },
          namespace
        )
      })

      return {
        tools: projected,
        count: projected.length,
        total_matched: totalMatched,
        detail,
      }
    },
  },

  {
    name: 'gnubok_list_companies',
    title: 'List Companies',
    description: 'List every non-archived company this API-key user can access. Use company_id from this result on other tools; omit it there to use the API key default.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        companies: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              company_id: { type: 'string' },
              name: { type: 'string' },
              org_number: { type: ['string', 'null'] },
              entity_type: { type: ['string', 'null'] },
              role: { type: 'string', enum: ['owner', 'admin', 'member', 'viewer'] },
              is_default: { type: 'boolean' },
            },
            required: ['company_id', 'name', 'org_number', 'entity_type', 'role', 'is_default'],
          },
        },
        count: { type: 'number' },
        default_company_id: { type: ['string', 'null'] },
      },
      required: ['companies', 'count', 'default_company_id'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, defaultCompanyId, userId, supabase) {
      type CompanyRow = {
        id: string
        name: string
        org_number: string | null
        entity_type: string | null
        archived_at: string | null
      }
      type MembershipRow = {
        company_id: string
        role: 'owner' | 'admin' | 'member' | 'viewer'
        companies: CompanyRow | CompanyRow[] | null
      }

      const memberships = (await getUserCompanies(supabase, userId)) as unknown as MembershipRow[]
      const accessible = memberships.flatMap((membership) => {
        const company = Array.isArray(membership.companies)
          ? membership.companies[0]
          : membership.companies
        return company && company.archived_at === null ? [{ membership, company }] : []
      })
      const companyIds = accessible.map(({ company }) => company.id)
      const displayNames = new Map<string, string>()

      if (companyIds.length > 0) {
        try {
          const settings = await fetchAllRows<{ company_id: string; company_name: string | null }>(
            ({ from, to }) =>
              supabase
                .from('company_settings')
                .select('company_id, company_name')
                .in('company_id', companyIds)
                .order('company_id', { ascending: true })
                .range(from, to),
          )
          for (const row of settings) {
            if (row.company_name) displayNames.set(row.company_id, row.company_name)
          }
        } catch (error) {
          log.warn('gnubok_list_companies display-name lookup failed', {
            error: error instanceof Error ? error.message : 'unknown',
          })
        }
      }

      const companies = accessible.map(({ membership, company }) => ({
        company_id: company.id,
        name: displayNames.get(company.id) ?? company.name,
        org_number: company.org_number,
        entity_type: company.entity_type,
        role: membership.role,
        is_default: company.id === defaultCompanyId,
      }))
      const hasAccessibleDefault = companies.some((company) => company.is_default)

      return {
        companies,
        count: companies.length,
        default_company_id: hasAccessibleDefault ? defaultCompanyId : null,
      }
    },
  },

  {
    name: 'gnubok_get_company_settings',
    title: 'Get Company Settings',
    description: 'Get invoice payment details, company contact details and the custom invoice email texts. Use before creating invoices or staging a settings update.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        company_id: { type: 'string' },
        bank_name: { type: ['string', 'null'] },
        clearing_number: { type: ['string', 'null'] },
        account_number: { type: ['string', 'null'] },
        bankgiro: { type: ['string', 'null'] },
        plusgiro: { type: ['string', 'null'] },
        swish: { type: ['string', 'null'] },
        iban: { type: ['string', 'null'] },
        bic: { type: ['string', 'null'] },
        contact_person: { type: ['string', 'null'], description: 'Default Our reference value on new invoices.' },
        email: { type: ['string', 'null'], description: 'Company contact email shown on invoices.' },
        phone: { type: ['string', 'null'], description: 'Company contact phone shown on invoices.' },
        website: { type: ['string', 'null'], description: 'Company website shown on invoices.' },
        invoice_email_texts: {
          type: ['object', 'null'],
          additionalProperties: false,
          description: 'Per-language overrides of the invoice email texts. Null or a missing field means the standard text is used.',
          properties: {
            sv: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subject: { type: 'string' },
                greeting: { type: 'string' },
                body: { type: 'string' },
                signoff: { type: 'string' },
              },
            },
            en: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subject: { type: 'string' },
                greeting: { type: 'string' },
                body: { type: 'string' },
                signoff: { type: 'string' },
              },
            },
          },
        },
      },
      required: [
        'company_id',
        'bank_name',
        'clearing_number',
        'account_number',
        'bankgiro',
        'plusgiro',
        'swish',
        'iban',
        'bic',
        'contact_person',
        'email',
        'phone',
        'website',
        'invoice_email_texts',
      ],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    catalogVisibility: 'search',
    async execute(_args, companyId, _userId, supabase) {
      const { data, error } = await supabase
        .from('company_settings')
        .select('bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, default_our_reference, email, phone, website, invoice_email_texts')
        .eq('company_id', companyId)
        .maybeSingle()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!data) throw new Error('Company settings not found.')

      return {
        company_id: companyId,
        bank_name: data.bank_name ?? null,
        clearing_number: data.clearing_number ?? null,
        account_number: data.account_number ?? null,
        bankgiro: data.bankgiro ?? null,
        plusgiro: data.plusgiro ?? null,
        swish: data.swish ?? null,
        iban: data.iban ?? null,
        bic: data.bic ?? null,
        contact_person: data.default_our_reference ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        website: data.website ?? null,
        invoice_email_texts: data.invoice_email_texts ?? null,
      }
    },
  },

  {
    name: 'gnubok_update_company_settings',
    title: 'Update Company Settings',
    description: 'Stage changes to invoice payment details, company contact details or the custom invoice email texts. Requires approval before company settings are updated.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bank_name: { type: 'string', maxLength: 100 },
        clearing_number: { type: 'string', description: '4-5 digits. Empty string clears the value.' },
        account_number: { type: 'string', description: '6-12 digits. Empty string clears the value.' },
        bankgiro: { type: ['string', 'null'], description: 'Valid 7-8 digit Bankgiro with Luhn check digit. Null or empty string clears it.' },
        plusgiro: { type: ['string', 'null'], description: 'Valid Plusgiro with hyphen and Luhn check digit. Null or empty string clears it.' },
        swish: { type: ['string', 'null'], description: 'Swedish business or mobile Swish number. Null clears it.' },
        iban: { type: ['string', 'null'], description: 'Swedish IBAN: SE followed by 22 digits. Null or empty string clears it.' },
        bic: { type: ['string', 'null'], description: '8 or 11 character BIC/SWIFT. Null or empty string clears it.' },
        contact_person: { type: ['string', 'null'], maxLength: 200, description: 'Default Our reference value on new invoices. Null clears it.' },
        email: { type: 'string', format: 'email', description: 'Company contact email shown on invoices. Empty string clears it.' },
        phone: { type: 'string', description: 'Company contact phone shown on invoices. Empty string clears it.' },
        website: { type: 'string', description: 'Company website shown on invoices. Empty string clears it.' },
        invoice_email_texts: {
          type: ['object', 'null'],
          additionalProperties: false,
          description: 'Overrides the invoice email texts per language, standard invoices only. Omit a field to keep the standard text. Null clears every override.',
          properties: {
            sv: {
              type: 'object',
              additionalProperties: false,
              description: 'Swedish texts. Only these placeholders are allowed: {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp}. Any other {token} is rejected.',
              properties: {
                subject: { type: 'string', maxLength: 200 },
                greeting: { type: 'string', maxLength: 200 },
                body: { type: 'string', maxLength: 2000 },
                signoff: { type: 'string', maxLength: 200 },
              },
            },
            en: {
              type: 'object',
              additionalProperties: false,
              description: 'English texts, used when the customer language is en. Same placeholder set as sv.',
              properties: {
                subject: { type: 'string', maxLength: 200 },
                greeting: { type: 'string', maxLength: 200 },
                body: { type: 'string', maxLength: 2000 },
                signoff: { type: 'string', maxLength: 200 },
              },
            },
          },
        },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging or changing data.' },
        idempotency_key: { type: 'string', description: 'Random per-operation UUID. Reusing it with the same payload returns the original staged response.' },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    catalogVisibility: 'search',
    async execute(args, companyId, userId, supabase, actor) {
      const rawChanges: Record<string, unknown> = {}
      for (const key of [
        'bank_name',
        'clearing_number',
        'account_number',
        'bankgiro',
        'plusgiro',
        'swish',
        'iban',
        'bic',
        'email',
        'phone',
        'website',
        'invoice_email_texts',
      ]) {
        if (args[key] !== undefined) rawChanges[key] = args[key]
      }
      if (args.contact_person !== undefined) {
        rawChanges.default_our_reference = args.contact_person
      }

      const parsed = UpdateCompanySettingsParamsSchema.safeParse({ changes: rawChanges })
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(`Invalid company settings: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'validation failed'}`)
      }

      const { data: current, error } = await supabase
        .from('company_settings')
        .select('bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, default_our_reference, email, phone, website, invoice_email_texts')
        .eq('company_id', companyId)
        .maybeSingle()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!current) throw new Error('Company settings not found.')

      const currentPreview = {
        company_id: companyId,
        bank_name: current.bank_name ?? null,
        clearing_number: current.clearing_number ?? null,
        account_number: current.account_number ?? null,
        bankgiro: current.bankgiro ?? null,
        plusgiro: current.plusgiro ?? null,
        swish: current.swish ?? null,
        iban: current.iban ?? null,
        bic: current.bic ?? null,
        contact_person: current.default_our_reference ?? null,
        email: current.email ?? null,
        phone: current.phone ?? null,
        website: current.website ?? null,
        invoice_email_texts: current.invoice_email_texts ?? null,
      }
      const previewChanges = {
        ...parsed.data.changes,
        ...(parsed.data.changes.default_our_reference !== undefined
          ? { contact_person: parsed.data.changes.default_our_reference }
          : {}),
      }
      delete (previewChanges as Record<string, unknown>).default_our_reference

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'update_company_settings',
        'Uppdatera företagsinställningar',
        parsed.data,
        {
          current: currentPreview,
          changes: previewChanges,
          proposed: { ...currentPreview, ...previewChanges },
        },
        actor,
        undefined,
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        },
      )
    },
  },

  {
    name: 'gnubok_list_skills',
    title: 'List Domain Skills',
    description: 'List domain-knowledge skills for this company (entity type, VAT). Workflow guides + loaded specialty atoms. Pass include_all=true to see hidden skills. Call gnubok_load_skill(slug) for any body.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: { type: 'string', description: 'Optional filter by tag (e.g. "vat", "monthly", "yearly", "payroll", or the tier name "workflow"/"horizontal"/"vertical"/"modifier").' },
        tier: {
          type: 'string',
          enum: ['workflow', 'horizontal', 'vertical', 'modifier'],
          description: 'Optional filter by tier. workflow = static guides, horizontal = regulatory atoms (Swedish VAT/payroll/…), vertical = industry atoms (konsult-IT, e-handel…), modifier = cross-cutting atoms (holding-AB…).',
        },
        include_all: {
          type: 'boolean',
          description: 'When true, ignore the company-context filter (entity_type, employees, vat_registered) and return all skills. Default false.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        skills: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              name: { type: 'string' },
              summary: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              tier: { type: 'string', enum: ['workflow', 'horizontal', 'vertical', 'modifier'] },
            },
            required: ['slug', 'name', 'summary', 'tier'],
          },
        },
        count: { type: 'number' },
        hidden_count: { type: 'number', description: 'Skills hidden by company-context filter. Re-call with include_all=true to see them.' },
        company_context: {
          type: 'object',
          additionalProperties: false,
          description: 'Snapshot of the filter inputs used to compute the list: useful when debugging "why isn\'t skill X showing up?".',
          properties: {
            entity_type: { type: ['string', 'null'] },
            has_employees: { type: 'boolean' },
            vat_registered: { type: 'boolean' },
          },
        },
      },
      required: ['skills', 'count', 'hidden_count', 'company_context'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const tag = (args.tag as string | undefined)?.toLowerCase().trim()
      const tier = (args.tier as SkillTier | undefined)
      const includeAll = args.include_all === true

      // Resolve company context: read once per call. Failures degrade
      // gracefully: an unresolved field means "don't filter on it" so a
      // misconfigured company still gets the full skill list.
      const [settings, employeeCount] = await Promise.all([
        supabase
          .from('company_settings')
          .select('entity_type, vat_registered')
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('employees')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('is_active', true),
      ])
      const entityType = (settings.data?.entity_type as string | undefined) ?? null
      const vatRegistered = Boolean(settings.data?.vat_registered)
      const hasEmployees = (employeeCount.count ?? 0) > 0

      const all = await loadAllSkills(supabase)

      // First pass: tier + tag filter (unchanged).
      const tagFiltered = all.filter((s) => {
        if (tier && s.tier !== tier) return false
        if (tag && !s.tags.some((t) => t.toLowerCase() === tag)) return false
        return true
      })

      // Second pass: applicability filter: skipped when include_all=true so
      // agents can always escape to the full list. Skills without an
      // applicability declaration are always shown (universal).
      const applicable = includeAll
        ? tagFiltered
        : tagFiltered.filter((s) => {
            if (!s.applicability) return true
            const a = s.applicability
            if (a.entity_type && a.entity_type !== 'both' && entityType && entityType !== a.entity_type) return false
            if (a.requires?.includes('employees') && !hasEmployees) return false
            if (a.requires?.includes('vat_registered') && !vatRegistered) return false
            return true
          })

      return {
        skills: applicable.map((s) => ({
          slug: s.slug,
          name: s.name,
          summary: s.summary,
          tags: s.tags,
          tier: s.tier,
        })),
        count: applicable.length,
        hidden_count: tagFiltered.length - applicable.length,
        company_context: {
          entity_type: entityType,
          has_employees: hasEmployees,
          vat_registered: vatRegistered,
        },
      }
    },
  },

  {
    name: 'gnubok_load_skill',
    title: 'Load Domain Skill',
    description: 'Load a skill body by slug. Workflow slugs are flat (e.g. "month-end-close"); atom slugs match registry ids (e.g. "vertical/konsult-it", "modifier/holding-ab"). Call gnubok_list_skills to find slugs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Skill slug: workflow slug ("month-end-close", "quarterly-vat-review", "year-end-close", "invoicing-rules") or atom id ("vertical/konsult-it", "modifier/holding-ab", "horizontal/swedish-vat", …).' },
      },
      required: ['slug'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string' },
        name: { type: 'string' },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        tier: { type: 'string', enum: ['workflow', 'horizontal', 'vertical', 'modifier'] },
        body: { type: 'string', description: 'Full skill content as Markdown' },
      },
      required: ['slug', 'name', 'body', 'tier'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const slug = (args.slug as string | undefined)?.trim()
      if (!slug) throw new Error('slug is required')
      const skill = await findSkill(slug, supabase)
      if (!skill) {
        const all = await loadAllSkills(supabase)
        const available = all.map((s) => s.slug).join(', ')
        throw new Error(`Skill not found: "${slug}". Available skills: ${available}`)
      }
      // Every load, every tier: records which skill/atom bodies agents
      // actually pull (mcp.skill_loaded). Without this, "which atom was
      // loaded" is unanswerable and atom effectiveness can't be measured.
      if (actor) {
        emitSkillLoaded({ slug: skill.slug, tier: skill.tier, actor, userId, companyId })
      }
      // Workflow-tier skills are the closed-form processes (month-end-close,
      // year-end-close). Loading one is a strong signal the
      // agent is starting that workflow: emit so we can track completion
      // rates. Atom skills are reference material and don't trigger this.
      if (skill.tier === 'workflow' && actor) {
        emitWorkflowStarted({ slug: skill.slug, actor, userId, companyId })
      }
      return {
        slug: skill.slug,
        name: skill.name,
        summary: skill.summary,
        tags: skill.tags,
        tier: skill.tier,
        body: skill.body,
      }
    },
  },

  {
    name: 'gnubok_remember_fact',
    title: 'Remember Company Fact',
    description: 'Capture a durable fact, preference, or correction about the company. Use mid-conversation when the user says something to remember next time. Writes immediately: does not stage. Use sparingly.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: {
          type: 'string',
          description: 'The full fact text in the user\'s language. Self-contained: readable without prior context. Example: "Företaget hyr lagerplats av AB Foo, hyresfaktura kommer 25:e varje månad."',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'pattern', 'correction'],
          description: 'fact = verifiable statement, preference = user-stated choice, pattern = observed regularity, correction = agent learned from a user fix. Default fact.',
        },
        source_ref: {
          type: 'string',
          description: 'Optional pointer to where this fact came from (e.g. "conversation:<uuid>:turn-3").',
        },
        relevance_score: {
          type: 'number',
          description: 'How important this memory is for future prompts. 0.0-1.0. Default 0.8 for agent-captured facts.',
        },
      },
      required: ['content'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Deprecated: read fact_id instead' },
        fact_id: { type: 'string' },
        kind: { type: 'string' },
        content: { type: 'string' },
        created_at: { type: 'string' },
      },
      required: ['id', 'fact_id', 'kind', 'content', 'created_at'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const content = (args.content as string | undefined)?.trim()
      if (!content || content.length < 2) throw new Error('content is required (min 2 chars)')
      const kind = (args.kind as string | undefined) ?? 'fact'
      if (!['fact', 'preference', 'pattern', 'correction'].includes(kind)) {
        throw new Error(`invalid kind: ${kind}`)
      }
      const rawScore = args.relevance_score
      const score =
        typeof rawScore === 'number' && rawScore >= 0 && rawScore <= 1 ? rawScore : 0.8

      // Dedup guard: the agent re-remembers the same fact constantly (e.g.
      // "Vercel = omvänd skattskyldighet" on every Vercel categorization).
      // Before inserting, compare against existing active memories by
      // word-set Jaccard similarity. A near-duplicate (≥0.82) is treated as
      // already-known: we touch its updated_at + nudge relevance instead of
      // writing a new row, so agent_memory doesn't fill with paraphrases.
      // Bounded to the 300 most-recent active rows: dedup-on-write keeps
      // the working set small enough that this stays cheap.
      const { data: existing } = await supabase
        .from('agent_memory')
        .select('id, kind, content, created_at, relevance_score')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(300)

      const incomingTokens = tokenizeForDedup(content)
      const dupe = (existing ?? []).find(
        (m: { content: string }) =>
          jaccardSimilarity(incomingTokens, tokenizeForDedup(m.content)) >= 0.82,
      ) as { id: string; kind: string; content: string; created_at: string; relevance_score: number } | undefined

      if (dupe) {
        // Already known. Bump relevance toward the new score (max) and
        // refresh updated_at so recency-ordered recall still surfaces it.
        await supabase
          .from('agent_memory')
          .update({
            relevance_score: Math.max(dupe.relevance_score ?? 0, score),
            updated_at: new Date().toISOString(),
          })
          .eq('id', dupe.id)
        return {
          id: dupe.id,
          fact_id: dupe.id,
          kind: dupe.kind,
          content: dupe.content,
          created_at: dupe.created_at,
        }
      }

      const { data, error } = await supabase
        .from('agent_memory')
        .insert({
          company_id: companyId,
          kind,
          content,
          source: 'agent_learned',
          source_ref: (args.source_ref as string | undefined) ?? null,
          relevance_score: score,
          is_active: true,
          created_by_user_id: userId,
        })
        .select('id, kind, content, created_at')
        .single()
      if (error) throw new Error(`Failed to remember fact: ${error.message}`)
      return { ...data, fact_id: data.id }
    },
  },

  {
    name: 'gnubok_forget_fact',
    title: 'Forget Company Fact',
    description: 'Deactivate a memory entry by id. Use when the user explicitly asks to forget something or supersedes it. The row is kept for audit (is_active=false) but no longer surfaces in prompts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The memory entry id from a prior gnubok_remember_fact call.' },
        reason: { type: 'string', description: 'Optional short note about why this is being forgotten (for audit).' },
      },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Deprecated: read fact_id instead' },
        fact_id: { type: 'string' },
        is_active: { type: 'boolean' },
      },
      required: ['id', 'fact_id', 'is_active'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const id = (args.id as string | undefined)?.trim()
      if (!id) throw new Error('id is required')
      const { data, error } = await supabase
        .from('agent_memory')
        .update({ is_active: false })
        .eq('id', id)
        .eq('company_id', companyId)
        .select('id, is_active')
        .single()
      if (error) throw new Error(`Failed to forget fact: ${error.message}`)
      return { ...data, fact_id: data.id }
    },
  },

  {
    name: 'gnubok_feedback',
    title: 'Send Agent Feedback',
    description: 'Report agent-side feedback: missing tool, wrong description, skill gap, or a positive signal. Goes to event_log for product-team triage. Rate-limited 1/min/key.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        context: {
          type: 'string',
          description: 'What you were trying to do and what blocked you, or what worked well. Free text, max 2000 chars.',
        },
        sentiment: {
          type: 'string',
          enum: ['positive', 'negative', 'neutral'],
          description: 'Direction of the feedback. Default: negative.',
        },
        suggestion: {
          type: 'string',
          description: 'Optional concrete suggestion (e.g. "add a tool for X", "rename Y arg").',
        },
        tool_name: {
          type: 'string',
          description: 'Optional specific tool the feedback concerns.',
        },
        skill_slug: {
          type: 'string',
          description: 'Optional specific skill the feedback concerns.',
        },
      },
      required: ['context'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recorded: { type: 'boolean' },
        message: { type: 'string' },
      },
      required: ['recorded', 'message'],
    },
    annotations: {
      // Not read-only: this writes a telemetry event to the bus and mutates the
      // in-process rate-limit map. readOnlyHint is about side effects, not whether
      // business state changes: so it must be false even though no ledger is touched.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, _supabase, actor) {
      const context = (args.context as string | undefined)?.trim()
      if (!context) throw new Error('context is required')
      if (context.length > 2000) throw new Error('context is too long (max 2000 chars)')

      const sentiment = ((args.sentiment as string | undefined) ?? 'negative') as 'positive' | 'negative' | 'neutral'
      const suggestion = (args.suggestion as string | undefined)?.trim() || null
      const toolName = (args.tool_name as string | undefined)?.trim() || null
      const skillSlug = (args.skill_slug as string | undefined)?.trim() || null

      // Rate-limit per API key (or per user when no key id). 1 per 60 s.
      // In-memory + single-process: leaky bucket would be cleaner but the
      // signal here is product-team triage, not security; over-counting is
      // fine, occasional under-counting is fine.
      const rateKey = actor?.id ?? userId
      const now = Date.now()
      const last = feedbackRateLimit.get(rateKey)
      if (last && now - last < FEEDBACK_RATE_LIMIT_MS) {
        const waitSec = Math.ceil((FEEDBACK_RATE_LIMIT_MS - (now - last)) / 1000)
        throw new Error(`gnubok_feedback is rate-limited. Try again in ${waitSec}s.`)
      }
      feedbackRateLimit.set(rateKey, now)

      emitAfterResponse(() => eventBus
        .emit({
          type: 'agent.feedback',
          payload: {
            context,
            sentiment,
            suggestion,
            toolName,
            skillSlug,
            sessionId: actor?.sessionId ?? null,
            actorType: actor?.type ?? 'api_key',
            actorId: actor?.id ?? null,
            actorLabel: actor?.label ?? null,
            userId,
            companyId,
          },
        })
        .catch((err) => console.error('[mcp] agent.feedback emit failed:', err)))

      return {
        recorded: true,
        message: 'Thanks. Feedback queued for product-team review. We aggregate signal weekly.',
      }
    },
  },

  {
    name: 'gnubok_get_agent_briefing',
    title: 'Get Agent Briefing',
    description: 'Bootstrap this company\'s accountant context in one call: user_name, profile_summary, atoms (gnubok_load_skill for bodies), top-30 memories, dimensions, and recommended_tools: per-workflow loadouts to batch-load in one ToolSearch select:a,b,c call. Call once at session start.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        company: {
          type: 'object',
          additionalProperties: false,
          description:
            'The company selected for this call. Confirm it is the entity the user means before staging a write. Pass company_id on later calls to keep working in a non-default company.',
          properties: {
            id: { type: 'string', description: 'Deprecated: read company_id instead.' },
            company_id: { type: 'string', description: 'company_id selected for this call.' },
            name: { type: ['string', 'null'] },
            org_number: { type: ['string', 'null'] },
            entity_type: { type: ['string', 'null'], description: 'e.g. "aktiebolag", "enskild_firma". Null if unset.' },
            accounting_method: {
              type: ['string', 'null'],
              enum: ['accrual', 'cash', null],
              description: 'accrual = faktureringsmetoden: payment debits 19xx AND credits 1510 (both sides). cash = kontantmetoden: payment debits 19xx and books revenue + moms. Drives the settlement posting. Null defaults to accrual.',
            },
          },
          required: ['id', 'company_id'],
        },
        user_name: {
          type: ['string', 'null'],
          description:
            'Name of the person you are assisting: address them by it (their tilltalsnamn), not the owner in profile_summary. Null if unset.',
        },
        profile_summary: {
          type: ['string', 'null'],
          description: 'Composer-generated one-paragraph summary of the company. Null if no agent profile exists yet (composer has not run).',
        },
        atoms: {
          type: 'array',
          description: 'Atoms (horizontal/vertical/modifier skills) loaded for this company. Metadata only: call gnubok_load_skill(id) for the body.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Deprecated: read atom_id instead.' },
              atom_id: { type: 'string', description: 'Atom id (e.g. "horizontal/swedish-vat", "vertical/konsult-it", "modifier/holding-ab"). Use as gnubok_load_skill slug.' },
              tier: { type: 'string', enum: ['horizontal', 'vertical', 'modifier'] },
              title: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['id', 'atom_id', 'tier', 'title', 'description'],
          },
        },
        memory: {
          type: 'array',
          description: 'Top-30 active memories (facts, preferences, patterns, corrections) ranked by relevance and recency.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Deprecated: read fact_id instead.' },
              fact_id: { type: 'string', description: 'Pass to gnubok_forget_fact to deactivate.' },
              kind: { type: 'string', enum: ['fact', 'preference', 'pattern', 'correction'] },
              content: { type: 'string' },
              relevance_score: { type: ['number', 'null'] },
            },
            required: ['id', 'fact_id', 'kind', 'content'],
          },
        },
        dimensions: {
          type: 'object',
          additionalProperties: false,
          description: 'Dimension registry snapshot (kostnadsställe/projekt). OMITTED when the company has none registered; presence means lines can be tagged via the dims bag on gnubok_create_voucher.',
          properties: {
            enabled: { type: 'boolean', description: 'When true, dims-bag values are validated against the registry.' },
            dimensions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sie_dim_no: { type: 'number' },
                  name: { type: 'string' },
                  active_value_count: { type: 'number' },
                  required_on_accounts: {
                    type: 'array',
                    description: 'BAS accounts with an active required-rule: postings there are refused without a value for this dimension.',
                    items: { type: 'string' },
                  },
                  default_on_accounts: {
                    type: 'array',
                    description: 'BAS accounts where a default/fixed rule auto-applies a value at draft creation.',
                    items: { type: 'string' },
                  },
                  top_values: {
                    type: 'array',
                    description: 'Up to 10 active values; full list via gnubok_list_dimension_values.',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        code: { type: 'string' },
                        name: { type: 'string' },
                      },
                      required: ['code', 'name'],
                    },
                  },
                },
                required: ['sie_dim_no', 'name', 'active_value_count', 'required_on_accounts', 'default_on_accounts', 'top_values'],
              },
            },
          },
          required: ['enabled', 'dimensions'],
        },
        ledger_context: {
          type: 'object',
          additionalProperties: false,
          description: 'Digest of how this company books things: top-5 counterparty + top-3 supplier patterns. Full picture (account usage, explicit rules, VAT profile, conventions) in the Accounted://ledger/context resource. Evidence is historical frequency, NOT permission to auto-book: weigh seen count AND recency, never a ratio alone. OMITTED when not computable.',
          properties: {
            resource_uri: { type: 'string', description: 'URI of the full ledger-context resource.' },
            window_from: { type: 'string', description: 'Start of the rolling stats window (ISO date).' },
            posted_entries_window: { type: 'number', description: 'Posted journal entries in the window. Low = thin evidence: treat patterns as weak.' },
            top_counterparty_patterns: {
              type: 'array',
              description: 'Most frequent booked bank-feed counterparties with dominant booking. evidence = seen N in 12m, M agreed, last booked; below 0.7 agreement excluded.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  counterparty: { type: 'string' },
                  dominant_category: { type: 'string' },
                  dominant_account_number: { type: ['string', 'null'] },
                  evidence: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      seen_12m: { type: 'number' },
                      agree: { type: 'number' },
                      last_booked: { type: 'string' },
                    },
                    required: ['seen_12m', 'agree', 'last_booked'],
                  },
                },
                required: ['counterparty', 'dominant_category', 'dominant_account_number', 'evidence'],
              },
            },
            top_supplier_patterns: {
              type: 'array',
              description: 'Most invoiced suppliers (AP side) with dominant expense account and VAT treatment. Same evidence semantics.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  supplier: { type: 'string' },
                  dominant_account_number: { type: 'string' },
                  vat_treatment: { type: ['string', 'null'] },
                  evidence: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      seen_12m: { type: 'number' },
                      agree: { type: 'number' },
                      last_booked: { type: 'string' },
                    },
                    required: ['seen_12m', 'agree', 'last_booked'],
                  },
                },
                required: ['supplier', 'dominant_account_number', 'vat_treatment', 'evidence'],
              },
            },
          },
          required: ['resource_uri', 'window_from', 'posted_entries_window', 'top_counterparty_patterns', 'top_supplier_patterns'],
        },
        recommended_tools: {
          type: 'array',
          description:
            'Per-workflow tool loadouts, ordered by call sequence. Deferred-loading harnesses batch-load a whole cluster in one call (ToolSearch select:a,b,c). Static; validated against the registry.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workflow: { type: 'string', description: 'Stable workflow key.' },
              description: { type: 'string' },
              skill: { type: 'string', description: 'Slug for gnubok_load_skill (full playbook).' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exact tool names, ordered.',
              },
            },
            required: ['workflow', 'description', 'skill', 'tools'],
          },
        },
      },
      required: ['company', 'user_name', 'profile_summary', 'atoms', 'memory', 'recommended_tools'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, userId, supabase) {
      // Dimension registry is best-effort and cheap: one indexed read, skipped
      // output when empty (most companies never register dimensions: lazy
      // seeding means zero rows until first use). Errors never block the
      // briefing.
      const safeDimensionsRead = (async () => {
        try {
          return await supabase
            .from('dimensions')
            .select('id, sie_dim_no, name')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('sie_dim_no', { ascending: true })
        } catch {
          return { data: null, error: new Error('dimensions read failed') }
        }
      })()

      // Ledger-context digest is best-effort: a stats failure (e.g. RPC not
      // yet applied on a self-hosted install) omits the block, never blocks
      // the briefing.
      const safeLedgerDigest = (async () => {
        try {
          const ctx = await buildLedgerContext(supabase, companyId)
          return {
            resource_uri: 'Accounted://ledger/context',
            window_from: ctx.meta.window.from,
            posted_entries_window: ctx.meta.coverage.posted_entries_window,
            top_counterparty_patterns: ctx.counterparty_patterns.slice(0, 5).map((p) => ({
              counterparty: p.counterparty,
              dominant_category: p.dominant.category,
              dominant_account_number: p.dominant.account_number,
              evidence: {
                seen_12m: p.evidence.seen_12m,
                agree: p.evidence.agree,
                last_booked: p.evidence.last_booked,
              },
            })),
            top_supplier_patterns: ctx.supplier_patterns.slice(0, 3).map((s) => ({
              supplier: s.supplier,
              dominant_account_number: s.dominant.account_number,
              vat_treatment: s.dominant.vat_treatment,
              evidence: {
                seen_12m: s.evidence.seen_12m,
                agree: s.evidence.agree,
                last_booked: s.evidence.last_booked,
              },
            })),
          }
        } catch {
          return null
        }
      })()

      const [profileRes, memoryRes, userRes, companyRes, settingsRes, dimensionsRes] = await Promise.all([
        supabase
          .from('agent_profiles')
          .select('profile_summary, horizontal_atoms, vertical_atoms, modifier_atoms')
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('agent_memory')
          .select('id, kind, content, relevance_score')
          .eq('company_id', companyId)
          .eq('is_active', true)
          .order('relevance_score', { ascending: false, nullsFirst: false })
          .order('last_accessed_at', { ascending: false, nullsFirst: false })
          .limit(30),
        // The user's own preferred name (profiles.full_name) so the agent can
        // address them correctly. Distinct from owner/signatory names that may
        // appear in profile_summary: those come from Bolagsverket via TIC and
        // describe the company, not necessarily the person chatting. Best-effort:
        // a failed read yields a null name, never a thrown briefing.
        supabase
          .from('profiles')
          .select('full_name')
          .eq('id', userId)
          .maybeSingle(),
        // Company identity so the agent can confirm which entity it operates on
        // before any write. The dispatcher has already resolved and authorized
        // the optional per-call company_id. A failed read still yields a company
        // block with at least the id.
        supabase
          .from('companies')
          .select('name, org_number, entity_type')
          .eq('id', companyId)
          .maybeSingle(),
        supabase
          .from('company_settings')
          .select('accounting_method, dimensions_enabled')
          .eq('company_id', companyId)
          .maybeSingle(),
        safeDimensionsRead,
      ])

      if (profileRes.error) throw new Error(`Failed to load agent profile: ${profileRes.error.message}`)
      if (memoryRes.error) throw new Error(`Failed to load agent memory: ${memoryRes.error.message}`)

      const profile = profileRes.data as
        | {
            profile_summary: string | null
            horizontal_atoms: string[] | null
            vertical_atoms: string[] | null
            modifier_atoms: string[] | null
          }
        | null
      const memoryRows = (memoryRes.data ?? []) as Array<{
        id: string
        kind: string
        content: string
        relevance_score: number | null
      }>

      // profiles read is best-effort: ignore userRes.error so a missing name
      // never blocks the briefing. Data minimisation (GDPR Art.5(1)(c)): the
      // agent only needs the tilltalsnamn to address the user, so pass the first
      // token only (never the full legal name) into the LLM prompt. Mirrors
      // app/api/agent/invoke/route.ts, which also derives firstName via split.
      const userName =
        (((userRes.data as { full_name: string | null } | null)?.full_name ?? '')
          .trim()
          .split(/\s+/)[0] || null)

      // Company identity is best-effort: a missing row never blocks the
      // briefing. The id is always known (it scopes every query above).
      const companyRow = companyRes.data as
        | { name: string | null; org_number: string | null; entity_type: string | null }
        | null
      const settingsRow = settingsRes.data as
        | { accounting_method: string | null; dimensions_enabled?: boolean | null }
        | null
      const company = {
        id: companyId,
        company_id: companyId,
        name: companyRow?.name ?? null,
        org_number: companyRow?.org_number ?? null,
        entity_type: companyRow?.entity_type ?? null,
        accounting_method: settingsRow?.accounting_method ?? null,
      }

      // Dimensions block: skipped entirely when the registry is empty so an
      // untagged company pays nothing (and the agent isn't told about a
      // feature with no data behind it).
      const dimensionRows = (dimensionsRes.error ? [] : dimensionsRes.data ?? []) as Array<{
        id: string
        sie_dim_no: number
        name: string
      }>
      let dimensionsBlock:
        | {
            enabled: boolean
            dimensions: Array<{
              sie_dim_no: number
              name: string
              active_value_count: number
              required_on_accounts: string[]
              default_on_accounts: string[]
              top_values: Array<{ code: string; name: string }>
            }>
          }
        | undefined
      if (dimensionRows.length > 0) {
        try {
          const { data: valueRows, error: valueErr } = await supabase
            .from('dimension_values')
            .select('dimension_id, code, name')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('code', { ascending: true })
          if (!valueErr) {
            const byDimension = new Map<string, Array<{ code: string; name: string }>>()
            for (const v of (valueRows ?? []) as Array<{ dimension_id: string; code: string; name: string }>) {
              const bucket = byDimension.get(v.dimension_id) ?? []
              bucket.push({ code: v.code, name: v.name })
              byDimension.set(v.dimension_id, bucket)
            }
            // Account dimension rules (PR10): tell the agent up front which
            // accounts refuse postings without a value (required) and which
            // auto-apply one (default/fixed) — so gnubok_create_voucher calls
            // self-correct instead of bouncing off MANDATORY_DIMENSION_MISSING.
            const requiredByDimension = new Map<string, string[]>()
            const defaultByDimension = new Map<string, string[]>()
            const { data: ruleRows, error: ruleErr } = await supabase
              .from('account_dimension_rules')
              .select('account_number, rule_type, dimension_id')
              .eq('company_id', companyId)
              .eq('is_active', true)
            if (!ruleErr) {
              for (const r of (ruleRows ?? []) as Array<{ account_number: string; rule_type: string; dimension_id: string }>) {
                const target = r.rule_type === 'required' ? requiredByDimension : defaultByDimension
                const bucket = target.get(r.dimension_id) ?? []
                bucket.push(r.account_number)
                target.set(r.dimension_id, bucket)
              }
            }
            dimensionsBlock = {
              enabled: settingsRow?.dimensions_enabled === true,
              dimensions: dimensionRows.map((d) => {
                const values = byDimension.get(d.id) ?? []
                return {
                  sie_dim_no: d.sie_dim_no,
                  name: d.name,
                  active_value_count: values.length,
                  required_on_accounts: (requiredByDimension.get(d.id) ?? []).sort(),
                  default_on_accounts: (defaultByDimension.get(d.id) ?? []).sort(),
                  top_values: values.slice(0, 10),
                }
              }),
            }
          }
        } catch {
          // Best-effort: a values-read failure just omits the block.
        }
      }

      const atomIds = [
        ...(profile?.horizontal_atoms ?? []),
        ...(profile?.vertical_atoms ?? []),
        ...(profile?.modifier_atoms ?? []),
      ]

      let atoms: Array<{ id: string; atom_id: string; tier: string; title: string; description: string }> = []
      if (atomIds.length > 0) {
        const { data: atomRows, error: atomErr } = await supabase
          .from('agent_atom_registry')
          .select('id, tier, title, description')
          .in('id', atomIds)
          .eq('is_active', true)
        if (atomErr) throw new Error(`Failed to load atom metadata: ${atomErr.message}`)
        atoms = ((atomRows ?? []) as Array<{
          id: string
          tier: string
          title: string | null
          description: string
        }>).map((r) => ({
          id: r.id,
          atom_id: r.id,
          tier: r.tier,
          title: r.title ?? r.id,
          // Trim the keyword-stuffed registry description to a clean one-liner:
          // bodies are fetched via gnubok_load_skill, not from this metadata.
          description: toSummary(r.description),
        }))
      }

      const ledgerDigest = await safeLedgerDigest

      return {
        company,
        user_name: userName,
        profile_summary: profile?.profile_summary ?? null,
        atoms,
        memory: memoryRows.map((m) => ({
          id: m.id,
          fact_id: m.id,
          kind: m.kind,
          content: m.content,
          relevance_score: m.relevance_score,
        })),
        ...(dimensionsBlock ? { dimensions: dimensionsBlock } : {}),
        ...(ledgerDigest ? { ledger_context: ledgerDigest } : {}),
        // Static per-workflow loadouts (issue #1098): lets a deferred-loading
        // harness batch-load a whole workflow cluster in one call. Validated
        // against the tool registry at module init (assertRecommendedLoadoutsValid).
        recommended_tools: RECOMMENDED_WORKFLOW_LOADOUTS.map((w) => ({
          workflow: w.workflow,
          description: w.description,
          skill: w.skill,
          tools: [...w.tools],
        })),
      }
    },
  },




  {
    name: 'gnubok_list_verifikat_without_documents',
    title: 'List Verifikat Missing Documents',
    description: 'List posted verifikat that genuinely lack an underlag: needs-doc source types only, current document versions, user waivers respected. Newest first, paginated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max results to return, 1-100 (default 20)' },
        offset: { type: 'number', description: 'Number of results to skip for pagination (default 0)' },
        since: { type: 'string', description: 'Optional ISO date (YYYY-MM-DD). Only return entries on or after this date.' },
        min_amount: { type: 'number', description: 'Optional minimum gross amount (sum of debits) to filter low-value entries. Default 0.' },
      },
    },
    outputSchema: paginatedSchema('verifikat', {
      type: 'object',
      additionalProperties: false,
      properties: {
        journal_entry_id: { type: 'string' },
        voucher_series: { type: 'string' },
        voucher_number: { type: 'number' },
        entry_date: { type: 'string' },
        description: { type: 'string' },
        source_type: { type: 'string' },
        gross_amount: { type: 'number' },
      },
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
      const offset = Math.max(0, Number(args.offset) || 0)
      const since = typeof args.since === 'string' ? args.since : null
      const minAmount = typeof args.min_amount === 'number' && Number.isFinite(args.min_amount)
        ? Math.max(0, args.min_amount)
        : 0

      // gross_amount is an aggregate over journal_entry_lines, which PostgREST
      // cannot filter on: filtering it in memory after .range() made
      // total_count ignore min_amount and consecutive pages overlap. The RPC
      // filters, counts and paginates in SQL so the total respects the filter
      // and next_offset advances by exactly the rows consumed.
      const { data, error } = await supabase.rpc('verifikat_without_documents', {
        p_company_id: companyId,
        p_since: since,
        p_min_amount: minAmount,
        p_limit: limit,
        p_offset: offset,
      })
      if (error) throw new Error(`Database error: ${error.message}`)

      const result = data as {
        ok: boolean
        code?: string
        total_count?: number
        verifikat?: unknown[]
      } | null
      if (!result?.ok) {
        throw new Error(`verifikat_without_documents failed: ${result?.code ?? 'unknown error'}`)
      }

      const rows = result.verifikat ?? []
      const total = result.total_count ?? 0
      const hasMore = offset + rows.length < total
      return {
        verifikat: rows,
        count: rows.length,
        total_count: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + rows.length } : {}),
      }
    },
  },


  // ── Receipt matcher tool ──────────────────────────────────────


  // ── Customer tools ───────────────────────────────────────────

  {
    name: 'gnubok_list_customers',
    title: 'List Customers',
    description: 'List all customers for the active company. Use to look up customer_id for invoice creation.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customers: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['customers', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, userId, supabase) {
      const { data, error } = await supabase
        .from('customers')
        .select('id, name, customer_type, email, org_number, vat_number, default_payment_terms, city, country')
        .eq('company_id', companyId)
        .order('name')

      if (error) throw new Error(`Database error: ${error.message}`)

      return { customers: data, count: data?.length ?? 0 }
    },
  },

  {
    name: 'gnubok_create_customer',
    title: 'Create Customer',
    description: 'Stage a new customer. Stages for user approval: NOT created until approved in the web app. EU VAT numbers trigger VIES validation.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Customer name' },
        customer_type: {
          type: 'string',
          enum: ['individual', 'swedish_business', 'eu_business', 'non_eu_business'],
          description: 'Customer type',
        },
        email: { type: 'string', description: 'Email address' },
        org_number: { type: 'string', description: 'Swedish org number' },
        vat_number: { type: 'string', description: 'EU VAT number' },
        payment_terms: { type: 'number', description: 'Payment terms in days (default 30)' },
        address: { type: 'string', description: 'Street address' },
        postal_code: { type: 'string' },
        city: { type: 'string' },
        country: { type: 'string', description: 'Country (default Sweden)' },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate inputs and return the would-be preview without staging or creating. No DB writes, no side-effects.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Random per-operation UUID. Repeat calls with the same key + same payload return the original response (24h TTL). Different payload → IDEMPOTENCY_KEY_REUSE error.',
        },
      },
      required: ['name', 'customer_type'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true, // safe to retry with idempotency_key
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const name = args.name as string
      const customerType = args.customer_type as string

      if (!name?.trim()) throw new Error('Customer name is required.')
      if (!['individual', 'swedish_business', 'eu_business', 'non_eu_business'].includes(customerType)) {
        throw new Error('Invalid customer_type. Must be: individual, swedish_business, eu_business, non_eu_business')
      }

      const params = {
        name: name.trim(),
        customer_type: customerType,
        email: (args.email as string) || null,
        org_number: (args.org_number as string) || null,
        vat_number: (args.vat_number as string) || null,
        payment_terms: Number(args.payment_terms) || 30,
        address: (args.address as string) || null,
        postal_code: (args.postal_code as string) || null,
        city: (args.city as string) || null,
        country: (args.country as string) || 'Sweden',
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_customer',
        `Ny kund: ${params.name}`,
        params,
        params, // params ARE the preview for customers
        actor,
        {
          description: 'Once approved, you can invoice this customer with gnubok_create_invoice using the returned customer_id.',
          tool: 'gnubok_create_invoice',
        },
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_update_customer',
    title: 'Update Customer',
    description: 'Stage a partial update to an existing customer. Find customer_id with gnubok_list_customers. Requires approval before customer data is changed.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer_id: { type: 'string', description: 'UUID from gnubok_list_customers.' },
        name: { type: 'string', minLength: 1 },
        customer_type: {
          type: 'string',
          enum: ['individual', 'swedish_business', 'eu_business', 'non_eu_business'],
          description: 'Changing an individual customer to a business type clears its stored personal number.',
        },
        customer_number: { type: ['string', 'null'], maxLength: 32, description: 'Null or empty string clears the customer number.' },
        email: { type: 'string', format: 'email' },
        phone: { type: 'string' },
        address_line1: { type: 'string' },
        address_line2: { type: 'string' },
        postal_code: { type: 'string' },
        city: { type: 'string' },
        country: { type: 'string' },
        org_number: { type: 'string' },
        vat_number: { type: 'string', description: 'EU VAT numbers are revalidated with VIES when the update is approved.' },
        language: { type: 'string', enum: ['sv', 'en'] },
        default_payment_terms: { type: 'integer', minimum: 1 },
        notes: { type: 'string' },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging or changing data.' },
        idempotency_key: { type: 'string', description: 'Random per-operation UUID. Reusing it with the same payload returns the original staged response.' },
      },
      required: ['customer_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    catalogVisibility: 'search',
    async execute(args, companyId, userId, supabase, actor) {
      const changes: Record<string, unknown> = {}
      for (const key of [
        'name',
        'customer_type',
        'customer_number',
        'email',
        'phone',
        'address_line1',
        'address_line2',
        'postal_code',
        'city',
        'country',
        'org_number',
        'vat_number',
        'language',
        'default_payment_terms',
        'notes',
      ]) {
        if (args[key] !== undefined) changes[key] = args[key]
      }

      const parsed = UpdateCustomerParamsSchema.safeParse({
        customer_id: args.customer_id,
        changes,
      })
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(`Invalid customer update: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'validation failed'}`)
      }

      const { data: current, error } = await supabase
        .from('customers')
        .select('id, name, customer_type, customer_number, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, language, default_payment_terms, notes')
        .eq('id', parsed.data.customer_id)
        .eq('company_id', companyId)
        .maybeSingle()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!current) throw new Error('Customer not found.')

      const currentPreview = {
        customer_id: current.id,
        name: current.name,
        customer_type: current.customer_type,
        customer_number: current.customer_number ?? null,
        email: current.email ?? null,
        phone: current.phone ?? null,
        address_line1: current.address_line1 ?? null,
        address_line2: current.address_line2 ?? null,
        postal_code: current.postal_code ?? null,
        city: current.city ?? null,
        country: current.country,
        org_number: current.org_number ?? null,
        vat_number: current.vat_number ?? null,
        vat_number_validated: current.vat_number_validated ?? false,
        language: current.language ?? 'sv',
        default_payment_terms: current.default_payment_terms,
        notes: current.notes ?? null,
      }

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'update_customer',
        `Uppdatera kund: ${current.name}`,
        parsed.data,
        {
          current: currentPreview,
          changes: parsed.data.changes,
          proposed: { ...currentPreview, ...parsed.data.changes },
        },
        actor,
        undefined,
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        },
      )
    },
  },

  // ── Article tools (artikelregister) ──────────────────────────

  {
    name: 'gnubok_list_articles',
    title: 'List Articles',
    description: "List the active company's catalog articles (artikelregister). Use to look up an article to add to an invoice line. Active articles only by default.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive filter on name or article_number.' },
        include_inactive: { type: 'boolean', description: 'Include deactivated articles (default false).' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        articles: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['articles', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let q = supabase
        .from('articles')
        .select('id, article_number, name, name_en, type, unit, price_excl_vat, vat_rate, revenue_account, housework_type, active')
        .eq('company_id', companyId)
      if (!args.include_inactive) q = q.eq('active', true)

      // Strip PostgREST filter metacharacters before interpolating into .or():
      // commas/parens would otherwise let a query inject extra or-conditions, and
      // the ILIKE wildcards % and _ would turn a stray char into a match-all.
      const raw = typeof args.query === 'string' ? args.query : ''
      const safe = raw.replace(/[%_,()\\*]/g, ' ').trim()
      if (safe) {
        q = q.or(`name.ilike.%${safe}%,article_number.ilike.%${safe}%`)
      }

      const { data, error } = await q.order('name')
      if (error) throw new Error(`Database error: ${error.message}`)
      return { articles: data, count: data?.length ?? 0 }
    },
  },

  {
    name: 'gnubok_create_article',
    title: 'Create Article',
    description: 'Stage a new catalog article (artikelregister). Stages for approval: not created until approved. Article number auto-assigned. Reuse on invoice lines via gnubok_create_invoice.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Article name (prints on the invoice line).' },
        type: { type: 'string', enum: ['vara', 'tjanst'], description: 'Good (vara) or service (tjanst). Default tjanst.' },
        unit: { type: 'string', description: 'Unit, e.g. st, tim, kg. Default st.' },
        price_excl_vat: { type: 'number', description: 'Unit price EXCLUDING VAT.' },
        currency: { type: 'string', description: 'Price currency as ISO 4217 code (e.g. EUR). Default SEK. Pre-fills the invoice currency when the article is added.' },
        vat_rate: { type: 'number', enum: [0, 6, 12, 25], description: 'VAT rate percent. Default 25.' },
        revenue_account: { type: 'string', description: 'Optional BAS class-3 revenue account (e.g. 3041). Omit to derive from VAT.' },
        cost_price: { type: 'number', description: 'Optional cost price (margin only; never booked).' },
        ean: { type: 'string', description: 'Barcode / EAN.' },
        housework_type: { type: 'string', description: 'ROT/RUT arbetstyp (services only).' },
        name_en: { type: 'string', description: 'English name for English-language invoices.' },
        notes: { type: 'string' },
        article_number: { type: 'string', description: 'Optional manual number; omit to auto-generate.' },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging.' },
        idempotency_key: { type: 'string', description: 'Per-operation UUID for safe retries (24h TTL).' },
      },
      required: ['name', 'price_excl_vat'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const name = (args.name as string)?.trim()
      if (!name) throw new Error('Article name is required.')
      if (typeof args.price_excl_vat !== 'number') {
        throw new Error('price_excl_vat is required and must be a number.')
      }

      const params: Record<string, unknown> = {
        name,
        type: (args.type as string) || 'tjanst',
        unit: (args.unit as string) || undefined,
        price_excl_vat: args.price_excl_vat,
        currency: (args.currency as string) || undefined,
        vat_rate: typeof args.vat_rate === 'number' ? args.vat_rate : 25,
        revenue_account: (args.revenue_account as string) || null,
        cost_price: typeof args.cost_price === 'number' ? args.cost_price : null,
        ean: (args.ean as string) || null,
        housework_type: (args.housework_type as string) || null,
        name_en: (args.name_en as string) || null,
        notes: (args.notes as string) || null,
        article_number: (args.article_number as string) || null,
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_article',
        `Ny artikel: ${name}`,
        params,
        params, // params ARE the preview
        actor,
        {
          description: 'Once approved, add it to an invoice with gnubok_create_invoice using the returned article fields.',
          tool: 'gnubok_create_invoice',
        },
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_update_article',
    title: 'Update Article',
    description: 'Stage an edit to a catalog article (price, name, account, etc.) or deactivate it via active:false. Stages for approval. Find article_id with gnubok_list_articles.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        article_id: { type: 'string', description: 'UUID of the article to update.' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['vara', 'tjanst'] },
        unit: { type: 'string' },
        price_excl_vat: { type: 'number' },
        currency: { type: 'string', description: 'Price currency as ISO 4217 code (e.g. EUR), or omit to leave unchanged.' },
        vat_rate: { type: 'number', enum: [0, 6, 12, 25] },
        revenue_account: { type: 'string', description: 'BAS class-3 revenue account, or omit to leave unchanged.' },
        cost_price: { type: 'number' },
        ean: { type: 'string' },
        housework_type: { type: 'string' },
        name_en: { type: 'string' },
        notes: { type: 'string' },
        active: { type: 'boolean', description: 'Set false to deactivate (hide from pickers, keep history).' },
        dry_run: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['article_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const articleId = args.article_id as string
      if (!articleId) throw new Error('article_id is required.')

      const params: Record<string, unknown> = { article_id: articleId }
      for (const key of [
        'name', 'type', 'unit', 'price_excl_vat', 'currency', 'vat_rate', 'revenue_account',
        'cost_price', 'ean', 'housework_type', 'name_en', 'notes', 'active',
      ]) {
        if (args[key] !== undefined) params[key] = args[key]
      }

      return stagePendingOperation(supabase, companyId, userId, 'update_article',
        `Uppdatera artikel ${(args.name as string)?.trim() || articleId}`,
        params,
        params,
        actor,
        undefined,
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        }
      )
    },
  },

  // ── Invoice tools ────────────────────────────────────────────

  {
    name: 'gnubok_list_invoices',
    title: 'List Customer Invoices',
    description: 'List invoices for the active company, newest first. Optional status filter.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled', 'credited'],
          description: 'Filter by invoice status',
        },
        limit: { type: 'number', description: 'Max results (default 50, max 100)' },
        offset: { type: 'integer', minimum: 0, description: 'Number of results to skip for pagination (default 0)' },
      },
    },
    outputSchema: paginatedSchema('invoices', { type: 'object' }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 100)
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      const status = args.status as string | undefined

      let query = supabase
        .from('invoices')
        .select('id, invoice_number, status, customer_id, total, currency, invoice_date, due_date, document_type, default_dimensions, customers(name)', { count: 'exact' })
        .eq('company_id', companyId)

      if (status) {
        query = query.eq('status', status)
      }

      const { data, error, count } = await query
        .order('invoice_date', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      const rows = data ?? []
      const invoices = rows.slice(0, limit).map((inv: Record<string, unknown>) => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        status: inv.status,
        customer_name: (inv.customers as Record<string, unknown>)?.name ?? null,
        total: inv.total,
        currency: inv.currency,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        document_type: inv.document_type,
        default_dimensions: inv.default_dimensions ?? {},
      }))

      const hasMore = count == null
        ? rows.length > limit
        : offset + invoices.length < count
      const total = count ?? offset + invoices.length + (hasMore ? 1 : 0)

      return {
        invoices,
        count: invoices.length,
        total_count: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + invoices.length } : {}),
      }
    },
  },

  {
    name: 'gnubok_create_invoice',
    title: 'Create Customer Invoice',
    description: 'Stage a new invoice. Validates inputs, calculates VAT preview. Items accept dims bags. Stages for user approval: invoice number assigned at approval.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer_id: { type: 'string', description: 'Customer UUID' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string', description: 'st, tim, dag, mån' },
              unit_price: { type: 'number', description: 'Price per unit excl. VAT' },
              vat_rate: { type: 'number', description: 'VAT rate 0-100 (optional override)' },
              dimensions: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Dims bag {sie_dim_no: kod eller namn}, e.g. {"6":"P001"}. Wins per key over default_dimensions.',
              },
            },
            required: ['description', 'quantity', 'unit', 'unit_price'],
          },
          description: 'Invoice line items',
        },
        default_dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dims bag keyed by SIE dim no, value = code OR name, e.g. {"1":"KS01","6":"Villa Almgren"}. Applied to every item not setting the key. Unknown values rejected: never auto-created.',
        },
        invoice_date: { type: 'string', description: 'YYYY-MM-DD (default today)' },
        due_date: { type: 'string', description: 'YYYY-MM-DD (default from payment terms)' },
        currency: { type: 'string', enum: ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'] },
        our_reference: { type: 'string' },
        your_reference: { type: 'string' },
        notes: { type: 'string' },
        payment_link_url: {
          type: 'string',
          description: 'Optional https pay link for THIS invoice (e.g. Stripe); rendered in the invoice email and PDF.',
        },
      },
      required: ['customer_id', 'items'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const customerId = args.customer_id as string
      const items = args.items as Array<{
        description: string
        quantity: number
        unit: string
        unit_price: number
        vat_rate?: number
        dimensions?: unknown
      }>

      if (!customerId) throw new Error('customer_id is required. Use gnubok_list_customers to find IDs.')
      if (!items?.length) throw new Error('At least one item is required.')

      for (const [i, item] of items.entries()) {
        if (!item.description?.trim()) throw new Error(`Item ${i + 1}: description is required`)
        if (!item.quantity || item.quantity <= 0) throw new Error(`Item ${i + 1}: quantity must be positive`)
        if (!item.unit?.trim()) throw new Error(`Item ${i + 1}: unit is required (st, tim, dag)`)
        if (item.unit_price == null) throw new Error(`Item ${i + 1}: unit_price is required`)
      }

      // Resolve-don't-select: parse the invoice-level default bag + each item's
      // own bag, then resolve codes AND natural-language names against the
      // registry in ONE pass (zero queries when nothing is tagged; free-text
      // passthrough while dimensions_enabled is off). The resolved default is
      // staged top-level; each item keeps only its own resolved bag: the
      // executor merges item-over-default at commit time.
      const defaultDimensions = parseDimensionsArg(args.default_dimensions, 'default_dimensions')
      const { bags: resolvedDimBags, resolutions: dimensionResolutions } = await resolveDimensionBags(
        supabase,
        companyId,
        [defaultDimensions, ...items.map((item, i) => parseDimensionsArg(item.dimensions, `items[${i}].dimensions`))],
      )
      const resolvedDefaultDimensions = resolvedDimBags[0]
      const stagedItems = items.map((item, i) => {
        const { dimensions: _rawDimensions, ...rest } = item
        const bag = resolvedDimBags[i + 1]
        return bag && Object.keys(bag).length > 0 ? { ...rest, dimensions: bag } : rest
      })

      // Same https-only gate as the web API (CreateInvoiceSchema): the link is
      // rendered in customer-facing emails/PDFs under the company's name.
      const paymentLinkUrl = (args.payment_link_url as string | undefined)?.trim() || null
      if (paymentLinkUrl) {
        let isHttps = false
        try {
          isHttps = new URL(paymentLinkUrl).protocol === 'https:'
        } catch {
          isHttps = false
        }
        if (!isHttps || paymentLinkUrl.length > 2048) {
          throw new Error('payment_link_url must be a valid https URL (max 2048 chars).')
        }
      }

      const today = new Date().toISOString().split('T')[0]
      const currency = ((args.currency as string) || 'SEK') as Currency
      const invoiceDate = (args.invoice_date as string) || today

      // Fetch customer (full row for VAT rules)
      const { data: customer, error: custError } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customerId)
        .eq('company_id', companyId)
        .single()

      if (custError || !customer) {
        throw new Error('Customer not found. Use gnubok_list_customers to find valid IDs.')
      }

      // VAT rules from customer type (same logic as web UI)
      const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated)
      // Gate on the PERMITTED set, not the picker default, exactly like
      // buildInvoiceWriteData and commitCreateInvoice: huvudregeln (ML 6 kap.
      // 34 §) taxes a B2B service where the buyer is established, so 0% is the
      // default for a foreign business; but the ML 6 kap. supplies taxed where
      // they are performed (hotel/restaurang 12%, persontransport and event
      // admission 6%, fastighetstjänst and korttidsuthyrning 25%) carry Swedish
      // VAT even to a German or a US company. Gating on the default made a
      // Stockholm hotel night impossible to invoice through this tool at all.
      // The default is still 0% (vatRules.rate is the fallback below), so a
      // Swedish rate only reaches the staged operation when the agent set it on
      // that line explicitly.
      const permittedRates = getPermittedVatRates(customer.customer_type, customer.vat_number_validated)
      const allowedRates = new Set(permittedRates.map((r) => r.rate))

      // Calculate per-item VAT
      const subtotal = items.reduce((s, item) => s + item.quantity * item.unit_price, 0)
      let vatAmount = 0
      for (const item of items) {
        const itemRate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
        if (!allowedRates.has(itemRate)) {
          throw new Error(
            `VAT rate ${itemRate}% is not allowed for customer type "${customer.customer_type}". ` +
            `Allowed rates: ${permittedRates.map((r) => r.rate + '%').join(', ')}`
          )
        }
        const lineTotal = item.quantity * item.unit_price
        vatAmount += Math.round(lineTotal * itemRate / 100 * 100) / 100
      }
      const total = subtotal + vatAmount

      // Due date from payment terms if not provided
      let dueDate = args.due_date as string | undefined
      if (!dueDate) {
        const d = new Date(invoiceDate)
        d.setDate(d.getDate() + (customer.default_payment_terms || 30))
        dueDate = d.toISOString().split('T')[0]
      }

      // Stage for user approval instead of creating directly
      return stagePendingOperation(supabase, companyId, userId, 'create_invoice',
        `Ny faktura: ${customer.name} ${Math.round(total * 100) / 100} ${currency}`,
        {
          customer_id: customerId,
          items: stagedItems,
          ...(resolvedDefaultDimensions && Object.keys(resolvedDefaultDimensions).length > 0
            ? { default_dimensions: resolvedDefaultDimensions }
            : {}),
          invoice_date: invoiceDate,
          due_date: dueDate,
          currency,
          our_reference: (args.our_reference as string) || null,
          your_reference: (args.your_reference as string) || null,
          notes: (args.notes as string) || null,
          payment_link_url: paymentLinkUrl,
        },
        {
          customer_name: customer.name,
          customer_type: customer.customer_type,
          items: stagedItems.map(item => ({
            ...item,
            line_total: item.quantity * item.unit_price,
            vat_rate: item.vat_rate ?? vatRules.rate,
          })),
          subtotal: Math.round(subtotal * 100) / 100,
          vat_amount: Math.round(vatAmount * 100) / 100,
          total: Math.round(total * 100) / 100,
          currency,
          vat_treatment: vatRules.treatment,
          invoice_date: invoiceDate,
          due_date: dueDate,
          // Echoed for every non-exact dimension resolution (resolve-don't-
          // select) so the agent can verify what a name attached to.
          ...(dimensionResolutions.length > 0 ? { dimension_resolutions: dimensionResolutions } : {}),
        },
        actor,
        {
          description: 'Once approved, the invoice is created as a draft. Send it with gnubok_send_invoice or use gnubok_mark_invoice_as_sent if delivered outside the system.',
          tool: 'gnubok_send_invoice',
        }
      )
    },
  },

  // ── Report tools ─────────────────────────────────────────────

  {
    name: 'gnubok_get_trial_balance',
    title: 'Trial Balance (Råbalans)',
    description: 'Trial balance (huvudbok) for a fiscal period: all account balances with debit/credit totals. Defaults to most recent period. Optional dimensions filter scopes to tagged lines (kostnadsställe/projekt).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
        dimensions: REPORT_DIMENSIONS_FILTER_SCHEMA,
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: { type: 'array', items: { type: 'object' } },
        total_debit: { type: 'number' },
        total_credit: { type: 'number' },
        is_balanced: { type: 'boolean' },
        period_name: { type: 'string' },
        period_start: { type: 'string' },
        period_end: { type: 'string' },
        account_count: { type: 'number' },
        ...DIMENSION_FILTER_OUTPUT_PROPS,
      },
      required: ['rows', 'total_debit', 'total_credit', 'is_balanced'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      // If no period specified, find the most recent one
      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id, name')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first to auto-create a period.')
        }
        periodId = periods.id
      }

      // Get period info
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      // Optional dimensions filter: names resolve to registry codes first
      // (resolve-don't-select), then flow into the generator's jsonb
      // containment filter.
      const dimFilter = await resolveReportDimensionFilter(supabase, companyId, args.dimensions)

      // Delegate to the canonical, paginated trial-balance builder. The
      // previous inline query had no pagination, so PostgREST's 1000-row
      // default silently truncated any period with >1000 entry lines (wrong
      // sums, false "not balanced"), and it ignored opening balances.
      // generateTrialBalance paginates and rolls IB forward.
      const trialBalance = await generateTrialBalance(
        supabase,
        companyId,
        periodId!,
        // Saldobalans is the ledger as posted, resultatavslut included.
        dimFilter.filter
          ? { closingEntry: 'include' as const, dimensions: dimFilter.filter }
          : { closingEntry: 'include' as const },
      )

      const rows = trialBalance.rows
        .map((r) => {
          const net = Math.round((r.closing_debit - r.closing_credit) * 100) / 100
          return {
            account_number: r.account_number,
            account_name: r.account_name,
            period_debit: r.period_debit,
            period_credit: r.period_credit,
            closing_debit: net > 0 ? net : 0,
            closing_credit: net < 0 ? Math.abs(net) : 0,
          }
        })
        .sort((a, b) => a.account_number.localeCompare(b.account_number))

      const totalDebit = Math.round(rows.reduce((s, r) => s + r.closing_debit, 0) * 100) / 100
      const totalCredit = Math.round(rows.reduce((s, r) => s + r.closing_credit, 0) * 100) / 100

      return {
        rows,
        total_debit: totalDebit,
        total_credit: totalCredit,
        is_balanced: Math.abs(totalDebit - totalCredit) < 0.01,
        period_name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        account_count: rows.length,
        ...(dimFilter.filter ? { dimension_filter: dimFilter.filter } : {}),
        ...(dimFilter.resolutions.length > 0 ? { dimension_resolutions: dimFilter.resolutions } : {}),
      }
    },
  },

  {
    name: 'gnubok_get_vat_report',
    title: 'VAT Declaration (Momsdeklaration)',
    description: 'VAT declaration (momsdeklaration, SKV 4700) for a period. Returns all rutor; ruta49 = VAT to pay (positive) or refund (negative). Pass render_ui=true to also open the review widget (claude.ai / Desktop).',
    outputSchema: VAT_REPORT_OUTPUT_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_type: {
          type: 'string',
          enum: ['monthly', 'quarterly', 'yearly'],
          description: 'Period type',
        },
        year: { type: 'number', description: 'Year (e.g. 2025)' },
        period: { type: 'number', description: '1-12 for monthly, 1-4 for quarterly, 1 for yearly' },
        render_ui: {
          type: 'boolean',
          description: 'When true, also render the interactive momsdeklaration review widget (claude.ai / Claude Desktop). The structured rutor are returned either way. Default false.',
        },
      },
      required: ['period_type', 'year', 'period'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // Renders the VAT widget only when the caller passes render_ui=true (the
    // dispatcher emits result-level _meta in that case). This is the merged
    // report+widget surface; gnubok_vat_review_widget remains as an alias.
    uiResourceUri: 'ui://vat-review/app.html',
    async execute(args, companyId, _userId, supabase) {
      return computeVatReport(args, companyId, supabase)
    },
  },

  {
    name: 'gnubok_vat_review_widget',
    title: 'VAT Review Widget',
    description: 'Open the interactive VAT review widget for a period. Equivalent to gnubok_get_vat_report(render_ui=true); kept as an alias for clients pinned to this tool name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_type: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'], description: 'Period type' },
        year: { type: 'number', description: 'Year (e.g. 2025)' },
        period: { type: 'number', description: '1-12 for monthly, 1-4 for quarterly, 1 for yearly' },
      },
      required: ['period_type', 'year', 'period'],
    },
    outputSchema: VAT_REPORT_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { resourceUri: 'ui://vat-review/app.html' } },
    async execute(args, companyId, _userId, supabase) {
      return computeVatReport(args, companyId, supabase)
    },
  },

  {
    name: 'gnubok_vat_close_check',
    title: 'VAT Close Check (Momsdeklaration)',
    description: "Answer 'can I close VAT?' in one call. Returns SKV 4700 rutor, blockers (uncategorized, unapproved supplier invoices, reconciliation diff, missing receipts) plus declaration_checks: the momsdeklaration completeness gate the web filing UI uses. ready_to_close covers both.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_type: { type: 'string', enum: ['monthly', 'quarterly', 'yearly'], description: 'Period type' },
        year: { type: 'number', description: 'Year (e.g. 2026)' },
        period: { type: 'number', description: '1-12 for monthly, 1-4 for quarterly, 1 for yearly' },
      },
      required: ['period_type', 'year', 'period'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: { type: 'object' },
        period_label: { type: 'string' },
        rutor: { type: 'object' },
        payment: {
          type: 'object',
          properties: {
            net_due: { type: 'number' },
            direction: { type: 'string', enum: ['pay', 'refund', 'zero'] },
            deadline: { type: ['string', 'null'] },
            deadline_label: { type: ['string', 'null'] },
            moms_period: { type: ['string', 'null'] },
          },
        },
        blockers: { type: 'array', items: { type: 'object' } },
        declaration_checks: {
          type: 'array',
          items: { type: 'object' },
          description: 'Completeness findings: { code, status, message, rutor }. Any ERROR forces ready_to_close=false.',
        },
        sanity: { type: 'object' },
        ready_to_close: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['period', 'rutor', 'payment', 'blockers', 'declaration_checks', 'sanity', 'ready_to_close', 'summary'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      return computeVatCloseCheck(args, companyId, supabase)
    },
  },

  // ── KPI & Income Statement tools ─────────────────────────────

  {
    name: 'gnubok_get_kpi_report',
    title: 'Business KPI Report',
    description: 'Business KPIs for a fiscal period: gross margin, net result, cash position, receivables, expense ratio, payment days, VAT liability, monthly trend.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first.')
        }
        periodId = periods.id
      }

      // Verify period belongs to user
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      // Run queries in parallel (same as the KPI API route)
      const [incomeStatement, trialBalance, arLedger, monthlyBreakdown, paidInvoices] =
        await Promise.all([
          generateIncomeStatement(supabase, companyId, periodId!),
          generateTrialBalance(supabase, companyId, periodId!, { closingEntry: 'include' }),
          generateARLedger(supabase, companyId),
          generateMonthlyBreakdown(supabase, companyId, periodId!),
          supabase
            .from('invoices')
            .select('invoice_date, paid_at')
            .eq('company_id', companyId)
            .eq('status', 'paid')
            .not('paid_at', 'is', null),
        ])

      const grossMargin = calculateGrossMargin(incomeStatement)
      const cashPosition = calculateCashPosition(trialBalance.rows)
      const expenseRatio = calculateExpenseRatio(incomeStatement)
      const avgPaymentDays = calculateAvgPaymentDays(
        (paidInvoices.data ?? []) as { invoice_date: string; paid_at: string }[]
      )

      // AR ledger uses entries, each with invoices that have outstanding amounts
      const outstandingReceivables = arLedger.total_outstanding
      const overdueReceivables = arLedger.total_overdue

      // VAT liability from trial balance (same accounts as momsdeklaration ruta 49)
      const vatLiability = calculateVatLiability(trialBalance.rows)

      return {
        period_name: period.name,
        period_start: period.period_start,
        period_end: period.period_end,
        gross_margin: grossMargin,
        net_result: incomeStatement.net_result,
        cash_position: cashPosition,
        outstanding_receivables: Math.round(outstandingReceivables * 100) / 100,
        overdue_receivables: Math.round(overdueReceivables * 100) / 100,
        expense_ratio: expenseRatio,
        avg_payment_days: avgPaymentDays,
        paid_invoice_count: paidInvoices.data?.length ?? 0,
        vat_liability: vatLiability,
        total_revenue: incomeStatement.total_revenue,
        total_expenses: incomeStatement.total_expenses,
        months: monthlyBreakdown.months,
      }
    },
  },

  {
    name: 'gnubok_get_income_statement',
    title: 'Income Statement (Resultaträkning)',
    description: 'Income statement (resultaträkning) for a fiscal period: revenue, expenses, net result by account category. Optional dimensions filter scopes to tagged lines (kostnadsställe/projekt).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
        dimensions: REPORT_DIMENSIONS_FILTER_SCHEMA,
      },
    },
    outputSchema: {
      type: 'object',
      properties: { ...DIMENSION_FILTER_OUTPUT_PROPS },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first.')
        }
        periodId = periods.id
      }

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      const dimFilter = await resolveReportDimensionFilter(supabase, companyId, args.dimensions)

      const result = await generateIncomeStatement(
        supabase,
        companyId,
        periodId!,
        dimFilter.filter ? { dimensions: dimFilter.filter } : undefined,
      )
      result.period = { start: period.period_start, end: period.period_end }

      return {
        period_name: period.name,
        ...result,
        ...(dimFilter.filter ? { dimension_filter: dimFilter.filter } : {}),
        ...(dimFilter.resolutions.length > 0 ? { dimension_resolutions: dimFilter.resolutions } : {}),
      }
    },
  },

  // ── Invoice Operations ───────────────────────────────────────

  {
    name: 'gnubok_mark_invoice_as_paid',
    title: 'Mark Invoice as Paid',
    description: 'Mark an invoice as paid and create the payment journal entry. Stages for approval. Status must be sent or overdue.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice' },
        payment_date: { type: 'string', description: 'Payment date YYYY-MM-DD (default: today)' },
        allow_duplicate: { type: 'boolean', description: 'Override the duplicate-payment guard (default false). Set true ONLY after the user confirms; the guard blocks marking paid when an unlinked bank transaction already looks like this invoice\'s payment: match that transaction instead.' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')

      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()

      if (invoiceError || !invoice) throw new Error('Invoice not found')
      if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
        throw new Error('Invoice can only be marked as paid when status is "sent" or "overdue"')
      }

      const paymentDate = (args.payment_date as string) || new Date().toISOString().split('T')[0]

      // Duplicate-payment guard: surface a likely existing bank payment to the
      // agent before staging, so it matches the transaction to the invoice
      // instead of booking a parallel payment voucher (the orphan that later
      // double-counts the receipt). The commit executor re-checks as the hard
      // gate. Mirrors the web mark-paid route's guard.
      if (args.allow_duplicate !== true && invoice.customer?.name) {
        const remainingAmount =
          (invoice as { remaining_amount?: number }).remaining_amount ?? invoice.total
        const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId,
          invoice: {
            invoice_number: invoice.invoice_number,
            customer_name: invoice.customer.name,
            currency: invoice.currency ?? null,
            total: invoice.total ?? null,
            total_sek: invoice.total_sek ?? null,
            exchange_rate: invoice.exchange_rate ?? null,
          },
          // remaining_amount is stored in the invoice currency; the lookup
          // converts it before banding kronor bank rows.
          paymentAmount: remainingAmount,
          paymentDate,
        })
        if (candidates.length > 0) {
          throw new Error(
            `Möjlig dubbelbetalning: en obokförd banktransaktion ser ut att vara betalningen för faktura ` +
            `${invoice.invoice_number}. Anropa igen med allow_duplicate=true om det verkligen är en separat betalning.`,
          )
        }
      }

      return stagePendingOperation(supabase, companyId, userId, 'mark_invoice_paid',
        `Betald: ${invoice.invoice_number} ${invoice.customer?.name || ''} ${invoice.total} ${invoice.currency}`,
        { invoice_id: invoiceId, payment_date: paymentDate, allow_duplicate: args.allow_duplicate === true },
        {
          invoice_number: invoice.invoice_number,
          customer_name: invoice.customer?.name,
          total: invoice.total,
          currency: invoice.currency,
          payment_date: paymentDate,
        },
        actor,
        {
          description: 'Once approved, the payment is booked (15xx → 19xx). Use gnubok_get_ar_ledger to confirm the customer balance reflects it.',
          tool: 'gnubok_get_ar_ledger',
        },
        { dateForPeriodCheck: paymentDate },
      )
    },
  },

  {
    name: 'gnubok_send_invoice',
    title: 'Send Invoice by Email',
    description: 'Send invoice via email with PDF attachment. Stages for approval. Requires customer email + email service configured.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to send' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')

      const emailService = getEmailService()
      if (!emailService.isConfigured()) {
        throw new Error('Email service not configured. Ensure RESEND_API_KEY and RESEND_FROM_EMAIL are set.')
      }

      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()

      if (invoiceError || !invoice) throw new Error('Invoice not found')

      const customer = invoice.customer as Customer
      if (!customer.email) throw new Error('Customer has no email address. Update customer details first.')

      return stagePendingOperation(supabase, companyId, userId, 'send_invoice',
        `Skicka: ${invoice.invoice_number} till ${customer.email}`,
        { invoice_id: invoiceId },
        {
          invoice_number: invoice.invoice_number,
          customer_name: customer.name,
          customer_email: customer.email,
          total: invoice.total,
          currency: invoice.currency,
        },
        actor,
        {
          description: 'After the customer pays, mark the invoice paid via gnubok_mark_invoice_as_paid.',
          tool: 'gnubok_mark_invoice_as_paid',
          args: { invoice_id: invoiceId },
        }
      )
    },
  },

  {
    name: 'gnubok_get_invoice_deliveries',
    title: 'Get Invoice Delivery History',
    description: 'Email delivery attempts for one invoice with the provider outcome (delivered, bounced, complained, delayed, suppressed). Call before chasing an unpaid invoice: a bounce means the customer never received it. Recipients are masked, message content is never returned.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice whose delivery attempts to list' },
      },
      required: ['invoice_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deliveries: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              invoice_delivery_id: { type: 'string' },
              channel: { type: 'string', description: 'email or manual' },
              status: { type: 'string', description: 'Our own send state: pending, sent, failed, marked_sent' },
              provider: { type: ['string', 'null'] },
              provider_status: {
                type: ['string', 'null'],
                description: 'What the receiving server did. NULL means no report yet: accepted by the provider, nothing more.',
              },
              provider_status_at: { type: ['string', 'null'] },
              provider_status_detail: {
                type: ['string', 'null'],
                description: 'Provider reason text for a failure, with address local parts masked.',
              },
              provider_recipient_statuses: {
                type: 'object',
                description: 'PII-free outcomes keyed by stable To/CC positions such as to:1 and cc:1. BCC is never included.',
                additionalProperties: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    status: { type: 'string' },
                    status_at: { type: 'string' },
                  },
                  required: ['status', 'status_at'],
                },
              },
              error_code: { type: ['string', 'null'] },
              to_addresses: {
                type: 'array',
                items: { type: 'string' },
                description: 'Masked to ***@domain: the domain is enough to spot a wrong recipient.',
              },
              cc_addresses: { type: 'array', items: { type: 'string' } },
              attachment_filename: { type: ['string', 'null'] },
              sent_at: { type: ['string', 'null'] },
              failed_at: { type: ['string', 'null'] },
              created_at: { type: 'string' },
            },
            required: ['invoice_delivery_id', 'channel', 'status', 'created_at'],
          },
        },
        count: { type: 'number' },
      },
      required: ['deliveries', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    // Specialized per-invoice diagnostic: keep it out of the default tools/list
    // (context budget, payload-size.bench.test.ts) and let agents chasing an
    // unpaid invoice find it via gnubok_search_tools (delivery, bounce, email).
    catalogVisibility: 'search',
    async execute(args, companyId, userId, supabase) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')

      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .select('id')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (invoiceError) throw new Error(`Database error: ${invoiceError.message}`)
      if (!invoice) throw new Error('Invoice not found')

      // Never read invoice_deliveries directly: the row carries the exact
      // subject, body and BCC of a customer mail. The RPC is the masking
      // boundary (migration 20260727100000), and it is the service-role
      // sibling because MCP has no auth.uid() and routes to the API key's
      // company rather than the user's active one.
      const { data, error } = await supabase.rpc(
        'list_invoice_delivery_summaries_for_service',
        { p_company_id: companyId, p_user_id: userId, p_invoice_id: invoiceId },
      )
      if (error) throw new Error(`Database error: ${error.message}`)

      // Mirrors the RETURNS TABLE of the RPC. body_html, body_text and
      // bcc_addresses are absent by construction, not filtered here.
      const rows = (data ?? []) as Array<{
        id: string
        channel: string
        status: string
        to_addresses: string[] | null
        cc_addresses: string[] | null
        provider: string | null
        provider_status: string | null
        provider_status_at: string | null
        provider_status_detail: string | null
        provider_recipient_statuses: Record<string, { status: string; status_at: string }> | null
        error_code: string | null
        attachment_filename: string | null
        sent_at: string | null
        failed_at: string | null
        created_at: string
      }>
      const deliveries = rows.map((row) => ({
        invoice_delivery_id: row.id,
        channel: row.channel,
        status: row.status,
        provider: row.provider ?? null,
        provider_status: row.provider_status ?? null,
        provider_status_at: row.provider_status_at ?? null,
        provider_status_detail: row.provider_status_detail ?? null,
        provider_recipient_statuses: sanitizeDeliveryRecipientStatuses(
          row.provider_recipient_statuses,
        ),
        error_code: row.error_code ?? null,
        to_addresses: row.to_addresses ?? [],
        cc_addresses: row.cc_addresses ?? [],
        attachment_filename: row.attachment_filename ?? null,
        sent_at: row.sent_at ?? null,
        failed_at: row.failed_at ?? null,
        created_at: row.created_at,
      }))

      return { deliveries, count: deliveries.length }
    },
  },

  {
    name: 'gnubok_mark_invoice_as_sent',
    title: 'Mark Invoice as Sent',
    description: 'Mark a draft invoice as sent without sending email (when delivered manually). Stages for approval. Status must be draft.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the draft invoice' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')

      const { data: invoice, error: invoiceError } = await supabase
        .from('invoices')
        .select('*, customer:customers(*)')
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()

      if (invoiceError || !invoice) throw new Error('Invoice not found')
      if (invoice.status !== 'draft') throw new Error('Only draft invoices can be marked as sent')

      return stagePendingOperation(supabase, companyId, userId, 'mark_invoice_sent',
        `Markera skickad: ${invoice.invoice_number} ${invoice.customer?.name || ''}`,
        { invoice_id: invoiceId },
        {
          invoice_number: invoice.invoice_number,
          customer_name: invoice.customer?.name,
          total: invoice.total,
          currency: invoice.currency,
        },
        actor,
        {
          description: 'Once approved, the invoice moves to "sent". Track its payment via gnubok_mark_invoice_as_paid when the customer pays.',
          tool: 'gnubok_mark_invoice_as_paid',
          args: { invoice_id: invoiceId },
        }
      )
    },
  },

  // ── Supplier Operations (Read-Only) ──────────────────────────

  {
    name: 'gnubok_list_suppliers',
    title: 'List Suppliers (Leverantörer)',
    description: 'List all suppliers (leverantörer) with contact and payment details, sorted by name.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suppliers: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['suppliers', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, userId, supabase) {
      const { data, error } = await supabase
        .from('suppliers')
        .select('id, name, supplier_type, email, phone, org_number, vat_number, default_expense_account, default_payment_terms, default_currency, city, country')
        .eq('company_id', companyId)
        .order('name', { ascending: true })

      if (error) throw new Error(`Database error: ${error.message}`)

      return { suppliers: data ?? [], count: data?.length ?? 0 }
    },
  },

  {
    name: 'gnubok_create_supplier',
    title: 'Create Supplier (Leverantör)',
    description: 'Stage a new supplier (leverantör). Stages for user approval: NOT created until approved in the web app. Use to add a vendor before booking a supplier invoice or matching expenses.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 255, description: 'Supplier name' },
        supplier_type: {
          type: 'string',
          enum: ['swedish_business', 'eu_business', 'non_eu_business'],
          description: 'Supplier type (default swedish_business). eu_business requires vat_number.',
        },
        email: { type: 'string', maxLength: 255, format: 'email', description: 'Email address' },
        phone: { type: 'string', maxLength: 50, description: 'Phone number' },
        org_number: {
          type: 'string',
          maxLength: 20,
          pattern: '^\\d{6}-?\\d{4}$|^\\d{12}$',
          description: 'Swedish org number (10 digits with optional hyphen XXXXXX-XXXX, or 12 digits).',
        },
        vat_number: {
          type: 'string',
          maxLength: 20,
          description: 'EU VAT number with country prefix (e.g. SE556677778800, DE123456789). Required when supplier_type is eu_business.',
        },
        address_line1: { type: 'string', maxLength: 255, description: 'Street address' },
        address_line2: { type: 'string', maxLength: 255 },
        postal_code: { type: 'string', maxLength: 20 },
        city: { type: 'string', maxLength: 100 },
        country: {
          type: 'string',
          maxLength: 2,
          pattern: '^[A-Za-z]{2}$',
          description: 'ISO 3166-1 alpha-2 country code (default SE)',
        },
        bankgiro: {
          type: 'string',
          maxLength: 20,
          pattern: '^\\d{3,4}-?\\d{4}$',
          description: 'Swedish Bankgiro number (7-8 digits with valid Luhn check digit).',
        },
        plusgiro: {
          type: 'string',
          maxLength: 20,
          pattern: '^\\d{1,7}-?\\d{1}$',
          description: 'Swedish Plusgiro number (2-8 digits).',
        },
        bank_account: { type: 'string', maxLength: 50, description: 'Bank account number' },
        iban: {
          type: 'string',
          maxLength: 34,
          pattern: '^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$',
          description: 'IBAN (ISO 13616). Country code + 2 check digits + alphanumeric.',
        },
        bic: {
          type: 'string',
          maxLength: 11,
          pattern: '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$',
          description: 'BIC/SWIFT code (8 or 11 chars).',
        },
        default_expense_account: {
          type: 'string',
          maxLength: 10,
          pattern: '^[4567]\\d{3}$',
          description: '4-digit BAS expense account (class 4, 5, 6, or 7). e.g. "5010".',
        },
        default_payment_terms: {
          type: 'integer',
          minimum: 0,
          maximum: 365,
          description: 'Payment terms in days (default 30). Use 0 for due-on-receipt.',
        },
        default_currency: {
          type: 'string',
          minLength: 3,
          maxLength: 3,
          description: 'Default invoice currency, 3-letter ISO code (default SEK).',
        },
        notes: { type: 'string', maxLength: 2000 },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate inputs and return the would-be preview without staging or creating. No DB writes, no side-effects.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Random per-operation UUID. Repeat calls with the same key + same payload return the original response (24h TTL). Different payload → IDEMPOTENCY_KEY_REUSE error.',
        },
      },
      required: ['name'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      // Server-side validation (defense in depth): MCP transport already
      // checks the JSON Schema, but we re-validate with Zod so financial
      // identifiers (IBAN, BIC, bankgiro Luhn, org_number, VAT format) are
      // rejected at the ingestion boundary rather than persisted.
      // Strip MCP control fields before parsing: the strict schema rejects
      // unknown keys to satisfy ASVS V4.5 field-allow-listing.
      const { dry_run, idempotency_key, ...supplierArgs } = args
      let params
      try {
        params = CreateSupplierParamsSchema.parse(supplierArgs)
      } catch (err) {
        if (err instanceof z.ZodError) {
          const issue = err.issues[0]
          const path = issue?.path?.join('.') ?? 'params'
          throw new Error(`Invalid ${path}: ${issue?.message ?? 'validation failed'}`)
        }
        throw err
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_supplier',
        `Ny leverantör: ${params.name}`,
        params,
        params,
        actor,
        {
          description: 'Once approved, you can book supplier invoices against this supplier with gnubok_create_supplier_invoice_from_inbox using the returned supplier_id.',
          tool: 'gnubok_create_supplier_invoice_from_inbox',
        },
        {
          dryRun: Boolean(dry_run),
          idempotencyKey: typeof idempotency_key === 'string' ? idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_list_supplier_invoices',
    title: 'List Supplier Invoices',
    description: 'List supplier invoices (leverantörsfakturor), sorted by due date. Optional status filter; "to_pay" combines approved+overdue.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          description: 'Filter: registered, approved, overdue, paid, to_pay, all (default)',
          enum: ['registered', 'approved', 'overdue', 'paid', 'to_pay', 'all'],
        },
        limit: { type: 'number', description: 'Max results 1-100 (default 50)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoices: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['invoices', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 100)
      const status = (args.status as string) || 'all'

      let query = supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, invoice_date, due_date, status, total, total_sek, currency, vat_treatment, remaining_amount, default_dimensions, supplier:suppliers(id, name)')
        .eq('company_id', companyId)

      if (status !== 'all') {
        if (status === 'to_pay') {
          query = query.in('status', ['approved', 'overdue'])
        } else {
          query = query.eq('status', status)
        }
      }

      const { data, error } = await query.order('due_date', { ascending: true }).limit(limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      return { invoices: data ?? [], count: data?.length ?? 0 }
    },
  },

  // ── Counterparty Templates & Suggestions ─────────────────────



  // ── Accounts & Chart of Accounts ─────────────────────────────

  {
    name: 'gnubok_list_accounts',
    title: 'List Chart of Accounts (Kontoplan)',
    description: 'List chart of accounts (kontoplan). account_class: 1=assets, 2=liabilities, 3=revenue, 4-7=expenses, 8=financial.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_class: { type: 'number', description: 'Filter by class (1-8)' },
        active_only: { type: 'boolean', description: 'Only active accounts (default: true)' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accounts: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['accounts', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const activeOnly = args.active_only !== false
      const accountClass = args.account_class as number | undefined

      let query = supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, account_class, account_group, account_type, normal_balance, is_active, description')
        .eq('company_id', companyId)
        .order('sort_order')

      if (activeOnly) query = query.eq('is_active', true)
      if (accountClass !== undefined) query = query.eq('account_class', accountClass)

      const { data, error } = await query

      if (error) throw new Error(`Database error: ${error.message}`)

      return { accounts: data ?? [], count: data?.length ?? 0 }
    },
  },

  {
    name: 'gnubok_create_account',
    title: 'Create Account (Kontoplan)',
    description: 'Stage a new kontoplan account. BAS 2026 numbers prefill name/type/SRU (overrides win); custom numbers need account_name, account_type, normal_balance. Inactive existing account? Use gnubok_update_account instead.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_number: { type: 'string', description: '4-digit number, e.g. "5410".' },
        account_name: { type: 'string', description: 'Optional for BAS numbers (prefilled).' },
        account_type: {
          type: 'string',
          enum: ['asset', 'equity', 'liability', 'revenue', 'expense', 'untaxed_reserves'],
          description: 'Required for non-BAS numbers. untaxed_reserves only for 21xx (obeskattade reserver).',
        },
        normal_balance: {
          type: 'string',
          enum: ['debit', 'credit'],
          description: 'Required for non-BAS numbers.',
        },
        description: { type: 'string' },
        default_vat_code: { type: 'string' },
        default_vat_rate: { type: 'number', enum: [0, 0.06, 0.12, 0.25], description: 'Fraction (0.25 = 25%). Livsmedel: 0.06 from 2026-04-01 (temporary cut from 0.12, reverts 2027-12-31).' },
        sru_code: { type: 'string', description: 'Prefilled for BAS numbers.' },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging.' },
        idempotency_key: { type: 'string', description: 'Per-operation UUID for safe retries (24h TTL).' },
      },
      required: ['account_number'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const accountNumber = String(args.account_number ?? '').trim()
      if (!/^\d{4}$/.test(accountNumber)) {
        throw new Error('account_number must be exactly 4 digits, e.g. "5410".')
      }

      // Fail fast on numbers already in this company's chart so the approver
      // is never shown a create that would 409 at commit time.
      const { data: existing, error: existingErr } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, is_active')
        .eq('company_id', companyId)
        .eq('account_number', accountNumber)
        .maybeSingle()
      if (existingErr) throw new Error(`Database error: ${existingErr.message}`)
      if (existing) {
        throw new Error(
          existing.is_active
            ? `Konto ${accountNumber} (${existing.account_name}) finns redan i kontoplanen. Ändra det med gnubok_update_account.`
            : `Konto ${accountNumber} (${existing.account_name}) finns men är inaktivt. Aktivera det med gnubok_update_account (is_active=true).`,
        )
      }

      // Resolve-don't-guess: BAS 2026 catalog fills the gaps; explicit args win.
      const ref = getBASReference(accountNumber)
      const name = String(args.account_name ?? '').trim() || ref?.account_name
      const accountType = (args.account_type as string | undefined) ?? ref?.account_type
      const normalBalance = (args.normal_balance as string | undefined) ?? ref?.normal_balance
      if (!name || !accountType || !normalBalance) {
        throw new Error(
          `${accountNumber} is not in the BAS 2026 catalog: account_name, account_type and normal_balance are required for custom accounts.`,
        )
      }
      // Runtime guard (hosts don't always enforce inputSchema enums).
      if (!['asset', 'equity', 'liability', 'revenue', 'expense', 'untaxed_reserves'].includes(accountType)) {
        throw new Error('account_type must be one of: asset, equity, liability, revenue, expense, untaxed_reserves')
      }
      if (!['debit', 'credit'].includes(normalBalance)) {
        throw new Error('normal_balance must be debit or credit')
      }
      // Fail fast on a class/type contradiction (e.g. 2999 + expense): the
      // commit executor derives account_class from the first digit, so an
      // inconsistent pair would misclassify balance sheet vs income statement.
      const classConflict = accountClassTypeConflict(accountNumber, accountType)
      if (classConflict) throw new Error(classConflict)
      const vatRate = args.default_vat_rate as number | undefined
      if (vatRate !== undefined && ![0, 0.06, 0.12, 0.25].includes(vatRate)) {
        throw new Error('default_vat_rate must be one of 0, 0.06, 0.12, 0.25 (fraction, not percent)')
      }

      const params: Record<string, unknown> = {
        account_number: accountNumber,
        account_name: name,
        account_type: accountType,
        normal_balance: normalBalance,
        plan_type: ref ? 'full_bas' : 'k1',
        description: String(args.description ?? '').trim() || ref?.description || undefined,
        default_vat_code: String(args.default_vat_code ?? '').trim() || undefined,
        default_vat_rate: vatRate,
        sru_code: String(args.sru_code ?? '').trim() || ref?.sru_code || undefined,
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_account',
        `Nytt konto: ${accountNumber} ${name}`,
        params,
        { ...params, source: ref ? 'bas_2026' : 'custom' },
        actor,
        {
          description: 'Once approved, the account is active and can carry voucher lines via gnubok_create_voucher.',
          tool: 'gnubok_list_accounts',
        },
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_update_account',
    title: 'Update Account (Kontoplan)',
    description: 'Stage an edit to a kontoplan account: rename, description, default VAT, SRU code, or activate/deactivate via is_active. Stages for approval. Find accounts with gnubok_list_accounts.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_number: { type: 'string', description: '4-digit number of the account to update.' },
        account_name: { type: 'string' },
        description: { type: 'string' },
        default_vat_code: { type: 'string' },
        default_vat_rate: { type: 'number', enum: [0, 0.06, 0.12, 0.25], description: 'Default VAT rate as a fraction (0.25 = 25%). Livsmedel: 0.06 from 2026-04-01 (temporary cut from 0.12, reverts 2027-12-31).' },
        sru_code: { type: 'string' },
        is_active: { type: 'boolean', description: 'false deactivates (hides from pickers, keeps history); true (re)activates.' },
        dry_run: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['account_number'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const accountNumber = String(args.account_number ?? '').trim()
      if (!/^\d{4}$/.test(accountNumber)) {
        throw new Error('account_number must be exactly 4 digits, e.g. "5410".')
      }

      const { data: current, error: fetchErr } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, description, default_vat_code, default_vat_rate, sru_code, is_active')
        .eq('company_id', companyId)
        .eq('account_number', accountNumber)
        .maybeSingle()
      if (fetchErr) throw new Error(`Database error: ${fetchErr.message}`)
      if (!current) {
        throw new Error(`Konto ${accountNumber} finns inte i kontoplanen. Skapa det med gnubok_create_account.`)
      }

      const vatRate = args.default_vat_rate as number | undefined
      if (vatRate !== undefined && ![0, 0.06, 0.12, 0.25].includes(vatRate)) {
        throw new Error('default_vat_rate must be one of 0, 0.06, 0.12, 0.25 (fraction, not percent)')
      }

      const params: Record<string, unknown> = { account_number: accountNumber }
      const changes: Record<string, unknown> = {}
      for (const key of ['account_name', 'description', 'default_vat_code', 'default_vat_rate', 'sru_code', 'is_active']) {
        if (args[key] !== undefined) {
          params[key] = args[key]
          changes[key] = args[key]
        }
      }
      if (Object.keys(changes).length === 0) {
        throw new Error('Nothing to update: pass at least one of account_name, description, default_vat_code, default_vat_rate, sru_code, is_active.')
      }

      return stagePendingOperation(supabase, companyId, userId, 'update_account',
        `Uppdatera konto ${accountNumber} ${current.account_name}`,
        params,
        { account_number: accountNumber, current, changes },
        actor,
        undefined,
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        }
      )
    },
  },

  // ── Dimensions (kostnadsställe/projekt) ──────────────────────

  {
    name: 'gnubok_list_dimensions',
    title: 'List Dimensions (Kostnadsställe/Projekt)',
    description: 'List the dimension registry with values: 1 = kostnadsställe, 6 = projekt, plus custom dims. Call before tagging voucher lines via the dimensions bag on gnubok_create_voucher. System dims are seeded on first call.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimensions: {
          type: 'array',
          description: 'Registry entries keyed by sie_dim_no (the dims-bag key), each with its values. code = what goes in the bag; is_active false = archived (unusable on new lines).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Deprecated: read dimension_id instead' },
              dimension_id: { type: 'string' },
              sie_dim_no: { type: 'number' },
              name: { type: 'string' },
              resets_annually: { type: 'boolean' },
              is_system: { type: 'boolean' },
              is_active: { type: 'boolean' },
              sort_order: { type: 'number' },
              values: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', description: 'Deprecated: read dimension_value_id instead' },
                    dimension_value_id: { type: 'string' },
                    code: { type: 'string' },
                    name: { type: 'string' },
                    is_active: { type: 'boolean' },
                    start_date: { type: ['string', 'null'] },
                    end_date: { type: ['string', 'null'] },
                  },
                  required: ['id', 'dimension_value_id', 'code', 'name', 'is_active', 'start_date', 'end_date'],
                },
              },
            },
            required: ['id', 'dimension_id', 'sie_dim_no', 'name', 'resets_annually', 'is_system', 'is_active', 'sort_order', 'values'],
          },
        },
      },
      required: ['dimensions'],
    },
    annotations: {
      // The lazy ensure_company_dimensions seed is an idempotent get-or-create
      // of the two system registry rows: semantically a read (the dashboard
      // GET /api/dimensions does the same).
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, _userId, supabase) {
      await ensureCompanyDimensions(supabase, companyId)
      const dimensions = await fetchDimensionRegistry(supabase, companyId)
      return {
        dimensions: dimensions.map((d) => ({
          ...d,
          dimension_id: d.id,
          values: d.values.map((v) => ({ ...v, dimension_value_id: v.id })),
        })),
      }
    },
  },

  {
    name: 'gnubok_list_dimension_values',
    title: 'List Dimension Values',
    description: 'List values (SIE #OBJEKT codes) for one dimension, optionally fuzzy-matched by query. Use to find the right kostnadsställe/projekt code before tagging lines. sie_dim_no: 1 = kostnadsställe, 6 = projekt.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sie_dim_no: { type: 'number', description: '1 = kostnadsställe, 6 = projekt, or a custom dim from gnubok_list_dimensions.' },
        query: { type: 'string', description: 'Optional fuzzy search over code + name, ranked by confidence.' },
        include_inactive: { type: 'boolean', description: 'Include archived values (default false).' },
        limit: { type: 'number', description: 'Max results, 1-200 (default 50).' },
      },
      required: ['sie_dim_no'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimension: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Deprecated: read dimension_id instead' },
            dimension_id: { type: 'string' },
            sie_dim_no: { type: 'number' },
            name: { type: 'string' },
            resets_annually: { type: 'boolean' },
            is_active: { type: 'boolean' },
          },
          required: ['id', 'dimension_id', 'sie_dim_no', 'name', 'resets_annually', 'is_active'],
        },
        values: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Deprecated: read dimension_value_id instead' },
              dimension_value_id: { type: 'string' },
              code: { type: 'string' },
              name: { type: 'string' },
              is_active: { type: 'boolean' },
              start_date: { type: ['string', 'null'] },
              end_date: { type: ['string', 'null'] },
              confidence: { type: 'number', description: 'Fuzzy confidence 0-1; present only with query.' },
            },
            required: ['id', 'dimension_value_id', 'code', 'name', 'is_active', 'start_date', 'end_date'],
          },
        },
        count: { type: 'number' },
      },
      required: ['dimension', 'values', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const sieDimNo = Number(args.sie_dim_no)
      if (!Number.isInteger(sieDimNo) || sieDimNo < 1) {
        throw new Error('sie_dim_no must be a positive integer SIE dimension number (1 = kostnadsställe, 6 = projekt).')
      }
      const includeInactive = args.include_inactive === true
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 200)
      const query = typeof args.query === 'string' ? args.query.trim() : ''

      await ensureCompanyDimensions(supabase, companyId)

      const { data: dimension, error: dimError } = await supabase
        .from('dimensions')
        .select('id, sie_dim_no, name, resets_annually, is_active')
        .eq('company_id', companyId)
        .eq('sie_dim_no', sieDimNo)
        .maybeSingle()
      if (dimError) throw new Error(`Database error: ${dimError.message}`)
      if (!dimension) {
        throw new Error(
          `Dimension ${sieDimNo} finns inte i registret. Anropa gnubok_list_dimensions för att se registrerade dimensioner.`,
        )
      }

      let valuesQuery = supabase
        .from('dimension_values')
        .select('id, code, name, is_active, start_date, end_date')
        .eq('company_id', companyId)
        .eq('dimension_id', dimension.id)
        .order('code', { ascending: true })
      if (!includeInactive) valuesQuery = valuesQuery.eq('is_active', true)

      const { data: rows, error: valuesError } = await valuesQuery
      if (valuesError) throw new Error(`Database error: ${valuesError.message}`)
      const all = (rows ?? []) as Array<{
        id: string
        code: string
        name: string
        is_active: boolean
        start_date: string | null
        end_date: string | null
      }>

      const qualifiedDimension = { ...dimension, dimension_id: dimension.id }

      if (!query) {
        const values = all.slice(0, limit).map((v) => ({ ...v, dimension_value_id: v.id }))
        return { dimension: qualifiedDimension, values, count: values.length }
      }

      // Fuzzy ranking: same fuse.js setup as the resolve step so what this
      // tool shows matches what a dims bag would resolve to.
      const fuse = new Fuse(all, { keys: ['code', 'name'], includeScore: true, threshold: 0.4 })
      const values = fuse
        .search(query)
        .slice(0, limit)
        .map((hit) => ({
          ...hit.item,
          dimension_value_id: hit.item.id,
          confidence: roundOre(1 - (hit.score ?? 1)),
        }))
      return { dimension: qualifiedDimension, values, count: values.length }
    },
  },

  {
    name: 'gnubok_create_dimension_value',
    title: 'Create Dimension Value',
    description: 'Stage a new dimension value (kostnadsställe/projekt object code, SIE #OBJEKT) for user approval: agents never silently mint reporting values. Use when a dims-bag value has no registry match. sie_dim_no: 1 = kostnadsställe, 6 = projekt.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sie_dim_no: { type: 'number', description: '1 = kostnadsställe, 6 = projekt, or a custom dim.' },
        code: {
          type: 'string',
          maxLength: 20,
          pattern: '^[A-Za-z0-9\\u00C5\\u00C4\\u00D6\\u00E5\\u00E4\\u00F6_+\\-]{1,20}$',
          description: 'Object code, strict Fortnox format: letters A-Ö, digits, _, + and -. Immutable after creation.',
        },
        name: { type: 'string', maxLength: 120, description: 'Human-readable name shown in registers and reports.' },
        start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Optional ISO start date; only on accumulating dims (projekt).' },
        end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Optional ISO end date ≥ start_date; only on accumulating dims.' },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate inputs and return the would-be preview without staging. No DB writes, no side-effects.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Random per-operation UUID. Repeat calls with the same key + same payload return the original response (24h TTL). Different payload → IDEMPOTENCY_KEY_REUSE error.',
        },
      },
      required: ['sie_dim_no', 'code', 'name'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      // Strip MCP control fields, then re-validate with the same Zod schema
      // the commit executor uses (defense in depth, mirrors create_supplier).
      const { dry_run, idempotency_key, ...valueArgs } = args
      let params
      try {
        params = CreateDimensionValueParamsSchema.parse(valueArgs)
      } catch (err) {
        if (err instanceof z.ZodError) {
          const issue = err.issues[0]
          const path = issue?.path?.join('.') ?? 'params'
          throw new Error(`Invalid ${path}: ${issue?.message ?? 'validation failed'}`)
        }
        throw err
      }

      await ensureCompanyDimensions(supabase, companyId)

      // Pre-flight for a tight agent feedback loop; the executor re-checks all
      // of this at commit time (the staged row is never trusted).
      const { data: dimension, error: dimError } = await supabase
        .from('dimensions')
        .select('id, sie_dim_no, name, resets_annually')
        .eq('company_id', companyId)
        .eq('sie_dim_no', params.sie_dim_no)
        .maybeSingle()
      if (dimError) throw new Error(`Database error: ${dimError.message}`)
      if (!dimension) {
        throw new Error(
          `Okänd dimension ${params.sie_dim_no}. Endast registrerade dimensioner kan få nya värden: ` +
          'anropa gnubok_list_dimensions (1 = kostnadsställe och 6 = projekt skapas automatiskt).',
        )
      }
      if (dimension.resets_annually && (params.start_date || params.end_date)) {
        throw new Error(
          `Start-/slutdatum är inte tillåtna på dimensionen "${dimension.name}" (nollställs årligen).`,
        )
      }

      const { data: existing, error: existingError } = await supabase
        .from('dimension_values')
        .select('id, code, name, is_active')
        .eq('company_id', companyId)
        .eq('dimension_id', dimension.id)
        .eq('code', params.code)
        .maybeSingle()
      if (existingError) throw new Error(`Database error: ${existingError.message}`)
      if (existing?.is_active) {
        throw new Error(
          `Värdet "${params.code}" (${existing.name}) finns redan i ${dimension.name}: använd koden direkt i dimensions-baggen.`,
        )
      }
      if (existing) {
        throw new Error(
          `"${params.code}" är arkiverat: återaktivera värdet i registret för att använda det.`,
        )
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_dimension_value',
        `Nytt värde i ${dimension.name}: ${params.code} - ${params.name}`,
        params,
        {
          sie_dim_no: dimension.sie_dim_no,
          dimension_name: dimension.name,
          code: params.code,
          name: params.name,
          start_date: params.start_date ?? null,
          end_date: params.end_date ?? null,
          will: 'create the value in the dimension registry so lines can be tagged with it',
        },
        actor,
        {
          description: 'Once approved, tag voucher lines with the new code via the dimensions bag on gnubok_create_voucher, or verify it with gnubok_list_dimension_values.',
          tool: 'gnubok_list_dimension_values',
          args: { sie_dim_no: dimension.sie_dim_no },
        },
        {
          dryRun: Boolean(dry_run),
          idempotencyKey: typeof idempotency_key === 'string' ? idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_tag_journal_lines',
    title: 'Tag Journal Lines (Bulk Retag)',
    description: "Bulk-tag POSTED journal lines with dimensions (kostnadsställe/projekt) selected by a filter block, e.g. all 4010 lines with 'Bygg AB' in 2024 → P01. Stages for approval; max 500 lines. Retags internal reporting only: the verifikat stays immutable, every change logged.",
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dimensions bag applied to every matched line, REPLACING its current bag: {"<sie_dim_no>":"<kod eller namn>"}, e.g. {"6":"P01"}. Values may be registry codes or names: resolved server-side (resolve-don\'t-select).',
        },
        reason: {
          type: 'string',
          minLength: 3,
          maxLength: 500,
          description: 'Why the lines are retagged: stored per line in the immutable dimension_retag_log.',
        },
        filters: {
          type: 'object',
          additionalProperties: false,
          description: 'Line selection: at least one filter required. Preview the match set with gnubok_query_journal (same filter fields) first.',
          properties: {
            account_from: { type: 'string', description: 'Lowest account number (inclusive), e.g. "4010".' },
            account_to: { type: 'string', description: 'Highest account number (inclusive).' },
            accounts: { type: 'array', items: { type: 'string' }, description: 'Specific account numbers (overrides account_from/account_to). Up to 50.' },
            date_from: { type: 'string', description: 'Earliest entry date (YYYY-MM-DD, inclusive).' },
            date_to: { type: 'string', description: 'Latest entry date (YYYY-MM-DD, inclusive).' },
            text: { type: 'string', maxLength: 200, description: 'Case-insensitive substring match on the ENTRY description (verifikattext): line descriptions are not searched.' },
            only_untagged: { type: 'boolean', description: 'Only lines whose dimensions bag is exactly empty ({}). Lines already carrying ANY dimension are excluded: partially tagged lines do not match.' },
          },
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, validate inputs and return the would-be preview without staging. No DB writes, no side-effects.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Random per-operation UUID. Repeat calls with the same key + same payload return the original response (24h TTL). Different payload → IDEMPOTENCY_KEY_REUSE error.',
        },
      },
      required: ['dimensions', 'reason', 'filters'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const { dry_run, idempotency_key } = args

      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (reason.length < 3 || reason.length > 500) {
        throw new Error('reason must be 3-500 characters: it is stored in the immutable dimension_retag_log.')
      }

      const inputBag = parseDimensionsArg(args.dimensions, 'dimensions')
      if (!inputBag) {
        throw new Error('dimensions must contain at least one {"<sie_dim_no>":"<kod eller namn>"} pair, e.g. {"6":"P01"}.')
      }

      // ── Filters: validated before any DB work so bad input fails fast.
      const filters = (args.filters && typeof args.filters === 'object' ? args.filters : {}) as Record<string, unknown>
      const accounts = Array.isArray(filters.accounts) ? (filters.accounts as string[]) : undefined
      if (accounts && accounts.length > 50) {
        throw new Error('filters.accounts is capped at 50: use account_from/account_to for ranges')
      }
      const accountFrom = typeof filters.account_from === 'string' ? filters.account_from : undefined
      const accountTo = typeof filters.account_to === 'string' ? filters.account_to : undefined
      const dateFrom = typeof filters.date_from === 'string' ? filters.date_from : undefined
      const dateTo = typeof filters.date_to === 'string' ? filters.date_to : undefined
      const text = typeof filters.text === 'string' ? filters.text.trim() : ''
      if (text.length > 200) {
        throw new Error('filters.text must be 200 characters or shorter')
      }
      const onlyUntagged = filters.only_untagged === true

      const hasFilter = Boolean(
        (accounts && accounts.length > 0) || accountFrom || accountTo || dateFrom || dateTo || text || onlyUntagged,
      )
      if (!hasFilter) {
        throw new Error(
          'Ange minst ett filter (konto, datum, text eller only_untagged): en företagsbred omtaggning måste avgränsas. ' +
          'Förhandsgranska träffmängden med gnubok_query_journal.',
        )
      }

      // ── Resolve the bag (names → registry codes; resolve-don't-select).
      //    DimensionResolutionError propagates with candidates/create-first
      //    guidance: nothing unresolved is ever staged.
      const { bags, resolutions } = await resolveDimensionBags(supabase, companyId, [inputBag])
      const resolvedBag = bags[0] as Record<string, string>

      // ── Match the lines. POSTED entries only: drafts are edited directly
      //    (the retag RPC rejects them too).
      type MatchedRow = {
        id: string
        account_number: string
        debit_amount: number
        credit_amount: number
        sort_order: number
        journal_entries: { id: string; entry_date: string; voucher_number: number; voucher_series: string }
      }

      // Two-step fetch (lib/bookkeeping/entry-lines.ts) instead of a
      // `journal_entries!inner` embed, which PostgREST compiled into a
      // correlated LATERAL join over every tenant's journal_entry_lines.
      // The DB-side `.limit(RETAG_MAX_LINES + 1)` is replaced by the JS
      // overflow check below: the cap counts MATCHED lines, and the old
      // limit could not be expressed across the two steps.
      //
      // BOUNDED: entries are paged and their lines fetched chunk by chunk,
      // and the whole walk STOPS as soon as the accumulated line count
      // exceeds RETAG_MAX_LINES: the overflow check below then throws the
      // same ">500 rader" error either way. Without the short-circuit,
      // `only_untagged: true` alone (a valid filter per the guard above) on a
      // large ledger materialized every matching line first: hundreds of
      // round-trips just to throw. fetchLinesByEntryIds is the same shared
      // chunked helper fetchEntryLines drives; only the loop around it is
      // local so it can bail early.
      const filterEntries = (eq: EntryLinesQuery) => {
        let e = eq.eq('company_id', companyId).eq('status', 'posted')
        if (dateFrom) e = e.gte('entry_date', dateFrom)
        if (dateTo) e = e.lte('entry_date', dateTo)
        if (text) {
          // LIKE wildcards escaped so the filter matches literal % / _:
          // same treatment as gnubok_query_journal's text legs. v1
          // searches the ENTRY description only (documented in the
          // schema); the two-leg line+entry union query_journal runs is
          // overkill for a write filter.
          //
          // Backslash is escaped FIRST, and the order matters: `\` is LIKE's
          // own escape character, so an unescaped one in the search term
          // swallows the character after it (searching `a\b` matched rows
          // containing `ab`). Escaping it last would instead double the
          // backslashes the % / _ rules just added.
          const escaped = text
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_')
          e = e.ilike('description', `%${escaped}%`)
        }
        return e
      }
      const filterLines = (lq: EntryLinesQuery) => {
        let l = lq
        if (accounts && accounts.length > 0) {
          l = l.in('account_number', accounts)
        } else {
          if (accountFrom) l = l.gte('account_number', accountFrom)
          if (accountTo) l = l.lte('account_number', accountTo)
        }
        // Pragmatic v1 (documented in the schema): only-untagged means the
        // bag is EXACTLY '{}' (column is NOT NULL DEFAULT '{}'). Partially
        // tagged lines (e.g. only dim 1 set) do not match.
        if (onlyUntagged) l = l.filter('dimensions', 'eq', '{}')
        return l
      }

      /** journal_entries page size (PostgREST's own cap). */
      const ENTRY_PAGE_SIZE = 1000
      /** Entry ids per fetchLinesByEntryIds call: its own chunk width, so each
       *  call is exactly one `.in()` query and the early-stop check runs
       *  between every query rather than after a large batch. */
      const LINE_CHUNK_SIZE = 100

      type EntryRow = {
        id: string
        entry_date: string
        voucher_number: number
        voucher_series: string
      }
      type BareLineRow = {
        id: string
        journal_entry_id: string
        account_number: string
        debit_amount: number
        credit_amount: number
        sort_order: number
      }

      const rows: MatchedRow[] = []
      try {
        const seenEntryIds = new Set<string>()
        let entryFrom = 0
        paging: while (true) {
          const { data: entryPage, error: entryError } = await filterEntries(
            supabase
              .from('journal_entries')
              .select('id, entry_date, voucher_number, voucher_series, status'),
          )
            // Stable total order on the PK for correct paging (same invariant
            // as lib/supabase/fetch-all.ts).
            .order('id', { ascending: true })
            .range(entryFrom, entryFrom + ENTRY_PAGE_SIZE - 1)
          if (entryError) throw new Error(entryError.message)

          const pageEntries = ((entryPage ?? []) as EntryRow[]).filter(
            (e) => !seenEntryIds.has(e.id),
          )
          for (const e of pageEntries) seenEntryIds.add(e.id)
          const entryById = new Map(pageEntries.map((e) => [e.id, e]))

          for (let i = 0; i < pageEntries.length; i += LINE_CHUNK_SIZE) {
            const chunkIds = pageEntries.slice(i, i + LINE_CHUNK_SIZE).map((e) => e.id)
            const chunkLines = await fetchLinesByEntryIds<BareLineRow>(
              supabase,
              chunkIds,
              'id, account_number, debit_amount, credit_amount, sort_order',
              filterLines,
            )
            for (const line of chunkLines) {
              const parent = entryById.get(line.journal_entry_id)
              if (!parent) continue
              rows.push({ ...line, journal_entries: parent } as MatchedRow)
            }
            // Short-circuit: one line past the cap already decides the
            // outcome, so stop fetching instead of walking the rest of the
            // match set.
            if (rows.length > RETAG_MAX_LINES) break paging
          }

          if (!entryPage || entryPage.length < ENTRY_PAGE_SIZE) break
          entryFrom += ENTRY_PAGE_SIZE
        }
      } catch (err) {
        log.warn('tag_journal_lines match query failed', {
          companyId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
        throw new Error('Database error while matching journal lines')
      }

      // Verifikat-major preview order, newest first, then line order inside
      // the voucher. Done in JS: the sort keys live on the parent entry and
      // PostgREST's `.order(col, { foreignTable })` sorts the EMBEDDED rows,
      // not the parent result set.
      rows.sort((a, b) => {
        const ad = a.journal_entries.entry_date
        const bd = b.journal_entries.entry_date
        if (ad !== bd) return ad < bd ? 1 : -1
        const av = a.journal_entries.voucher_number
        const bv = b.journal_entries.voucher_number
        if (av !== bv) return bv - av
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })

      if (rows.length === 0) {
        throw new Error(
          'Inga bokförda rader matchade filtret. Kontrollera konto/datum/text: förhandsgranska med gnubok_query_journal (samma filterfält).',
        )
      }
      if (rows.length > RETAG_MAX_LINES) {
        throw new Error(
          `Filtret matchar fler än ${RETAG_MAX_LINES} rader: snäva av det (kortare datumintervall, färre konton) och kör i omgångar om högst ${RETAG_MAX_LINES}.`,
        )
      }

      // Human description of the selection, carried on the op for the
      // approval preview (the executor acts on line_ids verbatim).
      const summaryParts: string[] = []
      if (accounts && accounts.length > 0) summaryParts.push(`konto ${accounts.join(', ')}`)
      else if (accountFrom || accountTo) summaryParts.push(`konto ${accountFrom ?? '…'}-${accountTo ?? '…'}`)
      if (dateFrom || dateTo) summaryParts.push(`datum ${dateFrom ?? '…'}-${dateTo ?? '…'}`)
      if (text) summaryParts.push(`text "${text}"`)
      if (onlyUntagged) summaryParts.push('endast otaggade rader')
      const filterSummary = summaryParts.join(', ').slice(0, 500)

      const bagLabel = Object.entries(resolvedBag)
        .map(([dim, code]) => `${dim}=${code}`)
        .join(', ')

      // Same Zod schema the commit executor re-validates with: the staged
      // params can never drift from what commitRetagLineDimensions accepts.
      const params = RetagLineDimensionsParamsSchema.parse({
        line_ids: rows.map((r) => r.id),
        dimensions: resolvedBag,
        reason,
        filter_summary: filterSummary,
      })

      // No dateForPeriodCheck: the matched lines span dates; the retag RPC
      // enforces open-period + lock-date per line at commit time.
      return stagePendingOperation(supabase, companyId, userId, 'retag_line_dimensions',
        `Tagga om ${rows.length} verifikationsrader: ${bagLabel}`,
        params as unknown as Record<string, unknown>,
        {
          matched_lines: rows.length,
          dimensions: resolvedBag,
          filter_summary: filterSummary,
          sample: rows.slice(0, 10).map((r) => ({
            account: r.account_number,
            date: r.journal_entries.entry_date,
            debit: r.debit_amount,
            credit: r.credit_amount,
          })),
          ...(resolutions.length > 0 ? { dimension_resolutions: resolutions } : {}),
          will: 'replace the dimensions bag on every matched POSTED line via the audited retag RPC: internal reporting only, the verifikat itself is untouched',
        },
        actor,
        {
          description: 'After approval, verify the retag with gnubok_query_journal (group_by_dimension) or gnubok_get_dimension_pnl.',
          tool: 'gnubok_query_journal',
          args: { group_by_dimension: Object.keys(resolvedBag)[0] },
        },
        {
          dryRun: Boolean(dry_run),
          idempotencyKey: typeof idempotency_key === 'string' ? idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_get_dimension_pnl',
    title: 'P&L per Dimension (Resultat per projekt)',
    description: 'Resultat per projekt/kostnadsställe: P&L matrix over one SIE dimension: each value with activity becomes a column plus an untagged bucket, and the Totalt column reconciles exactly with the resultatrapport. sie_dim_no: 1 = kostnadsställe, 6 = projekt.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sie_dim_no: { type: 'string', description: "SIE dimension number: '1' = kostnadsställe, '6' = projekt, or a custom dim from gnubok_list_dimensions." },
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
        to_date: { type: 'string', description: 'Optional end date (YYYY-MM-DD); the matrix is always cumulative from period start (closing-balance semantics, reconciles with resultatrapport)' },
      },
      required: ['sie_dim_no'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dimension: {
          type: 'object',
          properties: {
            sie_dim_no: { type: 'string' },
            name: { type: 'string' },
          },
        },
        columns: {
          type: 'array',
          description: 'One per value with activity; code null = the "(Utan dimension)" residual bucket.',
          items: {
            type: 'object',
            properties: {
              code: { type: ['string', 'null'] },
              name: { type: ['string', 'null'] },
            },
          },
        },
        groups: {
          type: 'array',
          description: 'BAS class groups (3-8); each row\'s values[] aligns with columns[].',
          items: {
            type: 'object',
            properties: {
              class: { type: 'number' },
              class_label: { type: 'string' },
              rows: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    account_number: { type: 'string' },
                    account_name: { type: 'string' },
                    values: { type: 'array', items: { type: 'number' } },
                    total: { type: 'number' },
                  },
                },
              },
              subtotals: { type: 'array', items: { type: 'number' } },
              subtotal_total: { type: 'number' },
            },
          },
        },
        net_per_column: { type: 'array', items: { type: 'number' } },
        net_total: { type: 'number', description: 'Matches resultatrapport net result for the same window.' },
        period: {
          type: 'object',
          properties: { start: { type: 'string' }, end: { type: 'string' } },
        },
      },
      required: ['dimension', 'columns', 'groups', 'net_per_column', 'net_total'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const sieDimNo = String(args.sie_dim_no ?? '').trim()
      // Positive-integer guard: the value is interpolated into a PostgREST
      // jsonb path expression downstream, so free-form strings are rejected.
      if (!/^[1-9]\d{0,3}$/.test(sieDimNo)) {
        throw new Error("sie_dim_no must be a positive SIE dimension number, e.g. '1' (kostnadsställe) or '6' (projekt).")
      }

      let periodId = args.period_id as string | undefined

      // If no period specified, find the most recent one (same default as
      // gnubok_get_trial_balance).
      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id, name')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) {
          throw new Error('No fiscal periods found. Categorize some transactions first to auto-create a period.')
        }
        periodId = periods.id
      }

      const toDate = args.to_date as string | undefined

      return await generateDimensionPnl(supabase, companyId, periodId!, sieDimNo, { toDate })
    },
  },

  // ── Reports ──────────────────────────────────────────────────

  {
    name: 'gnubok_get_balance_sheet',
    title: 'Balance Sheet (Balansräkning)',
    description: 'Balance sheet (balansräkning) for a fiscal period: assets, equity, and liabilities sections with totals + balance check.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) throw new Error('No fiscal periods found. Create one first.')
        periodId = periods.id
      }

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found.')

      const result = await generateBalanceSheet(supabase, companyId, periodId!)

      return {
        period_name: period.name,
        ...result,
        period: { start: period.period_start, end: period.period_end },
      }
    },
  },

  {
    name: 'gnubok_get_general_ledger',
    title: 'General Ledger (Huvudbok)',
    description: 'General ledger (huvudbok) for a fiscal period: per-account opening, entries, closing balances. Optional account range + dimensions filters. For ad-hoc cross-account/amount/free-text queries use gnubok_query_journal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period_id: { type: 'string', description: 'Fiscal period UUID (default: most recent)' },
        account_from: { type: 'string', description: 'Starting account number filter' },
        account_to: { type: 'string', description: 'Ending account number filter' },
        dimensions: REPORT_DIMENSIONS_FILTER_SCHEMA,
      },
    },
    outputSchema: {
      type: 'object',
      properties: { ...DIMENSION_FILTER_OUTPUT_PROPS },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      let periodId = args.period_id as string | undefined

      if (!periodId) {
        const { data: periods } = await supabase
          .from('fiscal_periods')
          .select('id')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false })
          .limit(1)
          .single()

        if (!periods) throw new Error('No fiscal periods found.')
        periodId = periods.id
      }

      const accountFrom = args.account_from as string | undefined
      const accountTo = args.account_to as string | undefined

      const dimFilter = await resolveReportDimensionFilter(supabase, companyId, args.dimensions)

      const report = await generateGeneralLedger(
        supabase,
        companyId,
        periodId!,
        accountFrom,
        accountTo,
        dimFilter.filter ? { dimensions: dimFilter.filter } : undefined,
      )
      return {
        ...report,
        ...(dimFilter.filter ? { dimension_filter: dimFilter.filter } : {}),
        ...(dimFilter.resolutions.length > 0 ? { dimension_resolutions: dimFilter.resolutions } : {}),
      }
    },
  },

  {
    name: 'gnubok_query_journal',
    title: 'Query Journal Lines',
    description: "Flexible journal-line query for ad-hoc questions. Filters: account, date, amount, voucher, source, status, dimensions bag, free-text. group_by/group_by_dimension aggregation; include_dimensions returns each line's bag. Lines + totals over the full match set (totals_scope).",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_from: { type: 'string', description: 'Lowest account number (inclusive). E.g. "4000" with account_to "4999" → all class-4 expenses.' },
        account_to: { type: 'string', description: 'Highest account number (inclusive)' },
        accounts: { type: 'array', items: { type: 'string' }, description: 'Specific account numbers (overrides account_from/account_to). Up to 50.' },
        date_from: { type: 'string', description: 'Earliest entry date (YYYY-MM-DD, inclusive)' },
        date_to: { type: 'string', description: 'Latest entry date (YYYY-MM-DD, inclusive)' },
        amount_min: { type: 'number', description: 'Minimum line amount (absolute value of debit OR credit)' },
        amount_max: { type: 'number', description: 'Maximum line amount (absolute value)' },
        text: { type: 'string', maxLength: 200, description: 'Free-text search in entry description and line description (max 200 chars)' },
        voucher_series: { type: 'string', description: 'Filter by voucher series (e.g. "A")' },
        voucher_number_from: { type: 'number', description: 'Lowest voucher number (inclusive)' },
        voucher_number_to: { type: 'number', description: 'Highest voucher number (inclusive)' },
        source_type: { type: 'string', description: 'Filter by source: bank_transaction, invoice_created, supplier_invoice, currency_revaluation, year_end, opening_balance, etc.' },
        status: { type: 'string', enum: ['posted', 'reversed', 'all'], description: 'Default: posted' },
        project: { type: 'string', description: 'Filter by project code (SIE dim 6)' },
        cost_center: { type: 'string', description: 'Filter by cost center (SIE dim 1)' },
        dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Filter: SIE dim no → value (code OR name, resolved server-side), e.g. {"6":"P001"}. Containment match; covers custom dims unlike project/cost_center.',
        },
        include_dimensions: {
          type: 'boolean',
          description: "Return each line's dimensions bag (default false).",
        },
        group_by: { type: 'string', enum: ['account_number', 'voucher_series', 'source_type', 'cost_center', 'project'], description: 'Aggregate matching lines into groups by this field. Mutually exclusive with group_by_dimension.' },
        group_by_dimension: { type: 'string', description: 'Aggregate by SIE dimension number (e.g. "6" = projekt) from each line\'s dimensions bag; untagged → "(utan dimension)". Mutually exclusive with group_by.' },
        limit: { type: 'number', minimum: 1, maximum: 500, description: 'Max lines returned 1-500 (default 100). Totals/groups cover the FULL match set even when truncated, except under free-text search (see totals_scope).' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lines: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean', description: 'True if more matching lines exist than were returned' },
        total_lines: { type: 'number', description: 'Total lines matching ALL filters (incl. amount). When amount_min/amount_max is set this reflects the filtered set, not the wider DB-side match.' },
        returned_lines: { type: 'number' },
        amount_filter_applied_post_fetch: { type: 'boolean', description: 'True if amount_min/amount_max was applied client-side after the DB fetch.' },
        db_matched_pre_amount_filter: { type: ['number', 'null'], description: 'Pre-amount-filter DB match count when amount_filter_applied_post_fetch is true; null otherwise.' },
        totals: {
          type: 'object',
          properties: {
            debit: { type: 'number' },
            credit: { type: 'number' },
            net: { type: 'number', description: 'debit minus credit (positive = net debit)' },
          },
        },
        totals_scope: {
          type: 'string',
          enum: ['full_match', 'returned_slice'],
          description: 'full_match: totals/groups aggregate ALL matching lines regardless of limit. returned_slice: free-text search aggregates only the returned window.',
        },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              debit: { type: 'number' },
              credit: { type: 'number' },
              net: { type: 'number' },
              line_count: { type: 'number' },
            },
          },
          description: 'Present when group_by/group_by_dimension is set; sorted by |net| desc. Scope follows totals_scope.',
        },
        applied_filters: { type: 'object' },
        ...DIMENSION_FILTER_OUTPUT_PROPS,
      },
      required: ['lines', 'total_lines', 'returned_lines', 'totals', 'totals_scope'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 100), 500)
      const status = (args.status as string) || 'posted'
      const accounts = args.accounts as string[] | undefined
      const accountFrom = args.account_from as string | undefined
      const accountTo = args.account_to as string | undefined

      if (accounts && accounts.length > 50) {
        throw new Error('accounts list capped at 50: use account_from/account_to for ranges')
      }

      const dateFrom = args.date_from as string | undefined
      const dateTo = args.date_to as string | undefined
      const voucherSeries = args.voucher_series as string | undefined
      const vnFrom = args.voucher_number_from as number | undefined
      const vnTo = args.voucher_number_to as number | undefined
      const sourceType = args.source_type as string | undefined
      const project = args.project as string | undefined
      const costCenter = args.cost_center as string | undefined
      const includeDimensions = args.include_dimensions === true
      // Resolve-don't-select: value NAMES resolve to registry codes; the
      // containment filter then hits the GIN index on the jsonb bag.
      const dimFilter = await resolveReportDimensionFilter(supabase, companyId, args.dimensions)

      const GROUP_BY_FIELDS = ['account_number', 'voucher_series', 'source_type', 'cost_center', 'project'] as const
      const groupBy = args.group_by as (typeof GROUP_BY_FIELDS)[number] | undefined
      const groupByDimension =
        args.group_by_dimension !== undefined && args.group_by_dimension !== null
          ? String(args.group_by_dimension).trim()
          : undefined

      if (groupBy && groupByDimension) {
        throw new Error('Use either group_by or group_by_dimension, not both')
      }
      if (groupBy && !GROUP_BY_FIELDS.includes(groupBy)) {
        throw new Error(`group_by must be one of: ${GROUP_BY_FIELDS.join(', ')}`)
      }
      // Positive-integer guard: the schema says string but hosts don't always
      // validate, and the value keys into the dimensions jsonb bag.
      if (groupByDimension && !/^[1-9]\d{0,3}$/.test(groupByDimension)) {
        throw new Error('group_by_dimension must be a positive SIE dimension number, e.g. "6" (projekt)')
      }
      const wantsGroups = Boolean(groupBy || groupByDimension)

      // The dimensions jsonb only rides along when something needs it (a
      // dimension group, the bag filter's echo, or include_dimensions): it is
      // the widest column on the line and the aggregate pass fetches ALL rows.
      const dimsSelect = groupByDimension || includeDimensions || dimFilter.filter ? ', dimensions' : ''
      // Free-text legs only. The embed survives here on purpose: each leg is
      // capped at `legLimit` rows, and that cap (which drives legCapHit and
      // the `truncated` signal) has no equivalent in the two-step fetch,
      // which would have to pull the whole ilike match set unbounded. Every
      // other pass uses fetchEntryLines: see ENTRY_COLUMNS/LINE_COLUMNS.
      const DISPLAY_SELECT = `id, account_number, debit_amount, credit_amount, currency, line_description, project, cost_center${dimsSelect}, sort_order, journal_entries!inner(id, voucher_number, voucher_series, entry_date, description, notes, source_type, status, company_id)`
      // Column lists for the two-step entry-lines fetch (the non-text path).
      // Same fields as DISPLAY_SELECT, split across the two queries the
      // helper issues; company_id is implied by the entry-side filter.
      const ENTRY_COLUMNS = 'id, voucher_number, voucher_series, entry_date, description, notes, source_type, status'
      const LINE_COLUMNS = `id, account_number, debit_amount, credit_amount, currency, line_description, project, cost_center${dimsSelect}, sort_order`

      // Each query pass needs its own builder instance: PostgREST query
      // builders are not reusable across awaits. The factory closes over the
      // resolved filter values above and applies IDENTICAL filters for every
      // projection, so display, text legs, and the aggregate pass always see
      // the same match set.
      const buildFilteredQuery = (select: string) => {
        let q = supabase
          .from('journal_entry_lines')
          .select(select)
          .eq('journal_entries.company_id', companyId)

        if (status === 'all') {
          q = q.in('journal_entries.status', ['posted', 'reversed'])
        } else {
          q = q.eq('journal_entries.status', status)
        }

        if (accounts && accounts.length > 0) {
          q = q.in('account_number', accounts)
        } else {
          if (accountFrom) q = q.gte('account_number', accountFrom)
          if (accountTo) q = q.lte('account_number', accountTo)
        }

        if (dateFrom) q = q.gte('journal_entries.entry_date', dateFrom)
        if (dateTo) q = q.lte('journal_entries.entry_date', dateTo)

        if (voucherSeries) q = q.eq('journal_entries.voucher_series', voucherSeries)
        if (typeof vnFrom === 'number') q = q.gte('journal_entries.voucher_number', vnFrom)
        if (typeof vnTo === 'number') q = q.lte('journal_entries.voucher_number', vnTo)

        if (sourceType) q = q.eq('journal_entries.source_type', sourceType)

        if (project) q = q.eq('project', project)
        if (costCenter) q = q.eq('cost_center', costCenter)
        if (dimFilter.filter) q = q.contains('dimensions', dimFilter.filter)

        return q
      }

      // Same filter set as buildFilteredQuery, split for the two-step
      // entry-lines fetch: entry-level predicates become plain column filters
      // on journal_entries, line-level ones stay on journal_entry_lines. Keep
      // the three in sync: they must always describe one match set.
      const filterEntries = (q: EntryLinesQuery): EntryLinesQuery => {
        let e = q.eq('company_id', companyId)
        e = status === 'all' ? e.in('status', ['posted', 'reversed']) : e.eq('status', status)
        if (dateFrom) e = e.gte('entry_date', dateFrom)
        if (dateTo) e = e.lte('entry_date', dateTo)
        if (voucherSeries) e = e.eq('voucher_series', voucherSeries)
        if (typeof vnFrom === 'number') e = e.gte('voucher_number', vnFrom)
        if (typeof vnTo === 'number') e = e.lte('voucher_number', vnTo)
        if (sourceType) e = e.eq('source_type', sourceType)
        return e
      }

      const filterLines = (q: EntryLinesQuery): EntryLinesQuery => {
        let l = q
        if (accounts && accounts.length > 0) {
          l = l.in('account_number', accounts)
        } else {
          if (accountFrom) l = l.gte('account_number', accountFrom)
          if (accountTo) l = l.lte('account_number', accountTo)
        }
        if (project) l = l.eq('project', project)
        if (costCenter) l = l.eq('cost_center', costCenter)
        if (dimFilter.filter) l = l.contains('dimensions', dimFilter.filter)
        return l
      }

      type LineRow = {
        id: string
        account_number: string
        debit_amount: number
        credit_amount: number
        currency: string | null
        line_description: string | null
        project: string | null
        cost_center: string | null
        dimensions?: Record<string, string> | null
        sort_order: number
        journal_entries: {
          id: string
          voucher_number: number
          voucher_series: string
          entry_date: string
          description: string
          notes: string | null
          source_type: string
          status: string
        }
      }

      // Display ordering: verifikat-major, newest first, then line order
      // inside the voucher, with the line id as a deterministic tiebreak.
      // Applied in JS because the sort keys live on the parent entry:
      // PostgREST's `.order(col, { foreignTable })` sorts the EMBEDDED rows,
      // not the parent result set, so this order was never produced server
      // side.
      const byDisplayOrder = (a: LineRow, b: LineRow) => {
        const ad = a.journal_entries.entry_date
        const bd = b.journal_entries.entry_date
        if (ad !== bd) return ad < bd ? 1 : -1
        const av = a.journal_entries.voucher_number
        const bv = b.journal_entries.voucher_number
        if (av !== bv) return bv - av
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      }

      // Free-text search runs as two parallel .ilike() queries: one against
      // line_description (base table) and one against journal_entries.description
      // (embedded resource). PostgREST's flat .or() filter cannot span a base
      // column and an embedded-resource column ("failed to parse logic tree"),
      // so we issue two queries and merge by line id. Same pattern as
      // lib/invoices/duplicate-payment-candidates.ts.
      const text = (args.text as string | undefined)?.trim()
      let data: LineRow[] = []
      let dbMatched = 0
      // Full match set (non-text path only) so totals and groups are exact
      // regardless of `limit`. The free-text path stays slice-scoped (its
      // per-leg windows make a full pass unbounded) and says so via
      // totals_scope='returned_slice'.
      let fullRows: LineRow[] | null = null
      // True when at least one text-search leg filled its per-leg fetch
      // window: i.e. more matches probably exist on the DB side that didn't
      // make it into the merge. Drives the `truncated` signal honestly even
      // when the merged distinct set fits inside `limit`.
      let legCapHit = false

      if (text) {
        // Length guard: defence in depth against pathological inputs even
        // though .ilike() parameterises the value (compliance A.8.28).
        if (text.length > 200) {
          throw new Error('text filter must be 200 characters or shorter')
        }

        // LIKE wildcards `%` and `_` are escaped so a search for "2_441"
        // matches the literal string. Comma stripping is intentionally NOT
        // applied here: the previous implementation needed it because the
        // value was interpolated into PostgREST's OR DSL where `,` is the
        // separator. The .ilike() path passes the pattern as a parameterised
        // filter operand where `,` is a literal: stripping would mangle
        // searches for real commas in line descriptions.
        //
        // Backslash is escaped FIRST, and the order matters: `\` is LIKE's own
        // escape character, so an unescaped one in the search term swallows the
        // character after it (searching `a\b` matched rows containing `ab`).
        // Escaping it last would instead double the backslashes the % / _ rules
        // just added.
        const escaped = text
          .replace(/\\/g, '\\\\')
          .replace(/%/g, '\\%')
          .replace(/_/g, '\\_')
        const pattern = `%${escaped}%`

        // Fetch up to 2× limit per leg to reduce global-ordering loss when
        // one leg is much more selective than the other (e.g. 150 line
        // matches vs 5 entry matches with limit=100). Hard-capped at 500
        // rows per leg so a caller-supplied `limit` near its own ceiling
        // can't fan out to 2× very large queries. The final post-merge
        // slice still caps at `limit`; the wider per-leg window just gives
        // the merge a better tail to choose from.
        const legLimit = Math.min(limit * 2, 500)

        const buildLeg = (column: 'line_description' | 'journal_entries.description') =>
          buildFilteredQuery(DISPLAY_SELECT)
            .ilike(column, pattern)
            .order('entry_date', { foreignTable: 'journal_entries', ascending: false })
            .order('voucher_number', { foreignTable: 'journal_entries', ascending: false })
            .order('sort_order', { ascending: true })
            .limit(legLimit)

        const [byLine, byEntry] = await Promise.all([
          buildLeg('line_description'),
          buildLeg('journal_entries.description'),
        ])
        if (byLine.error || byEntry.error) {
          log.warn('query_journal text-search failed', {
            companyId,
            userId,
            byLine: byLine.error?.message ?? null,
            byEntry: byEntry.error?.message ?? null,
          })
          throw new Error('Database error while running text search')
        }

        const merged = new Map<string, LineRow>()
        for (const row of (byLine.data ?? []) as unknown as LineRow[]) merged.set(row.id, row)
        for (const row of (byEntry.data ?? []) as unknown as LineRow[]) {
          if (!merged.has(row.id)) merged.set(row.id, row)
        }
        data = Array.from(merged.values()).sort(byDisplayOrder).slice(0, limit)

        // Honest distinct-row count among what we fetched. If a leg hit its
        // window cap, more distinct matches may exist; `legCapHit` carries
        // that signal downstream so `truncated` isn't faked false.
        dbMatched = merged.size
        legCapHit =
          (byLine.data?.length ?? 0) >= legLimit ||
          (byEntry.data?.length ?? 0) >= legLimit
      } else {
        // Non-text path: ONE two-step fetch (lib/bookkeeping/entry-lines.ts)
        // feeds both the display slice and the full-match aggregate pass.
        // The old code ran two `journal_entries!inner` embed queries here (a
        // display one and a lean aggregate one), each of which PostgREST
        // compiled into a correlated LATERAL join that walked every tenant's
        // journal_entry_lines. The display projection is a superset of the
        // aggregate one, so one pass over the same match set replaces both.
        try {
          fullRows = await fetchEntryLines<LineRow>({
            supabase,
            entryColumns: ENTRY_COLUMNS,
            lineColumns: LINE_COLUMNS,
            filterEntries,
            filterLines,
          })
        } catch (err) {
          log.warn('query_journal failed', {
            companyId,
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
          throw new Error('Database error while running journal query')
        }
        data = [...fullRows].sort(byDisplayOrder).slice(0, limit)
        dbMatched = data.length
      }

      // Apply amount filter post-fetch: PostgREST can't OR an abs(debit) >= n
      // with abs(credit) >= n cleanly. Lines are debit XOR credit, so checking
      // max(debit, credit) works. The SAME predicate runs over the display
      // slice and the full aggregate set so both describe one match set.
      const amountMin = args.amount_min as number | undefined
      const amountMax = args.amount_max as number | undefined
      const amountFilterApplied = typeof amountMin === 'number' || typeof amountMax === 'number'
      const passesAmountFilter = (r: { debit_amount: number; credit_amount: number }) => {
        const lineAmount = Math.max(Number(r.debit_amount) || 0, Number(r.credit_amount) || 0)
        if (typeof amountMin === 'number' && lineAmount < amountMin) return false
        if (typeof amountMax === 'number' && lineAmount > amountMax) return false
        return true
      }
      const filtered = data.filter(passesAmountFilter)
      const fullFiltered = fullRows ? fullRows.filter(passesAmountFilter) : null

      // Totals aggregate over the full match set when available (non-text),
      // else over the returned slice (free-text): totals_scope tells the
      // agent which one it got.
      const totalsSource: Array<{ debit_amount: number; credit_amount: number }> =
        fullFiltered ?? filtered
      let totalDebit = 0
      let totalCredit = 0
      for (const r of totalsSource) {
        totalDebit += Number(r.debit_amount) || 0
        totalCredit += Number(r.credit_amount) || 0
      }

      const lines = filtered.map((r) => {
        return {
          line_id: r.id,
          journal_entry_id: r.journal_entries.id,
          voucher_series: r.journal_entries.voucher_series,
          voucher_number: r.journal_entries.voucher_number,
          entry_date: r.journal_entries.entry_date,
          entry_description: r.journal_entries.description,
          entry_notes: r.journal_entries.notes ?? null,
          source_type: r.journal_entries.source_type,
          status: r.journal_entries.status,
          account_number: r.account_number,
          debit: Number(r.debit_amount) || 0,
          credit: Number(r.credit_amount) || 0,
          line_description: r.line_description,
          project: r.project,
          cost_center: r.cost_center,
          ...(includeDimensions ? { dimensions: r.dimensions ?? {} } : {}),
          currency: r.currency,
        }
      })

      // Optional group_by aggregation: over the same set totals used, so
      // group sums always reconcile with `totals`.
      let groups:
        | Array<{ key: string; debit: number; credit: number; net: number; line_count: number }>
        | undefined
      if (wantsGroups) {
        const groupSource: LineRow[] = fullFiltered ?? filtered
        const keyOf = (r: LineRow): string => {
          if (groupByDimension) return r.dimensions?.[groupByDimension] ?? '(utan dimension)'
          switch (groupBy) {
            case 'voucher_series': return r.journal_entries.voucher_series
            case 'source_type': return r.journal_entries.source_type
            case 'cost_center': return r.cost_center ?? '(utan dimension)'
            case 'project': return r.project ?? '(utan dimension)'
            default: return r.account_number
          }
        }
        const bucketMap = new Map<string, { debit: number; credit: number; count: number }>()
        for (const r of groupSource) {
          const key = keyOf(r)
          const bucket = bucketMap.get(key) ?? { debit: 0, credit: 0, count: 0 }
          bucket.debit += Number(r.debit_amount) || 0
          bucket.credit += Number(r.credit_amount) || 0
          bucket.count += 1
          bucketMap.set(key, bucket)
        }
        groups = [...bucketMap.entries()]
          .map(([key, bucket]) => ({
            key,
            debit: roundOre(bucket.debit),
            credit: roundOre(bucket.credit),
            net: roundOre(bucket.debit - bucket.credit),
            line_count: bucket.count,
          }))
          .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      }

      // Non-text path: the aggregate pass IS the full match set, so
      // total_lines / truncated / pre-amount count all anchor to it. Text
      // path: no full pass exists: total_lines stays slice-anchored exactly
      // as before (amount filter → post-filter slice; otherwise the merged
      // distinct count), and legCapHit keeps `truncated` honest.
      const total_lines = fullFiltered
        ? fullFiltered.length
        : amountFilterApplied
          ? lines.length
          : dbMatched
      const truncated = fullFiltered
        ? fullFiltered.length > lines.length
        : amountFilterApplied
          ? data.length >= limit && lines.length === limit
          : dbMatched > lines.length || legCapHit
      return {
        lines,
        truncated,
        total_lines,
        returned_lines: lines.length,
        amount_filter_applied_post_fetch: amountFilterApplied,
        db_matched_pre_amount_filter: amountFilterApplied
          ? (fullRows ? fullRows.length : dbMatched)
          : null,
        totals: {
          debit: Math.round(totalDebit * 100) / 100,
          credit: Math.round(totalCredit * 100) / 100,
          net: Math.round((totalDebit - totalCredit) * 100) / 100,
        },
        totals_scope: fullFiltered ? 'full_match' : 'returned_slice',
        ...(groups ? { groups } : {}),
        applied_filters: {
          account_from: accountFrom ?? null,
          account_to: accountTo ?? null,
          accounts: accounts ?? null,
          date_from: dateFrom ?? null,
          date_to: dateTo ?? null,
          amount_min: amountMin ?? null,
          amount_max: amountMax ?? null,
          text: text ?? null,
          voucher_series: voucherSeries ?? null,
          voucher_number_from: vnFrom ?? null,
          voucher_number_to: vnTo ?? null,
          source_type: sourceType ?? null,
          status,
          project: project ?? null,
          cost_center: costCenter ?? null,
          dimensions: dimFilter.filter ?? null,
          group_by: groupBy ?? null,
          group_by_dimension: groupByDimension ?? null,
        },
        ...(dimFilter.filter ? { dimension_filter: dimFilter.filter } : {}),
        ...(dimFilter.resolutions.length > 0 ? { dimension_resolutions: dimFilter.resolutions } : {}),
      }
    },
  },

  {
    name: 'gnubok_get_ar_ledger',
    title: 'AR Ledger (Kundreskontra)',
    description: 'Accounts receivable ledger (kundreskontra): outstanding customer invoices with aging.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        as_of_date: { type: 'string', description: 'Balance date YYYY-MM-DD (default: today)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const asOfDate = args.as_of_date as string | undefined
      return await generateARLedger(supabase, companyId, asOfDate)
    },
  },

  {
    name: 'gnubok_get_supplier_ledger',
    title: 'AP Ledger (Leverantörsreskontra)',
    description: 'Accounts payable ledger (leverantörsreskontra): outstanding supplier invoices with aging.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        as_of_date: { type: 'string', description: 'Balance date YYYY-MM-DD (default: today)' },
      },
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const asOfDate = args.as_of_date as string | undefined
      return await generateSupplierLedger(supabase, companyId, asOfDate)
    },
  },

  // ── Transaction Matching ─────────────────────────────────────






  {
    name: 'gnubok_find_voucher_candidates_for_invoice',
    title: 'Find Voucher Candidates (Invoice)',
    description: "List posted verifikat that could be this invoice's payment (faktureringsmetoden: credit 1510; kontantmetoden: debit 19xx). Call before gnubok_link_invoice_to_voucher to mark the faktura paid (no new bokföring).",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to find candidates for' },
        limit: { type: 'number', description: 'Max candidates to return (default 10, max 50)' },
      },
      required: ['invoice_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string' },
        invoice_status: { type: 'string' },
        candidates: { type: 'array', items: { type: 'object' } },
      },
      required: ['invoice_id', 'candidates'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required')
      const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50)

      const { data: invoice, error } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, customer_id, customer:customers(id, name)'
        )
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()
      if (error || !invoice) throw new Error('Invoice not found')

      if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
        return {
          invoice_id: invoiceId,
          invoice_status: invoice.status,
          candidates: [],
        }
      }

      const candidates = await findMatchingVouchersForInvoice(
        supabase,
        companyId,
        invoice as never,
        { limit },
      )
      return {
        invoice_id: invoiceId,
        invoice_status: invoice.status,
        candidates,
      }
    },
  },

  {
    name: 'gnubok_link_invoice_to_voucher',
    title: 'Link Invoice to Voucher',
    description: 'Markera en faktura som betald via länk till en befintlig verifikation (faktureringsmetoden: krediterar 1510; kontantmetoden: debiterar 19xx). Kör gnubok_find_voucher_candidates_for_invoice först. Stages for approval.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to mark paid' },
        journal_entry_id: { type: 'string', description: 'UUID of the existing posted verifikat to link' },
        notes: { type: 'string', description: 'Optional note stored on the invoice_payments row' },
      },
      required: ['invoice_id', 'journal_entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      const journalEntryId = args.journal_entry_id as string
      const notes = (args.notes as string | undefined) ?? undefined
      if (!invoiceId || !journalEntryId) {
        throw new Error('invoice_id and journal_entry_id are required')
      }

      const { data: invoice, error: invErr } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, customer_id, customer:customers(id, name)'
        )
        .eq('id', invoiceId)
        .eq('company_id', companyId)
        .single()
      if (invErr || !invoice) throw new Error('Invoice not found')
      if (!['sent', 'overdue', 'partially_paid'].includes(invoice.status)) {
        throw new Error('Invoice is not in a matchable state (must be sent, overdue, or partially_paid)')
      }

      const validation = await validateVoucherForInvoiceLink(
        supabase,
        companyId,
        invoice as never,
        journalEntryId,
      )
      if (!validation.ok) {
        throw new Error(
          `${validation.code}${validation.details ? `: ${JSON.stringify(validation.details)}` : ''}`,
        )
      }

      const voucherLabel = validation.voucher.voucher_series && validation.voucher.voucher_number != null
        ? `${validation.voucher.voucher_series}-${validation.voucher.voucher_number}`
        : journalEntryId.slice(0, 8)

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'link_invoice_voucher',
        `Länka verifikat ${voucherLabel} → faktura ${invoice.invoice_number ?? invoiceId.slice(0, 8)}`,
        { invoice_id: invoiceId, journal_entry_id: journalEntryId, notes },
        {
          invoice_number: invoice.invoice_number,
          invoice_currency: invoice.currency,
          invoice_remaining: invoice.remaining_amount,
          voucher_label: voucherLabel,
          voucher_date: validation.voucher.entry_date,
          voucher_description: validation.voucher.description,
          ar_credit_amount: validation.arCreditAmount,
          payment_amount: validation.paymentAmount,
          will_be_fully_paid: validation.isFullyPaid,
          remaining_after: validation.remainingAfter,
          customer_name: (invoice.customer as unknown as { name?: string } | null)?.name ?? null,
        },
        actor,
        {
          description: 'After approval the invoice transitions to paid (or partially_paid). No new verifikat is created: the existing voucher is the payment posting.',
          tool: 'gnubok_get_ar_ledger',
        },
      )
    },
  },

  {
    name: 'gnubok_find_voucher_candidates_for_supplier_invoice',
    title: 'Find Voucher Candidates (Supplier Invoice)',
    description: 'List posted verifikat that debit leverantörsskuld (2440) and could be this supplier invoice\'s payment. Call before gnubok_link_supplier_invoice_to_voucher to mark the leverantörsfaktura paid (no new bokföring).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supplier_invoice_id: { type: 'string', description: 'UUID of the supplier invoice to find candidates for' },
        limit: { type: 'number', description: 'Max candidates to return (default 10, max 50)' },
      },
      required: ['supplier_invoice_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supplier_invoice_id: { type: 'string' },
        invoice_status: { type: 'string' },
        candidates: { type: 'array', items: { type: 'object' } },
      },
      required: ['supplier_invoice_id', 'candidates'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const supplierInvoiceId = args.supplier_invoice_id as string
      if (!supplierInvoiceId) throw new Error('supplier_invoice_id is required')
      const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50)

      const { data: invoice, error } = await supabase
        .from('supplier_invoices')
        .select(
          'id, supplier_invoice_number, arrival_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, supplier_id, supplier:suppliers(id, name)'
        )
        .eq('id', supplierInvoiceId)
        .eq('company_id', companyId)
        .single()
      if (error || !invoice) throw new Error('Supplier invoice not found')

      if (!['registered', 'approved', 'overdue', 'partially_paid'].includes(invoice.status)) {
        return {
          supplier_invoice_id: supplierInvoiceId,
          invoice_status: invoice.status,
          candidates: [],
        }
      }

      const candidates = await findMatchingVouchersForSupplierInvoice(
        supabase,
        companyId,
        invoice as never,
        { limit },
      )
      return {
        supplier_invoice_id: supplierInvoiceId,
        invoice_status: invoice.status,
        candidates,
      }
    },
  },

  {
    name: 'gnubok_link_supplier_invoice_to_voucher',
    title: 'Link Supplier Invoice to Voucher',
    description: 'Markera en leverantörsfaktura som betald via länk till en befintlig verifikation som debiterar leverantörsskuld (2440). Skapar ingen ny verifikation. Kör gnubok_find_voucher_candidates_for_supplier_invoice först. Stages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        supplier_invoice_id: { type: 'string', description: 'UUID of the supplier invoice to mark paid' },
        journal_entry_id: { type: 'string', description: 'UUID of the existing posted verifikat to link' },
        notes: { type: 'string', description: 'Optional note stored on the supplier_invoice_payments row' },
      },
      required: ['supplier_invoice_id', 'journal_entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const supplierInvoiceId = args.supplier_invoice_id as string
      const journalEntryId = args.journal_entry_id as string
      const notes = (args.notes as string | undefined) ?? undefined
      if (!supplierInvoiceId || !journalEntryId) {
        throw new Error('supplier_invoice_id and journal_entry_id are required')
      }

      const { data: invoice, error: invErr } = await supabase
        .from('supplier_invoices')
        .select(
          'id, supplier_invoice_number, arrival_number, status, currency, total, paid_amount, remaining_amount, due_date, paid_at, exchange_rate, supplier_id, supplier:suppliers(id, name)'
        )
        .eq('id', supplierInvoiceId)
        .eq('company_id', companyId)
        .single()
      if (invErr || !invoice) throw new Error('Supplier invoice not found')
      if (!['registered', 'approved', 'overdue', 'partially_paid'].includes(invoice.status)) {
        throw new Error('Supplier invoice is not in a matchable state (must be registered, approved, overdue, or partially_paid)')
      }

      const validation = await validateVoucherForSupplierInvoiceLink(
        supabase,
        companyId,
        invoice as never,
        journalEntryId,
      )
      if (!validation.ok) {
        throw new Error(
          `${validation.code}${validation.details ? `: ${JSON.stringify(validation.details)}` : ''}`,
        )
      }

      const voucherLabel = validation.voucher.voucher_series && validation.voucher.voucher_number != null
        ? `${validation.voucher.voucher_series}-${validation.voucher.voucher_number}`
        : journalEntryId.slice(0, 8)

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'link_supplier_invoice_voucher',
        `Länka verifikat ${voucherLabel} → leverantörsfaktura ${invoice.supplier_invoice_number ?? supplierInvoiceId.slice(0, 8)}`,
        { supplier_invoice_id: supplierInvoiceId, journal_entry_id: journalEntryId, notes },
        {
          supplier_invoice_number: invoice.supplier_invoice_number,
          invoice_currency: invoice.currency,
          invoice_remaining: invoice.remaining_amount,
          voucher_label: voucherLabel,
          voucher_date: validation.voucher.entry_date,
          voucher_description: validation.voucher.description,
          ap_debit_amount: validation.apDebitAmount,
          payment_amount: validation.paymentAmount,
          will_be_fully_paid: validation.isFullyPaid,
          remaining_after: validation.remainingAfter,
          supplier_name: (invoice.supplier as unknown as { name?: string } | null)?.name ?? null,
        },
        actor,
        {
          description: 'After approval the supplier invoice transitions to paid (or partially_paid). No new verifikat is created: the existing voucher is the payment posting.',
          tool: 'gnubok_get_supplier_ledger',
        },
      )
    },
  },


  // ── Fiscal Periods ───────────────────────────────────────────

  {
    name: 'gnubok_list_fiscal_periods',
    title: 'List Fiscal Periods',
    description: 'List all fiscal periods (räkenskapsperioder) with status: active (open), locked (no new entries), or closed (year-end completed).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        periods: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
      },
      required: ['periods', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_args, companyId, userId, supabase) {
      const { data, error } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at, opening_balances_set')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })

      if (error) throw new Error(`Database error: ${error.message}`)

      const periods = (data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        period_start: p.period_start,
        period_end: p.period_end,
        opening_balances_set: p.opening_balances_set,
        status: p.is_closed ? 'closed' : p.locked_at ? 'locked' : 'active',
      }))

      return { periods, count: periods.length }
    },
  },

  // ── Reconciliation ───────────────────────────────────────────


  // ── Document Inbox Tools ────────────────────────────────────

  {
    name: 'gnubok_create_document_upload',
    title: 'Create Document Upload',
    description: 'Create a short-lived URL for a model-free document upload. PUT the raw file bytes (max 10 MB) to upload_url, then call gnubok_complete_document_upload with the same upload_id and file_name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_name: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          description: 'File name with extension, for example "faktura.pdf"',
        },
        mime_type: {
          type: 'string',
          enum: [...MCP_DOCUMENT_MIME_TYPES],
          description: 'MIME type. Optional when it can be inferred from the file extension.',
        },
      },
      required: ['file_name'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        upload_id: { type: 'string' },
        upload_url: { type: 'string' },
        expires_at: { type: 'string' },
      },
      required: ['upload_id', 'upload_url', 'expires_at'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const fileName = args.file_name as string
      // Validation only: reject unsupported types before handing out a signed
      // URL. The resolved value is re-derived identically at complete time.
      resolveMcpDocumentMimeType(fileName, args.mime_type)
      const uploadId = crypto.randomUUID()
      const reservation = await createPendingDocumentUpload(
        supabase,
        companyId,
        userId,
        uploadId,
        fileName,
      )
      return {
        upload_id: reservation.uploadId,
        upload_url: reservation.signedUrl,
        expires_at: reservation.expiresAt,
      }
    },
  },

  {
    name: 'gnubok_complete_document_upload',
    title: 'Complete Document Upload',
    description: 'Validate and archive bytes sent to the URL from gnubok_create_document_upload and create the inbox item (empty extracted_data: fill it with gnubok_set_inbox_extracted_data). Idempotent: safe to retry with the same upload_id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        upload_id: {
          type: 'string',
          format: 'uuid',
          description: 'Reserved UUID returned by gnubok_create_document_upload',
        },
        file_name: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          description: 'The same file name used to create the upload URL',
        },
        mime_type: {
          type: 'string',
          enum: [...MCP_DOCUMENT_MIME_TYPES],
          description: 'MIME type. Optional when it can be inferred from the file extension.',
        },
      },
      required: ['upload_id', 'file_name'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string' },
        inbox_item_id: { type: 'string' },
        status: { type: 'string' },
        extracted_data: { type: 'object' },
        matched_supplier_id: { type: 'string' },
      },
      required: ['document_id', 'inbox_item_id', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const uploadId = args.upload_id as string
      const fileName = args.file_name as string
      const mimeType = resolveMcpDocumentMimeType(fileName, args.mime_type)

      const existingInbox = await findCompletedDocumentInboxItem(
        supabase,
        companyId,
        userId,
        uploadId,
      )
      if (existingInbox) return existingInbox

      const completed = await completePendingDocumentUpload(
        supabase,
        companyId,
        userId,
        uploadId,
        fileName,
        mimeType,
      )
      return createDocumentInboxItem(
        supabase,
        companyId,
        userId,
        completed.document.id,
        fileName,
        mimeType,
        Buffer.from(completed.buffer),
        uploadId,
      )
    },
  },

  {
    name: 'gnubok_upload_document',
    title: 'Upload Document to Inbox',
    description: 'Legacy inline-base64 upload for small files (max 10 MB). Prefer gnubok_create_document_upload so raw bytes bypass the model. Creates the inbox item with empty extracted_data: fill it with gnubok_set_inbox_extracted_data.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_name: { type: 'string', description: 'File name with extension (e.g. "faktura.pdf")' },
        file_content_base64: { type: 'string', description: 'Base64-encoded file content' },
        mime_type: { type: 'string', description: 'MIME type (optional, inferred from extension)' },
      },
      required: ['file_name', 'file_content_base64'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string' },
        inbox_item_id: { type: 'string' },
        status: { type: 'string' },
        extracted_data: { type: 'object' },
        matched_supplier_id: { type: 'string' },
      },
      required: ['document_id', 'inbox_item_id', 'status'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const fileName = args.file_name as string
      const base64Content = args.file_content_base64 as string
      const mimeType = resolveMcpDocumentMimeType(fileName, args.mime_type)

      const buffer = Buffer.from(base64Content, 'base64')
      if (buffer.byteLength > MAX_DOCUMENT_SIZE) {
        throw new Error(`File too large (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB)`)
      }

      const doc = await uploadDocument(supabase, userId, companyId, {
        name: fileName,
        buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        type: mimeType,
      }, { upload_source: 'api' })
      return createDocumentInboxItem(
        supabase,
        companyId,
        userId,
        doc.id,
        fileName,
        mimeType,
        buffer,
      )
    },
  },

  {
    name: 'gnubok_list_inbox_items',
    title: 'List Inbox Items',
    description: 'List document inbox items, including each original file_name. `processed` covers all terminal links (transaction, supplier invoice, journal entry); booked receipts count as done. unprocessed_only=true returns docs still needing handling.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['received', 'error'], description: 'Filter by status' },
        unprocessed_only: { type: 'boolean', description: 'When true, only return items with no terminal link yet (not matched to a transaction, supplier invoice, or journal entry), i.e. documents that still need handling. Default false.' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        cursor: {
          type: 'string',
          maxLength: 100,
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})(?:__[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?$',
          description: 'Composite "<created_at>__<inbox_item_id>" from previous page (exclusive). Pass next_cursor verbatim.',
        },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file_name: {
                type: ['string', 'null'],
                description: 'Original document file name, or null when the inbox item has no document',
              },
            },
            required: ['file_name'],
          },
        },
        count: { type: 'number' },
        next_cursor: { type: 'string', description: 'Pass as cursor on next call. Absent = no more pages.' },
      },
      required: ['items', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)
      const status = args.status as string | undefined
      const unprocessedOnly = args.unprocessed_only === true
      const cursor = typeof args.cursor === 'string' ? args.cursor : null

      // Composite cursor: "<created_at>__<id>". Falls back to plain timestamp
      // for backward compatibility with older callers.
      let cursorTs: string | null = null
      let cursorId: string | null = null
      if (cursor) {
        const sep = cursor.indexOf('__')
        if (sep === -1) {
          cursorTs = cursor
        } else {
          cursorTs = cursor.slice(0, sep)
          cursorId = cursor.slice(sep + 2)
        }
      }
      if (cursorTs && !z.string().datetime({ offset: true }).safeParse(cursorTs).success) {
        throw new Error('Invalid cursor timestamp. Pass next_cursor verbatim.')
      }
      if (cursorId && !z.string().uuid().safeParse(cursorId).success) {
        throw new Error('Invalid cursor inbox item ID. Pass next_cursor verbatim.')
      }

      const fetchSize = unprocessedOnly ? 200 : limit

      let query = supabase
        .from('invoice_inbox_items')
        .select(`
          id, status, source, created_at, extracted_data, matched_supplier_id,
          matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id,
          email_from, email_subject, error_message, document_attachments(file_name)
        `)
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        // Fetch a wider window when filtering client-side so the limit
        // applies to the post-filter set rather than truncating before it.
        .limit(fetchSize)

      if (status) query = query.eq('status', status)
      if (cursorTs && cursorId) {
        query = query.or(
          `created_at.lt.${cursorTs},and(created_at.eq.${cursorTs},id.lt.${cursorId})`
        )
      } else if (cursorTs) {
        query = query.lt('created_at', cursorTs)
      }

      const { data, error } = await query
      if (error) throw new Error(`Database error: ${error.message}`)

      const mapped = (data || []).map((item) => {
        const extracted = item.extracted_data as Record<string, unknown> | null
        let vendorName: string | null = null
        let amount: number | null = null
        let invoiceDate: string | null = null

        if (extracted) {
          const supplier = extracted.supplier as Record<string, unknown> | undefined
          const invoice = extracted.invoice as Record<string, unknown> | undefined
          const totals = extracted.totals as Record<string, unknown> | undefined
          vendorName = (supplier?.name as string) || null
          amount = (totals?.total as number) || null
          invoiceDate = (invoice?.invoiceDate as string) || null
        }

        // An item is "processed" once it has ANY terminal link: matched to a
        // bank transaction, converted to a supplier invoice, or booked
        // directly to a journal entry. Surfacing only the supplier fields
        // (as before) made receipts booked against bank transactions look
        // loose: and risked the agent flagging them as duplicates.
        const processed = !!(
          item.matched_transaction_id ||
          item.created_supplier_invoice_id ||
          item.created_journal_entry_id
        )

        return {
          id: item.id,
          status: item.status,
          source: item.source,
          created_at: item.created_at,
          file_name: item.document_attachments?.[0]?.file_name ?? null,
          vendor_name: vendorName,
          amount,
          invoice_date: invoiceDate,
          processed,
          matched_supplier_id: item.matched_supplier_id,
          matched_transaction_id: item.matched_transaction_id,
          created_supplier_invoice_id: item.created_supplier_invoice_id,
          created_journal_entry_id: item.created_journal_entry_id,
          email_from: item.email_from,
          email_subject: item.email_subject,
          error_message: item.error_message,
        }
      })

      const filtered = unprocessedOnly ? mapped.filter((i) => !i.processed) : mapped
      const items = filtered.slice(0, limit)

      // A full returned page continues after its last item. When client-side
      // filtering yields a short page from a full scan window, continue after
      // the last inspected row so older unprocessed items remain reachable.
      let nextCursor: string | null = null
      if (items.length === limit) {
        const last = items[items.length - 1]
        nextCursor = `${last.created_at}__${last.id}`
      } else if (data && data.length === fetchSize) {
        const last = data[data.length - 1]
        nextCursor = `${last.created_at}__${last.id}`
      }

      return {
        items,
        count: items.length,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      }
    },
  },

  {
    name: 'gnubok_get_inbox_item',
    title: 'Get Inbox Item',
    description: 'Get a single inbox item with complete extracted data, supplier match, email metadata, and timestamps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string', description: 'UUID of the inbox item' },
      },
      required: ['inbox_item_id'],
    },
    outputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const id = args.inbox_item_id as string

      const { data, error } = await supabase
        .from('invoice_inbox_items')
        .select('*, document_attachments(id, file_name, mime_type, file_size_bytes, created_at)')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!data) throw new Error('Inbox item not found')

      return data
    },
  },

  {
    name: 'gnubok_create_supplier_invoice_from_inbox',
    title: 'Create Supplier Invoice from Inbox',
    description: "Atomic: turn an inbox item into a staged supplier invoice. Resolves supplier, builds lines from extracted_data, applies VAT + FX + dimension tags, attaches the document. Stages for human review; honors dry_run. Unresolved supplier → staged:false + candidates + next.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string', description: 'UUID of the inbox item to convert' },
        supplier_id_override: { type: 'string', description: 'Force this supplier UUID instead of the matched/extracted one' },
        vat_treatment_override: { type: 'string', enum: ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt'], description: 'Override extracted VAT treatment' },
        invoice_date_override: { type: 'string', description: 'Override extracted invoice date (YYYY-MM-DD). Use when the extracted date is missing or wrong.' },
        due_date_override: { type: 'string', description: 'Override extracted due date (YYYY-MM-DD)' },
        line_overrides: {
          type: 'array',
          description: 'Per-line overrides (1-based line_number): account_number wins over accountSuggestion and supplier default; dimensions tags that line.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line_number: { type: 'number', description: '1-based index matching items_preview' },
              account_number: { type: 'string', description: 'BAS account number for this line (e.g. "6420")' },
              dimensions: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Dims bag {sie_dim_no: kod eller namn}, e.g. {"6":"P001"}, for this line. Wins per key over default_dimensions.',
              },
            },
            required: ['line_number'],
          },
        },
        default_dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dims bag keyed by SIE dim no, value = code OR name, e.g. {"1":"KS01","6":"Villa Almgren"}. Applied to every line not setting the key. Unknown values rejected: never auto-created.',
        },
        notes: { type: 'string', description: 'Optional notes appended to the supplier invoice' },
        dry_run: { type: 'boolean', description: 'If true, return the assembled payload without staging (default false)' },
        idempotency_key: { type: 'string', description: 'UUID. Repeat calls with same key + payload return cached response.' },
      },
      required: ['inbox_item_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const inboxItemId = args.inbox_item_id as string
      if (!inboxItemId) throw new Error('inbox_item_id is required')
      const dryRun = args.dry_run === true
      const idempotencyKey = args.idempotency_key as string | undefined

      // Fetch the inbox item with the attached source document
      const { data: inbox, error: inboxErr } = await supabase
        .from('invoice_inbox_items')
        .select('id, status, extracted_data, matched_supplier_id, created_supplier_invoice_id, document_id')
        .eq('id', inboxItemId)
        .eq('company_id', companyId)
        .single()

      if (inboxErr || !inbox) throw new Error('Inbox item not found')
      if (inbox.created_supplier_invoice_id) {
        throw new Error(`Inbox item already converted to supplier invoice ${inbox.created_supplier_invoice_id}`)
      }

      const extracted = (inbox.extracted_data as Record<string, unknown> | null) ?? null
      if (!extracted) throw new Error('Inbox item has no extracted_data: set it with gnubok_set_inbox_extracted_data first')

      const supplierExt = extracted.supplier as Record<string, unknown> | undefined
      const invoiceExt = extracted.invoice as Record<string, unknown> | undefined
      const totalsExt = extracted.totals as Record<string, unknown> | undefined
      const lineItemsExt = (extracted.lineItems as Array<Record<string, unknown>> | undefined) ?? []

      // Resolve supplier: explicit override > matched > org_number lookup > name lookup
      const supplierIdOverride = args.supplier_id_override as string | undefined
      let supplierId: string | null = supplierIdOverride ?? (inbox.matched_supplier_id as string | null) ?? null
      let supplierResolution: 'override' | 'matched' | 'lookup_org_number' | 'lookup_name' | 'unresolved' =
        supplierIdOverride ? 'override' : inbox.matched_supplier_id ? 'matched' : 'unresolved'

      if (!supplierId) {
        const orgNumber = supplierExt?.organizationNumber as string | undefined
        const supplierName = supplierExt?.name as string | undefined
        if (orgNumber) {
          const { data } = await supabase
            .from('suppliers')
            .select('id')
            .eq('company_id', companyId)
            .eq('org_number', orgNumber)
            .maybeSingle()
          if (data) {
            supplierId = data.id
            supplierResolution = 'lookup_org_number'
          }
        }
        if (!supplierId && supplierName) {
          const { data } = await supabase
            .from('suppliers')
            .select('id')
            .eq('company_id', companyId)
            .ilike('name', supplierName)
            .maybeSingle()
          if (data) {
            supplierId = data.id
            supplierResolution = 'lookup_name'
          }
        }
      }

      if (!supplierId) {
        // Structured resolution failure instead of a dead end (P1-4,
        // dev_docs/mcp_optimization_plan.md): a thrown error here stops the
        // whole inbox pipeline for small ad hoc vendors. Return staged:false
        // with near-miss candidates the agent can pass as supplier_id_override,
        // or a create-supplier next hint when nothing is close. Fuzzy scores
        // never auto-resolve: the agent/human confirms against the underlag.
        const extractedName = (supplierExt?.name as string | undefined) ?? null
        const extractedOrg = (supplierExt?.organizationNumber as string | undefined) ?? null

        const CANDIDATE_POOL_CAP = 500
        const { data: companySuppliers } = await supabase
          .from('suppliers')
          .select('id, name, org_number')
          .eq('company_id', companyId)
          .limit(CANDIDATE_POOL_CAP)

        const candidates = findSupplierCandidates(
          (companySuppliers ?? []) as { id: string; name: string; org_number: string | null }[],
          extractedName,
          extractedOrg,
        )
        const best = candidates[0]
        // No silent caps: past the pool cap the right supplier may exist yet
        // be absent from candidates: say so instead of implying full coverage.
        const poolTruncated = (companySuppliers?.length ?? 0) >= CANDIDATE_POOL_CAP

        return {
          staged: false,
          risk_level: getRiskLevel('create_supplier_invoice_from_inbox'),
          actor: actor ?? { type: 'user' },
          message: (best
            ? `Could not resolve supplier "${extractedName ?? 'unknown'}" exactly: ${candidates.length} near-miss candidate(s) in preview.candidates. Verify against the underlag, then retry with supplier_id_override; or create the supplier first.`
            : `Could not resolve supplier "${extractedName ?? 'unknown'}" (org: ${extractedOrg ?? 'unknown'}) and no similar supplier exists. Create it with gnubok_create_supplier, then retry with supplier_id_override.`)
            + (poolTruncated ? ` Note: candidate search covered only the first ${CANDIDATE_POOL_CAP} suppliers: the pool was truncated.` : ''),
          preview: {
            supplier_resolution: 'unresolved',
            unresolved_supplier: {
              extracted_name: extractedName,
              extracted_org_number: extractedOrg,
            },
            candidates,
            candidate_pool_truncated: poolTruncated,
          },
          next: best
            ? {
                description: `Closest existing supplier: "${best.name}" (score ${best.score}). If it matches the underlag, retry with this supplier_id_override.`,
                tool: 'gnubok_create_supplier_invoice_from_inbox',
                args: { inbox_item_id: inboxItemId, supplier_id_override: best.supplier_id },
              }
            : {
                description:
                  'Create the supplier, approve it, then retry this tool with supplier_id_override set to the new supplier id.',
                tool: 'gnubok_create_supplier',
                args: {
                  ...(extractedName ? { name: extractedName } : {}),
                  ...(extractedOrg ? { org_number: extractedOrg } : {}),
                },
              },
        }
      }

      // Fetch supplier defaults so line items can inherit default_expense_account
      // when neither the extraction nor the agent provided an accountSuggestion.
      // Doubles as existence/tenancy validation: every resolution path (and
      // especially supplier_id_override, which the unresolved next-hint now
      // actively promotes) must point at a supplier in THIS company, or the
      // staged operation would fail opaquely at commit time instead.
      const { data: resolvedSupplier } = await supabase
        .from('suppliers')
        .select('id, default_expense_account')
        .eq('id', supplierId)
        .eq('company_id', companyId)
        .single()
      if (!resolvedSupplier) {
        throw new Error(
          supplierResolution === 'override'
            ? `supplier_id_override ${supplierId} does not match any supplier in this company. Use a supplier_id from preview.candidates or gnubok_list_suppliers.`
            : `Resolved supplier ${supplierId} no longer exists in this company: update extracted_data or pass supplier_id_override.`,
        )
      }
      const supplierDefaultExpenseAccount = resolvedSupplier.default_expense_account ?? null

      // Assemble core invoice fields
      const currency = (invoiceExt?.currency as string) || 'SEK'
      for (const key of ['invoice_date_override', 'due_date_override'] as const) {
        const value = args[key] as string | undefined
        if (value !== undefined && !ISO_DATE_RE.test(value)) {
          throw new Error(`${key} must be an ISO date (YYYY-MM-DD), got "${value}"`)
        }
      }
      const invoiceDate = (args.invoice_date_override as string | undefined) ?? (invoiceExt?.invoiceDate as string) ?? null
      const dueDate = (args.due_date_override as string | undefined) ?? (invoiceExt?.dueDate as string | undefined) ?? null
      const supplierInvoiceNumber = (invoiceExt?.invoiceNumber as string) || ''
      if (!invoiceDate) throw new Error('Extracted invoice has no invoice date')
      if (!supplierInvoiceNumber) throw new Error('Extracted invoice has no invoice number')

      const total = Number(totalsExt?.total) || 0
      const subtotal = Number(totalsExt?.subtotal) || 0

      // VAT treatment: explicit override wins, else heuristic from extracted data
      const vatTreatment = (args.vat_treatment_override as string | undefined)
        ?? (invoiceExt?.vatTreatment as string | undefined)
        ?? 'standard_25'

      // FX: if non-SEK, fetch rate at fakturadatum (best-effort; agent can re-stage on failure)
      let exchangeRate: number | null = null
      if (currency !== 'SEK' && invoiceDate) {
        try {
          const result = await fetchExchangeRate(currency as Currency, new Date(invoiceDate))
          exchangeRate = result?.rate ?? null
        } catch {
          exchangeRate = null  // Agent will be informed via preview; can override later
        }
      }

      // Build lookups for per-line overrides keyed by 1-based line number.
      const rawLineOverrides = (args.line_overrides as Array<{ line_number: number; account_number?: string; dimensions?: unknown }> | undefined) ?? []
      const lineOverrideMap = new Map(
        rawLineOverrides.filter((o) => o.account_number).map((o) => [o.line_number, o.account_number as string]),
      )
      const lineDimensionsMap = new Map(
        rawLineOverrides.map((o, i) => [o.line_number, parseDimensionsArg(o.dimensions, `line_overrides[${i}].dimensions`)]),
      )

      // Resolve-don't-select: parse the invoice-level default bag + each line's
      // own bag, then resolve codes AND natural-language names against the
      // registry in ONE pass (zero queries when nothing is tagged; free-text
      // passthrough while dimensions_enabled is off). The resolved default is
      // staged top-level; each item keeps only its own resolved bag: the
      // executor merges item-over-default at commit time.
      const defaultDimensions = parseDimensionsArg(args.default_dimensions, 'default_dimensions')
      const { bags: resolvedDimBags, resolutions: dimensionResolutions } = await resolveDimensionBags(
        supabase,
        companyId,
        [defaultDimensions, ...lineItemsExt.map((_li, idx) => lineDimensionsMap.get(idx + 1))],
      )
      const resolvedDefaultDimensions = resolvedDimBags[0]

      // Translate extracted line items into the supplier_invoice_items shape.
      // Priority: line_overrides → per-line accountSuggestion → supplier.default_expense_account → 4000.
      const lineItems = lineItemsExt.map((li, idx) => {
        const lineNumber = idx + 1
        const dimensions = resolvedDimBags[idx + 1]
        const lineTotal = Number(li.line_total ?? li.lineTotal ?? li.amount) || 0
        // The AI extraction contract (ExtractionSchema) carries vatRate as a
        // percent integer (25, 12, 6) while supplier_invoice_items stores a
        // decimal fraction (0.25): normalize at this boundary or vat_rate 25
        // books 2500 % VAT downstream (issue #310). Foreign rates (19, 20)
        // map to 0 per the extraction contract: the strict Swedish allowlist
        // applies when converting to a supplier invoice.
        const vatRate = normalizeVatRateToDecimal(li.vat_rate ?? li.vatRate)
        // Real extractions carry no per-line VAT amount: derive it from the
        // normalized rate so the staged header vat_amount (summed below) is
        // honest instead of 0, which would gate the whole 2641 posting off.
        const rawVatAmount = li.vat_amount ?? li.vatAmount
        const vatAmount = rawVatAmount == null
          ? roundOre(lineTotal * vatRate)
          : Number(rawVatAmount) || 0
        return {
          line_number: lineNumber,
          description: (li.description as string) ?? `Position ${lineNumber}`,
          quantity: Number(li.quantity) || 1,
          unit: (li.unit as string) ?? 'st',
          unit_price: Number(li.unit_price ?? li.unitPrice ?? li.amount) || 0,
          line_total: lineTotal,
          account_number: lineOverrideMap.get(lineNumber) ?? (li.accountSuggestion as string | null) ?? supplierDefaultExpenseAccount ?? '4000',
          vat_rate: vatRate,
          vat_amount: vatAmount,
          ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
        }
      })

      // Derive from the actual per-line VAT rather than trusting
      // totalsExt.vat: that header figure comes straight from OCR/agent-
      // supplied extracted_data and is never reconciled against lineItems.
      // Per-line VAT customization (edited rate/amount on a line without
      // also fixing up the document totals) used to leave this at a stale
      // or zero value, and createSupplierInvoiceRegistrationEntry gates the
      // whole 2641 posting on invoice.vat_amount > 0: a stale header meant
      // the correct per-line VAT was silently never booked.
      const vatAmount = lineItems.reduce((sum, li) => sum + li.vat_amount, 0)

      const params = {
        inbox_item_id: inboxItemId,
        supplier_id: supplierId,
        document_id: inbox.document_id,
        supplier_invoice_number: supplierInvoiceNumber,
        invoice_date: invoiceDate,
        due_date: dueDate,
        currency,
        exchange_rate: exchangeRate,
        vat_treatment: vatTreatment,
        subtotal: Math.round(subtotal * 100) / 100,
        vat_amount: Math.round(vatAmount * 100) / 100,
        total: Math.round(total * 100) / 100,
        notes: (args.notes as string | undefined) ?? null,
        items: lineItems,
        ...(resolvedDefaultDimensions && Object.keys(resolvedDefaultDimensions).length > 0
          ? { default_dimensions: resolvedDefaultDimensions }
          : {}),
      }

      const previewData = {
        inbox_item_id: inboxItemId,
        supplier_id: supplierId,
        supplier_resolution: supplierResolution,
        extracted_supplier_name: supplierExt?.name ?? null,
        extracted_org_number: supplierExt?.organizationNumber ?? null,
        supplier_invoice_number: supplierInvoiceNumber,
        invoice_date: invoiceDate,
        due_date: dueDate,
        currency,
        exchange_rate: exchangeRate,
        exchange_rate_source: exchangeRate !== null ? 'riksbanken' : currency === 'SEK' ? 'not_applicable' : 'lookup_failed',
        vat_treatment: vatTreatment,
        subtotal: params.subtotal,
        vat_amount: params.vat_amount,
        total: params.total,
        line_count: lineItems.length,
        items_preview: lineItems.slice(0, 5),
        // Echoed for every non-exact dimension resolution (resolve-don't-
        // select) so the agent can verify what a name attached to.
        ...(dimensionResolutions.length > 0 ? { dimension_resolutions: dimensionResolutions } : {}),
        will: 'register supplier invoice (status=registered), attach the inbox document, post a registration journal entry on confirm: leverantörsskuld (2440) credited and the cost/VAT split debited per the per-line VAT rules',
      }

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'create_supplier_invoice_from_inbox',
        `Leverantörsfaktura: ${supplierInvoiceNumber} (${(supplierExt?.name as string) ?? 'okänd'})`,
        params,
        previewData,
        actor,
        {
          description: 'After approval, attest via gnubok_approve_supplier_invoice and pay via the bank flow.',
          tool: 'gnubok_get_inbox_item',
          args: { inbox_item_id: inboxItemId },
        },
        { dryRun, idempotencyKey },
      )
    },
  },

  {
    name: 'gnubok_list_unmatched_documents',
    title: 'List Unmatched Documents',
    description: 'List inbox documents not yet attached to any bank transaction, supplier invoice, or journal entry. Returns vendor/amount/currency/date hints. Amount is in the invoice currency; FX-normalise before comparing to transactions.amount.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        cursor: { type: 'string', description: 'Composite "<created_at>__<inbox_item_id>" from previous page (exclusive). Pass next_cursor verbatim.' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        count: { type: 'number' },
        next_cursor: { type: 'string', description: 'Pass as cursor on next call. Absent = no more pages.' },
      },
      required: ['items', 'count'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)
      const cursor = typeof args.cursor === 'string' ? args.cursor : null

      // Composite cursor: "<created_at>__<id>". Falls back to plain timestamp
      // for backward compat with older callers.
      let cursorTs: string | null = null
      let cursorId: string | null = null
      if (cursor) {
        const sep = cursor.indexOf('__')
        if (sep === -1) {
          cursorTs = cursor
        } else {
          cursorTs = cursor.slice(0, sep)
          cursorId = cursor.slice(sep + 2)
        }
      }

      // Pull recent inbox items with a document, no supplier invoice and no
      // direct journal entry yet (both are terminal links per the same
      // "processed" semantics gnubok_list_inbox_items uses), then filter out
      // those whose document is already pinned to a transaction.
      // Two-step query because PostgREST doesn't expose anti-joins.
      const fetchSize = limit * 2
      let inboxQuery = supabase
        .from('invoice_inbox_items')
        .select('id, document_id, source, email_from, email_subject, email_received_at, extracted_data, created_at')
        .eq('company_id', companyId)
        .not('document_id', 'is', null)
        .is('created_supplier_invoice_id', null)
        .is('created_journal_entry_id', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(fetchSize)

      if (cursorTs && cursorId) {
        // (created_at, id) < (cursorTs, cursorId): keyset pagination
        inboxQuery = inboxQuery.or(
          `created_at.lt.${cursorTs},and(created_at.eq.${cursorTs},id.lt.${cursorId})`
        )
      } else if (cursorTs) {
        inboxQuery = inboxQuery.lt('created_at', cursorTs)
      }

      const { data: inboxRows, error: inboxError } = await inboxQuery
      if (inboxError) throw new Error(`Database error: ${inboxError.message}`)
      if (!inboxRows || inboxRows.length === 0) {
        return { items: [], count: 0 }
      }

      const docIds = inboxRows.map((r) => r.document_id).filter((d): d is string => d != null)
      const { data: txMatches, error: txError } = await supabase
        .from('transactions')
        .select('document_id')
        .eq('company_id', companyId)
        .in('document_id', docIds)

      if (txError) throw new Error(`Database error: ${txError.message}`)
      const matchedDocIds = new Set((txMatches || []).map((t) => t.document_id))

      const unmatched = inboxRows
        .filter((r) => r.document_id && !matchedDocIds.has(r.document_id))
        .slice(0, limit)
        .map((item) => {
          const extracted = item.extracted_data as Record<string, unknown> | null
          let vendorName: string | null = null
          let orgNumber: string | null = null
          let amount: number | null = null
          let currency: string | null = null
          let invoiceDate: string | null = null
          let paymentReference: string | null = null

          if (extracted) {
            const supplier = extracted.supplier as Record<string, unknown> | undefined
            const invoice = extracted.invoice as Record<string, unknown> | undefined
            const totals = extracted.totals as Record<string, unknown> | undefined
            vendorName = (supplier?.name as string) || null
            orgNumber = (supplier?.orgNumber as string) || null
            amount = (totals?.total as number) || null
            // Surface currency alongside amount so the agent doesn't compare a
            // non-SEK invoice numerically to a SEK transaction. transactions.amount
            // is in transactions.currency; if these don't match, the agent must
            // FX-normalise before ranking matches. Defaulting to null when absent
            // (rather than 'SEK') makes the missing-currency case explicit.
            currency = (invoice?.currency as string) || null
            invoiceDate = (invoice?.invoiceDate as string) || null
            paymentReference = (invoice?.paymentReference as string) || null
          }

          return {
            inbox_item_id: item.id,
            document_id: item.document_id,
            source: item.source,
            created_at: item.created_at,
            email_from: item.email_from,
            email_subject: item.email_subject,
            email_received_at: item.email_received_at,
            vendor_name: vendorName,
            org_number: orgNumber,
            amount,
            currency,
            invoice_date: invoiceDate,
            payment_reference: paymentReference,
          }
        })

      // Pagination contract: emit next_cursor whenever the caller might be
      // missing rows. Two cases:
      //   (a) slice was full → cursor on last returned item (next page picks up
      //       any leftover unmatched rows we filtered past);
      //   (b) slice was short but inbox query returned a full batch → cursor on
      //       last inspected row (more unmatched may exist deeper in the inbox).
      // Only suppress the cursor when we exhausted the inbox stream entirely.
      let nextCursor: string | null = null
      if (unmatched.length === limit) {
        const last = unmatched[unmatched.length - 1]
        nextCursor = `${last.created_at}__${last.inbox_item_id}`
      } else if (inboxRows.length === fetchSize) {
        const last = inboxRows[inboxRows.length - 1]
        nextCursor = `${last.created_at}__${last.id}`
      }

      return {
        items: unmatched,
        count: unmatched.length,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      }
    },
  },

  {
    name: 'gnubok_get_document_content',
    title: 'Get Document Content',
    description: 'Get a 5-minute signed download URL for a document so the agent can read its contents (e.g. with vision). Use after gnubok_list_unmatched_documents to inspect a specific PDF before deciding which transaction it matches.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document_attachments row' },
      },
      required: ['document_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string' },
        file_name: { type: 'string' },
        mime_type: { type: 'string' },
        size_bytes: { type: 'number' },
        signed_url: { type: 'string' },
        expires_at: { type: 'string' },
      },
      required: ['document_id', 'file_name', 'signed_url', 'expires_at'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const documentId = args.document_id as string
      if (!documentId) throw new Error('document_id is required')

      const { data: doc, error: docError } = await supabase
        .from('document_attachments')
        .select('id, file_name, mime_type, file_size_bytes, storage_path')
        .eq('id', documentId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (docError) throw new Error(`Database error: ${docError.message}`)
      if (!doc) throw new Error('Document not found')

      const ttlSeconds = 300
      const { data: signed, error: signError } = await supabase.storage
        .from('documents')
        .createSignedUrl(doc.storage_path, ttlSeconds)

      if (signError || !signed) {
        throw new Error(`Failed to create signed URL: ${signError?.message ?? 'unknown error'}`)
      }

      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()

      return {
        document_id: doc.id,
        file_name: doc.file_name,
        mime_type: doc.mime_type,
        size_bytes: doc.file_size_bytes,
        signed_url: signed.signedUrl,
        expires_at: expiresAt,
      }
    },
  },

  {
    name: 'gnubok_link_document_to_voucher',
    title: 'Link Document to Voucher',
    description: 'Stage linking a document to a posted verifikation. Use for imported/manual vouchers with no bank-tx row. Call gnubok_list_verifikat_without_documents first to find targets. Stages for approval.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        document_id: { type: 'string', description: 'UUID of the document_attachments row' },
        journal_entry_id: { type: 'string', description: 'UUID of the target journal entry (verifikation)' },
        journal_entry_line_id: { type: 'string', description: 'Optional UUID to pin the doc to a specific debit/credit line' },
        idempotency_key: { type: 'string', description: 'Optional UUID to dedupe retries' },
        dry_run: { type: 'boolean', description: 'Preview without staging' },
      },
      required: ['document_id', 'journal_entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const documentId = args.document_id as string
      const journalEntryId = args.journal_entry_id as string
      const journalEntryLineId = typeof args.journal_entry_line_id === 'string' ? args.journal_entry_line_id : undefined
      if (!documentId) throw new Error('document_id is required')
      if (!journalEntryId) throw new Error('journal_entry_id is required')

      const [docRes, jeRes] = await Promise.all([
        supabase
          .from('document_attachments')
          .select('id, file_name, mime_type, journal_entry_id')
          .eq('id', documentId)
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('journal_entries')
          .select('id, entry_date, description, voucher_series, voucher_number, status')
          .eq('id', journalEntryId)
          .eq('company_id', companyId)
          .maybeSingle(),
      ])

      if (docRes.error || !docRes.data) throw new Error('Document not found')
      if (jeRes.error || !jeRes.data) throw new Error('Journal entry not found')

      const doc = docRes.data as {
        id: string; file_name: string; mime_type: string; journal_entry_id: string | null
      }
      const je = jeRes.data as {
        id: string; entry_date: string; description: string
        voucher_series: string | null; voucher_number: number | null; status: string
      }

      const voucherLabel = je.voucher_series && je.voucher_number
        ? `${je.voucher_series}${je.voucher_number}`
        : je.id.slice(0, 8)

      const currentlyLinkedToSameJe = doc.journal_entry_id === journalEntryId
      const currentlyLinkedToOther = !!doc.journal_entry_id && !currentlyLinkedToSameJe

      return stagePendingOperation(
        supabase, companyId, userId, 'link_document_to_voucher',
        `Koppla bilaga: ${doc.file_name} → verifikat ${voucherLabel}`,
        { document_id: documentId, journal_entry_id: journalEntryId, journal_entry_line_id: journalEntryLineId ?? null },
        {
          document_file_name: doc.file_name,
          document_mime_type: doc.mime_type,
          document_already_linked: currentlyLinkedToSameJe,
          document_currently_linked_to_other: currentlyLinkedToOther,
          document_current_journal_entry_id: doc.journal_entry_id ?? null,
          voucher_label: voucherLabel,
          voucher_date: je.entry_date,
          voucher_description: je.description,
          voucher_status: je.status,
          journal_entry_line_id: journalEntryLineId ?? null,
        },
        actor,
        undefined,
        {
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
          dryRun: args.dry_run === true,
          dateForPeriodCheck: je.entry_date,
        }
      )
    },
  },

  // ── Stream 1 Phase 1: Bookkeeping write (high-risk, always staged) ──

  {
    name: 'gnubok_close_period',
    title: 'Close Fiscal Period',
    description: 'Stage period close (irreversible per BFL). Requires period locked + year-end closing entry posted. High-risk: always staged, never auto-committed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to close' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period, error: fetchError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Period is already closed')
      if (!period.locked_at) throw new Error('Period must be locked before closing: call gnubok_lock_period first')
      if (!period.closing_entry_id) throw new Error('Year-end closing entry must exist before the period can be closed')

      return stagePendingOperation(supabase, companyId, userId, 'close_period',
        `Stäng period: ${period.name} (${period.period_start} till ${period.period_end})`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          locked_at: period.locked_at,
          closing_entry_id: period.closing_entry_id,
          irreversible: true,
        },
        actor,
        {
          description: 'Closing is irreversible. Verify the balance sheet and income statement first.',
          tool: 'gnubok_get_balance_sheet',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_lock_period',
    title: 'Lock Fiscal Period',
    description: 'Stage period lock: blocks new entries. Requires zero untriaged or unbooked business transactions in the period. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to lock' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period, error: fetchError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Period is already closed')
      if (period.locked_at) throw new Error('Period is already locked')

      // Same predicate the commit path (lockPeriod in period-service.ts)
      // enforces, so the approval card can never claim zero unbooked while
      // the period holds untriaged or unbooked business transactions. Fail
      // closed: a guard that cannot run must not wave the staging through.
      let unbooked: { untriaged: number; businessUnbooked: number }
      try {
        unbooked = await countUnbookedInPeriod(
          supabase, companyId, period.period_start, period.period_end,
        )
      } catch (err) {
        log.error('lock-period staging guard failed, refusing to stage', {
          companyId,
          fiscalPeriodId,
          reason: err instanceof Error ? err.message : String(err),
        })
        // Deliberately matches NEITHER of the two load-bearing phrases below:
        // an unreachable DB must not send an agent off remediating
        // transactions (mirrors period-service.ts).
        throw new Error(
          'Kunde inte kontrollera obokförda banktransaktioner i perioden. Ingen låsning har föreslagits. Försök igen.'
        )
      }

      const blockingCount = unbooked.untriaged + unbooked.businessUnbooked
      if (blockingCount > 0) {
        // Wording mirrors lockPeriod in period-service.ts and is load-bearing:
        // "saknar bokföring" and /Kan inte låsa period:.*affärstransaktion/
        // both feed matchers (inferCode in lib/errors/get-structured-error.ts
        // derives PERIOD_HAS_UNBOOKED_TRANSACTIONS for the MCP surface).
        const breakdown = [
          unbooked.untriaged > 0 ? `${unbooked.untriaged} ej hanterade` : null,
          unbooked.businessUnbooked > 0
            ? `${unbooked.businessUnbooked} markerade som affärshändelse men utan verifikat`
            : null,
        ]
          .filter(Boolean)
          .join(', ')
        throw new Error(
          `Kan inte låsa period: ${blockingCount} banktransaktion(er) i perioden saknar bokföring ` +
            `(${breakdown}). Alla affärstransaktioner måste vara bokförda innan perioden låses. ` +
            `Bokför dem eller markera dem som privata eller ignorerade, och lås perioden därefter.`
        )
      }

      return stagePendingOperation(supabase, companyId, userId, 'lock_period',
        `Lås period: ${period.name} (${period.period_start} till ${period.period_end})`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          // Both guard legs verified zero above; the commit path re-checks via
          // lockPeriod, so this figure can never silently go stale.
          unbooked_business_transactions: 0,
          untriaged_transactions: 0,
        },
        actor,
        {
          description: 'After locking, run year-end closing before the period can be closed via gnubok_close_period. Verify balances first with gnubok_get_trial_balance.',
          tool: 'gnubok_get_trial_balance',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },


  {
    name: 'gnubok_export_sie',
    title: 'Export SIE File',
    description: 'Generate SIE-4 file for a fiscal period (standard Swedish bookkeeping interchange format). Returns SIE text content.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to export' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string' },
        byte_size: { type: 'number' },
        fiscal_period_id: { type: 'string' },
        company_name: { type: 'string' },
        generated_at: { type: 'string' },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: company } = await supabase
        .from('company_settings')
        .select('company_name, org_number')
        .eq('company_id', companyId)
        .single()

      if (!company) throw new Error('Company settings not found')

      const sieContent = await generateSIEExport(supabase, companyId, {
        fiscal_period_id: fiscalPeriodId,
        company_name: company.company_name || 'Unknown',
        org_number: company.org_number,
      })

      return {
        content: sieContent,
        byte_size: Buffer.byteLength(sieContent, 'utf8'),
        fiscal_period_id: fiscalPeriodId,
        company_name: company.company_name,
        org_number: company.org_number,
        generated_at: new Date().toISOString(),
      }
    },
  },

  {
    name: 'gnubok_generate_rot_rut_file',
    title: 'Generate Rot/Rut Payout File',
    description:
      'Begäran om utbetalning for rot/rut (Skatteverket husavdrag): XML file from paid deduction invoices, uploaded manually on skatteverket.se (no API exists). Call with list_only=true first to see eligible invoices and blockers. Generating records an active begäran per invoice.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deduction_type: { type: 'string', enum: ['rot', 'rut'] },
        list_only: {
          type: 'boolean',
          description: 'Only list eligible + blocked invoices, generate nothing (default false)',
        },
        invoice_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Invoices to include. Omitted = all currently eligible.',
        },
        name: {
          type: 'string',
          maxLength: 16,
          description: 'NamnPaBegaran shown in Skatteverkets e-tjänst (max 16 chars). Omitted = generated.',
        },
      },
      required: ['deduction_type'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deduction_type: { type: 'string' },
        eligible: { type: 'array', items: { type: 'object' } },
        blocked: {
          type: 'array',
          items: { type: 'object' },
          description: 'Invoices excluded from begäran with per-invoice blocker code + Swedish message',
        },
        generated: { type: 'boolean' },
        request_id: { type: ['string', 'null'] },
        file_name: { type: ['string', 'null'] },
        xml: { type: ['string', 'null'], description: 'File content: save as UTF-8 .xml and upload on skatteverket.se' },
        requested_total: { type: 'number' },
        arenden: { type: 'array', items: { type: 'object' } },
        warnings: { type: 'array', items: { type: 'string' } },
        upload_url: { type: 'string' },
      },
      required: ['deduction_type', 'generated'],
    },
    annotations: {
      readOnlyHint: false, // records a rot_rut_payout_requests row when generating
      destructiveHint: false,
      idempotentHint: false, // second call conflicts (one active begäran per invoice)
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const type = args.deduction_type as 'rot' | 'rut'
      if (type !== 'rot' && type !== 'rut') throw new Error('deduction_type must be rot or rut')
      const uploadUrl = 'https://www7.skatteverket.se/portal/rotrut/begar-utbetalning/fil'

      const candidates = await listRotRutCandidates(supabase, companyId, type)
      if (!candidates.ok) throw new Error('Failed to list rot/rut candidates')

      if (args.list_only === true) {
        return {
          deduction_type: type,
          eligible: candidates.eligible,
          blocked: candidates.blocked,
          generated: false,
          request_id: null,
          file_name: null,
          xml: null,
          requested_total: candidates.eligible.reduce((sum, e) => sum + e.begart_belopp, 0),
          warnings: [],
          upload_url: uploadUrl,
        }
      }

      const requestedIds = Array.isArray(args.invoice_ids) && args.invoice_ids.length > 0
        ? (args.invoice_ids as string[])
        : candidates.eligible.map((e) => e.invoice_id)
      if (requestedIds.length === 0) {
        return {
          deduction_type: type,
          eligible: [],
          blocked: candidates.blocked,
          generated: false,
          request_id: null,
          file_name: null,
          xml: null,
          requested_total: 0,
          warnings: ['Inga fakturor är redo att begäras. Se blocked för orsaker per faktura.'],
          upload_url: uploadUrl,
        }
      }

      const result = await createRotRutPayoutRequest(supabase, companyId, userId, {
        type,
        invoiceIds: requestedIds,
        name: typeof args.name === 'string' ? args.name : undefined,
      })

      if (!result.ok) {
        const blockerLines = (result.blockers ?? [])
          .map((b) => `${b.invoice_number ?? b.invoice_id}: ${b.message}`)
          .join(' | ')
        throw new Error(
          result.code === 'ROT_RUT_INVOICE_CONFLICT'
            ? 'Minst en faktura ingår redan i en aktiv begäran om utbetalning.'
            : `Filen kunde inte skapas (${result.code}).${blockerLines ? ` ${blockerLines}` : ''}`,
        )
      }

      return {
        deduction_type: type,
        eligible: candidates.eligible,
        blocked: candidates.blocked,
        generated: true,
        request_id: result.request.id as string,
        file_name: result.file.file_name,
        xml: result.file.xml,
        requested_total: result.file.requested_total,
        arenden: result.file.arenden,
        warnings: result.file.warnings,
        upload_url: uploadUrl,
      }
    },
  },

  {
    name: 'gnubok_import_rot_rut_beslut',
    title: 'Import Rot/Rut Decision File',
    description:
      'Import Skatteverkets beslutsfil (decision JSON from the rot/rut e-tjänst) and record godkänt belopp on the matching begäran. Exact matching only; per-beslut outcomes in results. Book the payout afterwards via the settle endpoint hint in next.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_content: {
          type: 'string',
          description: 'The beslutsfil content verbatim (JSON text as downloaded from skatteverket.se)',
        },
      },
      required: ['file_content'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        imported: { type: 'number' },
        already_imported: { type: 'number' },
        errors: { type: 'number' },
        results: {
          type: 'array',
          items: { type: 'object' },
          description: 'Per-beslut outcome: status imported/already_imported/error, request_id, decided_total, rejected flag, next-step hint',
        },
      },
      required: ['imported', 'already_imported', 'errors', 'results'],
    },
    annotations: {
      readOnlyHint: false, // records beslut on rot_rut_payout_requests
      destructiveHint: false,
      idempotentHint: true, // re-importing the same file reports already_imported
      openWorldHint: false,
    },
    async execute(args, companyId, _userId, supabase) {
      const raw = args.file_content as string
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error('file_content is required (the beslutsfil JSON text)')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error('file_content är inte giltig JSON. Klistra in beslutsfilen oförändrad.')
      }
      const validated = RotRutBeslutFileSchema.safeParse(parsed)
      if (!validated.success) {
        throw new Error(
          `Beslutsfilen har fel format: ${validated.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        )
      }

      const result = await importRotRutBeslutFile(supabase, companyId, validated.data)
      if (!result.ok) {
        throw new Error(
          result.code === 'ROT_RUT_BESLUT_WRONG_COMPANY'
            ? 'Beslutsfilens utförare matchar inte företagets organisationsnummer.'
            : 'Beslutsfilen kunde inte importeras.',
        )
      }

      return {
        imported: result.imported,
        already_imported: result.already_imported,
        errors: result.errors,
        results: result.results,
      }
    },
  },

  {
    name: 'gnubok_audit_package',
    title: 'Generate Audit Package',
    description: "Single-call audit package for a fiscal period: SIE-4 + reports (trial balance, income statement, balance sheet, general ledger, journal, VAT) + receipts + audit log + voucher gaps, zipped. 1-hour signed URL.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to package' },
        include_documents: { type: 'boolean', description: 'Include receipts/document binaries in the zip (default true)' },
        estimate_only: { type: 'boolean', description: 'Return size estimate without generating (default false)' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        download_url: { type: ['string', 'null'], description: 'Signed Supabase Storage URL valid for 1 hour. Null when estimate_only=true.' },
        storage_path: { type: ['string', 'null'] },
        file_name: { type: 'string' },
        size_bytes: { type: 'number' },
        size_limit_bytes: { type: 'number' },
        within_limit: { type: 'boolean' },
        period: { type: 'object' },
        generated_at: { type: 'string' },
        expires_at: { type: ['string', 'null'] },
        estimate_only: { type: 'boolean' },
      },
      required: ['file_name', 'size_bytes', 'period', 'generated_at', 'estimate_only'],
    },
    annotations: {
      readOnlyHint: false,  // produces a Storage artifact
      destructiveHint: false,
      idempotentHint: true,  // repeat calls produce equivalent archives, fresh URL
      openWorldHint: false,
    },
    // Archive generation is the one genuinely long-running synchronous call
    // in the catalog: task-capable clients get a durable handle instead of a
    // multi-minute blocking response. Size estimates stay synchronous.
    shouldRunAsTask: (args) => args.estimate_only !== true,
    async execute(args, companyId, userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const includeDocuments = args.include_documents !== false
      const estimateOnly = args.estimate_only === true
      const SIZE_LIMIT_BYTES = 80 * 1024 * 1024

      // Verify period belongs to the company
      const { data: period, error: periodErr } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      if (periodErr || !period) throw new Error('Fiscal period not found')

      const generatedAt = new Date().toISOString()

      // Pre-flight size estimate: also serves the estimate-only path
      const estimate = await estimateArchiveSize(supabase, companyId, 'period', fiscalPeriodId)
      const sizeBytes = estimate.total_bytes
      const withinLimit = sizeBytes <= SIZE_LIMIT_BYTES

      const fileName = `arkiv_${period.name.replace(/[^\w-]/g, '_')}_${fiscalPeriodId.slice(0, 8)}.zip`

      if (estimateOnly) {
        return {
          download_url: null,
          storage_path: null,
          file_name: fileName,
          size_bytes: sizeBytes,
          size_limit_bytes: SIZE_LIMIT_BYTES,
          within_limit: withinLimit,
          period: {
            id: period.id,
            name: period.name,
            period_start: period.period_start,
            period_end: period.period_end,
          },
          generated_at: generatedAt,
          expires_at: null,
          estimate_only: true,
        }
      }

      if (includeDocuments && !withinLimit) {
        throw new Error(
          `Archive would exceed ${Math.round(SIZE_LIMIT_BYTES / 1024 / 1024)} MB (estimate: ${Math.round(sizeBytes / 1024 / 1024)} MB). Retry with include_documents=false to omit receipt binaries.`
        )
      }

      // Generate the archive (long-running)
      const zipBuffer = await generateFullArchive(supabase, companyId, {
        scope: 'period',
        period_id: fiscalPeriodId,
        include_documents: includeDocuments,
      })

      // Upload to Storage under a per-user audit-packages folder
      const storagePath = `${userId}/audit-packages/${Date.now()}_${fileName}`
      const { error: uploadErr } = await supabase.storage
        .from('documents')
        .upload(storagePath, new Uint8Array(zipBuffer), {
          contentType: 'application/zip',
          upsert: false,
        })
      if (uploadErr) throw new Error(`Failed to upload archive: ${uploadErr.message}`)

      // Sign for 1 hour
      const SIGNED_URL_TTL_SECONDS = 3600
      const { data: signed, error: signErr } = await supabase.storage
        .from('documents')
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)
      if (signErr || !signed) {
        // Best-effort cleanup of the uploaded blob if signing failed
        await supabase.storage.from('documents').remove([storagePath])
        throw new Error(`Failed to sign archive URL: ${signErr?.message ?? 'unknown error'}`)
      }

      const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString()

      return {
        download_url: signed.signedUrl,
        storage_path: storagePath,
        file_name: fileName,
        size_bytes: zipBuffer.byteLength,
        size_limit_bytes: SIZE_LIMIT_BYTES,
        within_limit: true,
        period: {
          id: period.id,
          name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
        },
        generated_at: generatedAt,
        expires_at: expiresAt,
        estimate_only: false,
      }
    },
  },

  // ── Stream 1 Phase 1 follow-up: year-end, opening balances, revaluation,
  //    voucher gaps, supplier-invoice lifecycle, proforma conversion ──

  {
    name: 'gnubok_year_end_readiness',
    title: 'Year-End Readiness Check',
    // Budget: 280 chars (output-schema.test.ts). Spend it on the blockers an
    // agent can act on BEFORE calling, in likelihood order. The four
    // period-state kinds (period_not_found / _not_ended / _already_closed /
    // closing_entry_exists) collapse into "period-state": nothing to pre-check
    // there, the period either is closable or is not. Open items in foreign
    // currency are warnings, never blockers, because executeYearEndClosing
    // revalues them in step 2 (lib/core/bookkeeping/year-end-service.ts).
    description: "Pre-flight for irreversible gnubok_run_year_end. Blockers: unbooked_transactions (most common), draft_entries, unexplained_voucher_gap, sequence_mismatch, trial_balance_unbalanced, opening_balance_continuity, next_period_ib_posted, period-state. FX = warning, never blocker.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to year-end' },
        include_preview: { type: 'boolean', description: 'If true, also return the would-be closing journal entry preview (default false)' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        period: { type: 'object' },
        ready: { type: 'boolean' },
        blockers: { type: 'array', items: { type: 'object' } },
        warnings: { type: 'array', items: { type: 'string' } },
        draft_count: { type: 'number' },
        unexplained_voucher_gap_count: { type: 'number' },
        sequence_mismatch_count: { type: 'number' },
        trial_balance_balanced: { type: 'boolean' },
        preview: { type: ['object', 'null'] },
        summary: { type: 'string' },
      },
      required: ['ready', 'blockers', 'warnings', 'summary'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      const includePreview = args.include_preview === true
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      // Fetch period for context (the validate function returns errors if not found,
      // but agents benefit from period metadata in the response)
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id, continuity_verified')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (!period) throw new Error('Fiscal period not found')

      const validation = await validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId)

      // Reshape the lib's blockers into structured entries so the agent (and
      // any dashboard) can render and act on each one independently. Routing
      // keys off the stable YearEndBlockerCode via YEAR_END_BLOCKER_KIND, so a
      // reworded Swedish message no longer silently reclassifies as 'other'.
      // The `kind` strings are this tool's public contract: never rename one.
      // A blocker with no mapped code falls back to the wording heuristic
      // (which also catches legacy English messages), then to 'other'.
      const blockers = validation.blockers.map(({ code, message }) => ({
        kind: YEAR_END_BLOCKER_KIND[code] ?? classifyYearEndBlockerMessage(message),
        severity: 'high' as const,
        message,
      }))

      let preview = null
      if (includePreview && validation.ready) {
        try {
          preview = await previewYearEndClosing(supabase, companyId, userId, fiscalPeriodId)
        } catch (err) {
          // Preview is opportunistic: never fail the readiness check on it.
          preview = { error: err instanceof Error ? err.message : 'Preview unavailable' }
        }
      }

      const summary = validation.ready
        ? validation.warnings.length > 0
          ? `Klart för bokslut. ${validation.warnings.length} varning(ar) att granska.`
          : 'Klart för bokslut.'
        : `Inte klart: ${blockers.length} blockerare måste åtgärdas.`

      return {
        period: {
          id: period.id,
          name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          is_closed: period.is_closed,
          locked_at: period.locked_at,
          closing_entry_id: period.closing_entry_id,
          continuity_verified: period.continuity_verified,
        },
        ready: validation.ready,
        blockers,
        warnings: validation.warnings,
        draft_count: validation.draftCount,
        unexplained_voucher_gap_count: validation.unexplainedGaps.length,
        sequence_mismatch_count: validation.sequenceMismatches.length,
        trial_balance_balanced: validation.trialBalanceBalanced,
        preview,
        summary,
      }
    },
  },

  {
    name: 'gnubok_run_year_end',
    title: 'Run Year-End Closing (Bokslut)',
    description: 'Stage year-end closing: zero result accounts (class 3-8) into 2099, lock period, create next period, seed opening balances. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to close out' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at')
        .eq('id', fiscalPeriodId).eq('company_id', companyId).single()

      if (!period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Period is already closed')

      return stagePendingOperation(supabase, companyId, userId, 'run_year_end',
        `Bokslut: ${period.name}`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          will: 'zero result accounts into 2099, lock period, create next period, generate opening balances',
        },
        actor,
        {
          description: 'After year-end, the period is locked and ready for closing via gnubok_close_period.',
          tool: 'gnubok_close_period',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_set_opening_balances',
    title: 'Set Opening Balances (Ingående Balans)',
    description: 'Stage opening-balance entry: copy class 1-2 closing balances from a closed period into the next period.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        closed_period_id: { type: 'string', description: 'UUID of the closed source period' },
        next_period_id: { type: 'string', description: 'UUID of the next (target) period' },
      },
      required: ['closed_period_id', 'next_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const closedId = args.closed_period_id as string
      const nextId = args.next_period_id as string
      if (!closedId || !nextId) throw new Error('closed_period_id and next_period_id are required')

      // Resolve human-readable period names so the approver doesn't see two raw
      // UUIDs in the staged-ops list. Both lookups are scoped to the company so
      // a mis-typed UUID from another tenant just yields a thin (but safe) title.
      const [{ data: closed }, { data: next }] = await Promise.all([
        supabase.from('fiscal_periods').select('name, period_end').eq('id', closedId).eq('company_id', companyId).maybeSingle(),
        supabase.from('fiscal_periods').select('name, period_start').eq('id', nextId).eq('company_id', companyId).maybeSingle(),
      ])
      const closedLabel = closed?.name ?? closedId
      const nextLabel = next?.name ?? nextId

      return stagePendingOperation(supabase, companyId, userId, 'set_opening_balances',
        `Ingående balans: ${closedLabel} → ${nextLabel}`,
        { closed_period_id: closedId, next_period_id: nextId },
        {
          closed_period_id: closedId,
          closed_period_name: closed?.name ?? null,
          next_period_id: nextId,
          next_period_name: next?.name ?? null,
          will: 'create opening balance entry from closed-period trial balance',
        },
        actor,
        {
          description: 'After approval, verify the opening balance matches the closed period\'s UB via gnubok_get_trial_balance on the next period.',
          tool: 'gnubok_get_trial_balance',
          args: { fiscal_period_id: nextId },
        }
      )
    },
  },

  {
    name: 'gnubok_run_currency_revaluation',
    title: 'Run Currency Revaluation',
    description: 'Stage currency revaluation: revalue open FX receivables/payables to closing-date rate (posts 3960/7960). One per period max.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
        closing_date: { type: 'string', description: 'Revaluation date (YYYY-MM-DD)' },
      },
      required: ['fiscal_period_id', 'closing_date'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      const closingDate = args.closing_date as string
      if (!fiscalPeriodId || !closingDate) throw new Error('fiscal_period_id and closing_date are required')

      return stagePendingOperation(supabase, companyId, userId, 'run_currency_revaluation',
        `Valutaomvärdering ${closingDate}`,
        { fiscal_period_id: fiscalPeriodId, closing_date: closingDate },
        { fiscal_period_id: fiscalPeriodId, closing_date: closingDate, posts_to: ['3960', '7960'] },
        actor,
        {
          description: 'After approval, confirm the new FX-adjusted balances via gnubok_get_balance_sheet.',
          tool: 'gnubok_get_balance_sheet',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_list_voucher_gaps',
    title: 'List Voucher Gaps',
    description: 'List voucher number gaps in a fiscal period (BFNAR 2013:2 audit requirement). Each gap shows whether it has an explanation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string' },
        voucher_series: { type: 'string', description: 'Optional series filter (e.g. "A")' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        gaps: { type: 'array', items: { type: 'object' } },
        total_gaps: { type: 'number' },
        unexplained_gaps: { type: 'number' },
      },
      required: ['gaps', 'total_gaps', 'unexplained_gaps'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase) {
      const fiscalPeriodId = args.fiscal_period_id as string
      const voucherSeries = args.voucher_series as string | undefined

      let seriesQuery = supabase
        .from('voucher_sequences').select('voucher_series')
        .eq('company_id', companyId).eq('fiscal_period_id', fiscalPeriodId)
      if (voucherSeries) seriesQuery = seriesQuery.eq('voucher_series', voucherSeries)

      const { data: seriesRows } = await seriesQuery
      if (!seriesRows || seriesRows.length === 0) {
        return { gaps: [], total_gaps: 0, unexplained_gaps: 0 }
      }

      const allGaps: Array<{ series: string; gap_start: number; gap_end: number; explanation: unknown }> = []
      for (const row of seriesRows) {
        const { data: gaps } = await supabase.rpc('detect_voucher_gaps', {
          p_company_id: companyId,
          p_fiscal_period_id: fiscalPeriodId,
          p_series: row.voucher_series,
        })
        if (gaps) {
          for (const gap of gaps as Array<{ gap_start: number; gap_end: number }>) {
            allGaps.push({ series: row.voucher_series, gap_start: gap.gap_start, gap_end: gap.gap_end, explanation: null })
          }
        }
      }

      if (allGaps.length > 0) {
        const { data: explanations } = await supabase
          .from('voucher_gap_explanations')
          .select('id, voucher_series, gap_start, gap_end, explanation, created_at')
          .eq('company_id', companyId).eq('fiscal_period_id', fiscalPeriodId)
        if (explanations) {
          const map = new Map(explanations.map((e) => [`${e.voucher_series}:${e.gap_start}:${e.gap_end}`, e]))
          for (const g of allGaps) {
            g.explanation = map.get(`${g.series}:${g.gap_start}:${g.gap_end}`) ?? null
          }
        }
      }

      return {
        gaps: allGaps,
        total_gaps: allGaps.length,
        unexplained_gaps: allGaps.filter((g) => !g.explanation).length,
      }
    },
  },

  {
    name: 'gnubok_set_voucher_note',
    title: 'Set Voucher Note (Anteckning)',
    description: 'Stage setting, replacing or clearing the internal note (anteckning) on a verifikat. Notes are annotation metadata, editable even on posted entries: bookkeeping fields stay immutable. Read them via gnubok_query_journal (entry_notes).',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        journal_entry_id: { type: 'string', description: 'Verifikat UUID (find via gnubok_query_journal).' },
        notes: {
          type: ['string', 'null'],
          description: 'New note (max 2000 chars), replaces the old one; null or empty clears.',
        },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging.' },
        idempotency_key: { type: 'string', description: 'Per-operation UUID for safe retries (24h TTL).' },
      },
      required: ['journal_entry_id', 'notes'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(args, companyId, userId, supabase, actor) {
      const journalEntryId = String(args.journal_entry_id ?? '').trim()
      if (!journalEntryId) throw new Error('journal_entry_id is required')

      if (args.notes !== null && typeof args.notes !== 'string') {
        throw new Error('notes must be a string (max 2000 chars) or null to clear the note')
      }
      // Whitespace-only → null so the column never stores visually-empty
      // annotations (same normalisation as the commit-boundary schema).
      const notes = typeof args.notes === 'string' && args.notes.trim() !== '' ? args.notes : null
      if (notes !== null && notes.length > 2000) {
        throw new Error('notes must be 2000 characters or shorter')
      }

      const { data: entry, error: fetchErr } = await supabase
        .from('journal_entries')
        .select('id, voucher_series, voucher_number, entry_date, description, status, notes')
        .eq('id', journalEntryId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (fetchErr) throw new Error(`Database error: ${fetchErr.message}`)
      if (!entry) throw new Error('Verifikationen hittades inte.')

      const voucherLabel = entry.voucher_number
        ? `${entry.voucher_series ?? ''}${entry.voucher_number}`
        : 'utkast'

      return stagePendingOperation(supabase, companyId, userId, 'set_voucher_note',
        notes === null
          ? `Rensa anteckning på verifikat ${voucherLabel}`
          : `Anteckning på verifikat ${voucherLabel}`,
        { journal_entry_id: journalEntryId, notes },
        {
          journal_entry_id: journalEntryId,
          voucher: voucherLabel,
          entry_description: entry.description,
          entry_status: entry.status,
          old_notes: entry.notes ?? null,
          new_notes: notes,
        },
        actor,
        undefined,
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
          dateForPeriodCheck: entry.entry_date,
        }
      )
    },
  },

  {
    name: 'gnubok_explain_voucher_gap',
    title: 'Explain Voucher Gap',
    description: 'Stage explanation for a voucher gap (BFNAR 2013:2 compliance, every gap needs a documented reason).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string' },
        voucher_series: { type: 'string' },
        gap_start: { type: 'number' },
        gap_end: { type: 'number' },
        explanation: { type: 'string', description: 'Swedish prose: why the gap exists' },
      },
      required: ['fiscal_period_id', 'voucher_series', 'gap_start', 'gap_end', 'explanation'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const explanation = args.explanation as string
      if (!explanation?.trim()) throw new Error('explanation is required')

      return stagePendingOperation(supabase, companyId, userId, 'explain_voucher_gap',
        `Förklara verifikationslucka ${args.voucher_series}:${args.gap_start}-${args.gap_end}`,
        {
          fiscal_period_id: args.fiscal_period_id,
          voucher_series: args.voucher_series,
          gap_start: args.gap_start,
          gap_end: args.gap_end,
          explanation: explanation.trim(),
        },
        {
          voucher_series: args.voucher_series,
          gap_start: args.gap_start,
          gap_end: args.gap_end,
          explanation: explanation.trim(),
        },
        actor,
        {
          description: 'After approval, run gnubok_list_voucher_gaps again to confirm all gaps in the period now have explanations (BFNAR 2013:2).',
          tool: 'gnubok_list_voucher_gaps',
          args: { fiscal_period_id: args.fiscal_period_id },
        }
      )
    },
  },

  {
    name: 'gnubok_approve_supplier_invoice',
    title: 'Approve Supplier Invoice',
    description: 'Stage approval of a supplier invoice that has not been attested yet (registered or overdue). An invoice that is still past its due date keeps the overdue label after approval. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { supplier_invoice_id: { type: 'string' } },
      required: ['supplier_invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.supplier_invoice_id as string
      if (!id) throw new Error('supplier_invoice_id is required')

      const { data: inv } = await supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, invoice_date, total, currency, status, approved_at, supplier:suppliers(name)')
        .eq('id', id).eq('company_id', companyId).single()
      if (!inv) throw new Error('Supplier invoice not found')
      // 'overdue' is approvable: the daily cron puts unbooked invoices there
      // just by aging (#1206). approved_at is the durable attest marker.
      if (!canApproveSupplierInvoice(inv)) {
        throw new Error('Fakturan är redan godkänd eller kan inte godkännas i nuvarande status')
      }

      return stagePendingOperation(supabase, companyId, userId, 'approve_supplier_invoice',
        `Godkänn leverantörsfaktura ${inv.supplier_invoice_number}`,
        { supplier_invoice_id: id },
        {
          supplier_invoice_number: inv.supplier_invoice_number,
          supplier_name: (inv.supplier as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          invoice_date: inv.invoice_date,
        },
        actor,
        {
          description: 'After approval the invoice is attested and ready for payment. When paid, link the payment via gnubok_link_supplier_invoice_to_voucher.',
          tool: 'gnubok_get_supplier_ledger',
        },
        inv.invoice_date ? { dateForPeriodCheck: inv.invoice_date } : {},
      )
    },
  },

  {
    name: 'gnubok_credit_supplier_invoice',
    title: 'Credit Supplier Invoice (Kreditfaktura)',
    description: 'Stage credit-note (kreditfaktura) for a supplier invoice: mirror invoice with negative effect + reverses registration JE (accrual).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { supplier_invoice_id: { type: 'string' } },
      required: ['supplier_invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.supplier_invoice_id as string
      if (!id) throw new Error('supplier_invoice_id is required')

      const { data: inv } = await supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, total, currency, status, supplier:suppliers(name)')
        .eq('id', id).eq('company_id', companyId).single()
      if (!inv) throw new Error('Supplier invoice not found')
      if (inv.status === 'credited') throw new Error('Fakturan har redan krediterats')

      return stagePendingOperation(supabase, companyId, userId, 'credit_supplier_invoice',
        `Kreditera leverantörsfaktura ${inv.supplier_invoice_number}`,
        { supplier_invoice_id: id },
        {
          supplier_invoice_number: inv.supplier_invoice_number,
          supplier_name: (inv.supplier as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          method: 'creates KREDIT- mirror invoice + reverses registration JE (accrual)',
        },
        actor,
        {
          description: 'After approval the credit note is posted and the leverantörsskuld cleared. Verify with gnubok_get_supplier_ledger.',
          tool: 'gnubok_get_supplier_ledger',
        }
      )
    },
  },

  {
    name: 'gnubok_convert_invoice',
    title: 'Convert Proforma to Invoice',
    description: 'Stage conversion of a proforma invoice to a real invoice. Allocates F-series number, copies items, marks proforma cancelled.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { invoice_id: { type: 'string' } },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.invoice_id as string
      if (!id) throw new Error('invoice_id is required')

      const { data: inv } = await supabase
        .from('invoices')
        .select('id, document_type, status, total, currency, customer:customers(name)')
        .eq('id', id).eq('company_id', companyId).single()
      if (!inv) throw new Error('Invoice not found')
      if (inv.document_type !== 'proforma') throw new Error('Endast proformafakturor kan konverteras')
      if (inv.status === 'cancelled') throw new Error('Denna proformafaktura har redan makuleras')

      const customerName = (inv.customer as { name?: string } | null)?.name ?? 'okänd kund'
      return stagePendingOperation(supabase, companyId, userId, 'convert_invoice',
        `Konvertera proforma → faktura: ${customerName} ${Math.round(Number(inv.total) * 100) / 100} ${inv.currency}`,
        { invoice_id: id },
        {
          customer_name: (inv.customer as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          will: 'allocate F-series number, copy items, cancel proforma',
        },
        actor,
        {
          description: 'After conversion, send the new invoice with gnubok_send_invoice.',
          tool: 'gnubok_send_invoice',
        }
      )
    },
  },

  {
    name: 'gnubok_unlock_period',
    title: 'Unlock Fiscal Period',
    description: 'Stage period unlock: clears locked_at so entries can be posted again. Cannot unlock a closed period. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period to unlock' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')

      const { data: period, error: fetchError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !period) throw new Error('Fiscal period not found')
      if (period.is_closed) throw new Error('Cannot unlock a closed period')
      if (!period.locked_at) throw new Error('Period is not locked')

      return stagePendingOperation(supabase, companyId, userId, 'unlock_period',
        `Lås upp period: ${period.name} (${period.period_start} till ${period.period_end})`,
        { fiscal_period_id: fiscalPeriodId },
        {
          period_name: period.name,
          period_start: period.period_start,
          period_end: period.period_end,
          locked_at: period.locked_at,
          will: 'clear locked_at: new entries can be posted into the period again',
        },
        actor,
        {
          description: 'After approval, post the rättelse via gnubok_correct_entry or new entries via gnubok_create_voucher, then re-lock with gnubok_lock_period.',
          tool: 'gnubok_lock_period',
          args: { fiscal_period_id: fiscalPeriodId },
        }
      )
    },
  },

  {
    name: 'gnubok_credit_invoice',
    title: 'Credit Customer Invoice (Kreditfaktura)',
    description: 'Stage credit note (kreditfaktura) for a customer invoice: KR- prefixed mirror invoice + reverses original JE (accrual). Original must be sent/paid/overdue and not already credited.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the invoice to credit' },
        reason: { type: 'string', description: 'Optional reason note (Swedish, shown on the credit note)' },
      },
      required: ['invoice_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const id = args.invoice_id as string
      const reason = args.reason as string | undefined
      if (!id) throw new Error('invoice_id is required')

      const { data: inv } = await supabase
        .from('invoices')
        .select('id, invoice_number, document_type, status, total, currency, customer:customers(name)')
        .eq('id', id).eq('company_id', companyId).single()

      if (!inv) throw new Error('Invoice not found')
      if (inv.document_type && inv.document_type !== 'invoice') {
        throw new Error('Credit notes can only be created from standard invoices')
      }
      if (inv.status === 'credited') throw new Error('Fakturan har redan krediterats')
      if (!['sent', 'paid', 'overdue'].includes(inv.status)) {
        throw new Error('Endast skickade, betalda eller förfallna fakturor kan krediteras')
      }

      return stagePendingOperation(supabase, companyId, userId, 'credit_invoice',
        `Kreditera faktura ${inv.invoice_number}`,
        { invoice_id: id, reason },
        {
          invoice_number: inv.invoice_number,
          customer_name: (inv.customer as { name?: string } | null)?.name,
          total: inv.total,
          currency: inv.currency,
          reason: reason || null,
          method: 'creates KR- mirror invoice + reverses original JE (accrual)',
        },
        actor,
        {
          description: 'After approval the credit note posts and the kundfordring is cleared. If a refund is owed to the customer, book the outbound payment when it leaves the bank.',
          tool: 'gnubok_get_ar_ledger',
        }
      )
    },
  },

  {
    name: 'gnubok_update_invoice',
    title: 'Update Draft Invoice',
    description: 'Stage an edit to a DRAFT invoice: header fields (incl. default_dimensions) and/or items (items = FULL REPLACE). Drafts only: no verifikat, not self-billed, not a credit note. Sent/paid invoices need gnubok_credit_invoice. Find invoice_id with gnubok_list_invoices.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        invoice_id: { type: 'string', description: 'UUID of the draft invoice, from gnubok_list_invoices.' },
        notes: { type: 'string' },
        invoice_date: { type: 'string', description: 'YYYY-MM-DD' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        delivery_date: { type: ['string', 'null'], description: 'YYYY-MM-DD; null clears the delivery date.' },
        your_reference: { type: 'string' },
        our_reference: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string', description: 'st, tim, dag, mån' },
              unit_price: { type: 'number', description: 'Price per unit excl. VAT' },
              vat_rate: { type: 'number', description: 'VAT rate 0-100 (optional override)' },
              dimensions: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Dims bag {sie_dim_no: kod eller namn}, e.g. {"6":"P001"}. Wins per key over default_dimensions.',
              },
            },
            required: ['description', 'quantity', 'unit', 'unit_price'],
          },
          description: 'FULL REPLACE: when provided, every existing line is deleted and this array becomes the new line set. Omit to keep the current lines.',
        },
        default_dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dims bag keyed by SIE dim no, value = code OR name. Replaces the whole stored bag; {} clears all tags. Omit to keep the current bag.',
        },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging or changing data.' },
        idempotency_key: { type: 'string', description: 'Random per-operation UUID. Reusing it with the same payload returns the original staged response.' },
      },
      required: ['invoice_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    catalogVisibility: 'search',
    async execute(args, companyId, userId, supabase, actor) {
      const invoiceId = args.invoice_id as string
      if (!invoiceId) throw new Error('invoice_id is required. Use gnubok_list_invoices to find IDs.')

      const rawItems = args.items as
        | Array<{
            description: string
            quantity: number
            unit: string
            unit_price: number
            vat_rate?: number
            dimensions?: unknown
          }>
        | undefined

      if (rawItems !== undefined) {
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
          throw new Error('items must be a non-empty array: it fully REPLACES every existing line on the draft.')
        }
        for (const [i, item] of rawItems.entries()) {
          if (!item.description?.trim()) throw new Error(`Item ${i + 1}: description is required`)
          if (!item.quantity || item.quantity <= 0) throw new Error(`Item ${i + 1}: quantity must be positive`)
          if (!item.unit?.trim()) throw new Error(`Item ${i + 1}: unit is required (st, tim, dag)`)
          if (item.unit_price == null) throw new Error(`Item ${i + 1}: unit_price is required`)
        }
      }

      // Resolve-don't-select (same pass as gnubok_create_invoice): parse the
      // default bag + each item's bag, then resolve codes AND names against
      // the registry in one go (zero queries when nothing is tagged).
      const defaultDimensions = parseDimensionsArg(args.default_dimensions, 'default_dimensions')
      const { bags: resolvedDimBags, resolutions: dimensionResolutions } = await resolveDimensionBags(
        supabase,
        companyId,
        [
          defaultDimensions,
          ...(rawItems ?? []).map((item, i) => parseDimensionsArg(item.dimensions, `items[${i}].dimensions`)),
        ],
      )
      const resolvedDefaultDimensions = resolvedDimBags[0]
      const stagedItems = rawItems?.map((item, i) => {
        const { dimensions: _rawDimensions, ...rest } = item
        const bag = resolvedDimBags[i + 1]
        return bag && Object.keys(bag).length > 0 ? { ...rest, dimensions: bag } : rest
      })

      const changes: Record<string, unknown> = {}
      for (const key of ['notes', 'invoice_date', 'due_date', 'delivery_date', 'your_reference', 'our_reference']) {
        if (args[key] !== undefined) changes[key] = args[key]
      }
      if (stagedItems) changes.items = stagedItems
      // The bag replaces wholesale, never merges: {} clears every tag.
      if (args.default_dimensions !== undefined) changes.default_dimensions = resolvedDefaultDimensions ?? {}

      const parsed = UpdateInvoiceParamsSchema.safeParse({ invoice_id: invoiceId, changes })
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(`Invalid invoice update: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'validation failed'}`)
      }

      const { data: invoice, error } = await supabase
        .from('invoices')
        .select('id, invoice_number, status, document_type, journal_entry_id, is_self_billed, credited_invoice_id, total, currency, customer:customers(name)')
        .eq('id', parsed.data.invoice_id)
        .eq('company_id', companyId)
        .maybeSingle()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!invoice) throw new Error('Invoice not found. Use gnubok_list_invoices to find valid IDs.')

      // Editable drafts only: the shared predicate the web PATCH route gates
      // on. The commit executor re-checks it at approval time (staging is not
      // a lock: the invoice can be sent between staging and approval).
      if (!isEditableInvoiceDraft(invoice)) {
        throw new Error(
          `Invoice ${invoice.invoice_number ?? invoice.id} is not an editable draft ` +
          `(status: ${invoice.status}${invoice.journal_entry_id ? ', has a posted verifikat' : ''}` +
          `${invoice.is_self_billed ? ', self-billed' : ''}${invoice.credited_invoice_id ? ', credit note' : ''}). ` +
          `Sent, paid, or booked invoices are immutable: use gnubok_credit_invoice instead.`
        )
      }

      const customerName = (invoice.customer as { name?: string } | null)?.name

      return stagePendingOperation(supabase, companyId, userId, 'update_invoice',
        `Uppdatera fakturautkast: ${customerName ?? invoice.invoice_number ?? invoice.id}`,
        parsed.data,
        {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number ?? null,
          customer_name: customerName ?? null,
          status: invoice.status,
          changes: parsed.data.changes,
          ...(parsed.data.changes.items
            ? { items_replace: true, item_count: parsed.data.changes.items.length }
            : {}),
          ...(dimensionResolutions.length > 0 ? { dimension_resolutions: dimensionResolutions } : {}),
        },
        actor,
        {
          description: 'Once approved, the draft is rewritten in place (totals and VAT recomputed; items fully replaced when provided). Send it with gnubok_send_invoice when ready.',
          tool: 'gnubok_send_invoice',
        },
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        },
      )
    },
  },

  {
    name: 'gnubok_import_sie',
    title: 'Import SIE File',
    description: 'Stage SIE-file import (types 1-4, CP437/UTF-8/Latin-1). On commit creates fiscal period, opening balances, and journal entries. High-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_content: { type: 'string', description: 'Full SIE file contents' },
        filename: { type: 'string', description: 'Original filename' },
        mappings: {
          type: 'array',
          description: 'Account mappings: { sourceAccount, sourceName, targetAccount, targetName, confidence, matchType, isOverride }',
          items: { type: 'object' },
        },
        create_fiscal_period: { type: 'boolean' },
        import_opening_balances: { type: 'boolean' },
        import_transactions: { type: 'boolean' },
        voucher_series: { type: 'string', description: 'Override voucher series for imported vouchers' },
        update_account_names: { type: 'boolean', description: 'Use #KONTO names from the file for created and existing accounts (default true). Set false to keep BAS default names.' },
      },
      required: ['file_content', 'filename', 'mappings'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fileContent = args.file_content as string
      const filename = args.filename as string
      const mappings = args.mappings as unknown[] | undefined

      if (!fileContent || !filename || !Array.isArray(mappings)) {
        throw new Error('file_content, filename, and mappings are required')
      }

      // Parse + validate at stage time so the approver sees real content (which
      // entries, what balances) and a broken/unbalanced file is rejected HERE,
      // not after they approve a blind byte count. commitImportSie re-parses on
      // commit (defense-in-depth: the staged string could be tampered).
      const { parseSIEFile, validateSIEFile, getEffectiveOpeningBalances } = await import('@/lib/import/sie-parser')
      let parsed
      try {
        parsed = parseSIEFile(fileContent)
      } catch (e) {
        throw new Error(`SIE-filen kunde inte tolkas: ${e instanceof Error ? e.message : 'okänt fel'}`)
      }
      const validation = validateSIEFile(parsed)
      if (!validation.valid) {
        throw new Error(`SIE-filen är ogiltig och importeras inte: ${validation.errors.join('; ')}`)
      }

      // Effective set: explicit #IB 0, or IB derived from #UB -1 when the
      // source system exports none (issue #675): so the approver sees the
      // real IB total and UB-1-only files pass the coverage check below.
      const ibCurrent = getEffectiveOpeningBalances(parsed).balances
      const ibTotal = Math.round(ibCurrent.reduce((s, b) => s + b.amount, 0) * 100) / 100

      // Mapping-coverage check. The executor's per-voucher loop silently
      // skips any line whose account is not in `mappings`, so an empty or
      // non-overlapping mapping set produces a committed import with
      // journal_entries_created=0 that then claims the (company_id,
      // file_hash) slot in the partial unique index and blocks retry.
      // Refuse to stage when the mapping wouldn't cover a single account
      // present in the file.
      const importOB = Boolean(args.import_opening_balances)
      const sourceAccountsInFile = new Set<string>()
      for (const v of parsed.vouchers) for (const l of v.lines) sourceAccountsInFile.add(l.account)
      if (importOB) for (const b of ibCurrent) sourceAccountsInFile.add(b.account)
      const mappedSources = new Set(
        (mappings as Array<{ sourceAccount?: unknown; targetAccount?: unknown }>)
          .filter((m) => typeof m?.targetAccount === 'string' && m.targetAccount.length > 0 && typeof m?.sourceAccount === 'string')
          .map((m) => m.sourceAccount as string),
      )
      const coveredAccounts = [...sourceAccountsInFile].filter((a) => mappedSources.has(a))
      const accountsMapped = { covered: coveredAccounts.length, total: sourceAccountsInFile.size }
      const wouldSkipAllVouchers = sourceAccountsInFile.size > 0 && coveredAccounts.length === 0

      if (wouldSkipAllVouchers) {
        const sample = [...sourceAccountsInFile].slice(0, 8).join(', ')
        throw new Error(
          `Kontomappningarna täcker inga konton i SIE-filen: alla ` +
            `${parsed.stats.totalVouchers} verifikationer skulle hoppas över ` +
            `och importen skulle skapa 0 verifikat. Filen innehåller ` +
            `${sourceAccountsInFile.size} unika källkonton (t.ex. ${sample}). ` +
            `Bifoga "mappings" där sourceAccount matchar #KONTO-numren i filen ` +
            `och targetAccount är ett giltigt BAS-konto.`,
        )
      }

      return stagePendingOperation(supabase, companyId, userId, 'import_sie',
        `SIE-import: ${filename}`,
        {
          file_content: fileContent,
          filename,
          mappings,
          create_fiscal_period: Boolean(args.create_fiscal_period),
          import_opening_balances: Boolean(args.import_opening_balances),
          import_transactions: Boolean(args.import_transactions),
          voucher_series: args.voucher_series,
          // Default true: Boolean(undefined) would silently flip it off.
          update_account_names:
            args.update_account_names === undefined ? true : Boolean(args.update_account_names),
        },
        {
          filename,
          file_size_bytes: fileContent.length,
          mappings_count: mappings.length,
          accounts_mapped: accountsMapped,
          would_skip_all_vouchers: wouldSkipAllVouchers,
          company_name: parsed.header.companyName,
          org_number: parsed.header.orgNumber,
          fiscal_year: { start: parsed.stats.fiscalYearStart, end: parsed.stats.fiscalYearEnd },
          account_count: parsed.stats.totalAccounts,
          voucher_count: parsed.stats.totalVouchers,
          transaction_line_count: parsed.stats.totalTransactionLines,
          opening_balance: { total: ibTotal, is_balanced: ibTotal === 0 },
          warnings: validation.warnings,
          create_fiscal_period: Boolean(args.create_fiscal_period),
          import_opening_balances: Boolean(args.import_opening_balances),
          import_transactions: Boolean(args.import_transactions),
          will: 'create fiscal period + opening balances + journal entries from the parsed SIE',
        },
        actor,
        {
          description: 'After commit, verify the imported balances with gnubok_get_trial_balance and check continuity via the IB/UB of adjacent periods.',
          tool: 'gnubok_get_trial_balance',
        }
      )
    },
  },

  {
    name: 'gnubok_undo_sie_import',
    title: 'Undo SIE Import',
    description: 'Stage undo of a completed SIE import: hard-deletes its entries, detaches docs, resets voucher_sequences, marks the import \'undone\' for re-import. Use after a botched import. Period must be open. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        import_id: { type: 'string', description: 'UUID of the sie_imports row to undo. Must be status=\'completed\'.' },
        reason: { type: 'string', maxLength: 500, description: 'Optional human-readable reason: shown in pending_operations review.' },
      },
      required: ['import_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const importId = args.import_id as string
      const reason = typeof args.reason === 'string' ? args.reason : undefined

      if (!importId) throw new Error('import_id is required')
      if (reason !== undefined && reason.length > 500) {
        throw new Error('reason must be 500 characters or fewer')
      }

      // Pre-flight mirrors undoSIEImport: confirm row exists, belongs to
      // this company, is in 'completed' status, and (if linked) the fiscal
      // period is open + unlocked. Surfacing rejection at stage-time keeps
      // the agent honest about what the approver is being asked to confirm.
      type ImportRow = {
        id: string
        filename: string
        fiscal_year_start: string | null
        fiscal_year_end: string | null
        transactions_count: number | null
        opening_balance_entry_id: string | null
        status: string
        fiscal_period_id: string | null
        imported_at: string | null
      }
      const { data, error: lookupErr } = await supabase
        .from('sie_imports')
        .select('id, filename, fiscal_year_start, fiscal_year_end, transactions_count, opening_balance_entry_id, status, fiscal_period_id, imported_at')
        .eq('id', importId)
        .eq('company_id', companyId)
        .maybeSingle()
      const importRow = data as ImportRow | null

      if (lookupErr) {
        throw new Error(`Kunde inte slå upp SIE-import ${importId}: ${lookupErr.message}`)
      }
      if (!importRow) {
        throw new Error(`SIE-import hittades inte: ${importId}`)
      }
      if (importRow.status !== 'completed') {
        throw new Error(`Bara slutförda importer kan ångras (nuvarande status: ${importRow.status}).`)
      }

      let fiscalPeriodName: string | null = null
      if (importRow.fiscal_period_id) {
        const { data: period } = await supabase
          .from('fiscal_periods')
          .select('name, is_closed, locked_at')
          .eq('id', importRow.fiscal_period_id)
          .eq('company_id', companyId)
          .maybeSingle()
        if (period?.is_closed || period?.locked_at) {
          throw new Error(
            `Räkenskapsåret "${period.name ?? 'okänt'}" är låst eller stängt. ` +
            `Öppna perioden innan du ångrar importen.`,
          )
        }
        fiscalPeriodName = (period as { name?: string } | null)?.name ?? null
      }

      return stagePendingOperation(supabase, companyId, userId, 'undo_sie_import',
        `Ångra SIE-import: ${importRow.filename}`,
        { import_id: importId },
        {
          import: {
            id: importRow.id,
            filename: importRow.filename,
            fiscal_year: { start: importRow.fiscal_year_start, end: importRow.fiscal_year_end },
            fiscal_period_name: fiscalPeriodName,
            transactions_count: importRow.transactions_count ?? 0,
            has_opening_balance_entry: Boolean(importRow.opening_balance_entry_id),
            imported_at: importRow.imported_at,
          },
          reason: reason ?? null,
          will: 'hard-delete the import\'s journal entries (transactions + opening balance), detach user-attached documents, reset voucher_sequences, and mark the sie_imports row as \'undone\' so the file can be re-imported',
        },
        actor,
        {
          description: 'After commit, re-stage the SIE import with corrected mappings via gnubok_import_sie.',
          tool: 'gnubok_import_sie',
        },
      )
    },
  },

  // ── Phase 4: arbitrary-line bookkeeping primitives ───────────────

  {
    name: 'gnubok_create_voucher',
    title: 'Create Manual Voucher (Verifikation)',
    description: 'Stage a manual verifikation with arbitrary balanced lines: capitalization (1010), accruals, FX adjustments, rättelser outside categorize_transaction. Lines accept dimensions bags {sie_dim_no: code or name}. Pass inbox_item_id to book a kvitto direct. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entry_date: { type: 'string', description: 'Voucher date (YYYY-MM-DD)' },
        description: { type: 'string', description: 'Verifikationstext (required, min 1 char)' },
        fiscal_period_id: { type: 'string', description: 'UUID of fiscal period. If omitted, resolved from entry_date.' },
        voucher_series: { type: 'string', description: 'Single letter A-Z. Defaults to A.' },
        notes: { type: 'string', description: 'Internal notes (max 2000 chars): visible on the verifikation but not on reports.' },
        default_dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dimension tags {sie_dim_no: kod eller namn}, e.g. {"6":"P001"}, applied to every line not setting the key itself. Unknown values are rejected: never auto-created.',
        },
        is_opening_balance: { type: 'boolean', description: 'Set true ONLY for a migrated ingående balans (IB). Marks the entry source_type=opening_balance so bank reconciliation excludes it from period movement. Requires every line to be a balance-sheet account (class 1/2) and entry_date = fiscal period start, else rejected. Defaults false.' },
        inbox_item_id: { type: 'string', description: 'Optional inbox item UUID to book directly. On confirm, the inbox item is linked to the new verifikat and its document is attached to the journal entry. Fails if the inbox item is already booked (as voucher) or converted (to supplier invoice).' },
        lines: {
          type: 'array',
          description: 'At least 2 balanced lines. sum(debit_amount) === sum(credit_amount), both > 0.',
          items: {
            type: 'object',
            properties: {
              account_number: { type: 'string', description: '4-digit BAS account number, e.g. "1010"' },
              debit_amount: { type: 'number', description: 'Debit amount in SEK (≥ 0)' },
              credit_amount: { type: 'number', description: 'Credit amount in SEK (≥ 0)' },
              line_description: { type: 'string' },
              currency: { type: 'string', description: 'ISO 4217, defaults to SEK' },
              amount_in_currency: { type: 'number', description: 'Original amount if currency is not SEK' },
              exchange_rate: { type: 'number' },
              tax_code: { type: 'string', description: 'Free-text tag: does NOT drive momsdeklaration ruta mapping. The BAS account number is what determines which ruta the line lands in (e.g. 2641 → ruta 48, 2614 → ruta 30). Pick the correct account first.' },
              dimensions: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Dimension tags {sie_dim_no: kod eller namn}, e.g. {"1":"KS01","6":"P001"}. Names resolve against the registry (high-confidence only, echoed). Wins per key over default_dimensions and cost_center/project.',
              },
              cost_center: { type: 'string', description: 'DEPRECATED alias for dimensions["1"].' },
              project: { type: 'string', description: 'DEPRECATED alias for dimensions["6"].' },
            },
            required: ['account_number'],
          },
        },
      },
      required: ['entry_date', 'description', 'lines'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const entryDate = args.entry_date as string
      // Normalize like line_description: coerce
      // to string and trim, so a non-string or whitespace-only description is
      // caught by the guard below instead of slipping into the preview/voucher.
      const description = String(args.description ?? '').trim()
      const rawLines = args.lines as Array<Record<string, unknown>> | undefined

      if (!entryDate || !description || !Array.isArray(rawLines) || rawLines.length < 2) {
        throw new Error('entry_date, description, and at least two lines are required')
      }

      // Normalize so validateBalance + preview see consistent numeric types.
      const lines = rawLines.map((l, i) => ({
        account_number: String(l.account_number ?? ''),
        debit_amount: Number(l.debit_amount) || 0,
        credit_amount: Number(l.credit_amount) || 0,
        line_description: l.line_description ? String(l.line_description) : undefined,
        currency: l.currency ? String(l.currency) : undefined,
        amount_in_currency: l.amount_in_currency !== undefined ? Number(l.amount_in_currency) : undefined,
        exchange_rate: l.exchange_rate !== undefined ? Number(l.exchange_rate) : undefined,
        tax_code: l.tax_code ? String(l.tax_code) : undefined,
        dimensions: parseDimensionsArg(l.dimensions, `lines[${i}].dimensions`),
        cost_center: l.cost_center ? String(l.cost_center) : undefined,
        project: l.project ? String(l.project) : undefined,
      }))

      // Pre-flight: catch unbalanced lines before staging so the agent gets a
      // tight feedback loop instead of a rejected pending_operation later.
      const balance = validateBalance(lines)
      if (!balance.valid) {
        throw new Error(
          `Lines are not balanced: debits ${balance.totalDebit} SEK, credits ${balance.totalCredit} SEK. ` +
          'Both must be positive and equal.'
        )
      }

      // Resolve-don't-select: merge voucher-level default_dimensions under each
      // line's own bag/aliases, then resolve codes AND natural-language names
      // against the registry in ONE pass (zero queries when nothing is tagged;
      // free-text passthrough while dimensions_enabled is off). Non-exact
      // resolutions are echoed in the preview so the approver and the agent
      // both see what "Villa Almgren tak" actually attached to.
      const defaultDimensions = parseDimensionsArg(args.default_dimensions, 'default_dimensions')
      const { bags: resolvedBags, resolutions: dimensionResolutions } = await resolveDimensionBags(
        supabase,
        companyId,
        lines.map((l) => mergeLineDimensions(l, defaultDimensions)),
      )
      for (const [i, line] of lines.entries()) {
        line.dimensions = resolvedBags[i]
      }

      // Resolve fiscal period. Two paths:
      //   1. Caller supplied fiscal_period_id → verify it exists and is open.
      //   2. Omitted → look up the open period covering entry_date.
      // Both paths converge on a Swedish-language error if no valid open
      // period is available. (NOTE: the executor re-checks period_lock at
      // commit time: this staging gate is advisory and exists for UX, the
      // commit-time guard is the authoritative one. Don't remove it as
      // "redundant".)
      let fiscalPeriodId = (args.fiscal_period_id as string | undefined) ?? null
      if (fiscalPeriodId) {
        const { data: period, error: periodErr } = await supabase
          .from('fiscal_periods')
          .select('id, is_closed, period_start, period_end, name')
          .eq('id', fiscalPeriodId)
          .eq('company_id', companyId)
          .maybeSingle()
        if (periodErr || !period) {
          throw new Error(`Fiscal period ${fiscalPeriodId} not found for this company.`)
        }
        if (period.is_closed) {
          throw new Error(
            `Räkenskapsperioden "${period.name ?? fiscalPeriodId}" är låst. ` +
            'Lås upp perioden, eller välj en öppen period.'
          )
        }
        // Defense in depth: also verify the supplied period actually covers
        // entry_date so the engine's EntryDateOutsideFiscalPeriodError surfaces
        // as a Swedish message rather than a generic engine error.
        if (entryDate < period.period_start || entryDate > period.period_end) {
          throw new Error(
            `Datumet ${entryDate} ligger utanför "${period.name ?? 'perioden'}" (${period.period_start}-${period.period_end}).`
          )
        }
      } else {
        fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
      }
      if (!fiscalPeriodId) {
        throw new Error(`No open fiscal period covers ${entryDate}. Open a period or pick a different date.`)
      }

      // Resolve account names for the preview so the approver reads
      // "1010 Balanserade utgifter / 2440 Leverantörsskulder" rather than
      // bare numbers. Also gate: refuse to stage when any line references an
      // unknown or inactive account so the approver isn't shown a voucher
      // that would fail at commit time anyway.
      const accountNumbers = [...new Set(lines.map((l) => l.account_number))]
      const { data: accounts } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name, is_active')
        .eq('company_id', companyId)
        .in('account_number', accountNumbers)
      const accountInfo = new Map<string, { name: string; active: boolean }>()
      for (const a of accounts || []) {
        accountInfo.set(a.account_number as string, {
          name: (a.account_name as string) ?? '',
          active: Boolean(a.is_active),
        })
      }
      const unknownAccounts = accountNumbers.filter((n) => !accountInfo.has(n))
      const inactiveAccounts = accountNumbers.filter(
        (n) => accountInfo.has(n) && !accountInfo.get(n)!.active,
      )
      if (unknownAccounts.length > 0 || inactiveAccounts.length > 0) {
        const parts: string[] = []
        if (unknownAccounts.length > 0) {
          parts.push(`saknas i kontoplanen: ${unknownAccounts.join(', ')}`)
        }
        if (inactiveAccounts.length > 0) {
          parts.push(`inaktiva: ${inactiveAccounts.join(', ')}`)
        }
        throw new Error(
          `Kan inte skapa verifikation. Konton ${parts.join('; ')}. ` +
          'Aktivera dem i kontoplanen eller välj andra konton.'
        )
      }

      const previewLines = lines.map((l) => ({
        account_number: l.account_number,
        account_name: accountInfo.get(l.account_number)?.name ?? null,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: l.line_description ?? null,
        dimensions: l.dimensions ?? null,
      }))

      // Optional inbox-direct booking. Validate at staging so the agent gets a
      // tight rejection signal: once staged, an already-booked inbox item
      // would only surface at commit time with a generic 409. The executor
      // re-checks idempotently via UNIQUE constraint on
      // invoice_inbox_items.created_journal_entry_id.
      const inboxItemId = (args.inbox_item_id as string | undefined) ?? null
      let inboxDocumentId: string | null = null
      if (inboxItemId) {
        const { data: inbox, error: inboxErr } = await supabase
          .from('invoice_inbox_items')
          .select('id, document_id, created_journal_entry_id, created_supplier_invoice_id')
          .eq('id', inboxItemId)
          .eq('company_id', companyId)
          .single()
        if (inboxErr || !inbox) {
          throw new Error(`Inbox item ${inboxItemId} not found for this company.`)
        }
        if (inbox.created_journal_entry_id) {
          throw new Error(
            `Inbox item is already booked as journal entry ${inbox.created_journal_entry_id}. ` +
            'Use gnubok_correct_entry or gnubok_reverse_entry if it needs to be changed.'
          )
        }
        if (inbox.created_supplier_invoice_id) {
          throw new Error(
            `Inbox item is already converted to supplier invoice ${inbox.created_supplier_invoice_id}. ` +
            'Cancel that path before booking it as a verifikat.'
          )
        }
        inboxDocumentId = (inbox.document_id as string | null) ?? null
      }

      // NOTE: source_type is intentionally NOT included in the staged params.
      // The executor derives it: 'opening_balance' when the typed
      // is_opening_balance flag is set AND the executor re-validates the entry
      // genuinely looks like an IB (all class-1/2 lines, dated on the period
      // start); otherwise 'manual'. We never accept a raw source_type string:
      // a tampered or future direct-staged pending_operations row can't
      // misrepresent the entry's origin, only assert "this is an IB" via a
      // boolean the executor independently verifies.
      const isOpeningBalance = args.is_opening_balance === true
      return stagePendingOperation(supabase, companyId, userId, 'create_voucher',
        `${isOpeningBalance ? 'Ingående balans' : 'Manuell verifikation'}: ${description}`,
        {
          entry_date: entryDate,
          description,
          fiscal_period_id: fiscalPeriodId,
          voucher_series: (args.voucher_series as string) || undefined,
          notes: (args.notes as string) || undefined,
          is_opening_balance: isOpeningBalance,
          inbox_item_id: inboxItemId,
          document_id: inboxDocumentId,
          lines,
        },
        {
          entry_date: entryDate,
          description,
          fiscal_period_id: fiscalPeriodId,
          voucher_series: (args.voucher_series as string) || 'A',
          total_debit: balance.totalDebit,
          total_credit: balance.totalCredit,
          line_count: lines.length,
          lines: previewLines,
          // Echoed for every non-exact dimension resolution (resolve-don't-
          // select) so the agent can verify what a name attached to.
          ...(dimensionResolutions.length > 0 ? { dimension_resolutions: dimensionResolutions } : {}),
          inbox_item_id: inboxItemId,
          document_attached: Boolean(inboxDocumentId),
          will: inboxItemId
            ? 'create a posted journal entry with a fresh sequential voucher number, link the inbox item to it, and attach the document to the verifikat'
            : 'create a posted journal entry with a fresh sequential voucher number',
        },
        actor,
        {
          description: 'After commit, confirm the new verifikation lands on the right accounts with gnubok_get_general_ledger or gnubok_query_journal.',
          tool: 'gnubok_query_journal',
        },
        { dateForPeriodCheck: entryDate },
      )
    },
  },

  {
    name: 'gnubok_correct_entry',
    title: 'Correct Posted Entry (Rättelse)',
    description: 'Stage a rättelse for a posted verifikation per BFL 5 kap 5§: storno + corrected entry in the original period (never in-place edit). Use for partial fixes like 2641 → 2614/2645; lines accept dimensions bags. Account drives ruta. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entry_id: { type: 'string', description: 'Journal entry UUID OR voucher ref like "A-113". Prefer voucher refs: UUIDs reused from earlier tool output are frequently hallucinated by LLM callers.' },
        default_dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dimension tags {sie_dim_no: kod eller namn}, e.g. {"6":"P001"}, applied to every replacement line not setting the key itself. Unknown values are rejected: never auto-created.',
        },
        lines: {
          type: 'array',
          description: 'Replacement lines (≥ 2, balanced). Use the same accounts as the original where unchanged.',
          items: {
            type: 'object',
            properties: {
              account_number: { type: 'string' },
              debit_amount: { type: 'number' },
              credit_amount: { type: 'number' },
              line_description: { type: 'string' },
              currency: { type: 'string' },
              amount_in_currency: { type: 'number' },
              exchange_rate: { type: 'number' },
              tax_code: { type: 'string', description: 'Free-text tag: does NOT drive momsdeklaration ruta. Pick the correct BAS account first.' },
              dimensions: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Dimension tags {sie_dim_no: kod eller namn}. Names resolve against the registry (high-confidence only, echoed). Wins per key over default_dimensions and cost_center/project.',
              },
              cost_center: { type: 'string', description: 'DEPRECATED alias for dimensions["1"].' },
              project: { type: 'string', description: 'DEPRECATED alias for dimensions["6"].' },
            },
            required: ['account_number'],
          },
        },
      },
      required: ['entry_id', 'lines'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const entryRef = args.entry_id as string
      const rawLines = args.lines as Array<Record<string, unknown>> | undefined

      if (!entryRef || !Array.isArray(rawLines) || rawLines.length < 2) {
        throw new Error('entry_id and at least two lines are required')
      }

      const lines = rawLines.map((l, i) => ({
        account_number: String(l.account_number ?? ''),
        debit_amount: Number(l.debit_amount) || 0,
        credit_amount: Number(l.credit_amount) || 0,
        line_description: l.line_description ? String(l.line_description) : undefined,
        currency: l.currency ? String(l.currency) : undefined,
        amount_in_currency: l.amount_in_currency !== undefined ? Number(l.amount_in_currency) : undefined,
        exchange_rate: l.exchange_rate !== undefined ? Number(l.exchange_rate) : undefined,
        tax_code: l.tax_code ? String(l.tax_code) : undefined,
        dimensions: parseDimensionsArg(l.dimensions, `lines[${i}].dimensions`),
        cost_center: l.cost_center ? String(l.cost_center) : undefined,
        project: l.project ? String(l.project) : undefined,
      }))

      const balance = validateBalance(lines)
      if (!balance.valid) {
        throw new Error(
          `Correction lines not balanced: debits ${balance.totalDebit}, credits ${balance.totalCredit}. ` +
          'Both must be positive and equal.'
        )
      }

      // Resolve-don't-select: same one-pass registry resolution as
      // gnubok_create_voucher (codes AND names; unknown/archived/ambiguous
      // values reject with candidates; nothing is ever auto-created).
      const defaultDimensions = parseDimensionsArg(args.default_dimensions, 'default_dimensions')
      const { bags: resolvedBags, resolutions: dimensionResolutions } = await resolveDimensionBags(
        supabase,
        companyId,
        lines.map((l) => mergeLineDimensions(l, defaultDimensions)),
      )
      for (const [i, line] of lines.entries()) {
        line.dimensions = resolvedBags[i]
      }

      const entryId = await resolveJournalEntryRef(supabase, companyId, entryRef)

      // Pre-flight: the executor checks again, but failing fast here gives the
      // agent a clearer error message than waiting until commit-time.
      // The Supabase types don't infer through `fiscal_periods!inner(...)`,
      // so we type the row shape manually rather than fight the generics.
      type OriginalRow = {
        id: string
        status: string
        entry_date: string
        description: string
        voucher_number: number
        voucher_series: string
        fiscal_period_id: string
        fiscal_periods: { name?: string; is_closed?: boolean; locked_at?: string | null } | { name?: string; is_closed?: boolean; locked_at?: string | null }[] | null
        lines: Array<{
          account_number: string
          debit_amount: number | string
          credit_amount: number | string
          line_description: string | null
          currency: string | null
          amount_in_currency: number | string | null
          exchange_rate: number | string | null
          tax_code: string | null
          dimensions: Record<string, string> | null
          cost_center: string | null
          project: string | null
        }> | null
      }
      const { data, error: origErr } = await supabase
        .from('journal_entries')
        .select(
          'id, status, entry_date, description, voucher_number, voucher_series, fiscal_period_id, ' +
          'fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(name, is_closed, locked_at), ' +
          'lines:journal_entry_lines(account_number, debit_amount, credit_amount, line_description, currency, amount_in_currency, exchange_rate, tax_code, dimensions, cost_center, project)'
        )
        .eq('id', entryId)
        .eq('company_id', companyId)
        .maybeSingle()
      const original = data as OriginalRow | null

      if (origErr) {
        throw new Error(`Database error looking up journal entry ${entryId}: ${origErr.message}`)
      }
      if (!original) {
        throw new Error(
          `Journal entry not found: id=${entryId}. ` +
          `If this UUID came from an earlier tool result, re-fetch via gnubok_query_journal: ` +
          `UUIDs are frequently hallucinated when reused across turns. You can also pass a voucher ref like "A-113".`
        )
      }
      if (original.status !== 'posted') {
        throw new Error(`Only posted entries can be corrected. Current status: ${original.status}.`)
      }
      const periodInfo = Array.isArray(original.fiscal_periods)
        ? original.fiscal_periods[0]
        : original.fiscal_periods
      if (periodInfo?.is_closed || periodInfo?.locked_at) {
        throw new Error(
          `Fiscal period "${periodInfo.name ?? 'okänd'}" is locked or closed. Unlock the period, or use omprövning for already-filed VAT.`
        )
      }

      const originalLines = original.lines || []

      return stagePendingOperation(supabase, companyId, userId, 'correct_entry',
        `Rättelse: V${original.voucher_series}${original.voucher_number} - ${original.description}`,
        {
          entry_id: entryId,
          lines,
        },
        {
          original: {
            entry_id: entryId,
            voucher: `${original.voucher_series}${original.voucher_number}`,
            entry_date: original.entry_date,
            description: original.description,
            lines: originalLines.map((l) => ({
              account_number: l.account_number,
              debit_amount: Number(l.debit_amount),
              credit_amount: Number(l.credit_amount),
              line_description: l.line_description,
              currency: l.currency,
              amount_in_currency:
                l.amount_in_currency != null ? Number(l.amount_in_currency) : null,
              exchange_rate: l.exchange_rate != null ? Number(l.exchange_rate) : null,
              tax_code: l.tax_code,
              dimensions: l.dimensions,
              cost_center: l.cost_center,
              project: l.project,
            })),
          },
          correction: {
            total_debit: balance.totalDebit,
            total_credit: balance.totalCredit,
            line_count: lines.length,
            lines: lines.map((l) => ({
              account_number: l.account_number,
              debit_amount: l.debit_amount,
              credit_amount: l.credit_amount,
              line_description: l.line_description ?? null,
              currency: l.currency ?? null,
              amount_in_currency: l.amount_in_currency ?? null,
              exchange_rate: l.exchange_rate ?? null,
              tax_code: l.tax_code ?? null,
              dimensions: l.dimensions ?? null,
              cost_center: l.cost_center ?? null,
              project: l.project ?? null,
            })),
          },
          ...(dimensionResolutions.length > 0 ? { dimension_resolutions: dimensionResolutions } : {}),
          will: 'post a storno that mirrors the original, then post a new corrected entry, then mark the original as reversed (BFL 5 kap 5§)',
        },
        actor,
        {
          description: 'After commit, the original is marked reversed and a corrected verifikation lands in its place. Confirm both with gnubok_query_journal.',
          tool: 'gnubok_query_journal',
        },
        { dateForPeriodCheck: original.entry_date },
      )
    },
  },

  {
    name: 'gnubok_reverse_journal_entry',
    title: 'Reverse Journal Entry (Storno)',
    description: 'Stage a storno: inverts debits/credits, original stays visible (BFL 5 kap). Only when it should never have been booked (duplicate, ghost, test). Booked wrong → gnubok_correct_entry; refund → gnubok_credit_invoice. HIGH risk.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entry_id: { type: 'string', description: 'Journal entry UUID OR voucher ref like "A-113". Prefer voucher refs: UUIDs reused from earlier tool output are frequently hallucinated by LLM callers.' },
        reversal_date: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$', description: 'Optional ISO yyyy-MM-dd date for the storno verifikation. Defaults to today (Swedish timezone). Period attribution always follows the original entry, regardless of this date.' },
        reason: { type: 'string', maxLength: 500, description: 'Optional human-readable reason: shown in pending_operations review. Not stored on the storno itself. Max 500 chars.' },
      },
      required: ['entry_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const entryRef = args.entry_id as string
      const reversalDate = typeof args.reversal_date === 'string' ? args.reversal_date : undefined
      const reason = typeof args.reason === 'string' ? args.reason : undefined

      if (!entryRef) {
        throw new Error('entry_id is required')
      }
      // Belt-and-braces runtime check: inputSchema declares the pattern, but the
      // MCP dispatcher does not always enforce it: validate again here so a
      // malformed date never reaches the pending_operations payload.
      if (reversalDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(reversalDate)) {
        throw new Error('reversal_date must be ISO yyyy-MM-dd')
      }
      if (reason !== undefined && reason.length > 500) {
        throw new Error('reason must be 500 characters or fewer')
      }

      const entryId = await resolveJournalEntryRef(supabase, companyId, entryRef)

      // Pre-flight mirrors commitReverseEntry: posted + period not closed/locked.
      // Failing fast gives a clearer Swedish error than waiting until commit-time.
      // Both is_closed and locked_at are checked so the staging-time signal
      // matches the commit-time gate; without locked_at, an agent could see
      // staged:true with period_status:locked and only discover the rejection
      // at commit time.
      type OriginalRow = {
        id: string
        status: string
        entry_date: string
        description: string
        voucher_number: number
        voucher_series: string
        fiscal_period_id: string
        fiscal_periods: { name?: string; is_closed?: boolean; locked_at?: string | null } | { name?: string; is_closed?: boolean; locked_at?: string | null }[] | null
        lines: Array<{
          account_number: string
          debit_amount: number | string
          credit_amount: number | string
          line_description: string | null
        }> | null
      }
      const { data, error: origErr } = await supabase
        .from('journal_entries')
        .select(
          'id, status, entry_date, description, voucher_number, voucher_series, fiscal_period_id, ' +
          'fiscal_periods!journal_entries_fiscal_period_id_fkey!inner(name, is_closed, locked_at), lines:journal_entry_lines(account_number, debit_amount, credit_amount, line_description)'
        )
        .eq('id', entryId)
        .eq('company_id', companyId)
        .maybeSingle()
      const original = data as OriginalRow | null

      if (origErr) {
        throw new Error(`Database error looking up journal entry ${entryId}: ${origErr.message}`)
      }
      if (!original) {
        throw new Error(
          `Journal entry not found: id=${entryId}. ` +
          `If this UUID came from an earlier tool result, re-fetch via gnubok_query_journal: ` +
          `UUIDs are frequently hallucinated when reused across turns. You can also pass a voucher ref like "A-113".`
        )
      }
      if (original.status !== 'posted') {
        throw new Error(`Only posted entries can be reversed. Current status: ${original.status}.`)
      }
      const periodInfo = Array.isArray(original.fiscal_periods)
        ? original.fiscal_periods[0]
        : original.fiscal_periods
      if (periodInfo?.is_closed || periodInfo?.locked_at) {
        throw new Error(
          `Fiscal period "${periodInfo.name ?? 'okänd'}" is locked or closed. Unlock the period, or use omprövning for already-filed VAT.`
        )
      }

      const originalLines = original.lines || []
      const reversedPreviewLines = originalLines.map((l) => ({
        account_number: l.account_number,
        debit_amount: Number(l.credit_amount),
        credit_amount: Number(l.debit_amount),
        line_description: `Reversal: ${l.line_description ?? ''}`,
      }))

      // If the original touches output/input VAT accounts (2610-2670), a storno
      // is correct ONLY if the moms period covering entry_date has not yet been
      // filed with Skatteverket. For filed periods the legal path is an
      // omprövning (rättelse-omprövning per ML 2023:200, SFL 22 kap). Accounted
      // doesn't track per-VAT-period filing status today, so we surface a
      // soft warning rather than block: the human approver decides.
      const vatAccounts = originalLines
        .map((l) => l.account_number)
        .filter((acc) => /^26[1-7]\d$/.test(acc))
      const vatWarning = vatAccounts.length > 0
        ? `Original innehåller momskonton (${[...new Set(vatAccounts)].join(', ')}). Om momsperioden är inlämnad till Skatteverket krävs omprövning (ML 2023:200): storno räcker inte. Bekräfta att perioden inte är inlämnad innan godkännande.`
        : null

      return stagePendingOperation(supabase, companyId, userId, 'reverse_entry',
        `Makulering: V${original.voucher_series}${original.voucher_number} - ${original.description}`,
        {
          entry_id: entryId,
          reversal_date: reversalDate,
        },
        {
          original: {
            entry_id: entryId,
            voucher: `${original.voucher_series}${original.voucher_number}`,
            entry_date: original.entry_date,
            description: original.description,
            lines: originalLines.map((l) => ({
              account_number: l.account_number,
              debit_amount: Number(l.debit_amount),
              credit_amount: Number(l.credit_amount),
              line_description: l.line_description,
            })),
          },
          reversal: {
            entry_date: reversalDate ?? null,
            fiscal_period_id: original.fiscal_period_id,
            line_count: reversedPreviewLines.length,
            lines: reversedPreviewLines,
          },
          reason: reason ?? null,
          ...(vatWarning ? { warnings: [vatWarning] } : {}),
          will: 'post a storno that mirrors the original with debits and credits swapped, link via reverses_id, and leave the original visible (BFL 5 kap, makulering)',
        },
        actor,
        {
          description: 'After commit, the storno is posted and the original stays visible. Confirm with gnubok_query_journal.',
          tool: 'gnubok_query_journal',
        },
        { dateForPeriodCheck: original.entry_date },
      )
    },
  },

  // ─── Phase 4-7: bokslut wizard surfaces exposed to agents ───────────

  {
    name: 'gnubok_propose_dispositioner',
    title: 'Propose Year-End Dispositioner',
    description:
      'Read-only proposal of bokslutsdispositioner for a fiscal period: periodiseringsfond (avsättning + obligatorisk återföring), överavskrivningar, SLP, bolagsskatt. No dedicated MCP poster: stage entries via gnubok_create_voucher (web bokslut UI) before gnubok_run_year_end.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
      },
      required: ['fiscal_period_id'],
    },
    // Output is the same DispositionsProposal shape returned by GET
    // /bokslutsdispositioner: surface as a permissive object so the
    // strict-schema test passes without duplicating the type tree here.
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { buildDispositionsProposal } = await import('@/lib/bokslut/dispositions-proposal-builder')
      return buildDispositionsProposal(supabase, companyId, fiscalPeriodId)
    },
  },

  {
    name: 'gnubok_propose_accruals',
    title: 'Propose Accruals (Periodiseringar)',
    description:
      'Read-only proposal of periodiseringar (förutbetalda/upplupna kostnader); currently surfaces the vacation-liability change. No dedicated MCP poster: stage accrual entries via gnubok_create_voucher (or the web accruals form).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { buildAccrualsProposal } = await import('@/lib/bokslut/accruals/accrual-detector')
      return buildAccrualsProposal(supabase, companyId, fiscalPeriodId)
    },
  },

  {
    name: 'gnubok_list_accrual_schedules',
    title: 'List Periodiseringar',
    description:
      'Löpande periodiseringar (17xx/29xx): monthly installments, dissolved and remaining amounts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'completed', 'cancelled', 'all'],
          description: "Default 'active'.",
        },
      },
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const status = (args.status as string) || 'active'
      let query = supabase
        .from('accrual_schedules')
        .select('*, installments:accrual_schedule_installments(*)')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
      if (status !== 'all') query = query.eq('status', status)
      const { data, error } = await query
      if (error) throw new Error(error.message)

      type InstallmentRow = { period_month: string; amount: number; status: string }
      const schedules = ((data ?? []) as Array<Record<string, unknown>>).map((schedule) => {
        const installments = ([...((schedule.installments as InstallmentRow[]) ?? [])]).sort(
          (a, b) => a.period_month.localeCompare(b.period_month),
        )
        const dissolved = sumOre(
          installments.filter((i) => i.status === 'posted').map((i) => Number(i.amount)),
        )
        const total = Number(schedule.total_amount)
        return {
          ...schedule,
          installments,
          dissolved_amount: dissolved,
          remaining_amount:
            schedule.status === 'cancelled' ? 0 : roundOre(total - dissolved),
        }
      })
      return { schedules, count: schedules.length }
    },
  },

  {
    name: 'gnubok_propose_annual_depreciation',
    title: 'Propose Annual Depreciation (Avskrivning)',
    description:
      'Read-only per-asset planenlig avskrivning proposal for a fiscal period. Reads the asset register and existing depreciation schedules. Call before staging the post.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { proposeAnnualPostings } = await import('@/lib/bokslut/assets/depreciation-engine')
      return proposeAnnualPostings(supabase, companyId, fiscalPeriodId)
    },
  },

  {
    name: 'gnubok_post_annual_depreciation',
    title: 'Post Annual Depreciation (Avskrivning)',
    description:
      'Stage planenlig avskrivning posts: one journal entry per asset for independent reversibility. Mid-risk, always staged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
        asset_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional whitelist of asset UUIDs to post; omit to post all proposed.',
        },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: STAGED_OPERATION_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const assetIds = Array.isArray(args.asset_ids) ? (args.asset_ids as string[]) : undefined

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_end, is_closed, locked_at, closing_entry_id')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      if (!period) throw new Error('Fiscal period not found')
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        throw new Error('Period is locked or closed')
      }

      const { proposeAnnualPostings } = await import('@/lib/bokslut/assets/depreciation-engine')
      const proposal = await proposeAnnualPostings(supabase, companyId, fiscalPeriodId)
      const filtered = assetIds
        ? proposal.items.filter((i) => assetIds.includes(i.asset.id))
        : proposal.items
      const pending = filtered.filter((i) => !i.existingJournalEntryId)

      const totalAmount = pending.reduce((s, i) => s + i.amount, 0)
      return stagePendingOperation(
        supabase, companyId, userId, 'post_annual_depreciation',
        `Planenlig avskrivning: ${period.name}, ${pending.length} tillgång(ar), ${Math.round(totalAmount * 100) / 100} SEK`,
        { fiscal_period_id: fiscalPeriodId, asset_ids: assetIds },
        {
          period_name: period.name,
          item_count: pending.length,
          total_amount: totalAmount,
          will: `book ${pending.length} planenlig avskrivning(ar): one journal entry per asset`,
          items: pending.map((i) => ({
            asset_id: i.asset.id,
            asset_name: i.asset.name,
            amount: i.amount,
            pro_rated: i.proRated,
          })),
        },
        actor,
        {
          description: 'After approval, depreciation entries are posted. Continue the year-end flow via gnubok_year_end_readiness, then gnubok_run_year_end.',
          tool: 'gnubok_year_end_readiness',
          args: { fiscal_period_id: fiscalPeriodId },
        },
        { dateForPeriodCheck: period.period_end },
      )
    },
  },

  {
    name: 'gnubok_preview_ef_declaration',
    title: 'Preview EF Declaration (NE-bilaga)',
    description:
      'Read-only EF declaration preview: egenavgifter schablonavdrag, räntefördelning, periodiseringsfond, expansionsfond. All declaration-only, never booked. Pass kapitalunderlag and prior-year amounts as inputs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fiscal_period_id: { type: 'string', description: 'UUID of the fiscal period' },
        category: {
          type: 'string',
          enum: ['full', 'pensioner', 'passive'],
          description: 'Egenavgifter category: defaults to "full"',
        },
        kapitalunderlag: { type: 'number', description: 'Justerat eget kapital vid föregående års utgång (default 0)' },
        prior_year_schablonavdrag: { type: 'number' },
        prior_year_actual_charged: { type: 'number' },
        pfond_desired_amount: { type: 'number' },
        expansionsfond_existing_balance: { type: 'number' },
        expansionsfond_desired_change: { type: 'number' },
      },
      required: ['fiscal_period_id'],
    },
    outputSchema: { type: 'object', additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, _userId, supabase, _actor) {
      const fiscalPeriodId = args.fiscal_period_id as string
      if (!fiscalPeriodId) throw new Error('fiscal_period_id is required')
      const { computeEfDeclarationPreview } = await import('@/lib/bokslut/enskild-firma/ef-declaration-preview')
      return computeEfDeclarationPreview(supabase, companyId, fiscalPeriodId, {
        category: args.category as 'full' | 'pensioner' | 'passive' | undefined,
        kapitalunderlag: args.kapitalunderlag as number | undefined,
        priorYearSchablonavdrag: args.prior_year_schablonavdrag as number | undefined,
        priorYearActualCharged: args.prior_year_actual_charged as number | undefined,
        pfondDesiredAmount: args.pfond_desired_amount as number | undefined,
        expansionsfondExistingBalance: args.expansionsfond_existing_balance as number | undefined,
        expansionsfondDesiredChange: args.expansionsfond_desired_change as number | undefined,
      })
    },
  },

  // ── Pending operations: list / approve / reject ──────────────
  // Mirrors the /pending web UI for agents that self-review before committing.
  {
    name: 'gnubok_list_pending_operations',
    title: 'List Pending Operations',
    description: 'List staged pending_operations. Filter by status (default pending), risk_level, or operation_type. Approve via gnubok_approve_pending_operation, discard via gnubok_reject_pending_operation. render_ui=true opens the approval widget.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['pending', 'committing', 'committed', 'rejected', 'failed_partial'], description: 'Default: pending' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
        operation_type: { type: 'string', description: 'Filter to a single operation_type (e.g. "create_invoice")' },
        limit: { type: 'number', minimum: 1, maximum: 200, description: 'Default 50' },
        offset: { type: 'number', minimum: 0, description: 'Default 0' },
        render_ui: {
          type: 'boolean',
          description: 'Render the interactive approval widget (claude.ai / Desktop): approve/reject by click; the click supplies the high-risk BFL acknowledgment. Data returned either way. Default false.',
        },
      },
      required: [],
    },
    outputSchema: paginatedSchema('operations'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // Renders the approval-queue widget only when the caller passes
    // render_ui=true (the dispatcher emits result-level _meta in that case),
    // keeping the tool data-only by default.
    uiResourceUri: 'ui://pending-operations/app.html',
    async execute(args, companyId, _userId, supabase) {
      const status = (args.status as string) ?? 'pending'
      const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 50))
      const offset = Math.max(0, (args.offset as number) ?? 0)

      // `params` holds the raw operation inputs (invoice line items, supplier
      // PII, voucher descriptions): excluded from the list response to
      // satisfy data-minimisation (GDPR Art. 5(1)(b)). Use preview_data for
      // a redacted, human-readable summary, or call the underlying entity
      // endpoint when the agent needs the full payload.
      let query = supabase
        .from('pending_operations')
        .select(
          'id, operation_type, title, preview_data, status, risk_level, actor_type, actor_id, actor_label, created_at, resolved_at, result_data',
          { count: 'exact' }
        )
        .eq('company_id', companyId)
        .eq('status', status)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (args.risk_level) query = query.eq('risk_level', args.risk_level as string)
      if (args.operation_type) query = query.eq('operation_type', args.operation_type as string)

      const { data, error, count } = await query
      if (error) throw new Error(`Failed to list pending operations: ${error.message}`)

      const operations = data ?? []
      const totalCount = count ?? operations.length
      const hasMore = offset + operations.length < totalCount
      return {
        operations,
        count: operations.length,
        total_count: totalCount,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + operations.length } : {}),
      }
    },
  },

  {
    name: 'gnubok_approve_pending_operation',
    title: 'Approve Pending Operation',
    description: "Commit a staged pending_operation the user has explicitly authorised. risk_level=high requires confirmed=true: surface the BFL 5 kap 5§ irreversibility first. The /pending web UI offers an equivalent commit path.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', description: 'UUID of the pending_operations row to approve' },
        confirmed: {
          type: 'boolean',
          description: 'Required when the operation has risk_level=high (create_voucher, correct_entry, reverse_entry, year-end, period lock/close). Acknowledges the BFL/BFNAR irreversibility implications. The web UI surfaces the same gate via an explicit warning dialog.',
        },
      },
      required: ['operation_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['committed', 'rejected', 'failed'] },
        operation_id: { type: 'string' },
        data: { type: 'object' },
        error: { type: 'string' },
        auto_rejected: { type: 'boolean' },
      },
      required: ['status', 'operation_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const operationId = args.operation_id as string
      if (!operationId) throw new Error('operation_id is required')

      const { data: op, error: fetchError } = await supabase
        .from('pending_operations')
        .select('*')
        .eq('id', operationId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !op) throw new Error('Pending operation not found')

      // High-risk operations require explicit confirmation in addition to the
      // standard pending_operations:approve scope. Mirrors the web-UI gate
      // (BFL 5 kap 5§: irreversible postings require positive acknowledgment).
      const operation = op as PendingOperation
      if (operation.risk_level === 'high' && args.confirmed !== true) {
        throw new Error(
          `Operation "${operation.operation_type}" is risk_level=high: pass confirmed=true to approve. The web UI requires the same positive acknowledgment per BFL 5 kap 5§ (irreversible postings).`
        )
      }

      // Resolve the user's email so commitPendingOperation can attribute the
      // journal_entries.committed_by_email and any user-facing email side
      // effects (send_invoice cc) to the actor: matches the web-UI commit
      // path attribution (V8.2.1, GDPR Art. 25(1)).
      let userEmail: string | undefined
      try {
        const { data: userData } = await supabase.auth.admin.getUserById(userId)
        userEmail = userData.user?.email ?? undefined
      } catch (err) {
        log.warn('Failed to resolve user email for MCP approval', { userId, err })
      }

      // commit_method provenance (agent_first_vision.md §8 P0-1): MCP
      // approvals are relayed through an agent credential: record that in
      // the immutable layer instead of claiming 'user_accept'. The positive
      // acknowledgment (confirmed=true for high risk) is agent-attested, not
      // a first-party human session; an auditor reading the GL can now tell
      // the difference (BFNAR 2013:2 kap 8 behandlingshistorik).
      //
      // ALL MCP traffic authenticates as an api_key actor: the claude.ai
      // OAuth connector's access_token is itself a minted gnubok_sk_ key
      // (app/api/mcp-oauth/token/route.ts), indistinguishable from the
      // bridge at this layer: so 'api_key' is the truthful value for every
      // path through this handler. 'agent' (also in the CHECK) is reserved
      // for first-party agent surfaces (e.g. in-app agent chat) once they
      // commit through this layer with a distinguishable actor type.
      //
      // commitMethod reaches the journal only for create_voucher ops
      // (pre-existing); the actor option below covers EVERY journal commit
      // this operation makes via the runWithActor() scope inside
      // commitPendingOperation, stamping journal_entries.committed_actor_*
      // and the audit_log COMMIT row (migration 20260619120000).
      const commitMethod =
        actor?.type === 'api_key' ? ('api_key' as const) : ('user_accept' as const)

      const result = await commitPendingOperation(
        supabase,
        userId,
        companyId,
        operation,
        {
          commitMethod,
          actor: {
            type: actor?.type === 'api_key' ? 'api_key' : 'user',
            ...(actor?.label ? { label: actor.label } : {}),
          },
          ...(userEmail ? { userEmail } : {}),
        }
      )

      // Audit the MCP-initiated approval. Failure must not break the user
      // flow: the side-effects have already happened.
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: operationId,
          aggregateType: 'System',
          aggregateId: operationId,
          eventType: 'PendingOperationApproved',
          payload: {
            operation_id: operationId,
            operation_type: operation.operation_type,
            risk_level: operation.risk_level,
            outcome: result.status,
            commit_method: commitMethod,
            channel: 'mcp',
            confirmed: args.confirmed === true,
          },
          actor: {
            type: actor?.type === 'api_key' ? 'api_key' : 'user',
            id: actor?.id ?? userId,
            ...(actor?.label ? { label: actor.label } : {}),
          },
          occurredAt: new Date(),
        })
      } catch (auditErr) {
        log.warn('Failed to append PendingOperationApproved audit event', auditErr)
      }

      return {
        status: result.status,
        operation_id: operationId,
        ...(result.data ? { data: result.data } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.auto_rejected ? { auto_rejected: true } : {}),
      }
    },
  },

  {
    name: 'gnubok_reject_pending_operation',
    title: 'Reject Pending Operation',
    description: 'Reject a staged pending_operation without executing it. Status flips to rejected; no journal entries, invoices, or other side-effects created. Idempotent on already-resolved ops (returns 409).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: { type: 'string', description: 'UUID of the pending_operations row to reject' },
        reason: {
          type: 'string',
          description: 'Optional human-readable reason recorded in result_data for the audit trail',
          maxLength: 500,
        },
      },
      required: ['operation_id'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['rejected'] },
        operation_id: { type: 'string' },
      },
      required: ['status', 'operation_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const operationId = args.operation_id as string
      if (!operationId) throw new Error('operation_id is required')

      const reason = typeof args.reason === 'string' ? args.reason.slice(0, 500) : undefined

      const { data: op, error: fetchError } = await supabase
        .from('pending_operations')
        .select('id, status, operation_type, risk_level')
        .eq('id', operationId)
        .eq('company_id', companyId)
        .single()

      if (fetchError || !op) throw new Error('Pending operation not found')
      if (op.status !== 'pending') {
        // No auto-commit path exists (removed in 20260505190027). A non-pending
        // status means the op was resolved explicitly: usually the user
        // approved it in the Att göra / pending UI in parallel. Make that
        // explicit so the agent doesn't read it as a silent auto-commit.
        throw new Error(
          op.status === 'rejected'
            ? 'Operation already rejected.'
            : op.status === 'failed_partial'
              ? 'Operation already resolved as failed_partial: it failed after posting an ' +
                'irreversible voucher. See result_data.posted_ids for what was posted and ' +
                'correct it with a storno if needed.'
              : `Operation already ${op.status}: approved explicitly (likely via the pending UI), ` +
                'not auto-committed. Reverse or correct the resulting verifikat instead.',
        )
      }

      // Atomic claim: flips pending → rejected only when the row is still
      // pending AND in the caller's tenant (V8.3.1, CC6.3 tenant isolation).
      // The .eq('status', 'pending') guard makes this a CAS so a concurrent
      // approval cannot lose to a parallel reject.
      const { data: updated, error: updateError } = await supabase
        .from('pending_operations')
        .update({
          status: 'rejected',
          resolved_at: new Date().toISOString(),
          result_data: {
            rejected_by: userId,
            rejected_via: actor?.type ?? 'user',
            ...(actor?.id ? { actor_id: actor.id } : {}),
            ...(reason ? { reason } : {}),
          },
        })
        .eq('id', operationId)
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .select('id')

      if (updateError) throw new Error(`Failed to reject operation: ${updateError.message}`)
      if (!updated || updated.length === 0) {
        throw new Error('Operation no longer pending: another caller claimed it')
      }

      // Audit the rejection so the trail mirrors the approval path.
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: operationId,
          aggregateType: 'System',
          aggregateId: operationId,
          eventType: 'PendingOperationRejected',
          payload: {
            operation_id: operationId,
            operation_type: op.operation_type,
            risk_level: op.risk_level,
            channel: 'mcp',
            ...(reason ? { has_reason: true } : { has_reason: false }),
          },
          actor: {
            type: actor?.type === 'api_key' ? 'api_key' : 'user',
            id: actor?.id ?? userId,
            ...(actor?.label ? { label: actor.label } : {}),
          },
          occurredAt: new Date(),
        })
      } catch (auditErr) {
        log.warn('Failed to append PendingOperationRejected audit event', auditErr)
      }

      return { status: 'rejected' as const, operation_id: operationId }
    },
  },

  // ── Bring-your-own-extraction for inbox items ────────────────
  {
    name: 'gnubok_set_inbox_extracted_data',
    title: 'Set Inbox Extracted Data',
    description: 'Replace extracted_data on an inbox item with agent-supplied fields (the agent parses the document itself). Follow with gnubok_create_supplier_invoice_from_inbox to stage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string', description: 'UUID of the invoice_inbox_items row' },
        extracted_data: {
          type: 'object',
          description: 'Full extraction result (supplier, invoice, lineItems, totals, vatBreakdown). lineItems.accountSuggestion accepts a BAS expense account (4xxx-7xxx).',
        },
      },
      required: ['inbox_item_id', 'extracted_data'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox_item_id: { type: 'string' },
        matched_supplier_id: { type: ['string', 'null'] },
        extracted_data: { type: 'object' },
      },
      required: ['inbox_item_id', 'extracted_data'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(args, companyId, userId, supabase, actor) {
      const inboxItemId = args.inbox_item_id as string
      if (!inboxItemId) throw new Error('inbox_item_id is required')

      const parsed = AgentExtractionSchema.parse(args.extracted_data)
      // BYO extraction: confidence 0.95 marks the result as agent-supplied
      // so downstream UI can render the provenance differently
      // (ISO 27001 A.8.12). AgentExtractionSchema preserves accountSuggestion
      // so agents can pin a BAS cost account per line.
      const extracted = { ...parsed, confidence: 0.95 }

      const { data: item, error: fetchError } = await supabase
        .from('invoice_inbox_items')
        .select('id, company_id, created_supplier_invoice_id')
        .eq('id', inboxItemId)
        .eq('company_id', companyId)
        .maybeSingle()

      if (fetchError) throw new Error(`Failed to fetch inbox item: ${fetchError.message}`)
      if (!item) throw new Error('Inbox item not found')
      // Explicit defense-in-depth tenant check (V4.5.1) alongside the .eq()
      // filter on the SELECT: surfaces a tampered service-role query
      // before it reaches the UPDATE.
      if (item.company_id !== companyId) {
        throw new Error('Inbox item belongs to a different company')
      }
      if (item.created_supplier_invoice_id) {
        throw new Error('Inbox item is already linked to a supplier invoice and cannot be modified')
      }

      // Supplier match so agent-supplied fields trigger the auto-link
      // (org-nr → name, ILIKE).
      let matchedSupplierId: string | null = null
      if (extracted.supplier.orgNumber) {
        const { data: s } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', companyId)
          .eq('org_number', extracted.supplier.orgNumber)
          .limit(1)
          .maybeSingle()
        if (s) matchedSupplierId = s.id
      }
      if (!matchedSupplierId && extracted.supplier.name) {
        const { data: s } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', companyId)
          .ilike('name', extracted.supplier.name)
          .limit(1)
          .maybeSingle()
        if (s) matchedSupplierId = s.id
      }

      const { error: updateError } = await supabase
        .from('invoice_inbox_items')
        .update({
          extracted_data: extracted as unknown as Record<string, unknown>,
          matched_supplier_id: matchedSupplierId,
        })
        .eq('id', inboxItemId)
        .eq('company_id', companyId)

      if (updateError) throw new Error(`Failed to update inbox item: ${updateError.message}`)

      // Audit the BYO override so financial-data provenance is traceable
      // (GDPR Art. 5(1)(f), SOC 2 CC9.2). Failure must not block the user
      // flow: the override has already landed in the DB.
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: inboxItemId,
          aggregateType: 'Document',
          aggregateId: inboxItemId,
          eventType: 'DocumentExtractionOverridden',
          payload: {
            inbox_item_id: inboxItemId,
            channel: 'mcp',
            has_supplier_org_number: extracted.supplier.orgNumber != null,
            has_invoice_number: extracted.invoice.invoiceNumber != null,
            extracted_total: extracted.totals.total,
            matched_supplier_id: matchedSupplierId,
          },
          actor: {
            type: actor?.type === 'api_key' ? 'api_key' : 'user',
            id: actor?.id ?? userId,
            ...(actor?.label ? { label: actor.label } : {}),
          },
          occurredAt: new Date(),
        })
      } catch (auditErr) {
        log.warn('Failed to append DocumentExtractionOverridden audit event', auditErr)
      }

      return {
        inbox_item_id: inboxItemId,
        matched_supplier_id: matchedSupplierId,
        extracted_data: extracted as unknown as Record<string, unknown>,
      }
    },
  },

  // ── Recurring invoice schedules ──────────────────────────────

  {
    name: 'gnubok_list_recurring_schedules',
    title: 'List Recurring Invoice Schedules',
    description: "List the company's recurring invoice schedules: auto-create customer invoices on day_of_month (clamps to the last day in shorter months) every interval_months months (any 1-12; presets 1/3/6/12) at send_hour, Europe/Stockholm. Shows status, auto_send and next_run_date.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'paused'],
          description: 'Filter by schedule status',
        },
        limit: { type: 'number', description: 'Max results (default 50, max 100)' },
        offset: { type: 'integer', minimum: 0, description: 'Number of results to skip for pagination (default 0)' },
      },
    },
    outputSchema: paginatedSchema('schedules', {
      type: 'object',
      properties: {
        recurring_schedule_id: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused'] },
        customer_id: { type: 'string' },
        customer_name: { type: ['string', 'null'] },
        day_of_month: { type: 'number', description: '1-31; clamps to the last day in shorter months' },
        interval_months: { type: 'number', description: 'Months between runs: any integer 1-12; 1 = monthly, 3 = quarterly, 6 = half-yearly, 12 = yearly' },
        send_hour: { type: 'number', description: 'Whole hour 0-23 in Europe/Stockholm time' },
        payment_terms_days: { type: 'number' },
        currency: { type: 'string' },
        auto_send: { type: 'boolean' },
        next_run_date: { type: 'string' },
        last_run_at: { type: ['string', 'null'] },
        last_invoice_id: { type: ['string', 'null'], description: 'Most recently generated invoice' },
        last_run_warning: { type: ['string', 'null'] },
        generated_count: { type: 'number' },
        monthly_total_excl_vat: { type: 'number' },
        default_dimensions: {
          type: 'object',
          description: 'Dims bag {sie_dim_no: code} copied onto every generated invoice',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string' },
              unit_price: { type: 'number' },
              vat_rate: { type: ['number', 'null'], description: 'null = customer default at spawn time' },
              dimensions: { type: 'object', description: 'Per-item dims bag; wins per key over default_dimensions' },
            },
          },
        },
      },
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    catalogVisibility: 'search',
    async execute(args, companyId, userId, supabase) {
      const limit = Math.min(Math.max(1, Number(args.limit) || 50), 100)
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      const status = args.status as string | undefined

      let query = supabase
        .from('recurring_invoice_schedules')
        .select(
          'id, name, status, customer_id, day_of_month, interval_months, send_hour, payment_terms_days, currency, auto_send, default_dimensions, next_run_date, last_run_at, last_invoice_id, last_run_warning, generated_count, customer:customers(name), items:recurring_invoice_schedule_items(description, quantity, unit, unit_price, vat_rate, dimensions, sort_order)',
          { count: 'exact' },
        )
        .eq('company_id', companyId)

      if (status) {
        query = query.eq('status', status)
      }

      const { data, error, count } = await query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + limit)

      if (error) throw new Error(`Database error: ${error.message}`)

      const rows = data ?? []
      const schedules = rows.slice(0, limit).map((row: Record<string, unknown>) => {
        const items = ((row.items as Array<Record<string, unknown>>) ?? [])
          .slice()
          .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
          .map((it) => ({
            description: it.description,
            quantity: it.quantity,
            unit: it.unit,
            unit_price: it.unit_price,
            vat_rate: it.vat_rate ?? null,
            dimensions: it.dimensions ?? {},
          }))
        const monthlyTotalExclVat =
          Math.round(items.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_price), 0) * 100) / 100
        return {
          recurring_schedule_id: row.id,
          name: row.name,
          status: row.status,
          customer_id: row.customer_id,
          customer_name: (row.customer as Record<string, unknown> | null)?.name ?? null,
          day_of_month: row.day_of_month,
          interval_months: row.interval_months,
          send_hour: row.send_hour,
          payment_terms_days: row.payment_terms_days,
          currency: row.currency,
          auto_send: row.auto_send,
          next_run_date: row.next_run_date,
          last_run_at: row.last_run_at ?? null,
          last_invoice_id: row.last_invoice_id ?? null,
          last_run_warning: row.last_run_warning ?? null,
          generated_count: row.generated_count,
          monthly_total_excl_vat: monthlyTotalExclVat,
          default_dimensions: row.default_dimensions ?? {},
          items,
        }
      })

      const hasMore = count == null
        ? rows.length > limit
        : offset + schedules.length < count
      const total = count ?? offset + schedules.length + (hasMore ? 1 : 0)

      return {
        schedules,
        count: schedules.length,
        total_count: total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + schedules.length } : {}),
      }
    },
  },

  {
    name: 'gnubok_create_recurring_schedule',
    title: 'Create Recurring Invoice Schedule',
    description: 'Stage a new recurring invoice schedule: creates a customer invoice on day_of_month (clamps to the last day in shorter months) every interval_months months (default 1) at send_hour, Europe/Stockholm. auto_send defaults false; true emails each invoice without new approval.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer_id: { type: 'string', description: 'Customer UUID from gnubok_list_customers.' },
        name: { type: 'string', minLength: 1, maxLength: 200, description: 'Internal schedule name (not printed on the invoice).' },
        day_of_month: {
          type: 'integer',
          minimum: 1,
          maximum: 31,
          description: 'Day of month the invoice is created. 29-31 clamp to the last day in shorter months; the stored day is kept for longer months.',
        },
        interval_months: {
          type: 'integer',
          minimum: 1,
          maximum: 12,
          description: 'Months between invoices: any integer 1-12. Default 1 (monthly); 3 = quarterly, 6 = half-yearly, 12 = yearly.',
        },
        send_hour: {
          type: 'integer',
          minimum: 0,
          maximum: 23,
          description: 'Whole hour (0-23) in Europe/Stockholm time at which the schedule runs. Default 8.',
        },
        payment_terms_days: { type: 'integer', minimum: 0, maximum: 90, description: 'due_date = invoice_date + terms. Default 30.' },
        currency: { type: 'string', enum: ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'], description: 'Default SEK.' },
        your_reference: { type: 'string' },
        our_reference: { type: 'string' },
        notes: { type: 'string' },
        auto_send: {
          type: 'boolean',
          description: 'Default false: invoices are created as drafts for manual review. true emails every generated invoice to the customer with no further approval; requires the customer to have an email address.',
        },
        start_date: { type: 'string', description: 'YYYY-MM-DD first run date. Omit to run on the next occurrence of day_of_month.' },
        default_dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dims bag keyed by SIE dim no, value = code OR name, e.g. {"6":"P001"}. Copied onto every generated invoice. Unknown values rejected: never auto-created.',
        },
        items: {
          type: 'array',
          minItems: 1,
          description: 'Template lines copied onto every generated invoice.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string', description: 'st, tim, dag, mån. Default st.' },
              unit_price: { type: 'number', description: 'Price per unit excl. VAT.' },
              vat_rate: {
                type: ['number', 'null'],
                enum: [0, 6, 12, 25, null],
                description: 'Omit or null to use the customer default VAT rate at spawn time.',
              },
              dimensions: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Dims bag {sie_dim_no: kod eller namn}, e.g. {"6":"P001"}. Wins per key over default_dimensions.',
              },
            },
            required: ['description', 'quantity', 'unit_price'],
          },
        },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging or changing data.' },
        idempotency_key: { type: 'string', description: 'Random per-operation UUID. Reusing it with the same payload returns the original staged response.' },
      },
      required: ['customer_id', 'name', 'day_of_month', 'items'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    catalogVisibility: 'search',
    async execute(args, companyId, userId, supabase, actor) {
      // Resolve-don't-select: parse the schedule-level default bag + each
      // item's own bag, then resolve codes AND natural-language names against
      // the registry in ONE pass (mirrors gnubok_create_invoice). The staged
      // params carry only resolved codes; the cron copies them verbatim onto
      // every generated invoice.
      const rawItems = Array.isArray(args.items)
        ? (args.items as Array<Record<string, unknown>>)
        : []
      const defaultDimensions = parseDimensionsArg(args.default_dimensions, 'default_dimensions')
      const { bags: resolvedDimBags, resolutions: dimensionResolutions } = await resolveDimensionBags(
        supabase,
        companyId,
        [defaultDimensions, ...rawItems.map((item, i) => parseDimensionsArg(item.dimensions, `items[${i}].dimensions`))],
      )
      const resolvedDefaultDimensions = resolvedDimBags[0]
      const stagedItems = rawItems.map((item, i) => {
        const { dimensions: _rawDimensions, ...rest } = item
        const bag = resolvedDimBags[i + 1]
        return bag && Object.keys(bag).length > 0 ? { ...rest, dimensions: bag } : rest
      })

      const candidate: Record<string, unknown> = {}
      for (const key of [
        'customer_id',
        'name',
        'day_of_month',
        'interval_months',
        'send_hour',
        'payment_terms_days',
        'currency',
        'your_reference',
        'our_reference',
        'notes',
        'auto_send',
        'start_date',
      ]) {
        if (args[key] !== undefined) candidate[key] = args[key]
      }
      if (args.items !== undefined) {
        // Non-array garbage passes through verbatim so the schema error below
        // names the real problem instead of a synthetic empty list.
        candidate.items = Array.isArray(args.items) ? stagedItems : args.items
      }
      if (resolvedDefaultDimensions && Object.keys(resolvedDefaultDimensions).length > 0) {
        candidate.default_dimensions = resolvedDefaultDimensions
      }

      const parsed = CreateRecurringScheduleParamsSchema.safeParse(candidate)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(`Invalid recurring schedule: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'validation failed'}`)
      }
      const params = parsed.data

      const { data: customer, error } = await supabase
        .from('customers')
        .select('id, name, email')
        .eq('id', params.customer_id)
        .eq('company_id', companyId)
        .maybeSingle()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!customer) throw new Error('Customer not found. Use gnubok_list_customers to find IDs.')
      if (params.auto_send && !customer.email) {
        throw new Error('Customer has no email address: auto_send requires one. Stage with auto_send=false or add an email first.')
      }

      const monthlyTotalExclVat =
        Math.round(params.items.reduce((sum, it) => sum + it.quantity * it.unit_price, 0) * 100) / 100

      // auto_send appears explicitly in the preview: an auto-sending schedule
      // is recurring outbound customer email that never sees approval again,
      // so the human must see exactly that flag when approving.
      const preview = {
        name: params.name,
        customer_id: customer.id,
        customer_name: customer.name,
        day_of_month: params.day_of_month,
        interval_months: params.interval_months,
        send_hour: params.send_hour,
        payment_terms_days: params.payment_terms_days,
        currency: params.currency,
        auto_send: params.auto_send,
        projected_first_run_date: computeInitialRunDate(new Date(), params.day_of_month, params.start_date),
        monthly_total_excl_vat: monthlyTotalExclVat,
        items: params.items,
        ...(params.default_dimensions && Object.keys(params.default_dimensions).length > 0
          ? { default_dimensions: params.default_dimensions }
          : {}),
        // Echoed for every non-exact dimension resolution (resolve-don't-
        // select) so the agent can verify what a name attached to.
        ...(dimensionResolutions.length > 0 ? { dimension_resolutions: dimensionResolutions } : {}),
      }

      return stagePendingOperation(supabase, companyId, userId, 'create_recurring_schedule',
        `Nytt återkommande fakturaschema: ${params.name}`,
        params as unknown as Record<string, unknown>,
        preview,
        actor,
        {
          description: 'Once approved, verify the schedule with gnubok_list_recurring_schedules; the hourly cron creates invoices from next_run_date.',
          tool: 'gnubok_list_recurring_schedules',
        },
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        }
      )
    },
  },

  {
    name: 'gnubok_update_recurring_schedule',
    title: 'Update Recurring Invoice Schedule',
    description: 'Stage an update to a recurring invoice schedule (schedule_id from gnubok_list_recurring_schedules). Pause/resume via status. items replace all lines; omit to keep them. day_of_month clamps to the last day in shorter months; send_hour is a whole hour in Europe/Stockholm.',
    outputSchema: STAGED_OPERATION_SCHEMA,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schedule_id: { type: 'string', description: 'UUID from gnubok_list_recurring_schedules.' },
        customer_id: { type: 'string', description: 'Move the schedule to another customer.' },
        name: { type: 'string', minLength: 1, maxLength: 200 },
        day_of_month: {
          type: 'integer',
          minimum: 1,
          maximum: 31,
          description: '1-31; clamps to the last day in shorter months. Changing it rolls next_run_date to the next future occurrence.',
        },
        interval_months: {
          type: 'integer',
          minimum: 1,
          maximum: 12,
          description: 'Months between invoices: any integer 1-12; 1 = monthly, 3 = quarterly, 6 = half-yearly, 12 = yearly. Changing only interval_months leaves next_run_date untouched.',
        },
        send_hour: { type: 'integer', minimum: 0, maximum: 23, description: 'Whole hour (0-23) in Europe/Stockholm time.' },
        payment_terms_days: { type: 'integer', minimum: 0, maximum: 90 },
        currency: { type: 'string', enum: ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'] },
        your_reference: { type: ['string', 'null'], description: 'Null clears the field.' },
        our_reference: { type: ['string', 'null'], description: 'Null clears the field.' },
        notes: { type: ['string', 'null'], description: 'Null clears the field.' },
        auto_send: {
          type: 'boolean',
          description: 'true emails every generated invoice with no further approval (requires customer email). false returns to draft-only.',
        },
        status: {
          type: 'string',
          enum: ['active', 'paused'],
          description: 'paused stops generating invoices; active resumes. Reactivating from a stale date rolls next_run_date to the next future occurrence, never today.',
        },
        default_dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Dims bag {sie_dim_no: kod eller namn} copied onto every generated invoice. Replaces the whole bag; {} clears all tags. Omit to keep.',
        },
        items: {
          type: 'array',
          minItems: 1,
          description: 'Replaces ALL existing template lines when provided; omit to keep the current lines unchanged.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit: { type: 'string', description: 'st, tim, dag, mån. Default st.' },
              unit_price: { type: 'number', description: 'Price per unit excl. VAT.' },
              vat_rate: {
                type: ['number', 'null'],
                enum: [0, 6, 12, 25, null],
                description: 'Omit or null to use the customer default VAT rate at spawn time.',
              },
              dimensions: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Dims bag {sie_dim_no: kod eller namn}, e.g. {"6":"P001"}. Wins per key over default_dimensions.',
              },
            },
            required: ['description', 'quantity', 'unit_price'],
          },
        },
        dry_run: { type: 'boolean', description: 'Validate and preview without staging or changing data.' },
        idempotency_key: { type: 'string', description: 'Random per-operation UUID. Reusing it with the same payload returns the original staged response.' },
      },
      required: ['schedule_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    catalogVisibility: 'search',
    async execute(args, companyId, userId, supabase, actor) {
      // Resolve-don't-select for both the replacement default bag and any
      // per-item bags (mirrors gnubok_create_recurring_schedule). An explicit
      // {} default_dimensions passes through as the clear-all-tags update.
      const rawItems = Array.isArray(args.items)
        ? (args.items as Array<Record<string, unknown>>)
        : []
      const defaultDimensions = parseDimensionsArg(args.default_dimensions, 'default_dimensions')
      const { bags: resolvedDimBags, resolutions: dimensionResolutions } = await resolveDimensionBags(
        supabase,
        companyId,
        [defaultDimensions, ...rawItems.map((item, i) => parseDimensionsArg(item.dimensions, `items[${i}].dimensions`))],
      )
      const stagedItems = rawItems.map((item, i) => {
        const { dimensions: _rawDimensions, ...rest } = item
        const bag = resolvedDimBags[i + 1]
        return bag && Object.keys(bag).length > 0 ? { ...rest, dimensions: bag } : rest
      })

      const changes: Record<string, unknown> = {}
      for (const key of [
        'customer_id',
        'name',
        'day_of_month',
        'interval_months',
        'send_hour',
        'payment_terms_days',
        'currency',
        'your_reference',
        'our_reference',
        'notes',
        'auto_send',
        'status',
      ]) {
        if (args[key] !== undefined) changes[key] = args[key]
      }
      if (args.default_dimensions !== undefined) {
        changes.default_dimensions = resolvedDimBags[0] ?? {}
      }
      if (args.items !== undefined) {
        // Non-array garbage passes through verbatim so the schema error below
        // names the real problem instead of a synthetic empty list.
        changes.items = Array.isArray(args.items) ? stagedItems : args.items
      }

      const parsed = UpdateRecurringScheduleParamsSchema.safeParse({
        schedule_id: args.schedule_id,
        changes,
      })
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(`Invalid schedule update: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'validation failed'}`)
      }
      const parsedChanges = parsed.data.changes

      const { data: current, error } = await supabase
        .from('recurring_invoice_schedules')
        .select(
          'id, name, status, customer_id, day_of_month, interval_months, send_hour, payment_terms_days, currency, your_reference, our_reference, notes, auto_send, default_dimensions, next_run_date, customer:customers(name, email), items:recurring_invoice_schedule_items(description, quantity, unit, unit_price, vat_rate, dimensions, sort_order)',
        )
        .eq('id', parsed.data.schedule_id)
        .eq('company_id', companyId)
        .maybeSingle()

      if (error) throw new Error(`Database error: ${error.message}`)
      if (!current) throw new Error('Recurring schedule not found. Use gnubok_list_recurring_schedules to find IDs.')

      // Turning auto_send on, or moving the schedule to another customer,
      // requires the (target) customer to have an email when auto_send is
      // effectively on; otherwise every cron run degrades to a draft +
      // warning. Mirrors the cookie-session PATCH route's guard.
      const effectiveAutoSend = parsedChanges.auto_send ?? (current.auto_send as boolean)
      if (parsedChanges.customer_id !== undefined) {
        const { data: target, error: targetError } = await supabase
          .from('customers')
          .select('id, email')
          .eq('id', parsedChanges.customer_id)
          .eq('company_id', companyId)
          .maybeSingle()
        if (targetError) throw new Error(`Database error: ${targetError.message}`)
        if (!target) throw new Error('Customer not found. Use gnubok_list_customers to find IDs.')
        if (effectiveAutoSend && !target.email) {
          throw new Error('Customer has no email address: auto_send requires one.')
        }
      } else if (parsedChanges.auto_send === true) {
        const currentCustomer = current.customer as { name?: string; email?: string | null } | null
        if (!currentCustomer?.email) {
          throw new Error('Customer has no email address: auto_send requires one. Add an email to the customer first.')
        }
      }

      const currentItems = ((current.items as Array<Record<string, unknown>>) ?? [])
        .slice()
        .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
        .map((it) => ({
          description: it.description,
          quantity: it.quantity,
          unit: it.unit,
          unit_price: it.unit_price,
          vat_rate: it.vat_rate ?? null,
          dimensions: it.dimensions ?? {},
        }))

      const currentPreview = {
        recurring_schedule_id: current.id,
        name: current.name,
        status: current.status,
        customer_id: current.customer_id,
        customer_name: (current.customer as { name?: string } | null)?.name ?? null,
        day_of_month: current.day_of_month,
        interval_months: current.interval_months,
        send_hour: current.send_hour,
        payment_terms_days: current.payment_terms_days,
        currency: current.currency,
        your_reference: current.your_reference ?? null,
        our_reference: current.our_reference ?? null,
        notes: current.notes ?? null,
        auto_send: current.auto_send,
        default_dimensions: current.default_dimensions ?? {},
        next_run_date: current.next_run_date,
        items: currentItems,
      }

      const { items: newItems, ...fieldChanges } = parsedChanges

      return stagePendingOperation(
        supabase,
        companyId,
        userId,
        'update_recurring_schedule',
        `Uppdatera återkommande fakturaschema: ${current.name}`,
        parsed.data as unknown as Record<string, unknown>,
        {
          current: currentPreview,
          changes: parsedChanges,
          proposed: {
            ...currentPreview,
            ...fieldChanges,
            ...(newItems ? { items: newItems } : {}),
          },
          // Echoed for every non-exact dimension resolution (resolve-don't-
          // select) so the agent can verify what a name attached to.
          ...(dimensionResolutions.length > 0 ? { dimension_resolutions: dimensionResolutions } : {}),
        },
        actor,
        undefined,
        {
          dryRun: Boolean(args.dry_run),
          idempotencyKey: typeof args.idempotency_key === 'string' ? args.idempotency_key : undefined,
        },
      )
    },
  },
]

// Drift guard for the gnubok_get_agent_briefing recommended_tools loadouts:
// every referenced tool must exist in the registry above and every referenced
// skill must be a real workflow skill. Runs at module init so a rename or
// removal fails the build (and every test importing this module) instead of
// shipping a briefing that recommends phantom tools.
assertRecommendedLoadoutsValid(new Set(tools.map((t) => t.name)))

// ── MCP Protocol Handler ─────────────────────────────────────

const SERVER_INFO_BY_NAMESPACE = {
  gnubok: {
    // Stable legacy identity for every existing connection.
    name: 'gnubok',
    title: 'Accounted',
    version: '1.0.0',
  },
  accounted: {
    name: 'accounted',
    title: 'Accounted',
    version: '1.0.0',
  },
} as const

const PROTOCOL_VERSION = '2025-06-18'

// ── Spec revision 2026-07-28 (stateless core) ────────────────
// New-style clients skip the initialize handshake and instead carry their
// protocol version and capabilities in _meta on every request. The handshake
// path keeps serving 2025-06-18-and-earlier clients unchanged: their
// responses stay byte-identical.
const STATELESS_PROTOCOL_VERSION = '2026-07-28'
const SUPPORTED_PROTOCOL_VERSIONS = [
  STATELESS_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
// 2026-07-28 reserves -32020..-32099 for spec-defined errors.
const JSONRPC_HEADER_MISMATCH = -32020
const JSONRPC_UNSUPPORTED_PROTOCOL_VERSION = -32022
// CacheableResult freshness hints. The tool/prompt catalog and widget HTML
// change only on deploy; skills live in the DB and can change between
// deploys; data resources are live ledger state and must never be cached.
// Everything is served behind Authorization, so cacheScope stays private.
const CACHE_STATIC = { ttlMs: 3_600_000, cacheScope: 'private' } as const
const CACHE_SKILLS = { ttlMs: 300_000, cacheScope: 'private' } as const
const CACHE_LIVE = { ttlMs: 0, cacheScope: 'private' } as const

const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { listChanged: false },
  prompts: { listChanged: false },
  extensions: {
    // MCP Apps (ratified extension): widgets are served as ui:// resources
    // and referenced from tool _meta.ui.resourceUri (see widgets/).
    'io.modelcontextprotocol/ui': {},
    // MCP Tasks: durable handles for long-running tool calls (see tasks.ts).
    [TASKS_EXTENSION_ID]: {},
  },
}

/**
 * Decode a standard-header value per the 2026-07-28 Value Encoding rules:
 * values outside plain ASCII arrive as =?base64?<data>?= and MUST be decoded
 * before comparing against the request body. Returns null for an absent
 * header so callers can distinguish "not sent" from "sent empty".
 */
function decodeMcpHeaderValue(value: string | null): string | null {
  if (value === null) return null
  const match = /^=\?base64\?(.*)\?=$/.exec(value)
  if (!match) return value
  try {
    return Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return value
  }
}

function jsonRpc(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

/**
 * Schedule a fire-and-forget telemetry emit so it cannot race Vercel function
 * suspension: `after()` keeps the function alive past the JSON-RPC response
 * until the emit settles, which is why event_log inserts used to die with
 * "TypeError: fetch failed". Falls back to a plain fire-and-forget emit when
 * no Next request scope exists (direct handler invocation in tests).
 */
function emitAfterResponse(emit: () => Promise<void>): void {
  try {
    after(emit)
  } catch {
    void emit()
  }
}

/**
 * Emit `mcp.tool_called` telemetry to the event bus. Fire-and-forget: the
 * dispatcher must never block the JSON-RPC response on telemetry, and a failing
 * handler must never surface to the client. The event bus already isolates
 * handlers via Promise.allSettled, but we belt-and-braces here too.
 */
function emitToolCallTelemetry(payload: {
  tool: string
  requiredScope: string | null
  actor: ActorContext
  latencyMs: number
  success: boolean
  isError: boolean
  errorCode: string | null
  errorKind: 'execution' | 'scope_denied' | 'capability_denied' | 'company_access_denied' | 'unknown_tool' | 'test_key_write_blocked' | null
  errorMessage: string | null
  requestId: string | number | null
  userId: string
  companyId: string
}): void {
  emitAfterResponse(() => eventBus
    .emit({
      type: 'mcp.tool_called',
      payload: {
        tool: payload.tool,
        requiredScope: payload.requiredScope,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        latencyMs: payload.latencyMs,
        success: payload.success,
        isError: payload.isError,
        errorCode: payload.errorCode,
        errorKind: payload.errorKind,
        // Truncated: domain error messages are short, but unknown-tool /
        // validation messages can embed long lists. 500 chars is plenty for
        // clustering failures into gotchas without bloating event_log rows.
        errorMessage: payload.errorMessage ? payload.errorMessage.slice(0, 500) : null,
        requestId: payload.requestId,
        userId: payload.userId,
        companyId: payload.companyId,
        sessionId: payload.actor.sessionId ?? null,
        client: payload.actor.client ?? null,
      },
    })
    .catch((err) => {
      // Last-resort guard. EventBus.emit already swallows handler failures,
      // but if the bus itself is in a bad state we still don't want to break tools.
      console.error('[mcp] tool_called telemetry emit failed:', err)
    }))
}

/** Fire-and-forget telemetry for a tools/list call. */
function emitToolsListTelemetry(payload: {
  toolCount: number
  actor: ActorContext
  latencyMs: number
  requestId: string | number | null
  userId: string
  companyId: string
}): void {
  emitAfterResponse(() => eventBus
    .emit({
      type: 'mcp.tools_list_called',
      payload: {
        toolCount: payload.toolCount,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        latencyMs: payload.latencyMs,
        requestId: payload.requestId,
        userId: payload.userId,
        companyId: payload.companyId,
        sessionId: payload.actor.sessionId ?? null,
        client: payload.actor.client ?? null,
      },
    })
    .catch((err) => {
      console.error('[mcp] tools_list_called telemetry emit failed:', err)
    }))
}

/** Fire-and-forget telemetry for a resources/read call. */
function emitResourceReadTelemetry(payload: {
  uri: string
  kind: 'widget' | 'skill' | 'data' | 'unknown'
  success: boolean
  errorCode: string | null
  actor: ActorContext
  latencyMs: number
  requestId: string | number | null
  userId: string
  companyId: string
}): void {
  emitAfterResponse(() => eventBus
    .emit({
      type: 'mcp.resource_read',
      payload: {
        uri: payload.uri,
        kind: payload.kind,
        success: payload.success,
        errorCode: payload.errorCode,
        latencyMs: payload.latencyMs,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        requestId: payload.requestId,
        userId: payload.userId,
        companyId: payload.companyId,
        sessionId: payload.actor.sessionId ?? null,
        client: payload.actor.client ?? null,
      },
    })
    .catch((err) => {
      console.error('[mcp] resource_read telemetry emit failed:', err)
    }))
}

/**
 * Per-session ring of "what was the most recent tool call, and what did its
 * response suggest as the `next` tool?" Used to detect `mcp.next_hint_followed`
 * when the agent's next call matches the previous nextHint.tool.
 *
 * In-memory only. Single-process visibility is acceptable for telemetry: a
 * miss in a multi-instance deploy only loses signal, never blocks a tool call.
 * Entries auto-expire after NEXT_HINT_TTL_MS to keep the map bounded.
 */
const NEXT_HINT_TTL_MS = 10 * 60 * 1000
const lastResponseHintBySession = new Map<string, { fromTool: string; suggestedTool: string; expiresAt: number }>()

function rememberNextHint(sessionId: string | null | undefined, fromTool: string, suggestedTool: string | undefined): void {
  if (!sessionId || !suggestedTool) return
  // Opportunistic eviction: drop a few expired entries on each write so the
  // map can't grow without bound under steady load.
  if (lastResponseHintBySession.size > 200) {
    const now = Date.now()
    for (const [k, v] of lastResponseHintBySession) {
      if (v.expiresAt < now) {
        lastResponseHintBySession.delete(k)
        if (lastResponseHintBySession.size < 100) break
      }
    }
  }
  lastResponseHintBySession.set(sessionId, {
    fromTool,
    suggestedTool,
    expiresAt: Date.now() + NEXT_HINT_TTL_MS,
  })
}

function checkAndEmitNextHintFollowed(
  sessionId: string | null | undefined,
  toolName: string,
  actor: ActorContext,
  userId: string,
  companyId: string,
): void {
  if (!sessionId) return
  const prev = lastResponseHintBySession.get(sessionId)
  if (!prev || prev.expiresAt < Date.now() || prev.suggestedTool !== toolName) return
  // Consume the hint so we don't double-count if the agent calls the same
  // tool twice in a row (idempotent retries shouldn't inflate the metric).
  lastResponseHintBySession.delete(sessionId)
  emitAfterResponse(() => eventBus
    .emit({
      type: 'mcp.next_hint_followed',
      payload: {
        fromTool: prev.fromTool,
        toTool: toolName,
        sessionId,
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorLabel: actor.label ?? null,
        userId,
        companyId,
      },
    })
    .catch((err) => console.error('[mcp] next_hint_followed emit failed:', err)))
}

/**
 * Fire-and-forget telemetry for every successful gnubok_load_skill, all tiers.
 * Unlike mcp.workflow_started (workflow tier only), this records WHICH skill
 * or atom body the agent pulled: the denominator for correlating a loaded
 * atom with downstream tool-error rates.
 */
function emitSkillLoaded(payload: {
  slug: string
  tier: 'workflow' | 'horizontal' | 'vertical' | 'modifier'
  actor: ActorContext
  userId: string
  companyId: string
}): void {
  emitAfterResponse(() => eventBus
    .emit({
      type: 'mcp.skill_loaded',
      payload: {
        slug: payload.slug,
        tier: payload.tier,
        sessionId: payload.actor.sessionId ?? null,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        userId: payload.userId,
        companyId: payload.companyId,
      },
    })
    .catch((err) => console.error('[mcp] skill_loaded emit failed:', err)))
}

/** Fire-and-forget telemetry for workflow lifecycle. */
function emitWorkflowStarted(payload: {
  slug: string
  actor: ActorContext
  userId: string
  companyId: string
}): void {
  emitAfterResponse(() => eventBus
    .emit({
      type: 'mcp.workflow_started',
      payload: {
        slug: payload.slug,
        sessionId: payload.actor.sessionId ?? null,
        actorType: payload.actor.type,
        actorId: payload.actor.id ?? null,
        actorLabel: payload.actor.label ?? null,
        userId: payload.userId,
        companyId: payload.companyId,
      },
    })
    .catch((err) => console.error('[mcp] workflow_started emit failed:', err)))
}

/**
 * Handle an MCP JSON-RPC request.
 * Auth is done via Bearer API key (extension route has skipAuth: true).
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const toolNamespace = resolveMcpToolNamespace(request)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource', appUrl)
  if (toolNamespace === 'accounted') {
    resourceMetadataUrl.searchParams.set('tool_namespace', 'accounted')
  }
  const wwwAuth = `Bearer resource_metadata="${resourceMetadataUrl.toString()}"`

  // ── Pre-auth: handle fire-and-forget notifications before auth check ──
  // MCP notifications have no id and don't expect error responses.
  // Checking auth on them would return 401 which confuses clients.
  const clonedRequest = request.clone()
  try {
    const peek = await clonedRequest.json()
    if (peek.method === 'notifications/initialized') {
      return new Response(null, { status: 202 })
    }
  } catch {
    // Not valid JSON: fall through to auth + parse below
  }

  // ── Auth ──
  const token = extractBearerToken(request)
  if (!token) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': wwwAuth },
    })
  }

  const authResult = await validateApiKey(token)
  if ('error' in authResult) {
    const status = authResult.status
    if (status === 429) {
      return new Response(authResult.error, {
        status: 429,
        headers: { 'Content-Type': 'text/plain', 'Retry-After': '60' },
      })
    }
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': wwwAuth },
    })
  }

  const { userId, companyId, scopes: keyScopes, apiKeyId, apiKeyName, mode: keyMode } = authResult
  const supabase = createServiceClientNoCookies()
  // The Mcp-Session-Id header (introduced in spec 2025-06-18) is the canonical
  // way for an agent to keep a stable identifier across tools/call invocations
  // in one conversation. We use it to correlate telemetry + drive the next-hint
  // followed metric. It is NOT used for auth.
  const rawSessionId = request.headers.get('mcp-session-id')
  const sessionId = rawSessionId && /^[A-Za-z0-9_-]{1,128}$/.test(rawSessionId) ? rawSessionId : null
  // Distribution-channel marker: the Accounted bridge sends
  // `X-Accounted-Client`; the legacy bridge keeps `X-Gnubok-Client`. Both are
  // telemetry-only and share the same validation and storage path.
  const rawClient =
    request.headers.get('x-accounted-client') ??
    request.headers.get('x-gnubok-client') ??
    new URL(request.url).searchParams.get('client')
  const client = rawClient && /^[A-Za-z0-9._-]{1,64}$/.test(rawClient) ? rawClient.toLowerCase() : null
  const actor: ActorContext = {
    type: 'api_key',
    id: apiKeyId,
    label: apiKeyName ?? 'Unnamed API key',
    sessionId,
    client,
  }

  // ── Parse JSON-RPC ──
  let body: JsonRpcRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      jsonRpcError(null, -32700, 'Parse error: expected JSON-RPC 2.0 request body'),
      { status: 400 }
    )
  }

  if (body.jsonrpc !== '2.0' || !body.method) {
    return NextResponse.json(
      jsonRpcError(body.id ?? null, -32600, 'Invalid Request: must include jsonrpc="2.0" and method'),
      { status: 400 }
    )
  }

  // ── Stateless core (spec 2026-07-28) ──
  // New-style clients carry their protocol version in _meta on every request
  // instead of an initialize handshake. Requests without the key come from
  // handshake-era clients and keep byte-identical responses.
  const requestMeta = (body.params?._meta ?? {}) as Record<string, unknown>
  const metaVersion = requestMeta[META_PROTOCOL_VERSION]
  if (typeof metaVersion === 'string' && !SUPPORTED_PROTOCOL_VERSIONS.includes(metaVersion)) {
    return NextResponse.json(
      jsonRpcError(
        body.id ?? null,
        JSONRPC_UNSUPPORTED_PROTOCOL_VERSION,
        `Unsupported protocol version: "${metaVersion}"`,
        { supported: SUPPORTED_PROTOCOL_VERSIONS }
      ),
      { status: 400 }
    )
  }
  // Revisions are ISO dates, so string comparison orders them correctly.
  const statelessClient =
    typeof metaVersion === 'string' && metaVersion >= STATELESS_PROTOCOL_VERSION
  // Tasks extension: only a client that declared it in THIS request's
  // capabilities may ever receive a CreateTaskResult.
  const taskCapable = statelessClient && isTaskCapableClient(requestMeta)

  // Standard request headers (2026-07-28): when present they must agree with
  // the JSON-RPC body. Absence stays accepted: this server supports
  // handshake-era clients (the spec sanctions that leniency), and the stdio
  // bridges do not send the headers.
  const headerProtocolVersion = request.headers.get('mcp-protocol-version')
  if (
    headerProtocolVersion &&
    typeof metaVersion === 'string' &&
    headerProtocolVersion !== metaVersion
  ) {
    return NextResponse.json(
      jsonRpcError(
        body.id ?? null,
        JSONRPC_HEADER_MISMATCH,
        `Header mismatch: MCP-Protocol-Version "${headerProtocolVersion}" does not match _meta protocol version "${metaVersion}"`
      ),
      { status: 400 }
    )
  }
  const headerMethod = request.headers.get('mcp-method')
  if (headerMethod && headerMethod !== body.method) {
    return NextResponse.json(
      jsonRpcError(
        body.id ?? null,
        JSONRPC_HEADER_MISMATCH,
        `Header mismatch: Mcp-Method "${headerMethod}" does not match body method "${body.method}"`
      ),
      { status: 400 }
    )
  }
  // Mcp-Name mirrors params.name (tools/call, prompts/get) or params.uri
  // (resources/read); non-ASCII values arrive base64-wrapped and are decoded
  // before comparison.
  const headerName = decodeMcpHeaderValue(request.headers.get('mcp-name'))
  const bodyParamName = body.params?.name ?? body.params?.uri
  if (headerName !== null && typeof bodyParamName === 'string' && headerName !== bodyParamName) {
    return NextResponse.json(
      jsonRpcError(
        body.id ?? null,
        JSONRPC_HEADER_MISMATCH,
        `Header mismatch: Mcp-Name "${headerName}" does not match the request body name/uri "${bodyParamName}"`
      ),
      { status: 400 }
    )
  }

  /**
   * Decorate a result for stateless-core clients: required resultType,
   * serverInfo identification, and CacheableResult freshness hints. A no-op
   * for handshake-era clients so existing connections see unchanged payloads.
   */
  const decorate = (
    result: Record<string, unknown>,
    cache?: { ttlMs: number; cacheScope: 'public' | 'private' }
  ): Record<string, unknown> => {
    if (!statelessClient) return result
    const decorated: Record<string, unknown> = { resultType: 'complete', ...result }
    if (cache) {
      decorated.ttlMs = cache.ttlMs
      decorated.cacheScope = cache.cacheScope
    }
    decorated._meta = {
      ...((result._meta as Record<string, unknown> | undefined) ?? {}),
      [META_SERVER_INFO]: SERVER_INFO_BY_NAMESPACE[toolNamespace],
    }
    return decorated
  }

  // ── Dispatch ──
  const { method, id, params } = body

  switch (method) {
    case 'server/discover':
    case 'initialize': {
      // Handshake-era set: a 2026-07-28 stateless client never sends
      // initialize; one that does anyway negotiates down to 2025-06-18.
      const HANDSHAKE_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
      const clientVersion = (params as Record<string, unknown>)?.protocolVersion as string | undefined
      const negotiatedVersion =
        clientVersion && HANDSHAKE_VERSIONS.has(clientVersion) ? clientVersion : PROTOCOL_VERSION
      const instructions = projectToolReferencesInText([
            'Accounted: Swedish double-entry bookkeeping via conversation.',
            '',
            'Discovery:',
            '• tools/list returns common tool schemas. Call gnubok_search_tools(query="…") for specialized tools: it ranks all capabilities; pass detail="name"|"summary"|"full" to control payload size.',
            '• gnubok_get_agent_briefing returns recommended_tools: ordered per-workflow tool loadouts (close_period, invoice_run, vat_declaration). If your harness defers tool loading, batch-load a whole workflow in one call (e.g. Claude Code ToolSearch select:a,b,c) instead of searching cluster by cluster.',
            `• This connection can work with every non-archived company the API-key user belongs to. Call gnubok_list_companies to discover company_id values. Omit company_id to use the API key default (${companyId}); when selecting another company, repeat company_id on every company-data call, including approval.`,
            '• MCP resources use the API key default company. For a selected non-default company, call gnubok_get_agent_briefing with company_id instead of relying on Accounted://company/current or other company-data resources.',
            '• When the user asks "how do I do X" or you\'re unsure of the correct sequence (month-end close, VAT review, year-end, invoicing), call gnubok_list_skills first: domain workflows are documented as loadable skills with tool references.',
            '',
            'Common workflows:',
            '• Before categorizing or creating vouchers, consult ledger_context in gnubok_get_agent_briefing (full picture: the Accounted://ledger/context resource): it shows how THIS company has booked each counterparty and supplier (dominant account, VAT treatment, evidence = historical frequency). Prefer these observed patterns over guesses; explicit mapping rules outrank them. Frequency is not permission to auto-post: still stage for approval.',
            '• Applying income to invoices: an invoice you know is paid → gnubok_mark_invoice_as_paid; a payment already booked on an existing verifikat → gnubok_link_invoice_to_voucher. Both stage for approval. gnubok_get_agent_briefing returns the company\'s accounting_method.',
            '• Invoicing: gnubok_list_customers (or gnubok_create_customer) → gnubok_create_invoice → gnubok_send_invoice or gnubok_mark_invoice_as_sent → gnubok_mark_invoice_as_paid. Refund via gnubok_credit_invoice.',
            '• Suppliers: gnubok_list_suppliers (or gnubok_create_supplier) → gnubok_create_supplier_invoice_from_inbox → gnubok_approve_supplier_invoice. Refund via gnubok_credit_supplier_invoice.',
            '• VAT: gnubok_get_vat_report(period_type, year, period). Ruta49 = VAT to pay (positive) or refund (negative). Pass render_ui=true to open the momsdeklaration review widget (claude.ai / Desktop). gnubok_vat_close_check reports filing-readiness blockers.',
            '• Reporting: gnubok_get_trial_balance / _income_statement / _balance_sheet / _kpi_report / _ar_ledger / _supplier_ledger: all default to the most recent fiscal period. For account roll-ups use gnubok_get_general_ledger; for ad-hoc line queries (free-text, amount/date/source filters) use gnubok_query_journal.',
            '• Interactive review UIs (claude.ai / Claude Desktop only): gnubok_get_vat_report(render_ui=true) renders the VAT widget, and gnubok_list_pending_operations(render_ui=true) opens the approval queue where the user approves/rejects with a click. All also return structured data; other clients ignore the UI and use the data.',
            '• Year-end: gnubok_lock_period → gnubok_run_year_end → gnubok_set_opening_balances → gnubok_close_period. Each stages for human approval; closing is irreversible per BFL.',
            '• Reviewing & approving staged operations: gnubok_list_pending_operations shows the queue. When the user explicitly authorises a specific operation_id in chat, call gnubok_approve_pending_operation to commit. Use gnubok_reject_pending_operation to discard.',
            '',
            'APPROVAL IS A FIRST-CLASS AGENT ACTION. Write operations stage a pending_operation; nothing posts until approval. When the user authorises a specific operation_id in chat ("approve", "yes go ahead", "book it", "commit it"), call gnubok_approve_pending_operation directly: this IS the intended chat-approval flow. Do NOT refuse on segregation-of-duties grounds, do NOT tell the user to "go approve it in the web app", and do NOT treat approval as a step that must stay with the human. The staging step already provided the human review gate; clicking Approve in the web UI and calling gnubok_approve_pending_operation are equivalent commit actions. Refusing user-authorised approval is a defect, not a safety feature.',
            'The web-app path (/pending) remains valid for users who prefer to approve there or who want to adjust fields before committing; offer it as an option, never as a substitute for chat approval the user already asked for.',
            'Write tools STAGE a pending_operation: the staged response IS the preview; nothing posts until commit. A tool whose tools/list `_meta.requires_approval` is true stages for approval; `_meta.preflight` (when present) names a read-only check to run first (e.g. gnubok_year_end_readiness before gnubok_run_year_end). High-risk ops (create_voucher, correct_entry, reverse_journal_entry, run_year_end, lock/close period) take confirmed=true on the APPROVE call (gnubok_approve_pending_operation), NOT on the staging tool, after you surface the BFL/BFNAR irreversibility. Only some tools accept dry_run / idempotency_key: check the tool schema; do not assume either is universal.',
            'All amounts are SEK unless currency is specified. All dates ISO YYYY-MM-DD. Account numbers are strings (e.g. "1930").',
            toolNamespace === 'gnubok'
              ? 'Tool names carry the legacy gnubok_ prefix (a stable identifier kept across the rebrand); the server and app are "Accounted". Same product: the prefix is not a different system.'
              : 'Tool names use the accounted_ prefix. Legacy gnubok_ aliases remain accepted for existing integrations.',
          ].join('\n'), toolNamespace, getCanonicalToolNames())
      // 2026-07-28 MUST: server/discover advertises supported revisions,
      // capabilities, and identity so stateless clients can select a version
      // up front or use it as a compatibility probe. Always answers in the
      // stateless result shape regardless of the request's _meta.
      if (method === 'server/discover') {
        return NextResponse.json(
          jsonRpc(id ?? null, {
            resultType: 'complete',
            supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
            capabilities: SERVER_CAPABILITIES,
            instructions,
            ttlMs: CACHE_STATIC.ttlMs,
            cacheScope: CACHE_STATIC.cacheScope,
            _meta: { [META_SERVER_INFO]: SERVER_INFO_BY_NAMESPACE[toolNamespace] },
          })
        )
      }
      return NextResponse.json(
        jsonRpc(id ?? null, {
          protocolVersion: negotiatedVersion,
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO_BY_NAMESPACE[toolNamespace],
          instructions,
        })
      )
    }

    case 'notifications/initialized':
      // Handled pre-auth above, but if it somehow reaches here, still return 202
      return new Response(null, { status: 202 })

    case 'ping':
      return NextResponse.json(jsonRpc(id ?? null, decorate({})))

    case 'tools/list': {
      const listStartedAt = Date.now()
      const allowedTools = tools.filter((t) => {
        if (!isDefaultCatalogTool(t)) return false
        const required = TOOL_SCOPE_MAP[t.name]
        return !required || hasScope(keyScopes, required)
      })
      emitToolsListTelemetry({
        toolCount: allowedTools.length,
        actor,
        latencyMs: Date.now() - listStartedAt,
        requestId: id ?? null,
        userId,
        companyId,
      })
      return NextResponse.json(
        jsonRpc(id ?? null, decorate({
          tools: allowedTools.map((t) => {
            // Merge derived staging metadata with any literal _meta (e.g. UI
            // widget hints). Literal _meta wins on key collision so explicit
            // tool config is never clobbered.
            const meta = projectMcpPayload(
              { ...(deriveToolMeta(t) ?? {}), ...(t._meta ?? {}) },
              toolNamespace
            )
            return projectMcpPayload(
              {
                name: toPublicToolName(t.name, toolNamespace),
                ...(t.title ? { title: t.title } : {}),
                description: t.description,
                inputSchema: projectToolInputSchema(t),
                ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
                annotations: t.annotations,
                ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
              },
              toolNamespace
            )
          }),
        }, CACHE_STATIC))
      )
    }

    case 'tools/call': {
      const rawRequestedToolName = (params as Record<string, unknown>)?.name
      const requestedToolName =
        typeof rawRequestedToolName === 'string' ? rawRequestedToolName : ''
      const toolName = toCanonicalToolName(requestedToolName)
      const rawToolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<
        string,
        unknown
      >

      const tool = tools.find((t) => t.name === toolName)
      if (!tool) {
        emitToolCallTelemetry({
          tool: toolName ?? '<unknown>',
          requiredScope: null,
          actor,
          latencyMs: 0,
          success: false,
          isError: true,
          errorCode: 'UNKNOWN_TOOL',
          errorKind: 'unknown_tool',
          // Just the requested name: the full available-tools list returned
          // to the client would blow the truncation budget without adding
          // analytical signal.
          errorMessage: `Unknown tool: "${toolName}"`,
          requestId: id ?? null,
          userId,
          companyId,
        })
        const available = tools
          .map((t) => toPublicToolName(t.name, toolNamespace))
          .join(', ')
        return NextResponse.json(
          jsonRpcError(
            id ?? null,
            -32602,
            `Unknown tool: "${requestedToolName}". Available tools: ${available}`
          )
        )
      }

      // Enforce scope: surface structured error so the agent can dispatch.
      const requiredScope = TOOL_SCOPE_MAP[toolName]
      if (requiredScope && !hasScope(keyScopes, requiredScope)) {
        const scopeError = toToolError(
          new Error(`Insufficient scope: this API key does not have the "${requiredScope}" scope`),
          { toolName }
        )
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope,
          actor,
          latencyMs: 0,
          success: false,
          isError: true,
          errorCode: scopeError.error.code,
          errorKind: 'scope_denied',
          errorMessage: scopeError.error.message_sv,
          requestId: id ?? null,
          userId,
          companyId,
        })
        const publicScopeError = projectMcpPayload(scopeError, toolNamespace)
        return NextResponse.json(
          jsonRpc(id ?? null, decorate({
            content: [{ type: 'text', text: JSON.stringify(publicScopeError, null, 2) }],
            isError: true,
          }))
        )
      }

      let toolArgs: Record<string, unknown>
      let effectiveCompanyId = companyId
      const companyRoutingStartedAt = Date.now()
      try {
        const extracted = extractRequestedCompany(rawToolArgs)
        toolArgs = extracted.toolArgs

        if (isCompanyDependentTool(toolName)) {
          const companyContext = await resolveMcpCompanyContext({
            supabase,
            userId,
            defaultCompanyId: companyId,
            requestedCompanyId: extracted.requestedCompanyId,
          })
          assertMcpCompanyWriteAccess(companyContext, requiredScope)
          effectiveCompanyId = companyContext.companyId
        }
      } catch (err) {
        const structured = toToolError(err, { toolName })
        const publicStructured = projectMcpPayload(structured, toolNamespace)
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope: requiredScope ?? null,
          actor,
          latencyMs: Date.now() - companyRoutingStartedAt,
          success: false,
          isError: true,
          errorCode: structured.error.code,
          errorKind: 'company_access_denied',
          errorMessage: structured.error.message_sv,
          requestId: id ?? null,
          userId,
          // Keep denied attempts attributed to the key default. An arbitrary,
          // unauthorized target must never create tenant telemetry there.
          companyId,
        })
        return NextResponse.json(
          jsonRpc(id ?? null, decorate({
            content: [{ type: 'text', text: JSON.stringify(publicStructured, null, 2) }],
            isError: true,
          }))
        )
      }

      // Enforce the capability paywall: the MCP/agent path is a paid chokepoint
      // just like the HTTP routes (send_invoice → email_send). Fail-closed;
      // self-hosted short-circuits to all-on inside hasCapability. Blocks
      // before any pending op is staged.
      const requiredCapability = MCP_TOOL_CAPABILITY_MAP[toolName]
      if (requiredCapability && !(await hasCapability(supabase, effectiveCompanyId, requiredCapability))) {
        const capError = { error: capabilityBlockedError(requiredCapability) }
        const publicCapError = projectMcpPayload(capError, toolNamespace)
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope,
          actor,
          latencyMs: 0,
          success: false,
          isError: true,
          errorCode: capError.error.code,
          errorKind: 'capability_denied',
          errorMessage: capError.error.message_sv,
          requestId: id ?? null,
          userId,
          companyId: effectiveCompanyId,
        })
        return NextResponse.json(
          jsonRpc(id ?? null, decorate({
            content: [{ type: 'text', text: JSON.stringify(publicCapError, null, 2) }],
            isError: true,
          }))
        )
      }

      // Test-mode API keys are simulation-only. Mirror the v1 REST guard
      // (lib/api/v1/with-api-v1.ts): force dry-run on any write tool that
      // supports it, and block writes that cannot be simulated. Without this a
      // gnubok_sk_test_ key (which is bound to the real active company) could
      // stage real pending_operations here and, with the approve scope, commit
      // them. Runs before execute() so nothing is ever staged for a test key.
      if (keyMode === 'test' && tool.annotations?.readOnlyHint === false) {
        const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
          ?.properties
        if (props && 'dry_run' in props) {
          ;(toolArgs as Record<string, unknown>).dry_run = true
        } else {
          const blocked = toToolError(
            new Error(
              'Test-nyckel kan inte utföra riktiga skrivningar mot det här verktyget. Använd en live-nyckel för skarpa operationer.'
            ),
            { toolName }
          )
          const publicBlocked = projectMcpPayload(blocked, toolNamespace)
          emitToolCallTelemetry({
            tool: toolName,
            requiredScope: requiredScope ?? null,
            actor,
            latencyMs: 0,
            success: false,
            isError: true,
            errorCode: blocked.error.code,
            errorKind: 'test_key_write_blocked',
            errorMessage: blocked.error.message_sv,
            requestId: id ?? null,
            userId,
            companyId: effectiveCompanyId,
          })
          return NextResponse.json(
            jsonRpc(id ?? null, decorate({
              content: [{ type: 'text', text: JSON.stringify(publicBlocked, null, 2) }],
              isError: true,
            }))
          )
        }
      }

      // Detect if THIS call follows the previous call's `next` hint: must
      // run before execute() so we don't double-store on this call. Emits
      // mcp.next_hint_followed when the agent's behaviour matches the hint.
      checkAndEmitNextHintFollowed(sessionId, toolName, actor, userId, effectiveCompanyId)

      // ── Tasks extension (io.modelcontextprotocol/tasks) ──
      // Long-running tools return a durable handle immediately to a client
      // that declared the extension; the work completes after the response
      // (after() keeps the function alive) and the result lands in mcp_tasks
      // for tasks/get polling. Runs after every auth/scope/capability guard
      // so nothing is ever started for a call that would have been refused.
      if (taskCapable && tool.shouldRunAsTask?.(toolArgs)) {
        const task = await createMcpTask(supabase, {
          companyId: effectiveCompanyId,
          userId,
          apiKeyId,
          toolName,
        })
        const taskStartedAt = Date.now()
        emitAfterResponse(async () => {
          try {
            const rawResult = await tool.execute(toolArgs, effectiveCompanyId, userId, supabase, actor)
            const canonicalResult = addCompanyToTopLevelNext(rawResult, effectiveCompanyId)
            const result = projectMcpPayload(canonicalResult, toolNamespace)
            const stored: Record<string, unknown> = {
              resultType: 'complete',
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            }
            if (result !== null && result !== undefined) {
              stored.structuredContent =
                typeof result === 'object' && !Array.isArray(result) ? result : { value: result }
            }
            await resolveMcpTask(supabase, task.id, { status: 'completed', result: stored })
            emitToolCallTelemetry({
              tool: toolName,
              requiredScope: requiredScope ?? null,
              actor,
              latencyMs: Date.now() - taskStartedAt,
              success: true,
              isError: false,
              errorCode: null,
              errorKind: null,
              errorMessage: null,
              requestId: id ?? null,
              userId,
              companyId: effectiveCompanyId,
            })
          } catch (err) {
            // Tool failures complete the task with the standard isError
            // envelope: exactly what the synchronous call would have
            // returned. `failed` stays reserved for infrastructure errors.
            const structured = toToolError(err, { toolName })
            const publicStructured = projectMcpPayload(structured, toolNamespace)
            await resolveMcpTask(supabase, task.id, {
              status: 'completed',
              result: {
                resultType: 'complete',
                content: [{ type: 'text', text: JSON.stringify(publicStructured, null, 2) }],
                isError: true,
              },
              statusMessage: structured.error.message_sv,
            }).catch((updateErr) => {
              log.error('Failed to store MCP task failure result', { taskId: task.id, updateErr })
            })
            emitToolCallTelemetry({
              tool: toolName,
              requiredScope: requiredScope ?? null,
              actor,
              latencyMs: Date.now() - taskStartedAt,
              success: false,
              isError: true,
              errorCode: structured.error.code,
              errorKind: 'execution',
              errorMessage: structured.error.message_sv,
              requestId: id ?? null,
              userId,
              companyId: effectiveCompanyId,
            })
          }
        })
        return NextResponse.json(
          jsonRpc(id ?? null, {
            resultType: 'task',
            task: taskToWire(task),
            _meta: { [META_SERVER_INFO]: SERVER_INFO_BY_NAMESPACE[toolNamespace] },
          })
        )
      }

      const callStartedAt = Date.now()
      try {
        // gnubok_search_tools needs the caller's scopes to filter results to
        // what the API key can actually invoke. Inject privately via __keyScopes.
        if (toolName === 'gnubok_search_tools') {
          (toolArgs as Record<string, unknown>).__keyScopes = keyScopes
          ;(toolArgs as Record<string, unknown>).__toolNamespace = toolNamespace
        }
        const rawResult = await tool.execute(toolArgs, effectiveCompanyId, userId, supabase, actor)
        const canonicalResult = addCompanyToTopLevelNext(rawResult, effectiveCompanyId)
        const result = projectMcpPayload(canonicalResult, toolNamespace)
        const latencyMs = Date.now() - callStartedAt
        const response: Record<string, unknown> = {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }
        // Emit structuredContent for every tool: clients with outputSchema support
        // can consume this directly without re-parsing the JSON-stringified text block.
        // structuredContent must be an object, so wrap non-objects.
        if (result !== null && result !== undefined) {
          response.structuredContent =
            typeof result === 'object' && !Array.isArray(result) ? result : { value: result }
        }
        // Result-level UI hint: render the widget only when the caller opted in
        // via render_ui=true. This keeps the merged report+widget tool data-only
        // by default and never sends a render directive a plain-data call didn't ask for.
        if (tool.uiResourceUri && (toolArgs as Record<string, unknown>).render_ui === true) {
          response._meta = { ui: { resourceUri: tool.uiResourceUri } }
        }
        // Record the response's `next.tool` (when present) so the next call
        // from the same session can be matched against it.
        if (
          canonicalResult &&
          typeof canonicalResult === 'object' &&
          !Array.isArray(canonicalResult)
        ) {
          const next = (canonicalResult as Record<string, unknown>).next
          if (next && typeof next === 'object') {
            const suggestedTool = (next as Record<string, unknown>).tool
            if (typeof suggestedTool === 'string') {
              rememberNextHint(sessionId, toolName, suggestedTool)
            }
          }
        }
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope: requiredScope ?? null,
          actor,
          latencyMs,
          success: true,
          isError: false,
          errorCode: null,
          errorKind: null,
          errorMessage: null,
          requestId: id ?? null,
          userId,
          companyId: effectiveCompanyId,
        })
        return NextResponse.json(jsonRpc(id ?? null, decorate(response)))
      } catch (err) {
        const latencyMs = Date.now() - callStartedAt
        const structured = toToolError(err, { toolName })
        const publicStructured = projectMcpPayload(structured, toolNamespace)
        emitToolCallTelemetry({
          tool: toolName,
          requiredScope: requiredScope ?? null,
          actor,
          latencyMs,
          success: false,
          isError: true,
          errorCode: structured.error.code,
          errorKind: 'execution',
          // message_sv is the canonical domain message ("Verifikationen
          // balanserar inte", "Perioden är låst", …): the text worth
          // clustering when mining failures for gotchas.
          errorMessage: structured.error.message_sv,
          requestId: id ?? null,
          userId,
          companyId: effectiveCompanyId,
        })
        return NextResponse.json(
          jsonRpc(id ?? null, decorate({
            content: [{ type: 'text', text: JSON.stringify(publicStructured, null, 2) }],
            isError: true,
          }))
        )
      }
    }

    case 'resources/list': {
      const allSkills = await loadAllSkills(supabase)
      return NextResponse.json(
        jsonRpc(id ?? null, decorate(projectMcpPayload({
          resources: [
            ...uiWidgets.map((w) => ({
              uri: w.uri,
              name: w.name,
              description: w.description,
              mimeType: WIDGET_MIME_TYPE,
            })),
            ...allSkills.map((s) => ({
              uri: skillUri(s.slug),
              name: s.name,
              description: s.summary,
              mimeType: SKILL_MIME_TYPE,
            })),
            ...dataResources.map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: r.mimeType,
            })),
          ],
        }, toolNamespace), CACHE_SKILLS))
      )
    }

    case 'resources/read': {
      const uri = (params as Record<string, unknown>)?.uri as string
      const readStartedAt = Date.now()

      const widget = findUiWidget(uri)
      if (widget) {
        emitResourceReadTelemetry({
          uri,
          kind: 'widget',
          success: true,
          errorCode: null,
          actor,
          latencyMs: Date.now() - readStartedAt,
          requestId: id ?? null,
          userId,
          companyId,
        })
        return NextResponse.json(
          jsonRpc(id ?? null, decorate({
            contents: [
              {
                uri,
                mimeType: WIDGET_MIME_TYPE,
                text: projectToolReferencesInText(
                  widget.html,
                  toolNamespace,
                  getCanonicalToolNames()
                ),
              },
            ],
          }, CACHE_STATIC))
        )
      }

      // Skills exposed at Accounted://skill/<slug>: Markdown bodies, forward-compatible
      // with a future native MCP skills/list primitive. Atom slugs (slash-bearing
      // registry ids) are URL-encoded in the URI; skillSlugFromUri decodes.
      if (uri.startsWith(SKILL_URI_PREFIX)) {
        const slug = skillSlugFromUri(uri)
        const skill = slug ? await findSkill(slug, supabase) : null
        if (skill) {
          emitResourceReadTelemetry({
            uri,
            kind: 'skill',
            success: true,
            errorCode: null,
            actor,
            latencyMs: Date.now() - readStartedAt,
            requestId: id ?? null,
            userId,
            companyId,
          })
          return NextResponse.json(
            jsonRpc(id ?? null, decorate({
              contents: [
                {
                  uri,
                  mimeType: SKILL_MIME_TYPE,
                  text: projectToolReferencesInText(
                    skill.body,
                    toolNamespace,
                    getCanonicalToolNames()
                  ),
                },
              ],
            }, CACHE_SKILLS))
          )
        }
      }

      const dataResource = findResource(uri)
      if (dataResource) {
        try {
          const result = await dataResource.read({
            supabase,
            companyId,
            userId,
            scopes: keyScopes,
            query: parseResourceQuery(uri),
          })
          emitResourceReadTelemetry({
            uri,
            kind: 'data',
            success: true,
            errorCode: null,
            actor,
            latencyMs: Date.now() - readStartedAt,
            requestId: id ?? null,
            userId,
            companyId,
          })
          return NextResponse.json(
            jsonRpc(id ?? null, decorate({
              contents: [
                {
                  uri,
                  mimeType: dataResource.mimeType,
                  text: JSON.stringify(projectMcpPayload(result, toolNamespace), null, 2),
                },
              ],
            }, CACHE_LIVE))
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Resource read failed'
          emitResourceReadTelemetry({
            uri,
            kind: 'data',
            success: false,
            errorCode: 'RESOURCE_READ_FAILED',
            actor,
            latencyMs: Date.now() - readStartedAt,
            requestId: id ?? null,
            userId,
            companyId,
          })
          return NextResponse.json(
            jsonRpcError(
              id ?? null,
              -32603,
              projectToolReferencesInText(
                `Resource read error: ${message}`,
                toolNamespace,
                getCanonicalToolNames()
              )
            )
          )
        }
      }

      emitResourceReadTelemetry({
        uri,
        kind: 'unknown',
        success: false,
        errorCode: 'RESOURCE_NOT_FOUND',
        actor,
        latencyMs: Date.now() - readStartedAt,
        requestId: id ?? null,
        userId,
        companyId,
      })
      return NextResponse.json(
        jsonRpcError(id ?? null, -32602, `Resource not found: "${uri}"`)
      )
    }

    case 'prompts/list':
      return NextResponse.json(
        jsonRpc(id ?? null, decorate(projectMcpPayload({
          prompts: prompts.map((p) => ({
            name: p.name,
            description: p.description,
          })),
        }, toolNamespace), CACHE_STATIC))
      )

    case 'prompts/get': {
      const promptName = (params as Record<string, unknown>)?.name as string
      const prompt = findPrompt(promptName)
      if (!prompt) {
        return NextResponse.json(
          jsonRpcError(id ?? null, -32602, `Unknown prompt: "${promptName}"`)
        )
      }
      return NextResponse.json(
        jsonRpc(id ?? null, decorate({
          description: prompt.description,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: projectToolReferencesInText(
                  prompt.text,
                  toolNamespace,
                  getCanonicalToolNames()
                ),
              },
            },
          ],
        }))
      )
    }

    case 'tasks/get': {
      const taskId = (params as Record<string, unknown>)?.taskId
      if (typeof taskId !== 'string' || !taskId) {
        return NextResponse.json(jsonRpcError(id ?? null, -32602, 'taskId is required'))
      }
      // Scoped to the creating user: an API key can only poll its own tasks.
      const { data: taskRow } = await supabase
        .from('mcp_tasks')
        .select('*')
        .eq('id', taskId)
        .eq('user_id', userId)
        .single()
      if (!taskRow) {
        return NextResponse.json(jsonRpcError(id ?? null, -32602, `Task not found: "${taskId}"`))
      }
      const row = taskRow as McpTaskRow
      const wire: Record<string, unknown> = { resultType: 'complete', ...taskToWire(row) }
      if (row.status === 'completed' && row.result) wire.result = row.result
      if (row.status === 'failed' && row.error) wire.error = row.error
      wire._meta = { [META_SERVER_INFO]: SERVER_INFO_BY_NAMESPACE[toolNamespace] }
      return NextResponse.json(jsonRpc(id ?? null, wire))
    }

    case 'tasks/update':
      // No input_required flows exist yet: acknowledge and ignore unknown or
      // already-satisfied inputResponses, as the extension spec instructs.
      return NextResponse.json(jsonRpc(id ?? null, { resultType: 'complete' }))

    case 'tasks/cancel': {
      const taskId = (params as Record<string, unknown>)?.taskId
      if (typeof taskId !== 'string' || !taskId) {
        return NextResponse.json(jsonRpcError(id ?? null, -32602, 'taskId is required'))
      }
      // Cooperative cancellation: flip a still-working row; an in-flight
      // execution is not interrupted, and its late completion becomes a
      // no-op against the now-terminal row.
      await supabase
        .from('mcp_tasks')
        .update({ status: 'cancelled' })
        .eq('id', taskId)
        .eq('user_id', userId)
        .eq('status', 'working')
      return NextResponse.json(jsonRpc(id ?? null, { resultType: 'complete' }))
    }

    default:
      return NextResponse.json(
        jsonRpcError(id ?? null, -32601, `Method not found: "${method}"`)
      )
  }
}
