import { NextResponse } from 'next/server'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext(
  'period.opening_balances',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('period_start, opening_balance_entry_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (periodError || !period) {
      return errorResponseFromCode('OPENING_BAL_PERIOD_NOT_FOUND', opLog, { requestId })
    }

    const { balances } = await getOpeningBalances(supabase, companyId!, period)

    const accountNumbers = Array.from(balances.keys())

    if (accountNumbers.length === 0) {
      return NextResponse.json({ data: [] })
    }

    const { data: accounts } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .in('account_number', accountNumbers)

    const accountNameMap = new Map(
      (accounts || []).map((a) => [a.account_number, a.account_name]),
    )

    const data = accountNumbers
      .sort()
      .map((accountNumber) => {
        const bal = balances.get(accountNumber)!
        const net = Math.round((bal.debit - bal.credit) * 100) / 100
        return {
          account_number: accountNumber,
          account_name: accountNameMap.get(accountNumber) || accountNumber,
          balance: net,
        }
      })
      .filter((row) => row.balance !== 0)

    return NextResponse.json({ data })
  },
)
