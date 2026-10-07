export function getCreditNoteSendMode(input: {
  customerHasEmail: boolean
  isSandbox: boolean
}): 'email' | 'manual' {
  return input.customerHasEmail && !input.isSandbox ? 'email' : 'manual'
}
