import { z } from 'zod'

/**
 * Agent-supplied extraction contract for inbox items
 * (gnubok_set_inbox_extracted_data). The agent parses the document itself and
 * hands over the structured fields; nothing here books anything on its own.
 *
 * accountSuggestion is preserved: agents (unlike an unvalidated OCR output)
 * can reliably assign a BAS expense account; the regex enforces the
 * class-4-7 range required for cost accounts.
 */

const DocumentKind = z
  .enum(['receipt', 'supplier_invoice', 'government_letter', 'other'])
  .nullable()
  .catch(null)
const PaymentMethod = z
  .enum(['card', 'swish', 'cash', 'invoice', 'other'])
  .nullable()
  .catch(null)
const MerchantCategory = z
  .enum(['restaurant', 'cafe', 'taxi', 'parking', 'fuel', 'grocery', 'hotel', 'other'])
  .nullable()
  .catch(null)
const Legibility = z.enum(['good', 'partial', 'unreadable']).nullable().catch(null)

export const AgentExtractionSchema = z.object({
  documentKind: DocumentKind.optional(),
  merchantCategory: MerchantCategory.optional(),
  legibility: Legibility.optional(),
  purchaseTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .catch(null)
    .optional(),
  payment: z
    .object({
      method: PaymentMethod,
      // Length + digits-only, deliberately not the shared four-digit
      // invariant from @/lib/invariants: this is the tail of a masked card
      // number, not a BAS account and not a fiscal year.
      cardLast4: z.string().length(4).regex(/^\d+$/).nullable().catch(null),
    })
    .nullable()
    .catch(null)
    .optional(),
  supplier: z.object({
    name: z.string().nullable(),
    orgNumber: z.string().nullable(),
    vatNumber: z.string().nullable(),
    address: z.string().nullable(),
    bankgiro: z.string().nullable(),
    plusgiro: z.string().nullable(),
  }),
  invoice: z.object({
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    paymentReference: z.string().nullable(),
    currency: z.string(),
    // Service/coverage window the invoice charges for (insurance period,
    // license term, "avtalsperiod"). Drives the periodisering prefill in the
    // supplier-invoice form.
    servicePeriodStart: z.string().nullable().optional(),
    servicePeriodEnd: z.string().nullable().optional(),
  }),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number().nullable(),
      lineTotal: z.number(),
      // Sane range for any real-world VAT rate. Non-Swedish rates are allowed
      // (UK 20, DE 19, NO 25, ...) since Accounted stores foreign invoices
      // for reference; the strict Swedish allowlist applies later when the
      // user converts to a supplier invoice.
      vatRate: z.number().min(0).max(100).nullable(),
      accountSuggestion: z.string().regex(/^[4-7]\d{3}$/).nullable(),
    })
  ),
  totals: z.object({
    subtotal: z.number().nullable(),
    vatAmount: z.number().nullable(),
    total: z.number().nullable(),
    // Öresavrundning line on Swedish receipts (can be negative).
    roundingAmount: z.number().nullable().catch(null).optional(),
  }),
  vatBreakdown: z.array(
    z.object({
      rate: z.number().min(0).max(100),
      base: z.number(),
      amount: z.number(),
    })
  ),
})
