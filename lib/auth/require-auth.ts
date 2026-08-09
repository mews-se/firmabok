import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { shouldEnforceMfa } from './mfa'
import type { User, SupabaseClient, JwtPayload } from '@supabase/supabase-js'

type AuthResult =
  | { user: User; supabase: SupabaseClient; error: null }
  | { user: null; supabase: SupabaseClient; error: NextResponse }

/**
 * Maps verified JWT claims onto the User subset routes actually consume
 * (id, email, is_anonymous, app_metadata, user_metadata, role, phone).
 *
 * Server-only fields (identities, factors, created_at timestamps) are absent
 * from the token and verified unused by any route (2026-07-23 audit);
 * created_at is set to '' only to satisfy the type.
 */
/**
 * Defense-in-depth pinning on top of getClaims' signature/expiry verification:
 * the token must come from THIS project's auth server (iss) and be an
 * end-user access token (aud 'authenticated'; anonymous sign-ins share it).
 * A mismatch is not treated as unauthenticated: we fall back to the
 * server-side getUser() check, which is authoritative.
 */
function claimsPinned(claims: JwtPayload): boolean {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  // Without a configured URL (unit tests) there is nothing to pin against.
  const issOk = !supabaseUrl || claims.iss === `${supabaseUrl}/auth/v1`
  const aud = claims.aud
  const audOk = Array.isArray(aud) ? aud.includes('authenticated') : aud === 'authenticated'
  return issOk && audOk
}

function userFromClaims(claims: JwtPayload): User {
  return {
    id: claims.sub,
    aud: Array.isArray(claims.aud) ? (claims.aud[0] ?? 'authenticated') : (claims.aud ?? 'authenticated'),
    role: claims.role,
    email: claims.email,
    phone: claims.phone,
    app_metadata: claims.app_metadata ?? {},
    user_metadata: claims.user_metadata ?? {},
    is_anonymous: claims.is_anonymous ?? false,
    created_at: '',
  }
}

/**
 * Auth + MFA guard for API routes.
 *
 * Returns the authenticated user and Supabase client, or a JSON error response.
 * When MFA is required (hosted deployment), verifies AAL2 assurance level.
 *
 * Fast path: getClaims() performs local WebCrypto verification against the
 * shared 10-minute JWKS cache instead of a per-request network getUser()
 * round trip. HS256/self-hosted projects fall back to a server call inside
 * getClaims itself (identical semantics; NEXT_PUBLIC_SELF_HOSTED needs no
 * special-casing). Revocation is still checked on every request by proxy.ts
 * middleware getUser() before any route runs. Claims-sourced metadata
 * (email, app_metadata, is_anonymous) can be up to one access-token TTL
 * stale, which is acceptable for all current consumers: bankid_linked
 * staleness is covered because the middleware MFA gate
 * (lib/supabase/middleware.ts) uses the FRESH getUser result.
 */
export async function requireAuth(): Promise<AuthResult> {
  const supabase = await createClient()

  let user: User | null = null
  try {
    // The typeof guard keeps legacy test mocks (auth object with only
    // getUser) on the old path.
    if (typeof supabase.auth.getClaims === 'function') {
      const { data } = await supabase.auth.getClaims()
      const claims = data?.claims
      if (claims?.sub) {
        if (claimsPinned(claims)) {
          user = userFromClaims(claims)
        } else {
          console.error('requireAuth: getClaims iss/aud pinning failed; falling back to getUser', {
            iss: claims.iss,
            aud: claims.aud,
          })
        }
      }
    }
  } catch (err) {
    // JWKS outage or malformed token: fall through to the server-side check.
    // Logged because every hit here degrades the request to the slower
    // getUser round trip; a spike must be visible in production.
    console.error('requireAuth: getClaims failed; falling back to getUser', err)
  }
  if (!user) {
    const { data } = await supabase.auth.getUser()
    user = data?.user ?? null
  }

  if (!user) {
    return {
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  if (shouldEnforceMfa(user)) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aal?.nextLevel === 'aal2' && aal?.currentLevel !== 'aal2') {
      return {
        user: null,
        supabase,
        error: NextResponse.json({ error: 'MFA verification required' }, { status: 403 }),
      }
    }
  }

  return { user, supabase, error: null }
}
