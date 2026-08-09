# CLAUDE.md: Accounted (personal fork)

Personal fork of erp-mafia/accounted, slimmed to one enskild firma on a
private LAN: double-entry bookkeeping under Bokföringslagen. Removed relative
to upstream: payroll, AB year-end (INK2/iXBRL/årsredovisning), the
transaction inbox and bank import, reconciliation, all external integrations,
the REST v1 API and the in-app AI assistant. The MCP server is the only
machine interface; external agents bring their own model. See README.md and
ARCHITECTURE.md.

**Stack**: Next.js 16 (App Router), React 19, TypeScript 5 strict, Zod 4,
Supabase (Postgres + RLS + auth), Tailwind 4 + shadcn/ui. Docker self-hosted
with a local Supabase stack is the only target. Path alias `@/*` = repo root.
All code, comments, and commits in English.

---

## Hard Rules

The accounting rules are Swedish law, enforced by DB triggers. Code that
violates them fails at runtime; code that works around the triggers breaks
legal compliance. Never do either.

1. **Never edit or delete a posted journal entry outside the two sanctioned
   rättelse paths.** BFL 5 kap 5 § allows two correction tracks: (a) storno:
   cancel with `reverseEntry()`, correct with `correctEntry()`
   (`lib/core/bookkeeping/storno-service.ts`); (b) inline rättelse:
   `correct_entry_metadata` / `correct_entry_lines_inline` RPCs, which
   strike-and-replace inside the same verifikat with an immutable who/when
   log (`journal_entry_rattelse_log`), only in open unlocked periods. Past a
   lock/close/declared state, storno is the only path.
2. **All journal writes go through `lib/bookkeeping/engine.ts`.** Never
   insert into journal tables directly: voucher numbers are assigned
   atomically by the `commit_journal_entry` RPC and must stay sequential, and
   gaps require documented explanations (BFNAR 2013:2,
   `voucher_gap_explanations`).
3. **Every entry balances**: `sum(debits) === sum(credits)`, both `> 0`.
4. **Respect period locks.** DB triggers block writes to closed/locked
   periods and behind the company lock date. Don't work around them: fix the
   flow that tried to write there.
5. **Never delete documents linked to posted entries**: 7-year retention is a
   legal requirement.
6. **Money math is `Math.round(x * 100) / 100`.** Never `toFixed()`: it
   returns strings and rounds incorrectly, causing öre-level drift that
   breaks entry balance.
7. **Account numbers are strings** (`'1930'`, never `1930`). They are
   identifiers, not quantities; arithmetic on them is always a bug.

General prohibitions:

- **Never modify an existing migration**: create a new one. Never touch the
  enforcement triggers (migration 017); they are legally required. Migrations
  are not idempotent; the self-hosted DB tracks applied files manually.
- **Core code must never import from `@/extensions/`.** CI builds core with
  zero extensions enabled; a direct import breaks that build.
- **Don't add dependencies without asking.** AGPL-3.0 project; license
  compatibility matters.
- **Don't "finish" the gnubok → Accounted rename.** Wire-format identifiers
  keep the old name on purpose: `gnubok-company-id` cookie, `gnubok_sk_`
  prefixes, `gnubok_*` tool names. Renaming them breaks live sessions, API
  keys and existing MCP connections.
- **Treat `.env.local` as pointing at the live database.** Never run
  seed/cleanup/repair scripts against it without explicit confirmation.
- **Keep the diff scoped to the request.** No drive-by refactors. When
  pulling from upstream, prefer keeping our deletions over re-adopting
  removed subsystems.
- **Never use em dashes (—) or en dashes (–)** in code, comments, commit
  messages, or docs; use a colon, comma, semicolon, or plain hyphen.
  Exception: a dash that is the literal subject being parsed or documented.
- Never create a NUL/nul file: `\Accounted\NUL`.

## When Uncertain

- **Stop and ask; do not guess.** Especially for anything touching posted
  entries, the live database, money math, or Swedish tax law.
- **Swedish domain questions are never answered from training data.** Load
  the matching `swedish-*` skill (vat, accounting-compliance,
  invoice-compliance, year-end-closing, sie-import-export, sru-filing,
  asset-accounting, tax-planning, e-invoicing).
- Scaffolding: `/erp-api-route` (API routes), `/supabase-migration`
  (migrations).

## Definition of Done

1. `npm run lint` is clean and `npm test` passes (`npx vitest run <dir>`
   while iterating).
2. New or changed logic in `lib/` or `app/api/` has tests: auth 401,
   validation 400, 404, happy path; mock `@/lib/supabase/server`.
3. Any change to a trigger, RPC, RLS policy, or DEFERRABLE constraint ships
   with a `*.pg.test.ts` (`npm run test:pg`).
4. New UI strings exist in **both** `messages/sv.json` and
   `messages/en.json`.
5. If you edited an atom `SKILL.md`, `npm run skills:generate` was run (CI's
   `skills:check` fails otherwise).
6. `npm run check:guards` passes if you touched API routes.
7. Commit is conventional (`feat:`/`fix:`/`refactor:`/`docs:`), atomic, on
   the `dev` branch; the user merges to `main`.

## Commands

```bash
npm run dev              # Dev server (runs setup:extensions first)
npm run build            # Production build (runs setup:extensions first)
npm run lint             # ESLint
npm test                 # All Vitest tests
npx vitest run <dir>     # Tests in one directory
npm run test:pg          # pg-real tests against real Postgres
npm run check:guards     # Ratchet guard (e.g. no hand-rolled route auth)
npm run setup:extensions # Regenerate extension registry
npm run skills:generate  # Regenerate agent_atom_registry seed
npm run crontabs:generate # Regenerate docker crontab from vercel.json
```

## Architecture

- **Journal entry lifecycle**: `createDraftEntry()` → `commitEntry()`
  (atomic voucher via `commit_journal_entry` RPC); `createJournalEntry()`
  does both. Everything accounting-shaped routes through this engine.
- **Tenancy**: every business table has `company_id`. Active company resolves
  in `lib/supabase/middleware.ts` from `user_preferences.active_company_id`;
  RLS uses `user_company_ids()`; queries still filter by `company_id`
  explicitly (service-role paths have no RLS).
- **Auth**: Supabase email+password via `withRouteContext`: never hand-roll
  `supabase.auth.getUser()` in a route. `NEXT_PUBLIC_SELF_HOSTED=true`
  disables MFA enforcement, session timeouts, BankID, analytics and the
  paywall.
- **Events**: `lib/events/bus.ts` is a module-level singleton. Any route that
  emits events must call `ensureInitialized()` (`lib/init.ts`) at module
  level.
- **Supabase clients**: browser `client.ts`, server `createClient()`, service
  role `createServiceClient()`, cookieless `createServiceClientNoCookies()`
  (in `lib/auth/api-keys.ts`; for API-key/MCP paths). Paginate with
  `fetchAllRows()`: PostgREST silently caps at 1000 rows.
- **MCP server**: the bookkeeping engine as MCP tools
  (`extensions/general/mcp-server/`), authenticated by `gnubok_sk_` API keys
  (SHA-256, scoped). Writes stage pending operations approved on `/pending`.
- **Types**: import from `@/types`; event types in `lib/events/types.ts`.
- **User-facing errors are Swedish**: map through
  `lib/errors/get-error-message.ts`.
- **Cron**: `vercel.json` is the source of truth; the Docker sidecar runs the
  generated `docker/crontab.self-hosted`.

## Repository Map

- `lib/bookkeeping/`: engine, entry generators, mapping, templates, BAS 2026
  data (`bas-data/`)
- `lib/core/`: period, year-end, storno, tax codes, audit, documents
- `lib/events/`, `lib/auth/`, `lib/supabase/`, `lib/api/` (Zod
  `validateBody`/`validateQuery`)
- `lib/reports/`: balance sheet, income statement, trial balance, ledgers,
  VAT, SIE, NE-bilaga
- `lib/bokslut/enskild-firma/`: egenavgifter, räntefördelning, fonder
- `lib/invoices/`, `lib/import/`, `lib/documents/`, `lib/tax/`, `lib/vat/`,
  `lib/currency/`, `lib/bankgiro/` (luhn/OCR validation), `lib/deadlines/`,
  `lib/personnummer.ts`
- `lib/utils.ts`: `cn()`, `formatCurrency()`, `formatDate()`,
  `formatOrgNumber()`; `lib/logger.ts`
- `app/(dashboard)/*` pages; `app/api/*` routes; `supabase/migrations/`
  schema; `extensions/general/mcp-server/` the only extension

## Testing

Vitest 4, `node` env, tests in `__tests__/`, scope `lib/` + `app/api/` (no
component/E2E tests). Helpers in `tests/helpers.ts`: `createMockSupabase()`,
`createQueuedMockSupabase()`, `createMockRequest()`, `parseJsonResponse()`,
plus fixture factories. `vi.clearAllMocks()` + `eventBus.clear()` in
`beforeEach`. Trigger/RPC/RLS behavior is tested in `*.pg.test.ts` against
real Postgres, not with mocks.

## Detail Loads On Demand

Don't duplicate these here; they auto-load when you touch matching paths:

- `.claude/rules/design.md`: design system, locked tokens (`app/**`,
  `components/**`)
- `.claude/rules/i18n.md`: sv/en conventions, "stays Swedish" surfaces
- `.claude/rules/api-routes.md`: `withRouteContext` route pattern
  (`app/api/**`)
- `.claude/rules/database.md`: migration rules, key tables/RPCs/triggers,
  pg-real (`supabase/migrations/**`)
- `.claude/rules/mcp-server.md`: MCP tool authoring, staged-operation pattern
- `.claude/rules/bookkeeping.md`: BAS accounts, VAT treatments/rutor,
  `lib/core/` services
