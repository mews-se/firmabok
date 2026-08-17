# Architecture

This fork of Accounted is a single-tenant-in-practice double-entry bookkeeping
system for Swedish accounting law, slimmed for one enskild firma on a private
network. This document explains how the system is put together and why some
parts are deliberately rigid.

## Overview

- **Framework**: Next.js (App Router) with React and TypeScript in strict mode.
- **Database**: Supabase (PostgreSQL with Row Level Security), which also
  provides auth (email/password). The whole stack runs locally: see
  [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).
- **Deployment**: Docker behind nginx on a single plain-HTTP origin,
  built for a private LAN (see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)).
- **UI**: Tailwind CSS with shadcn/ui components. UI strings live in
  `messages/sv.json` and `messages/en.json`.

## The bookkeeping engine

All accounting writes flow through one engine: `lib/bookkeeping/engine.ts`.

The journal entry lifecycle is draft, then commit:

1. `createDraftEntry()` creates an uncommitted entry that can still change.
2. `commitEntry()` posts it. The voucher number is assigned atomically by the
   `commit_journal_entry` database RPC, which keeps numbering sequential per
   series. Swedish law requires an unbroken, explainable voucher sequence.
3. `createJournalEntry()` does both steps in one call.

Two invariants hold for every entry:

- Debits equal credits, and both sides are greater than zero.
- Once committed, an entry changes only through the two sanctioned correction
  tracks of BFL 5 kap 5 §: **storno** (`reverseEntry()`/`correctEntry()` in
  `lib/core/bookkeeping/storno-service.ts`, which cancels and replaces under
  new voucher numbers) and **inline rättelse** (the `correct_entry_metadata`
  and `correct_entry_lines_inline` RPCs, which change text/date or
  strike-and-replace lines inside the same voucher, logging who/when to the
  write-once `journal_entry_rattelse_log`). Deletion is only possible for the
  last voucher in a series via `delete_last_voucher`.

If a gap still occurs in a voucher series (for example around imported
history), it must be documented, and the explanation is stored
(`voucher_gap_explanations`), following BFNAR 2013:2.

## Legal enforcement lives in the database

The rules above are not conventions; they are enforced by PostgreSQL triggers:

- Committed journal entries cannot be edited or deleted, except through the
  narrow trigger branches behind the correction RPCs (transaction-local GUCs
  such as `gnubok.allow_metadata_rattelse`, set only after the rättelse log
  row is written) and the storno status transition.
- Writes to closed or locked accounting periods are rejected, as are writes
  behind a company-wide lock date. These have no GUC escape.
- Documents linked to posted entries cannot be deleted; Swedish law requires
  7-year retention of accounting records.

Application code never works around these triggers. If a code path hits one,
the code path is wrong, not the trigger.

Two smaller invariants that show up everywhere in the codebase:

- Monetary amounts are rounded with `Math.round(x * 100) / 100`. String-based
  rounding such as `toFixed()` causes drift at the öre level and breaks entry
  balance.
- Account numbers are strings (`'1930'`, never `1930`). They are identifiers,
  not quantities.

## Multi-tenancy and security

The multi-tenant machinery from upstream is intact (removing it would mean
rewriting hundreds of RLS policies for no gain). Users belong to companies
through `company_members`, and every business table carries a `company_id`:

- **Row Level Security** in PostgreSQL restricts rows to companies the user
  belongs to.
- **Explicit filtering**: queries still filter by `company_id` in code, as
  defense in depth, because service-role code paths bypass RLS.
- **Route guards**: API routes wrap `withRouteContext`, which resolves the
  authenticated user and the active company in one place. Routes never
  hand-roll their own auth.

`NEXT_PUBLIC_SELF_HOSTED=true` (the default here) disables MFA enforcement,
session timeouts, analytics and the upstream paywall.

## The one extension: MCP

Upstream's extension system remains, but this fork enables a single
extension: `extensions/general/mcp-server/`. It exposes the bookkeeping
engine as MCP (Model Context Protocol) tools so an external AI agent, with
its own API key and its own model account, can operate the ledger. There is
no LLM call anywhere in this codebase.

- Authentication uses scoped API keys (`gnubok_sk_*`, stored as SHA-256
  hashes) created under `/settings/api`, or MCP OAuth.
- Posting operations are staged: the agent proposes, and a human approves on
  the `/pending` page before anything is committed to the journal.
- The Swedish accounting skills under `.claude/skills/swedish-*` are compiled
  into the `agent_atom_registry` seed and served to agents via the
  `gnubok_load_skill` tool.

Core code never imports from `@/extensions/`; extensions integrate through
the event bus (`lib/events/bus.ts`) and the generated static registry
(`npm run setup:extensions`).

The project is licensed AGPL-3.0-or-later; this fork carries no extension
exception. See [LICENSE](LICENSE).

## Repository map

| Path | Contents |
|---|---|
| `app/` | Next.js App Router pages and API routes |
| `lib/bookkeeping/` | Engine, entry generators, account mapping, BAS chart data |
| `lib/core/` | Periods, year-end, storno, tax codes, audit, documents |
| `lib/reports/` | Balance sheet, income statement, VAT, SIE, NE-bilaga |
| `lib/bokslut/enskild-firma/` | Egenavgifter, räntefördelning, fonder for the NE flow |
| `components/` | React components (shadcn/ui based) |
| `extensions/general/mcp-server/` | The MCP tool surface |
| `packages/gnubok-mcp` | stdio→HTTP MCP bridge (npm) |
| `supabase/migrations/` | Database schema, RLS policies, enforcement triggers |
| `packs/` | Konteringspaket (booking templates) as validated YAML |
| `messages/` | Swedish and English UI strings |
| `docs/` | Self-hosting and white-label guides |

## Testing

- Unit and route tests run on Vitest with mocked Supabase clients
  (`npm test`).
- Database behavior (triggers, RPCs, RLS) is tested against a real PostgreSQL
  instance in `*.pg.test.ts` files (`npm run test:pg`), because mocking cannot
  prove trigger semantics.
