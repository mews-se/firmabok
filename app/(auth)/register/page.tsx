'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Eye, EyeOff } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { AuthPageSkeleton } from '@/components/auth/AuthPageSkeleton'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { classifyAuthError, type AuthErrorKind } from '@/lib/auth/classify-auth-error'
import { isValidPassword, PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy'

export default function RegisterPage() {
  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      <RegisterPageContent />
    </Suspense>
  )
}

function RegisterPageContent() {
  // This page reads no query parameters. It deliberately does NOT read
  // `next`: nothing links here with one (bounceToAuth in
  // lib/supabase/middleware.ts targets /login only), the already-signed-in
  // case is handled in the middleware behind safeReturnTo, and the signup
  // path has no destination to spend it on. If a destination is ever wanted
  // here it MUST go through safeReturnTo (lib/auth/safe-return-to.ts); a
  // hand-rolled check on such a value is an open redirect.
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // Signup failures render inline next to the form (see AuthFormError), never
  // as a toast. Field-level problems attach to their field; everything else
  // goes to the form-level alert above the form.
  const [formError, setFormError] = useState<{ kind: AuthErrorKind; message: string } | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const confirmInputRef = useRef<HTMLInputElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()
  const t = useTranslations('register')
  const tAuth = useTranslations('auth')
  const errorLocale = useLocale() as ErrorLocale

  const handleRegister = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)
    setPasswordError(null)
    setConfirmError(null)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email
    const passwordValue = (formData.get('password') as string) || password
    const confirmValue = (formData.get('confirm_password') as string) || confirmPassword

    // Client-side checks run before isLoading so the inputs are still enabled
    // when focus moves to the offending field.
    if (!isValidPassword(passwordValue)) {
      setPasswordError(t('password_error_requirements'))
      passwordInputRef.current?.focus()
      return
    }

    if (passwordValue !== confirmValue) {
      setConfirmError(t('password_mismatch_description'))
      confirmInputRef.current?.focus()
      confirmInputRef.current?.select()
      return
    }

    setIsLoading(true)

    try {
      const { data, error } = await supabase.auth.signUp({
        email: emailValue,
        password: passwordValue,
      })

      if (error) {
        console.error('[register] signUp error', error.message)
        const kind = classifyAuthError(error)
        if (kind === 'weak_password') {
          // Server-side password policy rejection: same field, same message
          // as the client-side check.
          setPasswordError(t('password_error_requirements'))
        } else {
          const messageByKind: Partial<Record<AuthErrorKind, string>> = {
            email_exists: t('account_exists_description'),
            email_invalid: t('error_email_invalid'),
            rate_limited: t('error_rate_limited'),
            signup_disabled: t('error_signup_disabled'),
          }
          setFormError({
            kind,
            message:
              messageByKind[kind] ??
              getErrorMessage(error, { context: 'auth', locale: errorLocale }),
          })
        }
        return
      }


      // GoTrue runs with mailer autoconfirm, so a successful signup always
      // carries a session: straight to onboarding.
      if (data.session) {
        window.location.href = '/'
        return
      }

      // No session without an error only happens when GoTrue obfuscates a
      // duplicate signup (data.user with identities: [] to prevent user
      // enumeration). Frame it as the account already existing.
      setFormError({
        kind: 'email_exists',
        message: t('account_exists_description'),
      })
    } catch (error) {
      console.error('[register] unexpected exception', error instanceof Error ? error.message : String(error))
      setFormError({
        kind: 'unknown',
        message: getErrorMessage(error, { context: 'auth', locale: errorLocale }),
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-frame p-4">
      <div className="w-full max-w-sm animate-slide-up">
        <header className="text-center mb-8">
          <h1 className="sr-only">{t('create_account')}</h1>
          <BrandWordmark size="hero" />
        </header>

        <div className="rounded-xl border border-border bg-background p-6">
          {formError && (
            <div className="mb-4">
              <AuthFormError
                message={formError.message}
                action={
                  formError.kind === 'email_exists' ? (
                    <Link
                      href="/login"
                      className="font-medium underline underline-offset-2"
                    >
                      {t('sign_in')}
                    </Link>
                  ) : undefined
                }
              />
            </div>
          )}

          <div className="animate-fade-in">
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('email_label')}</Label>
              <Input
                ref={emailInputRef}
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder={t('email_placeholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('password_label')}</Label>
              <div className="relative">
                <Input
                  ref={passwordInputRef}
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder={t('password_placeholder')}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (passwordError && isValidPassword(e.target.value)) {
                      setPasswordError(null)
                    }
                  }}
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  disabled={isLoading}
                  aria-invalid={passwordError ? true : undefined}
                  aria-describedby="password-requirements"
                  className="h-11 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={showPassword ? tAuth('hide_password') : tAuth('show_password')}
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
              <p id="password-requirements" className="pt-1 text-xs text-muted-foreground">
                {t('password_req_length')}
              </p>
              {passwordError && (
                <p role="alert" className="text-xs text-destructive">
                  {passwordError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm_password">{t('confirm_password_label')}</Label>
              <Input
                ref={confirmInputRef}
                id="confirm_password"
                name="confirm_password"
                type="password"
                autoComplete="new-password"
                placeholder={t('confirm_password_placeholder')}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value)
                  if (confirmError && e.target.value === password) {
                    setConfirmError(null)
                  }
                }}
                required
                minLength={PASSWORD_MIN_LENGTH}
                disabled={isLoading}
                aria-invalid={confirmError ? true : undefined}
                aria-describedby={confirmError ? 'confirm-password-error' : undefined}
                className="h-11"
              />
              {confirmError && (
                <p
                  id="confirm-password-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {confirmError}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full h-11" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                t('create_account')
              )}
            </Button>
          </form>
          </div>
        </div>

        <p className="mt-6 text-center text-[13px] text-muted-foreground">
          {t('already_have_account')}{' '}
          <Link
            href="/login"
            className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            {t('sign_in')}
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-muted-foreground/80 leading-relaxed">
          {t('terms_prefix')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {t('terms_link')}
          </a>{' '}
          {t('terms_and')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {t('privacy_link')}
          </a>
          .
        </p>
      </div>
    </div>
  )
}
