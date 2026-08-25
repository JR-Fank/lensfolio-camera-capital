# Lensfolio migration plan

## Purpose and scope

This document records the production baseline and the safety boundaries for the
planned Supabase and Vercel migration. It does not authorize a framework
rewrite, database migration, production export, deployment, or removal of the
current Sites application.

Baseline:

- Source repository: `<repo-root>`
- Production commit: `8c93905a4a1e2b7d51657f74491efa99ae461bf7`
- Production tag: `sites/v3-pre-migration`
- Migration branch: `migration/supabase-vercel`
- Production Sites version: 3

## Current architecture

- Frontend: vinext `1.0.0-beta.2`, Vite, React 19, TypeScript and Tailwind CSS 4
- Server runtime: Cloudflare Worker through OpenAI Sites
- Database: Cloudflare D1/SQLite bound as `DB`
- Database access: Drizzle schema plus prepared D1 SQL queries
- Authentication: ChatGPT auth helper exists, but current pages and mutation
  routes do not enforce authentication or authorization
- Storage: R2 is not enabled and there are no application-managed uploads
- Scheduled work: the Worker refreshes due Japan Post tracking records daily
- Deployment: OpenAI Sites; the current production Site remains the rollback
  environment during migration

## Current data sources

The live Sites-managed D1 database is the production source of truth. The
ignored `.wrangler/` SQLite database is a local development copy and must not be
treated as the production backup. The `drizzle/` SQL files contain the schema
and initial business records; migration `0000_useful_longshot.sql` mixes DDL and
seed data, so it cannot be used as a schema-only restore file without filtering.

Production baseline:

| Domain | D1 tables | Records |
| --- | --- | ---: |
| Assets | `cameras` | 5 |
| Purchase | `purchase_orders`, `purchase_order_items` | 4 orders / 5 items |
| Logistics | `logistics_orders`, `logistics_items`, `logistics_events` | 2 batches / 5 items / 7 events |
| Repairs | `repair_records` | 0 |
| Market valuation | `market_valuations` | 5 |
| Sales | `sales_records` | 0 |
| Other asset costs | `asset_expenses` | 0 |

Reconciliation baseline:

- Purchase paid and allocated totals: CNY 13,610 / CNY 13,610
- Logistics charged and allocated totals: CNY 451 / CNY 451
- Expected market value total: CNY 17,250
- Duplicate primary keys: 0
- Orphaned foreign-key references: 0

## Migration target

- Frontend and server: native Next.js, React, TypeScript and Tailwind CSS
- Database: Supabase PostgreSQL
- Authentication: Supabase Auth with explicit record ownership and Row Level
  Security
- Object storage: Supabase Storage when an actual upload workflow is introduced
- Deployment: Vercel

The migration must preserve the current routes, calculations, record IDs or a
documented legacy-ID mapping, monetary totals, relational links and rollback
capability. No new product feature belongs in the migration critical path.

## Freeze and backup gates

Before any production data export or migration begins:

1. Push the unchanged production history and migration branch to a private,
   user-controlled Git remote.
2. Restrict the legacy Site to its owner.
3. Deploy and verify the read-only controls described in
   `docs/migration/read-only-plan.md`.
4. Confirm that browser-triggered and scheduled logistics refreshes cannot
   write to D1.
5. Export the D1 schema and all domain tables into a timestamped backup.
6. Record row counts, reconciliation totals, Git SHA, Sites version and file
   checksums in the backup manifest.
7. Restore the backup into an isolated database and rerun the integrity checks.

## Planned migration sequence

1. Freeze and back up the legacy production environment.
2. Define the PostgreSQL schema, ownership model, constraints and RLS policies.
3. Export D1 records without changing D1.
4. Transform and import records into an isolated Supabase environment.
5. Verify counts, relationships, monetary totals and representative asset
   histories.
6. Migrate reads, then writes, while keeping the old Site unchanged and
   available for rollback.
7. Deploy the validated Next.js application to Vercel.
8. Keep the legacy Site owner-only and read-only through the rollback window.

## Rollback plan

Code rollback and data rollback are separate operations.

### Code rollback

- Re-deploy OpenAI Sites version 3 or the Git tag
  `sites/v3-pre-migration`.
- Verify the deployed commit remains
  `8c93905a4a1e2b7d51657f74491efa99ae461bf7`.
- Keep all prior Sites versions and Git commits; do not rewrite or delete them.

### Data rollback

- Do not modify or delete the legacy D1 database during the migration and
  rollback window.
- Restore a damaged database only from a verified, timestamped backup into an
  isolated database first.
- Apply a schema-only DDL export, then import tables in dependency order:
  assets, purchase, logistics, repairs, valuations, sales and expenses.
- Reconcile counts, foreign keys, purchase allocations, logistics allocations
  and market totals before reconnecting an application.

Rolling a Site version back does not roll D1 data back. A valid D1 backup is
therefore mandatory before any production migration.
