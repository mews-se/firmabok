import { describe, expect, it } from 'vitest'
import { resolveRequiredScope } from '../scopes'

describe('resolveRequiredScope', () => {
  it('returns public for the health endpoint', () => {
    expect(resolveRequiredScope('GET', '/api/v1/health')).toBe('public')
  })

  it('returns public for openapi.json', () => {
    expect(resolveRequiredScope('GET', '/api/v1/openapi.json')).toBe('public')
  })

  it('resolves the companies:read scope for GET /api/v1/companies', () => {
    expect(resolveRequiredScope('GET', '/api/v1/companies')).toBe('companies:read')
  })

  it('resolves :param patterns to a single scope', () => {
    expect(
      resolveRequiredScope('GET', '/api/v1/companies/8fd5b1f4-1111-2222-3333-444455556666'),
    ).toBe('companies:read')
  })

  it('returns null for unknown paths', () => {
    expect(resolveRequiredScope('GET', '/api/v1/non-existent')).toBeNull()
  })

  it('does not match the wrong HTTP method', () => {
    expect(resolveRequiredScope('DELETE', '/api/v1/companies')).toBeNull()
  })

  it('does not let :param greedily consume slashes', () => {
    // /companies/{companyId} should not match /companies/abc/extra
    expect(resolveRequiredScope('GET', '/api/v1/companies/abc/extra')).toBeNull()
  })
})
