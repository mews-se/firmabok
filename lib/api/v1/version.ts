/**
 * The current API version date.
 *
 * Echoed in every response's `meta.api_version` and accepted as the optional
 * `Gnubok-Version` request header for future date-pinned breaking changes.
 *
 * Bump this when shipping a breaking change inside v1; older versions are
 * preserved as long as integrators pin to them via the header.
 */
export const API_V1_VERSION = '2026-05-12'

export const API_V1_VERSION_HEADER = 'Gnubok-Version'
