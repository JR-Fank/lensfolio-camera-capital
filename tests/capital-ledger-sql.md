# Capital Ledger SQL migration test specification

## Formal migration preparation additions

For the prepared implementation, use the ordered `supabase/migrations` including
`20260905000100` through `20260905000400`; do not also apply the old drafts.
The original draft-only cases below still specify the core ledger behavior.
The following RPC execution cases are specifications for a separately authorized
disposable database run; no repair RPC is called during migration preparation.

1. Verify source repair and funding bootstrap are SECURITY INVOKER, deny anon
   and service_role execution, require `auth.uid()` and owner/editor membership,
   and reject a viewer or a different portfolio without changing any row.
2. Reject NULL, infinite, or wrong-local-date S II timestamps; reject NULL or
   infinite shipping timestamps and a T2 payment after the known refund. Verify
   no midnight/current-time fallback appears in stored business timestamps.
3. Seed only confirmed baseline purchases and S II carrying cost. Authorize a
   synthetic fixture run with explicitly labelled test timestamps. Verify one
   sale, two shipments, two items, two gross costs, one refund, one S II status
   event, and one source audit receipt. Assert generated sale net proceeds 1288,
   S II profit 196, T2 carrying cost 4890, and TVS II carrying cost 2665.
4. Replay with identical timestamps in another session timezone. Assert the
   same returned IDs and unchanged row counts. Alter one argument or one source
   row after repair and assert replay rejects the conflict atomically.
5. Before repair, separately seed an existing sale, shipment, shipping cost,
   reversal, wrong purchase amount, missing asset, or non-NULL camera measured
   weight. Each must reject without retaining any partial sale/shipping rows.
   In particular, a TVS II conflict must roll back earlier T2 inserts.
6. Assert T2 shipment actual, item snapshot, and gross original cost all equal
   109, with a separate -22 reversal. Verify 500/507/657, 3120 cm3, and 26 cm in
   distinctly named audit fields; both camera measured weights stay NULL.
   TVS II audit evidence must retain all three JPY components totaling 2990.
   Assert no tracking_events are created and the bundle S II row is unchanged.
7. Run funding bootstrap after source repair with an explicit Date Back sale.
   Assert two participants, three stable account codes, seven posted events,
   and the four derived acceptance totals. Replay and verify identical IDs,
   balances and audit counts, including after harmless participant label changes.
8. Reject a conflicting stable account identity, missing source receipt,
   incorrect Date Back sale, missing source cost, and a changed purchase amount.
   Assert bootstrap rollback includes any newly created participant/account rows.
9. Concurrently replay each RPC with identical input: at most one set of source
   and funding rows commits. Exercise concurrent standalone funding operations;
   retry a transaction if PostgreSQL reports a deadlock/serialization failure,
   then verify all invariants and idempotency counts. Do not claim single-session
   tests prove concurrency safety.

## Scope and execution boundary

This is a future migration test plan, not an executable production repair.
Run it only against a disposable database created from the repository's ordered
`supabase/migrations` followed by the two drafts in `docs/migration/drafts`.
Do not connect the harness to the linked production project. Each case must run
in its own transaction and roll back its fixtures.

Use two portfolios and three authenticated fixture users: owner, editor, and
viewer. Set the same JWT claims used by the existing RLS tests. Negative cases
must force deferred checks with `SET CONSTRAINTS ALL IMMEDIATE` before asserting
the SQLSTATE, so a direct write cannot appear to pass merely because the test
has not committed.

## Foundation and migration compatibility

1. Apply every existing repository migration, then draft `00100`, then draft
   `00200`. Assert that creation succeeds without duplicate enum, table, policy,
   index, or constraint names.
2. Before `00100`, assert that `cost_entries_one_reversal_per_entry_idx` and
   `cost_entries_asset_source_cost_key` exist. Afterwards assert that both are
   gone, `cost_entries_nonreversal_source_key` is unique and partial on
   `reversal_of is null and source_id is not null`, and
   `cost_entries_reversal_of_idx` is non-unique.
3. Seed one valid historical posted cost reversal before applying `00100` and
   assert migration succeeds. In separate databases, seed an invalid reversal
   chain and an over-reversed original and assert the preflight aborts without
   partially replacing the old uniqueness rules.
4. Execute `public.settle_shipment_shipping_actual` from migration `01700` on a
   shipment created before the drafts. Assert it still turns exactly one pending
   shipping cost per item into a posted gross cost, retains each locked
   `shipment_items` allocation snapshot, and sets `shipments.actual_paid_cny` to
   the gross payment.

## RLS and cross-portfolio isolation

1. As viewer, select the four ledger tables and four ledger views for the member
   portfolio, and assert rows from the second portfolio are absent.
2. As viewer, assert insert, update, and delete fail. As owner and editor, assert
   permitted writes succeed only when `created_by = auth.uid()` on inserts.
3. Attempt every composite relationship with a parent ID from the second
   portfolio: participant/account, sale, purchase order, purchase item,
   shipment, shipment item, cost entry, original funding transaction, and
   allocation account. Assert foreign-key rejection (`23503`).
4. Assert authenticated users cannot execute the private validation or
   immutability functions directly. Assert the public reconciliation function
   runs as `SECURITY INVOKER`, respects RLS, and cannot see a source row outside
   the caller's portfolio.

## Reconciliation and invariant cases

### Sale proceeds and idempotency

1. Seed one completed sale with `net_proceeds_cny = 6188.00` and an explicit
   `sold_at`. Reconcile it once into the sales proceeds pool. Assert one posted
   transaction, one `+6188.00` allocation, and one audit row.
2. Repeat the RPC with the identical idempotency key and identical arguments.
   Assert the same transaction ID, `idempotent_replay = true`, and no extra
   transaction, allocation, or audit row.
3. Repeat the key with any changed amount, timestamp, evidence ID, note, or
   allocation. Assert `23505` and no mutation.
4. Attempt a second funding transaction for the same sale with a different key.
   Assert the unique sale-evidence index rejects it.

### Pool reinvestment, split funding, and direct contribution

1. Reconcile the new Contax T2 purchase cost of `4803.00` as a
   `purchase_funding` transaction with one `-4803.00` sales-pool allocation.
   Assert the transaction amount equals the absolute allocation total and the
   pool balance falls by `4803.00`.
2. Seed a separate purchase cost and reconcile split funding using a negative
   sales-pool allocation plus a positive participant allocation whose absolute
   values sum exactly to the cost. Assert both account effects and reject a
   split whose absolute total is one cent short or over.
3. Reconcile the TVS II purchase `2533.00` directly to Partner B with a
   `+2533.00` allocation. Assert no sales-pool movement.
4. Directly insert a posted transaction with no allocations, wrong allocation
   total, or invalid account direction, then force deferred constraints.
   Assert `23514` in every case. Repeat by inserting as draft, adding invalid
   allocations, and changing it to posted; assert the same rejection.

### Purchase and shipment relationship checks

1. Point purchase funding at a purchase item from another order, an unrelated
   asset cost, a non-purchase cost, a pending cost, or an amount different from
   `purchase_items.allocated_cost_cny`. Assert `23514` after deferred checks.
2. Point shipping funding at an item from another shipment, an unrelated asset
   cost, a non-`shipment_item` source, an unlocked item, or a cancelled
   shipment. Assert `23514`.
3. After valid shipping funding exists, attempt a direct insert, move, or delete
   of a shipment item or gross shipping cost that would break the shipment-wide
   one-cost-per-item count or gross sum. Force deferred checks and assert
   rejection. This verifies sibling-row inserts cannot bypass the invariant.

### Partial refund and multiple reversals

1. Settle the new T2 shipment at gross `109.00`, leaving the locked shipment-item
   allocation snapshot intact and setting `shipments.actual_paid_cny = 109.00`.
   Reconcile its original posted `+109.00` shipping cost to Partner A.
2. Insert a posted cost reversal of `-22.00` at
   `2026-09-04 17:40:41+08:00`, then reconcile a `refund` of `22.00` with a
   `-22.00` Partner A allocation and `reversal_of` the original funding
   transaction. Assert the original cost remains `+109.00`, net posted shipping
   cost is `87.00`, and Partner A net contribution is `87.00`.
3. In an independent fixture, add a second valid partial cost reversal and
   matching funding refund against the same originals. Assert both rows coexist
   and transaction/account remaining amounts equal the original less both
   partial reversals.
4. Attempt another partial reversal that makes either the cost total, funding
   transaction total, or per-account reversed allocation exceed the original.
   Force deferred constraints and assert `23514`.
5. Attempt a cost reversal of a cost reversal and a funding reversal/refund of a
   refund or reversal. Assert `23514`.
6. Link a refund transaction to a positive cost, a pending reversal, a reversal
   with a mismatched source, a different original funding cost, or a timestamp
   different from the cost reversal. Assert `23514`.
7. Use two concurrent sessions to post partial reversals whose combined amount
   exceeds the original. Assert the original-row lock serializes them and only
   one transaction can commit; verify the aggregate is not inflated by joins.

### Posted immutability

1. Update and delete every material field of a posted funding transaction.
   Assert `55000` and unchanged row data.
2. Insert, update, or delete an allocation belonging to a posted transaction.
   Assert `55000`.
3. Change the identity or delete a funded account. Assert `55000`; closing the
   account remains allowed, and a transaction posted at or after `closed_at` is
   rejected by the deferred validator.
4. Assert draft and void transactions never affect any balance view.

## Confirmed Lensfolio reconciliation fixture

The fixture IDs must be resolved from evidence rows; only confirmed asset IDs
are fixed here. Do not create production-like timestamps where evidence is
unknown.

### New Contax T2

- Asset: `99d47bd7-4990-4a55-bbeb-eebea4ef2ca4`.
- Purchase cost: posted `4803.00`; funding allocation: sales pool `-4803.00`.
- Shipment: Japan Post EMS, tracking `EN537362085JP`.
- Gross settlement: `shipments.actual_paid_cny = 109.00`, one locked item, and
  one original posted shipping cost of `+109.00`.
- Refund evidence: separate posted cost reversal `-22.00`; net logistics from
  `cost_entries` is `87.00`; total carrying cost is `4890.00`.
- Funding evidence: Partner A `+109.00` followed by `-22.00`; net contribution
  from allocations is `87.00`.
- The settlement evidence payload carries final packaged order weight `500 g`.
  The earlier `507 g` observation remains separately labelled evidence and is
  not written to `shipments.bare_weight_g`; the earlier chargeable-weight
  evidence remains `657 g` in its chargeable/evidence context. None may replace
  another, and `assets.measured_weight_g` must remain `NULL`.
- Assert the locked shipment-item amount and shipment actual remain gross
  `109.00`; the `-22.00` cost reversal, not a rewrite to `87.00`, produces the
  net carrying cost.

### Contax TVS II

- Asset: `5dc2aac1-cea2-445c-ab4d-646bf2a27489`.
- Posted purchase cost and Partner B allocation: `2533.00`.
- Gross EMS settlement, original shipping cost, and Partner B allocation:
  `132.00` each.
- Assert one-to-one shipment/item/cost reconciliation, Partner B net
  contribution `2665.00`, carrying cost `2665.00`, no sales-pool movement, and
  `assets.measured_weight_g is null`.

### Canon Autoboy S II one-time sale repair

- Target only asset `a847b8d7-a50d-4bdd-bdf7-2258dda5f679`; record net proceeds
  `1288.00` and preserve carrying cost `1092.00`.
- Assert the RPC rejects `p_occurred_at is null` and rejects any timestamp that
  does not exactly equal `sales.sold_at`. The known date `2026-09-02` alone is
  insufficient; the test must not invent midnight or another fixed time.
- Once an explicit evidenced `sold_at` is supplied, assert one sales-pool
  allocation of `+1288.00` and realized profit `196.00` from `asset_financials`.
- Attempt a second completed sale for the same asset and assert the existing
  `sales_one_completed_sale_per_asset_idx` rejects it. Attempt a second funding
  import for the same sale and assert the ledger unique index rejects it.
- Snapshot the bundle-purchased Autoboy S II before the case and assert no sale,
  cost, status, or funding row for that other asset changes.

## Final derived assertions

Query bottom-up after all confirmed fixtures are posted:

1. `sales_proceeds_pool_balances.balance_cny = 6188 - 4803 + 1288 = 2673`.
2. `funding_participant_contributions.net_contribution_cny = 87` for Partner A.
3. The same view returns `2665` for Partner B (`2533 + 132`).
4. `asset_financials` returns `4890` carrying cost for the new T2 and `2665` for
   TVS II. No funding table or funding view is referenced by that calculation.
5. Sum realized profit from the two completed sale evidence rows and their
   `cost_entries`: `1160 + 196 = 1356`. Assert no view contains `1356` or `2673`
   as a literal constant.
6. Run all four balance views after two partial reversals and independently sum
   signed posted allocations. Assert equality and no fan-out multiplication.
7. Repeat every reconciliation RPC call with its original idempotency key and
   assert all balances, row counts, source evidence, and audit counts remain
   unchanged.
