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
