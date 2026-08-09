import { z } from 'zod'
import { normaliseSwish, isValidSwish } from '@/lib/payments/swish'
import { normalizeVatNumber } from '@/lib/vat/vat-number'
import {
  accountNumberSchema,
  isoDateSchema,
  saneIsoDateSchema,
} from '@/lib/invariants/zod'
import { ISO_DATE_RE, ISO_DATE_MESSAGE_SV } from '@/lib/invariants/iso-date'
import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import { DimensionsBagSchema } from '@/lib/bookkeeping/dimension-resolver'
import { MAX_INVOICE_EMAIL_COPY_RECIPIENTS } from '@/lib/invoices/email-recipients'
import { INVOICE_POSTING_ACCOUNT_REGEX } from '@/lib/invoices/posting-account'
import { PERSONAL_NUMBER_INPUT_RE } from '@/lib/customers/mask-personal-number'
import type { AuditAction } from '@/types'

// ============================================================
// Shared primitives
// ============================================================

/** UUID v4 string */
const uuid = z.string().uuid()

/**
 * ISO date string (YYYY-MM-DD).
 *
 * Shape only. From `lib/invariants/iso-date.ts` so that every schema below, the
 * v1 routes, and the MCP surface reject a malformed date the same way.
 */
const isoDate = isoDateSchema

/**
 * ISO date that must also be a real, in-range calendar date: not just the
 * right shape. Backed by the shared `isSaneDateString` rule (also used by the
 * transaction form) so a 6-digit year or impossible date can't slip through
 * for user-entered dates. Use this over `isoDate` for free-text date input.
 */
const saneIsoDate = saneIsoDateSchema

/** BAS account number: always a string of 4 digits */
const accountNumber = accountNumberSchema

/** Non-negative monetary amount (>= 0) */
const nonNegativeAmount = z.number().nonnegative()

/**
 * SEK per one unit of a foreign currency.
 *
 * Mirrors the database CHECK that every table storing a rate carries:
 * `invoices_exchange_rate_check`, `supplier_invoices_exchange_rate_check`,
 * `invoice_payments_payment_exchange_rate_check` and
 * `supplier_invoice_payments_payment_exchange_rate_check` all read
 * `rate IS NULL OR (rate > 0 AND rate < 100000)`. BOTH bounds are exclusive,
 * so this mirror is `.positive()` + `.lt(100000)`; `.max(100000)` would let
 * exactly 100000 through the schema and straight into a 23514 violation.
 *
 * Without the mirror a plausible fat-fingered rate (250000, a pasted total
 * instead of a rate) passed validation, hit the constraint in Postgres, and
 * surfaced as an unexplained 500. Through this primitive it lands in
 * `validateBody`'s 400 with a message naming the field and the fix.
 *
 * The ceiling is a typo guard rather than a precise band: no currency the app
 * supports comes near it (USD ~10.5, EUR ~11.5, GBP ~13.5).
 */
const exchangeRate = z
  .number()
  .positive('Växelkursen måste vara större än 0')
  .lt(
    100000,
    'Växelkursen måste vara mindre än 100 000. Ange kursen per 1 enhet av valutan, till exempel 11,45 för EUR, inte fakturans belopp.',
  )

const invoiceEmailAddress = z
  .string()
  .trim()
  .email('Ange en giltig e-postadress')
  .max(254, 'E-postadressen får vara max 254 tecken')

const invoiceEmailAddressList = z
  .array(invoiceEmailAddress)
  .max(
    MAX_INVOICE_EMAIL_COPY_RECIPIENTS,
    `Högst ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} kopiemottagare är tillåtna`,
  )

/** Invoice-line posting account: an asset, liability/equity, or revenue account. */
const invoicePostingAccount = z
  .string()
  .regex(INVOICE_POSTING_ACCOUNT_REGEX, 'Posting account must be a 4-digit BAS class 1-3 account')

/** Swedish VAT rate as an integer percent. */
const vatRatePercent = z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])

/**
 * Swedish VAT rate as a decimal fraction: the supplier-invoice convention.
 * supplier_invoice_items stores 0.25 for 25 % (DB default 0.25) while
 * invoice_items stores integer percent (vatRatePercent above); issue #310.
 * Only statutory rates pass; percent-shaped input (25) is rejected with a
 * unit hint instead of silently booking 2500 % VAT.
 */
const vatRateDecimal = z.union(
  [z.literal(0), z.literal(0.06), z.literal(0.12), z.literal(0.25)],
  { error: 'vat_rate is a decimal fraction: 0, 0.06, 0.12 or 0.25 (not percent)' },
)

/** Time string (HH:MM or HH:MM:SS) */
const timeString = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Expected HH:MM or HH:MM:SS time format')

/** Periodisering: interim accounts. Förutbetalda kostnader live on 17xx. */
const prepaidExpenseAccount = z
  .string()
  .regex(/^17\d{2}$/, 'Balanskonto för periodiserad kostnad måste vara ett 17xx-konto')

/** Periodisering: förutbetalda intäkter live on 29xx. */
const deferredRevenueAccount = z
  .string()
  .regex(/^29\d{2}$/, 'Balanskonto för periodiserad intäkt måste vara ett 29xx-konto')

/**
 * Shared periodisering period rules for invoice line items: both dates or
 * neither, end after start, and a 2-120 calendar month span. The amount-side
 * rules differ per item shape and stay in each schema's superRefine.
 */
function validateAccrualPeriod(
  item: { accrual_period_start?: string | null; accrual_period_end?: string | null },
  ctx: z.RefinementCtx,
): void {
  const start = item.accrual_period_start
  const end = item.accrual_period_end
  if (!start && !end) return
  if (!start || !end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_start'],
      message: 'Ange både periodens start och slut för periodisering',
    })
    return
  }
  if (end < start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_end'],
      message: 'Periodens slut måste vara efter dess start',
    })
    return
  }
  const months = countCalendarMonths(start, end)
  if (months < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_end'],
      message: 'Periodisering kräver minst 2 kalendermånader',
    })
  }
  if (months > 120) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['accrual_period_end'],
      message: 'Periodisering kan omfatta högst 120 månader',
    })
  }
}

// ============================================================
// Enum schemas (matching types/index.ts)
// ============================================================

export const EntityTypeSchema = z.enum(['enskild_firma', 'aktiebolag'])

export const AccountingFrameworkSchema = z.enum(['k2', 'k3'])

/**
 * Single K3 component (BFNAR 2012:1 ch.17.4, komponentavskrivning).
 *
 * Used inside AssetCreateSchema / AssetUpdateSchema's `k3_components` array.
 * The cross-component invariant (sum of `cost` equals asset `acquisition_cost`)
 * lives in `validateComponents` from `lib/bokslut/assets/k3-components.ts`
 * and is called by the route-layer refinement: it cannot be expressed in
 * a single-object schema. Component-level checks (cost > 0, salvage ≤ cost,
 * positive useful life) are reinforced by `validateComponents` too so any
 * future caller that uses just the validator gets the same guarantees.
 *
 * `salvage_value` is optional; the engine treats omission as 0.
 */
export const K3ComponentSchema = z.object({
  name: z.string().min(1, 'Komponentens namn krävs.'),
  cost: z.number().positive('Anskaffningsvärdet måste vara större än 0.'),
  useful_life_months: z.number().int().positive('Nyttjandeperioden måste vara ett positivt heltal månader.'),
  salvage_value: z.number().nonnegative().optional(),
})

export const CustomerTypeSchema = z.enum([
  'individual',
  'swedish_business',
  'eu_business',
  'non_eu_business',
])

export const SupplierTypeSchema = z.enum([
  'swedish_business',
  'eu_business',
  'non_eu_business',
])

export const InvoiceDocumentTypeSchema = z.enum([
  'invoice', 'proforma', 'delivery_note',
])

export const VatTreatmentSchema = z.enum([
  'standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt',
])

export const AccountingMethodSchema = z.enum(['accrual', 'cash'])

export const CurrencySchema = z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'])

export const TransactionCategorySchema = z.enum([
  'income_services',
  'income_products',
  'income_other',
  'expense_equipment',
  'expense_software',
  'expense_travel',
  'expense_office',
  'expense_marketing',
  'expense_professional_services',
  'expense_education',
  'expense_representation',
  'expense_consumables',
  'expense_vehicle',
  'expense_telecom',
  'expense_bank_fees',
  'expense_card_fees',
  'expense_currency_exchange',
  'expense_other',
  'private',
  'uncategorized',
])

export const JournalEntrySourceTypeSchema = z.enum([
  'manual',
  'bank_transaction',
  'invoice_created',
  'invoice_paid',
  'invoice_cash_payment',
  'credit_note',
  'salary_payment',
  'opening_balance',
  'year_end',
  'storno',
  'correction',
  'import',
  'system',
  'inbox_item',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'supplier_invoice_privately_paid',
  'supplier_credit_note',
  'currency_revaluation',
  'reminder_fee',
  'accrual',
  'result_appropriation',
  'rot_rut_payout',
  'vat_settlement',
  'stripe_payout',
])

/** Query params for GET /api/bookkeeping/voucher-sequences/next. */
export const VoucherSequenceNextQuerySchema = z.object({
  period_id: uuid.optional(),
  series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  source_type: JournalEntrySourceTypeSchema.optional(),
  date: isoDate.optional(),
})

export const AccountTypeSchema = z.enum([
  'asset', 'equity', 'liability', 'revenue', 'expense',
])

export const NormalBalanceSchema = z.enum(['debit', 'credit'])

export const MappingRuleTypeSchema = z.enum([
  'mcc_code', 'merchant_name', 'description_pattern', 'amount_threshold', 'combined',
])

export const RiskLevelSchema = z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'])

export const DeadlineTypeSchema = z.enum([
  'delivery', 'invoicing', 'report', 'tax', 'other',
])

export const DeadlinePrioritySchema = z.enum(['critical', 'important', 'normal'])

export const TaxDeadlineTypeSchema = z.enum([
  'moms_monthly',
  'moms_quarterly',
  'moms_yearly',
  'f_skatt',
  'arbetsgivardeklaration',
  'skatteinbetalning',
  'inkomstdeklaration_ef',
  'inkomstdeklaration_ab',
  'arsredovisning',
  'arsstamma',
  'periodisk_sammanstallning',
  'kvarskatt',
])

export const TaxAssessmentDecisionTypeSchema = z.enum(['final', 'reassessment'])

export const CreateTaxAssessmentNoticeSchema = z
  .object({
    fiscal_period_id: uuid,
    decision_type: TaxAssessmentDecisionTypeSchema,
    decision_date: saneIsoDate,
    payment_due_date: saneIsoDate,
  })
  .refine((data) => data.payment_due_date >= data.decision_date, {
    message: 'Förfallodagen får inte vara tidigare än beslutsdagen',
    path: ['payment_due_date'],
  })

export const UpdateTaxAssessmentNoticeSchema = z
  .object({
    fiscal_period_id: uuid.optional(),
    decision_type: TaxAssessmentDecisionTypeSchema.optional(),
    decision_date: saneIsoDate.optional(),
    payment_due_date: saneIsoDate.optional(),
    archived: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Minst ett fält måste anges',
  })
  .refine(
    (data) => !data.decision_date || !data.payment_due_date || data.payment_due_date >= data.decision_date,
    {
      message: 'Förfallodagen får inte vara tidigare än beslutsdagen',
      path: ['payment_due_date'],
    },
  )

export const UpdateInitialSetupStateSchema = z
  .object({
    path: z.enum(['migration', 'bank', 'fresh']).nullable().optional(),
    completed: z.boolean().optional(),
    dismissed: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Minst ett fält måste anges',
  })

export const DeadlineSourceSchema = z.enum(['system', 'user'])

export const MomsPeriodSchema = z.enum(['monthly', 'quarterly', 'yearly'])

export const PsPeriodTypeSchema = z.enum(['monthly', 'quarterly'])
export const TaxFilingMethodSchema = z.enum(['electronic', 'paper'])

export const DocumentUploadSourceSchema = z.enum([
  'camera', 'file_upload', 'email', 'e_invoice', 'scan', 'api', 'system',
])

// ============================================================
// Invoice schemas
// ============================================================

export const CreateInvoiceItemSchema = z
  .object({
    // 'text' = free-text or blank spacer row: description only, amounts ignored
    // and excluded from totals/bookkeeping. Defaults to 'product'. Callers still
    // send quantity/unit/unit_price for text rows (the form sends 0/''/0), so
    // the inferred shape stays consistent for downstream code.
    line_type: z.enum(['product', 'text']).optional(),
    description: z.string().max(2000),
    quantity: z.number(),
    unit: z.string(),
    unit_price: z.number(),
    vat_rate: z.number().min(0).max(100).optional(),
    // Article linkage. `article_id` ties the line to a catalog article (text
    // rows omit it). `revenue_account` is the legacy wire name for the optional
    // BAS class 1-3 posting-account override the engine books to; the API
    // validates it against chart_of_accounts before use, and class 1-2
    // accounts are only accepted on zero-VAT lines (build-invoice-write.ts).
    article_id: uuid.nullable().optional(),
    revenue_account: invoicePostingAccount.nullable().optional(),
    // ROT/RUT-avdrag fields. `deduction_amount` is intentionally omitted from
    // the client schema: the API computes it from rot-rut-rules.ts so a
    // tampered client can't expand the 1513 receivable beyond the line total.
    deduction_type: z.enum(['rot', 'rut']).nullable().optional(),
    labor_hours: z.number().nonnegative().nullable().optional(),
    work_type: z.string().max(64).nullable().optional(),
    housing_designation: z.string().max(128).nullable().optional(),
    apartment_number: z.string().max(32).nullable().optional(),
    // Bostadsrättsföreningens orgnr (XSD BrfOrgNrTYPE). If present it must be
    // a real orgnr shape: 10 digits (optional dash after position 6) or the
    // 12-digit sekelsiffra form, or Skatteverkets schemavalidering rejects
    // the whole file at upload time. Empty string = cleared field → null.
    brf_org_number: z
      .union([
        z.string().regex(/^(\d{6}-?\d{4}|16\d{10})$/, 'Ogiltigt organisationsnummer (10 siffror, ev. med bindestreck)'),
        z.literal(''),
      ])
      .transform((v) => v || null)
      .nullable()
      .optional(),
    // Periodisering (förutbetald intäkt): defer the line's net revenue over
    // the service period. The revenue entry credits the 29xx interim account
    // instead of the revenue account; output VAT is never deferred.
    accrual_period_start: isoDate.nullable().optional(),
    accrual_period_end: isoDate.nullable().optional(),
    accrual_balance_account: deferredRevenueAccount.nullable().optional(),
    // Dimensions PR7: per-item bag merged over the invoice's
    // default_dimensions on the revenue line this item books to.
    dimensions: DimensionsBagSchema.optional(),
  })
  .superRefine((item, ctx) => {
    validateAccrualPeriod(item, ctx)
    const hasAccrual = Boolean(item.accrual_period_start || item.accrual_period_end)
    if (hasAccrual) {
      if (item.line_type === 'text') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accrual_period_start'],
          message: 'Textrader kan inte periodiseras',
        })
      }
      if (item.deduction_type) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accrual_period_start'],
          message: 'ROT/RUT-rader kan inte periodiseras',
        })
      }
      if (item.quantity * item.unit_price <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accrual_period_start'],
          message: 'Endast rader med positivt belopp kan periodiseras',
        })
      }
    }
    // Free-text rows skip the product-line requirements (description may be
    // empty for a spacer; quantity/unit/price are ignored).
    if (item.line_type === 'text') return
    if (item.description.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: 'Item description is required' })
    }
    if (item.quantity <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: 'Quantity must be positive' })
    }
    if (item.unit.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'Unit is required' })
    }
  })

const optionalIsoDate = isoDate.or(z.literal('')).transform(v => v || undefined).optional()

export const CreateInvoiceSchema = z.object({
  customer_id: uuid,
  invoice_date: isoDate,
  due_date: isoDate,
  delivery_date: optionalIsoDate,
  currency: CurrencySchema,
  document_type: InvoiceDocumentTypeSchema.optional(),
  your_reference: z.string().optional(),
  our_reference: z.string().optional(),
  notes: z.string().optional(),
  // Optional online payment link (manual MVP): the user pastes a link created
  // in their PSP dashboard (e.g. a Stripe Payment Link). https-only because the
  // URL is rendered in customer-facing emails/PDFs under the company's name.
  // The invoice form always sends the field ('' when empty), so empty string
  // normalises to undefined like external_invoice_number above; build-invoice-
  // write maps undefined to NULL so clearing the field on a draft edit works.
  payment_link_url: z
    .union([
      z
        .string()
        .max(2048)
        .refine((v) => {
          try {
            return new URL(v).protocol === 'https:'
          } catch {
            return false
          }
        }, 'Ogiltig betalningslänk (måste vara en https-adress)'),
      z.literal(''),
    ])
    .transform((v) => v || undefined)
    .optional(),
  // Per-invoice opt-out for the automatic Stripe payment link on send.
  // Omitted → true (create) / kept as sent by the form (edit).
  payment_link_auto: z.boolean().optional(),
  // ROT/RUT claim info. The personnummer is plaintext on the wire and gets
  // encrypted server-side before it ever hits the DB (see encryptPersonnummer
  // in lib/personnummer.ts). `deduction_housing_designation` is the
  // fastighetsbeteckning at invoice level: required when any ROT item is
  // present (enforced via rot-rut-rules.validateInvoice in the API).
  deduction_personnummer: z.string().max(20).optional(),
  deduction_housing_designation: z.string().max(128).optional(),
  // ROT i bostadsrätt: lägenhetsnummer + föreningens orgnr replace the
  // fastighetsbeteckning (Begaran.xsd: LagenhetsNr + BrfOrgNr). Stamped onto
  // the rot lines server-side, same as deduction_housing_designation.
  deduction_apartment_number: z.string().max(25).optional(),
  // Same orgnr shape rule as items[].brf_org_number; empty string = not set.
  deduction_brf_org_number: z
    .union([
      z.string().regex(/^(\d{6}-?\d{4}|16\d{10})$/, 'Ogiltigt organisationsnummer (10 siffror, ev. med bindestreck)'),
      z.literal(''),
    ])
    .transform((v) => v || undefined)
    .optional(),
  // When true, save as an unnumbered draft: skip F-series allocation and the
  // invoice.created event until the user finalizes via POST /invoices/{id}/finalize
  // ("Granska och skapa"). An unnumbered draft is not yet an issued faktura
  // (ML 17 kap 24§), so it can be hard-deleted with no gap in the number series.
  save_as_draft: z.boolean().optional(),
  // Per-invoice öresavrundning toggle (display-only). Omitted → stored as null,
  // which inherits company_settings.ore_rounding when rendering totals.
  ore_rounding: z.boolean().optional(),
  // Dimensions PR7: invoice-level bag applied to every generated journal line;
  // items[].dimensions merge over it per revenue line.
  default_dimensions: DimensionsBagSchema.optional(),
  // Self-billing (mottagen självfaktura, ML 17 kap 15§): optional. Set
  // is_self_billed=true to register an invoice the CUSTOMER issued on your
  // behalf. For your books it is a sale, booked immediately (Debit 1510, Credit
  // 30xx + 26xx) with the counterparty's number in external_invoice_number: no
  // number from your own series is consumed (BFL 5 kap 6§), and there is no
  // draft/send step. When is_self_billed is true, external_invoice_number and
  // received_date are required (enforced in the route). Leave off for a normal
  // invoice. A plain optional flag (no schema refine) so UpdateInvoiceSchema's
  // .omit() keeps working on this object.
  is_self_billed: z.boolean().optional(),
  // The dashboard invoice form always sends these self-billing fields (default
  // '' in create/edit mode) even for a normal invoice, so an empty string must
  // read as "not provided", not fail validation. Otherwise a plain
  // external_invoice_number: '' trips the min(1) and 400s every regular invoice
  // create. Required-when-self-billed is still enforced in the v1 route via a
  // falsy check after parse, so normalising '' -> undefined here is safe.
  external_invoice_number: z
    .union([z.string().min(1).max(64), z.literal('')])
    .transform((v) => v || undefined)
    .optional(),
  self_billing_agreement_ref: z
    .string()
    .max(128)
    .transform((v) => v || undefined)
    .optional(),
  received_date: optionalIsoDate,
  items: z.array(CreateInvoiceItemSchema).min(1, 'At least one item is required'),
})

// Update (edit) an existing DRAFT invoice in place. Same shape as create minus
// `save_as_draft`: editing never (re)creates a draft or allocates a number, it
// only rewrites the draft's header + line items. The PATCH route guards that the
// target is still a draft (status='draft', no journal entry, not self-billed).
export const UpdateInvoiceSchema = CreateInvoiceSchema.omit({ save_as_draft: true })

export const CreateCreditNoteSchema = z.object({
  credited_invoice_id: uuid,
  reason: z.string().optional(),
})

// ============================================================
// Rot/rut begäran om utbetalning (Skatteverkets husavdragstjänst)
// ============================================================

export const RotRutPayoutFileSchema = z.object({
  deduction_type: z.enum(['rot', 'rut']),
  invoice_ids: z.array(uuid).min(1).max(500),
  // NamnPaBegaran: the XSD caps it at 16 chars; omitted → generated.
  name: z.string().min(1).max(16).optional(),
})

export const RotRutRequestPatchSchema = z.object({
  status: z.enum(['submitted', 'paid', 'partially_paid', 'rejected', 'cancelled']),
  // Godkänt belopp from Skatteverkets beslut. Only meaningful together with
  // paid/partially_paid/rejected.
  decided_total: nonNegativeAmount.optional(),
})

export const RotRutSettleSchema = z.object({
  payment_date: isoDate,
  // Defaults server-side to decided_total ?? requested_total.
  amount: z.number().positive().optional(),
  // BAS 19xx account the payout landed on (1920 Bank, 1930 Företagskonto, …).
  // Omitted → 1930. The engine validates existence against chart_of_accounts.
  bank_account: z
    .string()
    .regex(/^19\d{2}$/, 'Bankkontot måste vara ett BAS 19xx-konto')
    .optional(),
})

// The beslutsfil JSON downloaded from Skatteverkets rot/rut e-tjänst
// (dev_docs/skatteverket/husavdrag/exempel_beslut.json + ht.raml).
export const RotRutBeslutFileSchema = z.object({
  version: z.string(),
  // Utförarens orgnr, 12 digits with 16-prefix in SKV's file.
  utforare: z.string().regex(/^\d{10,12}$/),
  beslut: z
    .array(
      z.object({
        // NamnPaBegaran as submitted (1-16 chars); the primary match key
        // against rot_rut_payout_requests.name.
        namn: z.string().min(1),
        referensnummer: z.string().regex(/^\d{11}(-\d+)?$/),
        arenden: z
          .array(
            z.object({
              personnummer: z.string().regex(/^\d{12}$/),
              fakturanummer: z.string().max(20).optional(),
              // Whole kronor; 0 = avslag for the ärende.
              godkantBelopp: z.number().int().min(0),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})

// ============================================================
// Articles (artikelregister)
// ============================================================

export const ArticleTypeSchema = z.enum(['vara', 'tjanst'])

export const CreateArticleSchema = z.object({
  name: z.string().min(1, 'Article name is required').max(200),
  type: ArticleTypeSchema.optional(),
  unit: z.string().min(1).max(32).optional(),
  price_excl_vat: nonNegativeAmount,
  vat_rate: vatRatePercent.optional(),
  // Default price currency; omitted = SEK. Pre-fills a new invoice's currency.
  // Constrained to the same CurrencySchema enum invoices use, which mirrors the
  // seeded currencies reference table: an unknown code is a clean 400 here
  // instead of a raw FK violation (23503) surfacing at insert time.
  currency: CurrencySchema.optional(),
  // Optional BAS class 1-3 posting-account override. Null/omitted = derive from
  // the invoice's VAT treatment (current behaviour).
  revenue_account: invoicePostingAccount.nullable().optional(),
  // Margin/display only; never posted.
  cost_price: nonNegativeAmount.nullable().optional(),
  ean: z.string().max(32).nullable().optional(),
  // ROT/RUT arbetstyp; only meaningful for type === 'tjanst'.
  housework_type: z.string().max(64).nullable().optional(),
  name_en: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // Manual article number; omit to auto-generate via generate_article_number.
  article_number: z.string().max(64).nullable().optional(),
})

// PATCH allows every create field plus toggling the soft-delete flag.
export const UpdateArticleSchema = CreateArticleSchema.partial().extend({
  active: z.boolean().optional(),
})

// Self-billing received (mottagen självfaktura, ML 17 kap 15§). The customer
// issued the invoice on our behalf; for us it is a sale. We store the
// counterparty's number in external_invoice_number and never assign one from
// our own series. No ROT/RUT (that is a B2C, own-issued concept), so the item
// schema is the lean revenue-only shape: vat_rate is constrained to the legal
// Swedish set so the booked output VAT is always reportable.
export const SelfBillingInvoiceItemSchema = z.object({
  description: z.string().min(1, 'Item description is required'),
  quantity: z.number().positive('Quantity must be positive'),
  unit: z.string().min(1, 'Unit is required').default('st'),
  unit_price: z.number(),
  vat_rate: z
    .union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])
    .optional(),
})

export const CreateSelfBillingInvoiceSchema = z.object({
  customer_id: uuid,
  external_invoice_number: z.string().min(1, 'External invoice number is required').max(64),
  self_billing_agreement_ref: z.string().max(128).optional(),
  invoice_date: isoDate,
  received_date: isoDate,
  due_date: isoDate,
  currency: CurrencySchema,
  notes: z.string().optional(),
  items: z.array(SelfBillingInvoiceItemSchema).min(1, 'At least one item is required'),
})

// ============================================================
// Recurring invoice schedule schemas
// ============================================================

// Swedish VAT rates per ML 17 kap 24§ p.9. null means "use the customer's
// default rate" (getAvailableVatRates), which is 0% for a VAT-validated EU
// business or an export customer: huvudregeln, ML 6 kap. 34 §, taxes a B2B
// service where the buyer is established. An explicit 25/12/6 is still lawful
// for those customers when the supply is taxed where it is performed
// (fastighetstjänst, persontransport, korttidsuthyrning, restaurang/catering,
// admission to cultural and sports events), so cron-time validation in
// executeRecurringSchedule gates on getPermittedVatRates, not on the default.
// A rate outside 0/6/12/25 is rejected here: there is no such Swedish rate, and
// the buyer could not deduct ingående moms on it.
export const RecurringScheduleItemSchema = z.object({
  description: z.string().min(1, 'Item description is required'),
  quantity: z.number().positive('Quantity must be positive'),
  unit: z.string().min(1, 'Unit is required').default('st'),
  unit_price: z.number(),
  vat_rate: z
    .union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])
    .nullable()
    .optional(),
  // Copied onto the generated invoice_items.dimensions; merges over the
  // schedule's default_dimensions on that item's revenue line.
  dimensions: DimensionsBagSchema.optional(),
})

export const CreateRecurringScheduleSchema = z.object({
  customer_id: uuid,
  name: z.string().min(1, 'Schedule name is required').max(200),
  day_of_month: z.number().int().min(1).max(31),
  // Months between runs: 1 = monthly (default), 3 = quarterly, 6 = half-
  // yearly, 12 = yearly. Any 1-12 is accepted (e.g. every 2 months).
  interval_months: z.number().int().min(1).max(12).default(1),
  // Whole hour (0-23) in Europe/Stockholm at which the invoice is sent.
  send_hour: z.number().int().min(0).max(23).default(8),
  payment_terms_days: z.number().int().min(0).max(90).default(30),
  currency: CurrencySchema.default('SEK'),
  your_reference: z.string().optional(),
  our_reference: z.string().optional(),
  notes: z.string().optional(),
  auto_send: z.boolean().default(false),
  // Copied onto invoices.default_dimensions for every generated invoice.
  default_dimensions: DimensionsBagSchema.optional(),
  // Optional: when to first run. Defaults to next occurrence of day_of_month
  // (today if day_of_month === today, otherwise next month).
  start_date: isoDate.optional(),
  items: z.array(RecurringScheduleItemSchema).min(1, 'At least one item is required'),
})

export const UpdateRecurringScheduleSchema = z.object({
  customer_id: uuid.optional(),
  name: z.string().min(1).max(200).optional(),
  day_of_month: z.number().int().min(1).max(31).optional(),
  // Changing the interval alone leaves next_run_date untouched: the new
  // cadence applies from the next run onward.
  interval_months: z.number().int().min(1).max(12).optional(),
  send_hour: z.number().int().min(0).max(23).optional(),
  payment_terms_days: z.number().int().min(0).max(90).optional(),
  currency: CurrencySchema.optional(),
  your_reference: z.string().nullable().optional(),
  our_reference: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  auto_send: z.boolean().optional(),
  status: z.enum(['active', 'paused']).optional(),
  // Replaces the whole bag if provided ({} clears all tags). Omit to keep.
  default_dimensions: DimensionsBagSchema.optional(),
  // Replace all items if provided. Omit to keep existing items unchanged.
  items: z.array(RecurringScheduleItemSchema).min(1).optional(),
})

export const MarkInvoicePaidSchema = z.object({
  payment_date: isoDate.optional(),
  exchange_rate_difference: z.number().optional(),
  notes: z.string().optional(),
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
    // Dimensions PR7: user-edited payment lines keep their tags (the
    // no-override path re-propagates the invoice's default_dimensions).
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
  // Bypass the duplicate-payment guard. Set after the user reviews the
  // candidate list returned by INVOICE_PAID_LIKELY_DUPLICATE and confirms
  // none of them are this payment. v1 callers must use a fresh
  // Idempotency-Key on the retry: the original is body-hash bound.
  force: z.boolean().optional(),
})

export const MarkInvoiceSentSchema = z.object({
  // Optional user-edited issuance lines ("Markera som skickad och bokför").
  // When present they replace the generated invoice entry verbatim: the route
  // validates balance and books exactly these lines, and accrual schedules
  // are NOT created (what the user reviewed is what books). Only honored on
  // the accrual book-at-issue path; ignored for credit notes, cash-method
  // and deferred-booking companies, which don't book at mark-sent.
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
})

export const SendInvoiceSchema = MarkInvoiceSentSchema.extend({
  additional_cc: invoiceEmailAddressList.optional(),
  additional_bcc: invoiceEmailAddressList.optional(),
}).refine(
  (data) => (
    (data.additional_cc?.length ?? 0) + (data.additional_bcc?.length ?? 0)
    <= MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ),
  {
    message: `Högst ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} extra kopiemottagare är tillåtna totalt`,
    path: ['additional_cc'],
  },
)

// ============================================================
// Customer schemas
// ============================================================

export const CreateCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  customer_type: CustomerTypeSchema,
  // Kundnummer shown on invoices. Free text, not unique in v1. Empty string
  // and null both clear the value (routes normalize '' to null).
  customer_number: z
    .string()
    .trim()
    .max(32, 'Customer number must be 32 characters or fewer')
    .nullable()
    .optional(),
  contact_person: z.string().trim().max(200).nullable().optional(),
  email: z.string().email('Invalid email address').optional(),
  phone: z.string().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  personal_number: z
    .string()
    .regex(/^(\d{6}|\d{8})[-+]?\d{4}$/, 'Invalid personal number')
    .optional()
    .nullable(),
  language: z.enum(['sv', 'en']).optional(),
  default_payment_terms: z.number().int().positive().optional(),
  notes: z.string().optional(),
}).superRefine((customer, ctx) => {
  if (customer.personal_number && customer.customer_type !== 'individual') {
    ctx.addIssue({
      code: 'custom',
      path: ['personal_number'],
      message: 'Personal number is only allowed for individual customers',
    })
  }
  if (
    (customer.invoice_email_cc_addresses?.length ?? 0)
    + (customer.invoice_email_bcc_addresses?.length ?? 0)
    > MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['invoice_email_cc_addresses'],
      message: `At most ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} customer invoice copy recipients are allowed in total`,
    })
  }
})

export const UpdateCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required').optional(),
  customer_type: CustomerTypeSchema.optional(),
  customer_number: z.string().trim().max(32).nullable().optional(),
  contact_person: z.string().trim().max(200).nullable().optional(),
  email: z.string().email('Invalid email address').optional(),
  phone: z.string().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  // Plaintext personnummer (validated here, then encrypted by the route), or
  // either masked form a read path returns: '********-1234' when the stored
  // value decrypted, '********-????' when it did not. The route reads a mask
  // as "leave the stored value alone" and never stores it, so a client echoing
  // back what it read cannot wipe the personnummer.
  // Both forms must pass. Accepting only the '-1234' one made an undecryptable
  // row completely uneditable: the mask the API had just returned failed
  // validation here, so PATCHing the customer's name or address 400'd on a
  // field the user had no way to correct.
  // CreateCustomerSchema stays strict: on create there is no stored value to
  // preserve, so a mask there is a client error and earns a 400.
  personal_number: z
    .string()
    .regex(PERSONAL_NUMBER_INPUT_RE, 'Invalid personal number')
    .nullable()
    .optional(),
  language: z.enum(['sv', 'en']).optional(),
  default_payment_terms: z.number().int().positive().optional(),
  notes: z.string().optional(),
}).superRefine((customer, ctx) => {
  if (
    (customer.invoice_email_cc_addresses?.length ?? 0)
    + (customer.invoice_email_bcc_addresses?.length ?? 0)
    > MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['invoice_email_cc_addresses'],
      message: `At most ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} customer invoice copy recipients are allowed in total`,
    })
  }
})

// ============================================================
// Supplier schemas
// ============================================================

export const CreateSupplierSchema = z.object({
  name: z.string().min(1, 'Supplier name is required'),
  supplier_type: SupplierTypeSchema,
  email: z.string().email('Invalid email address').optional(),
  phone: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  bankgiro: z.string().optional(),
  plusgiro: z.string().optional(),
  bank_account: z.string().optional(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  default_expense_account: accountNumber.optional(),
  default_payment_terms: z.number().int().positive().optional(),
  default_currency: CurrencySchema.nullable().optional(),
  notes: z.string().optional(),
})

export const UpdateSupplierSchema = CreateSupplierSchema.partial()

// ============================================================
// Supplier invoice schemas
// ============================================================

export const CreateSupplierInvoiceItemSchema = z.object({
  description: z.string().min(1, 'Item description is required'),
  amount: z.number().optional(),
  account_number: accountNumber,
  vat_rate: vatRateDecimal.optional(),
  // Manual VAT override. When provided, the engine books this exact amount to
  // 2641/2645 instead of recomputing line_total × vat_rate. Use for partial-
  // deductible cases (bilförmån 50%, representation 300 kr-tak), foreign-
  // currency rounding, or POS receipts where supplier-side rounding makes the
  // VAT off by öre.
  vat_amount: z.number().min(0).optional(),
  // Self-assessed VAT rate for omvänd skattskyldighet (reverse charge). The
  // supplier charges no VAT (vat_rate stays 0); this is the Swedish statutory
  // rate the buyer self-assesses at: 25% huvudregel default, 12%/6% for
  // reduced-rated services (ML 6 kap 34 §). Must be a statutory rate.
  reverse_charge_rate: z
    .number()
    .refine((r) => r === 0.06 || r === 0.12 || r === 0.25, {
      message: 'reverse_charge_rate must be 0.06, 0.12, or 0.25',
    })
    .optional(),
  vat_code: z.string().optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  unit_price: z.number().optional(),
  // Periodisering (förutbetald kostnad): defer the line's net cost over the
  // service period. The registration entry debits the 17xx interim account
  // instead of account_number; input VAT is never deferred.
  accrual_period_start: isoDate.nullable().optional(),
  accrual_period_end: isoDate.nullable().optional(),
  accrual_balance_account: prepaidExpenseAccount.nullable().optional(),
  // Dimensions PR7: per-item bag merged over the invoice's
  // default_dimensions on the expense line this item books to.
  dimensions: DimensionsBagSchema.optional(),
}).refine(
  (item) => {
    if (item.vat_amount == null) return true
    const lineTotal = item.amount != null
      ? item.amount
      : (item.quantity ?? 1) * (item.unit_price ?? 0)
    const vatRate = item.vat_rate ?? 0.25
    const maxVat = Math.round(lineTotal * vatRate * 100) / 100
    // 1-öre tolerance covers POS rounding; anything beyond is an upstream bug
    // or a client trying to inflate 2641 debit beyond the statutory ceiling.
    return item.vat_amount <= maxVat + 0.01
  },
  {
    message: 'vat_amount cannot exceed line_total × vat_rate',
    path: ['vat_amount'],
  },
).superRefine((item, ctx) => {
  validateAccrualPeriod(item, ctx)
  if (item.accrual_period_start || item.accrual_period_end) {
    const lineTotal = item.amount != null
      ? item.amount
      : (item.quantity ?? 1) * (item.unit_price ?? 0)
    if (lineTotal <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accrual_period_start'],
        message: 'Endast rader med positivt belopp kan periodiseras',
      })
    }
  }
})

export const CreateSupplierInvoiceSchema = z.object({
  supplier_id: uuid,
  // Optional invoice PDF/image already stored in the WORM document archive.
  // The route verifies company ownership and that the document is unused.
  document_id: uuid.optional(),
  supplier_invoice_number: z.string().min(1, 'Supplier invoice number is required'),
  invoice_date: isoDate,
  due_date: isoDate,
  delivery_date: optionalIsoDate,
  currency: CurrencySchema.optional(),
  // Bounded by the shared `exchangeRate` primitive so the value can never
  // reach `supplier_invoices_exchange_rate_check` and come back as a 500.
  exchange_rate: exchangeRate.optional(),
  vat_treatment: VatTreatmentSchema.optional(),
  reverse_charge: z.boolean().optional(),
  payment_reference: z.string().optional(),
  notes: z.string().optional(),
  // Per-invoice öresavrundning toggle (display-only). Omitted → stored as null (off).
  ore_rounding: z.boolean().optional(),
  paid_with_private_funds: z.boolean().optional(),
  // For paid_with_private_funds: the date the owner paid out-of-pocket.
  // Defaults to invoice_date (common for kvitto where the two coincide).
  payment_date: isoDate.optional(),
  // Dimensions PR7: invoice-level bag applied to every generated journal line;
  // items[].dimensions merge over it per expense line.
  default_dimensions: DimensionsBagSchema.optional(),
  items: z.array(CreateSupplierInvoiceItemSchema).min(1, 'At least one item is required'),
})

export const MarkSupplierInvoicePaidSchema = z.object({
  amount: z.number().positive().optional(),
  payment_date: isoDate.optional(),
  exchange_rate_difference: z.number().optional(),
  notes: z.string().optional(),
  force: z.boolean().optional(),
  // Which BAS account to credit for the payment. Defaults to 1930 to preserve
  // the historical behaviour for MCP / agent callers that don't supply it.
  payment_account: accountNumber.optional(),
  // Optional user-edited journal entry rows. When present they override the
  // default 2440-clearing / cash booking. Server validates balance and posts
  // via createJournalEntry directly. source_type still derives from the
  // routing decision so downstream payment-sync keeps working.
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
    // Dimensions PR7: user-edited payment lines keep their tags (the
    // no-override path re-propagates the invoice's default_dimensions).
    dimensions: DimensionsBagSchema.optional(),
  })).min(2).optional(),
})

export const UpdateSupplierInvoiceSchema = z.object({
  supplier_invoice_number: z.string().min(1).optional(),
  invoice_date: isoDate.optional(),
  due_date: isoDate.optional(),
  delivery_date: optionalIsoDate,
  payment_reference: z.string().optional(),
  notes: z.string().optional(),
})

// ============================================================
// Journal entry schemas
// ============================================================

export const CreateJournalEntryLineSchema = z.object({
  account_number: accountNumber,
  debit_amount: nonNegativeAmount.default(0),
  credit_amount: nonNegativeAmount.default(0),
  line_description: z.string().optional(),
  currency: z.string().optional(),
  amount_in_currency: z.number().optional(),
  exchange_rate: z.number().positive().optional(),
  tax_code: z.string().optional(),
  // SIE dimension map {sie_dim_no: object_code}, e.g. {"1":"KS01","6":"P001"}.
  // Single source of truth for the constraints lives in dimension-resolver so
  // the staged pending-operations path validates identically. Wins per key
  // over the cost_center/project aliases.
  dimensions: DimensionsBagSchema.optional(),
  // Deprecated aliases for dimensions['1'] / dimensions['6'], kept forever
  // for API/MCP compatibility.
  cost_center: z.string().optional(),
  project: z.string().optional(),
})

export const CreateJournalEntrySchema = z.object({
  fiscal_period_id: uuid,
  entry_date: isoDate,
  description: z.string().min(1, 'Description is required'),
  source_type: JournalEntrySourceTypeSchema.default('manual'),
  source_id: z.string().optional(),
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(CreateJournalEntryLineSchema).min(2, 'At least two lines are required for double-entry'),
})

export const CorrectJournalEntrySchema = z.object({
  // Optional verifikationstext for the corrected entry. When omitted the
  // server falls back to "Rättelse: <original description>"; supplying it lets
  // the user replace a header that echoed the wrong account's label (#1031).
  description: z.string().trim().min(1, 'Description cannot be empty').optional(),
  lines: z.array(CreateJournalEntryLineSchema).min(2, 'At least two lines are required for double-entry'),
})

// ============================================================
// Inline rättelse of a posted verifikat (BFL 5 kap 5 § / 9 §)
// ============================================================
// The correct_entry_metadata / correct_entry_lines_inline RPCs enforce the
// full envelope (posted status, open period, company lock date, balance,
// who/when logging); these schemas only shape the payload.

/** POST /api/bookkeeping/journal-entries/[id]/correct-metadata */
export const CorrectEntryMetadataSchema = z
  .object({
    description: z.string().trim().min(1, 'Beskrivningen kan inte vara tom').max(500).optional(),
    entry_date: isoDate.optional(),
  })
  .refine((body) => body.description !== undefined || body.entry_date !== undefined, {
    message: 'Minst ett fält måste anges',
  })

/**
 * Replacement line for an inline strike. Deliberately narrower than
 * CreateJournalEntryLineSchema: inline additions are SEK-only and carry no
 * tax_code or currency conversion (those corrections use the storno flow).
 */
export const InlineRattelseLineSchema = z.object({
  account_number: accountNumber,
  debit_amount: nonNegativeAmount.default(0),
  credit_amount: nonNegativeAmount.default(0),
  line_description: z.string().max(500).optional(),
  dimensions: DimensionsBagSchema.optional(),
})

/** POST /api/bookkeeping/journal-entries/[id]/strike-lines */
export const StrikeLinesSchema = z
  .object({
    strike_line_ids: z.array(uuid).max(200).default([]),
    lines: z.array(InlineRattelseLineSchema).max(100).default([]),
  })
  .refine((body) => body.strike_line_ids.length > 0 || body.lines.length > 0, {
    message: 'Rättelsen måste stryka eller lägga till minst en rad',
  })

// ============================================================
// Dimension registry schemas (kostnadsställe/projekt)
// ============================================================
// dev_docs/dimensions_implementation_plan.md §6. The registry tables
// (dimensions/dimension_values) shipped in 20260702084500_dimensions_substrate.

/**
 * Object code for USER-CREATED dimension values: strict Fortnox format.
 * Deliberately tighter than both the DB CHECK (1..40 chars, no `"{}`') and
 * DimensionsBagSchema (line-level values): legacy free-text codes from the
 * backfill/SIE import must survive on lines, but new registry codes minted
 * through the API stay portable to Fortnox/Visma.
 */
const dimensionValueCode = z
  .string()
  .regex(
    /^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$/,
    'Koden får bara innehålla bokstäver (A-Ö), siffror, _, + och - (max 20 tecken)',
  )

const dimensionValueDates = {
  start_date: isoDate.nullable().optional(),
  end_date: isoDate.nullable().optional(),
}

/** PATCH /api/dimensions/[id]: name is rejected route-side for is_system dims. */
export const UpdateDimensionSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Minst ett fält måste anges',
  })

/** POST /api/dimensions/[id]/values: code is immutable after creation (v1: no rename). */
export const CreateDimensionValueSchema = z
  .object({
    code: dimensionValueCode,
    name: z.string().min(1).max(120),
    /** Omitted → true. Lets "create as archived" be a single atomic POST. */
    is_active: z.boolean().optional(),
    ...dimensionValueDates,
  })
  .refine(
    (body) => !body.start_date || !body.end_date || body.end_date >= body.start_date,
    { message: 'Slutdatum får inte vara före startdatum', path: ['end_date'] },
  )

/**
 * POST /api/bookkeeping/journal-entry-lines/[lineId]/retag: Tier-2 retro-
 * tagging (dimensions plan PR6). The RPC enforces every rule (posted only,
 * open period, lock date, active registry values); this schema only shapes
 * the request. An empty bag {} untags the line.
 */
/**
 * POST /api/dimensions — create a custom dimension (dimensions PR10).
 * sie_dim_no omitted → server picks the next free number >= 20 (SIE leaves
 * 20+ unreserved). parent_sie_dim_no declares an #UNDERDIM hierarchy.
 */
export const CreateDimensionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sie_dim_no: z.coerce.number().int().min(1).max(9999).optional(),
  resets_annually: z.boolean().optional(),
  parent_sie_dim_no: z.coerce.number().int().min(1).max(9999).nullable().optional(),
})

const AccountDimensionRuleTypeSchema = z.enum(['required', 'default', 'fixed'])

/** GET /api/dimensions/rules query — optional exact-account filter. */
export const ListDimensionRulesQuerySchema = z.object({
  account_number: accountNumber.optional(),
})

/**
 * POST /api/dimensions/rules — per-account dimension policy (dimensions
 * PR10). 'required' carries no value; 'default'/'fixed' must carry the value
 * to apply. One rule per (account, dimension) — enforced by the DB UNIQUE.
 */
export const CreateAccountDimensionRuleSchema = z
  .object({
    account_number: accountNumber,
    dimension_id: uuid,
    rule_type: AccountDimensionRuleTypeSchema,
    value_id: uuid.optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.rule_type === 'required' && rule.value_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value_id'],
        message: 'En obligatorisk regel har inget värde — värden hör till Förval/Låst.',
      })
    }
    if (rule.rule_type !== 'required' && !rule.value_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value_id'],
        message: 'Välj vilket värde regeln ska använda.',
      })
    }
  })

/** PATCH /api/dimensions/rules/[id] — the value-presence rule re-checks in the route (partial update). */
export const UpdateAccountDimensionRuleSchema = z.object({
  rule_type: AccountDimensionRuleTypeSchema.optional(),
  value_id: uuid.nullable().optional(),
  is_active: z.boolean().optional(),
})

export const RetagLineDimensionsSchema = z.object({
  // {} passes (no entries to validate) = UNTAG. Intentional divergence from
  // the MCP staged path (RetagLineDimensionsParamsSchema), which rejects an
  // empty bag: a human clearing phantom tags via the dialog/workbench is a
  // deliberate act with a logged reason; an agent bulk-clearing history is
  // not something we allow to be staged. The retag log records {} as the
  // new value either way (#867 review).
  dimensions: DimensionsBagSchema,
  reason: z.string().min(3).max(500),
})

/** PATCH /api/dimensions/[id]/values/[valueId]: no `code` field by design. */
export const UpdateDimensionValueSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    is_active: z.boolean().optional(),
    ...dimensionValueDates,
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Minst ett fält måste anges',
  })

/**
 * Move a posted verifikation to a different date (and thereby fiscal period)
 * without changing its lines: fixes a booking entered with the wrong
 * date/year. The corrected lines are copied server-side from the original.
 */
export const RecordateJournalEntrySchema = z.object({
  new_entry_date: isoDate,
})

// ============================================================
// Transaction schemas
// ============================================================

/**
 * Manual bank-transaction creation (the "Lägg till transaktion" form).
 *
 * The authoritative server-side boundary for that flow. Historically the form
 * inserted straight into Supabase from the browser with only
 * `z.string().min(1)` on the date, which let a corrupt 6-digit year through and
 * crashed the page on render. The form reuses `isSaneDateString` (via this
 * schema's `saneIsoDate`) so the date rule is single-sourced across layers.
 */
export const CreateTransactionSchema = z.object({
  date: saneIsoDate,
  description: z.string().min(1, 'Description is required').max(500),
  amount: z.number().refine((n) => n !== 0, 'Amount must not be zero'),
  currency: CurrencySchema,
  category: TransactionCategorySchema.optional(),
  notes: z.string().max(2000).optional(),
})

export const CategorizeTransactionSchema = z
  .object({
    is_business: z.boolean(),
    category: TransactionCategorySchema.optional(),
    template_id: z.string().optional(),
    vat_treatment: VatTreatmentSchema.optional(),
    account_override: accountNumber.optional(),
    counterparty_template_id: z.string().uuid().optional(),
    // Dimensions bag {sie_dim_no: code} applied to the business lines of the
    // generated verifikat (bank/VAT legs stay untagged). Wins over a learned
    // counterparty-template bag when both are present.
    dimensions: DimensionsBagSchema.optional(),
    user_description: z.string().max(500).optional(),
    inbox_item_id: z.string().uuid().optional(),
    confirm_no_match: z.boolean().optional(),
    // Booking-time duplicate guard (TRANSACTION_BOOK_POSSIBLE_DUPLICATE). force
    // bypasses it after the user reviews the candidate; the bypass is bound to
    // the specific already-booked candidate (re-detected server-side, so a
    // guessed id can't wave the guard away). The candidate is either a sibling
    // transaction (expected_duplicate_transaction_id) or a ledger-only voucher
    // with no transaction behind it (expected_duplicate_journal_entry_id): both
    // carry a journal_entry_id, so new callers bind on that.
    force: z.boolean().optional(),
    expected_duplicate_transaction_id: uuid.optional(),
    expected_duplicate_journal_entry_id: uuid.optional(),
  })
  .refine((v) => !v.force || !!v.expected_duplicate_transaction_id || !!v.expected_duplicate_journal_entry_id, {
    message: 'expected_duplicate_transaction_id or expected_duplicate_journal_entry_id is required when force=true',
    path: ['expected_duplicate_journal_entry_id'],
  })

export const BookTransactionSchema = z
  .object({
    fiscal_period_id: uuid,
    entry_date: isoDate,
    description: z.string().min(1, 'Description is required'),
    lines: z.array(CreateJournalEntryLineSchema).min(1, 'At least one line is required'),
    // Booking-time duplicate guard: see CategorizeTransactionSchema.
    force: z.boolean().optional(),
    expected_duplicate_transaction_id: uuid.optional(),
    expected_duplicate_journal_entry_id: uuid.optional(),
  })
  .refine((v) => !v.force || !!v.expected_duplicate_transaction_id || !!v.expected_duplicate_journal_entry_id, {
    message: 'expected_duplicate_transaction_id or expected_duplicate_journal_entry_id is required when force=true',
    path: ['expected_duplicate_journal_entry_id'],
  })

/**
 * Edit a bank transaction's title (description). Only the working label:
 * gated server-side to unbooked, unmatched rows. Trimmed; whitespace-only is
 * rejected by min(1). Passing the bank original restores the "not edited" tag.
 */
export const UpdateTransactionTitleSchema = z.object({
  description: z.string().trim().min(1, 'Title cannot be empty').max(500),
})

/**
 * Bulk-book selected Underlag (Dokumentinkorgen) against their matched bank
 * transactions. One shared category + VAT treatment is applied to every
 * selected item; each item is booked against its own matched transaction (which
 * carries the SEK amount), so the verifikat are individual, not a
 * samlingsverifikation. Items without a matched transaction, already booked, or
 * already linked to a leverantörsfaktura are skipped server-side.
 *
 * Used both as the UI route body (POST /items/bulk-book) and as the
 * pending-operation params for `bulk_book_inbox_items` (Lena-driven flow).
 */
export const BulkBookInboxSchema = z.object({
  item_ids: z.array(uuid).min(1, 'Minst ett underlag krävs').max(200, 'Högst 200 underlag per bokföring'),
  category: TransactionCategorySchema,
  // Optional fields are `.nullish()` (not just `.optional()`) because the
  // `bulk_book_inbox_items` pending operation persists absent optionals as
  // explicit JSON `null` (stagePendingOperation in mcp-server/server.ts). When
  // the executor re-parses those params on approval, a bare `.optional()` would
  // reject the stored `null`. `.transform` normalizes `null → undefined` so the
  // executor and categorizeMatchedTransaction never receive `null`.
  vat_treatment: VatTreatmentSchema.nullish().transform((v) => v ?? undefined),
  // The underlag's actual moms when it differs from rate × belopp (e.g. dricks).
  // Only valid with a rate-based vat_treatment; rejected otherwise downstream.
  vat_amount: z.number().positive().nullish().transform((v) => v ?? undefined),
  notes: z.string().max(2000).nullish().transform((v) => v ?? undefined),
  allow_duplicate: z.boolean().nullish().transform((v) => v ?? undefined),
  // Shared dimensions bag applied to the business lines of every generated
  // verifikat (same semantics as single categorize). nullish for the same
  // staged-params reason as the fields above.
  dimensions: DimensionsBagSchema.nullish().transform((v) => v ?? undefined),
})
export type BulkBookInboxInput = z.infer<typeof BulkBookInboxSchema>

export const MatchInvoiceSchema = z
  .object({
    invoice_id: uuid,
    // Bypass the soft-duplicate guard (MATCH_INVOICE_POSSIBLE_DUPLICATE).
    // Set after the user reviews the candidate verifikation and confirms it
    // is not this payment. v1 callers must use a fresh Idempotency-Key on
    // the retry: the original is body-hash bound.
    force: z.boolean().optional(),
    // Required whenever force=true. Echoes the journal_entry_id of the
    // candidate the user reviewed in the duplicate-payment-check pre-flight.
    // The server re-detects the candidate and refuses force=true unless the
    // re-detected id matches this value. That binds the override to a
    // specific, user-seen duplicate so an automation can't sweep through
    // force=true to bypass the guard without ever consulting the candidate.
    expected_journal_entry_id: uuid.optional(),
    // Optional user-edited journal entry lines. When present they override
    // the default clearing/cash booking: the route validates balance and
    // posts via createJournalEntry directly. Source_type is still set from
    // the routing decision (invoice_paid vs invoice_cash_payment) so
    // downstream payment-sync continues to work.
    lines: z.array(z.object({
      account_number: accountNumber,
      debit_amount: nonNegativeAmount.default(0),
      credit_amount: nonNegativeAmount.default(0),
      line_description: z.string().optional(),
    })).min(2).optional(),
    // Optional caller-supplied SEK-per-invoice-currency rate for cross-currency
    // settlement. Used when the Riksbanken lookup returns nothing (rate not
    // published for that date): the dialog surfaces an input so the user can
    // type the rate from their bank statement. Ignored when tx.currency ===
    // invoice.currency. The ceiling is a sanity guard against pasted garbage /
    // scientific-notation input silently corrupting the FX-diff posting and
    // invoice_payments.amount: no supported currency's SEK rate approaches it
    // (USD~10.5, EUR~11.5, GBP~13.5). It is a guard rail, not a precise band;
    // the dialog's live preview (paid_in_invoice_currency + FX gain/loss) is
    // what catches a plausible-but-wrong decimal-shift typo before confirm.
    // It used to be `.max(100000)`, an inclusive ceiling against an exclusive
    // `payment_exchange_rate < 100000` CHECK: exactly 100000 passed Zod and
    // died in Postgres. The shared primitive is exclusive on both ends.
    manual_exchange_rate: exchangeRate.optional(),
  })
  .refine((v) => !v.force || !!v.expected_journal_entry_id, {
    message: 'expected_journal_entry_id is required when force=true',
    path: ['expected_journal_entry_id'],
  })

/**
 * Link an existing posted verifikat as payment for an invoice. No new
 * journal entry is created: only an invoice_payments row pointing at the
 * supplied journal_entry_id, plus the invoice's paid/remaining are advanced.
 */
export const LinkInvoiceToVoucherSchema = z.object({
  journal_entry_id: uuid,
  notes: z.string().max(2000).optional(),
})

/**
 * Supplier-invoice mirror: link an existing posted verifikat as payment for a
 * supplier invoice. No new JE: only a supplier_invoice_payments row pointing
 * at the supplied journal_entry_id, plus the invoice's paid/remaining advance.
 */
export const LinkSupplierInvoiceToVoucherSchema = z.object({
  journal_entry_id: uuid,
  notes: z.string().max(2000).optional(),
})

/**
 * Bulk-book N bank transactions on the same date into one combined verifikat
 * (samlingsverifikation per BFL 5 kap 6§). Two flows multiplexed by which
 * field is set:
 *
 *   - `existing_journal_entry_id`: link the txs to an already-posted voucher
 *     (no new JE created). The voucher's 19xx net must equal the tx sum.
 *
 *   - `template_id` + `mode` + `entry_description`: build a new verifikat
 *     by applying the booking template to each tx. The route does the ratio
 *     expansion (one_line_per_tx OR sum_per_account) and passes the final
 *     lines to the RPC.
 *
 * Exactly one of the two paths must be set: enforced by superRefine.
 */
export const BulkBookSchema = z
  .object({
    tx_ids: z
      .array(uuid)
      .min(1, 'At least one transaction is required')
      .max(200, 'At most 200 transactions per batch'),
    existing_journal_entry_id: uuid.optional(),
    template_id: uuid.optional(),
    mode: z.enum(['one_line_per_tx', 'sum_per_account']).optional(),
    entry_description: z.string().min(1).max(500).optional(),
    // PR #608: manual lines path. Mutually exclusive with template_id /
    // existing_journal_entry_id. The route passes these straight through
    // to the RPC's p_new_entry.lines.
    manual_lines: z
      .array(
        z.object({
          account_number: accountNumber,
          // Bound at 99,999,999 SEK per line (compliance-swarm V4.5).
          // Real-world max is in the millions; an 8-digit ceiling catches
          // typos (1000000 mistyped as 10000000000) before they hit the
          // RPC, without blocking legitimate large bookings.
          debit_amount: nonNegativeAmount.max(99_999_999, 'Line amount exceeds maximum'),
          credit_amount: nonNegativeAmount.max(99_999_999, 'Line amount exceeds maximum'),
          currency: z.string().min(3).max(3).default('SEK'),
          line_description: z.string().max(200).optional(),
          // Dimensions PR7: per-line bag, wins over default_dimensions.
          dimensions: DimensionsBagSchema.optional(),
        })
      )
      .min(2, 'A verifikat needs at least two lines')
      .max(200)
      .optional(),
    // Dimensions PR7: header-level bag applied to every generated line in
    // BOTH the template and manual paths (per-line bags win per key). The
    // route merges before calling the RPC.
    default_dimensions: DimensionsBagSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const hasExisting = !!data.existing_journal_entry_id
    const hasTemplate = !!data.template_id
    const hasManual = !!data.manual_lines
    const paths = [hasExisting, hasTemplate, hasManual].filter(Boolean).length
    if (paths !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide exactly one of: existing_journal_entry_id (link), template_id (template), or manual_lines (manual)',
        path: ['existing_journal_entry_id'],
      })
      return
    }
    if (hasTemplate) {
      if (!data.mode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'mode is required when template_id is set',
          path: ['mode'],
        })
      }
      if (!data.entry_description) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'entry_description is required when template_id is set',
          path: ['entry_description'],
        })
      }
    }
    if (hasManual && !data.entry_description) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'entry_description is required when manual_lines is set',
        path: ['entry_description'],
      })
    }
  })

/**
 * Allocate one bank transaction across N customer OR N supplier invoices.
 * Backed by the match_batch_allocate PL/pgSQL RPC, which builds a single
 * combined verifikat (samlingsverifikation) and inserts N payment rows.
 */
export const MatchBatchSchema = z
  .object({
    allocations: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('customer_invoice'),
            invoice_id: uuid,
            // Strictly positive: zero or negative is rejected at the schema
            // layer (PR #603 review) so the RPC's BATCH_INVALID_AMOUNT path
            // is only reachable from non-HTTP callers.
            amount: z.number().positive('Allocation amount must be greater than 0'),
          }),
          z.object({
            kind: z.literal('supplier_invoice'),
            supplier_invoice_id: uuid,
            amount: z.number().positive('Allocation amount must be greater than 0'),
          }),
        ]),
      )
      .min(1, 'At least one allocation is required')
      // Cap at 100 to prevent DoS via unbounded FOR UPDATE locks in the RPC
      // (PR #603 compliance review, OWASP V4.2). Domain-appropriate ceiling:
      // a real samlingsverifikat rarely covers more than a few dozen invoices.
      .max(100, 'At most 100 allocations per batch'),
  })
  .superRefine((data, ctx) => {
    // Reject mixed customer + supplier in a single batch: semantically a
    // single bank transfer settles invoices on one side. The RPC also guards
    // this with BATCH_MIXED_KINDS_UNSUPPORTED, but rejecting at the schema
    // layer gives a cleaner 400 with a per-field path.
    const kinds = new Set(data.allocations.map((a) => a.kind))
    if (kinds.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocations'],
        message: 'Allocations cannot mix customer_invoice and supplier_invoice kinds',
      })
    }
  })

export const LinkTransactionJournalEntrySchema = z.object({
  journal_entry_id: uuid,
  // Optional invoice to settle alongside the link. When provided, the
  // server inserts an invoice_payments row pointing at the existing JE
  // and flips the invoice status with the same optimistic-lock pattern
  // as the match-invoice route. Omit to only link the bank transaction
  // (e.g. when the JE doesn't relate to a customer invoice).
  invoice_id: uuid.optional(),
})

export const CreateTransactionFromDocumentSchema = z.object({
  inbox_item_id: uuid,
  amount: z.number().refine((n) => n !== 0, 'Amount must be non-zero'),
  transaction_date: isoDate,
  description: z.string().min(1).max(500),
})

export const MatchSupplierInvoiceSchema = z.object({
  supplier_invoice_id: uuid,
  // Same purpose as MatchInvoiceSchema.lines: user-edited rows override
  // the default 2440-clearing / cash booking. Route validates balance and
  // posts via createJournalEntry; source_type still derives from routing.
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount.default(0),
    credit_amount: nonNegativeAmount.default(0),
    line_description: z.string().optional(),
  })).min(2).optional(),
})


// ============================================================
// Settings schemas
// ============================================================

// Editable invoice email texts (standard invoices only). Nested JSONB:
// unknown keys inside are stripped (Zod default, consistent with this file).
// Empty strings pass validation; the template resolver treats whitespace-only
// as unset, and the UI prunes empties before saving so the stored object
// stays minimal. Subject is a mail header: CR/LF are stripped at render time
// regardless.
const InvoiceEmailTextsLangSchema = z.object({
  subject: z.string().max(200, 'Ämnesraden får vara max 200 tecken').optional(),
  greeting: z.string().max(200, 'Hälsningen får vara max 200 tecken').optional(),
  body: z.string().max(2000, 'Brödtexten får vara max 2000 tecken').optional(),
  signoff: z.string().max(200, 'Avslutningen får vara max 200 tecken').optional(),
})

export const InvoiceEmailTextsSchema = z.object({
  sv: InvoiceEmailTextsLangSchema.optional(),
  en: InvoiceEmailTextsLangSchema.optional(),
})

const InvoiceIbanSchema = z.string()
  .transform((value) => value.replace(/\s/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, 'Ogiltigt IBAN'))
  .nullable()
  .optional()
  .or(z.literal(''))

const InvoicePaymentAccountSchema = z.object({
  bank_name: z.string().trim().max(100).nullable().optional(),
  clearing_number: z.string().regex(/^\d{4,5}$/, 'Clearingnummer måste vara 4-5 siffror').nullable().optional().or(z.literal('')),
  account_number: z.string().regex(/^\d{6,12}$/, 'Kontonummer måste vara 6-12 siffror').nullable().optional().or(z.literal('')),
  bankgiro: z.string().regex(/^(\d{3,4}-\d{4}|\d{7,8})$/, 'Ogiltigt bankgironummer').nullable().optional().or(z.literal('')),
  plusgiro: z.string().regex(/^\d{1,7}-\d$/, 'Ogiltigt plusgironummer').nullable().optional().or(z.literal('')),
  swish: z.string().transform(normaliseSwish).pipe(z.string().refine(isValidSwish, 'Ogiltigt Swish-nummer')).nullable().optional(),
  iban: InvoiceIbanSchema,
  bic: z.string()
    .transform((value) => value.replace(/\s/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'Ogiltig BIC/SWIFT'))
    .nullable()
    .optional()
    .or(z.literal('')),
})

const InvoicePaymentAccountsSchema = z
  .partialRecord(CurrencySchema, InvoicePaymentAccountSchema)
  .superRefine((accounts, ctx) => {
    for (const [currency, account] of Object.entries(accounts)) {
      if (currency !== 'SEK' && account && !account.iban) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [currency, 'iban'],
          message: `IBAN krävs för betalningskonto i ${currency}`,
        })
      }
    }
  })

export const UpdateSettingsSchema = z.object({
  entity_type: EntityTypeSchema.optional(),
  company_name: z.string().optional(),
  org_number: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  f_skatt: z.boolean().optional(),
  vat_registered: z.boolean().optional(),
  vat_number: z.string()
    .transform(normalizeVatNumber)
    .pipe(z.string().regex(/^SE\d{12}$/, 'Momsregistreringsnummer måste vara SE följt av 12 siffror'))
    .nullable()
    .optional(),
  moms_period: MomsPeriodSchema.nullable().optional(),
  vat_taxable_base_over_40m: z.boolean().optional(),
  vat_has_eu_trade: z.boolean().optional(),
  vat_filing_method: TaxFilingMethodSchema.optional(),
  periodisk_sammanstallning_enabled: z.boolean().optional(),
  periodisk_sammanstallning_period: PsPeriodTypeSchema.optional(),
  periodisk_sammanstallning_filing_method: TaxFilingMethodSchema.optional(),
  kontrolluppgifter_enabled: z.boolean().optional(),
  rot_rut_enabled: z.boolean().optional(),
  oss_enabled: z.boolean().optional(),
  ioss_enabled: z.boolean().optional(),
  intrastat_enabled: z.boolean().optional(),
  punktskatt_enabled: z.boolean().optional(),
  fyllnadsinbetalning_enabled: z.boolean().optional(),
  tax_contact_name: z.string().max(200).nullable().optional(),
  tax_contact_phone: z.string().max(40).nullable().optional(),
  tax_contact_email: z.string().email().nullable().optional().or(z.literal('')),
  fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
  preliminary_tax_monthly: z.number().nullable().optional(),
  // Share capital per Bolagsverket (annual report aktiekapital note).
  aktiekapital: z.number().int('Aktiekapital anges i hela kronor').positive('Aktiekapital måste vara större än 0').nullable().optional(),
  antal_aktier: z.number().int('Antal aktier måste vara ett heltal').positive('Antal aktier måste vara större än 0').nullable().optional(),
  employer_registered: z.boolean().nullable().optional(),
  employer_seasonal: z.boolean().optional(),
  bank_name: z.string().max(100, 'Banknamn får vara max 100 tecken').nullable().optional(),
  clearing_number: z.string().regex(/^\d{4,5}$/, 'Clearingnummer måste vara 4-5 siffror').nullable().optional().or(z.literal('')),
  account_number: z.string().regex(/^\d{6,12}$/, 'Kontonummer måste vara 6-12 siffror').nullable().optional().or(z.literal('')),
  bankgiro: z.string().regex(/^(\d{3,4}-\d{4}|\d{7,8})$/, 'Ogiltigt bankgironummer (7-8 siffror)').nullable().optional().or(z.literal('')),
  plusgiro: z.string().regex(/^\d{1,7}-\d{1}$/, 'Ogiltigt plusgironummer').nullable().optional().or(z.literal('')),
  swish: z.string()
    .transform(normaliseSwish)
    .pipe(
      z.string().refine(
        isValidSwish,
        'Ogiltigt Swish-nummer (företagsnummer 123XXXXXXX eller mobilnummer 07XXXXXXXX)',
      ),
    )
    .nullable()
    .optional(),
  // Legacy SEK mirror of invoice_payment_accounts.SEK. Use the same general
  // IBAN validation because a SEK-denominated account need not be Swedish.
  iban: InvoiceIbanSchema,
  bic: z.string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'Ogiltig BIC/SWIFT (8 eller 11 tecken)').nullable().optional().or(z.literal('')),
  invoice_payment_accounts: InvoicePaymentAccountsSchema.optional(),
  accounting_method: AccountingMethodSchema.optional(),
  // #967: register/send invoices without booking; booking is a separate step.
  defer_invoice_booking: z.boolean().optional(),
  invoice_prefix: z.string().nullable().optional(),
  next_invoice_number: z.number().int().positive().optional(),
  next_arrival_number: z.number().int().positive().optional(),
  invoice_default_days: z.number().int().positive().optional(),
  invoice_default_notes: z.string().nullable().optional(),
  default_our_reference: z.string().max(200).nullable().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().optional().or(z.literal('')),
  pays_salaries: z.boolean().optional(),
  sector_slug: z.string().nullable().optional(),
  // Bookkeeping lock
  bookkeeping_locked_through: z.string().regex(ISO_DATE_RE, ISO_DATE_MESSAGE_SV).nullable().optional(),
  auto_lock_period_days: z.number().int().positive().nullable().optional(),
  // Voucher series
  default_voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
  // Per-source-type voucher series map. Keys are journal_entries.source_type
  // values; values are single uppercase letters A-Z. Read by the engine
  // (`createDraftEntry`) when no explicit voucher_series is passed, with a
  // fallback to 'A' for unknown keys.
  // partialRecord, not record: in Zod 4 an enum-keyed z.record is exhaustive
  // (every source_type required), so saving a map that omits a source type
  // (e.g. the newly added 'result_appropriation') fails with "expected string,
  // received undefined". The map is intentionally sparse: the settings form
  // sends only the source types the user configured, and the engine falls back
  // to 'A' for any unmapped key.
  default_voucher_series_per_source_type: z
    .partialRecord(
      JournalEntrySourceTypeSchema,
      z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z'),
    )
    .optional(),
  // Invoice PDF settings
  ore_rounding: z.boolean().optional(),
  invoice_show_ocr: z.boolean().optional(),
  invoice_show_bankgiro: z.boolean().optional(),
  invoice_show_plusgiro: z.boolean().optional(),
  invoice_show_swish: z.boolean().optional(),
  invoice_show_logo: z.boolean().optional(),
  invoice_show_company_name: z.boolean().optional(),
  invoice_company_name_position: z.enum(['header', 'footer']).optional(),
  invoice_late_fee_text: z.string().nullable().optional(),
  invoice_credit_terms_text: z.string().nullable().optional(),
  // Opt-in for the invoice payment-link feature (editor field + automatic
  // Stripe link on send). Default off at the DB level.
  invoice_payment_links_enabled: z.boolean().optional(),
  // Editable invoice email texts: { sv?: {...}, en?: {...} }; null clears
  // all overrides. Without this entry the generic PUT would silently strip
  // the field (the schema is the de-facto column whitelist).
  invoice_email_texts: InvoiceEmailTextsSchema.nullable().optional(),
  invoice_email_cc_addresses: invoiceEmailAddressList.nullable().optional(),
  invoice_email_bcc_addresses: invoiceEmailAddressList.nullable().optional(),
  // Invoice branding: colors enforced as #RRGGBB at the DB level too
  // (see migration 20260526120200_invoice_branding.sql). The dedicated
  // /api/settings/invoicing/branding route is the primary path; these
  // entries let the generic PUT /api/settings also accept the same fields.
  invoice_primary_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Ange en giltig hex-färg (#RRGGBB)')
    .optional(),
  invoice_accent_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Ange en giltig hex-färg (#RRGGBB)')
    .optional(),
  invoice_font_family: z
    .enum(['Helvetica', 'Times-Roman', 'Courier', 'Source Sans 3', 'Source Serif 4', 'Custom'])
    .optional(),
  invoice_header_text: z.string().max(200).nullable().optional(),
  invoice_footer_text: z.string().max(500).nullable().optional(),
  // Automation
  send_invoice_reminders: z.boolean().optional(),
  reminder_days_level_1: z.number().int().min(1).max(365).optional(),
  reminder_days_level_2: z.number().int().min(1).max(365).optional(),
  reminder_days_level_3: z.number().int().min(1).max(365).optional(),
  // Reminder surcharges (dröjsmålsränta + lagstadgad påminnelseavgift)
  reminder_fee_enabled: z.boolean().optional(),
  reminder_fee_amount: z
    .number()
    .min(0, 'Påminnelseavgift kan inte vara negativ')
    .max(60, 'Lagstadgad maxgräns för påminnelseavgift är 60 kr (Lag 1981:739)')
    .optional(),
  reminder_interest_rate_override: z
    .number()
    .min(0, 'Räntesats kan inte vara negativ')
    .max(0.9999, 'Ange räntesatsen som en decimal mindre än 1 (t.ex. 0.115 för 11,5%)')
    .nullable()
    .optional(),
  // AI agent flow
  ai_flow_enabled: z.boolean().optional(),
  // Dimensions (kostnadsställe/projekt): UI-visibility toggle only, never
  // load-bearing for correctness (dev_docs/dimensions_implementation_plan.md §2).
  dimensions_enabled: z.boolean().optional(),
}).refine(
  (data) => (
    (data.invoice_email_cc_addresses?.length ?? 0)
    + (data.invoice_email_bcc_addresses?.length ?? 0)
    <= MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ),
  {
    message: `Högst ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} fasta kopiemottagare är tillåtna totalt`,
    path: ['invoice_email_cc_addresses'],
  },
).refine(
  (data) => {
    // BFL 3 kap.: Enskild firma must have fiscal year starting January
    if (data.entity_type === 'enskild_firma' && data.fiscal_year_start_month !== undefined) {
      return data.fiscal_year_start_month === 1
    }
    return true
  },
  {
    message: 'Enskild firma must have fiscal year starting in January (BFL 3 kap.)',
    path: ['fiscal_year_start_month'],
  }
)

// ============================================================
// Fiscal period schemas
// ============================================================

export const CreateFiscalPeriodSchema = z.object({
  name: z.string().min(1, 'Period name is required'),
  period_start: isoDate,
  period_end: isoDate,
}).refine(
  (data) => data.period_start < data.period_end,
  {
    message: 'Period start must be before period end',
    path: ['period_end'],
  }
)

// ============================================================
// Mapping rule schemas
// ============================================================

export const CreateMappingRuleSchema = z.object({
  rule_name: z.string().min(1, 'Rule name is required'),
  rule_type: MappingRuleTypeSchema,
  priority: z.number().int().min(0).optional(),
  mcc_codes: z.array(z.string()).optional(),
  merchant_pattern: z.string().optional(),
  description_pattern: z.string().optional(),
  amount_min: z.number().optional(),
  amount_max: z.number().optional(),
  debit_account: accountNumber,
  credit_account: accountNumber,
  vat_treatment: z.string().optional(),
  risk_level: RiskLevelSchema.optional(),
  default_private: z.boolean().optional(),
  requires_review: z.boolean().optional(),
  confidence_score: z.number().min(0).max(1).optional(),
})

export const EvaluateMappingRulesSchema = z.union([
  z.object({ transaction_id: uuid }),
  z.object({
    description: z.string().optional(),
    amount: z.number(),
  }).passthrough(),
])

// ============================================================
// Deadline schemas
// ============================================================

export const CreateDeadlineSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  due_date: isoDate,
  due_time: timeString.nullish(),
  deadline_type: DeadlineTypeSchema,
  priority: DeadlinePrioritySchema.nullish(),
  customer_id: uuid.nullish(),
  notes: z.string().nullish(),
  tax_deadline_type: TaxDeadlineTypeSchema.nullish(),
  tax_period: z.string().nullish(),
  source: DeadlineSourceSchema.optional(),
  linked_report_type: z.string().nullish(),
  linked_report_period: z.record(z.string(), z.unknown()).nullish(),
})

// ============================================================
// Account schemas
// ============================================================

// Per-account default VAT rate: the sats the booking UI understands, as a
// decimal fraction. Mirrors the DB CHECK on chart_of_accounts.default_vat_rate.
const defaultVatRate = z
  .union([z.literal(0), z.literal(0.06), z.literal(0.12), z.literal(0.25)])
  .nullable()
  .optional()

export const CreateAccountSchema = z.object({
  account_number: accountNumber,
  account_name: z.string().min(1, 'Account name is required'),
  account_type: AccountTypeSchema,
  normal_balance: NormalBalanceSchema,
  plan_type: z.enum(['k1', 'full_bas']).optional(),
  description: z.string().nullable().optional(),
  default_vat_code: z.string().nullable().optional(),
  default_vat_rate: defaultVatRate,
  sru_code: z.string().nullable().optional(),
})

export const UpdateAccountSchema = z.object({
  account_name: z.string().min(1).optional(),
  is_active: z.boolean().optional(),
  description: z.string().nullable().optional(),
  default_vat_code: z.string().nullable().optional(),
  default_vat_rate: defaultVatRate,
  sru_code: z.string().nullable().optional(),
})

// Looser account-number shape than the 4-digit primitive on purpose: imported
// charts can carry non-standard numbers (sub-accounts like '19301'), and those
// are exactly the rows the prune flow exists to remove.
export const PruneAccountsSchema = z
  .object({
    dry_run: z.boolean(),
    account_numbers: z.array(z.string().min(1).max(10)).max(2000).optional(),
  })
  .refine((v) => v.dry_run || (v.account_numbers?.length ?? 0) > 0, {
    message: 'account_numbers is required when dry_run is false',
    path: ['account_numbers'],
  })

// ============================================================
// Bank reconciliation schemas
// ============================================================

export const BankLinkSchema = z.object({
  transaction_id: uuid,
  journal_entry_id: uuid,
  // Settlement account being reconciled. The voucher must have a line on this
  // account and the transaction must belong to it. Defaults to '1930' in the
  // route for back-compat.
  account_number: accountNumber.optional(),
})

export const BankUnlinkSchema = z.object({
  transaction_id: uuid,
})

/**
 * Re-tag a mis-typed bank-account opening balance (a manual/import voucher that
 * is really an ingående balans) as source_type='opening_balance' so bank
 * reconciliation excludes it from the period movement. Routed to the
 * mark_entry_as_opening_balance SECURITY DEFINER RPC, which enforces the rest.
 */
export const MarkOpeningBalanceSchema = z.object({
  journal_entry_id: uuid,
})

export const RunReconciliationSchema = z.object({
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  // BAS settlement account to reconcile against (e.g. '1930', '1932'). Defaults
  // to '1930' server-side so existing clients stay correct.
  account_number: accountNumber.optional(),
  dry_run: z.boolean().optional(),
  // Pairs the user ticked in the dry-run preview. When present on an apply
  // (dry_run false), only these pairs are committed: intersected server-side
  // with a fresh match run, so a stale or fabricated pair is never applied.
  selected_matches: z
    .array(
      z.object({
        transaction_id: uuid,
        journal_entry_id: uuid,
      }),
    )
    .max(500)
    .optional(),
})

// ============================================================
// Report query schemas
// ============================================================

export const VatDeclarationQuerySchema = z.object({
  periodType: z.enum(['monthly', 'quarterly', 'yearly']),
  year: z.coerce.number().int().min(2000).max(2100),
  period: z.coerce.number().int().min(1).max(12),
})

export const AccountBalancesQuerySchema = z.object({
  accounts: z
    .string()
    .transform((s) => s.split(',').map((a) => a.trim()).filter(Boolean))
    .pipe(z.array(accountNumber).min(1).max(50)),
  // Reject future dates: a saldo "as of tomorrow" would include unposted
  // future entries (if any) and mislead the bookkeeper about the true
  // pre-entry state of the ledger. Compared in Europe/Stockholm so a Swedish
  // bookkeeper working in the 00:00-02:00 CET window (after midnight UTC has
  // not yet passed) isn't rejected for entering their local today's date.
  as_of: isoDate.refine(
    (d) => d <= new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }),
    { message: 'as_of cannot be in the future' },
  ),
})

// ============================================================
// VAT validation schemas
// ============================================================

export const ValidateVatNumberSchema = z.object({
  vat_number: z.string().min(4, 'VAT number must be at least 4 characters'),
  customer_id: uuid.optional(),
})

// ============================================================
// Pagination schemas
// ============================================================

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
})

// ============================================================
// Event log schemas
// ============================================================

export const EventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  types: z.string()
    .transform(s => s.split(',').map(t => t.trim()).filter(Boolean))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

// ============================================================
// Pending operations schemas
// ============================================================

export const PendingOperationsQuerySchema = z.object({
  // 'failed_partial' is queryable directly; the UI folds it into the
  // rejected tab (see app/api/pending-operations/route.ts).
  status: z.enum(['pending', 'committed', 'rejected', 'failed_partial']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
})

export const PendingOperationsBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
})

// Bulk reject: same id list plus the optional category/reason pair from the
// single reject route. When provided they are applied to every rejected row.
export const PendingOperationsBulkRejectSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  rejection_category: z
    .enum(['wrong_category', 'wrong_amount', 'duplicate', 'wrong_period', 'other'])
    .optional(),
  rejection_reason: z.string().max(2000).optional(),
})

// ============================================================
// Audit trail schemas
// ============================================================

// `satisfies` keeps every filter value a member of the AuditAction union —
// adding a bogus value here fails the typecheck.
const auditActions = [
  'INSERT', 'UPDATE', 'DELETE', 'COMMIT', 'REVERSE', 'CORRECT',
  'LOCK_PERIOD', 'CLOSE_PERIOD', 'DOCUMENT_DELETE_BLOCKED',
  'RETENTION_BLOCK', 'SECURITY_EVENT', 'INTEGRITY_FAILURE',
] as const satisfies readonly AuditAction[]

export const AuditTrailQuerySchema = z.object({
  action: z.enum(auditActions).optional(),
  table_name: z.string().min(1).optional(),
  record_id: z.string().min(1).optional(),
  from_date: isoDate.optional(),
  to_date: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
})

// ============================================================
// Voucher gap schemas
// ============================================================

export const VoucherGapQuerySchema = z.object({
  fiscal_period_id: uuid,
  voucher_series: z.string().regex(/^[A-Z]$/, 'Verifikationsserie måste vara en bokstav A-Z').optional(),
})

export const SaveGapExplanationSchema = z.object({
  fiscal_period_id: uuid,
  voucher_series: z.string().default('A'),
  gap_start: z.number().int().positive(),
  gap_end: z.number().int().positive(),
  explanation: z.string().min(1).max(500),
})

// ============================================================
// Opening balance import schemas
// ============================================================

export const OpeningBalanceExecuteSchema = z.object({
  fiscal_period_id: uuid,
  lines: z.array(z.object({
    account_number: accountNumber,
    debit_amount: nonNegativeAmount,
    credit_amount: nonNegativeAmount,
  })).min(2, 'At least two lines are required for double-entry'),
})

// ============================================================
// Register import schemas (customers, suppliers)
// ============================================================

const ImportedCustomerRowSchema = z.object({
  row_index: z.number().int(),
  name: z.string().min(1),
  customer_type: CustomerTypeSchema,
  org_number: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  vat_number: z.string().nullable(),
  default_payment_terms: z.number().int().min(0).max(365),
  notes: z.string().nullable(),
})

export const CustomerImportExecuteSchema = z.object({
  rows: z.array(ImportedCustomerRowSchema).min(1, 'At least one row is required'),
  update_duplicates: z.boolean(),
})

const ImportedSupplierRowSchema = z.object({
  row_index: z.number().int(),
  name: z.string().min(1),
  supplier_type: SupplierTypeSchema,
  org_number: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  vat_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  bank_account: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  default_payment_terms: z.number().int().min(0).max(365),
  default_currency: z.string(),
  notes: z.string().nullable(),
})

export const SupplierImportExecuteSchema = z.object({
  rows: z.array(ImportedSupplierRowSchema).min(1, 'At least one row is required'),
  update_duplicates: z.boolean(),
})

const ImportedArticleRowSchema = z.object({
  row_index: z.number().int(),
  name: z.string().min(1),
  name_en: z.string().nullable(),
  article_number: z.string().nullable(),
  type: ArticleTypeSchema,
  unit: z.string(),
  price_excl_vat: nonNegativeAmount,
  // ISO 4217 shape only; the execute route validates against the currencies
  // table and drops unknown codes (mirrors revenue_account). Optional so rows
  // parsed before this field existed still validate.
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  vat_rate: vatRatePercent,
  // The execute route re-validates against the chart of accounts (and drops
  // unknown/inactive overrides), so a loose nullable string is enough here.
  revenue_account: z.string().nullable(),
  cost_price: nonNegativeAmount.nullable(),
  ean: z.string().nullable(),
  housework_type: z.string().nullable(),
  notes: z.string().nullable(),
})

export const ArticleImportExecuteSchema = z.object({
  rows: z.array(ImportedArticleRowSchema).min(1, 'At least one row is required'),
  update_duplicates: z.boolean(),
})

// Validates the optional column-mapping override posted to the parse route, so
// a malformed/hostile blob can't drive the parser with non-numeric or
// unexpected column indices. Mirrors DetectedArticleColumns.
const articleColumnIndex = z.number().int().min(0).nullable()
export const ArticleColumnOverridesSchema = z.object({
  name_col: z.number().int().min(0),
  article_number_col: articleColumnIndex,
  name_en_col: articleColumnIndex,
  type_col: articleColumnIndex,
  unit_col: articleColumnIndex,
  price_col: articleColumnIndex,
  // Optional + defaulted so a mapping payload from a client rendered before
  // this column existed still validates.
  currency_col: articleColumnIndex.optional().default(null),
  vat_rate_col: articleColumnIndex,
  revenue_account_col: articleColumnIndex,
  cost_price_col: articleColumnIndex,
  ean_col: articleColumnIndex,
  housework_type_col: articleColumnIndex,
  notes_col: articleColumnIndex,
  confidence: z.number(),
})

// ============================================================
// AI agent flow schemas
// ============================================================

const BookingProposalLineSchema = z.object({
  account_number: accountNumber,
  debit_amount: nonNegativeAmount,
  credit_amount: nonNegativeAmount,
  description: z.string().min(1).max(500),
})

const BookingProposalCounterpartyTemplateSchema = z.object({
  counterparty_name: z.string().min(1).max(200),
  debit_account: accountNumber,
  credit_account: accountNumber,
  vat_treatment: VatTreatmentSchema.nullable(),
  category: TransactionCategorySchema.nullable(),
})

export const AttachDocumentSchema = z.object({
  document_id: uuid,
})

export const LinkDocumentSchema = z.object({
  journal_entry_id: uuid,
  journal_entry_line_id: uuid.optional(),
  inbox_item_id: uuid.optional(),
  transaction_id: uuid.optional(),
})

// ============================================================
// Dimensions PR6: bulk retro-tagging workbench (appended at end
// of file by PR6 to avoid conflicts; keep new schemas below).
// ============================================================

/**
 * Query filters for GET /api/dimensions/tagging/lines (the BulkTagWorkbench
 * line browser). All filters optional; `limit` is a hard cap (default 200,
 * max 500): the route fetches limit+1 and reports `total_capped` instead of
 * paginating (dimensions plan §3, v1 scope).
 */
export const DimensionTaggingLinesQuerySchema = z.object({
  period_id: uuid.optional(),
  date_from: saneIsoDate.optional(),
  date_to: saneIsoDate.optional(),
  account_from: accountNumber.optional(),
  account_to: accountNumber.optional(),
  /** Free-text ilike filter on journal_entries.description. */
  text: z.string().trim().max(200).optional(),
  /** '1' → only vouchers with at least one untagged line ({} dimensions). */
  only_untagged: z.enum(['0', '1']).optional(),
  /**
   * '1' → include reversal pairs (annulled entries + their stornos). Excluded
   * by default: a pair nets to zero in every dimension bucket when both sides
   * carry the same tag, so retro-tagging it is a no-op, and showing it
   * invites tagging one side only, which skews project P&L.
   */
  include_annulled: z.enum(['0', '1']).optional(),
  /** Cap counts VOUCHERS since the voucher-level rework. */
  limit: z.coerce.number().int().min(1).max(300).default(150),
})

/**
 * Body for POST /api/dimensions/tagging/apply. One dimensions object applied
 * to every listed line via the retag_line_dimensions RPC (the UI groups
 * selected lines by their computed resulting map and issues one POST per
 * distinct map). `dimensions` reuses THE bag schema so validation cannot
 * drift from the engine/API layers; an empty bag is allowed: replace mode
 * uses it to clear phantom tags. `reason` mirrors the RPC's >= 3 chars CHECK.
 */
export const DimensionTaggingApplySchema = z.object({
  line_ids: z.array(uuid).min(1).max(500),
  dimensions: DimensionsBagSchema,
  reason: z.string().trim().min(3).max(500),
})
