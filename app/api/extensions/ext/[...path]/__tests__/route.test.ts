import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'
import { NextResponse } from 'next/server'

// Mock dependencies
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn().mockReturnValue({
    userId: 'user-1',
    extensionId: 'test-ext',
  }),
}))

import { createClient } from '@/lib/supabase/server'
import { extensionRegistry } from '@/lib/extensions/registry'
import { GET, POST } from '../route'

const mockCreateClient = vi.mocked(createClient)

function createPathParams(path: string[]) {
  return { params: Promise.resolve({ path }) }
}

describe('Extension Catch-All Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    extensionRegistry.clear()
  })

  it('returns 400 for empty path', async () => {
    const request = createMockRequest('/api/extensions/ext/')
    const response = await GET(request, createPathParams([]))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('returns 404 for unknown extension', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/nonexistent/foo')
    const response = await GET(request, createPathParams(['nonexistent', 'foo']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('returns 401 when not authenticated', async () => {
    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/data', handler: vi.fn() }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Not authenticated' },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/test-ext/data')
    const response = await GET(request, createPathParams(['test-ext', 'data']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 for unmatched method/path', async () => {
    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'POST', path: '/data', handler: vi.fn() }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    // GET doesn't match POST /data
    const request = createMockRequest('/api/extensions/ext/test-ext/data')
    const response = await GET(request, createPathParams(['test-ext', 'data']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('dispatches to matching handler with context', async () => {
    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ banks: [] })
    )

    extensionRegistry.register({
      id: 'enable-banking',
      name: 'Enable Banking',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/banks', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/enable-banking/banks')
    const response = await GET(request, createPathParams(['enable-banking', 'banks']))
    const { status, body } = await parseJsonResponse<{ banks: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.banks).toEqual([])
    expect(handler).toHaveBeenCalledWith(request, expect.objectContaining({
      extensionId: 'test-ext',
    }))
  })

  it('dispatches POST requests correctly', async () => {
    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true })
    )

    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'POST', path: '/connect', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/test-ext/connect', {
      method: 'POST',
      body: { foo: 'bar' },
    })
    const response = await POST(request, createPathParams(['test-ext', 'connect']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(handler).toHaveBeenCalled()
  })

})
