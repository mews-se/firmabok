/**
 * Kontantmetoden for an invoice that is paid in parts.
 *
 * An unbooked invoice books its revenue or cost and its moms when the money
 * moves, so every payment books its own share of the invoice. The share is
 * cumulative: once p kronor of a T kronor invoice are paid, a line of L kronor
 * has recognised roundOre(L × p / T), and a payment books how much that figure
 * grew. When p reaches T every line has recognised exactly L, so the last
 * payment takes the exact remainder and the öre rounding of the earlier
 * payments cancels out per account.
 *
 * Shared by the customer payment proposal and the supplier cash builder.
 */
import { roundOre, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import type { LineSides } from './line-side'

export interface CashInstalmentPlan {
  /**
   * settle: the payment clears the invoice, exactly or within the öre band;
   * partial: 1 kr or more is still owed afterwards;
   * overpayment: the payment exceeds the remaining amount by 1 kr or more.
   */
  kind: 'settle' | 'partial' | 'overpayment'
  priorPaid: number
  /** What the payment takes off the invoice: the payment itself for a partial, the remaining amount otherwise. */
  applied: number
  newPaid: number
  newRemaining: number
  /** payment − applied: the öresavrundning when settling, the excess on an overpayment, 0 for a partial. */
  difference: number
}

export function planCashInstalment(
  invoice: { total: number; paid_amount?: number | null; remaining_amount?: number | null },
  payment: number,
): CashInstalmentPlan {
  const priorPaid = roundOre(invoice.paid_amount ?? 0)
  const remaining = roundOre(invoice.remaining_amount ?? invoice.total - priorPaid)
  const amount = roundOre(payment)
  const difference = roundOre(amount - remaining)

  if (difference <= -ORE_ROUNDING_SETTLEMENT_MAX) {
    return {
      kind: 'partial',
      priorPaid,
      applied: amount,
      newPaid: roundOre(priorPaid + amount),
      newRemaining: roundOre(remaining - amount),
      difference: 0,
    }
  }
  return {
    kind: difference >= ORE_ROUNDING_SETTLEMENT_MAX ? 'overpayment' : 'settle',
    priorPaid,
    applied: remaining,
    newPaid: roundOre(priorPaid + remaining),
    newRemaining: 0,
    difference,
  }
}

/**
 * Index of the line with the largest absolute amount among those `include`
 * accepts, or among all lines when it accepts none; -1 for no lines.
 */
export function largestLineIndex<L extends LineSides>(
  lines: readonly L[],
  include: (line: L) => boolean = () => true,
): number {
  const pick = (filter: (line: L) => boolean): number => {
    let best = -1
    lines.forEach((line, i) => {
      if (!filter(line)) return
      const size = Math.abs(line.debit_amount - line.credit_amount)
      if (best < 0 || size > Math.abs(lines[best].debit_amount - lines[best].credit_amount)) best = i
    })
    return best
  }
  const index = pick(include)
  return index >= 0 ? index : pick(() => true)
}

/**
 * One payment's share of the full-invoice lines, i.e. every line except the
 * payment leg. `side` is where those lines land taken together: credit for a
 * customer invoice (revenue and utgående moms), debit for a supplier invoice
 * (cost and ingående moms).
 *
 * Each line is scaled on its absolute amount, so both halves of a
 * reverse-charge pair round alike and stay netted. The öre the per-line
 * rounding leaves over goes to the line at `foldIndex` (the largest revenue
 * or cost line), so the lines always sum to the applied amount; it is the
 * same line every time, and the folds cancel out by the last payment.
 */
export function instalmentLines<L extends LineSides>(
  lines: readonly L[],
  opts: {
    total: number
    priorPaid: number
    newPaid: number
    side: 'debit' | 'credit'
    foldIndex: number
  },
): L[] {
  const { total, priorPaid, newPaid, side, foldIndex } = opts
  const recognised = (net: number, paid: number): number => {
    if (paid >= total) return net
    const share = roundOre((Math.abs(net) * paid) / total)
    return net < 0 ? -share : share
  }

  const shares = lines.map((line) => {
    const net = roundOre(line.debit_amount - line.credit_amount)
    return roundOre(recognised(net, newPaid) - recognised(net, priorPaid))
  })
  const applied = roundOre(newPaid - priorPaid)
  const residual = roundOre(
    (side === 'debit' ? applied : -applied) - shares.reduce((sum, share) => sum + share, 0),
  )
  if (residual !== 0 && foldIndex >= 0 && foldIndex < shares.length) {
    shares[foldIndex] = roundOre(shares[foldIndex] + residual)
  }

  return lines.map((line, i) => ({
    ...line,
    debit_amount: shares[i] > 0 ? shares[i] : 0,
    credit_amount: shares[i] < 0 ? -shares[i] : 0,
  }))
}
