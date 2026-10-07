import { describe, expect, it } from 'vitest'
import { getCreditNoteSendMode } from '@/lib/invoices/credit-note-send-mode'

describe('getCreditNoteSendMode', () => {
  it('prefers email when delivery is available and the customer has an address', () => {
    expect(getCreditNoteSendMode({
      customerHasEmail: true,
      isSandbox: false,
    })).toBe('email')
  })

  it.each([
    { customerHasEmail: false, isSandbox: false },
    { customerHasEmail: true, isSandbox: true },
  ])('falls back to manual issuance for $customerHasEmail/$isSandbox', (input) => {
    expect(getCreditNoteSendMode(input)).toBe('manual')
  })
})
