# Capital Funding Facts

Status: confirmed project facts
As of: 2026-09-04

This file is the durable handoff for confirmed capital-funding facts. It is not
an executable migration and contains no payment-account credentials.

## Realized sales

### Contax T2 Date Back

- Sale net proceeds: ¥6,188
- Carrying cost: ¥5,028
- Realized profit: +¥1,160
- Funding destination: sales proceeds pool

### Independently purchased Canon Autoboy S II

- Asset ID: `a847b8d7-a50d-4bdd-bdf7-2258dda5f679`
- Sold date: 2026-09-02
- Exact sale time: unknown; do not infer
- Actual amount received: ¥1,288
- Carrying cost: ¥1,092
- Realized profit: +¥196
- Funding destination: sales proceeds pool
- Bundle-purchased Autoboy S II: unchanged

### Cumulative result

`¥1,160 + ¥196 = ¥1,356` cumulative realized profit.

## New Contax T2

- Asset ID: `99d47bd7-4990-4a55-bbeb-eebea4ef2ca4`
- Purchase: ¥4,803 from the sales proceeds pool
- Carrier: Japan Post EMS
- Tracking: `EN537362085JP`
- Gross shipping payment: ¥109
- Refund: ¥22 at `2026-09-04 17:40:41 +08:00`
- Net shipping cost: `¥109 - ¥22 = ¥87`
- Correct carrying cost: `¥4,803 + ¥87 = ¥4,890`
- Partner A gross logistics contribution: ¥109
- Partner A net contribution after refund: ¥87
- Early weight evidence: 507 g
- Early chargeable weight: 657 g
- Final shipment order weight including packaging: 500 g
- Volume: 3,120 cm3
- Maximum side: 26 cm
- `assets.measured_weight_g`: must remain `NULL`

The three weight values have different evidence meanings and must not overwrite
one another. None is a confirmed bare-camera measurement.

## Contax TVS II

- Asset ID: `5dc2aac1-cea2-445c-ab4d-646bf2a27489`
- Purchase: ¥2,533, paid by Partner B
- Carrier: Japan Post EMS
- Shipping: ¥132, paid by Partner B
- Correct carrying cost: `¥2,533 + ¥132 = ¥2,665`
- Partner B net contribution: ¥2,665
- `assets.measured_weight_g`: must remain `NULL`

## Sales proceeds pool

| Event | Movement | Running balance |
| --- | ---: | ---: |
| T2 Date Back sale | +¥6,188 | ¥6,188 |
| New Contax T2 purchase | -¥4,803 | ¥1,385 |
| Independent Autoboy S II sale | +¥1,288 | ¥2,673 |

Confirmed pool balance: **¥2,673**.

Partner-funded direct payments are not silently included in this pool. The
sales proceeds pool is not a profit pool: it holds cash proceeds and can fund
later uses, while realized profit remains the difference between sale net
proceeds and the asset's carrying cost.

## System boundaries

- `cost_entries` is the sole financial source of truth for asset cost.
- Capital Ledger records funding source and destination only.
- Sales proceeds, carrying cost, realized profit, capital contribution, and
  available pool cash remain distinct concepts.
- Corrections are appended as reversals; confirmed history is not overwritten.
- No secret, token, cookie, environment value, or payment-account identifier
  belongs in these project-state records.
