# Changelog

All notable changes to Firmabok, newest first. Versions follow the
tags in this repository; each one is published as a container image at
`ghcr.io/mews-se/firmabok`.

## 4.3.0 — 2026-10-01

Dependabot's monthly batch; the image rebuilds on the current
node:26-alpine with the updated runtime packages. No code change.

- react and react-dom move from 19.2.8 to 19.3.0, zod from 4.4.3 to
  4.6.5, next-intl from 4.13.7 to 4.14.7, @supabase/ssr from 0.12.5 to
  0.12.7, @react-pdf/renderer from 4.8.1 to 4.9.0, framer-motion from
  13.1.1 to 13.4.3, lucide-react from 1.34.0 to 1.48.0, react-hook-form
  from 7.86.0 to 7.88.0, tailwind-merge from 3.6.0 to 3.7.0, js-yaml from
  5.4.1 to 5.4.2, jszip from 3.10.1 to 3.10.2, posthog-js and posthog-node
  to 1.434.12 and 5.53.0, @upstash/ratelimit and @upstash/redis to 2.2.0
  and 1.39.0. eslint-config-next moves from 16.3.2 to 16.3.6 (development).
- The node:26-alpine base image moves to the current digest.
- vitest moves from 4.1.11 to 5.0.1 and dotenv from 17.4.2 to 18.0.3,
  both development only. Vitest 5 requires Node 22, so the workflows that
  pin a Node version move from 20 to 22.
- github/codeql-action moves to 4.38.2, docker/setup-buildx-action to
  4.4.1 and docker/build-push-action to 7.4.0 in the workflows.
- eslint stays on 9 for now: the eslint-plugin-react bundled with
  eslint-config-next does not run on ESLint 10 yet.


## 4.2.3 — 2026-09-30

Security update from dependabot; the image rebuilds with the patched
packages.

- next moves from 16.3.4 to 16.3.8 to clear GHSA-vcvr-r3jv-pc5j, remote
  code execution in next/og ImageResponse, fixed in 16.3.6. A LAN
  installation is not exposed to the internet, but the fix is a plain
  patch bump.
- dompurify moves from 3.4.13 to 3.4.16 to clear GHSA-p98j-92pf-mc4p,
  where a node-removing afterSanitize hook could leave event handlers
  armed on the detached subtree.
- The two brace-expansion copies under the build tooling move to 1.1.21
  and 2.1.7 to clear GHSA-q2hr-2g5m-vwhr, a quadratic-time expansion of
  the `{a},b}` rewrite. Development only.


## 4.2.2 — 2026-09-30

Security update from dependabot; the image rebuilds with the patched
js-yaml.

- js-yaml moves from 5.4.0 to 5.4.1 to clear GHSA-r3ph-w7gj-g6xm, where
  maxTotalMergeKeys did not count empty merge sources, so a crafted
  document could keep the loader busy far past the configured limit.
  js-yaml reads the template packs.
- @babel/core moves from 7.28.6 to 7.29.7 to clear GHSA-4x5r-pxfx-6jf8,
  an arbitrary file read through a sourceMappingURL comment. The package
  is only reachable via eslint-plugin-react-hooks and is only ever
  installed for development; the rest of the babel chain and
  browserslist's data packages move with it.


## 4.2.1 — 2026-09-11

Security update; the image rebuilds with the patched packages.

- next moves from 16.3.2 to 16.3.4 to clear GHSA-2xp9-vwfh-vxw4 and
  GHSA-p293-qw3h-jr36, unauthenticated remote code execution in the image
  optimization API. A LAN installation is not exposed to the internet, but
  the fix is a plain patch bump.
- sharp moves from 0.35.3 to 0.35.4 (libvips 1.3.3) to clear
  GHSA-rgj7-g3m4-5g8c in libheif. sharp renders invoice logos for the
  PDF.
- The js-yaml 4.x copy under the eslint chain moves to 4.3.2 to clear
  GHSA-2883-xcg3-v3hh. Development only.


## 4.2.0 — 2026-09-11

Thirty changes ported from upstream Accounted, limited to what a LAN
installation can use. Six new migrations run at the next start.

Fixes:

- Booking templates computed reverse-charge VAT as rate/(1+rate) of the
  total, so 25 % became 20 % on the 2614/2645 pair; the self-assessed VAT
  now goes on top of the base. Account 2012 is not in official BAS: the
  reference drops it and the EF F-skatt template books on 2013, with
  existing template rows moved. Dance admission is 6 % VAT from
  2026-07-01. A company's own account name wins over the BAS reference
  name, and 1580 loses its hardcoded tax-receivable label.
- The KPI monthly breakdown counts reversed originals like the year total
  does, so the months sum to Nettoresultat again, and bar labels no
  longer clip.
- SIE: the upload works in Safari and rejects the wrong file type
  visibly, the preview names the IB debit sum correctly, account creation
  is chunked and the import row closes on every exit, and pre-decoded
  text with CP437 mojibake is caught. A first räkenskapsår may start
  mid-month; opening balances and the period chain only trust
  date-adjacent periods.
- The momsdeklaration seeds its cadence from the configured
  redovisningsperiod on every visit, and a company without tax settings
  is sent to set them up instead of getting a guessed quarterly
  declaration.
- Recurring invoices force 0 % VAT when the company is not VAT
  registered.
- Supplier invoice rows with a negative amount (öresavrundning, rabatt)
  book on the opposite side instead of as negative amounts, and an
  invoice that nets below zero anchors on the debit side. Every write now
  refuses negative-side lines.
- An unpaid invoice can no longer be inserted with remaining_amount 0.
- Every invoice write refuses an article id that belongs to another
  company.
- Archive integrity checks are recorded in their own ledger, so the
  nightly control advances again.
- Customers and suppliers accept 0-day payment terms, and the field says
  why a value is invalid.
- Statutory notices on the invoice PDF follow the document language.
- The verifikat search finds a voucher by its label ("A209", "a 209"),
  with a spinner while searching.
- ContextPicker dropdowns work inside dialogs, and the supplier invoice
  detail tables get a column gutter.
- MCP: query_journal accepts a single account or a number instead of
  silently dropping the filter, and the list tools page past PostgREST's
  1000-row cap.

Features:

- The complete archive (SIE per räkenskapsår, reports, behandlingshistorik
  and every document) can be downloaded from the Exportera tab. It was
  only reachable through the MCP tool before.
- Mina konton: the Verifikat column is a filter, and unused accounts can
  be inactivated in bulk.
- The momsdeklaration shows a banner when the period is already booked.
- The automatic reminder switch is exposed under Fakturering, and the
  invoice page says when reminders are off.
- Recurring schedules take a first invoice date, so a yearly schedule
  bills in the month you choose.
- Nyckeltal lists every month's result and a month-by-month table, with
  a switch in Anpassa.
- MCP create_invoice lines accept an article id, prefilled like the web
  line picker.
- A booked 8999 is listed in Resultatrapport instead of hidden.
- The import tab shows the SIE import history with undo.
- 22 new booking templates: goods and materials, tax and VAT settlements,
  year-end postings.
- Dimension pickers show the value's name after picking, and an unused
  custom dimension can be deleted.
- The verifikat page shows who committed it.


## 4.1.4 — 2026-09-04

Security update from dependabot; nothing in the image changes.

- browserslist moves from 4.28.1 to 4.28.8 to clear GHSA-73wf-gq98-2v4g,
  where a crafted browserslist-stats.json could crash the process or
  write to the prototype. Its data packages (caniuse-lite,
  electron-to-chromium, node-releases) refresh with it. The package is
  build tooling and is only ever installed for development.

## 4.1.3 — 2026-09-04

Security update from dependabot; nothing in the image changes.

- @humanfs/node moves to 0.16.8 to clear GHSA-p498-v437-472g, where the
  recursive copy followed symlinked files outside the source tree. The
  package sits under the eslint chain and is only ever installed for
  development.
- From this release on, every dependabot patch gets a release of its own,
  so that a change that lands is also visible as a version.

## 4.1.2 — 2026-09-01

Dependency refresh from dependabot's monthly sweep; no functional changes.

- Seventeen minor and patch npm updates, among them next and
  eslint-config-next at 16.3.2.
- The pinned node base image digest and the CodeQL actions move along
  with their groups.
- ESLint 10 was proposed and declined again: eslint-plugin-react 7.37.5
  still breaks on it, tracked in jsx-eslint/eslint-plugin-react#3977.

## 4.1.1 — 2026-08-22

Nothing in the image changes; this release only covers the workflows that
build it.

- Every pinned action now comments the exact release its commit belongs to
  rather than the major. A major tag moves, so `# v4` stopped being true the
  moment upstream retagged it, and the workflow audit raised eight
  mismatches for pins nobody had touched.
- Dependabot waits a week before proposing an update. A release that is
  yanked or found compromised is usually pulled well inside that window.
- `docker/setup-buildx-action` moves to v4.3.0, the release the private
  variant already ran: the two repositories share a dependabot config but
  happened to run it a day apart.

## 4.1.0 — 2026-08-21

- Every MCP tool is listed in `tools/list`. Eight tools (update customer,
  update invoice, company settings, invoice deliveries, recurring
  schedules) were marked search-only and left out of the list; Claude
  Desktop only calls tools it received there, so they answered "Tool not
  found" even though the server accepted the call. The full catalog fits
  the context budget with room to spare.
- The user menu shows the running version as its last row. Release images
  carry their tag (`4.1.0`); `:latest` builds from main carry
  `main-<sha>`, so a server can always say which commit it runs.
- The Discord link and the "Kontakta support" dialog are gone from the
  user menu, the mobile nav, the help page, the account danger zone, the
  empty states and the error screens. The dialog mailed upstream's support
  address through an email service a LAN installation never configures.
  The `/api/support/contact` route goes with it.
- The legacy-host redirect in `next.config.ts` is gone; it only ever armed
  on an https host other than app.gnubok.se.

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
