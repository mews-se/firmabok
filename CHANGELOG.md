# Changelog

All notable changes to Firmabok, newest first. Versions follow the
tags in this repository; each one is published as a container image at
`ghcr.io/mews-se/firmabok`.

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
