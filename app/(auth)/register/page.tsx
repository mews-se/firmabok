'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { Check, Loader2, Mail, ArrowLeft, ExternalLink, Eye, EyeOff } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { getBranding } from '@/lib/branding/service'
import { detectWebmailHint } from '@/lib/auth/webmail-search'
import {
  consumeInviteCookie,
  INVITE_PROBLEM_MESSAGE_KEYS,
} from '@/lib/auth/consume-invite-cookie'
import { AuthPageSkeleton } from '@/components/auth/AuthPageSkeleton'
import { AuthFormError } from '@/components/auth/AuthFormError'
import { GoogleAuthButton } from '@/components/auth/GoogleAuthButton'
import { isGoogleAuthEnabled } from '@/lib/auth/google-oauth'
import { classifyAuthError, type AuthErrorKind } from '@/lib/auth/classify-auth-error'
import { cn } from '@/lib/utils'

const branding = getBranding()

export default function RegisterPage() {
  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      <RegisterPageContent />
    </Suspense>
  )
}

function RegisterPageContent() {
  // `invite` is the only query parameter this page reads. It deliberately does
  // NOT read `next`: nothing links here with one (bounceToAuth in
  // lib/supabase/middleware.ts targets /login and the two MFA pages only, and
  // app/invite/[token]/page.tsx sends `?invite=`), the already-signed-in case
  // is handled in the middleware behind safeReturnTo, and the signup path
  // has no destination to spend it on: it leaves through the confirmation
  // mail and /auth/callback. If a destination is ever wanted here it MUST go through
  // safeReturnTo (lib/auth/safe-return-to.ts); a hand-rolled check on this
  // value is an open redirect.
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isRegistered, setIsRegistered] = useState(false)
  const [duplicateEmail, setDuplicateEmail] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState<string | null>(null)
  // Signup failures render inline next to the form (see AuthFormError), never
  // as a toast. Field-level problems attach to their field; everything else
  // goes to the form-level alert above the form.
  const [formError, setFormError] = useState<{ kind: AuthErrorKind | 'oauth'; message: string } | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const confirmInputRef = useRef<HTMLInputElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()
  const router = useRouter()
  const supabase = createClient()
  const googleAuthEnabled = isGoogleAuthEnabled()
  const t = useTranslations('register')
  const tAuth = useTranslations('auth')
  const tInvite = useTranslations('invite')
  const errorLocale = useLocale() as ErrorLocale

  const chipCount = googleAuthEnabled ? 1 : 0

  // Accept a pending invite, if any, and report a non-definitive failure.
  // Returns true when the caller should land the user in the app directly.
  // The invite cookie survives anything that is not a settled outcome, so
  // /onboarding and /select-company can retry acceptance server-side.
  const acceptPendingInvite = async (): Promise<boolean> => {
    const invite = await consumeInviteCookie()
    if (invite.accepted) return true
    if (invite.problem) {
      const keys = INVITE_PROBLEM_MESSAGE_KEYS[invite.problem]
      toast({
        title: tInvite(keys.title),
        description: tInvite(keys.body),
        variant: 'destructive',
      })
    }
    return false
  }

  // When arriving from an invite link, fetch the invite info to pre-fill
  // and lock the email field so the user registers with the correct address:
  // a mismatched address makes POST /api/team/accept answer 403 on the email
  // equality check. The token survives that 403
  // (lib/auth/consume-invite-cookie.ts) so it is recoverable rather than
  // terminal, but the signup should not walk into it at all.
  useEffect(() => {
    const inviteToken = searchParams.get('invite')
    if (!inviteToken) return

    fetch(`/api/team/accept?token=${encodeURIComponent(inviteToken)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.data?.email) {
          setInviteEmail(data.data.email)
          setEmail(data.data.email)
        }
      })
      .catch(() => {})
  }, [searchParams])

  // The live checklist under the password field mirrors these rules; the
  // aggregate check gates submission.
  const passwordChecks = [
    { key: 'password_req_length', met: password.length >= 8 },
    { key: 'password_req_case', met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { key: 'password_req_number', met: /[0-9]/.test(password) },
    { key: 'password_req_special', met: /[^a-zA-Z0-9]/.test(password) },
  ] as const

  function isStrongPassword(pw: string): boolean {
    return pw.length >= 8
      && /[a-z]/.test(pw)
      && /[A-Z]/.test(pw)
      && /[0-9]/.test(pw)
      && /[^a-zA-Z0-9]/.test(pw)
  }

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
    if (!isStrongPassword(passwordValue)) {
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
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
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


      // If auto-confirmed (local dev), process invite immediately and redirect
      if (data.session) {
        const cookieMatch = document.cookie.match(/gnubok-invite-token=([^;]+)/)
        const inviteToken = cookieMatch?.[1]

        if (inviteToken) {
          try {
            const res = await fetch('/api/team/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: inviteToken }),
            })

            if (res.ok) {
              document.cookie = 'gnubok-invite-token=; path=/; max-age=0'
              window.location.href = '/'
              return
            }
          } catch (err) {
            console.error('[register] invite acceptance failed:', err instanceof Error ? err.message : String(err))
          }
        }

        // Auto-confirmed but no invite or invite failed: go to onboarding
        // (invite cookie is preserved so the onboarding fallback can retry)
        window.location.href = '/'
        return
      }

      // Supabase obfuscates duplicate signups (to prevent user enumeration):
      // when the email already belongs to a confirmed account, it returns
      // data.user with identities: [] and no error, and sends no email.
      // Detect that case so we don't show a misleading "check your email" screen.
      if (data.user && (data.user.identities?.length ?? 0) === 0) {
        setDuplicateEmail(emailValue)
        return
      }

      setEmail(emailValue)
      setIsRegistered(true)
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

  if (duplicateEmail) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-frame p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{t('duplicate_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t('duplicate_body_prefix')}{' '}
              <span className="font-medium text-foreground">{duplicateEmail}</span>.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('duplicate_hint')}
            </p>
          </div>

          <div className="space-y-2">
            {/*
              Plain /login, no `email` parameter: app/(auth)/login/page.tsx
              reads only `error`, `flow` and `next`, so the address was
              travelling in the URL (browser history, Referer, every proxy
              access log) and arriving nowhere. The address is already on
              screen above, so nothing is lost by dropping it.
            */}
            <Button className="w-full" asChild>
              <Link href="/login">
                {t('sign_in')}
              </Link>
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => setDuplicateEmail(null)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t('back')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (isRegistered) {
    const webmailHint = detectWebmailHint(email, branding.authEmailFrom)

    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-frame p-4">
        <div className="w-full max-w-sm animate-slide-up space-y-8">
          <div className="flex justify-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/8 flex items-center justify-center">
              <Mail className="h-7 w-7 text-primary" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h1 className="text-2xl font-medium tracking-tight">{t('confirm_email_title')}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t.rich('confirm_email_body', {
                email,
                strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-background p-4">
            <p className="text-sm text-muted-foreground text-center leading-relaxed">
              {t('confirm_email_hint')}
            </p>
          </div>

          <div className="space-y-2">
            {webmailHint && (
              <Button className="w-full" asChild>
                <a href={webmailHint.url} target="_blank" rel="noopener noreferrer">
                  {t(webmailHint.hasSearch ? 'open_webmail_search' : 'open_webmail_inbox', {
                    provider: webmailHint.name,
                  })}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            )}
            <Button variant="ghost" className="w-full text-muted-foreground" asChild>
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('back_to_login')}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    )
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
                disabled={isLoading || !!inviteEmail}
                readOnly={!!inviteEmail}
                className="h-11"
              />
              {inviteEmail && (
                <p className="text-xs text-muted-foreground">
                  {t('invite_email_hint')}
                </p>
              )}
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
                    if (passwordError && isStrongPassword(e.target.value)) {
                      setPasswordError(null)
                    }
                  }}
                  required
                  minLength={8}
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
              <ul
                id="password-requirements"
                className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1"
              >
                {passwordChecks.map((check) => (
                  <li
                    key={check.key}
                    className={cn(
                      'flex items-center gap-2 text-xs transition-colors duration-150',
                      check.met ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className="flex h-3 w-3 items-center justify-center"
                    >
                      {check.met ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <span className="h-1 w-1 rounded-full bg-current opacity-60" />
                      )}
                    </span>
                    {t(check.key)}
                  </li>
                ))}
              </ul>
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
                minLength={8}
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

          {chipCount > 0 && (
            <>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-background px-3 text-xs text-muted-foreground">
                    {tAuth('or_divider')}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {googleAuthEnabled && (
                  <GoogleAuthButton
                    compact
                    onError={(message) => setFormError({ kind: 'oauth', message })}
                  />
                )}
              </div>
            </>
          )}
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
