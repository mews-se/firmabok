import { describe, it, expect } from 'vitest'
import { companyCurrentResource } from '../resources/company-current'

/**
 * The shared mock Supabase harness is a permissive proxy: it accepts any
 * `.select()` string and resolves to whatever was enqueued, so a column that
 * does not exist in Postgres passes every mocked test and only fails silently
 * in production (PostgREST errors, the resource swallows it, the derived field
 * is null forever). That is exactly how `invoices.sent_at` shipped: a phantom
 * column that told every MCP agent no invoice had ever been sent.
 *
 * This recorder captures the table and column list of each query so the tests
 * below can assert on what was actually requested.
 */
type RecordedCall = {
  table: string
  select: string | null
  selectOptions: Record<string, unknown> | null
  methods: { name: string; args: unknown[] }[]
}

type QueryResult = { data?: unknown; error?: unknown; count?: number | null }

function createRecordingSupabase(results: QueryResult[]) {
  const calls: RecordedCall[] = []
  let index = 0

  const from = (table: string) => {
    const result = results[index++] ?? {}
    const call: RecordedCall = { table, select: null, selectOptions: null, methods: [] }
    calls.push(call)

    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void) =>
              resolve({
                data: result.data ?? null,
                error: result.error ?? null,
                count: result.count ?? null,
              })
          }
          return (...args: unknown[]) => {
            if (prop === 'select') {
              call.select = (args[0] as string) ?? null
              call.selectOptions = (args[1] as Record<string, unknown>) ?? null
            }
            call.methods.push({ name: String(prop), args })
            return chain
          }
        },
      },
    )

    return chain
  }

  return { supabase: { from } as never, calls }
}

const ctx = (supabase: never) => ({
  supabase,
  companyId: 'company-1',
  userId: 'user-1',
  scopes: [],
})

/**
 * The queries in the order the resource issues them inside its Promise.all.
 * Every column here was verified to exist against the production schema
 * (information_schema.columns, project pwxtzglxptnnvjrpixpg) on 2026-07-26.
 * If you change a select, re-verify it there before updating this list: the
 * mocked harness will not catch a name you invented.
 */
const EXPECTED_QUERIES: { table: string; columns: string[] }[] = [
  { table: 'companies', columns: ['id', 'name', 'org_number', 'entity_type', 'archived_at', 'created_at'] },
  {
    table: 'company_settings',
    columns: [
      'f_skatt', 'vat_registered', 'vat_number', 'moms_period',
      'fiscal_year_start_month', 'accounting_method', 'default_voucher_series',
      'bookkeeping_locked_through', 'auto_lock_period_days', 'invoice_prefix',
      'next_invoice_number', 'invoice_default_days',
    ],
  },
  {
    table: 'fiscal_periods',
    columns: ['id', 'name', 'period_start', 'period_end', 'is_closed', 'locked_at', 'closing_entry_id'],
  },
  { table: 'fiscal_periods', columns: ['id', 'name', 'period_start', 'period_end', 'locked_at'] },
  { table: 'customers', columns: ['id'] },
  { table: 'suppliers', columns: ['id'] },
  { table: 'invoices', columns: ['id'] },
  { table: 'supplier_invoices', columns: ['id'] },
  {
    table: 'voucher_sequences',
    columns: [
      'voucher_series', 'last_number', 'fiscal_period_id',
      'fiscal_periods!inner(name, period_start, period_end)',
    ],
  },
  { table: 'deadlines', columns: ['id', 'title', 'due_date', 'deadline_type', 'priority', 'status'] },
]

/** One empty result per query, so the resource can run end to end. */
function emptyResults(): QueryResult[] {
  const results: QueryResult[] = EXPECTED_QUERIES.map(() => ({ data: null, count: 0 }))
  results[0] = { data: { id: 'company-1', name: 'Test AB' } }
  return results
}

function parseColumns(select: string | null): string[] {
  if (!select) return []
  // Split on commas that are not inside an embedded-resource parenthesis.
  const columns: string[] = []
  let depth = 0
  let current = ''
  for (const char of select) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === ',' && depth === 0) {
      columns.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) columns.push(current.trim())
  return columns.filter(Boolean)
}

describe('Accounted://company/current query shape', () => {
  it('requests only tables and columns that exist in the schema', async () => {
    const { supabase, calls } = createRecordingSupabase(emptyResults())

    await companyCurrentResource.read(ctx(supabase))

    expect(calls.map((c) => c.table)).toEqual(EXPECTED_QUERIES.map((q) => q.table))
    calls.forEach((call, i) => {
      expect(parseColumns(call.select)).toEqual(EXPECTED_QUERIES[i].columns)
    })
  })
})
