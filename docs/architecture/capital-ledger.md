# Capital Ledger Architecture

Status: approved design boundary; SQL drafts pending recovery or separate review
Last updated: 2026-09-04

## Purpose

Capital Ledger records the source and destination of portfolio funding. It
answers questions such as:

- how much Partner A or Partner B funded;
- which purchase or logistics payment used those funds;
- how much cash remains in the sales proceeds pool; and
- how refunds and other partial reversals change net funding.

It is not a replacement for operational or financial evidence. Sales remain in
`sales`, purchase and shipment facts remain in their source tables, and
`cost_entries` remains the sole financial source of truth for asset carrying
cost. Capital Ledger balances must never be added to carrying cost or treated as
profit.

## Core model

The design uses four portfolio-scoped relations.

### `funding_participants`

Represents an economic funding participant, independently of application
authorization. Partner A and Partner B are participants. A participant may be
linked to a user profile, but that link does not determine access rights or
financial ownership.

Required invariants:

- every participant belongs to exactly one portfolio;
- display labels are nonblank and unique within the portfolio while active;
- an optional user link must not cross the portfolio boundary; and
- deactivation preserves all historical transactions.

### `funding_accounts`

Represents a named funding source or controlled pool. The initial accounts are
Partner A capital, Partner B capital, and the sales proceeds pool.

Required invariants:

- every account belongs to exactly one portfolio;
- participant capital accounts reference a participant in the same portfolio;
- shared pool accounts do not impersonate a participant;
- account currency is CNY for the current portfolio; and
- closing an account prevents new allocations but preserves history.

### `funding_transactions`

Represents one immutable funding event. Examples include a sale receipt, a
purchase payment, a logistics payment, a refund, and a reversal. A transaction
stores the business event type, occurrence time, evidence reference,
idempotency key, and optional reversal relationship.

Required invariants:

- monetary amounts use `numeric`, never floating-point types;
- every transaction belongs to one portfolio and all referenced records must
  belong to that portfolio;
- business evidence is identified by a stable source type and source ID;
- a source event cannot be imported twice under the same semantic role;
- posted transactions are immutable; corrections use reversal transactions;
- reversals reference an earlier posted transaction in the same portfolio;
- multiple partial reversals of one original transaction are allowed;
- cumulative posted reversals cannot exceed the original amount; and
- a reversal cannot itself be reversed through an ambiguous chain.

No unique constraint may enforce one reversal per original transaction. The
partial-reversal cap and direction must instead be enforced transactionally by
the reconciliation RPC and a database constraint trigger.

### `funding_allocations`

Assigns a transaction amount to one or more funding accounts. Allocations make
split funding explicit and allow the same event to be attributed to multiple
participants without duplicating the business event.

Required invariants:

- transaction and account share the same `portfolio_id`;
- allocation amounts are nonzero `numeric` CNY values;
- allocation direction is valid for the transaction type;
- the allocation total reconciles to the transaction amount to within exactly
  ¥0.00; and
- reversal allocations mirror the affected original account allocations and
  cannot exceed each account's unreversed amount.

## Accounting semantics

Account balances are derived, never stored as mutable counters.

- A sale receipt increases the sales proceeds pool.
- A purchase funded by that pool decreases it.
- A direct Partner A or Partner B payment increases that partner's cumulative
  capital contribution and points to the funded purchase or cost evidence.
- A refund is a partial reversal against the original funding transaction. It
  reduces the affected participant contribution or restores the affected pool,
  according to the original funding source.
- A distribution is distinct from a sale and distinct from realized profit.

The initial confirmed mapping is:

| Event | Funding account effect | Operational/financial evidence |
| --- | ---: | --- |
| T2 Date Back sale | sales proceeds pool +¥6,188 | completed sale |
| New T2 purchase | sales proceeds pool -¥4,803 | purchase item / purchase cost entry |
| Autoboy S II sale | sales proceeds pool +¥1,288 | completed sale |
| New T2 EMS payment | Partner A gross contribution +¥109 | shipping cost entry |
| New T2 EMS refund | Partner A contribution reversal -¥22 | partial cost reversal |
| TVS II purchase | Partner B contribution +¥2,533 | purchase item / purchase cost entry |
| TVS II EMS | Partner B contribution +¥132 | shipping cost entry |

## Reversal-safe projections

Views must aggregate posted allocations rather than joining each original to a
single reversal row. This avoids fan-out and supports multiple partial
reversals.

At minimum, reviewed SQL must expose:

- net balance by funding account;
- gross contribution, reversed amount, and net contribution by participant;
- transaction-level original, reversed, and remaining amounts; and
- sales proceeds pool inflows, outflows, and net balance.

Each view uses `security_invoker = true`, filters to posted rows, and groups
reversals before joining them back to originals. Void or pending rows must not
affect posted balances.

## Immutability and correction policy

Posted `funding_transactions` and `funding_allocations` cannot be updated or
deleted. Database triggers enforce this independently of application behavior.
Corrections append one or more reversal transactions and, when necessary, a
new corrected transaction. Human-readable notes do not replace evidence links.

Draft or pending rows may only be changed through the reviewed RPC while they
have no posted dependants. Production data repair must never use ad hoc table
updates.

## Portfolio isolation and RLS

All four tables carry `portfolio_id`. Composite foreign keys enforce that every
participant, account, transaction, allocation, reversal, and source relation
stays inside one portfolio.

RLS follows the existing portfolio roles:

- members may read records for their portfolios;
- owners and editors may invoke reviewed write workflows;
- viewers cannot mutate the ledger;
- direct mutation of posted ledger rows is denied; and
- service-role access does not bypass database invariants or immutability
  triggers.

The write RPC must derive the actor from `auth.uid()`, validate membership, set
`created_by` internally, and reject client-supplied actor or portfolio identity
that conflicts with the authenticated context.

## Reconciliation RPC contract

The planned reconciliation RPC is the only supported path for turning existing
sales, purchase, shipment, cost, and refund evidence into posted funding
transactions. It must:

1. lock the target source record and relevant funding accounts;
2. validate portfolio, asset, amount, status, and source relationships;
3. reject mismatches between `cost_entries` and the requested funding amount;
4. apply a stable idempotency key so a retry returns the same result;
5. insert the transaction and allocations atomically;
6. validate allocation equality and partial-reversal caps before commit; and
7. write an audit event without exposing secrets or payment-account data.

The RPC must not create or modify `cost_entries`. Cost corrections must already
exist in the cost ledger before their funding effect is reconciled.

## Implementation gate

No production migration or reconciliation may run until both SQL drafts are
present in Git, reviewed against this architecture, covered by database tests,
and approved for a separate `db push`. This document alone authorizes no
production change.
