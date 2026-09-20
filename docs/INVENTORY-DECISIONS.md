# Inventory management — the compatibility decisions

> «المخزون الحالي قد يحمل أكثر من تكلفة تاريخية، وكل عملية بيع تستهلك أقدم دفعة
> تكلفة متاحة أولًا.»

This file is the contract the FIFO inventory work is built against. It is
written BEFORE the schema, because the single biggest risk in this feature is
not the arithmetic — it is building a second inventory system beside the one
Levonis already has.

Every fact below was read out of the repository, not assumed. File and line
references are given so the next reader can check rather than trust.

---

## 0. THE HEADLINE: MOST OF THIS ALREADY EXISTS

The brief asks for reservations, a ledger, idempotent stock movement,
adjustments with reasons, per-identity stock, no negative stock, and no second
reservation mechanism. **Levonis already has all of it**, and it is good.

`worker/lib/inventory.ts` (1,040 lines) and `worker/lib/orderInventory.ts`
already provide:

| The brief asks for | What exists today |
|---|---|
| §34 on-hand / reserved / available | `products.stock_reserved` + the three sibling rungs (0018) |
| §35 no second reservation mechanism | `reserve` → `deduct` → `release`/`restore`, driven off the ledger |
| §38 append-only movement ledger | `inventory_ledger` (0018, reshaped by 0020) |
| §17 idempotent operations | `inventory_ledger.idempotency_key` UNIQUE, key = `kind:op:line:scope:scope_id` |
| §16/§78 atomicity | `planInventory()` returns STATEMENTS the caller appends to its own `db.batch` |
| §40 no negative stock | guards in the `WHERE` clause **and** `CHECK (stock >= 0)` |
| §63 concurrency | guard-in-WHERE + UNIQUE key; a loser's batch rolls back whole |
| §39 adjustments with a reason | `adjust_in` / `adjust_out` with `reason` (0020) |
| §65 pre-order is not stock | capacity scopes are separate ledger scopes (0073/0075) |
| §66 option + colour stock | `inventory_mode` picks ONE authoritative rung |

**So this feature adds cost layers to a working inventory system. It does not
replace one.** Anything below that looks like a new mechanism is either a lot
(a cost fact) or an incoming purchase (a procurement fact) — never a second
answer to "how many are there".

---

## 1. THE STOCK IDENTITY IS ALREADY DECIDED, AND LOTS MUST USE IT

`products.inventory_mode` (0018:159) chooses exactly one authoritative rung:

```
BASE                 products.stock            / products.stock_reserved
OPTION               product_option_values.stock
COLOR                product_colors.stock
VARIANT_COMBINATION  product_variants.stock
```

`inventory_ledger` already names that identity as the pair
**`(scope, scope_id)`**, where `scope IN ('base','option','color','variant')`
(0020) and `scope_id` is the row id at that rung (empty for `base`).

**DECISION 1 — a FIFO queue is scoped to `(scope, scope_id)` and nothing else.**
Not to the product. This is what makes §22 true for free: black cannot consume
white's older lot, because white's lots are in a different queue. Lots carry
`product_id` too, but only for joins and for the deletion registry — never as
the FIFO key.

---

## 2. LOTS ARE CONSUMED AT `deduct`, NOT AT `reserve`

`worker/lib/orderInventory.ts` runs `reserve` at order creation and `deduct` at
confirmation, and **`planOrderDeduction` replays the reserve ledger rows** —
product, scope, scope_id, qty — rather than recomputing targets from the
product's current shape. Its header says why: by confirmation time the admin may
have changed `inventory_mode`, so recomputing could deduct a different row than
the one held.

**DECISION 2 — lot allocation happens at `deduct`, in the SAME `db.batch`.**

- A reservation holds a QUANTITY. That is what stops an oversell, and it already
  works. A lot is a COST fact, and a cost becomes real when the sale does.
- §35 wants a reservation to "identify the FIFO lot allocation that will be
  consumed". The guarantee it exists for — "another concurrent order must not
  reserve the same last unit" — is already enforced by the reserved counter, so
  the brief's requirement is met. What a reservation gets instead is a **FIFO
  preview** (a read, which lots *would* be consumed), never a claim on a lot.
  Claiming lots at reserve would be the second reservation mechanism §34
  forbids, with its own release path and its own way to leak units for ever.
- §36 then becomes trivially correct: a cancelled-before-deduct order released
  no lots because it consumed none. A cancelled-after-deduct order restores to
  its recorded allocation rows, which name the exact lots.

---

## 3. FINANCE: DERIVE, DO NOT REWRITE

Migration 0095 added `order_items.cost_iqd` and
`order_items.cost_basis CHECK (cost_basis IN ('snapshot','unpriced','composed','unrecorded'))`.

A CHECK constraint cannot be widened in SQLite without rebuilding the table, and
`order_items` is live history with real orders in it.

**DECISION 3 — `cost_basis` is not touched. FIFO COGS is DERIVED from the
immutable allocation rows.**

Finance resolves an order line's COGS in this order:

1. `order_item_inventory_allocations` rows exist → COGS is their exact sum, and
   the basis reported is **`fifo`** (computed, never stored).
2. No allocations → the existing `cost_iqd × qty` with its stored `cost_basis`,
   exactly as today.

§25 explicitly permits this: *"Prefer storing an authoritative total COGS for
the order line **or deriving it from immutable lot allocations**."* Deriving is
the better half of that choice — it cannot drift from the allocations, and it
adds no column to a table whose history must not move.

**Historical profit cannot change.** An allocation row stores its own
`unit_cost_iqd` and `cogs_iqd` at allocation time. Receiving a March lot writes
new lots; it writes nothing into January's allocation rows, and finance reads
the rows, not the lots' current state.

---

## 4. INTEGER DINARS, AND THE REMAINDER IS NOT LOST

Three components, and only three (§8): purchase, international shipping,
internal delivery to the warehouse.

`shipping_total / qty` rarely divides evenly. 500,000 over 7 units is
71,428.57…

**DECISION 4 — costs are allocated by the largest-remainder rule, and the
allocation is proven to reconcile.**

```
base      = floor(total / qty)
remainder = total - base * qty        // 0 <= remainder < qty
```

The first `remainder` units get `base + 1`, the rest get `base`. The sum is
exactly `total`, by construction, for every total and every quantity. The lot
stores the TOTALS it was built from as well as the derived per-unit figure, so
the reconciliation is checkable after the fact and not merely asserted.

A lot's stored `unit_cost_iqd` is the cost of the units in THAT lot. Partial
receiving therefore creates one lot per receipt, each with its own exact share
of the purchase's totals — see §9 below.

---

## 5. UNKNOWN IS NOT ZERO

§13 and §21 are the same rule in two places.

**DECISION 5 — every cost column that may be unstated is NULLABLE, and NULL
means "not entered". Zero means "genuinely free".**

- `incoming_inventory.shipping_total_iqd` — NULL until the owner knows it.
- `inventory_lots.unit_cost_iqd` — NULL only for an opening lot whose cost the
  resolver could not answer.
- `order_item_inventory_allocations.cogs_iqd` — NULL when the lot it consumed
  had no known cost.

Nothing uses truthiness on a cost anywhere. Receiving requires each of the three
components to be **stated** — a typed 0 is stated; an empty box is not.

Finance keeps saying "unknown" where it truly is unknown. §21: *"do NOT invent
one."*

---

## 6. BACKFILL: EVERY EXISTING UNIT BECOMES AN OPENING LOT

**DECISION 6 — the migration creates one `opening` lot per stock identity that
currently holds units, at the cost the CURRENT resolver would give it.**

The cost ladder already exists and is written out in migration 0096's
`trg_mystery_allocation_cost`: `products.product_cost_iqd` (rung 0), then
`product_option_values.cost_iqd` / `cost_adjust_iqd`, then the fulfilment cell,
then `product_colors.cost_iqd` / `cost_adjust_iqd`. The backfill reuses that
precedence rather than inventing a second one.

Where no rung answers, the lot is created with `unit_cost_iqd = NULL` and
`cost_basis = 'opening_unpriced'`. An unpriced lot is still a real lot: it holds
units, it is consumed in FIFO order, and its allocations carry a NULL COGS that
finance reports as unknown.

The invariant the migration is tested against (§79):

```
SUM(lots.qty_remaining) per identity  ===  that identity's stock column
```

before and after, for every shape: base-only, option, colour, variant, zero
stock, unknown cost, known cost.

---

## 7. THE COUNTERS STAY AUTHORITATIVE FOR AVAILABILITY

§64 warns against four disagreeing stock numbers.

**DECISION 7 — `products.stock` and its three siblings remain the authoritative
answer to "can I sell this", and lots are the authoritative answer to "what did
it cost". They are kept equal by construction, not by reconciliation.**

Every operation that changes one changes the other **in the same `db.batch`**:
receiving increments the counter and inserts the lot together; deduction
decrements the counter and decrements `qty_remaining` together. There is no
sweep, no nightly job and no repair script, because there is no window in which
they can disagree.

An invariant test asserts the equality after every scenario in the suite.

Availability keeps reading the counter, so §67 is satisfied without touching one
line of the storefront: «متوفر X في المخزون» is the same number it is today, and
incoming stock is never added to it before receipt.

---

## 8. PRODUCT DELETION

`worker/lib/productDeletion.ts` already separates OWNED (deleted with the
product), HISTORY (pointer cleared, row kept) and FROZEN (left alone, and listed
so the registry test can tell "considered" from "never looked at").

**DECISION 8:**

| Table | Class | Why |
|---|---|---|
| `order_item_inventory_allocations` | FROZEN | part of the order record, like `pricing_snapshot`. §56: financial sales history is never cascade-deleted |
| `inventory_lots` | HISTORY | `product_id` cleared; the row stays, because allocations point at it and their COGS must stay readable |
| `incoming_inventory` | HISTORY | §55: once it has received stock its history is not hard-deleted |
| `incoming_inventory_receipts` | HISTORY | the audit trail of a real receipt |
| `inventory_reorder_settings` | OWNED | pure configuration with no financial meaning |

---

## 9. PARTIAL RECEIVING MAKES ONE LOT PER RECEIPT

§33 allows receiving 6 of 10 today and 4 later. Those 6 may carry a different
share of a shipping total than the later 4 if the totals change in between.

**DECISION 9 — each receipt creates its own immutable lot, and its cost share is
computed against the quantity BEING RECEIVED using the same largest-remainder
rule.** The purchase's totals stay on the incoming record; each lot records the
share it took. The sum of the lots' shares reconciles to the totals for a fully
received purchase, and the incoming record's own totals are never rewritten.

§54: once a lot exists and especially once it has been consumed, its financial
values are immutable. Correcting one is an explicit, audited action — never a
silent edit, because a silent edit rewrites profit that has already been
reported.

---

## 10. PERMISSIONS ARE THE EXISTING ONES

`worker/lib/adminScope.ts` has `FINANCIAL_FIELDS`, `stripFinancials()` (which
recurses, because cost lives at four rungs) and `projectForAdmin(env, user,
payload)`.

**DECISION 10 — every new cost field name is added to `FINANCIAL_FIELDS`, and
every inventory route serialises through `projectForAdmin`.** Quantities are
operational and stay visible to an assistant admin; costs, margins and supplier
prices do not. Enforced server-side, per §52 — the UI hiding a field is not a
permission.

---

## 11. SERIALS REUSE THE EXISTING CHAIN

`order_item_units` (0003:112 — one row per unit, carrying the warranty dates)
and `device_serials` (0003:132 — `serial_norm` PK, `serial_raw` preserved)
already exist, and warranty is built on them.

**DECISION 11 — no new serial system. `order_item_units` gains a nullable
`inventory_lot_id`.** That single column completes the chain the brief asks for
in §71:

```
supplier purchase → incoming → lot → order_item_unit → serial → warranty
```

Serials remain optional, exactly as they are today: nothing forces one onto a
spool of filament.

---

## 12. WHAT THIS FEATURE DELIBERATELY DOES NOT BUILD

Stated so that a future reader does not "fix" their absence:

- **No mixed-shipment cost allocation** (§31). Each incoming record carries its
  own shipping and internal-delivery totals. No by-weight, by-CBM or by-value
  engine. The owner decides outside the system what belongs to each record.
- **No fourth cost component** (§8). Not customs, not insurance, not bank fees,
  not brokerage. Three.
- **No estimated/final cost duality** (§12). A field is either entered or not.
- **No stock-status taxonomy** (§32). Quarantine, demo and service units are not
  a thing here. Incoming purchases have a lifecycle; stock does not.
- **No automatic purchasing** (§47). Reorder advice is advice.
- **No inventory in the operating-expense ledger** (§70). Buying ten printers is
  an asset movement; it becomes COGS as units sell. Mixing the two would
  misstate a month's profit by the size of a shipment.
