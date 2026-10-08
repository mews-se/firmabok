import { describe, it, expect } from 'vitest'
import { roundOre } from '@/lib/money'
import { instalmentLines, largestLineIndex, planCashInstalment } from '../cash-instalment'

type Line = { account_number: string; debit_amount: number; credit_amount: number }

const credit = (account_number: string, amount: number): Line => ({ account_number, debit_amount: 0, credit_amount: amount })
const debit = (account_number: string, amount: number): Line => ({ account_number, debit_amount: amount, credit_amount: 0 })
const net = (line: Line) => roundOre(line.debit_amount - line.credit_amount)
const sumNet = (lines: Line[]) => roundOre(lines.reduce((s, l) => s + net(l), 0))

/** Book `payments` one after the other the way the callers do and return each payment's lines. */
function payInParts(lines: Line[], payments: number[], side: 'debit' | 'credit', foldIndex: number): Line[][] {
  const total = side === 'debit' ? sumNet(lines) : -sumNet(lines)
  let paid = 0
  return payments.map((payment) => {
    const plan = planCashInstalment({ total, paid_amount: paid }, payment)
    const booked = instalmentLines(lines, { total, priorPaid: plan.priorPaid, newPaid: plan.newPaid, side, foldIndex })
    expect(sumNet(booked)).toBe(side === 'debit' ? plan.applied : -plan.applied)
    paid = plan.newPaid
    return booked
  })
}

function expectAccountTotals(full: Line[], parts: Line[][]) {
  full.forEach((line, i) => {
    expect(roundOre(parts.reduce((s, part) => s + net(part[i]), 0))).toBe(net(line))
  })
}

describe('planCashInstalment', () => {
  const invoice = { total: 10000, paid_amount: 0, remaining_amount: 10000 }

  it('keeps 9 999 of 10 000 a real partial: the band stops below 1 kr', () => {
    expect(planCashInstalment(invoice, 9999)).toEqual({
      kind: 'partial',
      priorPaid: 0,
      applied: 9999,
      newPaid: 9999,
      newRemaining: 1,
      difference: 0,
    })
  })

  it('settles in full inside the öre band, either way', () => {
    expect(planCashInstalment(invoice, 9999.01)).toMatchObject({ kind: 'settle', applied: 10000, newPaid: 10000, newRemaining: 0, difference: -0.99 })
    expect(planCashInstalment(invoice, 10000.99)).toMatchObject({ kind: 'settle', applied: 10000, difference: 0.99 })
    expect(planCashInstalment(invoice, 10000)).toMatchObject({ kind: 'settle', difference: 0 })
  })

  it('calls 1 kr or more above the remaining an overpayment', () => {
    expect(planCashInstalment(invoice, 10001)).toMatchObject({ kind: 'overpayment', applied: 10000, newPaid: 10000, difference: 1 })
  })

  it('counts from the amount already paid', () => {
    expect(planCashInstalment({ total: 10000, paid_amount: 9999, remaining_amount: 1 }, 1)).toEqual({
      kind: 'settle',
      priorPaid: 9999,
      applied: 1,
      newPaid: 10000,
      newRemaining: 0,
      difference: 0,
    })
    expect(planCashInstalment({ total: 10000, paid_amount: 4000 }, 6000)).toMatchObject({ kind: 'settle', newPaid: 10000 })
  })
})

describe('instalmentLines', () => {
  it('books 9 999 and then 1 of a 10 000 invoice in proportion', () => {
    const full = [credit('3001', 8000), credit('2611', 2000)]
    const [first, last] = payInParts(full, [9999, 1], 'credit', 0)

    expect(first).toEqual([credit('3001', 7999.2), credit('2611', 1999.8)])
    expect(last).toEqual([credit('3001', 0.8), credit('2611', 0.2)])
  })

  it('splits 100,00 in three thirds and lets the last one take the remainder', () => {
    const full = [credit('3001', 80), credit('2611', 20)]
    const parts = payInParts(full, [33.33, 33.33, 33.34], 'credit', 0)

    expect(parts).toEqual([
      [credit('3001', 26.66), credit('2611', 6.67)],
      [credit('3001', 26.67), credit('2611', 6.66)],
      [credit('3001', 26.67), credit('2611', 6.67)],
    ])
    expectAccountTotals(full, parts)
  })

  it('pays 1 234,56 with 1 000 and then 235 inside the öre band', () => {
    const full = [credit('3001', 987.65), credit('2611', 246.91)]
    const parts = payInParts(full, [1000, 235], 'credit', 0)

    expect(parts).toEqual([
      [credit('3001', 800), credit('2611', 200)],
      [credit('3001', 187.65), credit('2611', 46.91)],
    ])
    expect(planCashInstalment({ total: 1234.56, paid_amount: 1000 }, 235).difference).toBe(0.44)
  })

  it('keeps every rate of a mixed 25/12/6 % invoice whole over the payments', () => {
    const full = [
      credit('3001', 1000),
      credit('2611', 250),
      credit('3002', 500),
      credit('2621', 60),
      credit('3003', 200),
      credit('2631', 12),
    ]
    const parts = payInParts(full, [1000, 777.77, 0.5, 243.73], 'credit', 0)

    expect(parts[0]).toEqual([
      credit('3001', 494.57),
      credit('2611', 123.64),
      credit('3002', 247.28),
      credit('2621', 29.67),
      credit('3003', 98.91),
      credit('2631', 5.93),
    ])
    expectAccountTotals(full, parts)
  })

  it('scales a negative discount line on its own side', () => {
    const full = [credit('3001', 1000), debit('3001', 100), credit('2611', 225)]
    const parts = payInParts(full, [500, 625], 'credit', 0)

    expect(parts[0]).toEqual([credit('3001', 444.44), debit('3001', 44.44), credit('2611', 100)])
    expectAccountTotals(full, parts)
  })

  it('keeps reverse-charge pairs and basis lines netted in every payment', () => {
    const full = [
      debit('6540', 10000),
      debit('2645', 2500),
      credit('2614', 2500),
      debit('4535', 10000),
      credit('4598', 10000),
    ]
    const parts = payInParts(full, [3333.33, 3333.33, 3333.34], 'debit', 0)

    for (const part of parts) {
      expect(net(part[1])).toBe(-net(part[2]))
      expect(net(part[3])).toBe(-net(part[4]))
      expect(net(part[0])).toBe(sumNet(part))
    }
    expectAccountTotals(full, parts)
  })

  it('folds the leftover öre into the chosen line and nets it out by the last payment', () => {
    const full = [credit('3001', 33.33), credit('3002', 33.33), credit('3003', 33.34)]
    const parts = payInParts(full, [10, 10, 10, 70], 'credit', 2)

    expect(parts[0]).toEqual([credit('3001', 3.33), credit('3002', 3.33), credit('3003', 3.34)])
    expect(sumNet(parts[1])).toBe(-10)
    expectAccountTotals(full, parts)
  })

  it('books nothing on a line too small to reach an öre this time', () => {
    const full = [credit('3001', 1000), credit('2611', 250), credit('3740', 0.01)]
    const [first] = payInParts(full, [100, 1150.01], 'credit', 0)

    expect(first[2]).toEqual(credit('3740', 0))
  })
})

describe('largestLineIndex', () => {
  it('picks the largest included line and falls back to all lines', () => {
    const lines = [credit('2611', 2500), credit('3001', 400), debit('3001', 600)]
    expect(largestLineIndex(lines, (l) => l.account_number.startsWith('3'))).toBe(2)
    expect(largestLineIndex(lines, () => false)).toBe(0)
    expect(largestLineIndex([])).toBe(-1)
  })
})
