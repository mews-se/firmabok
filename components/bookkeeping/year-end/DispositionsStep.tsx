'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DepreciationPanel } from './DepreciationPanel'
import { EfDeclarationSection } from './EfDeclarationSection'
import type { DispositionsProposal } from '@/lib/bokslut/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface DispositionsStepProps {
  periodId: string
  onBack: () => void
  onContinue: () => void
  onNavigationBlockedChange?: (blocked: boolean) => void
}

/**
 * Dispositions step of the bokslut wizard. An enskild firma books no
 * dispositioner: depreciation is posted here and the egenavgifter,
 * räntefördelning, periodiseringsfond and expansionsfond figures are shown for
 * the NE-bilaga declaration.
 */
export function DispositionsStep({
  periodId,
  onBack,
  onContinue,
  onNavigationBlockedChange,
}: DispositionsStepProps) {
  const [proposal, setProposal] = useState<DispositionsProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [taxDepreciationDirty, setTaxDepreciationDirty] = useState(false)

  useEffect(() => {
    onNavigationBlockedChange?.(taxDepreciationDirty)
  }, [onNavigationBlockedChange, taxDepreciationDirty])

  useEffect(() => () => onNavigationBlockedChange?.(false), [onNavigationBlockedChange])

  const loadProposals = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/bokslutsdispositioner`,
      )
      const body = await res.json()
      if (!res.ok) {
        setFetchError(getUserErrorMessage(body?.error) ?? 'Kunde inte ladda dispositioner')
        return
      }
      setProposal(body.data as DispositionsProposal)
    } catch {
      setFetchError('Kunde inte ladda dispositioner')
    } finally {
      setLoading(false)
    }
  }, [periodId])

  useEffect(() => {
    void loadProposals()
  }, [loadProposals])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (fetchError) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{fetchError}</p>
        </CardContent>
      </Card>
    )
  }

  if (!proposal) return null

  const fiscalYear = parseInt(proposal.fiscalPeriod.period_end.slice(0, 4), 10)

  return (
    <div className="space-y-6">
      <DepreciationPanel
        periodId={periodId}
        onPosted={() => void loadProposals()}
        onTaxDirtyChange={setTaxDepreciationDirty}
      />
      <EfDeclarationSection
        fiscalPeriodId={periodId}
        bookedSurplus={proposal.netResultBefore}
        fiscalYear={fiscalYear}
      />
      {taxDepreciationDirty && (
        <p className="text-sm text-warning-foreground" role="status">
          Spara eller återställ ändringarna i skattemässig avskrivning innan du lämnar steget.
        </p>
      )}
      <div className="flex justify-between">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={taxDepreciationDirty}
        >
          ← Tillbaka
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onContinue}
          disabled={taxDepreciationDirty}
          title={
            taxDepreciationDirty
              ? 'Spara ändringarna i skattemässig avskrivning innan du fortsätter.'
              : undefined
          }
        >
          Nästa: Förhandsgranska →
        </Button>
      </div>
    </div>
  )
}
