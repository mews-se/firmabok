'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

// Local mirror of the cloud-backup status shape: core must not import from
// @/extensions/, so the fields we read are declared here.
interface BackupProviderStatus {
  provider: string
  connected: boolean
  needs_reauth: boolean
  schedule: { last_auto_sync_status: 'success' | 'error' | null } | null
}

interface BackupStatus {
  providers?: BackupProviderStatus[]
  // Pre-multi-provider shape, describing Google Drive alone.
  connected: boolean
  needs_reauth: boolean
  schedule: { last_auto_sync_status: 'success' | 'error' | null } | null
}

/** Brand names stay untranslated; the sentence around them is localised. */
const PROVIDER_LABELS: Record<string, string> = {
  google_drive: 'Google Drive',
  dropbox: 'Dropbox',
}

/**
 * Warning shown on the dashboard ONLY when a connected cloud backup is failing
 * (dead token or errored auto-sync). A backup that silently stops is worse
 * than none; this makes the failure visible where the user actually is.
 * Renders nothing when the extension is off, disconnected, or healthy.
 *
 * With more than one destination connected, a failure on either one surfaces:
 * a working Drive backup does not make a broken Dropbox backup acceptable.
 */
export default function BackupHealthBanner() {
  const t = useTranslations('extensions')
  const [status, setStatus] = useState<BackupStatus | null>(null)

  useEffect(() => {
    if (!ENABLED_EXTENSION_IDS.has('cloud-backup')) return
    let cancelled = false
    fetch('/api/extensions/ext/cloud-backup/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body?.data) setStatus(body.data as BackupStatus)
      })
      .catch(() => {
        // Fail silent: the dashboard must not degrade over a status probe.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!status) return null

  const providers: BackupProviderStatus[] = status.providers ?? [
    {
      provider: 'google_drive',
      connected: status.connected,
      needs_reauth: status.needs_reauth,
      schedule: status.schedule,
    },
  ]

  const failing = providers.filter(
    (p) =>
      p.connected &&
      (p.needs_reauth || p.schedule?.last_auto_sync_status === 'error')
  )
  if (failing.length === 0) return null

  // One sentence covering everything that is broken, so two dead connections
  // do not stack two banners on the dashboard.
  const names = failing
    .map((p) => PROVIDER_LABELS[p.provider] ?? p.provider)
    .join(' + ')
  const allNeedReauth = failing.every((p) => p.needs_reauth)

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
      <div className="flex-1 text-sm">
        <p className="font-medium">
          {allNeedReauth
            ? t('ext_cloud_backup_banner_reauth', { provider: names })
            : t('ext_cloud_backup_banner_failing', { provider: names })}
        </p>
        <Link
          href="/import#cloud-backup"
          className="mt-1 inline-block text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {t('ext_cloud_backup_banner_action')}
        </Link>
      </div>
    </div>
  )
}
