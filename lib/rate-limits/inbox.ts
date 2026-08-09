import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Per-company rate limiter for document-inbox ingestion. Backed by the
 * `check_and_increment_inbox_quota` Postgres RPC (atomic check + increment),
 * not Upstash: keeps the limiter on the same shared distributed store the
 * rest of the app already hits, and works without extra env vars on Vercel
 * and Docker self-hosters alike.
 *
 * Both windows are per-company. On a single-user install the only real
 * client is the owner or their MCP agent, and an agent batch-importing a
 * folder of documents is legitimate traffic, so the ceilings sit far above
 * any honest workload and only stop runaway loops.
 */
export interface InboxLimitResult {
  ok: boolean
  retryAfterSec?: number
  scope?: 'minute' | 'day'
}

const MINUTE_MAX = 600
const DAY_MAX = 20000

export async function checkInboxUploadRateLimit(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InboxLimitResult> {
  const { data, error } = await supabase.rpc('check_and_increment_inbox_quota', {
    p_company_id: companyId,
    p_minute_max: MINUTE_MAX,
    p_day_max: DAY_MAX,
  })
  if (error) {
    // Fail open on infra error. The limiter is defense-in-depth: per-file
    // size + MIME checks still apply on the upload route. Better to accept
    // an upload than 500 a real user because Postgres blipped.
    console.error('[inbox-rate-limit] RPC failed:', error)
    return { ok: true }
  }
  // RPC returns jsonb_build_object payload. The JS client decodes as object.
  const result = (data ?? { ok: true }) as {
    ok: boolean
    scope?: 'minute' | 'day'
    retry_after_sec?: number
  }
  return {
    ok: result.ok,
    scope: result.scope,
    retryAfterSec: result.retry_after_sec,
  }
}
