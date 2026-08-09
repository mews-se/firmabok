/**
 * Unit tests for the staged kontoplan tools: gnubok_create_account and
 * gnubok_update_account. Covers registration/scope/risk-tier wiring, the
 * BAS 2026 prefill (resolve-don't-guess), the duplicate/inactive pre-flight
 * gates, and dry-run staging behaviour. Executor-side coverage
 * (commitCreateAccount / commitUpdateAccount) lives in
 * lib/pending-operations/__tests__/account-and-note-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

const createAccount = tools.find((t) => t.name === 'gnubok_create_account')!
const updateAccount = tools.find((t) => t.name === 'gnubok_update_account')!

/**
 * A 4-digit number guaranteed absent from the BAS 2026 catalog, in classes
 * 4-7 so the fixture's account_type 'expense' passes the class/type
 * consistency guard.
 */
function findNonBasNumber(): string {
  for (let n = 4000; n <= 7999; n++) {
    const candidate = String(n)
    if (!getBASReference(candidate)) return candidate
  }
  throw new Error('BAS catalog unexpectedly covers every 4-digit expense number')
}
const NON_BAS_NUMBER = findNonBasNumber()

const noopSupabase = { from: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('kontoplan tools: registration', () => {
  it('both tools exist, stage, and declare strict schemas', () => {
    for (const tool of [createAccount, updateAccount]) {
      expect(tool).toBeDefined()
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
      const out = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
      expect(out?.properties?.staged).toBeDefined()
      expect(out?.required).toContain('staged')
      expect(tool.description).toMatch(/stag(e|es|ing)/i)
      expect(tool.annotations.readOnlyHint).toBe(false)
      expect(tool.annotations.destructiveHint).toBe(false)
    }
  })

  it('only requires account_number', () => {
    expect((createAccount.inputSchema as { required?: string[] }).required).toEqual(['account_number'])
    expect((updateAccount.inputSchema as { required?: string[] }).required).toEqual(['account_number'])
  })

  it('is mapped to bookkeeping:write scope and low risk tier', () => {
    expect(TOOL_SCOPE_MAP.gnubok_create_account).toBe('bookkeeping:write')
    expect(TOOL_SCOPE_MAP.gnubok_update_account).toBe('bookkeeping:write')
    expect(OPERATION_RISK_TIERS.create_account).toBe('low')
    expect(OPERATION_RISK_TIERS.update_account).toBe('low')
  })
})

describe('gnubok_create_account: validation gates', () => {
  it('rejects a non-4-digit account number before any DB call', async () => {
    await expect(
      createAccount.execute({ account_number: '193' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/4 digits/)
    await expect(
      createAccount.execute({ account_number: '19300' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/4 digits/)
  })

  it('rejects when the account already exists and is active', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true } })
    await expect(
      createAccount.execute({ account_number: '5410' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/finns redan/)
  })

  it('points to gnubok_update_account when the account exists but is inactive', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: false } })
    await expect(
      createAccount.execute({ account_number: '5410' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/inaktivt.*is_active=true/s)
  })

  it('rejects a non-BAS number without name/type/balance', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // no existing row
    await expect(
      createAccount.execute({ account_number: NON_BAS_NUMBER }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/not in the BAS 2026 catalog/)
  })

  it('rejects a percent-style default_vat_rate (must be a fraction)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      createAccount.execute(
        { account_number: '5410', default_vat_rate: 25 },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/fraction, not percent/)
  })

  it('rejects an account_type inconsistent with the BAS class digit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // no existing row
    await expect(
      createAccount.execute(
        { account_number: '2999', account_name: 'Fel', account_type: 'expense', normal_balance: 'debit' },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/BAS class 2/)
  })

  it('exposes untaxed_reserves in the input schema enum (21xx round-trip)', () => {
    const props = (createAccount.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
    expect(props.account_type.enum).toContain('untaxed_reserves')
  })
})

describe('gnubok_create_account: staging behaviour (dry_run)', () => {
  it('prefills name/type/balance/SRU from the BAS catalog', async () => {
    const ref = getBASReference('5410')!
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // no existing row
    const result = (await createAccount.execute(
      { account_number: '5410', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({
      account_number: '5410',
      account_name: ref.account_name,
      account_type: ref.account_type,
      normal_balance: ref.normal_balance,
      plan_type: 'full_bas',
      source: 'bas_2026',
    })
  })

  it('explicit args win over the BAS prefill', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = (await createAccount.execute(
      { account_number: '5410', account_name: 'Verktyg och maskiner', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.account_name).toBe('Verktyg och maskiner')
    expect(result.preview.source).toBe('bas_2026')
  })

  it('stages a fully-specified custom account as plan_type k1 / source custom', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const result = (await createAccount.execute(
      {
        account_number: NON_BAS_NUMBER,
        account_name: 'Eget specialkonto',
        account_type: 'expense',
        normal_balance: 'debit',
        dry_run: true,
      },
      'company-1', 'user-1', supabase as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview).toMatchObject({
      account_number: NON_BAS_NUMBER,
      account_name: 'Eget specialkonto',
      account_type: 'expense',
      normal_balance: 'debit',
      plan_type: 'k1',
      source: 'custom',
    })
  })
})

describe('gnubok_update_account', () => {
  it('rejects a non-4-digit account number before any DB call', async () => {
    await expect(
      updateAccount.execute({ account_number: 'abcd' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/4 digits/)
  })

  it('points to gnubok_create_account when the account does not exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      updateAccount.execute(
        { account_number: '5410', account_name: 'Nytt namn' },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/finns inte.*gnubok_create_account/s)
  })

  it('rejects a call with no fields to change', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '5410', account_name: 'Förbrukningsinventarier', is_active: true } })
    await expect(
      updateAccount.execute({ account_number: '5410' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/Nothing to update/)
  })

  it('dry-run preview carries current values and the requested changes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        account_number: '5410',
        account_name: 'Förbrukningsinventarier',
        description: null,
        default_vat_code: null,
        default_vat_rate: null,
        sru_code: '7321', // 5410's catalog value (lib/bookkeeping/bas-data)
        is_active: true,
      },
    })
    const result = (await updateAccount.execute(
      { account_number: '5410', account_name: 'Verktyg', is_active: false, dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { dry_run?: boolean; preview: { current: Record<string, unknown>; changes: Record<string, unknown> } }

    expect(result.dry_run).toBe(true)
    expect(result.preview.current.account_name).toBe('Förbrukningsinventarier')
    expect(result.preview.changes).toEqual({ account_name: 'Verktyg', is_active: false })
  })
})
