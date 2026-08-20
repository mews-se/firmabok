'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AttnLine } from '@/components/ui/attn-line'
import {
  Loader2,
  CircleAlert,
  Eye,
  EyeOff,
} from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { classifyAuthError, type AuthErrorKind } from '@/lib/auth/classify-auth-error'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import {
  setSessionAuthMethodHint,
  type SessionTimeoutReason,
} from '@/lib/auth/session-timeout-shared'

/**
 * The login panel: email and password, nothing else.
 */
export function LoginClient() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  // Auth failures render inline (see the field error line), never as a
  // toast: `kind` drives field highlighting.
  const [formError, setFormError] = useState<{ kind: AuthErrorKind; message: string } | null>(null)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const emailInputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const searchParams = useSearchParams()
  const reasonParam = searchParams.get('reason')
  const timeoutReason: SessionTimeoutReason | null =
    reasonParam === 'idle' || reasonParam === 'absolute' ? reasonParam : null
  // Post-login destination, set e.g. by the MCP OAuth authorize endpoint
  // (/login?next=/api/mcp-oauth/authorize?...). Sanitized to a same-origin
  // relative path; '/' means no explicit destination.
  const nextPath = safeReturnTo(searchParams.get('next'), '/')
  const supabase = createClient()
  const tAuth = useTranslations('auth')
  const errorLocale = useLocale() as ErrorLocale

  useEffect(() => {
    if (timeoutReason) resetAnalyticsIdentity()
  }, [timeoutReason])

  // After a failed credentials attempt, put the caret back in the password
  // field with the old value selected so the user can retype immediately.
  // Runs post-render: the inputs are disabled while the request is in flight.
  useEffect(() => {
    if (formError?.kind === 'invalid_credentials') {
      passwordInputRef.current?.focus()
      passwordInputRef.current?.select()
    }
  }, [formError])

  const handlePasswordLogin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setFormError(null)
    setIsLoading(true)

    const formData = new FormData(e.currentTarget)
    const emailValue = (formData.get('email') as string) || email
    const passwordValue = (formData.get('password') as string) || password

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: emailValue,
        password: passwordValue,
      })

      if (error) {
        const kind = classifyAuthError(error)
        const messageByKind: Partial<Record<AuthErrorKind, string>> = {
          invalid_credentials: tAuth('login_invalid_credentials'),
          email_not_confirmed: tAuth('login_error_email_not_confirmed'),
          rate_limited: tAuth('login_error_rate_limited'),
          user_banned: tAuth('login_error_user_banned'),
        }
        setFormError({
          kind,
          message:
            messageByKind[kind] ??
            getErrorMessage(error, { context: 'auth', locale: errorLocale }),
        })
        return
      }

      setSessionAuthMethodHint('password')

      if (nextPath !== '/') {
        // Full navigation: the destination can be a route handler that
        // returns raw HTML (the MCP OAuth consent page), which the client
        // router cannot render.
        window.location.assign(nextPath)
        return
      }

      router.push('/')
      router.refresh()
    } catch (error) {
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
          <h1 className="sr-only">{tAuth('login_title')}</h1>
          <BrandWordmark size="hero" />
        </header>

        <div className="rounded-xl border border-border bg-background p-6">
          {timeoutReason && (
            <div role="alert" className="mb-4">
              <AttnLine>
                {timeoutReason === 'idle' ? tAuth('session_idle') : tAuth('session_absolute')}
              </AttnLine>
            </div>
          )}
          <div className="animate-fade-in">
              <form onSubmit={handlePasswordLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{tAuth('email_label')}</Label>
                  <Input
                    ref={emailInputRef}
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder={tAuth('email_placeholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={isLoading}
                    aria-invalid={formError?.kind === 'invalid_credentials' || undefined}
                    className="h-11"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">{tAuth('password_label')}</Label>
                  <div className="relative">
                    <Input
                      ref={passwordInputRef}
                      id="password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder={tAuth('password_placeholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      disabled={isLoading}
                      aria-invalid={formError?.kind === 'invalid_credentials' || undefined}
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
                  {formError && (
                    <p
                      role="alert"
                      className="animate-fade-in flex items-start gap-2 pt-1 text-[13px] leading-5 text-destructive"
                    >
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span>{formError.message}</span>
                    </p>
                  )}
                </div>
                <Button type="submit" className="w-full h-11" disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {tAuth('logging_in')}
                    </>
                  ) : (
                    tAuth('login_button')
                  )}
                </Button>
              </form>
          </div>
        </div>

        <p className="mt-6 text-center text-[13px] text-muted-foreground">
          {tAuth('login_new_here')}{' '}
          <Link
            href="/register"
            className="font-medium text-foreground underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            {tAuth('no_account')}
          </Link>
        </p>

        <p className="mt-3 text-center text-xs text-muted-foreground/80 leading-relaxed">
          {tAuth('terms_prefix')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {tAuth('terms_link')}
          </a>{' '}
          {tAuth('terms_and')}{' '}
          <a href="#" className="underline underline-offset-2 hover:text-foreground transition-colors">
            {tAuth('privacy_link')}
          </a>
          .
        </p>
      </div>
    </div>
  )
}
