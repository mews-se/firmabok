'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Period = 'month' | 'quarter' | 'year' | 'custom'

interface DateRangeFilterProps {
  onRangeChange: (start: string, end: string) => void
  className?: string
}

export default function DateRangeFilter({ onRangeChange, className }: DateRangeFilterProps) {
  const [activePeriod, setActivePeriod] = useState<Period>('month')

  const now = new Date()

  const handlePeriod = (period: Period) => {
    setActivePeriod(period)
    const year = now.getFullYear()
    const month = now.getMonth()

    switch (period) {
      case 'month': {
        const start = new Date(year, month, 1).toISOString().slice(0, 10)
        const end = new Date(year, month + 1, 0).toISOString().slice(0, 10)
        onRangeChange(start, end)
        break
      }
      case 'quarter': {
        const qStart = Math.floor(month / 3) * 3
        const start = new Date(year, qStart, 1).toISOString().slice(0, 10)
        const end = new Date(year, qStart + 3, 0).toISOString().slice(0, 10)
        onRangeChange(start, end)
        break
      }
      case 'year': {
        onRangeChange(`${year}-01-01`, `${year}-12-31`)
        break
      }
    }
  }

  const periods: { key: Period; label: string }[] = [
    { key: 'month', label: 'Månad' },
    { key: 'quarter', label: 'Kvartal' },
    { key: 'year', label: 'År' },
  ]

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {periods.map(({ key, label }) => (
        <Button
          key={key}
          variant={activePeriod === key ? 'default' : 'ghost'}
          size="sm"
          onClick={() => handlePeriod(key)}
          className="text-xs"
        >
          {label}
        </Button>
      ))}
    </div>
  )
}
