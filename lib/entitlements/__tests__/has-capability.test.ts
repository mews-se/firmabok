import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasCapability,
  requireCapability,
  capabilityBlockedResponse,
  getCompanyIdsWithCapability,
  getCompanyEntitlements,
} from '../has-capability'
import { CAPABILITY, PAID_CAPABILITIES } from '../keys'

// Self-hosted is permanently all-on: the gate answers without touching the
// DB, so a client that throws on any use proves the short-circuit.
const supabase = new Proxy(
  {},
  {
    get() {
      throw new Error('the bypassed gate must not query the database')
    },
  },
) as unknown as SupabaseClient

const companyId = '11111111-1111-4111-8111-111111111111'

describe('hasCapability', () => {
  it('always holds (self-hosted is all-on)', async () => {
    expect(await hasCapability(supabase, companyId, CAPABILITY.ai)).toBe(true)
  })
})

describe('requireCapability', () => {
  it('always proceeds', async () => {
    expect(await requireCapability(supabase, companyId, CAPABILITY.ai)).toBeNull()
  })
})

describe('getCompanyIdsWithCapability', () => {
  it('returns every valid requested company, deduplicated', async () => {
    const result = await getCompanyIdsWithCapability(
      supabase,
      [companyId, companyId, 'not-a-uuid'],
      CAPABILITY.skatteverket,
    )
    expect([...result]).toEqual([companyId])
  })
})

describe('getCompanyEntitlements', () => {
  it('holds every paid capability', async () => {
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.capabilities).toEqual([...PAID_CAPABILITIES])
  })
})

describe('capabilityBlockedResponse', () => {
  it('returns a bilingual 403 carrying the capability key', async () => {
    const res = capabilityBlockedResponse(CAPABILITY.bank_sync)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBeTruthy()
    expect(body.error_en).toBeTruthy()
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe(CAPABILITY.bank_sync)
  })
})
