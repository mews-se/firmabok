import { NextResponse } from 'next/server'
import { parseBankFile, generateFileHash, detectFileFormat } from '@/lib/import/bank-file/parser'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/import/bank-file/parse
 *
 * Accepts a bank file (CSV/XML) via FormData, auto-detects format, and returns
 * a parsed transactions preview with duplicate detection.
 */
export const POST = withRouteContext(
  'bank_file.parse',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const formatOverride = formData.get('format') as BankFileFormatId | null

    if (!file) {
      return errorResponseFromCode('BANK_FILE_NO_FILE', log, { requestId })
    }

    if (file.size > 10 * 1024 * 1024) {
      return errorResponseFromCode('BANK_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      const arrayBuffer = await file.arrayBuffer()
      const content = decodeFileContent(arrayBuffer)
      const fileHash = generateFileHash(content)

      const { data: existingImport } = await supabase
        .from('bank_file_imports')
        .select('id, status, imported_count, created_at')
        .eq('company_id', companyId)
        .eq('file_hash', fileHash)
        .single()

      if (existingImport && existingImport.status === 'completed') {
        return errorResponseFromCode('BANK_FILE_DUPLICATE', opLog, {
          requestId,
          details: {
            importId: existingImport.id,
            importedCount: existingImport.imported_count,
            importedAt: existingImport.created_at,
          },
        })
      }

      const detectedFormat = formatOverride
        ? null
        : detectFileFormat(content, file.name)

      const parseResult = parseBankFile(content, file.name, formatOverride || undefined)

      let existingCount = 0
      if (parseResult.transactions.length > 0) {
        const { count } = await supabase
          .from('transactions')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .gte('date', parseResult.date_from || '1970-01-01')
          .lte('date', parseResult.date_to || '2099-12-31')

        existingCount = count || 0
      }

      return NextResponse.json({
        data: {
          parse_result: parseResult,
          detected_format: detectedFormat?.id || formatOverride || null,
          detected_format_name: detectedFormat?.name || parseResult.format_name,
          file_hash: fileHash,
          filename: file.name,
          existing_transaction_count: existingCount,
          headers: parseResult.format === 'generic_csv'
            ? content.split('\n')[0]?.split(',').map((h) => h.trim()) || []
            : null,
        },
      })
    } catch (err) {
      opLog.error('bank file parse failed', err as Error)
      return errorResponseFromCode('BANK_FILE_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
