import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse, after } from 'next/server'
import { TimeoutError } from '@/lib/http/fetch-with-timeout'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { buildAuthorizeUrl, exchangeCodeForTokens, generatePkcePair } from './lib/oauth'
import { storeTokens, getTokens, deleteTokens, getTokenHealth } from './lib/token-store'
import { skvRequest, skvRequestWithAuth, SkatteverketAuthError, getSkatteverketEnvironment } from './lib/api-client'
import { writeSkatteverketAudit } from './lib/audit'
import { skvAuthCodeToStructured } from './lib/error-map'
import {
  buildMomsuppgift,
  type VatDeclarationPrep,
} from './lib/declaration-prep'
import { submitVatDeclarationChain } from './lib/vat-submit'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { getSystemAuthMode, isSystemAuthConfigured, getOmbudOrgNumber, getSystemCertInfo } from './lib/system-auth/config'
import { getConnection, markConnectionRevoked } from './lib/connection-store'
import { currentSkvEnvironment, resolveReadAuth } from './lib/resolve-auth'
import { probeCompanyGrants } from './lib/grant-probe'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import type { SkvSubmitResult } from '@/lib/pending-operations/skatteverket-commit'
import { syncSkattekonto, SKATTEKONTO_BALANCE_SNAPSHOT_KEY, SKATTEKONTO_LAST_SYNCED_AT_KEY } from './lib/skattekonto-sync'
import { runPostConnectRefresh } from './lib/post-connect-refresh'
import { bokforSkattekontoTransaction, SkattekontoBookingError } from './lib/skattekonto-booking'
import { handleSkattekontoDriftDetected } from './lib/skattekonto-drift-email'
import { handleSkattekontoConnectionExpired } from './lib/connection-expired-notification'
import {
  findMatchCandidates,
  findMatchSuggestionsBulk,
  matchSkattekontoToEntry,
  SkattekontoMatchError,
} from './lib/skattekonto-match'
import { splitTransactions } from './lib/skattekonto-buckets'
import type { SkattekontoBalanceSnapshot } from './types'
import type { VatPeriodType } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('skatteverket')

/**
 * Skatteverket integration extension.
 *
 * Enables filing momsdeklaration (VAT declaration) and arbetsgivardeklaration
 * (AGI), plus Skattekonto saldo sync. Users authenticate with BankID via the
 * `per` (e-legitimation) OAuth2 flow.
 *
 * Required environment variables:
 * - SKATTEVERKET_OAUTH2_CLIENT_ID
 * - SKATTEVERKET_OAUTH2_CLIENT_SECRET
 * - SKATTEVERKET_APIGW_CLIENT_ID
 * - SKATTEVERKET_APIGW_CLIENT_SECRET
 * - SKATTEVERKET_TOKEN_ENCRYPTION_KEY (openssl rand -base64 32; never reuse
 *   the test-env key in prod)
 *
 * Optional:
 * - SKATTEVERKET_ENV                            : 'test' | 'production'.
 *                                                 Drives security-relevant
 *                                                 limits (AGI payload size:
 *                                                 100 MB test vs 300 MB prod).
 *                                                 Defaults to 'test' (stricter)
 *                                                 when unset or unrecognised.
 *                                                 MUST be set explicitly in
 *                                                 every deployment manifest.
 * - SKATTEVERKET_OAUTH_BASE_URL                 : defaults to test
 * - SKATTEVERKET_API_BASE_URL                   : momsdeklaration; defaults to test
 * - SKATTEVERKET_AGD_INLAMNING_API_BASE_URL     : AGI inlämning; defaults to test
 * - SKATTEVERKET_AGD_PERIOD_API_BASE_URL        : AGI period mgmt; defaults to test
 * - SKATTEVERKET_SKATTEKONTO_API_BASE_URL       : Skattekonto; defaults to test
 * - SKATTEVERKET_DISABLED=true                  : emergency kill switch
 *
 * ─── Production cutover checklist ─────────────────────────────────────────
 * Before flipping the env URLs to prod, the following has to land first
 * (most are external blockers):
 *
 *   1. Register a prod OAuth2 client in Skatteverket's developer portal
 *      (separate from the test client). Requires a signed integrationsavtal.
 *   2. Order APIGW prod credentials (separate ärende).
 *   3. Register the prod redirect URI:
 *      `${NEXT_PUBLIC_APP_URL}/api/extensions/ext/skatteverket/callback`.
 *   4. Request scopes: agd:skicka, agd:lasa, skattekonto:lasa, moms:skicka.
 *   5. Pass Skatteverket's godkännandetest (they validate a few real AGI
 *      submissions in their test tenant before granting prod access).
 *   6. Generate a fresh SKATTEVERKET_TOKEN_ENCRYPTION_KEY (rotate from test).
 *   7. Set the prod base URLs:
 *        SKATTEVERKET_API_BASE_URL=https://api.skatteverket.se/momsdeklaration/v1
 *        SKATTEVERKET_AGD_INLAMNING_API_BASE_URL=https://api.skatteverket.se/arbetsgivardeklaration/inlamning/v1
 *        SKATTEVERKET_AGD_PERIOD_API_BASE_URL=https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1
 *        SKATTEVERKET_SKATTEKONTO_API_BASE_URL=https://api.skatteverket.se/beskattning/skattekonto/v2
 *        SKATTEVERKET_OAUTH_BASE_URL=https://peroauth2.skatteverket.se/oauth2/v1/per
 *        (per-flow prod host, verified resolving; oauth2.skatteverket.se does not exist)
 *   8. Wire an observability provider (lib/observability has the sink but no
 *      adapter is registered yet) and verify it alerts on
 *      /api/extensions/ext/skatteverket/* 5xx.
 *   9. Verify 7-year retention of `agi_declarations.xml_content` +
 *      `kvittensnummer` (BFL 7 kap.).
 *  10. Run a single AGI end-to-end against test on a real client before
 *      switching that client over.
 *
 * ─── System auth (ombud + org certificate) cutover checklist ──────────────
 * The hybrid model's background-read credentials. All code ships behind
 * SKATTEVERKET_SYSTEM_AUTH_MODE=off; flipping to shadow/on requires:
 *
 *   1. Skatteverket's CCG/org-flow docs (token endpoint URL, mechanism
 *      mTLS vs private_key_jwt, scope names, whether APIGW headers persist,
 *      whether resource calls need the client cert).
 *   2. Organisationscertifikat from Expisoft (test + prod) for Accounted's
 *      org number, base64-wrapped into SKATTEVERKET_SYSTEM_CERT_PEM_B64 /
 *      _KEY_PEM_B64.
 *   3. Bilateral avtal per API for the org flow (skattekonto read, AGI read,
 *      momsdeklaration ombud) + APIGW subscriptions for the system client.
 *   4. Set SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL, _SCOPES, _CLIENT_ID,
 *      _AUTH_MECHANISM per the docs; SKATTEVERKET_OMBUD_ORG_NUMBER =
 *      Accounted's org number (shown to users in the grant instructions).
 *   5. Validate grant-probe.ts classification against real sandbox 403
 *      bodies (shadow mode in the test environment first).
 *   6. Godkännandetest per API, then SKATTEVERKET_SYSTEM_AUTH_MODE=on in
 *      prod. User tokens remain the fallback indefinitely.
 *
 * The /status endpoint reports which environment is active so the UI can
 * surface a Testmiljö / Produktion badge.
 */

const AGI_WRITE_ROLES = new Set(['owner', 'admin', 'member'])

/**
 * Paywall gate for routes that talk to Skatteverket's API. The declaration
 * FILE download is always free (manual filing is never blocked); the direct
 * API interaction (connect, validate, draft, lock, submit, sync) is the paid
 * convenience. Returns null when entitled, a 403 capability_blocked response
 * otherwise. Unlock (DELETE /declaration/lock) is deliberately NOT gated so a
 * lapsed company can always recover a draft it locked while entitled.
 */
async function requireSkvCapability(ctx: ExtensionContext): Promise<NextResponse | null> {
  return requireCapability(ctx.supabase, ctx.companyId, CAPABILITY.skatteverket)
}

/**
 * Defense-in-depth RBAC check for AGI write/validate endpoints. Ctx
 * presence alone (set by middleware) only confirms the user is signed in
 * and has a resolved company; it does NOT prove they are entitled to
 * submit tax declarations for that company. Viewers must be blocked.
 *
 * Returns null on success, a NextResponse on failure.
 */
async function requireAgiWriteRole(ctx: ExtensionContext): Promise<NextResponse | null> {
  const { data, error } = await ctx.supabase
    .from('company_members')
    .select('role')
    .eq('company_id', ctx.companyId)
    .eq('user_id', ctx.userId)
    .maybeSingle()

  if (error) {
    return NextResponse.json(
      { error: 'Behörighetskontroll misslyckades.' },
      { status: 500 },
    )
  }
  if (!data?.role || !AGI_WRITE_ROLES.has(data.role as string)) {
    return NextResponse.json(
      { error: 'Otillräcklig behörighet för att lämna in AGI för det här företaget.' },
      { status: 403 },
    )
  }
  return null
}

/**
 * Base URL for the OAuth redirect_uri registered with Skatteverket in
 * Utvecklarportalen. Registration changes there are slow, so after the
 * user-facing app moved to app.accounted.se the redirect_uri stays pinned
 * to the legacy domain via NEXT_PUBLIC_SKV_OAUTH_BASE_URL (hosted value:
 * https://app.gnubok.se). Self-hosted deployments leave it unset and the
 * regular app URL is used.
 */
function getSkvOauthBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  )
}

export const skatteverketExtension: Extension = {
  id: 'skatteverket',
  name: 'Skatteverket Integration',
  version: '1.0.0',

  settingsPanel: {
    label: 'Skatteverket',
    path: '/settings/account',
  },

  apiRoutes: [
    // ── OAuth: Start authorization ──────────────────────────────────
    // Builds the Skatteverket OAuth2 authorize URL and redirects the user
    // to BankID login. Stores state token in extension settings for CSRF validation.
    {
      method: 'GET',
      path: '/authorize',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        const state = crypto.randomUUID()
        const redirectUri = `${getSkvOauthBaseUrl()}/api/extensions/ext/skatteverket/callback`

        // Optional: where to send the user after the BankID round-trip.
        // Allowlisted to internal in-app paths to avoid open-redirect abuse.
        const url = new URL(request.url)
        const requestedReturn = url.searchParams.get('return_to')
        const returnTo =
          requestedReturn && requestedReturn.startsWith('/') && !requestedReturn.startsWith('//')
            ? requestedReturn
            : null

        // Generate PKCE pair: verifier persisted server-side, challenge sent
        // to SKV. Some SKV per-flow client configurations issue revoked-on-use
        // tokens unless PKCE is present, so we always send it.
        const pkce = generatePkcePair()

        // Store state for CSRF validation in callback. The user id is stored
        // alongside it because the callback runs on the OAuth host (see
        // getSkvOauthBaseUrl), where the browser carries no session cookies
        // once the user-facing app lives on its own domain.
        await ctx.settings.set('oauth_state', state)
        await ctx.settings.set('oauth_user_id', ctx.userId)
        await ctx.settings.set('oauth_redirect_uri', redirectUri)
        await ctx.settings.set('oauth_code_verifier', pkce.verifier)
        if (returnTo) await ctx.settings.set('oauth_return_to', returnTo)
        else await ctx.settings.clear('oauth_return_to')

        const authorizeUrl = buildAuthorizeUrl(redirectUri, state, {
          codeChallenge: pkce.challenge,
        })

        return NextResponse.redirect(authorizeUrl)
      },
    },

    // ── OAuth: Callback ─────────────────────────────────────────────
    // Receives the auth code from Skatteverket after BankID login.
    // Exchanges code for tokens immediately (5-minute code expiry).
    // skipAuth: true; browser redirect from Skatteverket. We handle
    // user identification via the stored state token + Supabase session.
    {
      method: 'GET',
      path: '/callback',
      skipAuth: true,
      handler: async (request: Request) => {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        // Injection-safety invariants: appUrl comes from NEXT_PUBLIC_APP_URL
        // (deployment configuration, never user input), and jsLiteral
        // JSON-encodes and escapes `<` so embedded values cannot break out of
        // the script context. The per-response CSP nonce below is defense in
        // depth on top of that: even injected markup could never execute.
        const jsLiteral = (value: unknown) =>
          JSON.stringify(value ?? '').replace(/</g, '\\u003c')

        // CSP allows only the nonce-carrying inline script; everything else
        // is blocked. Cache-Control: no-store because the callback URL
        // carries a one-shot authorization code and must never be cached.
        const responseHeaders = (nonce: string) => ({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
          'Cache-Control': 'no-store',
        })

        // Build an HTML response that detects whether we're running inside an
        // OAuth popup. If `window.opener` exists, post a message back to the
        // parent and close the popup. Otherwise fall back to a plain redirect
        // (preserves the legacy non-popup connect flow). The fallback uses
        // location.replace so this callback URL (whose code and state are
        // consumed) drops out of history: navigating Back from the landing
        // page must not re-run the callback into a guaranteed CSRF error.
        const respondWithSuccess = (fallbackPath: string) => {
          const nonce = crypto.randomUUID()
          const html = `<!DOCTYPE html><html><body><script nonce="${nonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-success' }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.replace(${jsLiteral(`${appUrl}${fallbackPath}`)});
            }
          </script><p>Anslutningen lyckades. Du kan stänga denna flik.</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: responseHeaders(nonce),
          })
        }

        const respondWithError = (reason: string, fallbackPath: string) => {
          const nonce = crypto.randomUUID()
          const escapedReason = reason
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
          const html = `<!DOCTYPE html><html><body><script nonce="${nonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-error', reason: ${jsLiteral(reason)} }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.replace(${jsLiteral(`${appUrl}${fallbackPath}`)});
            }
          </script><p>Anslutningen misslyckades: ${escapedReason}</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: responseHeaders(nonce),
          })
        }

        if (error) {
          const desc = url.searchParams.get('error_description') || 'Okänt fel'
          return respondWithError(
            desc,
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent(desc)}`,
          )
        }

        if (!code || !state) {
          return respondWithError(
            'Saknar auktoriseringskod',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Saknar auktoriseringskod')}`,
          )
        }

        // This callback is served on the OAuth host (see getSkvOauthBaseUrl),
        // where the browser has no session cookies once the user-facing app
        // lives on its own domain. The flow is resolved entirely from the
        // state token: /authorize stored state, user id, redirect_uri and
        // PKCE verifier keyed on company_id, and the state value is an
        // unguessable single-use UUID, so the bare lookup by value doubles
        // as the CSRF check.
        const { createClient, createServiceClient } = await import('@/lib/supabase/server')
        const db = createServiceClient()

        // States are single-use and short-lived: the recency bound both
        // caps how long a leaked/phished authorize URL stays completable
        // (the row expires ten minutes after /authorize refreshed it) and
        // keeps the row set far below PostgREST's silent 1000-row cap.
        // value is jsonb, so equality is matched in JS rather than in the
        // PostgREST filter, where JSON serialization rules would apply.
        const stateCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
        const { data: stateRows, error: stateError } = await db
          .from('extension_data')
          .select('company_id, value')
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_state')
          .gte('updated_at', stateCutoff)

        if (stateError) {
          log.error('oauth state lookup failed', stateError)
          return respondWithError(
            'Ett tekniskt fel uppstod. Försök igen.',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Ett tekniskt fel uppstod')}`,
          )
        }

        const stateMatch = (stateRows ?? []).find((row) => row.value === state)
        if (!stateMatch) {
          return respondWithError(
            'Ogiltig state-parameter (CSRF)',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Ogiltig state-parameter (CSRF)')}`,
          )
        }
        const companyId = stateMatch.company_id as string

        const readSetting = async (key: string): Promise<string | null> => {
          const { data } = await db
            .from('extension_data')
            .select('value')
            .eq('company_id', companyId)
            .eq('extension_id', 'skatteverket')
            .eq('key', key)
            .maybeSingle()
          return (data?.value as string | null) ?? null
        }

        // Flows that started before oauth_user_id shipped ran on the same
        // domain as the app and still carry session cookies; fall back to
        // those so in-flight connects survive the deploy boundary.
        let userId = await readSetting('oauth_user_id')
        if (!userId) {
          const cookieClient = await createClient()
          const { data: { user } } = await cookieClient.auth.getUser()
          userId = user?.id ?? null
        }
        if (!userId) {
          return respondWithError(
            'Sessionen har gått ut. Stäng fliken och försök ansluta igen.',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Sessionen har gått ut')}`,
          )
        }

        // Defense in depth for the service-role write below: the stored
        // user must still be a member of the company that initiated the
        // flow (membership can be revoked between /authorize and this
        // callback, and RLS no longer backstops the write). Checked before
        // the exchange so a rejected flow does not burn the one-shot
        // authorization code. (#1091)
        const { data: membership } = await db
          .from('company_members')
          .select('user_id')
          .eq('company_id', companyId)
          .eq('user_id', userId)
          .maybeSingle()
        if (!membership) {
          return respondWithError(
            'Behörighet saknas för företaget',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Behörighet saknas för företaget')}`,
          )
        }

        const redirectUri = (await readSetting('oauth_redirect_uri')) ||
          `${getSkvOauthBaseUrl()}/api/extensions/ext/skatteverket/callback`

        // Retrieve the PKCE verifier stored in /authorize. Optional only for
        // backward compatibility with in-flight flows that started before the
        // PKCE rollout: once those drain, this can be made required.
        const codeVerifier = (await readSetting('oauth_code_verifier')) || undefined

        // Optional in-app destination set by /authorize?return_to=...
        const returnTo = await readSetting('oauth_return_to')
        const successPath = returnTo
          ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}skv_connected=true`
          : `/reports?tab=vat-declaration&skv_connected=true`
        const errorPath = (msg: string) =>
          returnTo
            ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}skv_error=${encodeURIComponent(msg)}`
            : `/reports?tab=vat-declaration&skv_error=${encodeURIComponent(msg)}`

        try {
          const tokens = await exchangeCodeForTokens(code, redirectUri, codeVerifier)
          await storeTokens(db, userId, tokens, companyId)

          // Clean up CSRF state + the one-shot user id/return_to/PKCE verifier.
          await db
            .from('extension_data')
            .delete()
            .eq('company_id', companyId)
            .eq('extension_id', 'skatteverket')
            .in('key', ['oauth_state', 'oauth_user_id', 'oauth_return_to', 'oauth_code_verifier'])

          // Refresh Skatteverket-derived data AFTER the response is sent.
          // Right-after-consent is still the one reliable window for a
          // personal-token fetch (SKV per-flow tokens live ~65 minutes), but
          // the sync (skattekonto fetch + AGI auto-settle + kvittens
          // re-checks) can take tens of seconds. This handler previously
          // awaited it, which held the redirect open while the popup kept
          // displaying SKV's already-consumed consent page; users read that
          // as "I approved and nothing happened". The eager promise +
          // after() pattern (mirrors the enable-banking finalize page) sends
          // the success page immediately and keeps the serverless function
          // alive until the refresh settles; the connect panels do a delayed
          // status refetch to pick up the synced data. Best-effort: a
          // refresh failure must never fail the connect that just succeeded.
          const refreshPromise = runPostConnectRefresh(db, userId, companyId)
            .then(() => undefined)
            .catch((refreshErr) => {
              log.error('post-connect refresh failed', refreshErr, { companyId, userId })
            })
          try {
            after(() => refreshPromise)
          } catch {
            // Outside a request scope (unit tests, plain node server): the
            // eager promise still drives the refresh to completion.
          }

          return respondWithSuccess(successPath)
        } catch (err) {
          console.error('[skatteverket] Token exchange failed:', err)
          // The ephemeral flow rows must not outlive the flow: oauth_user_id
          // in particular holds a user identity and serves no purpose once
          // the exchange has failed (#1090). Best-effort: a cleanup failure
          // must not mask the exchange error shown to the user.
          try {
            await db
              .from('extension_data')
              .delete()
              .eq('company_id', companyId)
              .eq('extension_id', 'skatteverket')
              .in('key', ['oauth_state', 'oauth_user_id', 'oauth_return_to', 'oauth_code_verifier'])
          } catch (cleanupErr) {
            log.error('oauth state cleanup after failed exchange failed', cleanupErr, { companyId })
          }
          // BankID auth codes expire after 5 minutes. Surface timeouts distinctly
          // so the user retries quickly instead of exhausting the code window.
          const message = err instanceof TimeoutError
            ? 'Tidsgränsen mot Skatteverket överskreds: försök igen med BankID'
            : err instanceof Error
              ? err.message
              : 'Token exchange misslyckades'
          return respondWithError(message, errorPath(message))
        }
      },
    },

    // ── Connection status ───────────────────────────────────────────
    {
      method: 'GET',
      path: '/status',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        const tokens = await getTokens(ctx.supabase, ctx.userId)
        const environment = getSkatteverketEnvironment()
        const disabled = (process.env.SKATTEVERKET_DISABLED ?? '').toLowerCase() === 'true'

        if (!tokens) {
          return NextResponse.json({ connected: false, environment, disabled })
        }

        const expired = tokens.expires_at < Date.now()
        const canRefresh = tokens.refresh_token !== null && tokens.refresh_count < 10

        // Persisted health, written by the crons when they hit a terminal
        // auth state. Lets the settings panel prompt for re-consent
        // proactively instead of only after a live failure.
        const health = await getTokenHealth(ctx.supabase, ctx.userId)

        return NextResponse.json({
          connected: true,
          expired,
          canRefresh,
          needsReconsent: health?.status === 'needs_reconsent',
          lastErrorCode: health?.last_error_code ?? null,
          scope: tokens.scope,
          expiresAt: new Date(tokens.expires_at).toISOString(),
          environment,
          disabled,
        })
      },
    },

    // ── Disconnect ──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/disconnect',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        await deleteTokens(ctx.supabase, ctx.userId)
        return NextResponse.json({ success: true })
      },
    },

    // ══════════════════════════════════════════════════════════════
    // System connection (ombud + organization certificate)
    //
    // The hybrid auth model's per-company side: the user grants Accounted's
    // org number a behorighet at Skatteverket's Ombud och behorigheter
    // e-service (one-time BankID signature), we verify it with a probe on
    // SYSTEM credentials, and background reads stop depending on the
    // 65-minute personal token. All of it is inert until
    // SKATTEVERKET_SYSTEM_AUTH_MODE is switched on.
    // ══════════════════════════════════════════════════════════════

    // ── System connection: status + instructions ────────────────────
    {
      method: 'GET',
      path: '/system-connection',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        const mode = getSystemAuthMode()
        const available = mode !== 'off' && isSystemAuthConfigured()
        if (!available) {
          return NextResponse.json({ available: false, mode })
        }

        const connection = await getConnection(ctx.companyId, currentSkvEnvironment())
        return NextResponse.json({
          available: true,
          mode,
          environment: currentSkvEnvironment(),
          // What the user grants the behorigheter to, plus where.
          ombud_org_number: getOmbudOrgNumber(),
          grant_url: 'https://skatteverket.se/ombud',
          behorigheter: [
            { key: 'lasombud', label: 'Juridiskt läsombud' },
            { key: 'moms_ombud', label: 'Momsdeklaration, ombud' },
          ],
          cert: getSystemCertInfo(),
          connection,
        })
      },
    },

    // ── System connection: verify (probe the grants) ────────────────
    {
      method: 'POST',
      path: '/system-connection/verify',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireAgiWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        if (getSystemAuthMode() === 'off' || !isSystemAuthConfigured()) {
          return NextResponse.json(
            { error: 'Systemanslutningen är inte aktiverad i denna miljö.' },
            { status: 503 }
          )
        }

        // Manual probes are rate limited: one per minute per company.
        const existing = await getConnection(ctx.companyId, currentSkvEnvironment())
        if (existing?.last_probe_at && Date.now() - new Date(existing.last_probe_at).getTime() < 60_000) {
          return NextResponse.json(
            { error: 'Vänta en minut mellan verifieringar.', connection: existing },
            { status: 429 }
          )
        }

        const { data: settings } = await ctx.supabase
          .from('company_settings')
          .select('org_number, entity_type')
          .eq('company_id', ctx.companyId)
          .single()
        if (!settings?.org_number) {
          return NextResponse.json(
            { error: 'Organisationsnummer saknas. Ange det under Inställningar först.' },
            { status: 400 }
          )
        }
        const orgNumber = formatRedovisare(
          settings.org_number as string,
          settings.entity_type as 'enskild_firma' | 'aktiebolag'
        )

        try {
          const result = await probeCompanyGrants(ctx.companyId, orgNumber, ctx.userId)
          await writeSkatteverketAudit(ctx, {
            endpoint: 'system-connection/verify',
            agRegistreradId: orgNumber,
            outcome: 'ok',
          })
          return NextResponse.json({
            data: {
              connection: result.connection,
              // Spelled-out per-behorighet outcome so the UI can say
              // "läsombud OK, momsbehörighet saknas fortfarande".
              lasombud: result.lasombud,
              moms_ombud: result.momsOmbud,
            },
          })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── System connection: revoke locally ───────────────────────────
    {
      method: 'DELETE',
      path: '/system-connection',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const roleBlocked = await requireAgiWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        // Marks the local row revoked (kept for history). Withdrawing the
        // actual behorighet happens at skatteverket.se; this only stops us
        // from using system credentials for the company.
        await markConnectionRevoked(ctx.companyId, currentSkvEnvironment())
        return NextResponse.json({ success: true })
      },
    },

    // ── Validate declaration (dry run) ──────────────────────────────
    // Sends momsuppgift to Skatteverket's /kontrollera endpoint.
    // Returns ERROR/WARNING/OK without saving anything.
    {
      method: 'POST',
      path: '/declaration/validate',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const { redovisare, redovisningsperiod, momsuppgift } =
            await parseDeclarationRequest(request, ctx)

          console.log('[skatteverket] Validating:', {
            redovisare,
            redovisningsperiod,
            momsuppgift: JSON.stringify(momsuppgift),
          })

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            'POST',
            `/kontrollera/${redovisare}/${redovisningsperiod}`,
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            console.error('[skatteverket] Validate error:', response.status, text)
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Save draft ──────────────────────────────────────────────────
    // Saves momsuppgift to Skatteverket's "Eget utrymme".
    // Returns validation results. Optionally lock for signing.
    {
      method: 'POST',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const { redovisare, redovisningsperiod, momsuppgift } =
            await parseDeclarationRequest(request, ctx)

          console.log('[skatteverket] Sending draft:', {
            redovisare,
            redovisningsperiod,
            momsuppgift: JSON.stringify(momsuppgift),
          })

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            'POST',
            `/utkast/${redovisare}/${redovisningsperiod}`,
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            console.error('[skatteverket] Draft error:', response.status, text)
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          // Track submission status
          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_saved',
              redovisare,
              redovisningsperiod,
              kontrollresultat: data.kontrollresultat,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch draft ─────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            'GET',
            `/utkast/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Delete draft ────────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            'DELETE',
            `/utkast/${redovisare}/${redovisningsperiod}`
          )

          if (response.status !== 204 && !response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          await ctx.settings.clear(`submission_${redovisningsperiod}`)
          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Lock draft for signing ──────────────────────────────────────
    // Returns a signeringslänk (deep link) that the user opens
    // in a new tab to sign with BankID on Skatteverket's site.
    {
      method: 'PUT',
      path: '/declaration/lock',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            'PUT',
            `/las/${redovisare}/${redovisningsperiod}`
          )

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_locked',
              redovisare,
              redovisningsperiod,
              signeringsLank: data.signeringsLank,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Unlock draft ────────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/declaration/lock',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            'DELETE',
            `/las/${redovisare}/${redovisningsperiod}`
          )

          if (response.status !== 204 && !response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_saved',
              redovisare,
              redovisningsperiod,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── One-click submit (kontrollera -> utkast -> lås) ─────────────
    // The whole "skicka för signering" chain behind one button. Validation
    // errors abort before anything is written to Eget utrymme; a lock
    // failure leaves the saved draft in place and says so (draft_saved),
    // so the UI can offer a lock-only retry instead of a full re-submit.
    {
      method: 'POST',
      path: '/declaration/submit',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const body = (await request.json()) as {
            periodType?: VatPeriodType
            year?: number
            period?: number
            fiscalPeriodId?: string
          }
          const { periodType, year, period, fiscalPeriodId } = body
          if (!periodType || !year || !period) {
            return NextResponse.json(
              { error: 'Saknar obligatoriska fält: periodType, year, period' },
              { status: 400 }
            )
          }

          const result = await submitVatDeclarationChain(
            ctx,
            { periodType, year, period, fiscalPeriodId },
            { validate: true }
          )

          if (!result.ok) {
            return NextResponse.json(
              {
                error: result.error,
                stage: result.stage,
                draft_saved: result.draftSaved,
                kontrollResultat: result.kontrollresultat,
              },
              { status: result.httpStatus }
            )
          }

          return NextResponse.json({
            data: {
              signeringsLank: result.signingUrl,
              redovisare: result.redovisare,
              redovisningsperiod: result.redovisningsperiod,
              kontrollResultat: result.kontrollresultat,
            },
          })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch submitted declaration ─────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/submitted',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          // resolveReadAuth: post-signing checks should outlive the user's
          // 65-minute session when the company has a moms_ombud grant.
          const resolved = await resolveReadAuth(ctx.supabase, ctx.companyId, {
            requires: 'moms_ombud',
            userId: ctx.userId,
          })
          if (!resolved.ok) {
            return NextResponse.json(
              { error: 'Inte ansluten till Skatteverket.', code: 'NOT_CONNECTED' },
              { status: 401 }
            )
          }
          const response = await skvRequestWithAuth(
            resolved.auth,
            'GET',
            `/inlamnat/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          // A non-null inlamnat means the declaration is filed: complete the
          // period's moms deadline. Best-effort, gated on the caller passing
          // the picker params (older clients omit them).
          if (data) {
            await completeVatDeadlineFromRequest(request, ctx, 'submitted')
          }

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch decided declaration ───────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/decided',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const resolved = await resolveReadAuth(ctx.supabase, ctx.companyId, {
            requires: 'moms_ombud',
            userId: ctx.userId,
          })
          if (!resolved.ok) {
            return NextResponse.json(
              { error: 'Inte ansluten till Skatteverket.', code: 'NOT_CONNECTED' },
              { status: 401 }
            )
          }
          const response = await skvRequestWithAuth(
            resolved.auth,
            'GET',
            `/beslutat/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          // A beslut means Skatteverket has processed the filing: confirm
          // the period's moms deadline (terminal state).
          if (data) {
            await completeVatDeadlineFromRequest(request, ctx, 'confirmed')
          }

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ══════════════════════════════════════════════════════════════
    // Skattekonto routes (read-only balance + transactions)
    // ══════════════════════════════════════════════════════════════

    // ── Saldo (cached snapshot) ────────────────────────────────────
    // Returns the most recent saldoResponse cached in extension_data.
    // The dashboard uses this for repeated renders without hitting SKV.
    // Force a refresh by calling POST /skattekonto/sync first.
    {
      method: 'GET',
      path: '/skattekonto/saldo',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const snapshot = await ctx.settings.get<SkattekontoBalanceSnapshot>(SKATTEKONTO_BALANCE_SNAPSHOT_KEY)
        const lastSyncedAt = await ctx.settings.get<string>(SKATTEKONTO_LAST_SYNCED_AT_KEY)
        return NextResponse.json({
          data: snapshot?.saldo ?? null,
          fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
          lastSyncedAt: lastSyncedAt ?? null,
        })
      },
    },

    // ── Transaktioner (from local table) ───────────────────────────
    // Returns booked + upcoming transactions for the active company.
    // Optional `from` query filters tidigare on transaktionsdatum >= from.
    {
      method: 'GET',
      path: '/skattekonto/transaktioner',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const from = url.searchParams.get('from')

        let query = ctx.supabase
          .from('skattekonto_transactions')
          .select('*')
          .eq('company_id', ctx.companyId)
          .order('transaktionsdatum', { ascending: false })

        if (from) query = query.gte('transaktionsdatum', from)

        const { data, error } = await query
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 })
        }

        const rows = data ?? []
        const today = new Date().toISOString().slice(0, 10)
        const { booked, overdue, upcoming } = splitTransactions(rows, today)

        // Enrich obokförda rader with a single-best-candidate suggestion.
        // Only attached when there's exactly one match: avoids the UI
        // confidently pointing at the wrong verifikat.
        const suggestions = await findMatchSuggestionsBulk(
          ctx.supabase,
          ctx.companyId,
          booked.map(r => ({
            id: r.id,
            transaktionsdatum: r.transaktionsdatum,
            belopp_skatteverket: Number(r.belopp_skatteverket),
            journal_entry_id: r.journal_entry_id,
          })),
        )

        const bookedEnriched = booked.map(r => ({
          ...r,
          match_suggestion: suggestions.get(r.id) ?? null,
        }))

        return NextResponse.json({
          data: {
            booked: bookedEnriched,
            overdue,
            upcoming,
          },
        })
      },
    },

    // ── Manual sync ────────────────────────────────────────────────
    // Pulls fresh saldo + transactions from Skatteverket and upserts.
    {
      method: 'POST',
      path: '/skattekonto/sync',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        try {
          const result = await syncSkattekonto(ctx)
          return NextResponse.json({ data: result })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Bokför one row → draft journal entry ──────────────────────
    // Creates a DRAFT verifikat in /bookkeeping for the user to review
    // and commit. The skattekonto_transactions row is linked via
    // journal_entry_id so the UI can show "Bokförd" status.
    {
      method: 'POST',
      path: '/skattekonto/transaktioner/:id/bokfor',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        // Extract :id from the catch-all dispatcher's path-param convention
        // (`_id` query string, set in app/api/extensions/ext/[...path]/route.ts).
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }

        try {
          const entry = await bokforSkattekontoTransaction(
            ctx.supabase,
            ctx.companyId,
            ctx.userId,
            id,
          )
          return NextResponse.json({ data: { entry } })
        } catch (err) {
          if (err instanceof SkattekontoBookingError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : err.code === 'PERIOD_LOCKED' ? 423
              : err.code === 'NO_COUNTER_ACCOUNT' ? 422
              : 400
            return NextResponse.json(
              { error: err.message, code: err.code },
              { status },
            )
          }
          return handleSkvError(err)
        }
      },
    },

    // ── Matcha mot befintligt verifikat ──────────────────────────────
    // List candidate journal entries already touching 1630 with the right
    // amount/side near the transaction date. Lets the user link the SKV
    // row to a manually-booked bank transfer instead of creating a duplicate
    // verifikat. Returns at most 25 candidates.
    {
      method: 'GET',
      path: '/skattekonto/transaktioner/:id/match-candidates',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }
        try {
          const { candidates } = await findMatchCandidates(ctx.supabase, ctx.companyId, id)
          return NextResponse.json({ data: { candidates } })
        } catch (err) {
          if (err instanceof SkattekontoMatchError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : 400
            return NextResponse.json({ error: err.message, code: err.code }, { status })
          }
          return handleSkvError(err)
        }
      },
    },

    // Link the SKV row to a chosen candidate. No new verifikat is created:
    // we just write journal_entry_id onto skattekonto_transactions. The
    // candidate is re-validated server-side (matching 1630 line, not already
    // linked) to catch races and a malicious client.
    {
      method: 'POST',
      path: '/skattekonto/transaktioner/:id/match',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }
        let body: { journal_entry_id?: string }
        try {
          body = (await request.json()) as { journal_entry_id?: string }
        } catch {
          return NextResponse.json({ error: 'Ogiltig request body' }, { status: 400 })
        }
        if (!body.journal_entry_id || typeof body.journal_entry_id !== 'string') {
          return NextResponse.json(
            { error: 'Saknar journal_entry_id' },
            { status: 400 },
          )
        }
        try {
          await matchSkattekontoToEntry(
            ctx.supabase,
            ctx.companyId,
            id,
            body.journal_entry_id,
          )
          return NextResponse.json({ data: { ok: true } })
        } catch (err) {
          if (err instanceof SkattekontoMatchError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ENTRY_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : err.code === 'ENTRY_ALREADY_LINKED' ? 409
              : 422
            return NextResponse.json({ error: err.message, code: err.code }, { status })
          }
          return handleSkvError(err)
        }
      },
    },
  ],

  eventHandlers: [
    {
      eventType: 'skattekonto.drift_detected',
      handler: handleSkattekontoDriftDetected,
    },
    {
      eventType: 'skattekonto.connection.expired',
      handler: handleSkattekontoConnectionExpired,
    },
  ],

  // Registry-resolved commit services for the MCP submit tools. The core
  // pending-operations dispatcher (lib/pending-operations/commit.ts) cannot
  // import this extension (CI guard), so it reaches these through
  // extensionRegistry.get('skatteverket')?.services when committing a staged
  // submit_vat_declaration operation. Commit = "send for BankID
  // signing" (returns a signing link), never "file".
  services: {
    commitSubmitVatDeclaration,
  },
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse and validate declaration request body, then compute the momsuppgift.
 *
 * The computation itself lives in lib/declaration-prep.ts (buildMomsuppgift)
 * so the commit-side service and MCP tools file exactly the same numbers this
 * route does: see the no-drift note there. This shell only parses the body.
 */
async function parseDeclarationRequest(
  request: Request,
  ctx: ExtensionContext
): Promise<VatDeclarationPrep> {
  const body = await request.json()
  const { periodType, year, period, fiscalPeriodId } = body as {
    periodType: VatPeriodType
    year: number
    period: number
    fiscalPeriodId?: string
  }

  if (!periodType || !year || !period) {
    throw new Error('Saknar obligatoriska fält: periodType, year, period')
  }

  return buildMomsuppgift(ctx.supabase, ctx.companyId, { periodType, year, period, fiscalPeriodId })
}

/**
 * Parse redovisare and redovisningsperiod from query params.
 * Used by GET/PUT/DELETE endpoints that don't need a full body.
 */
function parseQueryParams(
  request: Request,
  ctx: ExtensionContext
): { redovisare: string; redovisningsperiod: string } {
  const url = new URL(request.url)
  const redovisare = url.searchParams.get('redovisare')
  const redovisningsperiod = url.searchParams.get('redovisningsperiod')

  if (!redovisare || !redovisningsperiod) {
    throw new Error('Saknar obligatoriska parametrar: redovisare, redovisningsperiod')
  }

  // Suppress unused variable warning: ctx is required by the type signature
  void ctx

  return { redovisare, redovisningsperiod }
}

/**
 * Build the deadline generator's tax_period string (`YYYY-MM` monthly,
 * `YYYY-QN` quarterly) from the picker params. Yearly periods use the
 * fiscal-year label and need company settings; see yearlyVatTaxPeriod.
 */
function vatTaxPeriod(periodType: VatPeriodType, year: number, period: number): string | null {
  if (periodType === 'monthly') return `${year}-${String(period).padStart(2, '0')}`
  if (periodType === 'quarterly') return `${year}-Q${period}`
  return null
}

/**
 * The moms_yearly row's tax_period is the generator's fiscal-year label:
 * `YYYY` for calendar fiscal years and `YYYY-1/YYYY` for broken ones (year
 * = the FY-end year). Derived from company settings because the picker only
 * carries the year.
 */
async function yearlyVatTaxPeriod(ctx: ExtensionContext, year: number): Promise<string> {
  const { data } = await ctx.supabase
    .from('company_settings')
    .select('fiscal_year_start_month')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  const startMonth = data?.fiscal_year_start_month ?? 1
  return startMonth === 1 ? `${year}` : `${year - 1}/${year}`
}

/**
 * Complete the moms deadline for the period identified by the request's
 * optional periodType/year/period query params. Both monthly and quarterly
 * types are passed for sub-annual periods: company settings decide which one
 * exists, the other is a no-op. Best-effort by design (completeTaxDeadline
 * never throws).
 */
async function completeVatDeadlineFromRequest(
  request: Request,
  ctx: ExtensionContext,
  newStatus: 'submitted' | 'confirmed'
): Promise<void> {
  const url = new URL(request.url)
  const periodType = url.searchParams.get('periodType') as VatPeriodType | null
  const year = Number(url.searchParams.get('year'))
  const period = Number(url.searchParams.get('period'))
  if (!periodType || !Number.isFinite(year) || !Number.isFinite(period) || !year || !period) {
    return
  }
  const taxPeriod =
    periodType === 'yearly'
      ? await yearlyVatTaxPeriod(ctx, year)
      : vatTaxPeriod(periodType, year, period)
  if (!taxPeriod) return
  await completeTaxDeadline(
    ctx.supabase,
    ctx.companyId,
    periodType === 'yearly' ? ['moms_yearly'] : ['moms_monthly', 'moms_quarterly'],
    taxPeriod,
    newStatus
  )
}

/**
 * Convert Skatteverket errors to appropriate HTTP responses.
 */
function handleSkvError(err: unknown): NextResponse {
  if (err instanceof SkatteverketAuthError) {
    // MISSING_SCOPE returns 401: the existing token works, but it doesn't
    // grant access to this resource. Treating it as 401 (rather than 403)
    // signals to the frontend that the right remediation is to reconnect,
    // not to ask the user to gain new authorization at SKV.
    const status = err.code === 'NOT_CONNECTED' ? 401
      : err.code === 'BEHORIGHET_SAKNAS' ? 403
      : err.code === 'SESSION_EXPIRED' || err.code === 'REFRESH_EXHAUSTED' ? 401
      : err.code === 'MISSING_SCOPE' ? 401
      : err.code === 'TOKEN_CORRUPTED' ? 401
      : err.code === 'TOKEN_REVOKED' ? 401
      : 403

    return NextResponse.json(
      { error: err.message, code: err.code },
      { status }
    )
  }

  console.error('[skatteverket] API error:', err)
  return NextResponse.json(
    { error: err instanceof Error ? err.message : 'Okänt fel' },
    { status: 500 }
  )
}

// ── MCP submit commit services ─────────────────────────────────────────
//
// Registry-resolved by lib/pending-operations/commit.ts when a staged
// submit_vat_declaration / submit_agi op is approved. "Commit" runs the SKV
// chain up to the BankID signing link and returns it: the user's signature in
// the browser is the irreversible filing act, outside this code.
//
// Direct lib calls bypass the HTTP dispatcher's SKATTEVERKET_ENABLED gate
// (app/api/extensions/ext/[...path]/route.ts), so each service checks the flag
// itself and returns a recoverable EXTENSION_DISABLED result (the op stays
// reviewable). SkatteverketAuthError (no connection / scope / quota) is
// likewise recoverable. SKV business rejections are non-recoverable → the op
// is consumed and the user regenerates + re-stages.

function skatteverketEnabled(): boolean {
  return process.env.SKATTEVERKET_ENABLED === 'true'
}

const EXTENSION_DISABLED_RESULT: Extract<SkvSubmitResult, { ok: false }> = {
  ok: false,
  code: 'EXTENSION_DISABLED',
  http_status: 503,
  recoverable: true,
  error: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
}

/**
 * Translate a thrown error inside a commit service to a SkvSubmitResult.
 * SkatteverketAuthError (connection / scope / quota) is recoverable: the op
 * stays reviewable so the user reconnects and re-approves. Anything else is a
 * non-recoverable internal error → the op is rejected.
 */
async function mapServiceError(
  ctx: ExtensionContext,
  endpoint: string,
  err: unknown,
): Promise<Extract<SkvSubmitResult, { ok: false }>> {
  if (err instanceof SkatteverketAuthError) {
    const mapped = skvAuthCodeToStructured(err.code)
    await writeSkatteverketAudit(ctx, { endpoint, outcome: 'auth_error', errorMessage: err.message })
    return { ok: false, code: mapped.code, http_status: mapped.httpStatus, recoverable: true, error: err.message }
  }
  await writeSkatteverketAudit(ctx, {
    endpoint,
    outcome: 'internal_error',
    errorMessage: err instanceof Error ? err.message : String(err),
  })
  return {
    ok: false,
    code: 'SKATTEVERKET_INTERNAL_ERROR',
    http_status: 500,
    recoverable: false,
    error: err instanceof Error ? err.message : 'Okänt fel',
  }
}

/**
 * VAT "skicka för signering": POST /utkast + PUT /las → signeringslänk.
 * Recompute-at-commit (buildMomsuppgift over posted entries) so the figures
 * filed equal what the preview showed for the same ledger state.
 */
async function commitSubmitVatDeclaration(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<SkvSubmitResult> {
  if (!skatteverketEnabled()) return EXTENSION_DISABLED_RESULT

  const periodType = params.period_type as VatPeriodType
  const year = params.year as number
  const period = params.period as number
  const fiscalPeriodId = params.fiscal_period_id as string | undefined
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    // The staged figures were already reviewed at approval time, so the
    // chain starts at the utkast write (no kontrollera pre-step here).
    const result = await submitVatDeclarationChain(ctx, { periodType, year, period, fiscalPeriodId })
    if (!result.ok) {
      return {
        ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: result.httpStatus,
        recoverable: false, error: result.error,
      }
    }
    return {
      ok: true,
      signing_url: result.signingUrl,
      redovisningsperiod: result.redovisningsperiod,
      redovisare: result.redovisare,
      kontrollresultat: result.kontrollresultat,
    }
  } catch (err) {
    return mapServiceError(ctx, 'declaration/submit', err)
  }
}
