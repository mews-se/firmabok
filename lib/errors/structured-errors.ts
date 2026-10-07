/**
 * Canonical registry of structured error codes used by both REST routes and
 * the MCP server.
 *
 * Each entry defines:
 *   - httpStatus: status returned by errorResponse() for this code
 *   - message_sv: Swedish user-facing message (consumed by toast)
 *   - message_en: English message for agents and developer logs
 *   - remediation: optional pointer to a fix (tool/resource/description)
 *
 * Adding a new code = add a row here. The error-code-matrix in
 * `.claude/plans/for-all-of-those-mutable-sunset.md` lists the codes per
 * operation; keep that document and this file in sync.
 *
 * Codes follow `<DOMAIN>_<OPERATION>_<CAUSE>` naming. Stable forever once
 * shipped: agents pattern-match on them.
 */

export interface StructuredErrorRemediation {
  description: string
  tool?: string
  args?: Record<string, unknown>
  resource?: string
}

export interface StructuredErrorEntry {
  httpStatus: number
  message_sv: string
  message_en: string
  remediation?: StructuredErrorRemediation
  /**
   * When true, agents and clients may retry the same request after a short
   * backoff. Set only on truly transient failures (DB blip, external API
   * timeout, rate limit). Permanent failures (validation, not found, period
   * locked) MUST stay false: retrying won't change the outcome.
   */
  retryable?: boolean
}

// ─────────────────────────────────────────────────────────────────
// Generic / cross-cutting codes
// ─────────────────────────────────────────────────────────────────

const GENERIC: Record<string, StructuredErrorEntry> = {
  UNKNOWN_ERROR: {
    httpStatus: 500,
    message_sv: 'Något gick fel. Försök igen.',
    message_en: 'An unexpected error occurred.',
  },
  // Unclassified-but-transient failures (DB deadlock/timeout, connection
  // drop, upstream 5xx/429) inferred by isTransientFailure() when no
  // specific code applies. Stable code so agents can dispatch on it.
  TRANSIENT_ERROR: {
    httpStatus: 503,
    message_sv: 'Tillfälligt fel: försök igen om en stund.',
    message_en: 'Transient failure: retry the same request after a short backoff.',
    retryable: true,
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    message_sv: 'Ett oväntat serverfel uppstod. Försök igen senare.',
    message_en: 'Internal server error.',
  },
  VALIDATION_ERROR: {
    httpStatus: 400,
    message_sv: 'Förfrågan innehåller ogiltiga uppgifter.',
    message_en: 'Validation error.',
  },
  UNAUTHORIZED: {
    httpStatus: 401,
    message_sv: 'Din session har gått ut. Logga in igen.',
    message_en: 'Authentication required.',
  },
  FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Du har inte behörighet att utföra denna åtgärd.',
    message_en: 'Insufficient permissions.',
  },
  NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Resursen kunde inte hittas.',
    message_en: 'Resource not found.',
  },
  CONFLICT: {
    httpStatus: 409,
    message_sv: 'En konflikt uppstod. Ladda om sidan och försök igen.',
    message_en: 'Conflict.',
  },
  RATE_LIMITED: {
    httpStatus: 429,
    message_sv: 'För många förfrågningar. Vänta en stund och försök igen.',
    message_en: 'Rate limit exceeded.',
    retryable: true,
  },
  NOT_IMPLEMENTED: {
    httpStatus: 501,
    message_sv: 'Funktionen är inte implementerad ännu.',
    message_en: 'This feature is accepted by the schema but not yet implemented.',
  },
  COMPANY_CONTEXT_MISSING: {
    httpStatus: 400,
    message_sv: 'Ingen aktiv företagskontext. Välj ett företag och försök igen.',
    message_en: 'No active company context resolved for the request.',
  },
  IDEMPOTENCY_KEY_REUSE: {
    httpStatus: 409,
    message_sv: 'Idempotensnyckeln har redan använts med en annan begäran.',
    message_en: 'Idempotency key was previously used with a different request body.',
    remediation: {
      description:
        'Use a fresh UUID for a new operation, or send the original request body to replay.',
    },
  },
  INSUFFICIENT_SCOPE: {
    httpStatus: 403,
    message_sv: 'API-nyckeln saknar behörighet för denna åtgärd.',
    message_en: 'The current API key does not have the required scope.',
    remediation: {
      description:
        'Mint a new key with the missing scope or grant it through the API key settings.',
      resource: 'Accounted://capabilities',
    },
  },
  TEST_KEY_WRITE_BLOCKED: {
    httpStatus: 403,
    message_sv:
      'Den här åtgärden kan inte simuleras och är därför inte tillgänglig med en testnyckel. Använd en live-nyckel.',
    message_en:
      'This endpoint cannot be simulated, so it is not available with a test key. Test keys force dry-run on every write; use a live key for endpoints that do not support dry-run.',
    remediation: {
      description: 'Use a live key for this endpoint, or pick an endpoint that supports dry-run.',
    },
  },
  EXTENSION_DISABLED: {
    httpStatus: 503,
    message_sv: 'Integrationen är inte aktiverad i denna miljö.',
    message_en: 'The integration is not enabled in this environment.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Bookkeeping engine codes (already used by lib/bookkeeping/errors.ts)
// ─────────────────────────────────────────────────────────────────

const BOOKKEEPING: Record<string, StructuredErrorEntry> = {
  ACCOUNTS_NOT_IN_CHART: {
    httpStatus: 400,
    message_sv: 'Konton saknas i kontoplanen.',
    message_en: 'One or more BAS accounts are not active in the chart of accounts.',
    remediation: {
      description:
        'Activate the missing accounts via bookkeeping settings, or use a different category.',
      resource: 'Accounted://chart-of-accounts',
    },
  },
  // Distinct from a plain duplicate: the account number is taken by a row the
  // company deactivated. Creating it again can never succeed (the unique
  // constraint counts inactive rows), so the only way forward is reactivation.
  // Callers key on this code to offer that instead of a dead-end 409.
  ACCOUNT_EXISTS_INACTIVE: {
    httpStatus: 409,
    message_sv: 'Kontot finns redan i din kontoplan men är inaktiverat.',
    message_en:
      'The account number already exists in this company chart of accounts but is deactivated.',
    remediation: {
      description:
        'Reactivate the existing account instead of creating it: POST /api/bookkeeping/accounts/activate with { account_numbers: [number] }.',
      resource: 'Accounted://chart-of-accounts',
    },
  },
  JOURNAL_ENTRY_NOT_BALANCED: {
    httpStatus: 400,
    message_sv: 'Verifikationen balanserar inte.',
    message_en: 'Debits and credits do not match.',
    remediation: {
      description: 'Recalculate the lines so totals are equal before retrying.',
    },
  },
  JOURNAL_LINE_NEGATIVE_AMOUNT: {
    httpStatus: 400,
    message_sv: 'En verifikationsrad har ett negativt belopp. Boka beloppet på motsatt sida i stället.',
    message_en: 'A journal line has a negative amount. Book it on the opposite side instead.',
    remediation: {
      description:
        'Every line carries one non-negative side: move a negative debit to credit_amount (and vice versa) before retrying.',
    },
  },
  FISCAL_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'No fiscal period covers the entry date.',
    remediation: {
      description: 'Create or extend the relevant fiscal period before retrying.',
      resource: 'Accounted://period/active',
    },
  },
  ENTRY_DATE_OUTSIDE_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Datumet ligger utanför det valda räkenskapsåret.',
    message_en: 'Entry date is outside the active fiscal period.',
    remediation: {
      description: 'Use a date inside an open period or create one that covers it.',
      resource: 'Accounted://period/active',
    },
  },
  JOURNAL_ENTRY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  CANNOT_REVERSE_NON_POSTED: {
    httpStatus: 400,
    message_sv: 'Endast bokförda verifikationer kan stornas.',
    message_en: 'Only posted entries can be reversed.',
  },
  CANNOT_REVERSE_STORNO: {
    httpStatus: 400,
    message_sv:
      'En stornering kan inte stornas. Om verifikationen makulerades av misstag, bokför den på nytt (kopiera originalet).',
    message_en:
      'A storno entry cannot be reversed. If the entry was cancelled by mistake, re-book it (copy the original).',
  },
  CANNOT_CORRECT_NON_POSTED: {
    httpStatus: 400,
    message_sv: 'Endast bokförda verifikationer kan rättas.',
    message_en: 'Only posted entries can be corrected.',
  },
  CANNOT_EDIT_NON_DRAFT: {
    httpStatus: 409,
    message_sv: 'Endast utkast kan redigeras. Bokförda verifikationer rättas med storno.',
    message_en: 'Only draft entries can be edited; posted entries are immutable and are corrected with storno.',
    remediation: {
      description: 'Use the correction (storno) flow to change a posted entry instead of editing it.',
    },
  },
  ENTRY_ALREADY_REVERSED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen har redan stornats av en annan användare. Ladda om sidan och försök igen.',
    message_en: 'Entry was already reversed by a concurrent operation.',
  },
  CURRENCY_REVALUATION_ALREADY_EXISTS: {
    httpStatus: 409,
    message_sv: 'En valutaomvärdering finns redan för denna period.',
    message_en: 'Currency revaluation already exists for this period.',
  },
  INVALID_MAPPING_RESULT: {
    httpStatus: 400,
    message_sv: 'Kontering saknas för transaktionen. Kontrollera bokföringsreglerna.',
    message_en: 'Mapping rules produced an invalid debit/credit account pair.',
  },
  DIMENSION_VALIDATION_FAILED: {
    httpStatus: 400,
    message_sv:
      'Ett angivet kostnadsställe/projekt finns inte i dimensionsregistret eller är arkiverat. Skapa värdet i registret först.',
    message_en:
      'One or more dimension codes on the entry lines are missing from the dimension registry or archived. details.issues lists each offending sie_dim_no/code.',
    remediation: {
      description:
        'Create the missing dimension value in the register (or re-activate the archived value), then retry. Only companies with dimensions enabled are validated; each issue in details.issues carries sie_dim_no, code and reason (unknown_dimension | unknown_value | archived_value).',
    },
  },
  MANDATORY_DIMENSION_MISSING: {
    httpStatus: 400,
    message_sv:
      'Ett eller flera konton kräver en dimension (t.ex. projekt eller kostnadsställe). Välj värden innan bokföring.',
    message_en:
      'One or more accounts require a dimension value. details.violations lists each account_number, sie_dim_no and dimension_name.',
    remediation: {
      description:
        'Tag every listed line with the required dimension value, then retry the commit.',
    },
  },
  BOOKKEEPING_DATABASE_ERROR: {
    httpStatus: 500,
    message_sv: 'Verifikationen kunde inte sparas. Försök igen.',
    message_en: 'Bookkeeping database operation failed.',
    retryable: true,
  },
  MEANINGLESS_CORRECTION: {
    httpStatus: 400,
    message_sv: 'Rättelsen motsvarar ingen ekonomisk händelse: det finns inget att rätta.',
    message_en: 'The correction represents no economic event: nothing to correct.',
  },
  NO_OPEN_PERIOD_FOR_DATE: {
    httpStatus: 400,
    message_sv:
      'Det finns ingen räkenskapsperiod som täcker det valda datumet. Skapa eller öppna räkenskapsåret först.',
    message_en: 'No fiscal period covers the selected date.',
    remediation: {
      description: 'Create or open the fiscal year that covers the date before retrying.',
      resource: 'Accounted://period/active',
    },
  },
  TARGET_PERIOD_CLOSED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsåret som täcker datumet är stängt (bokslut) och kan inte öppnas. Bokför i en öppen period i stället.',
    message_en: 'The fiscal year covering the date is closed and cannot be reopened.',
  },
  TARGET_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv: 'Räkenskapsperioden som täcker datumet är låst.',
    message_en: 'The fiscal period covering the date is locked.',
    remediation: {
      description:
        'Unlock the period (if status is "locked", not "closed") or use a date inside an open period.',
      tool: 'gnubok_unlock_period',
    },
  },
  PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Bokföringen är låst för denna period.',
    message_en: 'Period is locked or closed; entries cannot be added.',
    remediation: {
      description:
        'Either unlock the period via gnubok_unlock_period (if status is "locked", not "closed") or change the entry date to fall inside an open period.',
      tool: 'gnubok_unlock_period',
    },
  },
  PERIOD_NOT_LOCKED: {
    httpStatus: 400,
    message_sv: 'Perioden måste först låsas innan den kan stängas.',
    message_en: 'Period must be locked before it can be closed.',
    remediation: {
      description: 'Call gnubok_lock_period before closing.',
      tool: 'gnubok_lock_period',
    },
  },
  YEAR_END_NOT_RUN: {
    httpStatus: 400,
    message_sv: 'Bokslutsåtgärder måste utföras innan perioden kan stängas.',
    message_en: 'Year-end closing must be executed before the period can be closed.',
  },
  INVOICE_ALREADY_SENT: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan skickats eller betalats.',
    message_en: 'The invoice is already sent or paid.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 1: invoicing
// ─────────────────────────────────────────────────────────────────

const TRANSACTIONS: Record<string, StructuredErrorEntry> = {
  TX_EXCHANGE_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Kunde inte hämta växelkursen från Riksbanken. Försök igen om en stund: verifikationen måste bokföras i SEK.',
    message_en:
      'Could not fetch the exchange rate from Riksbanken. The verifikation must be posted in SEK.',
    retryable: true,
  },
}

const MATCH_INVOICE: Record<string, StructuredErrorEntry> = {
  MATCH_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  MATCH_INVOICE_BOOKING_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Fakturan är utställd i utländsk valuta men saknar växelkurs. Utan kursen går det inte att räkna fram kursvinst eller kursförlust. Komplettera fakturans växelkurs (exchange_rate) och försök igen.',
    message_en:
      'The foreign-currency invoice has no usable booking exchange rate on file (invoice.exchange_rate is missing, zero, or out of range), so the FX gain/loss (BAS 3960/7960) on settlement cannot be computed.',
    remediation: {
      description:
        'Set invoice.exchange_rate to the rate the receivable (1510) was booked at, then retry the payment. On an invoice that is not yet booked, POST /api/invoices/{id}/refresh-exchange-rate fetches the taxable-event rate from Riksbanken and fills it in. On an already-booked invoice that endpoint refuses (INVOICE_FX_REFRESH_BOOKED): the SEK amounts are in a verifikat and only storno or inline rättelse may change them.',
    },
  },
  MATCH_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Betalningsbeloppet är större än fakturans återstående belopp. Registrera högst det återstående beloppet.',
    message_en:
      'Payment amount exceeds the invoice remaining amount. Register at most the remaining amount.',
  },
}

const MATCH_SI: Record<string, StructuredErrorEntry> = {
  MATCH_SI_NOT_OPEN: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan har redan slutbetalats av en annan förfrågan.',
    message_en: 'Supplier invoice has already been fully paid or is no longer matchable.',
  },
  INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Kontantmetoden kan inte bokföra delbetalningar av en obokförd faktura automatiskt: hela fakturan bokförs vid betalning. Ta emot hela beloppet i en betalning, byt till faktureringsmetoden eller bokför betalningen manuellt som verifikation.',
    message_en:
      'The cash method cannot auto-book partial payments of an unbooked invoice: the generated entry always books the full invoice. Receive the full amount in one payment, switch to the accrual method, or book the payment manually as a journal entry.',
  },
  SI_CASH_PARTIAL_UNSUPPORTED: {
    httpStatus: 400,
    message_sv:
      'Kontantmetoden kan inte bokföra delbetalningar av en obokförd leverantörsfaktura automatiskt: hela fakturan bokförs vid betalning. Betala hela beloppet i en betalning eller bokför betalningen manuellt som verifikation.',
    message_en:
      'The cash method cannot auto-book partial payments of an unbooked supplier invoice: the generated entry always books the full invoice. Pay the full amount in one payment or book the payment manually as a journal entry.',
  },
}

const INVOICE: Record<string, StructuredErrorEntry> = {
  INVOICE_CUSTOMER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kunden kunde inte hittas.',
    message_en: 'Customer not found.',
  },
  INVOICE_CREATE_VAT_RULE_VIOLATION: {
    httpStatus: 400,
    message_sv: 'Momssatsen är inte tillåten för denna kundtyp.',
    message_en: 'The VAT rate is not allowed for this customer type.',
  },
  INVOICE_CREATE_REVENUE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Ett angivet bokföringskonto finns inte eller är inte ett aktivt balans- eller intäktskonto (klass 1-3).',
    message_en: 'A supplied posting account does not exist or is not an active balance-sheet or revenue account (class 1-3).',
  },
  INVOICE_CREATE_ARTICLE_INVALID: {
    httpStatus: 400,
    message_sv: 'En angiven artikel finns inte i företaget.',
    message_en: 'A supplied article does not exist in this company.',
  },
  INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT: {
    httpStatus: 400,
    message_sv: 'Ett balanskonto (klass 1-2) kan bara användas på rader utan moms. Använd ett intäktskonto (3xxx) för momspliktiga rader.',
    message_en: 'A balance-sheet account (class 1-2) can only be used on zero-VAT lines. Use a revenue account (3xxx) for VAT-bearing lines.',
  },
  INVOICE_CREATE_ROT_RUT_VALIDATION: {
    httpStatus: 400,
    message_sv: 'ROT/RUT-avdraget kunde inte valideras. Kontrollera personnummer och fastighetsbeteckning.',
    message_en: 'ROT/RUT deduction failed validation. Check personnummer and housing designation.',
  },
  INVOICE_CREATE_ACCRUAL_INVALID: {
    httpStatus: 400,
    message_sv: 'Periodisering kan inte användas här. Den kräver faktureringsmetoden och stöds inte för omvänd skattskyldighet, export eller proforma.',
    message_en: 'Periodisering cannot be used here. It requires the accrual method and is not supported for reverse charge, export, or proforma documents.',
  },
  ACCRUAL_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Periodiseringen kunde inte hittas.',
    message_en: 'Accrual schedule not found.',
  },
  ACCRUAL_DISSOLVE_FAILED: {
    httpStatus: 400,
    message_sv: 'Periodiseringen kunde inte lösas upp.',
    message_en: 'The accrual schedule could not be dissolved.',
  },
  ACCRUAL_NOT_ACTIVE: {
    httpStatus: 400,
    message_sv: 'Periodiseringen är inte aktiv.',
    message_en: 'The accrual schedule is not active.',
  },
  ACCRUAL_NOTHING_TO_DISSOLVE: {
    httpStatus: 400,
    message_sv: 'Det finns inget kvar att lösa upp.',
    message_en: 'There is nothing left to dissolve on this accrual schedule.',
  },
  INVOICE_CREATE_ROT_RUT_PERSONNUMMER_INVALID: {
    httpStatus: 400,
    message_sv: 'Personnumret för ROT/RUT-avdraget är ogiltigt.',
    message_en: 'The personnummer provided for the ROT/RUT deduction is invalid.',
  },
  // Rot/rut begäran om utbetalning (Skatteverkets husavdragstjänst)
  ROT_RUT_REQUEST_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Begäran om utbetalning hittades inte.',
    message_en: 'Payout request not found.',
  },
  ROT_RUT_NO_ELIGIBLE_INVOICES: {
    httpStatus: 400,
    message_sv: 'Ingen av de valda fakturorna kan ingå i filen. Se blockeringarna per faktura.',
    message_en: 'None of the selected invoices can be included in the file. See the per-invoice blockers.',
  },
  ROT_RUT_INVOICES_BLOCKED: {
    httpStatus: 400,
    message_sv: 'En eller flera valda fakturor kan inte ingå i filen. Åtgärda blockeringarna eller välj bort fakturorna.',
    message_en: 'One or more selected invoices cannot be included in the file. Fix the blockers or deselect the invoices.',
  },
  ROT_RUT_INVOICE_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Minst en faktura ingår redan i en aktiv begäran om utbetalning.',
    message_en: 'At least one invoice is already part of an active payout request.',
  },
  ROT_RUT_INVALID_STATUS_TRANSITION: {
    httpStatus: 400,
    message_sv: 'Statusändringen är inte tillåten för begäran i dess nuvarande läge.',
    message_en: 'The status transition is not allowed from the request current state.',
  },
  ROT_RUT_SETTLE_INVALID_STATE: {
    httpStatus: 400,
    message_sv: 'Utbetalningen kan bara bokföras för en inskickad begäran som inte redan är bokförd.',
    message_en: 'The payout can only be booked for a submitted request that is not already settled.',
  },
  ROT_RUT_FILE_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Filen kunde inte skapas.',
    message_en: 'The payout file could not be created.',
  },
  ROT_RUT_BESLUT_WRONG_COMPANY: {
    httpStatus: 400,
    message_sv:
      'Beslutsfilens utförare matchar inte företagets organisationsnummer. Kontrollera att filen laddades ner för rätt företag.',
    message_en:
      "The decision file's utförare does not match the company's organisation number. Check that the file was downloaded for the right company.",
  },
  INVOICE_CREATE_INSERT_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte sparas.',
    message_en: 'Invoice insert failed.',
  },
  INVOICE_CREATE_ITEMS_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturaraderna kunde inte sparas.',
    message_en: 'Invoice items insert failed.',
  },
  INVOICE_CREATE_NUMBER_ASSIGN_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tilldela fakturanummer vid skapande.',
    message_en: 'Failed to assign invoice number on create.',
  },
  INVOICE_CREDIT_ORIGINAL_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Ursprungsfakturan kunde inte hittas.',
    message_en: 'Original invoice not found.',
  },
  INVOICE_CREDIT_NOT_INVOICE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor kan endast skapas från riktiga fakturor.',
    message_en: 'Credit notes can only be created from standard invoices.',
  },
  INVOICE_CREDIT_ALREADY_CREDITED: {
    httpStatus: 400,
    message_sv: 'Fakturan har redan krediterats.',
    message_en: 'Invoice has already been credited.',
  },
  INVOICE_CREDIT_NOT_SENT: {
    httpStatus: 400,
    message_sv: 'Endast skickade, betalda eller förfallna fakturor kan krediteras.',
    message_en: 'Only sent, paid, or overdue invoices can be credited.',
  },
  INVOICE_CREDIT_ISSUE_INCOMPLETE: {
    httpStatus: 500,
    message_sv:
      'Kreditfakturan kunde inte utfärdas färdigt. Försök igen.',
    message_en:
      'The credit note could not be issued completely. Please try again.',
  },
  INVOICE_CREDIT_REPAIR_REQUIRED: {
    httpStatus: 500,
    message_sv: 'Kreditfakturans verifikat skapades, men utfärdandet måste slutföras. Försök igen eller kontakta support.',
    message_en: 'The credit-note voucher was created, but issuance must be completed. Retry or contact support.',
  },
  INVOICE_CREDIT_ALREADY_ISSUED: {
    httpStatus: 409,
    message_sv: 'Kreditfakturan har redan utfärdats.',
    message_en: 'The credit note has already been issued.',
  },
  INVOICE_MARK_SENT_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Fakturan kan inte markeras som skickad i nuvarande status.',
    message_en: 'The invoice cannot be marked as sent in its current status.',
  },
  INVOICE_MARK_SENT_STATUS_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturans status kunde inte uppdateras.',
    message_en: 'The invoice status could not be updated.',
  },
  INVOICE_MARK_SENT_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan ändrades av en annan begäran. Ladda om och försök igen.',
    message_en: 'The invoice was changed by another request. Reload and retry.',
  },
  INVOICE_MARK_SENT_LINES_UNBALANCED: {
    httpStatus: 400,
    message_sv: 'Verifikationsraderna är inte balanserade (debet ≠ kredit).',
    message_en: 'Custom journal lines do not balance.',
  },
  INVOICE_MARK_SENT_LINES_INVALID: {
    httpStatus: 400,
    message_sv: 'Verifikationsraderna kan inte användas: en rad har både debet och kredit, eller använder ett interimskonto (29xx). Använd periodisering på fakturaraden istället.',
    message_en: 'Custom journal lines are invalid: a row carries both debit and credit, or uses a 29xx interim account. Use line-level periodisering instead.',
  },
  INVOICE_MARK_SENT_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte bokföras och ligger kvar som utkast.',
    message_en: 'The invoice could not be posted and remains a draft.',
  },
  INVOICE_MARK_SENT_REPAIR_REQUIRED: {
    httpStatus: 500,
    message_sv: 'Verifikatet skapades, men kopplingen till fakturan måste återställas. Kontakta support.',
    message_en: 'The voucher was created, but its invoice link must be repaired. Contact support.',
  },
  INVOICE_BOOK_ALREADY_BOOKED: {
    httpStatus: 400,
    message_sv: 'Fakturan är redan bokförd.',
    message_en: 'The invoice is already booked.',
  },
  INVOICE_BOOK_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Endast skickade eller förfallna fakturor kan bokföras i efterhand.',
    message_en: 'Only sent or overdue invoices can be booked afterwards.',
  },
  INVOICE_BOOK_NOT_BOOKABLE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor och andra dokumenttyper bokförs inte via detta steg.',
    message_en: 'Credit notes and other document types are not booked through this step.',
  },
  INVOICE_BOOK_CASH_METHOD: {
    httpStatus: 400,
    message_sv: 'Vid kontantmetoden bokförs fakturan när den betalas.',
    message_en: 'Under the cash method the invoice is booked when it is paid.',
  },
  INVOICE_BOOK_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Inget öppet räkenskapsår täcker fakturadatumet. Skapa räkenskapsåret först.',
    message_en: 'No open fiscal period covers the invoice date. Create the fiscal year first.',
  },
  INVOICE_BOOK_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Fakturan bokfördes samtidigt av en annan begäran. Ladda om sidan.',
    message_en: 'The invoice was booked concurrently by another request. Reload the page.',
  },
  INVOICE_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte bokföras.',
    message_en: 'Failed to book the invoice.',
  },
  // Raised by lib/bookkeeping/invoice-entries.ts when a foreign-currency
  // customer invoice reaches a booking path with no exchange rate. Items carry
  // no per-item SEK column, so the rate is the only honest source; booking 1:1
  // would still balance (the 1510 debit is derived from the credits) while
  // understating ruta 05 and ruta 10 of the momsdeklaration. Sales-side twin of
  // SI_FX_RATE_MISSING.
  INVOICE_FX_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Fakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs: utan kurs kan beloppen inte räknas om till kronor och momsen blir fel.',
    message_en:
      'The invoice is in a foreign currency but has no exchange rate on file. Set the invoice exchange rate before booking; without it the amounts cannot be translated to SEK and the output VAT would be understated.',
    remediation: {
      description:
        'Set exchange_rate on the invoice (the rate at the taxable-event date) and retry. On an unbooked invoice, POST /api/invoices/{id}/refresh-exchange-rate fetches it from Riksbanken.',
    },
  },
  INVOICE_SEND_COMPANY_SETTINGS_MISSING: {
    httpStatus: 404,
    message_sv: 'Företagsinställningar saknas.',
    message_en: 'Company settings are missing.',
  },
  INVOICE_SEND_PAYMENT_ACCOUNT_MISSING: {
    httpStatus: 400,
    message_sv: 'Fakturan saknar ett betalningskonto för vald valuta. Lägg till kontot under Fakturering innan du skapar PDF-filen eller markerar fakturan som skickad.',
    message_en: 'The invoice has no payment account for its currency. Add the account under Invoicing before generating the PDF or marking the invoice as sent.',
    remediation: {
      description: 'Lägg till ett betalningskonto med IBAN för fakturans valuta under Fakturering.',
    },
  },
  INVOICE_PDF_RENDER_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturans PDF kunde inte skapas.',
    message_en: 'Invoice PDF rendering failed.',
  },
  INVOICE_PAID_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  INVOICE_PAID_NOT_PAYABLE: {
    httpStatus: 400,
    message_sv: 'Fakturan kan inte markeras som betald i nuvarande status.',
    message_en: 'Invoice is not in a payable status.',
  },
  INVOICE_PAID_LINES_UNBALANCED: {
    httpStatus: 400,
    message_sv: 'Verifikationsraderna är inte balanserade (debet ≠ kredit).',
    message_en: 'Custom journal lines do not balance.',
  },
  INVOICE_PAID_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Ingen öppen räkenskapsperiod för betalningsdatumet.',
    message_en: 'No open fiscal period covers the payment date.',
  },
  INVOICE_PAID_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan betalats av en annan förfrågan.',
    message_en: 'Invoice was already paid by another request.',
  },
  INVOICE_PAID_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte bokföra betalningen.',
    message_en: 'Failed to create payment journal entry.',
  },
  INVOICE_DELETE_NOT_DRAFT: {
    httpStatus: 400,
    message_sv: 'Endast utkast kan tas bort. Bokförda fakturor måste krediteras istället.',
    message_en: 'Only draft invoices can be deleted; non-drafts must be credited.',
    remediation: {
      description: 'Issue a credit note instead of deleting a posted invoice.',
    },
  },
  INVOICE_UPDATE_NOT_DRAFT: {
    httpStatus: 409,
    message_sv: 'Endast utkast kan ändras. Bokförda fakturor är oföränderliga: utfärda en kreditfaktura istället.',
    message_en: 'Only draft invoices can be updated. Issued invoices are immutable: issue a credit note instead.',
    remediation: {
      description: 'Issue a credit note via POST /invoices/{id}:credit and create a fresh invoice with the corrected details.',
    },
  },
  INVOICE_CANCEL_RACE: {
    httpStatus: 409,
    message_sv: 'Fakturan ändrades samtidigt och kunde inte makuleras. Ladda om och försök igen.',
    message_en: 'Invoice was modified concurrently and could not be cancelled. Reload and retry.',
  },
  INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  // POST /api/invoices/{id}/refresh-exchange-rate: the repair path for a
  // foreign-currency invoice whose SEK conversion is missing or was stamped
  // from the wrong day's rate. It works on sent invoices (PATCH does not), but
  // stops at the verifikat.
  INVOICE_FX_REFRESH_BOOKED: {
    httpStatus: 409,
    message_sv:
      'Fakturan är redan bokförd, så växelkursen kan inte räknas om här. Beloppen i kronor sitter i verifikatet och får bara ändras genom rättelse: makulera med storno och bokför om, eller rätta verifikatet inifrån (BFL 5 kap. 5 §).',
    message_en:
      'The invoice already has a verifikat, so its SEK conversion cannot be re-rated here. The SEK amounts are posted entries and may only be changed through one of the two sanctioned rättelse tracks (BFL 5 kap 5 §): storno + correcting entry, or the inline rättelse RPCs on an open unlocked period.',
    remediation: {
      description:
        'Reverse the invoice verifikat (gnubok_reverse_journal_entry) and rebook it with the correct rate, or correct it inline via gnubok_correct_entry while the period is still open and unlocked. Never update invoice.exchange_rate behind a posted entry.',
      tool: 'gnubok_reverse_journal_entry',
    },
  },
  INVOICE_FX_REFRESH_PERIOD_LOCKED: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsperioden för fakturadatumet är låst eller stängd, så växelkursen kan inte uppdateras. Öppna perioden eller rätta med storno i en öppen period.',
    message_en:
      'The fiscal period covering the invoice date is locked or closed, so the exchange rate cannot be updated. details.period_status carries the verdict; lookup_failed: true means the lock state could not be read and the request was refused fail-closed.',
    remediation: {
      description:
        'Unlock the period via gnubok_unlock_period (only if the status is "locked", not "closed"), then retry. Past a close, the correction belongs in an open period as a storno.',
      tool: 'gnubok_unlock_period',
    },
  },
  INVOICE_FX_REFRESH_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Kunde inte hämta växelkursen från Riksbanken för leverans-/fakturadatumet. Fakturan är oförändrad: en gissad kurs får inte bokföras. Försök igen om en stund.',
    message_en:
      'No Riksbanken observation could be retrieved for the taxable-event date (delivery_date, falling back to invoice_date) and no cached rate was available either. The invoice was left unchanged rather than converted at an invented rate.',
    retryable: true,
    remediation: {
      description:
        'Retry once Riksbanken responds. The permitted rate sources are the Nasdaq OMX mid-rate published by Riksbanken or the latest ECB rate (ML 8 kap 21-23 §); never substitute an estimate.',
    },
  },
  INVOICE_FINALIZE_NOT_DRAFT: {
    httpStatus: 409,
    message_sv: 'Endast onumrerade utkast kan skapas. Fakturan har redan ett nummer eller är inte ett utkast.',
    message_en: 'Only unnumbered drafts can be finalized; this invoice already has a number or is not a draft.',
  },
  INVOICE_FINALIZE_INCOMPLETE: {
    httpStatus: 500,
    message_sv: 'Fakturanumret tilldelades men fakturan kunde inte läsas tillbaka. Ladda om sidan och kontrollera fakturan.',
    message_en: 'The invoice number was assigned but the invoice could not be re-read. Reload the page and verify the invoice.',
  },
  INVOICE_RECURRING_UPDATE_PARTIAL: {
    httpStatus: 500,
    message_sv:
      'Ändringen av det återkommande schemat kunde inte slutföras och schemat kan ha hamnat i ett halvsparat läge. Öppna schemat och kontrollera både fält och rader innan du sparar igen.',
    message_en:
      'The recurring schedule update failed and the compensating rollback did not fully apply: the schedule may be left in a partial state (header fields and items out of sync). Inspect the schedule fields and items before retrying.',
  },
}

const SUPPLIER_INVOICE: Record<string, StructuredErrorEntry> = {
  SI_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantörsfakturan kunde inte hittas.',
    message_en: 'Supplier invoice not found.',
  },
  SI_APPROVE_NOT_REGISTERED: {
    httpStatus: 400,
    message_sv: 'Fakturan är redan godkänd eller kan inte godkännas i nuvarande status.',
    message_en: 'The invoice is already approved, or cannot be approved in its current status.',
  },
  SI_EDIT_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Leverantörsfakturan ändrades av någon annan (eller av den dagliga förfallokontrollen) medan du redigerade. Ladda om fakturan och försök igen.',
    message_en:
      'The supplier invoice changed elsewhere (or in the daily overdue check) while you were editing. Reload the invoice and try again.',
  },
  SI_EDIT_INVALID_STATUS: {
    httpStatus: 400,
    message_sv:
      'Bara obetalda leverantörsfakturor kan redigeras. Betalda, krediterade och återförda fakturor rättas genom kreditfaktura eller storno.',
    message_en:
      'Only unsettled supplier invoices can be edited. Paid, credited and reversed invoices are corrected with a credit note or a storno.',
  },
  SI_EDIT_VERIFIKAT_LOCKED: {
    httpStatus: 400,
    message_sv:
      'Fakturadatum och fakturanummer står på det bokförda verifikatet och kan inte ändras här. ' +
      'Rätta verifikatet (rättelse i öppen period, annars storno + ny bokföring) eller kreditera fakturan. ' +
      'Förfallodatum, betalningsreferens och anteckningar går fortfarande att ändra.',
    message_en:
      'Invoice date and invoice number are part of the posted verifikat and cannot be changed here. ' +
      'Correct the entry instead (inline rättelse in an open period, otherwise storno + re-book), or credit the invoice. ' +
      'due_date, payment_reference and notes remain editable.',
    remediation: {
      description:
        'Correct the registration verifikat through a sanctioned rättelse path, or credit the supplier invoice and register a corrected one.',
      tool: 'gnubok_correct_entry',
    },
  },
  SI_APPROVE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte godkänna leverantörsfakturan.',
    message_en: 'Failed to update supplier invoice status to approved.',
  },
  SI_BOOK_ALREADY_BOOKED: {
    httpStatus: 400,
    message_sv: 'Leverantörsfakturan är redan bokförd.',
    message_en: 'The supplier invoice is already booked.',
  },
  SI_BOOK_INVALID_STATUS: {
    httpStatus: 400,
    message_sv: 'Endast registrerade, godkända eller förfallna fakturor kan bokföras i efterhand.',
    message_en: 'Only registered, approved or overdue invoices can be booked afterwards.',
  },
  SI_BOOK_NOT_BOOKABLE: {
    httpStatus: 400,
    message_sv: 'Kreditfakturor bokförs inte via detta steg.',
    message_en: 'Credit notes are not booked through this step.',
  },
  SI_BOOK_CASH_METHOD: {
    httpStatus: 400,
    message_sv: 'Vid kontantmetoden bokförs fakturan när den betalas.',
    message_en: 'Under the cash method the invoice is booked when it is paid.',
  },
  SI_BOOK_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv: 'Inget öppet räkenskapsår täcker fakturadatumet. Skapa räkenskapsåret först.',
    message_en: 'No open fiscal period covers the invoice date. Create the fiscal year first.',
  },
  SI_BOOK_CONFLICT: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan bokfördes samtidigt av en annan begäran. Ladda om sidan.',
    message_en: 'The supplier invoice was booked concurrently by another request. Reload the page.',
  },
  SI_BOOK_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantörsfakturan kunde inte bokföras.',
    message_en: 'Failed to book the supplier invoice.',
  },
  // Raised by lib/bookkeeping/supplier-invoice-entries.ts when a
  // foreign-currency invoice reaches a booking path with no exchange rate.
  // Booking it 1:1 would balance but understate the fiktiv moms on 2614/2645
  // and therefore rutorna 20-24 + 30-32 of the momsdeklaration.
  SI_FX_RATE_MISSING: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan är i utländsk valuta men saknar växelkurs. Ange fakturans växelkurs innan den bokförs: utan kurs kan beloppen inte räknas om till kronor och momsen blir fel.',
    message_en:
      'The supplier invoice is in a foreign currency but has no exchange rate on file. Set the invoice exchange rate before booking; without it the amounts cannot be translated to SEK and the reverse-charge VAT would be understated.',
    remediation: {
      description:
        'Set exchange_rate on the supplier invoice (the rate at the invoice date) and retry the booking.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 2: periods, year-end, reports
// ─────────────────────────────────────────────────────────────────

const PERIOD: Record<string, StructuredErrorEntry> = {
  PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'Fiscal period not found.',
  },
  PERIOD_LOCK_FAILED: {
    httpStatus: 400,
    message_sv: 'Perioden kunde inte låsas.',
    message_en: 'Failed to lock period.',
  },
  PERIOD_LOCK_HAS_DRAFTS: {
    httpStatus: 400,
    message_sv: 'Perioden innehåller verifikationsutkast som måste bokföras eller raderas innan låsning.',
    message_en: 'Period contains draft journal entries.',
  },
  PERIOD_LOCK_ALREADY_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är redan låst.',
    message_en: 'Period is already locked.',
  },
  PERIOD_UNLOCK_NOT_LOCKED: {
    httpStatus: 409,
    message_sv: 'Perioden är inte låst.',
    message_en: 'Period is not locked.',
  },
  PERIOD_UNLOCK_CLOSED: {
    httpStatus: 409,
    message_sv: 'Ett stängt räkenskapsår kan inte låsas upp.',
    message_en: 'A closed fiscal year cannot be unlocked.',
  },
  // Retired 2026-07-26: PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS. Creating the
  // next räkenskapsår while a prior one is still fully open is no longer an
  // error at all: BFL 5 kap 2 § forces the new year's affärshändelser to be
  // booked within weeks (which needs a räkenskapsår covering them) while BFL
  // 6 kap gives the prior year six months to be finished, so running both in
  // parallel is the mandated state, not an edge case. The detection now rides
  // along as a non-blocking `warnings: [{ code: 'PRIOR_FISCAL_YEAR_STILL_OPEN',
  // message }]` on the 200 (app/api/bookkeeping/fiscal-periods), which needs no
  // registry entry: warnings are not thrown errors. Do not re-add this code.
}

const YEAR_END: Record<string, StructuredErrorEntry> = {
  YEAR_END_PREVIEW_FAILED: {
    httpStatus: 400,
    message_sv: 'Bokslutsförhandsgranskningen misslyckades.',
    message_en: 'Failed to preview year-end closing.',
  },
  YEAR_END_FAILED: {
    httpStatus: 400,
    message_sv: 'Bokslutet kunde inte verkställas.',
    message_en: 'Failed to execute year-end closing.',
  },
  YEAR_END_PRIOR_PERIOD_OPEN: {
    httpStatus: 400,
    message_sv: 'En tidigare period är fortfarande öppen. Stäng den först.',
    message_en: 'A prior fiscal period is still open.',
  },
  YEAR_END_UNBALANCED_TRIAL: {
    httpStatus: 400,
    message_sv: 'Resultaträkningens debet och kredit balanserar inte. Granska verifikationerna innan bokslut.',
    message_en: 'Trial balance does not balance.',
  },
  YEAR_END_NEXT_PERIOD_HAS_IB: {
    httpStatus: 400,
    message_sv: 'Nästa räkenskapsperiod har redan ingående balanser bokförda. Storno dem innan du kör om bokslutet.',
    message_en: 'Next fiscal period already has opening balances posted; reverse them before re-running year-end.',
  },
  YEAR_END_NO_ACTIVITY: {
    httpStatus: 409,
    message_sv:
      'Räkenskapsperioden saknar bokförd aktivitet och kan därför inte skapa en bokslutsverifikation. Bokför eller importera periodens affärshändelser innan du kör bokslutet.',
    message_en:
      'The fiscal period has no posted activity, so no year-end voucher can be created. Post or import the period activity before running year-end closing.',
    retryable: false,
  },
}

const OPENING_BAL: Record<string, StructuredErrorEntry> = {
  OPENING_BAL_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'Fiscal period not found.',
  },
}

const FX: Record<string, StructuredErrorEntry> = {
  FX_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden kunde inte hittas.',
    message_en: 'Fiscal period not found.',
  },
  FX_PERIOD_CLOSED: {
    httpStatus: 400,
    message_sv: 'Perioden är redan stängd. Valutaomvärdering kan inte köras.',
    message_en: 'Period is already closed; currency revaluation cannot be run.',
  },
  FX_FAILED: {
    httpStatus: 400,
    message_sv: 'Valutaomvärderingen misslyckades.',
    message_en: 'Currency revaluation failed.',
  },
  FX_CLOSING_RATE_UNAVAILABLE: {
    httpStatus: 502,
    message_sv:
      'Ingen valutakurs från Riksbanken finns för balansdagen. Valutaomvärderingen har inte bokförts: en uppskattad kurs får inte bokföras mot 3960/7960 (ÅRL 4 kap. 13 §). Försök igen när kursen är publicerad.',
    message_en:
      'No Riksbanken observation is available for the closing date. The revaluation was refused rather than posted from an estimated rate; details.missingRates lists each currency and date.',
    retryable: true,
    remediation: {
      description:
        'Retry once Riksbanken has published the closing-date rate, or run the revaluation for a closing date that has a published observation.',
    },
  },
}

const REPORT: Record<string, StructuredErrorEntry> = {
  REPORT_PERIOD_REQUIRED: {
    httpStatus: 400,
    message_sv: 'period_id krävs.',
    message_en: 'period_id query parameter is required.',
  },
  REPORT_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Rapporten kunde inte genereras.',
    message_en: 'Failed to generate the report.',
  },
}

const VAT_REPORT: Record<string, StructuredErrorEntry> = {
  VAT_REPORT_MISSING_PARAMS: {
    httpStatus: 400,
    message_sv: 'periodType, year och period krävs.',
    message_en: 'periodType, year and period query parameters are required.',
  },
  VAT_REPORT_INVALID_PERIOD_TYPE: {
    httpStatus: 400,
    message_sv: 'periodType måste vara monthly, quarterly eller yearly.',
    message_en: 'periodType must be one of monthly, quarterly, yearly.',
  },
  VAT_REPORT_INVALID_YEAR: {
    httpStatus: 400,
    message_sv: 'year måste vara ett giltigt årtal mellan 2000 och 2100.',
    message_en: 'year must be a number between 2000 and 2100.',
  },
  VAT_REPORT_INVALID_PERIOD: {
    httpStatus: 400,
    message_sv: 'period är ogiltig för vald periodtyp.',
    message_en: 'period is invalid for the chosen period type.',
  },
  VAT_REPORT_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Momsdeklarationen kunde inte beräknas.',
    message_en: 'Failed to calculate VAT declaration.',
  },
}

const PS_REPORT: Record<string, StructuredErrorEntry> = {
  PS_REPORT_MISSING_PARAMS: {
    httpStatus: 400,
    message_sv: 'periodType, year och period krävs.',
    message_en: 'periodType, year and period query parameters are required.',
  },
  PS_REPORT_INVALID_PERIOD_TYPE: {
    httpStatus: 400,
    message_sv: 'periodType måste vara monthly eller quarterly.',
    message_en: 'periodType must be monthly or quarterly.',
  },
  PS_REPORT_INVALID_YEAR: {
    httpStatus: 400,
    message_sv: 'year måste vara ett giltigt årtal mellan 2000 och 2100.',
    message_en: 'year must be a number between 2000 and 2100.',
  },
  PS_REPORT_INVALID_PERIOD: {
    httpStatus: 400,
    message_sv: 'period är ogiltig för vald periodtyp.',
    message_en: 'period is invalid for the chosen period type.',
  },
  PS_REPORT_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Periodisk sammanställning kunde inte beräknas.',
    message_en: 'Failed to generate periodisk sammanställning.',
  },
  PS_REPORT_CSV_BLOCKED_BY_ERRORS: {
    httpStatus: 400,
    message_sv: 'CSV kan inte laddas ner. Åtgärda blockerande fel först.',
    message_en: 'CSV download blocked by validation errors. Fix them first.',
  },
  PS_REPORT_MISSING_FILER_INFO: {
    httpStatus: 400,
    message_sv: 'Kontaktuppgifter saknas. Fyll i namn, telefon och e-post under Inställningar.',
    message_en: 'Tax contact information is missing on company_settings.',
  },
}

const SIE_EXPORT: Record<string, StructuredErrorEntry> = {
  SIE_EXPORT_COMPANY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Företagsinställningar saknas: SIE-exporten kan inte skapas.',
    message_en: 'Company settings missing; SIE export cannot be generated.',
  },
  SIE_EXPORT_FAILED: {
    httpStatus: 500,
    message_sv: 'SIE-exporten misslyckades.',
    message_en: 'Failed to generate SIE export.',
  },
}

const TAX_DECL: Record<string, StructuredErrorEntry> = {
  TAX_DECL_GENERATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Skattedeklarationen kunde inte genereras.',
    message_en: 'Failed to generate tax declaration.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 3: imports (SIE, bank-file, opening-balance)
// ─────────────────────────────────────────────────────────────────

const SIE_IMPORT: Record<string, StructuredErrorEntry> = {
  SIE_PARSE_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad i förfrågan.',
    message_en: 'No file attached to the request.',
  },
  SIE_PARSE_INVALID_TYPE: {
    httpStatus: 400,
    message_sv: 'Filtypen stöds inte. Ladda upp en fil med ändelsen .sie eller .se.',
    message_en: 'Unsupported file type; upload a .sie or .se file.',
  },
  SIE_PARSE_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 50 MB.',
    message_en: 'File exceeds the 50 MB size limit.',
  },
  SIE_PARSE_EMPTY: {
    httpStatus: 400,
    message_sv: 'Filen är tom (0 bytes). Kontrollera exporten från bokföringsprogrammet.',
    message_en: 'File is empty.',
  },
  SIE_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka SIE-filen. Filen kan vara skadad eller i ett format som inte stöds.',
    message_en: 'Failed to parse the SIE file.',
  },
  SIE_PARSE_VALIDATION_FAILED: {
    httpStatus: 400,
    message_sv: 'SIE-filen innehåller valideringsfel som måste åtgärdas innan import.',
    message_en: 'SIE file failed validation.',
  },
  SIE_DUPLICATE_FILE: {
    httpStatus: 409,
    message_sv: 'Den här filen har redan importerats.',
    message_en: 'File has already been imported.',
  },
  SIE_DUPLICATE_PERIOD: {
    httpStatus: 409,
    message_sv: 'En SIE-import för ett överlappande räkenskapsår finns redan.',
    message_en: 'An SIE import for an overlapping fiscal period already exists.',
  },
  SIE_IMPORT_UNMAPPED_ACCOUNTS: {
    httpStatus: 400,
    message_sv: 'Vissa konton saknar mappning. Gå tillbaka till kontomappningssteget och koppla alla konton.',
    message_en: 'One or more accounts have no mapping target.',
    remediation: { description: 'Map every source account to a BAS account before importing.' },
  },
  SIE_IMPORT_ACCOUNT_ACTIVATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte aktivera konton i kontoplanen. Kontrollera att kontona inte redan finns med andra inställningar.',
    message_en: 'Failed to activate mapped accounts in the chart of accounts.',
  },
  SIE_IMPORT_FAILED: {
    httpStatus: 400,
    message_sv: 'Importen slutfördes med fel. Se detaljerna nedan.',
    message_en: 'SIE import completed with errors.',
  },
  SIE_IMPORT_UNEXPECTED: {
    httpStatus: 500,
    message_sv: 'Importen avbröts oväntat. Ingen data har sparats.',
    message_en: 'Unexpected error during SIE import; no data was committed.',
  },
  SIE_REPLACE_FAILED: {
    httpStatus: 400,
    message_sv: 'SIE-importen kunde inte ersättas.',
    message_en: 'Failed to replace SIE import.',
  },
  SIE_REPLACE_FORBIDDEN: {
    httpStatus: 403,
    message_sv: 'Endast ägare eller administratörer kan ersätta en SIE-import.',
    message_en: 'Only company owners and admins can replace an SIE import.',
  },
  SIE_UNDO_FAILED: {
    httpStatus: 400,
    message_sv: 'SIE-importen kunde inte ångras.',
    message_en: 'Failed to undo SIE import.',
  },
  SIE_IMPORT_DUPLICATE: {
    httpStatus: 409,
    message_sv: 'Den här SIE-filen har redan importerats.',
    message_en: 'This SIE file has already been imported.',
  },
}

const OPENING_BALANCE_IMPORT: Record<string, StructuredErrorEntry> = {
  OB_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad.',
    message_en: 'No file attached.',
  },
  OB_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  OB_INVALID_FORMAT: {
    httpStatus: 400,
    message_sv: 'Filformatet stöds inte. Tillåtna format: .xlsx, .xls, .csv, .ods.',
    message_en: 'Unsupported file format.',
  },
  OB_INVALID_COLUMN_OVERRIDES: {
    httpStatus: 400,
    message_sv: 'Ogiltig kolumnmappning.',
    message_en: 'Invalid column overrides JSON.',
  },
  OB_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka filen.',
    message_en: 'Failed to parse the opening balance file.',
  },
  OB_PERIOD_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Räkenskapsperioden hittades inte.',
    message_en: 'Fiscal period not found.',
  },
  OB_PERIOD_CLOSED: {
    httpStatus: 400,
    message_sv: 'Räkenskapsperioden är stängd.',
    message_en: 'Fiscal period is closed.',
  },
  OB_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Räkenskapsperioden är låst.',
    message_en: 'Fiscal period is locked.',
  },
  OB_COMPANY_LOCK_DATE: {
    httpStatus: 409,
    message_sv:
      'Bokföringen är låst t.o.m. ett låsdatum som täcker periodens start — ingående balanser kan inte korrigeras. Ta bort eller flytta låsdatumet under Inställningar → Bokföring och försök igen.',
    message_en:
      'The company-wide bookkeeping lock date covers the period start — opening balances cannot be corrected. Remove or move the lock date under Settings → Bookkeeping and try again.',
    remediation: {
      description:
        'Clear or move the bookkeeping lock date (company_settings.bookkeeping_locked_through) to a date before the period start, then retry the correction.',
    },
  },
  OB_PERIOD_ALREADY_HAS_BALANCES: {
    httpStatus: 409,
    message_sv: 'Räkenskapsperioden har redan ingående balanser.',
    message_en: 'Fiscal period already has opening balances set.',
  },
  OB_TOO_FEW_LINES: {
    httpStatus: 400,
    message_sv: 'Minst två rader med belopp krävs.',
    message_en: 'At least two lines with amounts are required.',
  },
  OB_PNL_ACCOUNT: {
    httpStatus: 400,
    message_sv: 'Resultatkonton (klass 3-8) kan inte användas i ingående balanser.',
    message_en: 'Profit & loss accounts (class 3-8) are not allowed in opening balances.',
  },
  OB_UNBALANCED: {
    httpStatus: 400,
    message_sv: 'Debet och kredit balanserar inte.',
    message_en: 'Opening balance debits and credits do not match.',
  },
  OB_ACCOUNT_ACTIVATION_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte aktivera konton i kontoplanen.',
    message_en: 'Failed to activate accounts in the chart of accounts.',
  },
  OB_EXECUTE_FAILED: {
    httpStatus: 500,
    message_sv: 'Importen misslyckades.',
    message_en: 'Opening balance import failed.',
  },
  OB_CORRECT_NO_EXISTING: {
    httpStatus: 409,
    message_sv: 'Perioden har inga ingående balanser att korrigera. Bokför dem först.',
    message_en: 'The period has no opening balances to correct. Book them first.',
  },
  OB_CORRECT_YEAR_END_EXISTS: {
    httpStatus: 409,
    message_sv:
      'Perioden har ett bokslut. Återför bokslutet och öppna perioden innan ingående balanser kan korrigeras.',
    message_en:
      'The period has a year-end close. Reverse the close and reopen the period before opening balances can be corrected.',
  },
  OB_CORRECT_FAILED: {
    httpStatus: 500,
    message_sv: 'Korrigeringen av ingående balanser misslyckades.',
    message_en: 'Opening balance correction failed.',
  },
}

const REGISTER_IMPORT: Record<string, StructuredErrorEntry> = {
  REG_IMPORT_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad.',
    message_en: 'No file attached.',
  },
  REG_IMPORT_FILE_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor. Maxstorlek är 10 MB.',
    message_en: 'File exceeds the 10 MB size limit.',
  },
  REG_IMPORT_INVALID_FORMAT: {
    httpStatus: 400,
    message_sv: 'Filformatet stöds inte. Tillåtna format: .xlsx, .xls, .csv, .ods.',
    message_en: 'Unsupported file format.',
  },
  REG_IMPORT_INVALID_COLUMN_OVERRIDES: {
    httpStatus: 400,
    message_sv: 'Ogiltig kolumnmappning.',
    message_en: 'Invalid column overrides JSON.',
  },
  REG_IMPORT_PARSE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte tolka filen.',
    message_en: 'Failed to parse the register file.',
  },
  REG_IMPORT_NO_ROWS: {
    httpStatus: 400,
    message_sv: 'Inga giltiga rader hittades i filen.',
    message_en: 'No valid rows found in the file.',
  },
  REG_IMPORT_EXECUTE_FAILED: {
    httpStatus: 500,
    message_sv: 'Importen misslyckades.',
    message_en: 'Register import failed.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Wave 4: documents, masters, salary, company, API keys
// ─────────────────────────────────────────────────────────────────

const DOCUMENT: Record<string, StructuredErrorEntry> = {
  DOC_UPLOAD_NO_FILE: {
    httpStatus: 400,
    message_sv: 'Ingen fil bifogad.',
    message_en: 'No file attached.',
  },
  DOC_UPLOAD_TOO_LARGE: {
    httpStatus: 400,
    message_sv: 'Filen är för stor.',
    message_en: 'Uploaded file exceeds the size limit.',
  },
  DOC_UPLOAD_UNSUPPORTED_TYPE: {
    httpStatus: 400,
    message_sv: 'Filtypen stöds inte.',
    message_en: 'Unsupported file type.',
  },
  DOC_UPLOAD_INVALID_CONTENT: {
    httpStatus: 400,
    message_sv: 'Filen kunde inte läsas som en giltig PDF eller bild. Kontrollera att filen inte är skadad.',
    message_en: 'The file could not be read as a valid PDF or image. Check that the file is not corrupted.',
  },
  DOC_UPLOAD_STORAGE_FAILED: {
    httpStatus: 500,
    message_sv: 'Filen kunde inte sparas.',
    message_en: 'Document storage failed.',
  },
  DOC_UPLOAD_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Det går inte att bifoga underlag till verifikationer i en låst eller stängd period.',
    message_en: 'Cannot attach documents to entries in a locked or closed fiscal period.',
  },
  DOC_DOWNLOAD_FAILED: {
    httpStatus: 500,
    message_sv: 'Det gick inte att skapa nedladdningslänken.',
    message_en: 'Failed to create signed download URL.',
  },
  DOC_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dokumentet kunde inte hittas.',
    message_en: 'Document not found.',
  },
  DOC_LINK_ENTRY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  DOC_LINK_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Dokumentet är redan kopplat till en verifikation.',
    message_en: 'Document is already linked to a journal entry.',
  },
  DOC_LINK_FAILED: {
    httpStatus: 500,
    message_sv: 'Kopplingen misslyckades.',
    message_en: 'Failed to link document to journal entry.',
  },
}

// Document inbox (invoice_inbox_items): the core Underlag surface.
const INBOX: Record<string, StructuredErrorEntry> = {
  INBOX_ITEM_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Underlaget kunde inte hittas i inkorgen.',
    message_en: 'Inbox item not found.',
  },
  INBOX_ITEM_ALREADY_HANDLED: {
    httpStatus: 409,
    message_sv: 'Underlaget är redan hanterat.',
    message_en: 'Inbox item is already handled (linked to a supplier invoice, voucher, or transaction).',
  },
  INBOX_ITEM_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Underlaget laddades upp men kunde inte läggas i inkorgen.',
    message_en: 'The document was stored but the inbox item could not be created.',
  },
}

const CUSTOMER: Record<string, StructuredErrorEntry> = {
  CUSTOMER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Kunden kunde inte hittas.',
    message_en: 'Customer not found.',
  },
  CUSTOMER_DUPLICATE_ORG_NUMBER: {
    httpStatus: 409,
    message_sv: 'En kund med samma organisationsnummer finns redan.',
    message_en: 'A customer with that organisation number already exists.',
  },
  CUSTOMER_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunden kunde inte skapas.',
    message_en: 'Failed to create customer.',
  },
  CUSTOMER_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunden kunde inte uppdateras.',
    message_en: 'Failed to update customer.',
  },
  CUSTOMER_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunden kunde inte tas bort.',
    message_en: 'Failed to delete customer.',
  },
  CUSTOMER_HAS_INVOICES: {
    httpStatus: 409,
    message_sv: 'Kunden har fakturor och kan inte tas bort.',
    message_en: 'Customer cannot be deleted while invoices reference it.',
  },
  CUSTOMER_NO_PERSONAL_NUMBER: {
    httpStatus: 404,
    message_sv: 'Kunden har inget sparat personnummer.',
    message_en: 'No personal number is stored for this customer.',
  },
  // The stored ciphertext could not be decrypted (written under a different
  // PERSONNUMMER_ENCRYPTION_KEY, or corrupted). Deliberately not an
  // INTERNAL_ERROR: it is not transient, retrying never helps, and the user
  // can fix it in one step by typing the personnummer in again.
  CUSTOMER_PERSONAL_NUMBER_UNREADABLE: {
    httpStatus: 422,
    message_sv:
      'Det sparade personnumret kan inte läsas. Skriv in det igen för att ersätta det.',
    message_en:
      'The stored personal number cannot be read. Enter it again to replace it.',
  },
}

const ARTICLE: Record<string, StructuredErrorEntry> = {
  ARTICLE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Artikeln kunde inte hittas.',
    message_en: 'Article not found.',
  },
  ARTICLE_DUPLICATE_NUMBER: {
    httpStatus: 409,
    message_sv: 'En artikel med samma artikelnummer finns redan.',
    message_en: 'An article with that article number already exists.',
  },
  ARTICLE_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Artikeln kunde inte skapas.',
    message_en: 'Failed to create article.',
  },
  ARTICLE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Artikeln kunde inte uppdateras.',
    message_en: 'Failed to update article.',
  },
  INVOICE_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Fakturan kunde inte tas bort eller makuleras.',
    message_en: 'The invoice could not be deleted or cancelled.',
  },
  CUSTOMER_PERSONAL_NUMBER_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv: 'Personnummer kan endast sparas för privatkunder.',
    message_en: 'Personal numbers can only be stored for individual customers.',
  },
  ARTICLE_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Artikeln kunde inte tas bort.',
    message_en: 'Failed to delete article.',
  },
  ARTICLE_IN_USE: {
    httpStatus: 409,
    message_sv:
      'Artikeln har använts på en faktura och kan därför inte tas bort. Inaktivera den i stället om du inte vill kunna välja den på nya fakturor.',
    message_en:
      'The article has been used on an invoice and cannot be deleted. Deactivate it instead if you no longer want it selectable on new invoices.',
  },
  ARTICLE_REVENUE_ACCOUNT_INVALID: {
    httpStatus: 400,
    message_sv: 'Bokföringskontot finns inte eller är inte ett aktivt balans- eller intäktskonto (klass 1-3).',
    message_en: 'The posting account does not exist or is not an active balance-sheet or revenue account (class 1-3).',
  },
}

const SUPPLIER: Record<string, StructuredErrorEntry> = {
  SUPPLIER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantören kunde inte hittas.',
    message_en: 'Supplier not found.',
  },
  SUPPLIER_DUPLICATE_ORG_NUMBER: {
    httpStatus: 409,
    message_sv: 'En leverantör med samma organisationsnummer finns redan.',
    message_en: 'A supplier with that organisation number already exists.',
  },
  SUPPLIER_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantören kunde inte skapas.',
    message_en: 'Failed to create supplier.',
  },
  SUPPLIER_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantören kunde inte uppdateras.',
    message_en: 'Failed to update supplier.',
  },
  SUPPLIER_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantören kunde inte tas bort.',
    message_en: 'Failed to delete supplier.',
  },
  // v1 archive refusal: leverantörsfakturor pointing at this supplier still
  // need its name/address for BFL 7 kap audit. Issue credit notes first.
  SUPPLIER_HAS_INVOICES: {
    httpStatus: 409,
    message_sv:
      'Leverantören kan inte arkiveras eftersom det finns öppna leverantörsfakturor som refererar till den.',
    message_en:
      'Supplier cannot be archived while open supplier invoices reference it.',
    remediation: {
      description:
        'Close (credit / mark paid) every open supplier invoice before archiving the supplier. The dashboard exposes the same blocker.',
    },
  },
  // v1 strict-mode: update / delete only allowed on `registered` SIs (the
  // SI analogue of `draft`). Mirrors the dashboard internal route.
  SI_NOT_DRAFT: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan är inte längre i status "registrerad" och kan därför inte uppdateras eller tas bort.',
    message_en:
      'Supplier invoice is not in `registered` status and cannot be updated or deleted.',
  },
}

const SUPPLIER_INVOICE_WAVE4: Record<string, StructuredErrorEntry> = {
  SI_CREATE_DUPLICATE_INVOICE_NUMBER: {
    httpStatus: 409,
    message_sv: 'En leverantörsfaktura med samma nummer finns redan.',
    message_en: 'A supplier invoice with that number already exists.',
  },
  SI_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Leverantörsfakturan kunde inte skapas.',
    message_en: 'Failed to create supplier invoice.',
  },
  SI_CREATE_INVALID_INPUT: {
    httpStatus: 400,
    message_sv: 'Ogiltig kombination av fakturafält. Kontrollera formuläret och försök igen.',
    message_en: 'Invalid combination of supplier invoice fields.',
  },
  SI_CREATE_NO_FISCAL_PERIOD: {
    httpStatus: 400,
    message_sv:
      'Det finns inget räkenskapsår som täcker fakturadatumet. Lägg upp räkenskapsåret först, eller ändra fakturadatumet.',
    message_en:
      'No fiscal year covers the invoice date. Create the fiscal year first, or change the invoice date.',
  },
  SI_CREATE_ACCRUAL_REVERSE_CHARGE: {
    httpStatus: 400,
    message_sv:
      'Periodisering kan inte kombineras med omvänd skattskyldighet. Kostnadsraden utgör momsunderlaget i momsdeklarationen (ruta 20-32), så nettobeloppet kan inte skjutas upp till ett interimskonto.',
    message_en:
      'Periodisering cannot be combined with reverse charge. The expense line carries the VAT base for the VAT declaration (boxes 20-32), so the net amount cannot be deferred to an interim account.',
  },
  SI_DELETE_HAS_BOOKING: {
    httpStatus: 400,
    message_sv:
      'Leverantörsfakturan är bokförd, har registrerade betalningar eller en periodisering och kan inte tas bort. Skapa en kreditfaktura i stället för att återställa bokföringen.',
    message_en:
      'The supplier invoice has a posted journal entry, recorded payments, or an accrual schedule and cannot be deleted. Create a credit note instead to reverse the bookkeeping.',
  },
  SI_PAID_ALREADY: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan är redan betald eller krediterad.',
    message_en: 'Supplier invoice is already paid or credited.',
  },
  SI_PAID_NOT_PAYABLE: {
    httpStatus: 400,
    message_sv: 'Leverantörsfakturan kan inte markeras som betald i nuvarande status.',
    message_en: 'Supplier invoice is not in a payable state.',
  },
  SI_PAID_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Bokföringen är låst. Betalningen kan inte registreras.',
    message_en: 'Bookkeeping is locked; payment cannot be recorded.',
  },
  SI_PAID_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte registrera betalningen.',
    message_en: 'Failed to record supplier invoice payment.',
  },
  SI_CREDIT_ALREADY_CREDITED: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan har redan krediterats.',
    message_en: 'Supplier invoice has already been credited.',
  },
  SI_CREDIT_PERIOD_LOCKED: {
    httpStatus: 400,
    message_sv: 'Bokföringen är låst. Krediteringen kan inte skapas.',
    message_en: 'Bookkeeping is locked; credit note cannot be created.',
  },
  SI_CREDIT_FAILED: {
    httpStatus: 500,
    message_sv: 'Kunde inte kreditera leverantörsfakturan.',
    message_en: 'Failed to credit supplier invoice.',
  },
}

const COMPANY: Record<string, StructuredErrorEntry> = {
  COMPANY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Företaget kunde inte hittas.',
    message_en: 'Company not found.',
  },
  COMPANY_CREATE_DUPLICATE_ORG_NUMBER: {
    httpStatus: 409,
    message_sv: 'Ett företag med samma organisationsnummer finns redan.',
    message_en: 'A company with that organisation number already exists.',
  },
  COMPANY_CREATE_BAS_SEED_FAILED: {
    httpStatus: 500,
    message_sv: 'Kontoplanen kunde inte skapas. Försök igen.',
    message_en: 'Failed to seed the chart of accounts.',
  },
  COMPANY_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Företaget kunde inte skapas.',
    message_en: 'Failed to create company.',
  },
}

const API_KEY: Record<string, StructuredErrorEntry> = {
  API_KEY_SCOPE_INVALID: {
    httpStatus: 400,
    message_sv: 'En eller flera scopes är ogiltiga.',
    message_en: 'One or more requested scopes are invalid.',
  },
  API_KEY_QUOTA_EXCEEDED: {
    httpStatus: 429,
    message_sv: 'Du har nått maxgränsen för antal API-nycklar.',
    message_en: 'API key quota exceeded.',
  },
  API_KEY_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'API-nyckeln kunde inte skapas.',
    message_en: 'Failed to create API key.',
  },
  API_KEY_REVOKE_FAILED: {
    httpStatus: 500,
    message_sv: 'API-nyckeln kunde inte återkallas.',
    message_en: 'Failed to revoke API key.',
  },
  API_KEY_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'API-nyckeln kunde inte hittas.',
    message_en: 'API key not found.',
  },
  API_KEY_SOD_CONFLICT: {
    httpStatus: 409,
    message_sv:
      'Nyckeln kombinerar ett skriv-scope som stagar bokföring med pending_operations:approve. Då kan en automatiserad agent både skapa och godkänna verifikationer utan mänsklig granskning (ansvarsfördelning, ISO 27001 A.5.3 / BFNAR 2013:2). Bekräfta att du förstår risken för att skapa nyckeln ändå.',
    message_en:
      'This key combines a staging write scope with pending_operations:approve, letting an automated agent both stage and approve postings with no human in the loop (segregation of duties, ISO 27001 A.5.3 / BFNAR 2013:2).',
    remediation: {
      description:
        'Inform the user of the segregation-of-duties risk, then re-POST the same scopes with acknowledge_sod: true to create the key anyway.',
    },
  },
}

// ─────────────────────────────────────────────────────────────────
// Link invoice to an existing posted verifikat (no new JE)
// ─────────────────────────────────────────────────────────────────

const LINK_INVOICE_VOUCHER: Record<string, StructuredErrorEntry> = {
  LINK_VOUCHER_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Fakturan kunde inte hittas.',
    message_en: 'Invoice not found.',
  },
  LINK_VOUCHER_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  LINK_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är inte bokförd. Endast bokförda verifikationer kan länkas som betalning.',
    message_en: 'Journal entry is not posted. Only posted entries can be linked as a payment.',
  },
  LINK_VOUCHER_NO_AR_CREDIT: {
    httpStatus: 400,
    message_sv:
      'Verifikationen krediterar inte ett kundfordringskonto (151x). Bokföringen behöver först rättas med en stornoverifikation som krediterar 1510, t.ex. via gnubok_correct_entry.',
    message_en:
      'The journal entry does not credit an accounts-receivable account (151x). Correct the booking first via a storno+correction (gnubok_correct_entry) that credits 1510.',
    remediation: {
      description:
        'Use gnubok_correct_entry to storno the existing voucher and re-book the receipt as Dr 1930 / Cr 1510, then link the corrected voucher.',
      tool: 'gnubok_correct_entry',
    },
  },
  LINK_VOUCHER_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan länkad till den här fakturan.',
    message_en: 'This journal entry is already linked to this invoice.',
  },
  LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Verifikationens kundfordringskreditering är större än fakturans återstående belopp. Verifikationen täcker fler fakturor: välj en annan verifikation eller rätta beloppet först.',
    message_en:
      'The voucher\'s AR credit exceeds the invoice\'s remaining balance. Split the voucher across multiple invoices via gnubok_correct_entry first, or pick a different voucher.',
  },
  LINK_VOUCHER_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Verifikationens valuta matchar inte fakturans. Endast verifikationer i fakturans valuta kan länkas.',
    message_en: 'The voucher\'s currency does not match the invoice currency.',
  },
  LINK_VOUCHER_INVOICE_FULLY_PAID: {
    httpStatus: 409,
    message_sv: 'Fakturan har redan slutbetalats. Inget mer behöver länkas.',
    message_en: 'Invoice is already fully paid.',
  },
  LINK_VOUCHER_DB_ERROR: {
    httpStatus: 500,
    message_sv: 'Databasfel under länkning. Försök igen.',
    message_en: 'Database error while linking the voucher. Please retry.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Link SUPPLIER invoice to an existing posted verifikat (no new JE)
// ─────────────────────────────────────────────────────────────────

const LINK_SI_VOUCHER: Record<string, StructuredErrorEntry> = {
  LINK_SI_VOUCHER_INVOICE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Leverantörsfakturan kunde inte hittas.',
    message_en: 'Supplier invoice not found.',
  },
  LINK_SI_VOUCHER_VOUCHER_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Verifikationen kunde inte hittas.',
    message_en: 'Journal entry not found.',
  },
  LINK_SI_VOUCHER_NOT_POSTED: {
    httpStatus: 409,
    message_sv:
      'Verifikationen är inte bokförd. Endast bokförda verifikationer kan länkas som betalning.',
    message_en: 'Journal entry is not posted. Only posted entries can be linked as a payment.',
  },
  LINK_SI_VOUCHER_NO_AP_DEBIT: {
    httpStatus: 400,
    message_sv:
      'Verifikationen debiterar inget leverantörsskuldskonto (244x). Rätta bokföringen först med en stornoverifikation som debiterar t.ex. 2440 (SEK) eller 2441 (utländsk valuta), via gnubok_correct_entry.',
    message_en:
      'The journal entry does not debit any accounts-payable account in the 244x range (e.g. 2440 SEK, 2441 foreign currency). Correct the booking first via a storno+correction (gnubok_correct_entry).',
    remediation: {
      description:
        'Use gnubok_correct_entry to storno the existing voucher and re-book the payment as Dr 244x / Cr 1930, then link the corrected voucher.',
      tool: 'gnubok_correct_entry',
    },
  },
  LINK_SI_VOUCHER_ALREADY_LINKED: {
    httpStatus: 409,
    message_sv: 'Verifikationen är redan länkad till den här leverantörsfakturan.',
    message_en: 'This journal entry is already linked to this supplier invoice.',
  },
  LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING: {
    httpStatus: 400,
    message_sv:
      'Verifikationens leverantörsskuldsdebitering är större än leverantörsfakturans återstående belopp. Verifikationen täcker fler fakturor: välj en annan verifikation eller rätta beloppet först.',
    message_en:
      'The voucher\'s AP debit exceeds the supplier invoice\'s remaining balance. Split the voucher across multiple supplier invoices via gnubok_correct_entry first, or pick a different voucher.',
  },
  LINK_SI_VOUCHER_CURRENCY_MISMATCH: {
    httpStatus: 400,
    message_sv:
      'Verifikationens valuta matchar inte leverantörsfakturans. Endast verifikationer i fakturans valuta kan länkas.',
    message_en: 'The voucher\'s currency does not match the supplier invoice currency.',
  },
  LINK_SI_VOUCHER_INVOICE_FULLY_PAID: {
    httpStatus: 409,
    message_sv: 'Leverantörsfakturan har redan slutbetalats. Inget mer behöver länkas.',
    message_en: 'Supplier invoice is already fully paid.',
  },
  LINK_SI_VOUCHER_DB_ERROR: {
    httpStatus: 500,
    message_sv: 'Databasfel under länkning. Försök igen.',
    message_en: 'Database error while linking the voucher. Please retry.',
  },
}

const ASSETS: Record<string, StructuredErrorEntry> = {
  ASSET_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Tillgången kunde inte hittas.',
    message_en: 'Asset not found.',
  },
  ASSET_ALREADY_DISPOSED: {
    httpStatus: 409,
    message_sv: 'Tillgången är redan avyttrad.',
    message_en: 'The asset has already been disposed.',
  },
  ASSET_DISPOSAL_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Avyttringen kan inte bokföras eftersom avskrivningar redan finns för samma eller en senare period. Återför den felaktiga avskrivningen med storno först.',
    message_en:
      'The disposal cannot be posted because depreciation already exists for the same or a later period. Reverse the incorrect depreciation first.',
  },
  ASSET_JAMKNING_DATA_REQUIRED: {
    httpStatus: 422,
    message_sv:
      'Ange ursprunglig ingående moms och ursprunglig avdragsprocent för att bedöma justering enligt ML 15 kap.',
    message_en:
      'Enter the original input VAT and original deduction percentage to assess adjustment under ML chapter 15.',
  },
  ASSET_ADJUSTMENT_DOCUMENT_REQUIRED: {
    httpStatus: 422,
    message_sv:
      'Bekräfta att en justeringshandling upprättas när justeringsskyldigheten överförs.',
    message_en:
      'Confirm that an adjustment document is prepared when the adjustment obligation is transferred.',
  },
  ASSET_BUSINESS_TRANSFER_CONFIRMATION_REQUIRED: {
    httpStatus: 422,
    message_sv:
      'Bekräfta att överlåtelsen omfattar en hel verksamhet eller självständig verksamhetsgren och uppfyller villkoren i ML 5 kap. 38 §.',
    message_en:
      'Confirm that the transfer covers an entire business or independent branch and meets the conditions in ML chapter 5, section 38.',
  },
  ASSET_CORRECTION_BLOCKED: {
    httpStatus: 409,
    message_sv:
      'Anskaffningsdatum, anskaffningsvärde och kategori kan inte ändras efter att tillgången avyttrats eller avskrivningar bokförts. Återför (storno) först, eller använd avyttringsflödet.',
    message_en:
      'Acquisition date, cost and category cannot be changed once the asset has been disposed or depreciation has been posted. Reverse (storno) first, or use the disposal flow.',
  },
  // Generic on purpose: the flag covers accounts excluded from K2 for several
  // different reasons (egenupparbetade immateriella, uppskjuten skatt,
  // verkligt värde, säkringsredovisning, ...), so the static entry states only
  // what the BAS chart says. The asset routes override it with an
  // account-specific message from lib/bokslut/assets/k2-account-guard.ts,
  // which cites BFNAR 2016:10 punkt 10.4 only when the intangible group is
  // what actually triggered the gate.
  K2_EXCLUDED_ACCOUNT: {
    httpStatus: 422,
    message_sv:
      'Kontot är markerat Ej K2 i BAS-kontoplanen och förutsätter K3. Välj ett konto som är tillåtet enligt K2.',
    message_en:
      'The account is marked Ej K2 in the BAS chart of accounts and presumes the K3 framework. Pick an account that K2 permits.',
  },
}

// Dimensions registry (kostnadsställe/projekt): dev_docs/dimensions_implementation_plan.md §6
const DIMENSION: Record<string, StructuredErrorEntry> = {
  DIMENSION_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dimensionen kunde inte hittas.',
    message_en: 'Dimension not found.',
  },
  DIMENSION_SYSTEM_RENAME: {
    httpStatus: 400,
    message_sv: 'Systemdimensioner kan inte döpas om.',
    message_en: 'System dimensions (kostnadsställe/projekt) cannot be renamed.',
  },
  DIMENSION_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionen kunde inte uppdateras.',
    message_en: 'Failed to update dimension.',
  },
  DIMENSION_SYSTEM_DELETE: {
    httpStatus: 400,
    message_sv: 'Systemdimensioner (kostnadsställe och projekt) kan inte tas bort: avaktivera dem istället.',
    message_en: 'System dimensions (kostnadsställe/projekt) cannot be deleted: archive (inactivate) them instead.',
  },
  // The DB registry guard (enforce_dimension_registry_guards) raises when any
  // posted/reversed line is tagged with the dimension's number, and the value
  // retention trigger fires on the cascade to dimension_values. Routes surface
  // the trigger's own Swedish message via `messageSv`.
  DIMENSION_REFERENCED: {
    httpStatus: 409,
    message_sv:
      'Dimensionen används på bokförda verifikat och kan inte tas bort: avaktivera den istället.',
    message_en:
      'The dimension is referenced by posted vouchers and cannot be deleted: archive (inactivate) it instead.',
    remediation: {
      description:
        'Archive the dimension instead: PATCH /api/dimensions/[id] with { "is_active": false }. Numbers tagged on posted lines are retained for the BFL 7-year period.',
    },
  },
  DIMENSION_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionen kunde inte tas bort.',
    message_en: 'Failed to delete dimension.',
  },
  DIMENSION_VALUE_NOT_FOUND: {
    httpStatus: 404,
    message_sv: 'Dimensionsvärdet kunde inte hittas.',
    message_en: 'Dimension value not found.',
  },
  DIMENSION_VALUE_DUPLICATE_CODE: {
    httpStatus: 409,
    message_sv: 'Ett värde med samma kod finns redan i dimensionen.',
    message_en: 'A value with that code already exists in the dimension.',
  },
  DIMENSION_VALUE_DATES_NOT_ALLOWED: {
    httpStatus: 400,
    message_sv: 'Datum kan bara sättas på ackumulerande dimensioner (t.ex. projekt).',
    message_en:
      'Start/end dates can only be set on accumulating dimensions (e.g. projects): this dimension resets annually.',
  },
  DIMENSION_VALUE_CREATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionsvärdet kunde inte skapas.',
    message_en: 'Failed to create dimension value.',
  },
  DIMENSION_VALUE_UPDATE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionsvärdet kunde inte uppdateras.',
    message_en: 'Failed to update dimension value.',
  },
  // The DB retention trigger (enforce_dimension_value_retention) raises when a
  // code is referenced by posted/reversed lines. Routes surface the trigger's
  // own Swedish message via `messageSv` so the code + kod appear in the toast.
  DIMENSION_VALUE_REFERENCED: {
    httpStatus: 409,
    message_sv:
      'Värdet används på bokförda verifikat och kan inte tas bort: arkivera det istället.',
    message_en:
      'The value is referenced by posted vouchers and cannot be deleted: archive (inactivate) it instead.',
    remediation: {
      description:
        'Archive the value instead: PATCH the dimension value with { "is_active": false }. Codes referenced by posted lines are retained for the BFL 7-year period.',
    },
  },
  DIMENSION_VALUE_DELETE_FAILED: {
    httpStatus: 500,
    message_sv: 'Dimensionsvärdet kunde inte tas bort.',
    message_en: 'Failed to delete dimension value.',
  },
  DIMENSION_IMPORT_FAILED: {
    httpStatus: 500,
    message_sv: 'Import av befintliga dimensionskoder misslyckades.',
    message_en: 'Failed to import existing dimension codes from journal lines.',
  },
}

// ─────────────────────────────────────────────────────────────────
// Node.js / undici network system codes. These surface when an outbound call
// (email provider, Riksbanken, Skatteverket, a DB socket) fails at the
// network layer and the raw Error bubbles up with its `code` intact.
// Registered so they translate to a Swedish transient message instead of
// leaking strings like "connect ECONNREFUSED 10.0.0.1:443" (#337 follow-up).
// ─────────────────────────────────────────────────────────────────

const NETWORK_TRANSIENT_ENTRY: StructuredErrorEntry = {
  httpStatus: 503,
  message_sv: 'Kunde inte nå en extern tjänst. Försök igen om en stund.',
  message_en: 'An upstream network call failed. Retry the same request after a short backoff.',
  retryable: true,
}

const NODE_SYSTEM: Record<string, StructuredErrorEntry> = {
  ECONNREFUSED: NETWORK_TRANSIENT_ENTRY,
  ECONNRESET: NETWORK_TRANSIENT_ENTRY,
  ETIMEDOUT: NETWORK_TRANSIENT_ENTRY,
  ENOTFOUND: NETWORK_TRANSIENT_ENTRY,
  EAI_AGAIN: NETWORK_TRANSIENT_ENTRY,
  EPIPE: NETWORK_TRANSIENT_ENTRY,
}

// ─────────────────────────────────────────────────────────────────
// Combined registry
// ─────────────────────────────────────────────────────────────────

const REGISTRY: Record<string, StructuredErrorEntry> = {
  ...GENERIC,
  ...BOOKKEEPING,
  ...TRANSACTIONS,
  ...MATCH_INVOICE,
  ...LINK_INVOICE_VOUCHER,
  ...LINK_SI_VOUCHER,
  ...MATCH_SI,
  ...INVOICE,
  ...SUPPLIER_INVOICE,
  ...PERIOD,
  ...YEAR_END,
  ...OPENING_BAL,
  ...FX,
  ...REPORT,
  ...VAT_REPORT,
  ...PS_REPORT,
  ...SIE_EXPORT,
  ...TAX_DECL,
  ...SIE_IMPORT,
  ...OPENING_BALANCE_IMPORT,
  ...REGISTER_IMPORT,
  ...DOCUMENT,
  ...INBOX,
  ...CUSTOMER,
  ...ARTICLE,
  ...SUPPLIER,
  ...SUPPLIER_INVOICE_WAVE4,
  ...COMPANY,
  ...API_KEY,
  ...ASSETS,
  ...DIMENSION,
  ...NODE_SYSTEM,
}

export function getErrorEntry(code: string): StructuredErrorEntry | undefined {
  return REGISTRY[code]
}

export function hasErrorEntry(code: string): boolean {
  return code in REGISTRY
}
