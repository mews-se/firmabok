import type { ComponentType } from 'react'
import dynamic from 'next/dynamic'
import { SettingsLoadingSkeleton } from '../SettingsLoadingSkeleton'

const AccountSettingsContent = dynamic(() =>
  import('./AccountSettingsContent').then((module) => ({ default: module.AccountSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const CompanySettingsContent = dynamic(() =>
  import('./CompanySettingsContent').then((module) => ({ default: module.CompanySettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const BookkeepingSettingsContent = dynamic(() =>
  import('./BookkeepingSettingsContent').then((module) => ({ default: module.BookkeepingSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const TaxSettingsContent = dynamic(() =>
  import('./TaxSettingsContent').then((module) => ({ default: module.TaxSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const InvoicingSettingsContent = dynamic(() =>
  import('./InvoicingSettingsContent').then((module) => ({ default: module.InvoicingSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const TemplatesSettingsContent = dynamic(() =>
  import('./TemplatesSettingsContent').then((module) => ({ default: module.TemplatesSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const BankingSettingsContent = dynamic(() =>
  import('./BankingSettingsContent').then((module) => ({ default: module.BankingSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
const ApiSettingsContent = dynamic(() =>
  import('./ApiSettingsContent').then((module) => ({ default: module.ApiSettingsContent })),
  { loading: SettingsLoadingSkeleton },
)
/**
 * Single source of truth mapping a settings section id to the component that
 * renders its content. Both the per-section route (`settings/<section>/page.tsx`,
 * a thin wrapper) and the routed settings modal (`SettingsModal` → `SettingsShell`)
 * resolve content through this map, so there is exactly one place a section's
 * composition lives.
 */
export const SETTINGS_SECTIONS: Record<string, ComponentType> = {
  account: AccountSettingsContent,
  company: CompanySettingsContent,
  bookkeeping: BookkeepingSettingsContent,
  tax: TaxSettingsContent,
  invoicing: InvoicingSettingsContent,
  templates: TemplatesSettingsContent,
  banking: BankingSettingsContent,
  api: ApiSettingsContent,
}

export type SettingsSectionId = keyof typeof SETTINGS_SECTIONS
