/**
 * SEB CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator
 * Columns vary but typically: Bokföringsdag, Valutadag, Verifikationsnummer,
 *   Text/mottagare, Belopp, Saldo
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

export const sebFormat: BankFileFormat = {
  id: 'seb',
  name: 'SEB',
  description: 'SEB CSV (semicolon-delimited)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0]?.toLowerCase() || ''
    // SEB uses semicolon delimiter. Header always has a bokföringsdag/bokföringsdatum
    // column plus either valutadag/valutadatum or verifikationsnummer. The secondary
    // check distinguishes SEB from Länsförsäkringar (which also has bokföringsdag).
    const hasBookingDate = /bokf(ö|o)ringsda(g|tum)/.test(firstLine)
    const hasSebSecondary =
      /valuta(dag|datum)/.test(firstLine) || firstLine.includes('verifikationsnummer')
    return firstLine.includes(';') && hasBookingDate && hasSebSecondary
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Parse header to find column indices
    const headerLine = lines[0] || ''
    const headers = headerLine.split(';').map((h) => h.trim().toLowerCase().replace(/"/g, ''))

    // Find column indices dynamically
    const dateIdx = headers.findIndex((h) => /bokf(ö|o)ringsda(g|tum)/.test(h))
    const descIdx = headers.findIndex(
      (h) => h.includes('text') || h.includes('mottagare') || h.includes('beskrivning')
    )
    const amountIdx = headers.findIndex((h) => h.includes('belopp'))
    const balanceIdx = headers.findIndex((h) => h.includes('saldo'))

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: 1,
        message: 'Could not identify required columns (date, amount)',
        severity: 'error',
      })
      return {
        format: 'seb',
        format_name: 'SEB',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = line.split(';').map((f) => f.trim().replace(/^"|"$/g, ''))

      const date = fields[dateIdx]
      const description = fields[descIdx >= 0 ? descIdx : dateIdx + 1] || 'Unknown'
      const amountStr = fields[amountIdx]
      const balanceStr = balanceIdx >= 0 ? fields[balanceIdx] : undefined

      if (!date || !amountStr) {
        issues.push({ row: i + 1, message: 'Missing required fields', severity: 'warning' })
        skippedRows++
        continue
      }

      const amount = parseCommaDecimal(amountStr)
      if (isNaN(amount)) {
        issues.push({ row: i + 1, message: `Invalid amount: ${amountStr}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const normalizedDate = normalizeDate(date)
      if (!normalizedDate) {
        issues.push({ row: i + 1, message: `Invalid date: ${date}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const balance = balanceStr ? parseCommaDecimal(balanceStr) : null

      transactions.push({
        date: normalizedDate,
        description: description.trim(),
        amount,
        currency: 'SEK',
        balance: isNaN(balance as number) ? null : balance,
        reference: null,
        counterparty: null,
        raw_line: line,
      })
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'seb',
      format_name: 'SEB',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: lines.length - 1,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}
