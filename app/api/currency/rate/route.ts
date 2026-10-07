import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { fetchExchangeRate, readCachedRate } from '@/lib/currency/riksbanken'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { Currency } from '@/types'

const VALID_CURRENCIES: Currency[] = ['EUR', 'USD', 'GBP', 'NOK', 'DKK']

// withRouteContext already refuses sessions without an active company.
export const GET = withRouteContext('currency.rate', async (request) => {
  const { searchParams } = new URL(request.url)
  const currency = searchParams.get('currency') as Currency | null
  const dateStr = searchParams.get('date')

  if (!currency || !VALID_CURRENCIES.includes(currency)) {
    return NextResponse.json({ error: 'Invalid currency' }, { status: 400 })
  }

  // Reject malformed dates up front: an Invalid Date would otherwise reach
  // the Riksbanken request as "NaN-NaN-NaN".
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return NextResponse.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 })
  }

  const date = dateStr ? new Date(dateStr) : undefined
  // The regex accepts shapes like 2025-13-45 that still parse to an Invalid
  // Date; catch those here so toISOString below cannot throw.
  if (date && Number.isNaN(date.getTime())) {
    return NextResponse.json({ error: 'Invalid date (expected YYYY-MM-DD)' }, { status: 400 })
  }

  // Same cache key fetchExchangeRate computes internally.
  const formattedDate = (date ?? new Date()).toISOString().split('T')[0]

  // exchange_rates is tenant-free public reference data (no company_id,
  // SELECT policy USING(true)), so a service-role read is safe here, and it
  // is the only client that can also WARM the cache: INSERT is service-role
  // only since migration 20260710100000. Riksbanken is only called on a
  // cache miss.
  const service = createServiceClientNoCookies()
  const cached = await readCachedRate(service, currency, formattedDate)

  const rate = cached ?? (await fetchExchangeRate(currency, date, service))

  if (!rate) {
    return NextResponse.json({ error: 'Could not fetch exchange rate' }, { status: 502 })
  }

  return NextResponse.json({ data: rate })
})
