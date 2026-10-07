/**
 * Every timestamp in the app is a Swedish business event, so it is formatted
 * in Swedish wall-clock time. Without this, formatting falls back to the
 * runtime time zone: UTC on the server, the visitor's own zone in the
 * browser, which renders a 14:05 send as 12:05 and disagrees across the
 * hydration boundary.
 */
export const APP_TIME_ZONE = 'Europe/Stockholm'
