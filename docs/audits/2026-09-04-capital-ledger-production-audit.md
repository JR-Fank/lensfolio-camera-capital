# Capital Ledger Production Audit

Status: confirmed facts recorded; production mutation not performed
Audit date: 2026-09-04
Branch: `feat/capital-ledger-design`

## Scope and evidence boundary

This document records the confirmed production facts supplied for the Capital
Ledger handoff. No production database write, migration push, deployment, or
`main` merge was performed as part of this audit. Exact event times are only
recorded when they are known; an unknown timestamp is not inferred.

The two requested SQL draft files were not present in the local repository at
handoff time, so this branch does not attempt to recreate their missing
contents:

- `docs/migration/drafts/20260904000100_create_capital_ledger.sql`
- `docs/migration/drafts/20260904000200_create_capital_reconciliation_rpc.sql`

## Confirmed financial results

| Item | Net proceeds | Carrying cost | Realized profit |
| --- | ---: | ---: | ---: |
| Contax T2 Date Back | ¥6,188 | ¥5,028 | +¥1,160 |
| Canon Autoboy S II, asset `a847b8d7-a50d-4bdd-bdf7-2258dda5f679` | ¥1,288 | ¥1,092 | +¥196 |
| **Cumulative realized profit** |  |  | **+¥1,356** |

The Canon sale occurred on 2026-09-02. Its precise transaction time is
unknown and must remain unset until evidence establishes it. This sale applies
only to the independently purchased Canon Autoboy S II. The other Autoboy S II
acquired in the bundle is not changed.

## Confirmed acquisition and logistics facts

### New Contax T2

- Asset: `99d47bd7-4990-4a55-bbeb-eebea4ef2ca4`
- Purchase cost: ¥4,803, funded from the sales proceeds pool
- Carrier: Japan Post EMS
- Tracking number: `EN537362085JP`
- Gross shipping payment: ¥109
- Refund: ¥22 at `2026-09-04 17:40:41 +08:00`
- Net shipping cost: ¥87
- Correct carrying cost: ¥4,890
- Early weight evidence: 507 g
- Early chargeable weight: 657 g
- Final shipment order weight including packaging: 500 g
- Volume: 3,120 cm3
- Maximum side: 26 cm
- `assets.measured_weight_g`: remains `NULL`
- Partner A logistics contribution: ¥109 gross and ¥87 net after refund

The shipping refund is a partial reversal. It does not erase or rewrite the
gross payment. The cost ledger must preserve both the ¥109 original entry and
the ¥22 reversing entry so the net posted logistics cost is ¥87.

### Contax TVS II

- Asset: `5dc2aac1-cea2-445c-ab4d-646bf2a27489`
- Purchase cost: ¥2,533
- Carrier: Japan Post EMS
- Shipping cost: ¥132
- Correct carrying cost: ¥2,665
- Partner B funded the ¥2,533 purchase and ¥132 shipping
- Partner B net contribution: ¥2,665
- `assets.measured_weight_g`: remains `NULL`

## Sales proceeds pool reconciliation

| Movement | Amount |
| --- | ---: |
| T2 Date Back sale proceeds | +¥6,188 |
| New Contax T2 purchase | -¥4,803 |
| Independent Autoboy S II sale proceeds | +¥1,288 |
| **Confirmed pool balance** | **¥2,673** |

Partner A's logistics payment and Partner B's direct purchase and logistics
payments are capital funding facts, not sales proceeds pool movements.

## Audit conclusions

1. The sales proceeds pool is a cash-source balance and is not a profit pool.
2. `cost_entries` remains the sole financial source of truth for asset carrying
   cost. Capital Ledger rows must not be included in carrying-cost or ROI
   calculations.
3. Capital Ledger records where funds came from and where they went. It does
   not replace sales, purchase, shipment, or cost evidence.
4. The current schema has no durable representation for Partner A, Partner B,
   their net contributions, or the sales proceeds pool. The architecture in
   `docs/architecture/capital-ledger.md` closes that gap without changing the
   meaning of existing financial tables.
5. Reconciliation must be idempotent, portfolio-scoped, and reversal-aware
   before any production mutation is considered.
