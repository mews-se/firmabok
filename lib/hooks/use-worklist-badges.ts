'use client'

import useSWR from 'swr'
import { createClient } from '@/lib/supabase/client'

export interface WorklistBadges {
  /** Agent-staged operations awaiting review: same predicate as countPendingOperations. */
  pendingOperations: number
}

/**
 * Client-side nav badge counts. These used to be fetched by the dashboard
 * layout on the critical path of every server navigation; head-count
 * queries nobody needs before first paint. Now they load (and revalidate)
 * after mount, and SWR dedupes the realtime-triggered refreshes that
 * previously stampeded during bulk operations.
 *
 * The predicate deliberately mirrors lib/worklist/categories.ts so the badge
 * shows the same number as every other "att göra" surface; RLS scopes the
 * table, and the explicit company_id filter is defense in depth.
 */
export function useWorklistBadges(companyId: string | null | undefined) {
  const { data, mutate } = useSWR<WorklistBadges>(
    companyId ? ['worklist-badges', companyId] : null,
    async ([, id]: [string, string]) => {
      const supabase = createClient()
      const ops = await supabase
        .from('pending_operations')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', id)
        .eq('status', 'pending')
      return {
        pendingOperations: ops.error ? 0 : (ops.count ?? 0),
      }
    },
  )

  return {
    pendingOperations: data?.pendingOperations ?? 0,
    // SWR's bound mutate is referentially stable, so consumers can list it in
    // effect deps without re-subscribing on every render.
    refresh: mutate,
  }
}
