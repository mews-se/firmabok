'use client'

import { CalendarViewMode } from '@/types'
import { VIEW_MODE_LABELS } from '@/lib/calendar/utils'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ViewModeSelectorProps {
  viewMode: CalendarViewMode
  onViewModeChange: (mode: CalendarViewMode) => void
}

export function ViewModeSelector({ viewMode, onViewModeChange }: ViewModeSelectorProps) {
  const modes: CalendarViewMode[] = ['month', 'week', 'day']

  return (
    <div className="inline-flex rounded-md border">
      {modes.map((mode) => (
        <Button
          key={mode}
          variant="ghost"
          size="sm"
          onClick={() => onViewModeChange(mode)}
          className={cn(
            'rounded-none border-r last:border-r-0 px-3',
            viewMode === mode && 'bg-muted'
          )}
        >
          {VIEW_MODE_LABELS[mode]}
        </Button>
      ))}
    </div>
  )
}
