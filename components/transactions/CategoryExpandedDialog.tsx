'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ArrowUpRight, ArrowDownRight } from 'lucide-react'
import VatTreatmentSelect from './VatTreatmentSelect'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './transaction-types'
import type { TransactionWithInvoice } from './transaction-types'
import type { TransactionCategory, VatTreatment } from '@/types'

interface CategoryExpandedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: TransactionWithInvoice | null
  onSelectCategory: (category: TransactionCategory, vatTreatment?: VatTreatment) => void
  isProcessing: boolean
}

export default function CategoryExpandedDialog({
  open,
  onOpenChange,
  transaction,
  onSelectCategory,
  isProcessing,
}: CategoryExpandedDialogProps) {
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'none'>('standard_25')

  useEffect(() => {
    if (open) {
      setVatTreatment('standard_25')
    }
  }, [open, transaction?.id])

  if (!transaction) return null

  const isIncome = transaction.amount > 0

  const handleSelectCategory = (category: TransactionCategory) => {
    const resolvedVat = vatTreatment === 'none' ? undefined : vatTreatment
    onSelectCategory(category, resolvedVat)
  }

  return (
    <Dialog open={open} onOpenChange={isProcessing ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Välj kategori</DialogTitle>
          <DialogDescription>
            Välj rätt kategori för att bokföra transaktionen
          </DialogDescription>
        </DialogHeader>

        {/* Transaction summary */}
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <div
            className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${
              isIncome
                ? 'bg-success/10 text-success'
                : 'bg-destructive/10 text-destructive'
            }`}
          >
            {isIncome ? (
              <ArrowUpRight className="h-4 w-4" />
            ) : (
              <ArrowDownRight className="h-4 w-4" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">{transaction.description}</p>
            <p className="text-xs text-muted-foreground">{formatDate(transaction.date)}</p>
          </div>
          <p className={`font-medium text-sm flex-shrink-0 ${isIncome ? 'text-success' : ''}`}>
            {isIncome ? '+' : ''}
            {formatCurrency(transaction.amount, transaction.currency)}
          </p>
        </div>

        {/* VAT treatment selector */}
        <div>
          <h4 className="text-sm font-medium text-muted-foreground mb-2">Momsbehandling</h4>
          <VatTreatmentSelect
            value={vatTreatment}
            onValueChange={setVatTreatment}
          />
        </div>

        {/* Category grid */}
        <div className="space-y-4 py-2">
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-2">Kostnader</h4>
            <div className="grid grid-cols-2 gap-1.5">
              {EXPENSE_CATEGORIES.map((cat) => (
                <Button
                  key={cat.value}
                  variant="outline"
                  size="sm"
                  className="justify-start text-xs h-auto py-1.5"
                  onClick={() => handleSelectCategory(cat.value)}
                  disabled={isProcessing}
                >
                  <div className="flex flex-col items-start">
                    <span>{cat.label}</span>
                    {cat.account && <span className="text-[10px] text-muted-foreground">{cat.account}</span>}
                  </div>
                </Button>
              ))}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-2">Intäkter</h4>
            <div className="grid grid-cols-2 gap-1.5">
              {INCOME_CATEGORIES.map((cat) => (
                <Button
                  key={cat.value}
                  variant="outline"
                  size="sm"
                  className="justify-start text-xs h-auto py-1.5"
                  onClick={() => handleSelectCategory(cat.value)}
                  disabled={isProcessing}
                >
                  <div className="flex flex-col items-start">
                    <span>{cat.label}</span>
                    {cat.account && <span className="text-[10px] text-muted-foreground">{cat.account}</span>}
                  </div>
                </Button>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
