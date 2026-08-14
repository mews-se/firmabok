'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DataListEmpty } from '@/components/ui/data-list'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { ContextPicker } from '@/components/common/ContextPicker'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import {
  Eye,
  FileText,
  ImageIcon,
  Inbox,
  Link2,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
  Wallet,
  X,
} from 'lucide-react'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'

const InboxLinkVoucherDialog = dynamic(() => import('@/components/inbox/InboxLinkVoucherDialog'))

// The Underlag inbox: a general document intake (receipts, supplier invoices,
// own invoice copies, contracts). Rows never assume the extraction is
// invoice-shaped; supplier/amount only decorate when present.

export interface InboxListItem {
  id: string
  status: string
  source: string | null
  created_at: string
  document_id: string | null
  file_name: string | null
  mime_type: string | null
  file_size_bytes: number | null
  extraction_skipped: boolean
  error_message: string | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  linked_journal_entry_id: string | null
  supplier_name: string | null
  amount: number | null
  currency: string | null
  invoice_date: string | null
}

type InboxFilter = 'pending' | 'handled' | 'all'
const FILTERS: InboxFilter[] = ['pending', 'handled', 'all']
const FILTER_LABEL_KEYS: Record<InboxFilter, string> = {
  pending: 'filter_pending',
  handled: 'filter_handled',
  all: 'filter_all',
}

const PAGE_SIZE = 50

// Keep in sync with ALLOWED_DOCUMENT_TYPES in
// lib/core/documents/document-service.ts (server module, not importable here).
const UPLOAD_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp'

const SOURCE_LABEL_KEYS: Record<string, string> = {
  upload: 'source_upload',
  email: 'source_email',
}

function isImageType(type: string | null): boolean {
  return type?.startsWith('image/') ?? false
}

function isPdfType(type: string | null): boolean {
  return type === 'application/pdf'
}

export default function InboxPageContent() {
  const t = useTranslations('inbox')
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [items, setItems] = useState<InboxListItem[]>([])
  const [count, setCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [filter, setFilter] = useState<InboxFilter>('pending')
  const [isUploading, setIsUploading] = useState(false)
  const [actioningId, setActioningId] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<InboxListItem | null>(null)
  const [linkItem, setLinkItem] = useState<InboxListItem | null>(null)
  const [deleteItem, setDeleteItem] = useState<InboxListItem | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const fetchItems = useCallback(
    async (activeFilter: InboxFilter, offset = 0, append = false) => {
      if (!append) setIsLoading(true)
      try {
        const res = await fetch(
          `/api/inbox?status=${activeFilter}&limit=${PAGE_SIZE}&offset=${offset}`,
        )
        const json = await res.json()
        if (!res.ok) throw new Error(getErrorMessage(json, { statusCode: res.status }))
        setItems((prev) => (append ? [...prev, ...(json.data ?? [])] : (json.data ?? [])))
        setCount(json.count ?? 0)
        setLoadFailed(false)
      } catch {
        if (!append) {
          setItems([])
          setCount(0)
        }
        setLoadFailed(true)
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void fetchItems(filter)
  }, [filter, fetchItems])

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return
    setIsUploading(true)
    let failed = 0
    for (const file of Array.from(files)) {
      const formData = new FormData()
      formData.append('file', file)
      try {
        const res = await fetch('/api/inbox/upload', { method: 'POST', body: formData })
        if (!res.ok) {
          failed += 1
          const json = await res.json().catch(() => null)
          toast({
            title: t('upload_failed_title'),
            description: `${file.name}: ${getErrorMessage(json, { statusCode: res.status })}`,
            variant: 'destructive',
          })
        }
      } catch {
        failed += 1
        toast({
          title: t('upload_failed_title'),
          description: file.name,
          variant: 'destructive',
        })
      }
    }
    setIsUploading(false)
    if (failed > 0 && files.length > 1) {
      toast({
        title: t('upload_failed_title'),
        description: t('upload_partial_failed', { failed, total: files.length }),
        variant: 'destructive',
      })
    }
    if (failed < files.length) {
      setFilter('pending')
      void fetchItems('pending')
    }
  }

  async function handleAction(item: InboxListItem, action: 'dismiss' | 'restore') {
    setActioningId(item.id)
    try {
      const res = await fetch(`/api/inbox/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        toast({
          title: t('action_failed'),
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      void fetchItems(filter)
    } catch {
      toast({ title: t('action_failed'), variant: 'destructive' })
    } finally {
      setActioningId(null)
    }
  }

  async function handleDelete(item: InboxListItem) {
    setActioningId(item.id)
    try {
      const res = await fetch(`/api/inbox/${item.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        toast({
          title: t('action_failed'),
          description: getErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      void fetchItems(filter)
    } catch {
      toast({ title: t('action_failed'), variant: 'destructive' })
    } finally {
      setActioningId(null)
    }
  }

  // Handled-state label: normal outcomes render as muted text (chips mark
  // exceptions), dismissed is the exception chip.
  function statusCell(item: InboxListItem) {
    if (item.created_supplier_invoice_id) {
      return <span className="text-xs text-muted-foreground">{t('status_supplier_invoice')}</span>
    }
    if (item.created_journal_entry_id) {
      return <span className="text-xs text-muted-foreground">{t('status_booked')}</span>
    }
    if (item.matched_transaction_id) {
      return <span className="text-xs text-muted-foreground">{t('status_matched')}</span>
    }
    if (item.linked_journal_entry_id) {
      return <span className="text-xs text-muted-foreground">{t('status_linked')}</span>
    }
    if (item.status === 'error') {
      return (
        <Badge variant="outline" className="font-normal" title={item.error_message ?? undefined}>
          {t('status_dismissed')}
        </Badge>
      )
    }
    return null
  }

  const previewSrc = previewItem?.document_id
    ? `/api/documents/${previewItem.document_id}/inline`
    : null

  const isPending = (item: InboxListItem) =>
    item.status === 'received' &&
    !item.created_supplier_invoice_id &&
    !item.created_journal_entry_id &&
    !item.matched_transaction_id &&
    !item.linked_journal_entry_id

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2">
          <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
          <HelpPopover>{t('empty_description')}</HelpPopover>
        </span>
        {canWrite && (
          <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
            {isUploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {isUploading ? t('uploading') : t('upload')}
          </Button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFilesSelected(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ContextPicker
          value={filter}
          onChange={(id) => setFilter(id as InboxFilter)}
          ariaLabel={t('col_status')}
          triggerLabel={
            count > 0
              ? `${t(FILTER_LABEL_KEYS[filter])} · ${count}`
              : t(FILTER_LABEL_KEYS[filter])
          }
          items={FILTERS.map((f) => ({ id: f, label: t(FILTER_LABEL_KEYS[f]) }))}
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-52 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : loadFailed ? (
        <DataListEmpty
          icon={<Inbox className="h-6 w-6" />}
          title={t('load_failed')}
          action={<Button variant="outline" onClick={() => void fetchItems(filter)}>{t('retry')}</Button>}
        />
      ) : items.length === 0 ? (
        <DataListEmpty
          icon={<Inbox className="h-6 w-6" />}
          title={filter === 'pending' ? t('empty_title') : t('empty_filter')}
          description={filter === 'pending' ? t('empty_description') : undefined}
          action={
            filter === 'pending' && canWrite ? (
              <Button onClick={() => fileInputRef.current?.click()}>{t('upload')}</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-full')}>{t('col_document')}</th>
                <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{t('col_date')}</th>
                <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('col_source')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                <th className={TH_CLASS}>{t('col_status')}</th>
                <th className={cn(TH_CLASS, 'w-[168px]')} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {items.map((item) => {
                const pending = isPending(item)
                const dismissed = item.status === 'error' && !item.created_supplier_invoice_id &&
                  !item.created_journal_entry_id && !item.matched_transaction_id &&
                  !item.linked_journal_entry_id
                const primaryLabel =
                  item.supplier_name || item.file_name || t('no_document')
                const busy = actioningId === item.id
                return (
                  <tr
                    key={item.id}
                    className="group transition-colors duration-150 hover:bg-secondary/35"
                  >
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <span className="flex min-w-0 items-center gap-2">
                        {isImageType(item.mime_type) ? (
                          <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate" title={item.file_name ?? undefined}>
                          {primaryLabel}
                        </span>
                      </span>
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                      {formatDate(item.created_at)}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell')}>
                      {item.source && SOURCE_LABEL_KEYS[item.source]
                        ? t(SOURCE_LABEL_KEYS[item.source])
                        : (item.source ?? '')}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                      {item.amount != null
                        ? formatCurrency(item.amount, item.currency ?? 'SEK')
                        : ''}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>{statusCell(item)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                      <span className={cn('inline-flex items-center gap-1', HOVER_REVEAL_CLASS)}>
                        {item.document_id && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10"
                            aria-label={t('action_preview')}
                            title={t('action_preview')}
                            onClick={() => setPreviewItem(item)}
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        {pending && canWrite && (
                          <>
                            {item.document_id && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10"
                                aria-label={t('action_link_voucher')}
                                title={t('action_link_voucher')}
                                onClick={() => setLinkItem(item)}
                              >
                                <Link2 className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10"
                              aria-label={t('action_create_supplier_invoice')}
                              title={t('action_create_supplier_invoice')}
                              onClick={() =>
                                router.push(`/supplier-invoices/new?inbox_item_id=${item.id}`)
                              }
                            >
                              <Wallet className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10"
                              aria-label={t('action_dismiss')}
                              title={t('action_dismiss')}
                              disabled={busy}
                              onClick={() => void handleAction(item, 'dismiss')}
                            >
                              {busy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <X className="h-4 w-4" />
                              )}
                            </Button>
                          </>
                        )}
                        {dismissed && canWrite && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10"
                              aria-label={t('action_restore')}
                              title={t('action_restore')}
                              disabled={busy}
                              onClick={() => void handleAction(item, 'restore')}
                            >
                              {busy ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RotateCcw className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10 text-destructive"
                              aria-label={t('action_delete')}
                              title={t('action_delete')}
                              disabled={busy}
                              onClick={() => setDeleteItem(item)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {items.length < count && (
            <div className="flex justify-center py-4">
              <Button
                variant="outline"
                onClick={() => void fetchItems(filter, items.length, true)}
              >
                {t('load_more')}
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={previewItem !== null} onOpenChange={(o) => !o && setPreviewItem(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-6">
              {previewItem?.file_name ?? previewItem?.supplier_name ?? ''}
            </DialogTitle>
            {previewItem && (previewItem.supplier_name || previewItem.amount != null) && (
              <DialogDescription className="flex items-center gap-2 tabular-nums">
                {previewItem.supplier_name && <span>{previewItem.supplier_name}</span>}
                {previewItem.amount != null && (
                  <span>{formatCurrency(previewItem.amount, previewItem.currency ?? 'SEK')}</span>
                )}
                {previewItem.invoice_date && <span>{formatDate(previewItem.invoice_date)}</span>}
              </DialogDescription>
            )}
          </DialogHeader>

          {previewItem && previewSrc && (
            <div className="py-1">
              {isImageType(previewItem.mime_type) ? (
                <img
                  src={previewSrc}
                  alt={previewItem.file_name ?? ''}
                  className="max-h-[70vh] w-full rounded-lg border object-contain"
                />
              ) : isPdfType(previewItem.mime_type) ? (
                // <object> + type="application/pdf" invokes the browser's PDF
                // plugin directly; <iframe> intermittently shows a
                // blocked-content notice. Mirrors InboxDocumentPicker.
                <object
                  data={previewSrc}
                  type="application/pdf"
                  aria-label={previewItem.file_name ?? ''}
                  className="h-[70vh] w-full rounded-lg border"
                >
                  <a
                    href={previewSrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-2 text-sm text-muted-foreground underline"
                  >
                    {t('preview_unavailable')}
                  </a>
                </object>
              ) : (
                <a
                  href={previewSrc}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-4 py-6 text-center text-sm text-muted-foreground underline"
                >
                  {t('preview_unavailable')}
                </a>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewItem(null)}>
              {t('preview_close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {linkItem && (
        <InboxLinkVoucherDialog
          open
          item={linkItem}
          onClose={() => setLinkItem(null)}
          onLinked={() => {
            setLinkItem(null)
            void fetchItems(filter)
          }}
        />
      )}

      <DestructiveConfirmDialog
        open={deleteItem !== null}
        onOpenChange={(o) => !o && setDeleteItem(null)}
        title={t('delete_confirm_title')}
        description={t('delete_confirm_description', {
          name: deleteItem?.file_name ?? t('unnamed_document'),
        })}
        confirmLabel={t('action_delete')}
        cancelLabel={t('preview_close')}
        onConfirm={async () => {
          if (deleteItem) await handleDelete(deleteItem)
          setDeleteItem(null)
        }}
      />
    </div>
  )
}
