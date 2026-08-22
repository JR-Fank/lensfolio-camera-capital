# Cost Ledger Migration Plan

Status: Phase 3C-1 preparation only
Prepared: 2026-08-22
Production writes performed: none

## Purpose and grain

`cost_entries` is the append-oriented financial ledger for Lensfolio. Each
source allocation row produces one cost entry for one asset. The planned first
generation therefore has this grain:

- one purchase entry per `purchase_items` row;
- one logistics entry per `shipment_items` row;
- no repair, valuation, sale, manual adjustment, or reversal entries in this
  phase.

Expected generation size: 10 rows (5 purchase + 5 logistics).

## Schema review

The current `public.cost_entries` table supports the required fields:

| Field | PostgreSQL type | Required |
| --- | --- | --- |
| `asset_id` | `uuid` | yes |
| `cost_type` | `public.cost_type` | yes |
| `source_type` | `public.cost_source_type` | yes |
| `source_id` | `uuid` | no |
| `original_amount` | `numeric(20,6)` | yes |
| `currency` | `text` | yes |
| `fx_rate_to_cny` | `numeric(20,10)` | yes |
| `amount_cny` | `numeric(20,2)` | yes |
| `entry_status` | `public.cost_entry_status` | yes |
| `occurred_at` | `timestamptz` | yes |
| `reversal_of` | `uuid` | no |

Amounts use PostgreSQL `numeric`; no ledger amount uses `float`, `real`, or
`double precision`. Event times use `timestamptz`.

The table enforces the asset/portfolio relationship, ISO-like currency codes,
positive FX rates, and reversal shape. A reversal must reference an entry for
the same portfolio and asset, and only one reversal may reference an entry.

### Cost types

Current `public.cost_type` values:

- `purchase`
- `domestic_shipping`
- `international_shipping`
- `repair`
- `other`
- `adjustment`
- `reversal`

`purchase`, `repair`, `other`, `adjustment`, and `reversal` are directly
supported. The literal value `logistics` is **not** supported. The existing
`asset_financials` view classifies `domestic_shipping` and
`international_shipping` as logistics cost.

For the frozen Japan-to-Hong Kong shipments, the recommended schema-compatible
mapping is `cost_type = 'international_shipping'`. If the business requires the
literal value `logistics`, a new migration must first add it to the enum and
update `asset_financials`; the import must not use an unsupported value or place
logistics under `other`.

Current `public.cost_source_type` already supports `purchase_item` and
`shipment_item`. Current entry statuses are `pending`, `posted`, and `void`.

## Source mapping

### Purchase entries

| Target field | Source/rule |
| --- | --- |
| `asset_id` | `purchase_items.asset_id` |
| `cost_type` | `purchase` |
| `source_type` | `purchase_item` |
| `source_id` | `purchase_items.id` |
| `original_amount` | `purchase_items.allocated_cost_cny` |
| `currency` | `CNY` |
| `fx_rate_to_cny` | `1` |
| `amount_cny` | `purchase_items.allocated_cost_cny` |
| `entry_status` | `posted` |
| `occurred_at` | parent `purchase_orders.ordered_at` |
| `reversal_of` | `NULL` |

The ledger uses the allocated CNY fact as both original and converted amount.
It does not derive a synthetic item-level JPY FX rate from order discounts and
fees. Original JPY facts remain authoritative in the purchase tables.

### Logistics entries

| Target field | Source/rule |
| --- | --- |
| `asset_id` | `shipment_items.asset_id` |
| `cost_type` | `international_shipping` (pending approval) |
| `source_type` | `shipment_item` |
| `source_id` | `shipment_items.id` |
| `original_amount` | `shipment_items.allocated_shipping_cny` |
| `currency` | `CNY` |
| `fx_rate_to_cny` | `1` |
| `amount_cny` | `shipment_items.allocated_shipping_cny` |
| `entry_status` | `posted` for actual-paid shipment; `pending` for budget shipment |
| `occurred_at` | `shipments.shipped_at` when present; otherwise `shipments.created_at` for the pending budget entry |
| `reversal_of` | `NULL` |

This mapping copies the frozen allocation amount. It does not recompute cost
from current asset weight, shipment ratio, or chargeable weight.

## Source relation and provenance

Every generated entry must join to a source row in the same portfolio:

- `(portfolio_id, source_type = 'purchase_item', source_id)` identifies one
  `purchase_items` row;
- `(portfolio_id, source_type = 'shipment_item', source_id)` identifies one
  `shipment_items` row.

`source_id` is a polymorphic UUID and has no database foreign key to the source
tables. The generator must therefore preflight and postflight source existence,
asset equality, portfolio equality, and source type.

The current schema also has no unique constraint on
`(portfolio_id, source_type, source_id)`. Before formal generation, choose one
of these controls:

1. Recommended: add a partial unique index for non-reversal, non-null source
   rows; or
2. Require deterministic entry UUIDs plus strict preflight/postflight checks in
   the one-time import script.

No production generation should proceed without one of these idempotency
controls.

## Canon bundle treatment

The two Canon bundle components remain separate assets and keep their imported
legacy facts:

| Asset legacy ID | Purchase | Logistics | Ledger total | Provenance |
| --- | ---: | ---: | ---: | --- |
| `canon-autoboy-s-set` | 603 | 66 | 669 | purchase `legacy_equal_allocation`; logistics locked weight snapshot |
| `canon-autoboy-sii-set` | 603 | 66 | 669 | purchase `legacy_equal_allocation`; logistics locked weight snapshot |

The CNY 603 values are legacy equal allocations of one bundle order, not
independent market purchase prices. The generator must not alter either value.
The CNY 66 logistics values are frozen source allocations and must not be
recalculated from current asset weight.

## Financial verification rules

Expected source and ledger amounts:

| Asset | Purchase | Logistics | All-entry total | Initially posted total |
| --- | ---: | ---: | ---: | ---: |
| Canon Autoboy S II | 986 | 106 | 1,092 | 1,092 |
| Contax T2 Date Back | 4,913 | 115 | 5,028 | 5,028 |
| Nikon 28Ti | 6,505 | 98 | 6,603 | 6,505 |
| Canon Autoboy S bundle component | 603 | 66 | 669 | 603 |
| Canon Autoboy S II bundle component | 603 | 66 | 669 | 603 |
| **Total** | **13,610** | **451** | **14,061** | **13,831** |

The CNY 230 difference between all-entry total and initially posted total is
the budget shipment. Its three entries (98 + 66 + 66) remain in the ledger as
`pending` until actual payment is confirmed. This preserves both verified
baselines:

- all purchase and logistics source allocations: CNY 14,061;
- Dashboard invested / posted carrying cost: CNY 13,831.

Required verification after a future generation:

1. `cost_entries` has 10 generated source rows: 5 purchase and 5 logistics.
2. Purchase amount sum is CNY 13,610.
3. Logistics amount sum is CNY 451: CNY 221 posted and CNY 230 pending.
4. Posted total carrying cost is CNY 13,831.
5. All-entry amount is CNY 14,061.
6. Every entry has the same portfolio and asset as its source allocation.
7. No duplicate source relation or deterministic entry ID exists.
8. No entry uses `real`, `float`, or `double precision` arithmetic.
9. `asset_financials` reports purchase and posted logistics separately and
   continues to calculate ROI as profit divided by total carrying cost.
10. Repairs, valuations, and sales remain unchanged during ledger generation.

All monetary comparisons use an allowed difference of at most CNY 0.01.

## Audit and rollback strategy

The future generator should run in one transaction and record:

- `migration_run_id`;
- source backup name and manifest SHA-256;
- before/after entry counts;
- purchase, actual-logistics, budget-logistics, posted, and all-entry totals;
- deterministic source-to-entry mapping.

Before later financial phases begin, rollback may delete only the exact entries
created by that migration run, identified by deterministic IDs and verified
source relations. Rollback must refuse when:

- an entry has a reversal;
- an unrelated/manual ledger row exists in the target set;
- repairs, valuations, or sales have been migrated and depend on the ledger;
- source or portfolio relationships no longer match the recorded audit.

After the ledger becomes operational, corrections should use reversal entries
rather than destructive deletion.

## Phase 3C-2 entry gates

Formal generation is blocked until both decisions are recorded:

1. Approve `international_shipping` as the cost type for these two shipments,
   or authorize a migration adding literal `logistics` and updating the views.
2. Approve a database unique source index or deterministic-ID-only idempotency
   strategy.

Until then, `cost_entries` must remain empty.
