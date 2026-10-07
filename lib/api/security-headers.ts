/**
 * Common security headers for the public skills discovery route
 * (`/.well-known/skills/index.json`), which bypasses the auth wrapper and
 * returns a plain `NextResponse.json` with caching.
 *
 *   X-Content-Type-Options: nosniff  : block MIME sniffing on text/json
 *   Referrer-Policy: strict-origin...: limit referrer leakage if a link is
 *                                       embedded somewhere unexpected
 *   X-Frame-Options: DENY            : discovery surfaces should never
 *                                       legitimately render in a frame
 *
 * Includes CSP and HSTS, but NOT X-Robots-Tag: the skills index exists to be
 * read by agents.
 */
export const PUBLIC_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  // Discovery routes return JSON or plain text: no script, style, image, or
  // form contexts. `default-src 'none'` is the strictest possible CSP and
  // costs nothing here.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  // HSTS: every Accounted deployment is HTTPS-only. 1 year is the standard
  // production value; includeSubDomains because the apex serves everything.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

/**
 * Merge the public security headers onto an arbitrary header dict so callers
 * can keep their own Content-Type / Cache-Control entries.
 */
export function withPublicSecurityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...PUBLIC_SECURITY_HEADERS, ...extra }
}
