/**
 * Maps raw errors to user-friendly Swedish messages.
 *
 * Priority chain:
 * 1. Zod validation field errors
 * 2. Postgres error code map
 * 3. HTTP status code map
 * 4. Context-specific fallback
 * 5. Generic fallback
 */

import { formatCurrency } from '@/lib/utils'
// Pure module (no next/server): safe for the client bundles this file lives in.
import { formatDimensionValidationIssues } from '@/lib/bookkeeping/dimension-errors'
import { getErrorEntry, hasErrorEntry } from './structured-errors'

type ErrorContext =
  | 'invoice'
  | 'supplier_invoice'
  | 'customer'
  | 'article'
  | 'supplier'
  | 'transaction'
  | 'journal_entry'
  | 'settings'
  | 'auth'
  | 'salary'

interface GetErrorMessageOptions {
  context?: ErrorContext
  statusCode?: number
}

// Postgres error codes -> Swedish messages
const POSTGRES_ERROR_MAP: Record<string, string> = {
  '23505': 'En post med samma uppgifter finns redan.',
  '23503': 'Posten kan inte ändras eftersom den refereras av annan data.',
  '23502': 'Ett obligatoriskt fält saknas.',
  '42501': 'Du har inte behörighet att utföra denna åtgärd.',
  '42P01': 'Resursen kunde inte hittas.',
  '23514': 'Värdet uppfyller inte de tillåtna kraven.',
  '40001': 'En annan ändring pågick samtidigt. Försök igen.',
  '40P01': 'En konflikt uppstod. Försök igen.',
  '22P02': 'Ogiltigt värde angavs.',
  '22003': 'Värdet är utanför tillåtet intervall.',
}

// HTTP status codes -> Swedish messages
const HTTP_STATUS_MAP: Record<number, string> = {
  400: 'Förfrågan innehåller ogiltiga uppgifter.',
  401: 'Din session har gått ut. Logga in igen.',
  403: 'Du har inte behörighet att utföra denna åtgärd.',
  404: 'Resursen kunde inte hittas.',
  409: 'En konflikt uppstod. Ladda om sidan och försök igen.',
  422: 'Uppgifterna kunde inte bearbetas. Kontrollera fälten och försök igen.',
  429: 'För många förfrågningar. Vänta en stund och försök igen.',
  500: 'Ett oväntat serverfel uppstod. Försök igen senare.',
  502: 'Servern är tillfälligt otillgänglig. Försök igen om en stund.',
  503: 'Tjänsten är tillfälligt otillgänglig. Försök igen om en stund.',
}

// Context-specific fallbacks
const CONTEXT_FALLBACKS: Record<ErrorContext, string> = {
  invoice: 'Kunde inte hantera fakturan. Försök igen.',
  supplier_invoice: 'Kunde inte hantera leverantörsfakturan. Försök igen.',
  customer: 'Kunde inte hantera kunden. Försök igen.',
  article: 'Kunde inte hantera artikeln. Försök igen.',
  supplier: 'Kunde inte hantera leverantören. Försök igen.',
  transaction: 'Kunde inte hantera transaktionen. Försök igen.',
  journal_entry: 'Kunde inte hantera verifikationen. Försök igen.',
  settings: 'Kunde inte spara inställningarna. Försök igen.',
  auth: 'Ett fel uppstod vid inloggningen. Försök igen.',
  salary: 'Kunde inte hantera löneuppgifterna. Försök igen.',
}

const GENERIC_FALLBACK = 'Något gick fel. Försök igen.'

// Known error patterns → user-friendly Swedish messages
const ERROR_PATTERN_MAP: [RegExp, string | null][] = [
  [
    /locked\/closed fiscal period/i,
    'Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.',
  ],
  [
    /Bokföringen är låst t\.o\.m\./,
    null, // null = extract the Swedish message directly from the raw error text
  ],
  [
    /Cannot attach documents to entries in a locked/i,
    'Kan inte bifoga dokument till verifikationer i en låst period.',
  ],
  [
    /Entry date .+ is outside fiscal period/i,
    'Datumet ligger utanför det valda räkenskapsåret.',
  ],
  [
    /Only company owners and admins can delete vouchers/i,
    'Endast ägare och administratörer kan radera verifikationer.',
  ],
  [
    /Journal entry not found/i,
    'Verifikationen kunde inte hittas.',
  ],
  [
    /Only posted entries can be deleted/i,
    'Endast bokförda verifikationer kan raderas.',
  ],
  [
    /Cannot delete voucher in a closed fiscal period/i,
    'Verifikationen kan inte raderas: räkenskapsåret är stängt.',
  ],
  [
    /Cannot delete voucher in a locked fiscal period/i,
    'Verifikationen kan inte raderas: perioden är låst.',
  ],
  [
    /Cannot delete: other entries reference this voucher/i,
    'Verifikationen kan inte raderas eftersom andra verifikationer (t.ex. storno eller rättelse) refererar till den.',
  ],
  [
    /timed out after \d+m?s/i,
    'Anslutningen mot tjänsten tog för lång tid. Försök igen.',
  ],
  [
    /already has a journal entry/i,
    'Transaktionen är redan bokförd. Ångra kategoriseringen om du vill ändra den.',
  ],
  [
    // GoTrue rejects supabase.auth.signUp with this when the installation
    // runs with disable_signup (closed self-hosted instances). The invitee
    // cannot fix it themselves: point them to whoever runs the installation.
    /signups? not allowed/i,
    'Kontoregistrering är avstängd på den här installationen. Kontakta den som bjöd in dig eller din administratör för att få ett konto.',
  ],
  [
    // GoTrue could not send its own mail (admin invite, confirmation,
    // recovery): almost always missing SMTP configuration on self-hosted.
    /error sending (invite|confirmation|recovery|magic link) email/i,
    'E-postmeddelandet kunde inte skickas av autentiseringstjänsten. Kontrollera installationens SMTP-inställningar och försök igen.',
  ],
]

/**
 * Check if a message matches a known error pattern and return the Swedish translation.
 * Returns null if no pattern matches.
 */
function tryMatchKnownError(message: string): string | null {
  for (const [pattern, translation] of ERROR_PATTERN_MAP) {
    if (pattern.test(message)) {
      if (translation !== null) return translation
      // Extract the Swedish part from the message
      const match = message.match(/Bokföringen är låst t\.o\.m\. [^.]+\./)
      return match ? match[0] : 'Bokföringen är låst för denna period.'
    }
  }
  return null
}

/**
 * Simple heuristic to detect already-translated Swedish messages.
 * If the message contains common Swedish words/patterns, pass it through.
 */
function isSwedishUserMessage(message: string): boolean {
  const swedishPatterns = [
    /kunde inte/i,
    /kan inte/i,
    /hittades/i,
    /redan/i,
    /låst/i,
    /försök igen/i,
    /ogiltigt?/i,
    /saknas/i,
    /saknar/i,
    /krävs/i,
    /måste/i,
    /redan finns/i,
    /gick fel/i,
    /valideringsfel/i,
    /korrigera/i,
    /bankuppgifter/i,
    /behörighet/i,
    /session/i,
    /förfrågan/i,
    /obligatorisk/i,
    /är låst/i,
    /fält/i,
    /värde/i,
    /felaktig/i,
    /för (lång|kort|stor|liten|många|få)/i,
    /bankgiro/i,
    /personnummer/i,
    /kontonummer/i,
    /clearingnummer/i,
    /nummer är/i,
    /tillgängligt/i,
    /verifikation/i,
    /importera|importen/i,
  ]
  return swedishPatterns.some((p) => p.test(message))
}

/**
 * Extract a user-friendly message from a Zod validation error shape.
 * Returns null if the error is not a Zod error.
 */
function tryParseZodErrors(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null

  const obj = error as Record<string, unknown>

  // Check for Zod-style field errors: { fieldName: ["message"] } or { issues: [...] }
  if (Array.isArray(obj.issues)) {
    const issues = obj.issues as Array<{ message?: string; path?: string[] }>
    const messages = issues
      .slice(0, 3)
      .map((issue) => {
        const field = issue.path?.join('.') || ''
        const msg = issue.message || 'ogiltigt värde'
        return field ? `${field}: ${msg}` : msg
      })
    if (messages.length > 0) return messages.join('. ')
  }

  // Check for { errors: [{ field, message, code }] } shape from validateBody
  if (Array.isArray(obj.errors)) {
    const items = obj.errors as Array<{ field?: string; message?: string }>
    const messages = items
      .slice(0, 3)
      .map((it) => {
        const field = it.field || ''
        const msg = it.message || 'ogiltigt värde'
        return field ? `${field}: ${msg}` : msg
      })
      .filter(Boolean)
    if (messages.length > 0) return messages.join('. ')
  }

  // Check for { errors: { field: ["msg"] } } shape (legacy)
  if (typeof obj.errors === 'object' && obj.errors !== null) {
    const fieldErrors = obj.errors as Record<string, string[]>
    const messages: string[] = []
    for (const [field, msgs] of Object.entries(fieldErrors)) {
      if (Array.isArray(msgs) && msgs.length > 0) {
        messages.push(`${field}: ${msgs[0]}`)
      }
      if (messages.length >= 3) break
    }
    if (messages.length > 0) return messages.join('. ')
  }

  return null
}

/**
 * Get a user-friendly Swedish error message from a raw error.
 *
 * @param error - The raw error. Can be an API response body (object), Error instance, string, or unknown.
 * @param options - Optional context and HTTP status code.
 */
export function getErrorMessage(
  error: unknown,
  options: GetErrorMessageOptions = {}
): string {
  const { context, statusCode } = options

  // 1. If it's a string, check if it's already Swedish or matches a known pattern
  if (typeof error === 'string' && error.trim()) {
    if (isSwedishUserMessage(error)) return error
    const knownError = tryMatchKnownError(error)
    if (knownError) return knownError
  }

  // 2. If it's an object, try various parsing strategies
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>

    // Bare envelope inner-error shape: { code, message, message_en?, ... }.
    // Happens when a caller forwards `result.error` (the inner object) instead
    // of the whole `result`: show its Swedish `message`.
    if (typeof obj.code === 'string' && typeof obj.message === 'string' && obj.message.trim()) {
      // Typed domain exceptions (lib/bookkeeping/errors.ts classes) also match
      // this shape, but their `message` is raw English (often a DB constraint
      // string) and must never reach the user verbatim. Normalize the instance
      // into the structured envelope so the per-code branches below own the
      // translation. Class fields are enumerable own props, so { ...obj }
      // carries exactly the details those branches expect (totalDebit,
      // lockDate, reason, issues, ...), while the non-enumerable Error.message
      // stays out of details. Plain objects (forwarded inner envelopes,
      // PostgrestError-shaped literals) keep the passthrough behavior.
      if (error instanceof Error) {
        // Only recurse when the registry knows the code: the structured
        // branches then own the translation. An unknown code (a Node system
        // error like ECONNREFUSED, a Postgres SQLSTATE on a wrapped Error, a
        // stray third-party code) would fall out of the structured path with
        // its raw English message, so instead fall through to the plain
        // handling below: Postgres map, known patterns, Swedish check, and
        // finally the status/context/generic fallbacks.
        if (hasErrorEntry(obj.code)) {
          return getErrorMessage(
            {
              error: {
                code: obj.code,
                message: obj.message,
                account_numbers: (obj as { accountNumbers?: unknown }).accountNumbers,
                details: { ...obj },
              },
            },
            options
          )
        }
      } else {
        return obj.message
      }
    }

    // Structured application error: { error: { code, message, message_en?, ... } }
    if (typeof obj.error === 'object' && obj.error !== null) {
      const structured = obj.error as {
        code?: unknown
        message?: unknown
        account_numbers?: unknown
        details?: unknown
      }

      if (structured.code === 'ACCOUNTS_NOT_IN_CHART' && Array.isArray(structured.account_numbers)) {
        const numbers = structured.account_numbers as string[]
        return `Följande konton behöver aktiveras: ${numbers.join(', ')}`
      }

      if (structured.code === 'JOURNAL_ENTRY_NOT_BALANCED') {
        const details = structured.details as { totalDebit?: number; totalCredit?: number } | undefined
        if (details && typeof details.totalDebit === 'number' && typeof details.totalCredit === 'number') {
          return `Verifikationen balanserar inte (${formatCurrency(details.totalDebit)} debet vs ${formatCurrency(details.totalCredit)} kredit).`
        }
        return 'Verifikationen balanserar inte. Kontrollera att debet och kredit är lika stora.'
      }

      if (structured.code === 'JOURNAL_LINE_NEGATIVE_AMOUNT') {
        return 'En verifikationsrad har ett negativt belopp. Boka beloppet på motsatt sida i stället.'
      }

      if (structured.code === 'FISCAL_PERIOD_NOT_FOUND') {
        return 'Räkenskapsperioden kunde inte hittas.'
      }

      if (structured.code === 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD') {
        return 'Datumet ligger utanför det valda räkenskapsåret.'
      }

      if (structured.code === 'JOURNAL_ENTRY_NOT_FOUND') {
        return 'Verifikationen kunde inte hittas.'
      }

      if (structured.code === 'CANNOT_REVERSE_NON_POSTED') {
        return 'Endast bokförda verifikationer kan stornas.'
      }

      if (structured.code === 'CANNOT_CORRECT_NON_POSTED') {
        return 'Endast bokförda verifikationer kan rättas.'
      }

      if (structured.code === 'ENTRY_ALREADY_REVERSED') {
        return 'Verifikationen har redan stornats av en annan användare. Ladda om sidan och försök igen.'
      }

      if (structured.code === 'CURRENCY_REVALUATION_ALREADY_EXISTS') {
        return 'En valutaomvärdering finns redan för denna period.'
      }

      if (structured.code === 'FX_CLOSING_RATE_UNAVAILABLE') {
        // Name the currency and the date: the user needs to know exactly which
        // rate is missing to judge whether to wait or pick another closing
        // date. Nothing was posted, so this is never a partial-state message.
        const details = structured.details as { missingRates?: unknown } | undefined
        const missing = Array.isArray(details?.missingRates)
          ? (details.missingRates as { currency?: unknown; date?: unknown }[])
              .filter((m) => typeof m?.currency === 'string' && typeof m?.date === 'string')
              .map((m) => `${m.currency as string} per ${m.date as string}`)
          : []
        const what = missing.length > 0 ? missing.join(', ') : 'balansdagen'
        return `Ingen valutakurs från Riksbanken finns för ${what}. Valutaomvärderingen har inte bokförts: en uppskattad kurs får inte bokföras mot 3960/7960. Försök igen när kursen är publicerad.`
      }

      if (structured.code === 'INVALID_MAPPING_RESULT') {
        return 'Kontering saknas för transaktionen. Kontrollera bokföringsreglerna.'
      }

      if (structured.code === 'DIMENSION_VALIDATION_FAILED') {
        // Prefer reconstructing the per-code Swedish sentences from the
        // machine-readable issue list (present on both the dashboard and the
        // v1/registry error envelopes); fall back to the message, which the
        // engine already emits in Swedish naming the offending codes.
        const details = structured.details as { issues?: unknown } | undefined
        const formatted = formatDimensionValidationIssues(details?.issues)
        if (formatted) return formatted
        if (typeof structured.message === 'string' && structured.message.trim()) {
          return structured.message
        }
        return 'Ett angivet kostnadsställe/projekt finns inte i dimensionsregistret eller är arkiverat. Skapa värdet i registret först.'
      }

      if (structured.code === 'NO_OPEN_PERIOD_FOR_DATE') {
        return 'Det finns ingen räkenskapsperiod som täcker det valda datumet. Skapa eller öppna räkenskapsåret först.'
      }

      if (structured.code === 'TARGET_PERIOD_CLOSED') {
        return 'Räkenskapsåret för det valda datumet är stängt (bokslut) och kan inte återöppnas. Bokför rättelsen i innevarande period istället.'
      }

      if (structured.code === 'TARGET_PERIOD_LOCKED') {
        const details = structured.details as { lockDate?: string } | undefined
        return details?.lockDate
          ? `Räkenskapsperioden för det valda datumet är låst (t.o.m. ${details.lockDate}). Lås upp perioden för att flytta verifikationen dit.`
          : 'Räkenskapsperioden för det valda datumet är låst. Lås upp perioden för att flytta verifikationen dit.'
      }

      if (structured.code === 'OB_COMPANY_LOCK_DATE') {
        const details = structured.details as { lockDate?: string } | undefined
        return details?.lockDate
          ? `Bokföringen är låst t.o.m. ${details.lockDate} och ingående balanser kan inte korrigeras. Ta bort eller flytta låsdatumet under Inställningar → Bokföring och försök igen.`
          : 'Bokföringen är låst av företagets låsdatum och ingående balanser kan inte korrigeras. Ta bort eller flytta låsdatumet under Inställningar → Bokföring och försök igen.'
      }

      if (structured.code === 'MEANINGLESS_CORRECTION') {
        const details = structured.details as { reason?: string } | undefined
        if (details?.reason === 'no_date_change') {
          return 'Det nya datumet är samma som det nuvarande: det finns inget att flytta.'
        }
        if (details?.reason === 'identical_to_original') {
          return 'Rättelsen är identisk med originalverifikationen: inget har ändrats.'
        }
        return 'Rättelsen saknar ekonomisk innebörd: varje konto netto till noll. En rättelse måste beskriva en faktisk affärshändelse (BFL 5 kap. 5 §).'
      }

      if (structured.code === 'BOOKKEEPING_DATABASE_ERROR') {
        // A DB-layer error may carry a user-relevant cause (e.g. period lock
        // trigger). Try the known-pattern map before falling back to the
        // generic "kunde inte sparas" message.
        if (typeof structured.message === 'string') {
          const matched = tryMatchKnownError(structured.message)
          if (matched) return matched
        }
        return 'Verifikationen kunde inte sparas. Försök igen.'
      }

      if (typeof structured.message === 'string' && structured.message.trim()) {
        // Known codes without a dynamic branch above (e.g. CANNOT_REVERSE_STORNO)
        // carry raw English engine messages: prefer the registry's Swedish
        // message so no typed code surfaces English in the UI.
        if (typeof structured.code === 'string' && !isSwedishUserMessage(structured.message)) {
          const entry = getErrorEntry(structured.code)
          if (entry?.message_sv) return entry.message_sv
        }
        return structured.message
      }
    }

    // Accumulated per-item validation list from routes that collect several
    // problems before responding, e.g. the salary approve route:
    //   { error: 'Valideringsfel …', details: ['Tomas Tysén: Bankuppgifter saknas …', …] }
    // Surface the specific reasons: otherwise this shape falls all the way
    // through to the generic HTTP-400 message and the user learns nothing.
    if (
      Array.isArray(obj.details) &&
      obj.details.length > 0 &&
      obj.details.every((d) => typeof d === 'string' && d.trim() !== '')
    ) {
      const items = (obj.details as string[]).map((d) => d.trim())
      const shown = items.slice(0, 5).join(' • ')
      const more = items.length > 5 ? ` (+${items.length - 5} till)` : ''
      const lead = typeof obj.error === 'string' && obj.error.trim() ? `${obj.error.trim()}: ` : ''
      return `${lead}${shown}${more}`
    }

    // Try Zod validation errors
    const zodMessage = tryParseZodErrors(obj)
    if (zodMessage) return zodMessage

    // Try Postgres error code
    if (typeof obj.code === 'string' && POSTGRES_ERROR_MAP[obj.code]) {
      return POSTGRES_ERROR_MAP[obj.code]
    }

    // Try known error patterns (e.g. locked period triggers)
    for (const field of ['error', 'message'] as const) {
      if (typeof obj[field] === 'string' && obj[field].trim()) {
        const knownError = tryMatchKnownError(obj[field])
        if (knownError) return knownError
      }
    }

    // Try error.message if it's already a good Swedish message
    if (typeof obj.error === 'string' && obj.error.trim()) {
      if (isSwedishUserMessage(obj.error)) return obj.error
    }

    if (typeof obj.message === 'string' && obj.message.trim()) {
      if (isSwedishUserMessage(obj.message)) return obj.message
    }
  }

  // 3. Error instance
  if (error instanceof Error && error.message.trim()) {
    const knownError = tryMatchKnownError(error.message)
    if (knownError) return knownError
    if (isSwedishUserMessage(error.message)) return error.message
  }

  // 4. HTTP status code map
  if (statusCode && HTTP_STATUS_MAP[statusCode]) {
    return HTTP_STATUS_MAP[statusCode]
  }

  // 5. Context-specific fallback
  if (context && CONTEXT_FALLBACKS[context]) {
    return CONTEXT_FALLBACKS[context]
  }

  // 6. Generic fallback
  return GENERIC_FALLBACK
}

/**
 * Helper that parses a Response body and returns a user-friendly error message.
 */
export async function getResponseErrorMessage(
  response: Response,
  context?: ErrorContext,
): Promise<string> {
  try {
    const body = await response.json()
    return getErrorMessage(body, { context, statusCode: response.status })
  } catch {
    return getErrorMessage(null, { context, statusCode: response.status })
  }
}
