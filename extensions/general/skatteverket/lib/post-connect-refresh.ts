import type { SupabaseClient } from '@supabase/supabase-js'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createLogger } from '@/lib/logger'
import { syncSkattekonto } from './skattekonto-sync'
import { SkatteverketAuthError } from './api-client'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from './token-store'

const log = createLogger('skatteverket-post-connect')

/**
 * Refresh Skatteverket-derived data right after a successful BankID consent.
 *
 * SKV's `per`-flow tokens (and their refresh tokens) live ~65 minutes, so the
 * nightly skattekonto cron usually finds them dead: right after consent is the
 * one reliable window where a personal-token fetch is guaranteed to work. The
 * OAuth callback awaits this before responding, so when the popup closes the
 * skattekonto rows are upserted; UI listeners can refetch without racing a
 * background job.
 *
 * Best-effort by contract: every step has its own try/catch and this function
 * never throws. A refresh failure must never fail the connect that just
 * succeeded.
 */
export interface PostConnectRefreshResult {
  synced: boolean
}

export async function runPostConnectRefresh(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<PostConnectRefreshResult> {
  const result: PostConnectRefreshResult = { synced: false }

  try {
    if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) {
      return result
    }
  } catch (err) {
    log.warn('post-connect capability check failed', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    return result
  }

  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    await syncSkattekonto(ctx)
    result.synced = true
  } catch (err) {
    log.warn('post-connect skattekonto sync failed', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    // A terminal auth error immediately after a fresh consent means the
    // just-granted token itself is unusable; in practice MISSING_SCOPE,
    // when the user skipped a behörighet on SKV's consent page. Persist
    // the health flag (same mechanism as the crons) so /status reports
    // needsReconsent and the connect panel can prompt with a specific
    // "godkänn alla behörigheter" message instead of a silent success.
    if (
      err instanceof SkatteverketAuthError &&
      (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
    ) {
      await markNeedsReconsent(supabase, userId, err.code)
    }
  }

  return result
}
