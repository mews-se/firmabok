'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatDate } from '@/lib/utils'
import { BookOpen, Loader2, Search } from 'lucide-react'

// Pick an existing verifikat and link the inbox item's document to it via
// POST /api/documents/[id]/link. The DB sync trigger on
// document_attachments.journal_entry_id stamps
// invoice_inbox_items.linked_journal_entry_id, so the item leaves the active
// inbox without this client doing anything inbox-specific.

interface VoucherRow {
  id: string
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string | null
}

interface Props {
  open: boolean
  item: { id: string; document_id: string | null }
  onClose: () => void
  onLinked: () => void
}

export default function InboxLinkVoucherDialog({ open, item, onClose, onLinked }: Props) {
  const t = useTranslations('inbox')
  const { toast } = useToast()

  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<VoucherRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLinking, setIsLinking] = useState(false)

  // Debounced server-side search over the voucher description; newest first.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = setTimeout(async () => {
      setIsLoading(true)
      try {
        const params = new URLSearchParams({
          exclude_draft: 'true',
          sort_by: 'date_desc',
          limit: '20',
        })
        if (search.trim()) params.set('search', search.trim())
        const res = await fetch(`/api/bookkeeping/journal-entries?${params.toString()}`)
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        setEntries(res.ok ? ((json.data ?? []) as VoucherRow[]) : [])
      } catch {
        if (!cancelled) setEntries([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, search])

  async function handlePick(entry: VoucherRow) {
    if (!item.document_id || isLinking) return
    setIsLinking(true)
    try {
      const res = await fetch(`/api/documents/${item.document_id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_id: entry.id }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        toast({
          title: t('link_failed'),
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('link_success') })
      onLinked()
    } catch {
      toast({ title: t('link_failed'), variant: 'destructive' })
    } finally {
      setIsLinking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('link_title')}</DialogTitle>
          <DialogDescription>{t('link_description')}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('link_search_placeholder')}
            className="pl-9"
          />
        </div>

        <div className="-mx-6 max-h-[50vh] divide-y overflow-y-auto px-6">
          {isLoading ? (
            <div className="space-y-3 py-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <BookOpen className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('link_empty')}</p>
            </div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                disabled={isLinking}
                onClick={() => void handlePick(entry)}
                className={cn(
                  '-ml-2 flex w-full items-center gap-3 rounded px-2 py-3 text-left transition-colors hover:bg-secondary/60',
                  isLinking && 'opacity-50',
                )}
              >
                <span className="w-16 shrink-0 font-medium tabular-nums">
                  {entry.voucher_series}
                  {entry.voucher_number}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatDate(entry.entry_date)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{entry.description ?? ''}</span>
                {isLinking && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
