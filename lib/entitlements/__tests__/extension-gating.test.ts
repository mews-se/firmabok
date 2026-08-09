import { describe, it, expect } from 'vitest'
import {
  EXTENSION_REQUIRED_CAPABILITY,
  requiredCapabilityForExtension,
} from '../keys'

describe('requiredCapabilityForExtension', () => {
  it('gates no extension workspaces (the map is empty)', () => {
    expect(EXTENSION_REQUIRED_CAPABILITY).toEqual({})
  })

  it('returns undefined for any extension', () => {
    expect(requiredCapabilityForExtension('general', 'mcp-server')).toBeUndefined()
    expect(requiredCapabilityForExtension('general', 'does-not-exist')).toBeUndefined()
  })
})
