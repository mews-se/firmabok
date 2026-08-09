/**
 * Forensic identifiers for security event logs (failed auth, scope deny,
 * company-membership deny). We log a *truncated* source IP (last octet
 * dropped for IPv4, last 80 bits zeroed for IPv6) and user-agent so audit
 * trails can correlate suspicious patterns by network neighbourhood
 * without persisting full identifying IPs in the log store.
 *
 * Data minimisation: GDPR Art.5(1)(c) / Art.5(1)(f). Truncation preserves
 * the diagnostic value (city-level geolocation, ASN, abuse-pattern
 * correlation) while eliminating point-of-presence identification.
 *
 * Honors `x-forwarded-for` when set (Vercel / proxies); behind Vercel the
 * leftmost value is rewritten by the edge so we accept it as authoritative.
 */
export function truncateIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  // IPv4: validate octets are 0-255, then drop last octet → "203.0.113.0/24".
  // Out-of-range octets indicate a spoofed or malformed header; refuse to
  // log a pseudo-IP that would pollute abuse-pattern analysis.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map((s) => Number.parseInt(s, 10))
    if (octets.every((o) => o >= 0 && o <= 255)) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
    }
    return undefined
  }
  // IPv6: keep first 3 hextets → "2001:db8:abc::/48"
  const v6 = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):/i.exec(ip)
  if (v6) return `${v6[1]}::/48`
  return undefined
}
