'use client'

import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import EmptyExtensionState from '@/components/extensions/shared/EmptyExtensionState'
import { Camera } from 'lucide-react'

export default function ReceiptOcrWorkspace({ userId }: WorkspaceComponentProps) {
  return (
    <EmptyExtensionState
      title="Kvittoscanning"
      description="Ladda upp och skanna kvitton direkt från tillägets arbetsyta. Gå till Kvitton i sidomenyn för att komma igång."
      icon={<Camera className="h-12 w-12 text-muted-foreground/40 mb-4" />}
    />
  )
}
