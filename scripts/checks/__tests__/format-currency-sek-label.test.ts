/**
 * Proof that the sek-labelled-amount ratchet guard actually catches the thing.
 *
 * The offending fixtures live only in these strings and in an OS temp directory
 * the end-to-end case creates and deletes: nothing offending is committed, so
 * the guard cannot start failing on its own test data.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findSekLabelledFxAmountsInSource as scan } from '../format-currency-sek-label.mjs'

const GUARD = path.resolve(__dirname, '..', 'format-currency-sek-label.mjs')

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('sek-labelled-amount guard: catches a foreign amount printed as SEK', () => {
  it('flags a single-argument call on a record the file reads .currency from', () => {
    const source = `
      export function InvoiceTotal({ invoice }: { invoice: Invoice }) {
        if (invoice.currency !== 'SEK') return null
        return (
          <span>
            {formatCurrency(invoice.total)}
          </span>
        )
      }
    `
    const findings = scan('components/invoices/Offender.tsx', source)
    expect(findings).toHaveLength(1)
    expect(findings[0].expr).toBe('invoice.total')
    expect(findings[0].where).toBe('components/invoices/Offender.tsx:6')
  })

  it('sees through Number() / Math.abs() / unary minus wrappers', () => {
    const source = `
      const label = invoice.currency === 'EUR' ? formatCurrency(-Math.abs(Number(invoice.subtotal))) : ''
    `
    expect(scan('components/invoices/Wrapped.tsx', source).map((f) => f.expr)).toEqual([
      'invoice.subtotal',
    ])
  })

  it('flags a ?? fallback whose right side is the foreign figure', () => {
    const source = `
      const label = invoice.currency ? formatCurrency(invoice.total_sek ?? invoice.total) : ''
    `
    expect(scan('components/invoices/Fallback.tsx', source).map((f) => f.expr)).toEqual([
      'invoice.total',
    ])
  })

  it('flags amount_in_currency even with no .currency read in the file', () => {
    const source = `const label = formatCurrency(line.amount_in_currency)`
    expect(scan('components/bookkeeping/Foreign.tsx', source).map((f) => f.expr)).toEqual([
      'line.amount_in_currency',
    ])
  })
})

describe('sek-labelled-amount guard: leaves correct code alone', () => {
  it.each([
    ['the currency is passed', `const s = invoice.currency ? formatCurrency(invoice.total, invoice.currency) : ''`],
    ['the SEK twin is formatted', `const s = invoice.currency !== 'SEK' && invoice.total_sek ? formatCurrency(invoice.total_sek) : ''`],
    ['a camelCase SEK twin is formatted', `const s = invoice.currency ? formatCurrency(invoice.totalSek) : ''`],
    // journal_entry_lines.debit_amount is ALWAYS SEK; line.currency labels the
    // document. See lib/bookkeeping/ledger-line-amount.ts (structural root 4.1).
    ['a ledger column is formatted', `const s = line.currency !== 'SEK' ? formatCurrency(line.debit_amount) : ''`],
    ['the owner has no currency in the file', `const s = formatCurrency(row.amount)`],
    ['a different owner carries the currency', `const s = invoice.currency ? formatCurrency(candidate.amount) : ''`],
    // amount * rate is a conversion INTO kronor, so the result is SEK.
    ['the expression converts to SEK', `const s = invoice.currency ? formatCurrency(invoice.total * rate) : ''`],
    ['there is no formatCurrency call at all', `const s = invoice.currency + invoice.total`],
  ])('stays silent when %s', (_label, source) => {
    expect(scan('components/invoices/Clean.tsx', source)).toEqual([])
  })
})

describe('sek-labelled-amount guard: end to end through the CI entry point', () => {
  function fixtureTree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sek-label-guard-'))
    tempDirs.push(root)
    for (const [relPath, text] of Object.entries(files)) {
      const full = path.join(root, relPath)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, text)
    }
    return root
  }

  function run(root: string): { status: number; findings: { where: string; expr: string }[] } {
    try {
      const stdout = execFileSync('node', [GUARD, root, '--json'], { encoding: 'utf8' })
      return { status: 0, findings: JSON.parse(stdout) }
    } catch (e) {
      const err = e as { status: number; stdout: string }
      return { status: err.status, findings: JSON.parse(err.stdout) }
    }
  }

  const CLEAN = `
    export function SupplierInvoiceRow({ invoice }: { invoice: SupplierInvoice }) {
      return <td>{formatCurrency(invoice.total, invoice.currency)}</td>
    }
  `
  const OFFENDING = `
    export function SupplierInvoiceRow({ invoice }: { invoice: SupplierInvoice }) {
      if (invoice.currency !== 'SEK') return null
      return <td>{formatCurrency(invoice.total)}</td>
    }
  `

  it('exits 0 on a tree with only correct calls', () => {
    const result = run(fixtureTree({ 'components/suppliers/Row.tsx': CLEAN }))
    expect(result.findings).toEqual([])
    expect(result.status).toBe(0)
  })

  it('exits 1 and names the site once the offending call is introduced', () => {
    const result = run(fixtureTree({ 'components/suppliers/Row.tsx': OFFENDING }))
    expect(result.status).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].where).toBe('components/suppliers/Row.tsx:4')
    expect(result.findings[0].expr).toBe('invoice.total')
  })

  it('ignores test files, so a fixture in a spec cannot fail the build', () => {
    const result = run(fixtureTree({ 'components/suppliers/__tests__/Row.test.tsx': OFFENDING }))
    expect(result.findings).toEqual([])
    expect(result.status).toBe(0)
  })
})
