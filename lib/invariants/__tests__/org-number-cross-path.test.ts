import { describe, it, expect } from 'vitest'
import { formatRedovisare } from '@/lib/skatteverket/format'

/**
 * The Skatteverket-bound export path must treat org numbers consistently.
 *
 * Before `lib/invariants/org-number.ts` the export paths disagreed: the SRU
 * converter stripped hyphens only and threw on a space, so a company stored in
 * an awkward form could fail at a filing deadline with a message that did not
 * say why. This test guards the surviving redovisare conversion.
 */

const AB_10 = '5560125790'

/** The input forms a Swedish user or a provider API actually produces. */
const EQUIVALENT_FORMS = ['5560125790', '556012-5790', '556012 5790', '165560125790']

/** Does the SRU redovisare conversion throw? */
function redovisareRejects(orgNumber: string): boolean {
  try {
    formatRedovisare(orgNumber, 'aktiebolag')
    return false
  } catch {
    return true
  }
}

describe('org number: the redovisare conversion', () => {
  it.each(EQUIVALENT_FORMS)('accepts %s', (form) => {
    expect(redovisareRejects(form), 'SRU redovisare conversion').toBe(false)
  })

  it('produces the same redovisare identity from every equivalent form', () => {
    const identities = EQUIVALENT_FORMS.map((f) => formatRedovisare(f, 'aktiebolag'))
    expect(new Set(identities).size, `got ${JSON.stringify(identities)}`).toBe(1)
    expect(identities[0]).toBe('165560125790')
  })

  it.each([
    ['5560125790x', 'stray characters'],
    ['55601', 'too short'],
  ])('rejects %s (%s)', (bad) => {
    expect(redovisareRejects(bad), 'SRU redovisare conversion').toBe(true)
  })

  it('stays permissive about a bad check digit by design', () => {
    // Export-time conversion is deliberately permissive: see org-number.ts.
    expect(redovisareRejects('5560125791'), 'SRU redovisare conversion').toBe(false)
  })

  it('the canonical form is what the display helper round-trips to', () => {
    expect(formatRedovisare(AB_10, 'aktiebolag')).toBe('165560125790')
  })
})
