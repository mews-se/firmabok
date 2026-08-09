'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Invoice } from '@/types'
import { calculatePeriodSummary, SWEDISH_MONTHS } from '@/lib/calendar/utils'
import { formatCurrency } from '@/lib/utils'
import { TrendingUp, Clock, CheckCircle, AlertTriangle } from 'lucide-react'

interface PaymentSummaryCardProps {
  invoices: Invoice[]
  year: number
  month: number
}

export function PaymentSummaryCard({ invoices, year, month }: PaymentSummaryCardProps) {
  const summary = calculatePeriodSummary(invoices)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">
          Sammanfattning {SWEDISH_MONTHS[month]} {year}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Expected */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Förväntat</p>
              <p className="text-sm font-medium">{summary.pendingCount} fakturor</p>
            </div>
          </div>
          <p className="text-lg font-semibold">{formatCurrency(summary.totalExpected)}</p>
        </div>

        {/* Overdue */}
        {summary.overdueCount > 0 && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Förfallen</p>
                <p className="text-sm font-medium text-destructive">
                  {summary.overdueCount} fakturor
                </p>
              </div>
            </div>
            <p className="text-lg font-semibold text-destructive">
              {formatCurrency(summary.totalOverdue)}
            </p>
          </div>
        )}

        {/* Paid */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
              <CheckCircle className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Betald</p>
              <p className="text-sm font-medium">{summary.paidCount} fakturor</p>
            </div>
          </div>
          <p className="text-lg font-semibold text-success">
            {formatCurrency(summary.totalPaid)}
          </p>
        </div>

        {/* Pending */}
        {summary.pendingCount > 0 && summary.overdueCount < summary.pendingCount && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                <Clock className="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Väntande</p>
                <p className="text-sm font-medium">
                  {summary.pendingCount - summary.overdueCount} fakturor
                </p>
              </div>
            </div>
            <p className="text-lg font-semibold">
              {formatCurrency(summary.totalExpected - summary.totalOverdue)}
            </p>
          </div>
        )}

        {/* Foreign-currency invoices without a stored SEK conversion are
            excluded from the sums above rather than silently mixed in. */}
        {summary.unconvertedCount > 0 && (
          <p className="text-xs text-warning">
            {summary.unconvertedCount === 1
              ? '1 faktura i utländsk valuta utan växelkurs ingår inte i beloppen.'
              : `${summary.unconvertedCount} fakturor i utländsk valuta utan växelkurs ingår inte i beloppen.`}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
