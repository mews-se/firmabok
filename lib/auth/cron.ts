import crypto from 'crypto'
import { NextResponse } from 'next/server'

/**
 * Verify cron secret using constant-time comparison to prevent timing attacks.
 * Expects `Authorization: Bearer <CRON_SECRET>` header.
 *
 * Returns null if authorized, or a 401 NextResponse if not.
 */
export function verifyCronSecret(request: Request): NextResponse | null {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || !authHeader) {
    return unauthorized()
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.substring(7)
    : authHeader

  // Use timingSafeEqual to prevent timing-based secret extraction.
  // Encode both to buffers of equal length by hashing with SHA-256.
  const tokenHash = crypto.createHash('sha256').update(token).digest()
  const secretHash = crypto.createHash('sha256').update(cronSecret).digest()

  if (!crypto.timingSafeEqual(tokenHash, secretHash)) {
    return unauthorized()
  }

  return null
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}
