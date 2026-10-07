'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Sun, Moon, Monitor, LogOut } from 'lucide-react'
import { useTheme } from 'next-themes'
import { createClient } from '@/lib/supabase/client'
import { SecuritySettings } from '@/components/settings/SecuritySettings'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsSectionHeader,
  SettingsSeg,
} from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { PalettePicker } from '@/components/settings/PalettePicker'
import { usePalette } from '@/components/providers/PaletteProvider'
import type { Palette } from '@/lib/theme/palettes'

export function AccountSettingsContent() {
  const router = useRouter()
  const supabase = createClient()
  const { theme, setTheme } = useTheme()
  const { palette, setPalette } = usePalette()
  const [mounted, setMounted] = useState(false)
  const { toast } = useToast()
  const tCommon = useTranslations('common')
  const tSettings = useTranslations('settings')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const [fullName, setFullName] = useState('')
  const [initialName, setInitialName] = useState('')
  const [nameLoading, setNameLoading] = useState(true)
  const [savingName, setSavingName] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // Pre-fill the name field from profiles.full_name. Self-contained client
  // fetch: mirrors BankIdSettings.
  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (active) setNameLoading(false); return }
      const { data } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .maybeSingle()
      if (!active) return
      setFullName(data?.full_name ?? '')
      setInitialName(data?.full_name ?? '')
      setNameLoading(false)
    })()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSaveName() {
    const trimmed = fullName.trim()
    if (!trimmed || trimmed === initialName || savingName) return
    setSavingName(true)
    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: trimmed }),
      })
      if (!res.ok) throw new Error('Could not save')
      setFullName(trimmed)
      setInitialName(trimmed)
      toast({ title: tSettings('name_saved') })
      router.refresh()
    } catch {
      toast({ title: tSettings('name_save_failed'), variant: 'destructive' })
    } finally {
      setSavingName(false)
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const paletteLabels: Record<Palette, string> = {
    neutral: tSettings('palette_neutral'),
    indigo: tSettings('palette_indigo'),
    forest: tSettings('palette_forest'),
    sand: tSettings('palette_sand'),
  }

  const nameUnchanged = !fullName.trim() || fullName.trim() === initialName

  return (
    <div>
      <SettingsSectionHeader title={tNav('account')} intro={tIntro('account')} />

      {/* Profile: name, appearance */}
      <SettingsGroup label={tSettings('group_profile')}>
        <SettingsRow
          label={tSettings('name_label')}
          htmlFor="full_name"
          help={tSettings('name_description')}
          align="baseline"
        >
          <SettingsInput
            id="full_name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={tSettings('name_placeholder')}
            disabled={nameLoading || savingName}
            maxLength={100}
          />
          <SettingsRowEnd>
            <Button
              size="sm"
              onClick={handleSaveName}
              disabled={nameLoading || savingName || nameUnchanged}
            >
              {savingName ? tCommon('saving') : tCommon('save')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>

        <SettingsRow label={tSettings('section_appearance')}>
          {mounted && (
            <SettingsSeg
              value={theme ?? 'system'}
              onChange={setTheme}
              aria-label={tSettings('section_appearance')}
              options={[
                {
                  value: 'light',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Sun className="h-3.5 w-3.5" />
                      {tCommon('theme_light')}
                    </span>
                  ),
                },
                {
                  value: 'dark',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Moon className="h-3.5 w-3.5" />
                      {tCommon('theme_dark')}
                    </span>
                  ),
                },
                {
                  value: 'system',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Monitor className="h-3.5 w-3.5" />
                      {tCommon('theme_system')}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </SettingsRow>

        <SettingsRow
          label={tSettings('palette_label')}
          help={tSettings('palette_description')}
          align="baseline"
        >
          {mounted && (
            <PalettePicker
              value={palette}
              onChange={setPalette}
              labels={paletteLabels}
              aria-label={tSettings('palette_label')}
            />
          )}
        </SettingsRow>
      </SettingsGroup>

      {/* Security: BankID, password, 2FA (renders its own group) */}
      <SecuritySettings />

      {/* Sign out */}
      <SettingsGroup>
        <SettingsRow label={tCommon('logout')} help={tCommon('logout_description')}>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="mr-2 h-3.5 w-3.5" />
              {tCommon('logout')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
