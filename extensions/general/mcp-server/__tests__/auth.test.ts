import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(() => ({})),
  }
})

import { validateApiKey, ALL_SCOPES } from '@/lib/auth/api-keys'
import { handleMcpRequest } from '../server'

const mockValidateApiKey = vi.mocked(validateApiKey)

const ENDPOINT = 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'

function mcpRequest(authorization?: string): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

describe('MCP handler authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers 401 without a challenge header when no Bearer token is sent', async () => {
    const res = await handleMcpRequest(mcpRequest())

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
    expect(mockValidateApiKey).not.toHaveBeenCalled()
  })

  it('answers 401 without a challenge header when the key is rejected', async () => {
    mockValidateApiKey.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const res = await handleMcpRequest(mcpRequest('Bearer gnubok_sk_wrong'))

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('does not treat a non-Bearer scheme as a credential', async () => {
    const res = await handleMcpRequest(mcpRequest('Basic Zm9vOmJhcg=='))

    expect(res.status).toBe(401)
    expect(mockValidateApiKey).not.toHaveBeenCalled()
  })

  it('passes a rate-limited key through as 429 with Retry-After', async () => {
    mockValidateApiKey.mockResolvedValue({ error: 'Rate limit exceeded', status: 429 })

    const res = await handleMcpRequest(mcpRequest('Bearer gnubok_sk_busy'))

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
  })

  it('serves a request authenticated with a gnubok_sk_ key', async () => {
    mockValidateApiKey.mockResolvedValue({
      userId: 'user-1',
      companyId: '11111111-1111-4111-8111-111111111111',
      scopes: [...ALL_SCOPES],
      apiKeyId: 'key-1',
      apiKeyName: 'Bridge key',
      mode: 'live',
    })

    const res = await handleMcpRequest(mcpRequest('Bearer gnubok_sk_valid'))

    expect(mockValidateApiKey).toHaveBeenCalledWith('gnubok_sk_valid')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.result.tools)).toBe(true)
  })
})
