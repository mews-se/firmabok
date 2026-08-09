'use client'

import { ReactNode } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

interface EditEntryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  onSave: () => void | Promise<void>
  isSaving?: boolean
  children: ReactNode
}

export default function EditEntryDialog({
  open,
  onOpenChange,
  title,
  description,
  onSave,
  isSaving = false,
  children,
}: EditEntryDialogProps) {
  const handleSave = async () => {
    await onSave()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-4">
          {children}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Avbryt
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sparar...
              </>
            ) : (
              'Spara'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
