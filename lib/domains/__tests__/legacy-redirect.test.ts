import { describe, it, expect } from 'vitest'
import { isRedirectedFromLegacyHost } from '../legacy-redirect'

describe('legacy-host redirect exclusions', () => {
  it('forwards ordinary pages to the new domain', () => {
    expect(isRedirectedFromLegacyHost('/')).toBe(true)
    expect(isRedirectedFromLegacyHost('/dashboard')).toBe(true)
    expect(isRedirectedFromLegacyHost('/reports')).toBe(true)
    // The login page MUST redirect: a usable login page on the legacy
    // host would establish sessions there and loop users between domains.
    expect(isRedirectedFromLegacyHost('/login')).toBe(true)
  })

  it('keeps machine surfaces on the legacy host', () => {
    expect(isRedirectedFromLegacyHost('/api/events')).toBe(false)
    expect(isRedirectedFromLegacyHost('/api/extensions/ext/mcp-server/mcp')).toBe(false)
    expect(isRedirectedFromLegacyHost('/.well-known/oauth-authorization-server')).toBe(false)
    expect(isRedirectedFromLegacyHost('/_next/static/chunk.js')).toBe(false)
  })
})
