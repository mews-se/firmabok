'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { switchCompany } from '@/lib/company/actions'
import { getBranding } from '@/lib/branding/service'
import '@/components/onboarding/journey/journey.css'

const branding = getBranding()

/**
 * The company picker on /select-company: the journey's searchable list
 * (founder decision 2026-07-24: the list is the standard at ANY count).
 * Member companies switch + open directly; anything new goes through the
 * manual onboarding.
 */

export interface MemberCompany {
  id: string
  name: string
  orgNumber: string | null
  entityType: string | null
  role: string
}

interface CompanyPickerProps {
  firstName: string | null
  teamId: string
  memberCompanies: MemberCompany[]
  /** A pending invitation exists for this email but no invite token is at
   *  hand: point the user back to the link in the invitation email. */
  hasPendingInvite?: boolean
}

type SetupState = { kind: 'idle' } | { kind: 'opening'; companyId: string }

// Swedish legal entity names (Aktiebolag, Enskild firma, etc.) are statutory
// terms: kept in Swedish in both locales.
function humanEntityType(t: string | null | undefined): string {
  if (!t) return ''
  if (t === 'aktiebolag') return 'Aktiebolag'
  if (t === 'enskild_firma') return 'Enskild firma'
  return t
}

export default function CompanyPicker({
  firstName,
  memberCompanies,
  hasPendingInvite = false,
}: CompanyPickerProps) {
  const { toast } = useToast()
  const t = useTranslations('select_company')
  const [setup, setSetup] = useState<SetupState>({ kind: 'idle' })
  const [query, setQuery] = useState('')

  const hour = new Date().getHours()
  const greeting = hour < 5 ? t('greeting_night') : hour < 10 ? t('greeting_morning') : hour < 14 ? t('greeting_hello') : hour < 18 ? t('greeting_afternoon') : t('greeting_evening')

  const busy = setup.kind !== 'idle'

  const q = query.trim().toLowerCase()
  const filteredMembers = useMemo(
    () =>
      memberCompanies.filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          (c.orgNumber ?? '').replace(/[\s-]/g, '').includes(q.replace(/[\s-]/g, '')),
      ),
    [memberCompanies, q],
  )

  async function handleOpenMember(companyId: string) {
    if (busy) return
    setSetup({ kind: 'opening', companyId })
    const result = await switchCompany(companyId)
    if (result.error) {
      toast({
        title: t(result.error === 'not_member' ? 'error_no_access' : 'error_switch_failed'),
        variant: 'destructive',
      })
      setSetup({ kind: 'idle' })
      return
    }
    window.location.assign('/')
  }

  function onSearchEnter() {
    if (filteredMembers.length === 1) handleOpenMember(filteredMembers[0].id)
  }

  return (
    <div className="stagger-enter">
      <header className="mb-8 text-center">
        <h1 className="font-display text-2xl md:text-3xl tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="text-muted-foreground text-sm mt-1.5">{t('subtitle')}</p>
      </header>

      {hasPendingInvite && (
        <div className="mb-6 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm text-muted-foreground text-center">
            {t('pending_invite_note')}
          </p>
        </div>
      )}

      <div className="jny-biginput jny-filter" style={{ margin: '0 auto' }}>
        <input
          value={query}
          placeholder={t('search_placeholder')}
          aria-label={t('search_placeholder')}
          autoComplete="off"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSearchEnter()}
        />
      </div>

      <div className="jny-rowlist" style={{ maxHeight: '52vh' }}>
        {filteredMembers.length > 0 && (
          <div className="jny-rowsec">
            {t('section_your_companies', { appName: branding.appName.toLowerCase() })}
          </div>
        )}
        {filteredMembers.map((c) => {
          const isOpening = setup.kind === 'opening' && setup.companyId === c.id
          return (
            <button
              key={c.id}
              type="button"
              className="jny-rowpick is-existing"
              disabled={busy}
              onClick={() => handleOpenMember(c.id)}
            >
              <span className="jny-rleft">
                <span className="jny-rname">{c.name}</span>
                <span className="jny-rmeta">
                  {[humanEntityType(c.entityType), c.role !== 'owner' ? c.role : '']
                    .filter(Boolean)
                    .join(' · ') || t('opens_directly')}
                </span>
              </span>
              <span className="jny-rorg">
                {isOpening ? <Loader2 className="h-4 w-4 animate-spin" /> : c.orgNumber ?? ''}
              </span>
            </button>
          )
        })}

        {filteredMembers.length === 0 && (
          <div className="jny-rownote">
            {memberCompanies.length === 0
              ? t('no_companies_found')
              : t('no_search_matches')}
          </div>
        )}
      </div>

      <div className="mt-6 text-center">
        <Link href="/onboarding" className="jny-btn-quiet" style={{ textDecoration: 'none' }}>
          {t('add_company_manually')} &hellip;
        </Link>
      </div>
    </div>
  )
}
