import { describe, it, expect } from 'vitest'
import { hasCp1252Artifact } from '../charset-repair'

describe('hasCp1252Artifact', () => {
  it('flags a C1 special standing in for a letter', () => {
    expect(hasCp1252Artifact('F”rmedlad frakt')).toBe(true)
    expect(hasCp1252Artifact('™vriga fastighetskostnader')).toBe(true) // Ö→™ at word start
  })

  it('leaves correctly decoded names alone', () => {
    expect(hasCp1252Artifact('Förmedlad frakt')).toBe(false)
  })

  it('does NOT flag a legitimate space-padded en-dash', () => {
    // Real BAS names: "Kundfordringar – delad faktura" (1513), "Periodiseringsfond
    // 2021 – nr 2". The en-dash is space-padded punctuation, not a mangled letter.
    expect(hasCp1252Artifact('Kundfordringar – delad faktura')).toBe(false)
    expect(hasCp1252Artifact('Periodiseringsfond 2021 – nr 2')).toBe(false)
  })
})
