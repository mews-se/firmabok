/**
 * Path exclusions for the legacy-host (app.gnubok.se) page redirect in
 * next.config.ts.
 *
 * Machine surfaces (api/, .well-known/) and assets (_next/) must keep
 * answering on the legacy host after the app.accounted.se cutover;
 * everything else forwards to the new domain. The login and MFA pages are
 * deliberately NOT excluded, since a usable login page on the legacy host
 * would establish sessions there and bounce users in a redirect loop.
 */
export const LEGACY_HOST_REDIRECT_EXCLUSIONS =
  '(?!api/|\\.well-known/|_next/)'

/**
 * Mirror of how the path-to-regexp source `/:path((?!...).*)` decides
 * whether a legacy-host request is forwarded. Used by tests to pin the
 * exclusion behavior without booting Next's router.
 */
export function isRedirectedFromLegacyHost(pathname: string): boolean {
  const relative = pathname.replace(/^\//, '')
  return new RegExp(`^${LEGACY_HOST_REDIRECT_EXCLUSIONS}.*$`).test(relative)
}
