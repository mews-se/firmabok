import { defineConfig } from 'vitest/config'
import path from 'path'

const alias = {
  '@': path.resolve(__dirname, '.'),
  // `server-only` is a build-time guard whose real entry point always throws;
  // Next.js swaps it out during bundling, Vitest cannot. Without this stub any
  // test that transitively imports a server-only module fails at import time.
  'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
}

const unitProject = {
  resolve: { alias },
  test: {
    name: 'unit',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.test.ts'],
    // `.claude/worktrees/*` are ephemeral agent checkouts whose `@/*` imports
    // resolve back to this root: never part of the suite.
    exclude: ['**/node_modules/**', '**/*.pg.test.ts', '**/.claude/**'],
  },
}

const pgRealProject = {
  resolve: { alias },
  test: {
    name: 'pg-real',
    globals: true,
    environment: 'node' as const,
    include: ['**/*.pg.test.ts'],
    exclude: ['**/node_modules/**', '**/.claude/**'],
    setupFiles: ['tests/pg/setup.ts'],
    // One-connection-at-a-time to avoid cross-file DB contention.
    fileParallelism: false,
    testTimeout: 15000,
  },
}

// Only register the pg-real project when DATABASE_URL is set. Local devs
// running a bare `vitest run` would otherwise hit the schema sanity check
// against a non-existent DB. `npm run test:pg` is the opt-in entry point.
const projects = process.env.DATABASE_URL
  ? [unitProject, pgRealProject]
  : [unitProject]

export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    environment: 'node',
    projects,
  },
})
