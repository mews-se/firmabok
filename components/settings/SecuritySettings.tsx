'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
} from '@/components/settings/SettingsRows'
import { isValidPassword, PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy'

export function SecuritySettings() {
  const t = useTranslations('settings_security')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const { toast } = useToast()

  const handleChangePassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsChangingPassword(true)

    if (!isValidPassword(newPassword)) {
      toast({
        title: t('toast_weak_password_title'),
        description: t('toast_weak_password_description'),
        variant: 'destructive',
      })
      setIsChangingPassword(false)
      return
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: t('toast_mismatch_title'),
        description: t('toast_mismatch_description'),
        variant: 'destructive',
      })
      setIsChangingPassword(false)
      return
    }

    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      })

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast({
          title: t('toast_update_failed_title'),
          description: body.error || t('toast_update_failed_description'),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('toast_password_updated_title'),
        description: t('toast_password_updated_description'),
      })
      setNewPassword('')
      setConfirmPassword('')
    } catch {
      toast({
        title: t('toast_generic_error_title'),
        description: t('toast_try_again'),
        variant: 'destructive',
      })
    } finally {
      setIsChangingPassword(false)
    }
  }

  return (
    <SettingsGroup label={t('group_security')}>
      <form onSubmit={handleChangePassword}>
        <SettingsRow
          label={t('new_password_label')}
          htmlFor="new_password"
          help={t('change_password_description')}
          align="baseline"
        >
          <SettingsInput
            id="new_password"
            type="password"
            autoComplete="new-password"
            placeholder={t('new_password_placeholder')}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            disabled={isChangingPassword}
          />
        </SettingsRow>
        <SettingsRow
          label={t('confirm_password_label')}
          htmlFor="confirm_new_password"
          align="baseline"
        >
          <SettingsInput
            id="confirm_new_password"
            type="password"
            autoComplete="new-password"
            placeholder={t('confirm_password_placeholder')}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            disabled={isChangingPassword}
          />
          <SettingsRowEnd>
            <Button type="submit" size="sm" disabled={isChangingPassword}>
              {isChangingPassword ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('update_password_button')
              )}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </form>
    </SettingsGroup>
  )
}
