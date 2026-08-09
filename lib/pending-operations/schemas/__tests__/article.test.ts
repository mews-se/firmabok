import { describe, it, expect } from 'vitest'
import { CreateArticleParamsSchema, UpdateArticleParamsSchema } from '../article'

const base = { name: 'EU-konsulting', price_excl_vat: 950 }

describe('CreateArticleParamsSchema currency', () => {
  it('accepts and normalizes an ISO code to upper case', () => {
    const parsed = CreateArticleParamsSchema.parse({ ...base, currency: 'eur' })
    expect(parsed.currency).toBe('EUR')
  })

  it('treats empty string and null as unset (commit defaults to SEK)', () => {
    expect(CreateArticleParamsSchema.parse({ ...base, currency: '' }).currency).toBeUndefined()
    expect(CreateArticleParamsSchema.parse({ ...base, currency: null }).currency).toBeUndefined()
    expect(CreateArticleParamsSchema.parse(base).currency).toBeUndefined()
  })

  it('rejects non-ISO shapes', () => {
    expect(() => CreateArticleParamsSchema.parse({ ...base, currency: 'EURO' })).toThrow()
    expect(() => CreateArticleParamsSchema.parse({ ...base, currency: 'E1' })).toThrow()
  })
})

describe('UpdateArticleParamsSchema currency', () => {
  const id = { article_id: '3a9ac4d2-163a-4d43-8fa3-1b32827505fa' }

  it('accepts a currency-only update', () => {
    const parsed = UpdateArticleParamsSchema.parse({ ...id, currency: 'usd' })
    expect(parsed.currency).toBe('USD')
  })

  it('leaves currency undefined when omitted (sparse update must not touch it)', () => {
    const parsed = UpdateArticleParamsSchema.parse({ ...id, name: 'Nytt namn' })
    expect(parsed.currency).toBeUndefined()
  })
})
