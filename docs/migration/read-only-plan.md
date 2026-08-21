# Legacy Site read-only protection

## Goal

Keep the current Lensfolio Site available as a trustworthy rollback surface
while preventing all production D1 mutations during migration. The protection
code is implemented on `migration/supabase-vercel`, but has not been deployed
and no production environment value or access policy has been changed.

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

## How writes are closed

The server-side `MIGRATION_READ_ONLY` switch is authoritative. It is disabled
when unset or set to `false`, and enabled only when its normalized value is
`true`.

When enabled:

1. Every mutation route rejects the request before parsing its body or opening
   a D1 write operation. The response is HTTP `423 Locked` with
   `{ "error": "System is under migration protection." }`.
2. Mutation forms and add, edit and delete controls are hidden so the UI does
   not offer actions that the server will reject. The current application has
   no delete controls or delete API routes.
3. Read-only GET pages and dashboard queries remain available.
4. The server-side guard remains authoritative; hiding controls is not a
   security boundary.
5. When protection is disabled, write routes still require both authenticated
   user headers; anonymous writes receive HTTP `401 Unauthorized`.
6. The legacy Site access policy should be changed from public to custom,
   owner-only access before the freeze backup is taken.

If limited maintenance writes are ever required, temporarily disabling the
switch must be approved, time-bounded and followed by a new D1 backup. Owner
authentication alone is not sufficient for a migration freeze.

## How to stop logistics refreshes

When `MIGRATION_READ_ONLY` is enabled:

1. `POST /api/logistics/refresh` returns HTTP 423 before fetching or writing
   tracking events.
2. `POST /api/logistics/refresh-due` returns HTTP 423 before scanning or
   updating logistics orders.
3. The client-side automatic call to `/api/logistics/refresh-due` is skipped.
4. The scheduled Worker handler checks the same switch before calling
   `refreshDueTracking`.
5. Manual refresh buttons are hidden.

The freeze verification must compare D1 row counts and latest `updated_at`
values before and after at least one normal page view and one scheduled-refresh
interval. No value may change.

## Activation runbook

1. Confirm Git tag `sites/v3-pre-migration` and a private remote backup exist.
2. Restrict the Site access policy to owner-only.
3. Set `MIGRATION_READ_ONLY=true` in the hosted environment for the reviewed
   protection version.
4. Deploy the reviewed protection version with that environment value.
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
3. Set `MIGRATION_READ_ONLY=false` (or remove the variable) only after the
   database and application version are confirmed compatible, then redeploy
   the same reviewed version.
4. Restore the scheduled logistics refresh and the client refresh only after
   mutation routes are authorized and tested.
5. Keep the Site owner-only until the migration incident or rollback is closed.
6. Recheck record counts, foreign keys and financial reconciliations.

Do not delete the legacy Site, its D1 database, its Sites versions or its Git
tags during the rollback window.
