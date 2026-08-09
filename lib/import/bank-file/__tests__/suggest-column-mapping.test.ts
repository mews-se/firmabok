/**
 * Tests for suggestColumnMapping: the auto-guess that seeds the manual CSV
 * column-mapping UI.
 *
 * Regression context: the previous heuristic walked each data row right-to-left
 * and picked the first numeric cell as the amount. Because virtually every
 * Swedish bank export ends with `…;Belopp;Saldo`, that grabbed the trailing
 * running-balance column as the amount, so the live preview showed the balance
 * instead of the transaction amount. The fix matches header labels first.
 */

import { describe, it, expect } from 'vitest'
import { suggestColumnMapping } from '../formats/generic-csv'

describe('suggestColumnMapping', () => {
  it('REGRESSION: picks Belopp (not the trailing Saldo) as amount when a header is present', () => {
    // Handelsbanken Företag-style layout: Bokföringsdatum;Referens;Belopp;Saldo.
    // The old reverse-scan heuristic would have returned amount = 3 (Saldo).
    const headers = ['Bokföringsdatum', 'Referens', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-15', 'Swish Anna Svensson', '-99,00', '12345,67'],
      ['2024-01-14', 'HEMKÖP', '-432,50', '12444,67'],
      ['2024-01-13', 'LÖNEUTBETALNING', '25000,00', '12877,17'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.amount).toBe(2) // Belopp, NOT 3 (Saldo)
    expect(result.balance).toBe(3) // Saldo auto-filled
    expect(result.date).toBe(0)
    expect(result.description).toBe(1)
  })

  it('without a header, prefers the column with negative values as amount and the trailing column as balance', () => {
    // date ; text ; belopp ; saldo: no header row at all.
    const dataRows = [
      ['2024-01-15', 'Swish Anna Svensson', '-99,00', '12345,67'],
      ['2024-01-14', 'HEMKÖP', '-432,50', '12444,67'],
      ['2024-01-13', 'LÖNEUTBETALNING', '25000,00', '12877,17'],
    ]

    const result = suggestColumnMapping(null, dataRows)

    expect(result.date).toBe(0)
    expect(result.description).toBe(1)
    expect(result.amount).toBe(2) // has negative values
    expect(result.balance).toBe(3) // remaining (all-positive) numeric column
  })

  it('handles the Handelsbanken private layout: picks Reskontradatum (booking), not Transaktionsdatum', () => {
    // The two date columns deliberately DIFFER here: a card purchase swiped the
    // 14th and booked the 16th. The dedicated Handelsbanken parser emits
    // Reskontradatum (formats/handelsbanken.ts primaryDateIdx), so the manual
    // "Annan CSV" mapping must pre-select the same column, otherwise the same
    // statement dates the same affärshändelse two days apart depending on which
    // upload path the user took, and the Saldo column no longer ties to the row.
    const headers = ['Reskontradatum', 'Transaktionsdatum', 'Text', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-16', '2024-01-14', 'SPOTIFY AB', '-99,00', '12345,67'],
      ['2024-01-15', '2024-01-13', 'HEMKÖP', '-432,50', '12444,67'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(0) // Reskontradatum (booking), NOT 1 (Transaktionsdatum)
    expect(result.description).toBe(2) // Text
    expect(result.amount).toBe(3) // Belopp, NOT 4 (Saldo)
    expect(result.balance).toBe(4)
  })

  it('handles the Länsförsäkringar layout: picks Bokföringsdag, not the leading Datum', () => {
    // Matches formats/lansforsakringar.ts, which resolves Bokföringsdag (field 1)
    // and only falls back to Datum when no booking column exists.
    const headers = ['Datum', 'Bokföringsdag', 'Typ', 'Text', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-14', '2024-01-16', 'Kortköp', 'SPOTIFY AB', '-99,00', '12345,67'],
      ['2024-01-13', '2024-01-15', 'Kortköp', 'HEMKÖP', '-432,50', '12444,67'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(1) // Bokföringsdag, NOT 0 (Datum)
    expect(result.description).toBe(3) // Text
    expect(result.amount).toBe(4)
    expect(result.balance).toBe(5)
  })

  it('handles the Swedbank layout: picks the abbreviated Bokfdag over Transdag and Valutadag', () => {
    // Swedbank is the decisive precedent: Transdag is present in the file and
    // formats/swedbank.ts deliberately resolves Bokfdag. Matching by label also
    // makes this deterministic instead of depending on Bokfdag happening to be
    // the leftmost date-shaped column.
    const headers = [
      'Radnr', 'Clnr', 'Kontonr', 'Produkt', 'Valuta',
      'Bokfdag', 'Transdag', 'Valutadag', 'Referens', 'Text', 'Belopp', 'Saldo',
    ]
    const dataRows = [
      ['1', '8327', '1234567890', 'Företagskonto', 'SEK',
        '2024-01-16', '2024-01-14', '2024-01-16', 'HEMKÖP', 'Kortköp', '-432.50', '12444.67'],
      ['2', '8327', '1234567890', 'Företagskonto', 'SEK',
        '2024-01-15', '2024-01-15', '2024-01-15', 'LÖN', 'Insättning', '25000.00', '12877.17'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(5) // Bokfdag, NOT 6 (Transdag) and NOT 7 (Valutadag)
    expect(result.amount).toBe(10) // Belopp
    expect(result.balance).toBe(11) // Saldo
  })

  it('FALLBACK: maps Transaktionsdatum when the export carries no booking date', () => {
    // transaktionsdatum is demoted to the last tier, not removed: a file that
    // only ever carried a transaction date must still map without user input.
    const headers = ['Transaktionsdatum', 'Text', 'Belopp']
    const dataRows = [
      ['2024-01-14', 'SPOTIFY AB', '-99,00'],
      ['2024-01-13', 'HEMKÖP', '-432,50'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(0) // Transaktionsdatum: the only date column there is
    expect(result.description).toBe(1)
    expect(result.amount).toBe(2)
  })

  it('FALLBACK: maps a bare Datum column when that is the only date column', () => {
    // Nordea / Skandia / Nordea Business format D shape.
    const headers = ['Datum', 'Transaktion', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-15', 'SPOTIFY AB', '-99,00', '12345,67'],
      ['2024-01-14', 'HEMKÖP', '-432,50', '12444,67'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(0)
    expect(result.amount).toBe(2)
    expect(result.balance).toBe(3)
  })

  it('does not invent a balance column when the file has none', () => {
    const headers = ['Datum', 'Text', 'Belopp']
    const dataRows = [
      ['2024-01-15', 'SPOTIFY', '-99,00'],
      ['2024-01-14', 'HEMKÖP', '-432,50'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.date).toBe(0)
    expect(result.description).toBe(1)
    expect(result.amount).toBe(2)
    expect(result.balance).toBe(-1)
  })

  it('matches the amount by label even when every amount is positive', () => {
    // No negative values to fall back on: the label match must still win.
    const headers = ['Bokföringsdatum', 'Referens', 'Belopp', 'Saldo']
    const dataRows = [['2024-01-15', 'Inbetalning kund', '5000,00', '12345,67']]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.amount).toBe(2) // Belopp by label, not Saldo
    expect(result.balance).toBe(3)
  })

  it('tolerates space-grouped thousands and Unicode minus signs', () => {
    const headers = ['Datum', 'Text', 'Belopp', 'Saldo']
    const dataRows = [
      ['2024-01-15', 'STOR BETALNING', '−1 432,50', '120 000,00'],
    ]

    const result = suggestColumnMapping(headers, dataRows)

    expect(result.amount).toBe(2)
    expect(result.balance).toBe(3)
  })

  it('returns all -1 for empty input', () => {
    expect(suggestColumnMapping(null, [])).toEqual({ date: -1, description: -1, amount: -1, balance: -1 })
  })
})
