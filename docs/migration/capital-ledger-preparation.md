# Capital Ledger migration preparation

Prepared from branch `feat/capital-ledger-design`, reviewed base
`33896ffa3b2aa106e7c655d7c333e948c91670b9`.

## Prepared definitions

The original drafts are retained. `20260905000100` and `20260905000200`
reproduce their SQL bodies, changing only the draft warning and dependency
comment. They follow foundation migration `20260821001900`.

`20260905000300` defines `reconcile_confirmed_capital_source_facts`.
It requires portfolio ID and three explicit evidence timestamps: standalone
Autoboy S II sale, new T2 shipping payment, and TVS II shipping payment. The S II
timestamp must fall on 2026-09-02 in Asia/Shanghai. No exact time is currently
known, so execution remains blocked until evidence supplies it. Shipping payment
times also have no inferred defaults. `now()` is used only for recording metadata
such as allocation locking, never for the sale or payment occurrence time.

The source repair has a fixed asset allowlist. It rejects pre-existing sale or
logistics rows instead of merging ambiguous evidence, verifies purchase baselines
of 4803 and 2533 and standalone S II carrying cost of 1092, and updates only the
standalone S II operational status. Bundle asset
`c916a37b-9ac6-43ff-b97b-577ef9120414` is never a mutation target.
Deterministic IDs, a portfolio advisory lock, row locks, and an audit receipt
make retries return the existing result. Replays with changed arguments or
changed source snapshots fail; they do not rewrite subsequent history.

The new T2 is settled at gross 109 in shipment, locked item allocation, and
original shipping cost. A separate cost reversal of -22 at
2026-09-04 17:40:41+08:00 produces net logistics 87 and carrying cost 4890.
TVS II gross shipping is 132, producing carrying cost 2665. These gross snapshots
are compatible with the semantics of shipping settlement RPC `01700`; that RPC
is not called again on these already-settled records.

The shipment schema has no field accurately representing final packaged order
weight alongside differently dated observations. All three T2 observations stay
in labelled audit evidence: final packaged order 500 g, earlier observation
507 g, and earlier chargeable weight 657 g; volume 3120 cm3 and maximum side
26 cm are also retained there. Bare weight, shipment-item weight snapshot, and
`assets.measured_weight_g` are not populated from these observations.
Shipment status starts as booked; `shipped_at`, `delivered_at`, and tracking
events remain absent because payment evidence does not establish tracking-event
times. T2 tracking is EN537362085JP. TVS II tracking remains unknown.
TVS II evidence preserves 2400 + 150 + 440 = 2990 JPY and the 132 CNY settlement;
the cost is recorded in settled CNY without inventing an exact JPY exchange rate.

`20260905000400` defines `bootstrap_confirmed_capital_funding`. It accepts the
portfolio and an explicit existing T2 Date Back sale ID. It creates stable
accounts `partner_a_capital`, `partner_b_capital`, and `sales_proceeds_pool`,
then sends seven evidence-backed events through the existing funding RPC.
Labels are editable display text, not real-name identity checks. Source repair
and funding bootstrap are separately invoked and each is atomic. Neither is
invoked by a migration file. Both require authenticated owner/editor permission
and execute as the caller, with an empty search path and UTC serialization.

Bootstrap returns row-derived balances and rejects a conflicting initial state:
pool 2673, Partner A 87, Partner B 2665, and realized profit 1356. These constants
are acceptance assertions, not view definitions. Cost and ROI projections
continue to use `cost_entries` and `sales` only. A later bootstrap replay after
unrelated new ledger movements may reject the original totals; this is a
one-time bootstrap, not a recurring synchronization service.

## Verification and application boundary

Required checks are `git diff --check`, `npm run typecheck`, and `npm run lint`.
SQL and PL/pgSQL receive offline parser checks. The test specification in
`tests/capital-ledger-sql.md` includes the source repair and bootstrap cases.
No repair or bootstrap RPC is called during this preparation.

The requested `npx supabase db push --linked --dry-run` was attempted from this
checkout. It failed with `LegacyProjectNotLinkedError`: the checkout has no linked
project reference. No migration plan was returned and no production writes were
performed. The four filenames above are the locally prepared set, not a verified
remote pending-migration list. A correctly linked checkout and a successful
dry-run are required before any application approval; no project is guessed.
