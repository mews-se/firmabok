import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { tools } from '../server'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const tool = () => tools.find((candidate) => candidate.name === 'gnubok_update_customer')!

function currentCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    name: 'Test Customer AB',
    customer_type: 'swedish_business',
    customer_number: '1001',
    email: 'billing@example.test',
    phone: '',
    address_line1: 'Testgatan 1',
    address_line2: null,
    postal_code: '12345',
    city: 'Teststad',
    country: 'Sweden',
    org_number: '556000-0000',
    vat_number: null,
    vat_number_validated: false,
    language: 'sv',
    default_payment_terms: 30,
    notes: null,
    ...overrides,
  }
}

describe('gnubok_update_customer: registration', () => {
  it('is a strict, staged customers:write tool at low risk', () => {
    expect(tool()).toBeDefined()
    expect(tool().inputSchema.additionalProperties).toBe(false)
    expect(tool().annotations.readOnlyHint).toBe(false)
    expect(tool().annotations.idempotentHint).toBe(true)
    expect(tool().catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_update_customer).toBe('customers:write')
    expect(OPERATION_RISK_TIERS.update_customer).toBe('low')
  })

  it('does not expose personal_number as an input', () => {
    const properties = tool().inputSchema.properties as Record<string, unknown>
    expect(properties).not.toHaveProperty('personal_number')
  })

  it('keeps the wide write schema discoverable through tool search', async () => {
    const search = tools.find((candidate) => candidate.name === 'gnubok_search_tools')!
    const result = (await search.execute(
      {
        query: 'update customer',
        detail: 'full',
        __keyScopes: ['customers:write'],
      },
      'company-1',
      'user-1',
      {} as never,
    )) as { tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> }

    expect(result.tools).toEqual([
      expect.objectContaining({
        name: 'gnubok_update_customer',
        inputSchema: expect.any(Object),
      }),
    ])
  })
})

describe('gnubok_update_customer: validation and staging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires at least one changed field', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/at least one/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects malformed email before querying the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, email: 'not-an-email', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/email/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails when the customer is outside the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      tool().execute(
        { customer_id: CUSTOMER_ID, city: 'New City', dry_run: true },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toThrow(/not found/i)
  })

  it('returns a merged dry-run preview without staging', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer() })

    const result = (await tool().execute(
      {
        customer_id: CUSTOMER_ID,
        city: 'New City',
        default_payment_terms: 14,
        dry_run: true,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as {
      staged: boolean
      dry_run?: boolean
      preview: { proposed?: Record<string, unknown> }
    }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.preview.proposed).toMatchObject({
      customer_id: CUSTOMER_ID,
      name: 'Test Customer AB',
      city: 'New City',
      default_payment_terms: 14,
    })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('stages the partial update for approval', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: currentCustomer() })
    enqueue({ data: { id: 'op-customer-1' } })

    const result = (await tool().execute(
      { customer_id: CUSTOMER_ID, phone: '0701234567' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; operation_id?: string; risk_level: string }

    expect(result).toMatchObject({
      staged: true,
      operation_id: 'op-customer-1',
      risk_level: 'low',
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'pending_operations')
  })
})
