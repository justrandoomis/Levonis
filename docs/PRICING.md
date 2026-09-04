# Pricing resolution and fee composition

Single implementation: `worker/lib/pricing.ts` (`resolveUnitPrice`) — used by
the product page quote, cart, server checkout, admin preview and tests.
Unit tests pinning every rule: `tests/pricing.test.ts` (`npm run test:unit`).

## Currency model

- **IQD is canonical** for every entered monetary value (integer dinars).
- **USD is derived** for display from the single admin setting
  `exchangeRate`, defined as **1 USD = X IQD**.
- Wallet balances are stored as integer **USD cents**; conversions IQD→cents
  use `ceil(iqd × 100 / X)` (rounding up so the wallet never undercharges);
  cents→IQD displays use `floor(cents × X / 100)`. Formatting never changes
  stored values.
- Changing the exchange rate changes **derived USD display only** — never
  stored IQD prices and never existing orders (each order snapshots
  `exchange_rate` at creation).

## The four price fields

At **product**, **option** and **color** level:

| Field | Meaning |
| --- | --- |
| `regular_price_iqd` | regular-member selling price |
| `pro_price_iqd` | PRO-member selling price |
| `compare_at_iqd` | optional original/compare-at reference (display only) |
| `cost_iqd` | internal purchase cost — **never in public responses** |

`null` = **inherit** down the chain `color → option → product base`,
independently **per field**. `0` is an explicit value (truthiness is never
used). At product level the four map to columns `price_iqd` (required),
`pro_price_iqd`, `original_price_iqd`, `product_cost_iqd`.

Option/color prices **replace** the applicable base price; they are never
surcharges.

## Inherit, adjust, fixed — the three modes (0044)

Each of the four fields on an option or a colour row is in exactly one of three
modes, and **the mode is read from the row, never stored beside it**:

| `<field>_price_iqd` | `<field>_adjust_iqd` | mode | what the row does |
| --- | --- | --- | --- |
| `NULL` | `NULL` | **inherit** | takes whatever the level below resolved to |
| `NULL` | set | **adjust** | that value **plus a signed number of dinars** |
| set | (ignored) | **fixed** | its own number, whatever the base does |

A fixed price wins over an adjustment on the same row: a number the owner typed
is an answer, and an adjustment beside it is at most a leftover.
`worker/lib/pricing.ts` exports `priceMode(row, field)` so nothing has to
re-derive the rule, and every row written before 0044 has `NULL` in all four
adjustment columns — so a catalogue that has never used one resolves exactly as
it did before.

**Why adjust exists.** A fixed price is a *pin*: raise the product's base price
and the pinned option stays where it was, so the headline changes while a
customer who picks that option is charged the old number. That failure is the
whole subject of `worker/lib/pinnedPrices.ts`. An adjustment says "this option
is 60,000 above the base" once, and keeps saying it after every future base
change.

**Anchoring.** An adjustment applies to the value the row would otherwise have
inherited *for the same field*. When a member field (PRIME/PRO) has nothing to
inherit — no member price is set anywhere below it — the adjustment anchors on
the **regular price resolved at that same rung**, because "PRO pays 15,000 less"
can only mean less than what everyone else pays. **Cost has no such fallback**: a
cost adjustment with no cost beneath it stays `inherit`, because inventing a cost
from a selling price would make the profit figures confidently wrong. The result
is clamped at zero and rounded to whole dinars.

`product_variants` deliberately has **no** adjustment columns: `resolveUnitPrice`
takes an option and a colour and never reads a variant price, so a variant
adjustment would be a field an admin could set that no customer could be charged
from.

## Quick Edit — the whole price table of one product

`worker/lib/priceGrid.ts` projects a product into one flat grid (the base row,
then one row per option, then one per colour) with a cell per field carrying its
mode, its stored value, its **effective** price and the price it would fall back
to on `inherit`. `effective` is computed by the same ladder `resolveUnitPrice`
walks, so the admin preview and the customer's cart cannot disagree — that
agreement is asserted row by row in `scripts/e2e-quick-price.mjs`.

The endpoints live in `worker/routes/adminPriceGrid.ts`, all under
`/api/admin/products/:id`:

| Route | What it does |
| --- | --- |
| `GET /price-grid` | the grid, the scope vocabulary, the margin floor |
| `PATCH /price-grid` | writes **only** the cells in the body |
| `POST /price-grid/bulk` | preview by default; `apply: true` writes what the preview returned |
| `POST /price-grid/copy` | pre-order↔direct, or model↔model, same two-step |
| `POST /price-grid/undo` | reverses one `batch_id`, out of `price_history` |
| `GET /price-history` | the timeline (financial admins only) |
| `POST /price-grid/cost-change` | the supplier-cost difference and a suggestion; **writes nothing** |

Every write appends to `price_history` (the table the seven-day price protection
already reads) stamped with a `batch_id`, which is what makes undo possible
without a snapshot table.

**Profit and the guard.** `profitOf(price, cost)` reports margin as profit over
the **selling price** — the retail convention — so a floor set at 20% is not
quietly satisfied at 16%. A missing cost yields `null`, never `0`. The guard
warns when a price is under its cost, or under the `minMarginPercent` admin
setting when one is configured, and it **warns rather than vetoes**: the write is
refused with `409 PROFIT_GUARD` until the caller sends `confirm: true`, because a
launch sold at cost and a clearance sold below it are both real decisions. A
guard only ever speaks about the fields the request changed — except a cost
change, which re-checks all three selling prices because it can put any of them
under water at once (`guardedFields`).

**Amounts.** `parseAmount` accepts `950K`, `1.25M`, `950,000`, Arabic-Indic
digits and `مليون`, and **refuses rather than guesses** on anything ambiguous —
a bare fraction of a dinar, two suffixes, a suffix that lands between dinars.
The admin drawer runs the same rule locally so a typo turns red as it is typed,
but the server is what parses the value that is written.

## PRO resolution

1. Resolved explicit PRO price (color→option→base) when present.
2. Otherwise the store-wide policy `proPricingPolicy`:
   - `explicit_only` (default): **no discount** — no fabricated percentages.
   - `global_percent` (owner-approved only): `regular − floor(regular×p/100)`.
3. A PRO member never pays more than the regular price (misconfigured PRO
   prices clamp to regular).

`compare_at` is shown only when it exceeds the applicable selling price —
no misleading strikethroughs.

## Fee composition (unit)

```
chosen selling price   (color/option/base; regular or PRO)
+ preorder transport commission   (air/sea/land; product override else
                                   admin default; WAIVED for active PRO)
+ selected warranty fee           (added on top; NEVER waived by membership)
= unit subtotal
```

Then, at order level: × quantity → coupon discount (if valid) → points
(1 pt = 1 IQD) → wallet application → **last-mile delivery** (chosen
delivery method price; **0 + `delivery_waived`=1 for active PRO**, or for a
referred friend's qualifying printer purchase). Preorder procurement
commissions, last-mile delivery, and warranty fees are three distinct
charges — a waiver of one never touches the others.

Validation errors (`OPTION_NOT_FOUND`, `COLOR_OPTION_MISMATCH`,
`TRANSPORT_REQUIRED`, `TRANSPORT_NOT_OFFERED`,
`TRANSPORT_COMMISSION_UNCONFIGURED`, `TRANSPORT_NOT_APPLICABLE`,
`WARRANTY_PLAN_NOT_FOUND`, `OPTION_INACTIVE`, `COLOR_INACTIVE`) reject the
selection server-side; the UI mirrors them but is never the enforcement.

## Worked examples (from the unit tests)

1. Base 100,000; option regular 120,000 selected → applied 120,000.
2. Option regular 120,000 + compare-at 150,000; color regular 130,000
   (compare-at null) → applied 130,000, compare-at 150,000 (inherited
   per-field from the option).
3. Preorder, sea commission 15,000, free tier → unit subtotal 115,000.
4. PRO + air commission 25,000 + 2-year warranty 20,000, no PRO price →
   100,000 + 0 (waived) + 20,000 = 120,000.
5. PRO with `explicit_only` policy and no explicit PRO price → pays the
   regular price; the UI shows no PRO discount.

## Snapshots

Each order line stores `pricing_snapshot` (the resolver output minus cost
fields), `warranty_snapshot` and `transport_snapshot`; the order stores
`membership_tier_snapshot`, `exchange_rate`, `delivery_waived`,
`coupon_snapshot`. Later edits to products, prices, policies or the
exchange rate never alter historical orders.


## Points — earning, waiting and redeeming (mandate §4.2–§4.4)

This section **supersedes** the earlier "1 point per 1,000 IQD, awarded at
delivery" rule. Implementation: `worker/lib/pointsOps.ts`, migration
`0014_points_rule.sql`, tests `tests/points.test.ts`.

### Two different rates

| Direction | Rate |
| --- | --- |
| **Earning** | `floor(net eligible merchandise / 100)` — 100 IQD = 1 point |
| **Redeeming** | 1 point = **exactly 1 IQD** (739 points → 739 IQD, never rounded) |

They are deliberately not each other's inverse.

### The eligible basis

```
Σ (applied product price × qty)      official-store merchandise only
− coupon discount                     order-level
− points spent on this order          so points are not re-earned on
                                      value the customer never paid
= net eligible                        floor(…/100) ONCE, on the ORDER TOTAL
```

* Lines are **summed first and floored once**. Three 199 IQD lines earn
  `floor(597/100) = 5` points, not `1+1+1 = 3`.
* **Never in the basis**: last-mile delivery, preorder transport commissions,
  warranty fees. Changing the delivery method alone cannot change the points.
* Order-level discounts are subtracted from the merchandise pool **in full** —
  the documented conservative distribution rule, because a coupon may partly
  cover shipping and shipping must never earn points.
* Community-store lines and subscriptions are not eligible. (Today the
  checkout only ever loads the official `products` catalogue;
  `community_products` has no checkout path, so no mixed cart can leak in.)

### Redemption (§4.4)

"Use my points" applies **all available points**, capped at the eligible
merchandise value **after** product/membership/coupon discounts — never
delivery, never fees. Anything above that cap stays in the balance.

Only **released** points are spendable: pending accruals live in
`points_accruals`, not in the ledger, so they cannot be redeemed by
construction. Availability is read through the wallet slice's frozen
`getAvailableBalances` contract (settled minus active holds/reservations).

Points are **reserved and committed inside the same checkout batch** as the
order (`points_reservations`, UNIQUE per order). The ledger withdrawal
computes its amount against the live balance *inside* the statement, so a
losing concurrent order produces a negative amount, violates
`CHECK (amount > 0)` and aborts its whole batch — order, stock, wallet and
points roll back together. A failed checkout therefore leaves no reservation
to release: there is no orphan state to clean up.

### The seven-day wait (§4.3)

| Field | Meaning |
| --- | --- |
| `purchase_at` | the **server instant the checkout transaction committed the order** — the same transaction that reserved stock and debited money and points. Not cart creation, not a failed attempt, never the browser clock. |
| `available_at` | `purchase_at + 7 × 24h`, fixed at creation and never moved |
| `settled_at` | stamped when RECORDED collections cover `total_iqd` |

An accrual releases only when **both** hold. Wallet-prepaid orders settle at
purchase; a COD order settles when a collection is recorded in
`order_payment_settlements` — **delivery is not collection** (§11.5), and the
delivered transition never records one. A COD order collected on day 9
releases on day 9: settlement does **not** start a new seven-day clock. A
partially collected order stays pending.

Release runs in the durable job (`worker/lib/jobs.ts`, step 7) and on the
settlement event itself. Never on page open. Each release is one D1 batch:
a conditional `UPDATE` picks a single winner, the dependent statements repeat
that winner's `released_at` token, and the POINT deposit carries a
deterministic id — so a retried cron, an overlapping run and a concurrent
settlement can never credit twice.

### Reversals

Cancellations and returns write **negative accrual entries recomputed from
the remaining eligible amount** — `points_now − floor(remaining/rate)` — not a
floor of the returned portion, which would drift on repeated partial returns.
History is never edited or deleted.

* Accrual still pending → the reversal only reduces the pending amount; no
  ledger movement ever happened.
* Accrual already released → a balance-guarded claw-back. If the customer
  already spent the points the call reports
  `insufficient_points_balance` honestly instead of faking a claw-back, and
  the reversal row is rolled back with it.
* Refunds return **points as points** and cash by its own channel. Points are
  never converted to cash.

### Rule versioning (acceptance test PTS-07)

Setting `pointsRuleConfig`:

```json
{"iqd_per_point": 100, "legacy_iqd_per_point": 1000,
 "version": "v2", "legacy_version": "v1", "effective_at": "<ISO UTC>"}
```

The rate is resolved **once, at purchase time**, and frozen on the accrual row
(`iqd_per_point`, `rule_version`). Changing the setting later cannot re-price
history. Orders purchased before `effective_at` keep the legacy rate; orders
that predate migration 0014 have no accrual row at all and keep the original
`points_awards` delivered-award path, rows and rate untouched. **No existing
balance is ever multiplied, re-granted or recomputed.**

Migration 0014 seeds `effective_at` to its own application time, so every
order that already existed is unambiguously "before" it. The owner can move
that date (decision register row 20 / mandate §13 item 4).

## The §5 unified financial snapshot

Every cart, checkout, order-detail, admin-prep and invoice screen reads ONE
server-computed money view — `financial` on the order payload
(`worker/routes/orders.ts`). No screen recomputes totals, and nothing is
computed in the browser.

| Field | Honesty rule |
| --- | --- |
| `merchandise_iqd` / `fees_iqd` | goods separated from transport commissions and warranty fees |
| `coupon_discount_iqd` | shown on its own line |
| `points_used` / `points_value_iqd` | 1 : 1, applied to merchandise only |
| `shipping_iqd`, `delivery_waived` | declared, never hidden |
| `total_iqd` | after coupon and points, before wallet |
| `wallet_applied_iqd`, `wallet_tx_id` | the wallet is a **payment means**, not a discount — it never reduces the goods price |
| `due_on_delivery_iqd`, `collected_iqd`, `outstanding_iqd` | a COD balance is never "paid" at creation |
| `payment_state` | `cod_due` / `partial` / `paid`, derived from RECORDED collections |
| `points.pending`, `points.available_at` | what was earned and when it can be released |
| `support` | attribution with an explicit `discount_iqd: 0` — a support code is **not** a discount |

Worked example (the mandate's §5 arithmetic, pinned in
`tests/points.test.ts`):

| Step | IQD |
| --- | --- |
| Merchandise net of commercial discounts | 75,000 |
| − 739 points redeemed (739 IQD) | 74,261 |
| + delivery | 5,000 |
| **Total** | **79,261** |
| − wallet payment | 30,000 |
| **Due on delivery (COD)** | **49,261** |
| Pending points accrued: `floor(74,261 / 100)` | **742 points** |
