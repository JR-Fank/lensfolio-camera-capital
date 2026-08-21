# Legacy Site read-only plan

## Goal

Keep the current Lensfolio Site available as a trustworthy rollback surface
while preventing all production D1 mutations during migration. This document
is a plan only; no production access policy, environment value, route or Worker
has been changed yet.

## Current write paths

The following paths can mutate D1:

- `POST /api/cameras`
- `PATCH /api/cameras`
- `POST /api/logistics`
- `POST /api/logistics/refresh`
- `POST /api/logistics/refresh-due`
- `POST /api/repairs`
- `POST /api/expenses`
- `POST /api/valuations`
- `POST /api/sales`
- The scheduled handler in `worker/index.ts`
- The automatic logistics refresh initiated by `app/ManagementApp.tsx`

Changing the Site from public to owner-only limits who can call these paths,
but does not make the application read-only. An owner page view can still
trigger the automatic logistics refresh, and the scheduled Worker can still
write without a browser request.

## How to close writes

Introduce a server-side `MIGRATION_READ_ONLY` switch in a dedicated protection
change after approval.

When enabled:

1. Every mutation route must reject the request before opening a D1 write
   operation. Use one consistent response such as HTTP `423 Locked` and a
   migration-read-only error body.
2. Mutation forms and controls should be disabled or hidden so the UI does not
   offer actions that the server will reject.
3. Read-only GET pages and dashboard queries remain available.
4. The server-side guard remains authoritative; hiding controls is not a
   security boundary.
5. The legacy Site access policy should be changed from public to custom,
   owner-only access before the freeze backup is taken.

If limited maintenance writes are ever required, temporarily disabling the
switch must be approved, time-bounded and followed by a new D1 backup. Owner
authentication alone is not sufficient for a migration freeze.

## How to stop logistics refreshes

When `MIGRATION_READ_ONLY` is enabled:

1. `POST /api/logistics/refresh` must return without fetching or writing
   tracking events.
2. `POST /api/logistics/refresh-due` must return without scanning or updating
   logistics orders.
3. The client-side automatic call to `/api/logistics/refresh-due` must be
   skipped.
4. The scheduled Worker handler must check the same switch before calling
   `refreshDueTracking`.
5. Manual refresh buttons must be disabled.

The freeze verification must compare D1 row counts and latest `updated_at`
values before and after at least one normal page view and one scheduled-refresh
interval. No value may change.

## Activation runbook

1. Confirm Git tag `sites/v3-pre-migration` and a private remote backup exist.
2. Restrict the Site access policy to owner-only.
3. Deploy the reviewed protection version with the read-only guard.
4. Set `MIGRATION_READ_ONLY=true` in the hosted environment.
5. Verify every POST/PATCH route is rejected.
6. Verify page loads do not update logistics records.
7. Verify the scheduled handler performs no database mutation.
8. Take and validate the production D1 backup.

## Recovery and unfreeze

To resume the legacy application:

1. Confirm whether the current D1 database is intact. If not, restore the
   verified backup into an isolated database and validate it before cutover.
2. Re-deploy Sites version 3 or check out `sites/v3-pre-migration` if the
   protection release itself must be removed.
3. Disable `MIGRATION_READ_ONLY` only after the database and application
   version are confirmed compatible.
4. Restore the scheduled logistics refresh and the client refresh only after
   mutation routes are authorized and tested.
5. Keep the Site owner-only until the migration incident or rollback is closed.
6. Recheck record counts, foreign keys and financial reconciliations.

Do not delete the legacy Site, its D1 database, its Sites versions or its Git
tags during the rollback window.
