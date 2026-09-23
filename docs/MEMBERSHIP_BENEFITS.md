# Membership shopping benefits — what a PRO or PREMIUM membership is worth

Every commercial value PRO and PREMIUM shopping benefits are made of is a ROW
IN THE DATABASE, edited from the admin panel, and nothing in this system is a
constant in a React file or a branch on a tier name. An owner changes a
percentage, a threshold, a ceiling or a date, and the next order follows. No
deploy.

Migration `0074_membership_benefit_rules.sql`. The arithmetic is pure and lives
in `packages/pricing/src/membershipBenefits.ts`; the half that talks to D1 is
`worker/lib/membershipBenefits.ts`; the admin door is
`worker/routes/adminMembershipBenefits.ts`.

---

## 1. The rule

One table, `membership_benefit_rules`, holds three kinds of rule, told apart by
`benefit_type`:

| `benefit_type` | what it decides | the fields it uses |
| --- | --- | --- |
| `product_discount` | what a member pays for goods | `discount_mode`, `percent`, `fixed_iqd`, `max_discount_iqd`, `cap_scope`, `max_quantity`, `min_subtotal_iqd` |
| `free_shipping` | whether delivery is free, and on which methods | `free_shipping_threshold_iqd`, `shipping_methods`, `max_shipping_subsidy_iqd` |
| `cod_tax_exemption` | whether the cash-on-delivery tax is waived | `cod_tax_exempt` |

Every rule also carries: `tier` (`prime` = PREMIUM, `pro` = PRO), `scope`
(`global` / `category` / `sub_category` / `product`) with its target id,
`enabled`, `priority`, `valid_from`, `valid_until`, `label` and `notes`.

`plus` exists in the CHECK constraint and is refused at the admin door, because
PLUS holds no pricing or delivery entitlement
(`ENTITLEMENT_MINIMUM_TIER`): such a rule would save cleanly and then do
nothing at every checkout, forever, with nothing anywhere to say why.

### Precedence

**Product > sub-section > section > global.** Specificity is the OUTER sort;
`priority` only ever breaks a tie between rules at the SAME level. Letting
priority cross levels would mean a global rule with priority 99 silently
overriding the product override an owner typed for one printer.

**Exactly one rule applies per line.** Two membership discounts are never
summed. The totals would simply come out smaller than they should, on some
products, for some members, and nothing on any screen would say why.

**A section rule covers its whole branch.** The taxonomy has no fixed depth, so
a rule on "Printers" reaches a product filed under "Printers → FDM → Bambu".
The worker supplies the product's ancestry from the `catalogs` tree.

---

## 2. Where a rule is applied — and why there are two places

`isUnitExpressible(rule)` decides, and it is the only thing that decides.

* **A rule whose whole effect fits in a unit price** — a percentage, a fixed
  amount, either with a PER-UNIT ceiling — is baked into the price by
  `resolveUnitPrice`. The product page, the cart and the checkout then quote
  one number without any of them knowing that benefit rules exist.
* **A rule whose effect depends on the ORDER** — `max_quantity`, a per-ORDER
  ceiling, or `min_subtotal_iqd` — is deliberately kept OUT of the unit price
  and applied once, at the line, where the quantity and the order total are
  known. "The first two printers" is not a price. Letting such a rule into the
  unit price is how a cart ends up discounting the third printer it promised
  not to.

The resolver reports which happened per line as `applied_at: 'unit' | 'line'`.
A caller must subtract `total_iqd` exactly once, and only for `'line'`.

**A per-order limit is spent once per ORDER, not once per line.** A rule's
`max_discount_iqd` with `cap_scope: 'per_order'`, and its `max_quantity`, are
budgets shared by every cart line that rule covers (`orderLineBenefits`): two
different printers under one rule capped at 100,000 per order save 100,000
between them. The budget goes to the lines with the largest per-unit saving
first (ties in cart order), and each line carries the part it received, so
the per-line figures in `orders.benefit_snapshot` and `order_items` add up to
the clamped total. The cart says «الخصم بحد أقصى لكل طلب» and the subscription
page «حتى X لكل طلب» — the same meaning. Two different rules keep two budgets.

### The ladder

A typed `pro_price_iqd` or `prime_price_iqd` on any rung (product, option,
fulfilment, transport, colour) is the owner's answer for that exact product and
**wins over any rule**. Nothing is added together.

`clampMemberLadder` keeps PRO ≤ PREMIUM ≤ Regular. When exactly one side is
rule-derived, **the rule-derived side moves** — a store-wide rule never raises a
price somebody typed. Both typed keeps the historical clamp, because then an
inversion really is a data fault.

---

## 3. The free-shipping threshold is STRICTLY GREATER

75,000 does **not** qualify. 75,001 does.

This is the owner's confirmed rule and the comparison `quoteShipping` has
always used. The rules table changes WHAT the number is, never what comparing
against it means. Two engines with two operators would make the same basket
free on the product page and charged at the door.

### The basis

The figure a threshold is tested against is **the eligible merchandise
subtotal, AFTER product discounts (membership and coupon), BEFORE delivery and
before the cash-on-delivery tax**, which is the store's existing
`threshold_basis: 'merchandise_after_coupon'` default in `shippingPolicy`. The
PREMIUM rule is additionally tested after points, per the product-form §5 rule
that predates this system. Both are unchanged by these rules; they are written
down here because §12 asks for the basis to be stated, not changed.

### The subsidy ceiling

`max_shipping_subsidy_iqd` is optional. With no ceiling, an eligible member's
covered components are free. With a ceiling that BINDS — a 15,000 ceiling
against a 25,000 fee — the member pays the 10,000 difference, and **no component
claims to be free**: the waiver flags come off and the quote carries
`membership_subsidy_iqd` and `membership_subsidy_capped` instead. "Free
delivery" on a line the customer partly paid for is a lie an invoice cannot
survive.

---

## 4. The cash-on-delivery tax is calculated, then exempted

The existing engine (`packages/shipping/src/codTax.ts`, the admin-configured
rate per complete block of the amount payable at the door — `codTaxPerBlockIqd`
/ `codTaxBlockIqd` in `worker/lib/settings.ts`, 3,000 IQD per 500,000 IQD until
the owner changes them) is untouched and still runs on every order. The membership then waives it as a benefit, and **both
numbers are recorded**:

```
cod_tax_before_exemption_iqd   12,000     what the courier's cash sheet sees
cod_tax_exemption_iqd         -12,000     what the membership did
cod_tax_iqd                        0      what the customer pays
```

Whether a tier is exempt is a configured rule, never `if (tier === 'PRO')`. An
owner who switches the PRO exemption off switches it off here; one who switches
PREMIUM's on switches it on.

---

## 5. Stacking, against every other mechanism that reduces money

The store already had six. This is the order and the rule for each.

| mechanism | interaction with a membership benefit |
| --- | --- |
| **Typed member price** (`pro_price_iqd` / `prime_price_iqd`) | REPLACES the rule for that line. Never summed. |
| **Scheduled offer window** (`offer_windows`) | Replaces the LINE's regular price, then the member ladder is re-clamped against it (`resolveOfferPrice`). A member on an offer pays the better of the two, never both. |
| **Platform coupon** (`coupons`) | Applied AFTER the membership discount, against the merchandise the membership has already reduced. |
| **Points** | Applied after the coupon, capped at the eligible merchandise after both. |
| **Wallet** | A payment, not a discount. Applied last, before the COD tax. |
| **Merchant coupons** (`merchant_coupons`) | A different seller's checkout (`storeOrders.ts`). Membership benefits are LEVONIS-store benefits and do not reach it. |
| **Bundles / mystery offers** | A bundle's COMPONENTS carry the member's rule; the bundle's own price does not. A bundle price is already a composed discount over its parts, and a second percentage on the parent would discount the same goods twice. An owner who wants a bundle cheaper for members types a member price on the bundle, which still wins outright. |

The settlement order, unchanged from before this system except for where the
membership sits:

```
line prices (membership already inside, where the rule fits a unit price)
  → order-level membership discount   (only where it does not)
  → coupon
  → points
  → delivery (with its own membership waiver)
  → wallet
  → cash-on-delivery tax (with its own membership exemption)
```

---

## 6. An order is frozen, and never recalculated

Changing a rule tomorrow must not alter yesterday's order, so nothing ever
re-derives a sold order's totals from the live rules.

Every write to a rule appends a row to `membership_benefit_versions`, carrying
the actor, the action, the before and after, and the WHOLE rule set as it then
stood. Every order records:

| column | what it holds |
| --- | --- |
| `orders.benefit_version_id` | the configuration version this order was priced under |
| `orders.membership_discount_iqd` | the whole membership saving on merchandise |
| `orders.shipping_before_benefit_iqd` / `shipping_benefit_iqd` | the delivery fee, and what the membership took off it |
| `orders.cod_tax_before_exemption_iqd` / `cod_tax_exemption_iqd` | the tax as calculated, and as waived |
| `orders.benefit_snapshot` | the whole resolution as JSON: per line, per rule |
| `order_items.membership_discount_iqd` / `membership_rule_id` | what this line saved, under which rule |

---

## 7. Security

Nothing about a membership is ever taken from the browser. The tier comes from
`getTierStatus` against the memberships ledger; the section comes from the
product ROW, never from a cart payload; the discount is computed on the server
and never accepted from one; the free-shipping decision and the tax exemption
are resolved at settlement, from the rules, at the authoritative checkout.

A membership that has expired is refused at that moment, because
`getTierStatus` expires overdue rows before it answers. An active admin
restriction case on `proPricing`, `premiumPricing`, `freeDelivery`,
`premiumDelivery` or `codTaxExemption` pauses the matching benefit for that one
account, and a configured rule is consulted only after the entitlement agrees.

The admin API is `requireAdmin` on the main host only, and every write is
audited through `auditStatements` in the same batch as the rule itself, so a
price change cannot succeed unattributed.

---

## 8. The API

| route | what it does |
| --- | --- |
| `GET /api/admin/membership-benefits` | every rule, the current version id, and the field/unit schema |
| `POST` / `PUT /:id` / `DELETE /:id` | create, edit, remove — each appending a version and an audit row |
| `GET /api/admin/membership-benefits/versions` | who changed what, when, and what it was before |
| `POST /api/admin/membership-benefits/simulate` | "what would this cart cost" through the same functions the checkout uses; reads nothing from any account and writes nothing |
| `GET /api/memberships/plans` → `benefits` | what the store currently promises each tier, for the subscription page |
| `GET /api/cart` → `membership` | what the membership is worth on this cart, per line and in total, plus free-delivery eligibility per method |
| `POST /api/orders/quote` → `quote.membership_benefits` | the same, for the order about to be placed, with both COD tax numbers |
| `POST /api/products/:id/quote` → `membership_preview` | what PREMIUM and PRO would pay for THIS selection |

---

## 9. The initial defaults, and that they are only defaults

Migration 0074 seeds four rules so the store behaves as the owner described on
day one:

| rule | tier | value |
| --- | --- | --- |
| `seed-pro-free-shipping` | PRO | free delivery above 75,000 IQD, on standard AND personal |
| `seed-premium-free-shipping` | PREMIUM | free delivery above 100,000 IQD, on standard only |
| `seed-pro-cod-exempt` | PRO | exempt from the cash-on-delivery tax |
| `seed-premium-cod-exempt` | PREMIUM | NOT exempt (the owner can change this) |

**No product-discount rule is seeded.** A global "PRO 10% off" would discount
the entire catalogue on the first deploy, and a section rule cannot be seeded
because it must name sections whose ids a migration cannot know. The admin
screen offers a "recommended starting values" action («إضافة القيم المقترحة»
on the rules tab, `POST /api/admin/membership-benefits/recommended`) that
creates them against the sections that actually exist: PRO printers 10% up to
100,000 per unit, PRO materials 15%, PRO accessories 10%, and PREMIUM printers
a FIXED 25,000 per unit — the owner's «البريميوم خصم حتى 25,000 لكل وحدة على
الطابعات». Fixed, not "100% capped at 25,000": a fixed amount never exceeds the
unit's price anyway, so it already means "up to", and a 100% rule would read
as a free printer. It never overwrites a tier and section that has a rule.
Nothing is written on the click: `GET …/recommended` lists each rule (tier,
section, figure, live or off) in a confirmation dialog, and the POST carries
the keys the admin confirmed (a bare POST is refused). Only the two printer
rules — the owner's own figures — are created enabled; materials and
accessories are this file's guesses, so they are created DISABLED and
discount nothing until the owner turns them on.

**Per-product rules folded into one section rule.** The product editor and
the import write PRODUCT rules, so a store priced per printer ends up with one
row per printer saying the same thing. The rules tab lists them grouped by
tier, section and identical terms (`GET …/consolidation`) and offers
«تحويل إلى قاعدة قسم» (`POST …/consolidation` with the group key and the exact
rule ids shown). The conversion creates one section rule and deletes the
product rules in ONE batch with ONE version row (action `consolidate`, whose
`rules_json` is the set after the conversion, `before_json` the deleted
product rows and `after_json` the new section rule), an audit row per rule and
one `membership_benefit.consolidate` audit row. The batch is fenced: the
section rule is inserted only while the section has no live rule for that
tier, each product rule is deleted only if unchanged since it was read, and
the version row writes NULL into its NOT NULL `rules_json` (rolling the batch
back, answered 409 `CONSOLIDATION_STALE`) unless every planned rule is gone
and the section holds exactly the expected live rule. Every active product in the
section is priced before and after with `selectRule`: a product whose price
would change keeps its product rule, and the dialog says how many other
products in the section the new rule reaches. Refused when the section
already has a different ENABLED rule for that tier (a disabled one does not
count; an enabled identical one anywhere in the list makes the product rules
redundant and the action only deletes them), or when the terms carry a
per-order ceiling or quantity limit (N budgets would become one).

Every one of these numbers is editable, and none of them is a constant anywhere
in the code.

> **A commercial change to note.** The PREMIUM free-delivery threshold seeded
> here is 100,000 IQD, per the benefits mandate. The pre-existing
> `shippingPolicy.prime_threshold_iqd` default was 150,000. Once a PREMIUM
> free-shipping rule exists, the RULE decides. This is the mandate's stated
> initial default, not an accident of the wiring, and the owner can set it back
> to 150,000 in one field.
