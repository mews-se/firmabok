'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { TaxSettingsForm } from '@/components/settings/TaxSettingsForm'
import { TaxAssessmentNoticesPanel } from '@/components/settings/TaxAssessmentNoticesPanel'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export function TaxSettingsContent() {
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')

  // Derived EU-sales signal: postings on 3108/3308/3107 imply a periodisk
  // sammanställning obligation the opt-in flags may not reflect. Suggestion
  // only; the user confirms via the ordinary checkboxes.
  const [euSalesDetected, setEuSalesDetected] = useState(false)
  // And for ROT/RUT: invoices with deductions mean a begäran om utbetalning
  // must reach Skatteverket by 31 January after the payment year.
  const [rotRutSignalDetected, setRotRutSignalDetected] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/eu-trade-signal')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data?.has_eu_sales) setEuSalesDetected(true)
      })
      .catch(() => {
        // Best-effort signal: a failed fetch just hides the suggestion.
      })
    fetch('/api/settings/rot-rut-signal')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data?.has_rot_rut) setRotRutSignalDetected(true)
      })
      .catch(() => {
        // Best-effort signal: a failed fetch just hides the suggestion.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    const vatRegistered = formData.get('vat_registered') === 'true'

    const updates: Record<string, unknown> = {
      f_skatt: formData.get('f_skatt') === 'true',
      vat_registered: vatRegistered,
      vat_number: vatRegistered ? ((formData.get('vat_number') as string) || null) : null,
      moms_period: vatRegistered ? ((formData.get('moms_period') as string) || null) : null,
      vat_taxable_base_over_40m:
        vatRegistered && formData.get('vat_taxable_base_over_40m') === 'true',
      vat_has_eu_trade: vatRegistered && formData.get('vat_has_eu_trade') === 'true',
      // The filing-method and PS selects are conditionally rendered: when a
      // control is unmounted its FormData key is absent, and defaulting would
      // silently overwrite the saved preference. Fall back to the stored
      // value first, then the default.
      vat_filing_method:
        (formData.get('vat_filing_method') as string) ||
        settings?.vat_filing_method ||
        'electronic',
      periodisk_sammanstallning_enabled:
        vatRegistered && formData.get('periodisk_sammanstallning_enabled') === 'true',
      periodisk_sammanstallning_period:
        (formData.get('periodisk_sammanstallning_period') as string) ||
        settings?.periodisk_sammanstallning_period ||
        'monthly',
      periodisk_sammanstallning_filing_method:
        (formData.get('periodisk_sammanstallning_filing_method') as string) ||
        settings?.periodisk_sammanstallning_filing_method ||
        'electronic',
      tax_contact_name: (formData.get('tax_contact_name') as string) || null,
      tax_contact_phone: (formData.get('tax_contact_phone') as string) || null,
      tax_contact_email: (formData.get('tax_contact_email') as string) || null,
      fiscal_year_start_month: parseInt(formData.get('fiscal_year_start_month') as string) || 1,
      preliminary_tax_monthly: parseFloat(formData.get('preliminary_tax_monthly') as string) || null,
      rot_rut_enabled: formData.get('rot_rut_enabled') === 'true',
      fyllnadsinbetalning_enabled: formData.get('fyllnadsinbetalning_enabled') === 'true',
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  return (
    <div>
      <SettingsSectionHeader title={tNav('tax')} intro={tIntro('tax')} />

      <SettingsFormWrapper onSave={handleSave} className="space-y-0">
        <TaxSettingsForm
          settings={settings}
          euSalesDetected={euSalesDetected}
          rotRutSignalDetected={rotRutSignalDetected}
        />
      </SettingsFormWrapper>

      <TaxAssessmentNoticesPanel />
    </div>
  )
}
