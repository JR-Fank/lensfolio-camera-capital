# Lensfolio Evidence Import Protocol

## Purpose and safety boundary

This protocol defines the reusable Codex workflow for screenshots of purchases, warehouse receipts, logistics payments, and carrier tracking:

1. Read the evidence without writing data.
2. Normalize every field into the versioned schema.
3. Validate facts, relationships, totals, and duplicate identity.
4. Show a human-readable write preview and every uncertainty.
5. Wait for the user to say exactly `确认录入`.
6. Use the authenticated owner/editor session to call one `SECURITY INVOKER` database transaction.
7. Verify the records and audit entry returned by that transaction.

The canonical machine-readable contract is [`schemas/evidence-import.schema.json`](../../schemas/evidence-import.schema.json). Evidence images and normalized production payloads must stay outside Git.

## Field envelope

Every extracted value uses the same envelope:

```json
{
  "value": "example or null",
  "status": "confirmed",
  "evidence": "short location or label visible in the screenshot"
}
```

- `confirmed`: directly visible or unambiguously established by the supplied evidence.
- `uncertain`: obscured, ambiguous, conflicting, inferred, or not present.
- Information absent from the screenshots is represented as `value: null` with `status: "uncertain"`.
- An uncertain optional value is written as `NULL`, never as its candidate value.
- An uncertain required value is a blocker and prevents the confirmation/write stage.
- `candidates` may list possible readings or matching records, but candidates are never written automatically.

## Purchase evidence

Purchase evidence has one `purchase` object and one or more `assets`. The required source fields are:

- Asset: `brand`, `model`, `serial_number`, `measured_weight_g`, `condition`, `status`, `notes`.
- Purchase: `purchase_date`, `platform`, `seller`, `order_reference`, `purchase_price_jpy`, `actual_paid_cny`, `exchange_rate_jpy_to_cny`, `fee_jpy`, `domestic_shipping_jpy`, `coupon_jpy`, `photo_fee_jpy`.
- Allocation per asset: `purchase_price_jpy`, `allocated_cost_cny`, `allocation_method`.

Required confirmed values for a write are `brand`, `model`, `purchase_date`, `actual_paid_cny`, and every asset's CNY allocation. A single-asset order uses `actual_paid_cny` as its allocation if no separate allocation is supplied. For bundles, every allocation must be explicitly confirmed and their sum must equal the actual CNY payment within ¥0.01.

JPY price and exchange rate are audit details. They never replace or derive `actual_paid_cny`. Missing JPY facts remain `NULL` in purchase tables. `photo_fee_jpy` remains distinct in the normalized payload and audit record; because the current order table has one generic `fee_jpy` column, the stored order fee is `fee_jpy + photo_fee_jpy`, while the evidence audit retains both components. If neither fee is known, the stored fee stays `NULL`.

The transaction creates:

- one `purchase_orders` record;
- one `assets` record per physical camera;
- one `purchase_items` record and one posted purchase `cost_entries` record per asset;
- one `audit_logs` record describing the evidence and affected IDs.

Bundle cameras remain separate assets. A bundle's total weight must never be split into individual `measured_weight_g` values. Missing individual measurements stay `NULL`.

## Logistics evidence

Logistics evidence supports:

- `carrier`, `tracking_number`, `origin`, `destination`, `shipping_date`;
- `bare_weight_g`, `chargeable_weight_g`;
- `shipping_cost_jpy`, `shipping_cost_cny`, `payment_status`, and shipment `status`;
- multiple `associated_assets`;
- zero or more `tracking_events` with raw/standard status, label, location, and occurrence time.

Each associated asset must resolve to exactly one existing record, in this order:

1. exact asset UUID;
2. exact `legacy_id` within the selected portfolio;
3. exact case-insensitive `brand + model` within the selected portfolio.

Zero candidates or multiple candidates stop the import. Codex must ask the user to select an asset and must not guess.

Historical allocation values must be confirmed. For a multi-asset shipment, every allocation is required and must sum to `shipping_cost_cny` within ¥0.01. Allocations are inserted already locked (`allocation_locked_at`, version 1) and cannot be recalculated from later asset weights.

- `payment_status: paid` creates/updates posted international-shipping cost entries.
- `payment_status: pending` or `budget` creates/updates pending entries.
- A posted cost cannot be downgraded to pending by later evidence.
- A shipment without confirmed CNY cost may carry tracking information, but it creates no cost entry and does not infer CNY from JPY.

Tracking data is copied from the screenshot only. The workflow never calls EMS or another carrier.

## Prohibited inference

Codex must not:

- derive individual camera weights from a bundle total;
- derive actual RMB payment from JPY price or an exchange rate;
- infer a serial number from a model;
- infer payment from a logistics or delivery status;
- mark budget or pending shipping as posted;
- choose between ambiguous asset candidates;
- invent carrier events, dates, locations, or source IDs.

## Preview and confirmation gate

Before any write, Codex presents a preview in this form:

```text
准备写入：
Asset: Canon Autoboy S II
Purchase: JPY 22,000; Actual CNY 986
Weight: 551g

将创建：
1 Asset
1 Purchase Order
1 Purchase Item
1 Purchase Cost Entry

不确定字段：none
阻塞项：none
```

If uncertainties exist, they appear explicitly with candidates and evidence location. No database call is allowed until all blockers are resolved and the user replies exactly `确认录入`. The normalized JSON must then contain:

```json
{
  "confirmation": {
    "status": "confirmed",
    "text": "确认录入",
    "confirmed_at": "2026-08-25T00:00:00Z"
  }
}
```

The command line adds a second deliberate gate: both `--apply` and `--confirm-import` are required. Without them, scripts only print a dry-run preview.

## Idempotency

- A canonical SHA-256 hash of the normalized write payload is stored in the audit entry.
- Purchase identity uses a normalized confirmed order reference when present; otherwise it uses the payload hash. It is persisted in `purchase_orders.legacy_id`. Seller/platform changes in a second crop do not duplicate the same confirmed order reference.
- Logistics identity uses a confirmed tracking number when present; otherwise it uses the payload hash. A partial unique index protects non-null `(portfolio_id, tracking_number)` values and `shipments.legacy_id` protects the fallback.
- Shipment items use a deterministic evidence identity and the existing unique `(shipment_id, asset_id)` relation.
- Tracking event identity hashes shipment identity plus raw status, standard status, location, and occurrence time; repeat screenshots therefore do not duplicate events.
- Cost entries use the existing `cost_entries_asset_source_cost_key` constraint.

Concurrent duplicate requests are serialized inside each database transaction. Repeating an already imported purchase returns its existing record IDs. Repeating logistics evidence updates the same shipment, does not change locked allocations, and inserts only new tracking events.

## Audit record

Every successful write inserts an `audit_logs` record containing:

- evidence type;
- import timestamp and authenticated importing user;
- normalized payload SHA-256;
- source screenshot basenames, if supplied;
- affected asset IDs;
- created/updated purchase, shipment, item, event, and cost-entry IDs;
- the normalized database payload used for the transaction.

The screenshot binary is never stored in Git or in `audit_logs`. Source filenames are reduced to basenames by the import scripts.

## Operator commands

The public Supabase URL and publishable key belong in the ignored `.env.local` file. No secret/service key is used.

Authenticate once in the local terminal. The default flow prompts for the existing owner's email and a hidden password; the password is sent directly to official Supabase Auth and is never saved. Projects configured to send an email OTP may use `--otp` instead.

```bash
node scripts/lensfolio-auth.mjs login
node scripts/lensfolio-auth.mjs login --otp
node scripts/lensfolio-auth.mjs status
```

The resulting access and refresh session is stored at `.lensfolio/session.json`, with directory mode `0700` and file mode `0600`. Import scripts load it automatically and refresh expired access tokens through Supabase Auth. A failed refresh asks for a new login; it never falls back to `SUPABASE_SECRET_KEY`. `LENSFOLIO_USER_ACCESS_TOKEN` remains an optional, temporary debugging override only.

The authenticated user must have exactly one owner/editor portfolio, or select one with `--portfolio-id`. Viewer and anonymous sessions are rejected before an RPC call.

```bash
node scripts/import-purchase-evidence.mjs /outside/repo/purchase.json
node scripts/import-purchase-evidence.mjs /outside/repo/purchase.json --apply --confirm-import

node scripts/import-logistics-evidence.mjs /outside/repo/logistics.json
node scripts/import-logistics-evidence.mjs /outside/repo/logistics.json --apply --confirm-import
```

After an apply, rerun the same command with `--verify` to read back the audit and affected records through the same authenticated RLS session.
