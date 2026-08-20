import type { CompanySettings, MomsPeriod } from '@/types'
import { deriveSwedishVatNumber } from '@/lib/vat/vat-number'

/**
 * Pure state machine for the journey onboarding
 * (dev_docs/onboarding_migration_plan.md). The component renders `step`,
 * dispatches actions, and performs the side effects (the
 * createCompanyFromOnboarding call); the reducer owns every transition and
 * every settings write.
 *
 * Invariants encoded here:
 * - `settings` accumulates the exact CompanySettings partial today's wizard
 *   sends to createCompanyFromOnboarding: nothing less.
 * - `vat_registered` is never silently defaulted: it is always an explicit
 *   answer (ML 17 kap 24 §).
 * - History stores each step's ENTRY snapshot, so Back rolls both answers
 *   and stations to how they were when the step began.
 */

export type JourneyStep =
  | 'orgnr'
  | 'name'
  | 'address'
  | 'fskatt'
  | 'fy'
  | 'fymonth'
  | 'fystart'
  | 'fyend'
  | 'momsyn'
  | 'moms'
  | 'method'
  | 'done'

export type JourneyStation = 0 | 1 | 2 | 3 | 4

const STATION_OF: Record<JourneyStep, JourneyStation> = {
  orgnr: 0,
  name: 0,
  address: 0,
  fskatt: 0,
  fy: 1,
  fymonth: 1,
  fystart: 1,
  fyend: 1,
  momsyn: 2,
  moms: 2,
  method: 3,
  done: 4,
}

export function stationOfStep(step: JourneyStep): JourneyStation {
  return STATION_OF[step]
}

export type JourneyServerError =
  | 'org_number_invalid'
  | 'period_invalid'
  | 'generic'
  | null

/** The slice of state a step's entry snapshot preserves for Back. */
interface JourneySnapshot {
  step: JourneyStep
  settings: Partial<CompanySettings>
  addressAsked: boolean
  /** The verksamhetsnamn question was explicitly answered. */
  nameConfirmedForEf: boolean
}

export interface JourneyState extends JourneySnapshot {
  /** Entry snapshot of the CURRENT step (what Back from a later step restores). */
  entry: JourneySnapshot
  history: JourneySnapshot[]
  submitting: boolean
  serverError: JourneyServerError
}

export interface JourneyInit {
  /** ?org_number= deep link. The component auto-submits it on mount. */
  initialOrgNumber?: string
}

export type JourneyAction =
  | { type: 'ORG_SUBMITTED'; orgNumber: string }
  | { type: 'NAME_SUBMITTED'; name: string }
  | { type: 'ADDRESS_SUBMITTED'; addressLine1?: string; postalCode?: string; city?: string }
  | { type: 'FSKATT_ANSWERED'; fskatt: boolean }
  | { type: 'FY_CALENDAR_CONFIRMED' }
  | { type: 'FY_OTHER_SELECTED' }
  | { type: 'FY_FIRST_SELECTED' }
  | { type: 'FY_END_MONTH_PICKED'; endMonth: number }
  | { type: 'FY_START_PICKED'; date: string }
  | { type: 'FY_END_PICKED'; date: string }
  | { type: 'VAT_ANSWERED'; registered: boolean }
  | { type: 'MOMS_PERIOD_PICKED'; period: MomsPeriod }
  | { type: 'METHOD_PICKED'; method: 'accrual' | 'cash' }
  | { type: 'SUBMIT_SUCCEEDED' }
  | { type: 'SUBMIT_FAILED'; code: 'org_number_invalid' | 'period_invalid' | 'generic' }
  | { type: 'BACK' }
  | { type: 'STATION_JUMP'; station: 0 | 1 | 2 | 3 }

function snapshotOf(s: JourneySnapshot): JourneySnapshot {
  return {
    step: s.step,
    settings: s.settings,
    addressAsked: s.addressAsked,
    nameConfirmedForEf: s.nameConfirmedForEf,
  }
}

export function initJourney(init: JourneyInit = {}): JourneyState {
  const settings: Partial<CompanySettings> = {}
  if (init.initialOrgNumber) settings.org_number = init.initialOrgNumber
  // Enskild firma is the only company form here, so the question is never
  // asked.
  settings.entity_type = 'enskild_firma'
  const base: JourneySnapshot = {
    step: 'orgnr',
    settings,
    addressAsked: false,
    nameConfirmedForEf: false,
  }
  return {
    ...base,
    entry: snapshotOf(base),
    history: [],
    submitting: false,
    serverError: null,
  }
}

/** Transition to `next`, pushing the current step's entry snapshot.
 *  `patch` wins over the defaults (a transition may carry a serverError). */
function go(state: JourneyState, next: JourneyStep, patch?: Partial<JourneyState>): JourneyState {
  const moved: JourneyState = {
    ...state,
    serverError: null,
    ...patch,
    step: next,
    history: [...state.history, state.entry],
  }
  return { ...moved, entry: snapshotOf(moved) }
}

/** Update within the current step (no history push, entry unchanged). */
function stay(state: JourneyState, patch: Partial<JourneyState>): JourneyState {
  return { ...state, ...patch }
}

/**
 * The Företaget station asks only what is still unknown, then hands over to
 * the fiscal-year station. Order: name → address → F-skatt. The
 * verksamhetsnamn is always confirmed (it defaults to the person's name but
 * is freely choosable, same as the wizard).
 */
function nextCompanyStep(state: JourneyState): JourneyStep {
  const s = state.settings
  const nameKnown = Boolean(s.company_name) && state.nameConfirmedForEf === true
  if (!nameKnown) return 'name'
  if (!state.addressAsked) return 'address'
  if (s.f_skatt === undefined) return 'fskatt'
  return 'fy'
}

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyState {
  switch (action.type) {
    case 'ORG_SUBMITTED': {
      if (state.submitting) return state
      const patched = stay(state, {
        settings: { ...state.settings, org_number: action.orgNumber },
        serverError: null,
      })
      return go(patched, nextCompanyStep(patched))
    }

    case 'NAME_SUBMITTED': {
      const trimmed = action.name.trim()
      if (!trimmed) return state
      const patched = stay(state, {
        settings: { ...state.settings, company_name: trimmed },
        nameConfirmedForEf: true,
      })
      return go(patched, nextCompanyStep(patched))
    }

    case 'ADDRESS_SUBMITTED': {
      const patched = stay(state, {
        settings: {
          ...state.settings,
          address_line1: action.addressLine1 || state.settings.address_line1,
          postal_code: action.postalCode || state.settings.postal_code,
          city: action.city || state.settings.city,
        },
        addressAsked: true,
      })
      return go(patched, nextCompanyStep(patched))
    }

    case 'FSKATT_ANSWERED': {
      const patched = stay(state, {
        settings: { ...state.settings, f_skatt: action.fskatt },
      })
      return go(patched, nextCompanyStep(patched))
    }

    case 'FY_CALENDAR_CONFIRMED': {
      const patched = stay(state, {
        settings: {
          ...state.settings,
          fiscal_year_start_month: 1,
          is_first_fiscal_year: false,
          first_year_start: undefined,
          first_year_end: undefined,
        },
      })
      return go(patched, 'momsyn')
    }

    case 'FY_OTHER_SELECTED':
      return go(state, 'fymonth')

    case 'FY_FIRST_SELECTED':
      return go(state, 'fystart')

    case 'FY_END_MONTH_PICKED': {
      const m = action.endMonth
      if (!Number.isInteger(m) || m < 1 || m > 12) return state
      const patched = stay(state, {
        settings: {
          ...state.settings,
          fiscal_year_start_month: m === 12 ? 1 : m + 1,
          is_first_fiscal_year: false,
          first_year_start: undefined,
          first_year_end: undefined,
        },
      })
      return go(patched, 'momsyn')
    }

    case 'FY_START_PICKED': {
      const patched = stay(state, {
        settings: {
          ...state.settings,
          is_first_fiscal_year: true,
          first_year_start: action.date,
        },
      })
      return go(patched, 'fyend')
    }

    case 'FY_END_PICKED': {
      const endMonth = Number(action.date.split('-')[1])
      const patched = stay(state, {
        settings: {
          ...state.settings,
          is_first_fiscal_year: true,
          first_year_end: action.date,
          // The ongoing fiscal year starts the month after the first year
          // ends: same derivation as the wizard's Step 3.
          fiscal_year_start_month:
            Number.isInteger(endMonth) && endMonth >= 1 && endMonth <= 12
              ? endMonth === 12
                ? 1
                : endMonth + 1
              : 1,
        },
      })
      return go(patched, 'momsyn')
    }

    case 'VAT_ANSWERED': {
      if (action.registered) {
        const patched = stay(state, {
          settings: {
            ...state.settings,
            vat_registered: true,
            vat_number: deriveSwedishVatNumber(state.settings.org_number),
          },
        })
        return go(patched, 'moms')
      }
      const patched = stay(state, {
        settings: {
          ...state.settings,
          vat_registered: false,
          vat_number: null,
          moms_period: null,
        },
      })
      return go(patched, 'method')
    }

    case 'MOMS_PERIOD_PICKED': {
      const patched = stay(state, {
        settings: { ...state.settings, moms_period: action.period },
      })
      return go(patched, 'method')
    }

    case 'METHOD_PICKED': {
      return stay(state, {
        settings: { ...state.settings, accounting_method: action.method },
        submitting: true,
        serverError: null,
      })
    }

    case 'SUBMIT_SUCCEEDED':
      return go(stay(state, { submitting: false }), 'done')

    case 'SUBMIT_FAILED': {
      const cleared = stay(state, { submitting: false })
      if (action.code === 'org_number_invalid') {
        // The server rejected the orgnr: travel back to the Företaget
        // station. Answers are kept; the flow walks forward again.
        return go(cleared, 'orgnr', { serverError: 'org_number_invalid' })
      }
      if (action.code === 'period_invalid') {
        return go(cleared, 'fy', { serverError: 'period_invalid' })
      }
      return stay(cleared, { serverError: 'generic' })
    }

    case 'BACK': {
      if (state.submitting || state.history.length === 0) return state
      const history = [...state.history]
      const snap = history.pop() as JourneySnapshot
      return {
        ...state,
        ...snap,
        entry: snap,
        history,
        submitting: false,
        serverError: null,
      }
    }

    case 'STATION_JUMP': {
      if (state.submitting) return state
      const target = action.station
      if (stationOfStep(state.step) <= target) return state
      const history = [...state.history]
      let snap: JourneySnapshot | null = null
      while (history.length > 0) {
        const top = history[history.length - 1]
        const st = stationOfStep(top.step)
        if (st > target) {
          history.pop()
          continue
        }
        if (st === target) {
          snap = history.pop() as JourneySnapshot
          // Rewind to the station's FIRST step, not its last.
          while (
            history.length > 0 &&
            stationOfStep(history[history.length - 1].step) === target
          ) {
            snap = history.pop() as JourneySnapshot
          }
        }
        break
      }
      if (!snap) return state
      return {
        ...state,
        ...snap,
        entry: snap,
        history,
        submitting: false,
        serverError: null,
      }
    }

    default:
      return state
  }
}
