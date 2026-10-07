import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('APP_NAME', () => {
  it('defaults to Accounted', async () => {
    vi.stubEnv('NEXT_PUBLIC_BRANDING_APP_NAME', '')
    const { APP_NAME } = await import('../brand')
    expect(APP_NAME).toBe('Accounted')
  })

  it('takes the name from NEXT_PUBLIC_BRANDING_APP_NAME', async () => {
    vi.stubEnv('NEXT_PUBLIC_BRANDING_APP_NAME', 'Firmabok')
    const { APP_NAME } = await import('../brand')
    expect(APP_NAME).toBe('Firmabok')
  })
})
