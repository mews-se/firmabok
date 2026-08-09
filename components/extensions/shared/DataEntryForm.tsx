'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DataEntryFormProps {
  title: string
  onSubmit: (e: React.FormEvent) => void
  submitLabel?: string
  isSubmitting?: boolean
  children: React.ReactNode
  className?: string
}

export default function DataEntryForm({
  title,
  onSubmit,
  submitLabel = 'Spara',
  isSubmitting = false,
  children,
  className,
}: DataEntryFormProps) {
  return (
    <Card className={cn('', className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {children}
          <Button type="submit" disabled={isSubmitting} size="sm">
            {isSubmitting ? 'Sparar...' : submitLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
