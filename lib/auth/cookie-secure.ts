/**
 * Whether cookies should carry the Secure flag. Follows the deployment
 * URL: an http:// NEXT_PUBLIC_APP_URL (LAN installs without TLS) cannot
 * use Secure cookies - the browser would drop them - while https://
 * deployments keep the production default.
 */
export function cookieSecure(): boolean {
  if (process.env.NEXT_PUBLIC_APP_URL?.startsWith('http://')) return false
  return process.env.NODE_ENV === 'production'
}
