# Changelog

All notable changes to Firmabok, newest first. Versions follow the
tags in this repository; each one is published as a container image at
`ghcr.io/mews-se/firmabok`.

## 4.0.0 — 2026-08-20

The auth and sharing layer is cut down to what a LAN installation with one
operator actually uses: email plus password, nothing else. About 9 800 lines
leave the tree.

- The Google sign-in option is gone. Self-hosted installations never had
  the provider configured, so the button was already dark; now the code
  behind it is gone too.
- The email password-reset flow is gone. The stack ships without SMTP and
  GoTrue autoconfirms signups, so no email ever left the system: the
  reset page, the auth callback that consumed recovery and confirmation
  links, and the check-your-email screens were all unreachable. A
  forgotten password is instead reset through GoTrue's admin API; the
  recipe is under Troubleshooting in SELF-HOSTING.
- The MFA machinery is gone. It could never be switched on self-hosted
  (the flag is baked into the image), yet the enroll and verify pages and
  the assurance-level gates ran on every request path.
- Invitations, teams and multi-company support are gone. Without email
  the invitation flow could only hand out links by hand, and a single
  operator has no one to invite and no second company to switch to. The
  company switcher, the member management panel and the team settings go
  with it.
- BREAKING: the migration drops the `company_invitations`, `teams`,
  `team_members` and `team_invitations` tables permanently, together with
  every `team_id` column and the team-scoped booking templates. An
  installation that somehow used invitations or teams loses that data on
  upgrade; single-operator installations lose nothing. `company_members`
  stays, it is the backbone every row-level security policy resolves
  through.

## 3.2.0 — 2026-08-20

- The password policy is a length rule again: at least six characters, and
  no demand for mixed case, a digit or a special character. Six matches
  GoTrue's own floor, so the form and the auth service can no longer
  disagree and the "weak password" round trip is gone. Firmabok serves one
  operator over plain HTTP on the local network, where a long list of
  composition rules buys little and mostly pushes people towards writing
  the password on a note.
- That rule lived in five copies: register, reset-password, set-password,
  the security settings panel and the account password route. It now lives
  in `lib/auth/password-policy.ts`, which the form `minLength` attributes
  and both message catalogues read from, so the copies cannot drift apart
  again.

## 3.1.1 — 2026-08-20

- The installer says something when the kernel has no memory cgroup.
  Raspberry Pi firmware boots with `cgroup_disable=memory`, and Compose
  then drops every `mem_limit` in the stack while `docker stats` reports
  nothing at all, with one terse warning per service to go on.
  SELF-HOSTING carries the fix: `cgroup_enable=memory` on the single line
  in `/boot/firmware/cmdline.txt`, a reboot, and then `docker compose up
  -d --force-recreate`, because containers keep their old host config
  across the reboot and the limits do not apply until they are recreated.
- The README spells out the update commands instead of pointing back at
  the install section. Both paths are there now: the standalone wget, and
  `git pull` from an existing checkout.

## 3.1.0 — 2026-08-20

- Dependabot now watches the npm tree, the pinned GitHub Actions and the
  Docker base image. Pinning to SHAs and digests is deliberate, but those
  lines never move on their own, and one grouped pull request per
  ecosystem each month is what keeps them from going quietly stale.
- The container base image moves from node 22 to node 26, both the build
  stage and the runtime stage.
- The first month of updates lands: 34 minor and patch bumps across the
  npm tree (next 16.2.12 to 16.3.1, react and react-dom 19.2.7 to 19.2.8,
  the Radix set, pg, recharts, react-hook-form and the rest), five pinned
  actions lifted to fresh SHAs, and @types/node and framer-motion to
  their next majors. Nothing in the application's behaviour changes.
- js-yaml moves to 5.3, which drops the default export. The pack loader
  imports the namespace instead, and @types/js-yaml goes with it: the
  package ships its own types now, and the old ones still declared the
  default export the runtime no longer has.

## 3.0.4 — 2026-08-18

- js-yaml and nanoid are lifted out of two advisories the daily scan
  flags as fixable: js-yaml 4.1.1 to 4.3.1 (CVE-2026-59869 and
  GHSA-5p4m-2wfm-xmqj) and nanoid 3.3.16 to 3.3.18 (CVE-2026-67213).
  Nothing in the application's behaviour changes.
- The foreign key test accepts Postgres 18's wording. It matched the
  error text, and 18 says "violates RESTRICT setting of foreign key
  constraint" where earlier versions said "violates foreign key
  constraint".

## 3.0.3 — 2026-08-17

- Each migration and the row recording it now run in one transaction.
  They were two separate `psql` calls, so a run interrupted between
  them left the migration applied but unrecorded, and since the SQL is
  not idempotent every later start failed on objects that already
  existed, with no way out. A migration that fails midway is rolled
  back completely instead.
- The database, migration, auth and REST services get the same
  `no-new-privileges` guard the rest of the stack already had.

## 3.0.2 — 2026-08-17

- Documentation: the MCP stdio bridge is `npx gnubok-mcp`. The README
  pointed at `accounted-mcp`, which was never published; the
  architecture notes and the bridge package's own README said the same
  thing and are corrected too.
- Updates rebuild the cron sidecar: `docker compose pull` skips
  build-only services, so changes to it never reached existing
  installs. The install script also refuses `lock` without a `.env`,
  points out when the update address differs from `DOMAIN`, and the
  from-source recipe works on a fresh machine.
- The Docker Hub mirror carries `latest` and the semver tags only, and
  each mirrored tag's index is rebuilt from the platform images, so the
  attestation manifests no longer render as an unknown/unknown platform
  on Hub. GHCR keeps the fully attested index.
- Housekeeping: the pre-nginx Caddyfile and other leftovers are gone,
  compose pins the project name and fails fast on missing generated
  secrets, and the docs describe the http-only stack as it is.

## 3.0.0 — 2026-08-14

- The database is now the official `postgres` image (18.2, alpine)
  instead of Supabase's. A three-file bootstrap creates the roles, the
  auth schema GoTrue builds on and the API grants; everything else the
  stack needs ships with plain postgres. The image layer for a full
  install shrinks from over three gigabytes to under one, and the
  database idles around 45 MB.
- **Breaking:** an existing installation cannot carry its database
  volume across this upgrade. Take a `pg_dump` on the old version,
  install fresh, and restore. The install commands themselves are
  unchanged.
- New databases are created with Swedish collation (ICU sv-SE), so
  text sorts z, å, ä, ö the way Swedish expects.
- The two daily database jobs (overdue supplier invoices, invoice
  delivery PII redaction) run from the cron container like every other
  scheduled job; the database needs no cron extension.
- Security: the overdue sweep function could be called by any signed-in
  user through the API. It now requires the service role.
- A large sweep removed the dormant extension browsing surface (the
  MCP server, the only extension, is untouched), dead schema families
  for integrations this fork does not ship (Stripe, WooCommerce,
  WhatsApp and inbound-mail inboxes, provider migration), the AI chat
  leftovers and sixty-odd unused translation namespaces - about 16,000
  lines in total. The stack rests around 300 MB of memory.

## 2.5.2 — 2026-08-13

- Deleted files nothing referenced: leftovers from features removed
  earlier, one-off repair and backfill scripts for migrations long
  since run, and image assets whose code is gone. Four npm packages
  went with them, about 24 MB of installed dependencies.
- Fixed two silent problems found along the way: two tests mocked a
  module that no longer exists, so they were quietly testing nothing,
  and a scheduled-job file was generated for a setup this project does
  not have.
- No functional changes.

## 2.5.1 — 2026-08-13

- Nine database migrations each seeded the same skill library from
  scratch, so a fresh install worked through about eight megabytes of
  SQL to reach the state the newest one describes on its own. Only that
  one is kept: installs are quicker and the repository is smaller.
  Existing installs are unaffected.
- Added this changelog.

## 2.5.0 — 2026-08-13

- The storage service is gone. The app now reads and writes documents,
  logos and SIE files directly on the same Docker volume as before.
  Download links are still signed and expire the same way.
- Removed an unused webhook module from the database setup.
- Deleted dead code: an old file-naming scheme with its one-off
  scripts, an orphaned component, and storage rules nothing enforced.
- The stack is down to six services and about 450 MB at rest, which
  fits comfortably on a 2 GB machine.

## 2.1.0 — 2026-08-13

- Removed the realtime service. The app now asks the server for
  changes in the background instead of holding a websocket open. Your
  own changes still appear immediately; changes made elsewhere (another
  tab, the MCP bridge) show up within a minute or when the tab regains
  focus.
- Health checks run once a minute instead of every five seconds.
  Startup is just as fast as before.
- Frees roughly 200 MB of memory and nearly all idle processor use.

## 2.0.1 — 2026-08-11

- The compose file is now named `docker-compose.yml`, so plain
  `docker compose stop`, `logs` and `ps` work in the install directory
  without extra flags.
- The README explains how to stop and uninstall.

## 2.0.0 — 2026-08-11

- Firmabok now runs entirely on your own hardware. One compose file
  holds the app and the Supabase services it needs behind a small
  nginx, and installing on a prepared Debian server takes two commands.
  Plain HTTP on your own network.
- Updating uses the same two commands; database migrations apply
  themselves.
- Onboarding assumes a sole trader (enskild firma).
- Removed the cloud deployment path, the BankID machinery and a number
  of unused dependencies. README rewritten around what actually ships.
- The old compose setup is gone, hence the version jump.

## 1.0.1 — 2026-08-09

- Made the license machine-readable: the copyright block moved to
  `NOTICE` and `LICENSE` is now plain AGPL text, so GitHub identifies
  it correctly. No code changes.

## 1.0.0 — 2026-08-09

- First stable release. Bookkeeping engine, VAT, invoicing, year-end
  closing and SIE import/export, with self-hosted deployment tested
  from scratch.
