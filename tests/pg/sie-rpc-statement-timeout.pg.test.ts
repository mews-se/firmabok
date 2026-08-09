import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

/**
 * The SIE import/replace/undo RPCs each run an entire file's work in one
 * statement, so each carries a function-scoped statement_timeout (migrations
 * 20260629160100 and 20260721144311); without it they inherit the 8s
 * authenticator timeout and any real-world multi-year migration is cancelled
 * with "canceling statement due to statement timeout".
 *
 * CREATE OR REPLACE FUNCTION silently drops settings attached via
 * ALTER FUNCTION ... SET, so a future redefinition of any of these functions
 * would revive the bug unless the SET is carried along. This ratchet runs
 * after full migration replay in CI and pins the config.
 */

const TIMEOUT_PROTECTED_FUNCTIONS = [
  'import_sie_journal_entries',
  'replace_sie_import',
  'undo_sie_import',
]

describe('SIE RPC statement_timeout config', () => {
  it.each(TIMEOUT_PROTECTED_FUNCTIONS)(
    '%s carries a function-scoped statement_timeout of 290s',
    async (functionName) => {
      const { rows } = await getPool().query<{ proconfig: string[] | null }>(
        `SELECT p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = $1`,
        [functionName],
      )
      expect(rows, `${functionName} should exist exactly once in public`).toHaveLength(1)
      expect(
        rows[0].proconfig ?? [],
        `${functionName} lost its statement_timeout: re-add "SET statement_timeout = '290s'" ` +
          'to the CREATE OR REPLACE FUNCTION statement that redefined it',
      ).toContain('statement_timeout=290s')
    },
  )
})
