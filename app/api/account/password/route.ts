import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy'

const log = createLogger('api/account/password')

const SetPasswordSchema = z.object({
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Lösenordet måste vara minst ${PASSWORD_MIN_LENGTH} tecken`),
})

/**
 * POST /api/account/password
 *
 * Server-routed password change for the signed-in user. Every account is
 * created with a password at signup, so the write always goes through the
 * user session.
 */
export async function POST(request: Request) {
  const { user, supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const result = await validateBody(request, SetPasswordSchema)
  if (!result.success) return result.response
  const { password } = result.data

  const { error: updateError } = await supabase.auth.updateUser({ password })

  if (updateError) {
    log.warn('password update failed', {
      userId: user.id,
      code: updateError.code,
      status: updateError.status,
    })
    return NextResponse.json(
      {
        error:
          getUserErrorMessage(updateError) ||
          'Kunde inte uppdatera lösenord. Försök igen.',
      },
      { status: 400 },
    )
  }

  log.info('password set', { userId: user.id })

  return NextResponse.json({ data: { ok: true } })
}
