import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

const rpcMock = vi.fn(async () => ({ data: null, error: null as { message: string } | null }))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({ rpc: rpcMock })),
}))

import { GET } from '../route'

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/invoices/deliveries/redact/cron')
}

describe('invoice delivery PII redaction cron', () => {
  beforeEach(() => {
    rpcMock.mockClear()
    rpcMock.mockResolvedValue({ data: null, error: null })
  })

  it('invokes the redaction via rpc', async () => {
    const response = await GET(cronRequest())
    expect(response.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('redact_expired_invoice_delivery_pii')
    expect(await response.json()).toEqual({ success: true })
  })

  it('propagates rpc failures as an error response', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const response = await GET(cronRequest())
    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
