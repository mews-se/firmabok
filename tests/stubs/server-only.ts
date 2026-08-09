/**
 * Test stub for the `server-only` package.
 *
 * `server-only` is a Next.js BUILD-time guard: its real entry point throws
 * unconditionally, and the bundler swaps in a harmless module for the server
 * graph. Vitest has no such bundler step, so any module that imports it
 * (lib/analytics/posthog-server.ts, app/(dashboard)/request-context.ts)
 * explodes with "This module cannot be imported from a Client Component
 * module" the moment a test touches it, directly or transitively.
 *
 * Aliasing it to this empty module in vitest.config.ts keeps the guard doing
 * its real job in `next build` while letting the suite import server modules.
 */
export {}
