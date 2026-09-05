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

An option/colour regular price is a rung on the ladder: a **fixed** number
replaces what is beneath it, an **adjustment** moves it. Either way the
difference it makes to the regular price is a **surcharge every tier pays** —
see "The member ladder follows the regular one" below.

## The member ladder follows the regular one (the owner's rule)

> Base Regular 150,000 / PRIME 125,000 / PRO 100,000. Option 2 adds 25,000 →
> 175,000 / 150,000 / 125,000. Direct sale adds 100,000 on top → 275,000 /
> 250,000 / 225,000. Options, colours, availability and shipping are
> **additional costs for every tier**.

**Amended by the payment-method mandate (2026-09-05):** «Pro Card users are
exempt from this additional shipping-type cost.» Options and colours still
cost every tier the same, but the *availability* fee — the direct-sale premium
exactly like the pre-order commission — is **waived for an active PRO**, on the
same gate (`proContext`: approved default address, benefits not restricted).
The owner's example therefore ends **275,000 / 250,000 / 125,000**: the PRO
member pays the option surcharge and nothing for immediacy.

Implemented in `worker/lib/pricing.ts` `memberAtRung`, mirrored by the Quick
Edit grid (`priceGrid.ts step/cellOf`) and the write-time validators
(`derivedRung`). At each rung (option, then colour) a PRIME/PRO field that
states nothing of its own inherits the value beneath **plus the change this
rung made to the regular price**. A rung that states its own member price
replaces it; a rung with a member *adjustment* applies it on top of that
carried value ("PRO gets 5,000 more off on this option"), or on the rung's
regular price when no member price exists beneath. Cost never follows: a
surcharge says nothing about what the extra costs the store.

A reduction at least as large as the member price it would inherit (base PRO
90,000, option −100,000) leaves nothing to carry: the resolver charges the
member the reduced regular price — or, for a PRO member whose line still has
a PRIME price, that PRIME price (see *PRO resolution* below: **a PRO member
never pays more than a PRIME member**) — and every validator refuses such a
row unless it states its own member price.

**What the validators refuse, on the DERIVED numbers.** `derivedRung` is run
by `productModel.validateProductDoc`, `productRelations.validatePriceLadder`,
`importCsv.parseImport`, the Quick Edit routes, and the product form's client
mirror (`src/components/adminProducts/form/model.ts`, which replicates
`memberAtRung`/`derivedRung` line for line). One fixture list,
`tests/pricingLadderFixtures.ts`, is run through the three server validators
and the client mirror in `tests/productModelLadder.test.ts` and through the
Quick Edit route in `tests/adminPriceGridRoute.test.ts`, and all five must
refuse exactly the same inputs:

- a reduction that swallows an inherited member price (above);
- a derived PRIME or PRO above the row's own regular price — base 150,000
  with no member prices, option +25,000 with `pro_adjust +10,000` puts PRO at
  185,000 on a 175,000 row;
- a derived PRIME below the derived PRO — option +25,000 with its own PRIME
  120,000 while it carries PRO 125,000: the resolver would clamp PRIME up to
  125,000 and charge a PRIME member a number the row never shows;
- for a **colour**, the swallowed-member-price and PRIME-below-PRO checks
  again under **each option it can be sold with** (its link set, else every
  active option), via `derivedRung(colour, derivedRung(option, base))` —
  because the resolver anchors a colour on the option the customer picked.
  Base 150/125/100k, option +100,000 with its own PRO 40,000, colour fixed
  130,000: under that option the colour's −120,000 swallows the 40,000 PRO,
  and the refusal names both the option and the colour. A colour is still
  measured against the base as every other row is.

**Legacy rows.** A product stored before these rules (base 100,000 / PRO
90,000, option fixed 5,000) exports as `options.N.regular_adjust_iqd=-95000`
with a note beside `price_iqd` saying the base stayed because lowering it
would take the product PRO to zero. Re-applying that file — exactly like
saving the product itself — is refused with `options.<id>.regular_price_iqd:
the reduction on this row is larger than the PRO price it inherits (90000) —
state a PRO price for this row, or reduce less`. That is the intended path:
the owner gives that row its own `options.N.pro_price_iqd` and the file
applies (`tests/templateRoundTrip.test.ts`).

Consequences: the same option written as `regular_price_iqd=175000` or as
`regular_adjust_iqd=+25000` prices every tier identically; the cheapest-base
normaliser (`cheapestBase.ts`) moves the product's PRIME/PRO by the same
amount it moves the base, so member prices are offsets that survive the
rewrite; and a product-level `pro_price_iqd` is the PRO price of the *base
selection only* — every surface shows the resolver's `pro_iqd` for the
selection in hand.

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
inherited *for the same field* — which, for PRIME/PRO, already carries the
row's regular surcharge (see the owner's rule above). When a member field has
nothing to inherit — no member price is set anywhere below it — the adjustment
anchors on the **regular price resolved at that same rung**, because "PRO pays
15,000 less" can only mean less than what everyone else pays. **Cost has no such fallback**: a
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
walks **and then clamped exactly as the resolver clamps the line**
(`clampMemberLadder`: neither member price above the row's regular price,
PRIME never below PRO, PRO falling back to PRIME), so the admin preview and
the customer's cart cannot disagree — `tests/priceGridAgreement.test.ts`
asserts cell-for-cell equality with the resolver over the whole fixture set,
and `scripts/e2e-quick-price.mjs` row by row against a running worker. Two
details keep that true: the value a rung passes UP to the next one is the raw
ladder value (that is how `pickMember` carries it; the clamp is the last word
on the line the customer actually picked), and a member cell's `inherited` is
that raw carried value too, because it is the anchor a member *adjustment*
applies to, exactly as `memberAtRung` anchors one. A PRO cell that inherits
nothing (no PRO price beneath, none of its own) shows the PRIME price PRO
members fall back to; a bulk `add`/`subtract`/percent on such a cell is
skipped as `NO_CURRENT_VALUE` rather than pinning a PRO number onto a row that
never had one.

**Write-time ladder.** `PATCH /price-grid`, and `bulk`/`copy` with
`apply: true`, rebuild the product as it would read after the change and run
`validatePriceLadder` — the validator the relations PUT runs — over every row
whose derived ladder can have moved: every row when the base row changed (it
is beneath all of them), an option and the colours sold with it when that
option changed, a colour alone (under each option it is sold with) when only
it changed. A violation answers `400 {code: 'VALIDATION', errors: […]}` with
the same messages the product form's save would show, before anything is
written; the preview responses carry the same list as `errors`. A legacy row
that is already wrong elsewhere in the product does not block an unrelated
edit, and undo is exempt — restoring a previous state is always allowed.

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

1. Resolved explicit PRO price (color→option→base) when present — the base
   PRO price plus every regular surcharge on the way up, unless a rung states
   its own PRO price (`memberAtRung`).
2. Otherwise the store-wide policy `proPricingPolicy`:
   - `explicit_only` (default): **no discount** — no fabricated percentages.
   - `global_percent` (owner-approved only): `regular − floor(regular×p/100)`.
3. Otherwise the PRIME price resolved for the same line, when one exists:
   **a PRO member never pays more than a PRIME member** (`clampMemberLadder`).
   This covers a PRIME-only product and a line whose base PRO was swallowed by
   a reduction (base 150/125/100k, option +100,000 with its own PRO 40,000,
   colour fixed 130,000 → PRIME 105,000, and PRO members pay 105,000 too).
   `pro_iqd` reports the number actually charged, so the product page, the
   cart, the admin preview and the Quick Edit grid all agree. No discount is
   invented: with no member price on the line at all, the regular price
   applies.
4. A PRO member never pays more than the regular price (misconfigured PRO
   prices clamp to regular), and PRIME is never below PRO (a legacy inverted
   row clamps PRIME up to PRO). Every resolved line therefore satisfies
   PRO ≤ PRIME ≤ Regular wherever the values exist —
   `tests/pricingLadder.test.ts` asserts it over the fixture set, and that
   `product_cost_iqd` never influences any of the three.

`compare_at` is shown only when it exceeds the applicable selling price —
no misleading strikethroughs.

## Fee composition (unit)

```
chosen selling price   (color/option/base; regular, PRIME or PRO)
+ ONE availability fee, never both:
    preorder transport commission   (air/sea/land; product override else
                                     admin default; WAIVED for active PRO)
    — on a pre-order line paid in advance
    direct-sale surcharge           (products.direct_surcharge_iqd;
                                     WAIVED for active PRO, same gate as
                                     the commission)
    — on a direct line, and on a pre-order line paid CASH ON DELIVERY
+ selected warranty fee           (added on top; NEVER waived by membership)
= unit subtotal
```

Then, at order level: × quantity → coupon discount (if valid) → points
(1 pt = 1 IQD) → wallet application → **last-mile delivery** (chosen
delivery method price; **0 + `delivery_waived`=1 for active PRO**, or for a
referred friend's qualifying printer purchase). The availability fee,
last-mile delivery and warranty fees are three distinct charges — a waiver of
one never touches the others.

The resolver reports which rule priced the line as `pricing_basis`
(`'preorder'` = the commission is the fee; `'direct'` = the surcharge is), and
`direct: { surcharge_iqd, waived }` / `transport: { …, waived, waived_by }`
so every surface can name the fee instead of folding it silently. The printer
home-delivery **note** (setting `printerHomeDeliveryNoteIqd`, default 50,000)
is not in this list on purpose: it is shown, never added.

## Extended warranty (printers only — owner mandate, 2026-09-05)

`worker/lib/warrantyPlans.ts` is the one place the rules live;
`tests/extendedWarranty.test.ts` runs them through the real cart, product,
checkout and policy routes.

- **Eligibility**: a product filed under a printer catalog
  (`catalogs.is_printer_catalog`, answered by `worker/lib/printerIdentity.ts`).
  Anything else is refused a plan on every write path (admin save, TXT
  analyze/apply, CSV preview/confirm → `400 WARRANTY_NOT_PRINTER`) and at
  runtime (cart add/update, checkout → `WARRANTY_NOT_PRINTER`; the quote
  reports it in `errors`). Stored legacy plans keep resolving on read.
- **Shape**: `duration_kind = 'extension'`, `duration_months ∈ {12, 24}`, one
  plan per duration — "+12 months → 24 months total", "+24 → 36" over the
  12-month base (`warranty_base_months`, a printer's default; `serialized`
  defaults to true so a unit row exists for the coverage to attach to).
  **Read-time defaults** (`effectiveDevicePolicy` / `effectiveBaseMonths`):
  a printer whose stored `ops_policy` lacks the keys (`'{}'`, or only a
  base — rows written before this round) is READ as serialized with the
  12-month base by the resolver, `pricedPlans`, the cart and
  `deviceOps.createUnitsOnDelivery`, so its snapshot carries `base_months
  12 / total_months 24|36` and its delivery creates the units; an explicit
  `serialized: false` is the owner's word and is kept. No migration rewrites
  old rows. The admin ops-policy route refuses `serialized: false` on a
  printer with active plans (`400 WARRANTY_PLAN_INVALID`), as the form does,
  and the legacy `POST /api/admin/products` runs the same printer guard.
- **One plan per line, the customer's to change**: re-adding the same
  printer merges into the existing line; an add that names a different plan
  than the line holds (including a line with none) is refused `409
  CART_WARRANTY_CONFLICT` ("already in your cart with a different
  extended-warranty choice — change it from the cart"); an add naming no plan
  keeps the line's plan. The plan changes only through `PATCH
  /api/cart/items/:id`.
- **Fee** = `round(REGULAR price of the selection × fee_percent / 100)` in
  integer IQD (basis points, one rounding), else the fixed `fee_iqd`. The
  basis is the regular price — never the member price — so a guest, a PRIME
  and a PRO pay the same dinar for the same extension; the warranty fee is
  still **never waived by membership**. An option or colour surcharge moves
  the basis (A1 899,000 × 7.5 % = 67,425; Combo 1,099,000 → 82,425). The
  owner's 7.5–10 % is a hint the admin form shows, not a server cap
  (0.01–100, ≤ 2 decimals).
- **Where it is chosen**: the product page (before add-to-cart) or the cart's
  "Extended Warranty" disclosure, through `warrantyPlanId` on
  `POST /api/cart/items` and `PATCH /api/cart/items/:id`. One plan per line,
  applied to every unit of the line. `GET /api/products/:slug`,
  `POST /api/products/:slug/quote` and `GET /api/cart` serve each plan with
  its `fee_iqd` already resolved for the selection's regular price plus
  `basis_iqd`, `base_months`, `total_months` — the storefront never computes a
  fee.
- **Before the order only**: checkout freezes `ResolvedPrice.warranty`
  (`plan_id, title_ar, title_en, fee_iqd, duration_months, duration_kind,
  fee_percent, basis_iqd, base_months, total_months`) into
  `order_items.warranty_snapshot`; no route writes that column afterwards.
  At delivery `deviceOps.computeCoverage` prefers the snapshot's
  `total_months`/`base_months`, so the 24/36 promise survives a later product
  edit. The fee counts as a fee (`fees_iqd`), earns no points, and is invoiced
  under the plan's own title.
- **Policy text**: `policy_documents` key `extended_warranty` (LEVONIS's own
  draft in ar/en/ckb, seeded and published like every other policy); the
  storefront links to `/policies/extended_warranty` beside the chooser.

## Payment method × shipping type (owner mandate, 2026-09-05)

`worker/lib/paymentPolicy.ts` is the one place the rule lives; `computeCheckout`
applies it and `tests/checkoutPayment.test.ts` runs it through the real routes.

| Cart | Pay in advance (`wallet`) | Cash on delivery (`cash`) |
| --- | --- | --- |
| Direct sale | base + direct surcharge (PRO: base) | the same — the method never changes a direct line |
| Pre-order (air/sea/land), product **with** a direct surcharge | base + transport commission (PRO: base) — **exactly as configured** | **priced as a direct sale**: base + direct surcharge (PRO: base); the commission is not charged |
| Pre-order, product with **no** direct surcharge (`direct_surcharge_iqd` null/0 — the normal pre-order-only shape) | base + transport commission (PRO: base) | **the same** — there is no direct premium to price the line "as direct" with, so the commission stays, `pricing_basis` stays `'preorder'`, nothing is waived |
| Pre-order paid `cash` but the wallet settles the **whole** total (`due_on_delivery_iqd = 0`) | — | **a prepaid order**: re-priced under the pre-order rule (the cheaper figure, still covered), `prepaid_by_wallet: true` on the quote; `payment_method_id` stays `cash` |

- **Decisions from the adversarial review (2026-09-05).** (a) "Priced as a
  direct sale" applies only when the product actually carries a direct-sale
  premium; with none, cash on delivery would otherwise drop the commission
  and charge nothing in its place — the store loses the commission and the
  door becomes cheaper than the wallet, the opposite of the owner's intent.
  (b) «مدفوع مقدمًا» means nothing is left to collect at the door: a cash
  order the wallet covers in full is a prepaid order whatever button was
  pressed, so it gets pre-order pricing (and, for a PRO at the approved
  address, the prepaid gift); a cash order the wallet covers only in part
  stays COD-priced. `computeCheckout` prices the cart under the requested
  basis, and re-settles it as prepaid when that condition holds.
- The quote also says whether the method matters at all: `cod_reprices` is
  true only when some line's price differs between prepaid and cash (a direct
  premium this customer pays). The product quote's `pricing_modes` (direct,
  and per journey prepaid/cod with `cod_reprices`) and the cart line's
  `cod_reprices` carry the same fact, so the product page, the cart and the
  checkout explain the cash rule **only where the number would move** — and
  the product page computes none of its figures (no browser arithmetic).
- The offered ids are `wallet` and `cash` for **every** shipping type
  (`allowedPaymentMethods`), echoed on the quote as `allowed_payment_methods`;
  the storefront draws exactly those. `full_advance` is tolerated as an alias
  of `wallet` (stored orders, API scripts) and never offered; `half_advance`
  is refused with `400 PAYMENT_METHOD_NOT_ALLOWED`. No id is ever renamed —
  `cash` stays the platform COD id the admin labels and stickers branch on.
- A cash-on-delivery pre-order **stays a pre-order**: the resolver keeps the
  transport object with its method (`waived: true, waived_by:
  'cod_direct_pricing'`), so `orders.shipping_type` is still `preorder_*`, the
  order walks the fourteen pre-order stages, tracking labels the freight, and
  "buy again" repeats the pre-order line. Only the commission/pricing logic
  differs, which is what the owner asked for.
- The pre-order gift («PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية») still requires
  `due_on_delivery_iqd = 0`, so a COD pre-order earns none — unchanged.
- The cart and the product page know no payment method, so they show the
  **prepaid** pre-order price and say so; the checkout quote's `lines` and
  `subtotal_iqd` are the price authority once a method is chosen, and the
  checkout screen renders those, never the cart's numbers, beside the total.
- **One PRO purchase context on every surface** (`worker/lib/entitlements.ts`
  `pricingTierContext`): PRO prices and both availability waivers apply only
  at the approved default PRO address with benefits not restricted. The
  checkout judges the address the customer selected; the product page, the
  product quote and the cart — which have no selection yet — judge the
  customer's DEFAULT address. So an active PRO whose default address is not
  approved sees the surcharge on the product page, in the cart and at the
  checkout alike (`viewer_tier.pricing_active` / `pro_benefits_context` say
  so), never a price the door will not honour.
- Snapshots: `pricing_snapshot` carries `direct.waived`, `transport.waived_by`
  and `pricing_basis`; the invoice line carries `direct_surcharge_iqd` (0 when
  none or waived) beside `transport_commission_iqd` (0 when waived, for either
  reason). An order can therefore explain its own price after the cart is gone.

Validation errors (`OPTION_NOT_FOUND`, `COLOR_OPTION_MISMATCH`,
`TRANSPORT_REQUIRED`, `TRANSPORT_NOT_OFFERED`,
`TRANSPORT_COMMISSION_UNCONFIGURED`, `TRANSPORT_NOT_APPLICABLE`,
`WARRANTY_PLAN_NOT_FOUND`, `OPTION_INACTIVE`, `COLOR_INACTIVE`) reject the
selection server-side; the UI mirrors them but is never the enforcement.

## Worked examples (from the unit tests)

1. Base 100,000; option regular 120,000 selected → applied 120,000.
2. Option regular 120,000 with PRIME 115,000; colour regular 130,000 (PRIME
   null) → applied 130,000, PRIME 125,000: the colour's +10,000 is paid by
   every tier, inherited per-field from the option.
2b. Base 150,000 / 125,000 / 100,000, option +25,000, direct-sale premium
   100,000 → 175,000 / 150,000 / 125,000 for the item and 275,000 / 250,000 /
   **125,000** per unit — the PRO member is exempt from the premium.
3. Preorder, sea commission 15,000, free tier → unit subtotal 115,000.
3b. The same pre-order line paid **cash on delivery**, direct premium 50,000
   → 150,000 (base + premium; the commission steps aside); PRO → 100,000. The
   order is still `preorder_sea` with fourteen stages.
3c. A pre-order line with **no** direct premium paid cash on delivery →
   115,000, identical to prepaid: the commission stays (`pricing_basis:
   'preorder'`, `cod_reprices: false`). PRO → 100,000 (`waived_by: 'pro'`).
3d. The 3b line paid `cash` with a wallet that covers the whole 155,000 →
   re-priced as prepaid: 115,000 + 5,000 delivery = 120,000, all from the
   wallet, `due_on_delivery_iqd: 0`, `prepaid_by_wallet: true`. A wallet that
   covers only 70,000 of it stays COD-priced: 150,000, 85,000 due at the door.
4. PRO + air commission 25,000 + 2-year warranty 20,000, no PRO price →
   100,000 + 0 (waived) + 20,000 = 120,000.
4b. Printer 899,000 (PRIME 885,000 / PRO 799,000), extension +12 at 7.5 % →
   the fee is 67,425 for every tier (7.5 % of the REGULAR 899,000): free
   966,425 / PRIME 952,425 / PRO 866,425; +24 at 10 % → 89,900. Total
   coverage 24 / 36 months, frozen in the snapshot.
5. PRO with `explicit_only` policy and no explicit PRO price → pays the
   regular price; the UI shows no PRO discount.

## Snapshots

Each order line stores `pricing_snapshot` (the resolver output minus cost
fields — including `direct.waived`, `transport.waived_by` and
`pricing_basis`), `warranty_snapshot` and `transport_snapshot`; the order
stores `membership_tier_snapshot`, `exchange_rate`, `delivery_waived`,
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
