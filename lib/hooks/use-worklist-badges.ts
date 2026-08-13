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
 * queries nobody needs before first paint. Now they load after mount and
 * stay fresh via SWR's focus revalidation plus a polling interval, which
 * covers changes made outside this tab (the MCP bridge, cron, another
 * browser tab). SWR pauses the interval while the tab is hidden.
 *
 * The predicate deliberately mirrors lib/worklist/categories.ts so the badge
 * shows the same number as every other "att göra" surface; RLS scopes the
 * table, and the explicit company_id filter is defense in depth.
 */
export function useWorklistBadges(companyId: string | null | undefined) {
  const { data } = useSWR<WorklistBadges>(
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
    { refreshInterval: 60_000 },
  )

  return {
    pendingOperations: data?.pendingOperations ?? 0,
  }
}
