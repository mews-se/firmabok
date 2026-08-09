/**
 * Shared helpers for v1 report endpoints.
 *
 * Most reports follow the same shape: parse `period_id` from the query
 * string, validate it as a UUID, and confirm it's a fiscal period the
 * caller's company owns before invoking the lib generator. This helper
 * centralises that pattern so each route stays at ~40 lines of business
 * logic and the validation behavior stays consistent across all reports.
 */

import { z } from 'zod'
import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { v1ErrorResponse, v1ErrorResponseFromCode } from './errors'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export interface FiscalPeriodRow {
  id: string
  period_start: string
  period_end: string
  is_closed: boolean
  locked_at: string | null
}

export type PeriodResult =
  | { ok: true; period: FiscalPeriodRow }
  | { ok: false; response: Response }

/**
 * Parse + validate `period_id` from the URL's query string, then load the
 * matching `fiscal_periods` row scoped to the caller's company. Returns
 * either the row (success) or a pre-built error response (caller just
 * returns it).
 *
 * Why a tight helper: every report endpoint does this same 4-step dance
 * (parse query, validate UUID, fetch period, 404 on miss). Pulling it
 * out reduces each route to its actual business logic.
 */
export async function loadPeriodFromQuery(
  request: Request,
  ctx: {
    supabase: SupabaseClient
    companyId: string
    requestId: string
    log: Logger
  },
): Promise<PeriodResult> {
  const url = new URL(request.url)
  const periodId = url.searchParams.get('period_id')

  if (!periodId) {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'period_id', message: 'period_id query parameter is required.' },
      }),
    }
  }

  if (!UUID_RE.test(periodId)) {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'period_id', message: 'period_id must be a UUID.' },
      }),
    }
  }

  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, is_closed, locked_at')
    .eq('id', periodId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()

  if (error) {
    return {
      ok: false,
      response: await v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId }),
    }
  }
  if (!data) {
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'fiscal_period', id: periodId },
      }),
    }
  }

  return { ok: true, period: data as FiscalPeriodRow }
}

/**
 * Wrap a report-generator call in a try/catch that surfaces a structured
 * REPORT_GENERATION_FAILED error if the generator throws. Mirrors the
 * dashboard's pattern so any lib-layer exception becomes a clean v1
 * envelope rather than leaking the underlying error.
 */
export async function safeGenerate<T>(
  generate: () => Promise<T>,
  ctx: { log: Logger; requestId: string; reportName: string },
): Promise<{ ok: true; result: T } | { ok: false; response: NextResponse }> {
  try {
    const result = await generate()
    return { ok: true, result }
  } catch (err) {
    ctx.log.error(`${ctx.reportName} report generation failed`, err as Error)
    return {
      ok: false,
      response: await v1ErrorResponseFromCode('REPORT_GENERATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          report: ctx.reportName,
          reason: err instanceof Error ? err.message : 'unknown',
        },
      }),
    }
  }
}
