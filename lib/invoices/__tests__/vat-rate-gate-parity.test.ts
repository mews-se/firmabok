/**
 * Every server-side write path that validates an invoice line's VAT rate must
 * gate on the SAME set, or the surfaces disagree about what is lawful: the web
 * UI would accept a 12% hotel night to a German company while the REST bulk
 * create, an MCP-staged commit, a recurring schedule or a self-bill refused it.
 *
 * The guarantee is structural, not coincidental: all of them call the one shared
 * getPermittedVatRates(customer_type, vat_number_validated) with the same two
 * fields off the same customers row, and all of them fall back to
 * getVatRules().rate (0% for a foreign business) when a line omits vat_rate. So
 * this pins the call, which is the part a future edit could quietly change back.
 *
 * The MCP staging tool (gnubok_create_invoice) is in the list too: it gates at
 * staging time, so gating it on the default set refused a lawful invoice before
 * the executor's own gate was ever reached.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../..')

const WRITE_GATES = [
  'lib/invoices/build-invoice-write.ts',
  'lib/invoices/self-billed-sale.ts',
  'lib/invoices/recurring-schedule-service.ts',
  'lib/pending-operations/commit.ts',
  'app/api/v1/companies/[companyId]/invoices/bulk-create/route.ts',
  'extensions/general/mcp-server/server.ts',
]

describe('invoice VAT-rate gates agree with buildInvoiceWriteData', () => {
  for (const relative of WRITE_GATES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')

    it(`${relative} gates on getPermittedVatRates`, () => {
      expect(source).toContain('getPermittedVatRates(')
    })

    it(`${relative} does not gate on the picker default`, () => {
      // getAvailableVatRates is the DEFAULT offered in the picker (a single
      // locked 0% for a foreign business customer). Using it as the validation
      // gate is what made a taxed-where-performed invoice impossible to issue.
      expect(source).not.toContain('getAvailableVatRates')
    })
  }
})
