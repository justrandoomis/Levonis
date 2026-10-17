# Product discount — «سعر بعد الخصم» in the product form

Status: design spec for the build lanes (server, admin UI, customer UI, tests).
Owner request 2026-10-16: «في المنتجات لا يوجد هناك خانه (السعر قبل الخصم) لعمل تخفيض معين — مثلا السعر قبل الخصم 600$ بعد الخصم 500$ ويكون مثلا تخفيض».
Migration: **0197 only, additive** (0196 is reserved by a parallel lane). Ships through CI and workflow 7.
A new DECISIONS row (the next free number, 243 at the time of writing) records §1 when this lands.

## بالعربية باختصار

- السعر الحالي المنشور لكل موديل ولون هو «السعر قبل الخصم» تلقائيًا؛ لا خانة لسعر «قبل» يُكتب باليد.
- في القسم ٣ «الأسعار» بطاقة جديدة «تخفيض السعر»: يكتب المالك **السعر بعد الخصم بالدولار** (سعر واحد للمنتج، أو سعر لكل موديل) أو **نسبة الخصم**، مع بداية ونهاية اختياريتين، ويرى قبل الحفظ «قبل ← بعد» لكل موديل ولون بالدولار والدينار.
- الحفظ يكتب **صف العرض نفسه** الذي يكتبه تبويب «العروض الخاصة» (`offer_windows`) عبر الباب نفسه وتحققه نفسه؛ لا طريق خصم ثانٍ.
- الدولار يُحوَّل **بسعر الصرف نفسه** الذي نُشر به سعر ذلك الموديل، ويُقرَّب لأعلى ألف دينار كما يقرّب التسعير V2؛ فإذا تغيّر سعر الصرف تحرّك السعران معًا.
- الشطب صادق دائمًا: المشطوب هو السعر المنشور الفعلي في تلك اللحظة، وبجانبه «−17٪»؛ وإذا لم يكن السعر بعد الخصم أقل فلا شطب ولا شارة.
- السلة والطلب والفاتورة تحترم العرض وتعرض «قبل/بعد» بالعربية والإنجليزية والسورانية وبالدينار.

---

## 0. Scope

In scope:

1. The discount card in section ٣ «الأسعار» of the product form (V2 products).
2. A dollar sale price that follows the exchange rate: migration 0197 and the resolver change.
3. Honesty rules: the struck price, the «−N٪» badge, members and offers together.
4. The customer side: card, product page, cart, checkout, order, invoice and email.
5. The tests to write, including one real-browser run.

Not in scope: price protection, trade-in «today's price», coupons, bundles and mystery offers (they keep dinar offers), the merchant storefront's `compare_at_iqd`. See §14.

---

## 1. Decisions

### 1.1 The owner's (asked and answered in this session)

| # | Decision |
|---|---|
| O1 | The product's **current** price is the before price, automatically. Nobody types a before price. |
| O2 | The owner enters the price **after** the discount, in USD (e.g. $500), **or** a percent. Start and end are optional. |
| O3 | It is a **real** offer: the cart, the order and the invoice honour it. |
| O4 | The strikethrough is always honest. |
| O5 | It is in dollars and follows the exchange rate. |

### 1.2 The designer's (this spec)

| # | Decision | Why |
|---|---|---|
| D1 | **One model, one row, one door.** The card reads and writes the same `offer_windows` + `offer_limits` row for the subject `('product', id)` that the «العروض الخاصة» tab writes, through `PUT /api/admin/offers/:productId` and its validation. The card adds no table of its own, and no product-save path touches offers. | worker/lib/offers.ts header: "no second discount code path". `MembershipDiscountSection.tsx` sets the same precedent for benefit rules. |
| D2 | **A new price mode `fixed_usd`.** Its dollar prices live in a new child table `offer_usd_prices` (0197): either one row for the whole product (`model_id = ''`) or one row per model. A model with no row is not on sale. | Products with Standard and Combo models are common, and one dollar price cannot fit both. Keeping the prices in a child table means `offer_windows` gets no ALTER, and older code keeps writing it unchanged. |
| D3 | **Conversion.** The after price on direct sale is `ceil₁₀₀₀(usd × U_sku)`. `U_sku` is the `usd_iqd_rate` of **that SKU's own published V2 row**. The rounding is the same `ceilStep` and the same 1,000 step that Pricing V2 uses for the published price (§4.4). Each pre-order channel keeps the **same IQD saving** as direct. | Before and after use one rate from one write, so they always move together. The pre-order rule is docs/PRICING-V2.md §5.5 ("offers move D and P together … P stays Δ below it"), expressed in published figures only. |
| D4 | **Never ≥ before.** If a window's price for a line is not strictly below that line's regular price, the window contributes no price. There is no strike, no badge and no error, and the line sells at its regular price. | O4. |
| D5 | **Floors are the existing ones.** At save, a route that would fall to ≤ 0 is refused. At read time, a line below the floor does not sell (`DERIVED_PRICE_BELOW_FLOOR` + `OFFER_INACTIVE`, unchanged). | offers.ts `resolveOfferPrice` §4.3 rule. No new floor. |
| D6 | **Below cost: warn the owner, never refuse, never move, never lift.** The owner's preview flags «تحت التكلفة». An editor's save rings the owner's bell with the product name only and no figure. The editor's own answer says nothing. | DECISIONS row 222 Q3 says a typed dollar price below cost + minimum profit saves with a warning. Q1 says never lift a price to cost, because that reveals the cost. A refusal shown to an editor would work as a cost oracle (worker/lib/pricingEngine/v2/bell.ts). |
| D7 | **Roles.** On a cost-first product, `fixed_usd` is owner-only (`403 PRICING_V2_OWNER_ONLY {section: 3}`), as it is for every V2 price write there. A percent offer is open to whoever may use the offers tab today. | worker/lib/pricingEngine/v2/api.ts role rules. The editor never sees dollars on a cost-first product (dto.ts). |
| D8 | **Percent maths is unchanged.** It stays `floor(regular × (100 − p) / 100)` on each line's published price. | Live percent offers keep their exact numbers. The published price already follows the rate. |
| D9 | **Badge = `round((before − applied) × 100 / before)`.** It is computed on the server, for the viewer, from the two IQD numbers printed beside it, and shown only when ≥ 1. | This is the house rounding of `BundleSavingLine`. The owner's example ($600 → $500) reads «−17٪». |
| D10 | **Precedence is unchanged.** A live offer replaces the regular price. Member rungs are clamped to ≤ the offer price, so a member pays the lower of the two and the discounts never stack. A coupon applies afterwards, as today. One label fix: see §9. | offers.ts `resolveOfferPrice`, and row 223 decision 5 ("one discount per line"). |
| D11 | **Times are Baghdad time.** That is the zone `normalizeUtc` reads a zone-less `datetime-local` value in. | The same rule the server already applies (offers.ts `normalizeUtc`). |
| D12 | **Lost updates are refused.** A save may carry `expected_updated_at`. A fence in the same batch refuses with `409 SPECIAL_OFFER_CHANGED` if the row moved. | The tab and the card edit one row. The house fence is worker/lib/operations.ts `fence`/`isFenceMiss`. |

---

## 2. What exists, and the defects this work fixes

Code read for this spec:

- `migrations/0060_offer_eligibility.sql`: the offer tables.
- `worker/lib/offers.ts`: `resolveOfferPrice`, `applyOfferToResolved`, `loadOffers`, `offerWindowStatements`, `normalizeUtc`.
- `worker/routes/offers.ts`: the admin door, `OFFER_PRICE_CONFLICT`, `SCHEDULE_INVERTED`, the floors, and `v2Managed(3)` for a typed dinar price on an ordinary product.
- `src/components/adminOffers/AdminOffers.tsx`.
- `worker/routes/products.ts`:
  - card projection;
  - `withLiveOffer`;
  - `pricingModes`;
  - `discountedWhere`;
  - listing items.
- `worker/routes/cart.ts` `resolveCartLine` and `worker/routes/orders.ts` `priceLines`: the offer snapshot.
- `worker/lib/customerPricing.ts`: the customer allow-list.
- `packages/pricing/src/pricing.ts`: `ResolvedPrice`, the SKU rung, `clampMemberLadder`.
- `packages/pricing/src/priceV2.ts`: D, P and the rounding.
- `migrations/0189_pricing_v2_core.sql`: `pricing_v2_sku_results`.
- `worker/lib/productOverlay.ts`: `skuRowsV2Sql`, `SKU_ROW_LIVE_V2`.
- `worker/lib/pricingEngine/v2/{api,dto,bell,write}.ts` and `autoReprice.ts`.
- `src/components/CardPrice.tsx`, `src/components/home/ProductCard.tsx`, `src/components/home/FlashDealsBoard.tsx`, `src/components/bundles/BundleSavingLine.tsx`, `src/components/ui/{OfferBadge,Countdown}.tsx`.
- `src/pages/{Product,Cart,Checkout,OrderDetail}.tsx`.
- `worker/lib/invoices.ts`.
- `src/components/adminProducts/form/{MembershipDiscountSection.tsx,v2/*}`.

Defects found on the way. Each is fixed by this spec, and the section that fixes it is named:

| # | Defect | Where | Fixed in |
|---|---|---|---|
| F1 | **A live offer never shows a struck price anywhere.** `resolveOfferPrice` returns the offer price as `regular_iqd`, and every surface strikes `regular` only when `applied < regular`. A guest therefore sees 750,000 with no 900,000 and no badge, which breaks the card's own §4 promise. | offers.ts `resolveOfferPrice` / `applyOfferToResolved`; CardPrice, Product.tsx, Cart.tsx | §4.6, §8 |
| F2 | The card applies the window to the **cheapest level only**. That is correct for a percent, which is monotone, and wrong for a per-model price. | products.ts card projection (`best`, then one `applyOfferToResolved`) | §8.2 |
| F3 | `/api/admin/offers` **purges no cache**. `purgeCatalogueAfterWrite` is mounted on the product and benefit routers only. After an offer save a guest sees the old price for up to `s-maxage`, while the cart already charges the new one. | worker/routes/offers.ts, worker/lib/edgePolicy.ts | §5.5 |
| F4 | The offers tab prints the stored UTC instant into a `datetime-local` field as if it were local time: 12:00 Baghdad shows as 09:00. | AdminOffers.tsx `toLocalInput` | §7 |
| F5 | A member whose rule price was clamped **up** to the offer price is labelled «سعر PRO» on what is really the offer price. | offers.ts `applyOfferToResolved` `applied_tier` | §9 |
| F6 | Two compact-card strings have no Sorani: «لأعضاء» and «بدل». This breaks row 183. | CardPrice.tsx `CompactPrice` | §8.9 |
| F7 | `/api/products?type=discounted`, the flash board's «عرض الكل», lists membership discounts and never a live offer. | products.ts `discountedWhere` | §8.8 |
| F8 | The product page shows no countdown for a live offer; only cards and flash deals do. | Product.tsx | §8.3 |

---

## 3. Data — migration `0197_offer_usd_prices.sql`

```sql
-- 0197 — DOLLAR SALE PRICES FOR THE ONE PROMOTION MODEL (docs/ux/PRODUCT-DISCOUNT.md §3)
--
-- A window whose offer_price_mode is 'fixed_usd' (offer_windows.offer_price_mode has no CHECK, so the
-- new value needs no ALTER) takes its price from these rows: ONE row for the whole product
-- (model_id = '') OR one row per model (the first option value in relation order, the id Pricing V2
-- calls model_id). Never both. A model without a row is not on sale. Cents are whole numbers; the
-- resolver turns them into dinars with the SKU's own V2 rate (worker/lib/offerUsd.ts).
-- Additive only: a new table and a trigger; no row of any existing table is touched. INERT until a
-- 'fixed_usd' window exists. An older Worker never reads it.
CREATE TABLE IF NOT EXISTS offer_usd_prices (
  subject_type    TEXT NOT NULL CHECK (subject_type = 'product'),
  subject_id      TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 60),
  model_id        TEXT NOT NULL DEFAULT '' CHECK (length(model_id) <= 120),
  price_usd_cents INTEGER NOT NULL CHECK (typeof(price_usd_cents) = 'integer' AND price_usd_cents BETWEEN 1 AND 10000000),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (subject_type, subject_id, model_id)
);

-- One scope per subject: the whole-product row or model rows, never both (the route refuses first;
-- this is the backstop for any other writer).
CREATE TRIGGER IF NOT EXISTS offer_usd_prices_one_scope BEFORE INSERT ON offer_usd_prices
WHEN EXISTS (SELECT 1 FROM offer_usd_prices o
              WHERE o.subject_type = NEW.subject_type AND o.subject_id = NEW.subject_id
                AND (o.model_id = '') <> (NEW.model_id = ''))
BEGIN SELECT RAISE(ABORT, 'OFFER_USD_SCOPE_MIXED'); END;
```

Notes:

- $100,000.00 = 10,000,000 cents. This is `V2_MAX_USD`, the 0189 ceiling.
- `typeof = 'integer'` refuses a binary float.
- No backfill and no index beyond the primary key: every read is by subject.
- `scripts/migrate-check.mjs --twice` must pass.
- `tests/sqlSplit.test.ts` rules apply.
- The whole set for a subject is always rewritten in one batch: a DELETE of the subject's rows, then the INSERTs (§5.3). The trigger therefore never fires on a legitimate save.

---

## 4. The resolver

### 4.1 Types

In **`worker/lib/offers.ts`**:

- `OfferWindow.offer_price_mode` becomes `'' | 'fixed' | 'discount_percent' | 'discount_iqd' | 'fixed_usd'`.
- `OfferWindow` gains `usd_prices: ReadonlyArray<{ model_id: string; cents: number }>`. It is `[]` for every other mode, and also when 0197 is absent.
- `windowFromRow` keeps `'fixed_usd'`. Unknown modes still read as `''`.
- `offerWindowStatements` accepts `'fixed_usd'` and binds the three IQD price columns as NULL for it.

In **`packages/pricing/src/pricing.ts`** (optional fields only; the merchant storefront ignores them):

```ts
// on SkuPriceRow — V2 rows only, filled by the overlay (§4.3). Server-side; a FINANCIAL_FIELDS key.
usd_iqd_rate?: string;

// on ResolvedPrice
/** The SKU rung that priced this line; null/absent when the ladder did. Server identity for the
 *  offer resolver; never in a customer payload (allow-lists). */
sku?: { combo_key: string; channel: SkuChannel; model_id: string | null } | null;
/** The line's regular price immediately before a live offer replaced it. Set by applyOfferToResolved
 *  only when the offer lowered it (§4.5). Frozen into order_items.pricing_snapshot with the rest. */
offer_before_iqd?: number;
```

`resolveUnitPrice` sets `sku` when the SKU rung answered (`skuRegular !== null`):

```ts
{ combo_key: skuKey, channel: skuChannel, model_id: option?.id ?? null }
```

`option.id` is the first option value in relation order: the cart passes `valueIds[0]`, and the card passes `skuLevelResolveInput(...).optionId`. That is the same id `evaluate.ts` calls `model_id`.

### 4.2 Where the rate comes from

The published before price of a V2 SKU is `product_sku_prices.regular_price_iqd`. A row counts only while its private twin in `pricing_v2_sku_results` says the same price (`SKU_ROW_LIVE_V2`). That twin row holds the rate the price was computed at (`usd_iqd_rate`, text). The writer (`v2WriteStatements`), including `autoReprice`, rewrites the two rows **in one batch** for each product.

So **the rate of the SKU's own row is the rate of its published price at this instant.** During a reprice wave, a product not yet repriced keeps its old rate for both before and after. The central rate is **never** used here.

### 4.3 The overlay carries the rate

`worker/lib/productOverlay.ts` `skuRowsV2Sql` gains one correlated scalar, with the same correlation as `SKU_ROW_LIVE_V2`:

```sql
(SELECT r.usd_iqd_rate FROM pricing_v2_sku_results r
   JOIN product_pricing_state s ON s.product_id = r.product_id AND s.mode = 'engine' AND s.pricing_method IS NOT NULL
  WHERE r.product_id = product_sku_prices.product_id
    AND r.combo_key = CASE product_sku_prices.combo_key WHEN 'o:*' THEN '' ELSE product_sku_prices.combo_key END
    AND r.channel = product_sku_prices.channel
    AND r.final_price_iqd = product_sku_prices.regular_price_iqd) AS usd_iqd_rate
```

`skuFields` copies `usd_iqd_rate` onto V2 rows only. The V1 fallback read has none, so `fixed_usd` prices nothing there and the result is an honest "no sale".

`sku_prices` is never projected to a customer (`projectPublic` lists fields). `usd_iqd_rate` is already in `FINANCIAL_FIELDS`, so any admin echo is stripped for non-owners. A leak test pins both (§12).

### 4.4 The pure conversion — `worker/lib/offerUsd.ts`

```ts
export type FixedUsdAnswer =
  | { kind: 'price'; regular_iqd: number }   // the line's offer regular price
  | { kind: 'none' }                          // no sale on this line (see the list below)
  | { kind: 'below_floor' };                  // the route would reach 0 or less

export function fixedUsdLine(i: {
  cents: number | null;       // the SKU's model row, else the '' row, else null
  rate: string | null;        // usd_iqd_rate of the SKU's direct_sale row
  directIqd: number | null;   // the SKU's published direct_sale price (the before price on direct)
  channelIqd: number;         // the published price of the line's own channel (= directIqd on direct)
}): FixedUsdAnswer
```

The steps:

1. If `cents`, `rate` or `directIqd` is null, the answer is `none`. This covers four cases: a model with no row, a SKU that does not sell direct, a V1 or missing rate, and a missing 0197.
2. Compute `afterDirect = ceilStep(mulProcurementExact({ num: BigInt(cents), den: 100n }, procurementExact(rate)), ROUNDING_STEP_IQD)`.
   - This is exact BigInt rational arithmetic.
   - It uses the same `ceilStep` and `ROUNDING_STEP_IQD` from `packages/pricing/src/costToPrice.ts` that `priceProductV2` publishes D with.
   - No JS float is ever produced: cents are an integer and the rate is decimal text.
3. If `afterDirect >= directIqd`, the answer is `none` (D4).
4. Compute `saving = directIqd − afterDirect`. It is a positive multiple of 1,000, because both prices are multiples of the step.
5. Compute `regular = channelIqd − saving`.
   - For a direct line or a COD pre-order priced as direct, this is `afterDirect`.
   - For a prepaid pre-order route it is the same saving off P.
   - If `regular < 1`, the answer is `below_floor`.
6. Otherwise return `{ kind: 'price', regular_iqd: regular }`.

**Worked numbers.** Price-first P1S $600 and Combo $750. Pre-order discount Δ = $50 on land.

| U | Line | Before | Offer typed | After | Badge |
|---|---|---|---|---|---|
| 1,500 | P1S direct | 900,000 | $500 | ceil(750,000) = **750,000** | −17٪ (16.67) |
| 1,500 | P1S land prepaid | 825,000 | — | 825,000 − 150,000 = **675,000** | −18٪ |
| 1,500 | Combo direct | 1,125,000 | $640 | **960,000** | −15٪ (14.67) |
| 1,500 | Combo land | 1,050,000 | — | 1,050,000 − 165,000 = **885,000** | −16٪ |
| 1,530 after the real reprice | P1S direct | 918,000 | $500 | ceil(765,000) = **765,000** | −17٪ |
| 1,530 after the real reprice | P1S land | 842,000 | — | 842,000 − 153,000 = **689,000** | −18٪ |
| 1,530 after the real reprice | Combo direct | 1,148,000 | $640 | ceil(979,200) = **980,000** | −15٪ |
| 1,527.5 | P1S direct | 917,000 | $500 | ceil(763,750) = **764,000** | −17٪ |
| 1,500 | P1S direct | 900,000 | $599.50 | ceil(899,250) = 900,000 ≥ before → **no sale** | — |
| 1,500, mid-wave (central rate 1,530 approved, P1S not yet repriced) | P1S direct | 900,000 | $500 | **750,000**, using its own row's 1,500 | −17٪ |

### 4.5 `resolveOfferPrice`

The input gains `usd?: FixedUsdAnswer`, which `applyOfferToResolved` computes.

- **`fixed_usd`:**
  - `price` sets `regular = usd.regular_iqd`.
  - `none` (or no `usd`) returns the ladder with **no** error: no sale, and the line sells normally.
  - `below_floor` returns the ladder with `errors: ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE']`. These are the existing semantics: the line does not sell.
- **New, for every mode (D4):** after `regular` is derived, and before the floor check, `if (regular >= base.regular_iqd)` return the ladder with no error.
  - In practice only `fixed_usd` can reach this rule. A percent and an amount off always lower the price.
  - A typed dinar `fixed` price on an ordinary product is refused since the clean start, and older windows of that kind are suspended.
  - Compositions never come through here: they have their own mirror, §4.7.
- Member clamping is unchanged. The `applied_tier` label is fixed in §9.

### 4.6 `applyOfferToResolved`

```ts
applyOfferToResolved(resolved, view, tier, tierActive, nowMs, doc?: { sku_prices?: readonly SkuPriceRow[] | null })
```

- For a `fixed_usd` window it builds the `FixedUsdAnswer` from three inputs:
  - `resolved.sku`, which gives the combo, the channel and the model;
  - the SKU's `direct_sale` row and the channel row in `doc.sku_prices`, which give the before price, the channel price and the rate;
  - `view.window.usd_prices`: the model row first, else the `''` row.
- When the result is `source: 'offer'`, it sets `offer_before_iqd = resolved.regular_iqd`, the pre-offer channel price, on the returned `ResolvedPrice`. By §4.5 that price is always strictly higher than the offer regular.
- Every caller passes its doc:
  - `withLiveOffer` (product page, quote, pills, public API `purchase`);
  - the card projection;
  - `resolveCartLine` (cart.ts);
  - `priceLines` (orders.ts).
- A caller that omits `doc` gets `none` for `fixed_usd`: never a guessed price. A static test lists the call sites and fails if one omits it.
- **The scope rule is re-applied at read time.** The door saves a `''` row only while every SKU sells direct at one price, and a model row only while that model's colours share one (§5.3 step 4). A later V2 save (a model repriced, a model added, a colour given a +$ delta) runs no offer check, so `fixedUsdAnswerFor` checks again on the live published rows of the line's document: a scope whose live direct rows carry more than one price prices **nothing** (`none`: no sale, no strike, no error). The product sells at its published prices, and the card's preview of the stored set shows the door's refusal (`OFFER_USD_PER_MODEL` / `OFFER_USD_MIXED_PRICES`) to the owner the moment the form's V2 write moves.

### 4.7 Loading, and the bundle mirror

- `loadOffers` reads windows exactly as today. If any window has mode `fixed_usd` and `offerUsdInstalled(db)`, it adds **one chunked read** of `offer_usd_prices` for those subjects. A missing table gives `[]`, so those windows price nothing.
- `offerUsdInstalled(db)` is a presence probe in the `catalogKnowledgeInstalled` shape: one statement per binding while unknown, none once present, and a 60 s recheck when absent.
- `worker/lib/bundleRead.ts`: `windowPrices` becomes true only for `fixed | discount_percent | discount_iqd`. `fixed_usd` is refused on compositions (§5.3), and this keeps a stray row inert.

---

## 5. The admin API (worker/routes/offers.ts)

### 5.1 `GET /api/admin/offers/:productId` (extended) and `GET /api/admin/offers`

- `windowView` gains `offer_usd_prices: Array<{ model_id: string; usd: string }>`, with `usd` as 2-decimal text such as `"500.00"`.
- The list reads the prices with one grouped LEFT JOIN, through two SQL variants on `offerUsdInstalled`.
- The single read also answers a **`discount`** block, which is the card's read model:

```ts
interface DiscountRead {
  usd_supported: boolean;                 // 0197 present
  published: boolean;                     // V2 method set AND V2 results exist (not «يحتاج تسعيرًا»)
  composition: boolean;                   // a bundle or mystery offer: the card does not render
  viewer: 'owner' | 'editor';             // v2ViewerOf(env, user)
  method: 'cost' | 'usd' | null;
  usd: {
    available: boolean;
    reason: null | 'NOT_INSTALLED' | 'NOT_PUBLISHED' | 'OWNER_ONLY' | 'NOT_DIRECT' | 'MIXED_PRICES';
    scopes: Array<'product' | 'model'>;   // which USD scopes are possible (§5.3 step 4)
  };
  models: Array<{ model_id: string; names: { ar: string; en: string; ckb: string }; uniform: boolean; direct: boolean }>;
  rows: Array<{                           // every published, LIVE V2 SKU × channel
    combo_key: string;
    model_id: string | null;
    names: { ar: string; en: string; ckb: string };   // model · colour, as the V2 table names them
    channel: 'direct_sale' | 'pre_order_land' | 'pre_order_sea' | 'pre_order_air';
    before_iqd: number;                   // product_sku_prices.regular_price_iqd
    before_usd: string | null;            // see below
    before_usd_exact: boolean;            // true price-first (typed dollars), false cost-first (≈)
  }>;
  write_seq: number;                      // the V2 write it was read at (the card refetches when it moves)
}
```

How `before_usd` is filled:

- It is the row's `usd_ceil6`, the V2 writer's "display, audit" figure, shown to 2 decimals. On a price-first product this is exactly the typed D or P.
- The **owner** always gets it.
- An **editor** gets it only when `method === 'usd'`. That is the rule behind `V2_STAFF_SEES_USD` and `editor_usd_price`: never on a cost-first product.

The answer never carries:

- `usd_iqd_rate`;
- `exact_iqd`, `direct_exact_iqd`, `replacement_*`, `target_*`;
- any `v2_*` key;
- any cost.

### 5.2 `POST /api/admin/offers/:productId/preview` (new; writes nothing)

- The body is the PUT body.
- It runs the **same** `readOffer` and checks 1–7 of §5.3.
- It answers `{ rows: PreviewRow[], issues, warnings }`.
- It writes nothing, audits nothing and purges nothing.

```ts
interface PreviewRow extends DiscountRead['rows'][number] {
  after_iqd: number | null;               // null: no sale on this row
  after_usd: string | null;               // fixed_usd: the typed price; percent: ceil-to-cent(after_iqd ÷ U), ≈; null where before_usd is null
  offer_saving_percent: number | null;    // D9, non-member viewer
  state: 'lowered' | 'not_lower' | 'not_covered' | 'below_floor';
  owner?: { below_cost: boolean; below_min_profit: boolean };   // the owner's answer only (D6)
}
```

**The preview prices with the resolver itself.** For each published SKU × channel it does three things:

1. It resolves the line exactly as the cart would: `resolveUnitPrice` with the SKU's selection and channel, at the non-member tier.
2. It applies the **draft** window through `applyOfferToResolved`, with the schedule forced to `live`.
3. It reads `regular_iqd` and `offer_before_iqd`.

It is not a second implementation.

How the owner flags are computed:

- `below_cost`: the after price is below `replacement_cost_iqd` of that channel's row, where one is known. Cost-first always has one; price-first has one when its cost inputs are complete.
- `below_min_profit`: cost-first direct rows only. It compares against `replacement_cost_iqd + target_profit_usd × U` of the same row.

### 5.3 `PUT /api/admin/offers/:productId`: what changes

**`readOffer`** accepts:

- `offer_price_mode: 'fixed_usd'`;
- `offer_usd_prices?: Array<{ model_id: string; usd: string }>`. Absent means keep the stored set (when the mode stays `fixed_usd`). Present means replace the set;
- `expected_updated_at?: string | null`. Absent means no check (today's behaviour). `null` means "I saw no row". A string means "I saw this stamp".

**Checks, in order** (each is a `{ code, message, ar, en, ckb }` issue, §5.8):

1. Subject exists. Existing.
2. `SCHEDULE_INVERTED`. Existing.
3. A typed dinar `fixed` or a `plus_price_iqd` on an ordinary product returns `v2Managed(3)`. Existing.
4. `fixed_usd` only:
   - `offerUsdInstalled`, else `409 OFFER_USD_NOT_INSTALLED`.
   - The product is ordinary (`composition = ''`), else `400 OFFER_USD_ORDINARY_ONLY`.
   - The product is V2-published, else `409 OFFER_USD_NOT_PRICED`.
   - Method is `cost` and the viewer is an editor: `403 PRICING_V2_OWNER_ONLY {section: 3}` (D7; the existing code and sentences in `packages/contracts/src/costRefusals.ts`).
   - The set is required. Absent with no stored set gives `OFFER_PRICE_INCOMPLETE` (existing code).
   - Each `usd` is parsed with `parseV2Usd`: > 0, ≤ 2 decimals, ≤ 100,000. Else `OFFER_USD_PRICE_SHAPE`. A JSON number is refused too, because `noFloat` throws.
   - One scope only: a `''` row alone, or model rows only. Else `OFFER_USD_SCOPE_MIXED`.
   - Every `model_id` is a live model of the product. Else `OFFER_USD_MODEL_UNKNOWN`.
   - The rule for `''`: every live V2 SKU sells direct, and all direct rows share one `direct_exact_iqd`.
     - If models differ, refuse with `OFFER_USD_PER_MODEL`.
     - If colours of one model differ, refuse with `OFFER_USD_MIXED_PRICES`.
     - If a SKU has no direct row, refuse with `OFFER_USD_NOT_DIRECT`.
   - The rule for a model row: every live SKU of that model has a direct row (else `OFFER_USD_NOT_DIRECT`), and they share one `direct_exact_iqd` (else `OFFER_USD_MIXED_PRICES`).
5. Percent and amount off: the existing `OFFER_PRICE_INCOMPLETE`, `BUNDLE_DISCOUNT_EXCEEDS_TOTAL` and `OFFER_PRICE_BELOW_FLOOR`.
6. `OFFER_PRICE_CONFLICT`. Existing.
7. **The preview of §5.2 on the stored published rows.** This applies to `fixed_usd` and percent alike.
   - If the mode prices and no row is `lowered`: `400 OFFER_NOT_LOWER`.
   - If any row is `below_floor`: `400 OFFER_ROUTE_BELOW_FLOOR`.
   - If some rows are `not_lower`: warning `OFFER_PARTLY_NOT_LOWER`.
   - Owner only: if any `below_cost` or `below_min_profit`, warning `OFFER_BELOW_COST`.
8. **One batch**, in this order:
   - `fence(db, …)` on `expected_updated_at`, when sent. The condition is `(SELECT updated_at FROM offer_windows WHERE subject …) IS ?`, with NULL meaning "no row".
   - `offerWindowStatements(...)`. Unchanged apart from the mode list.
   - `offerUsdStatements(...)`, only when installed: `DELETE FROM offer_usd_prices WHERE subject …`, then INSERT the set when the mode is `fixed_usd`. Any other mode leaves the set empty.
   - The audit (`offer.update`, with `offer_usd_prices` in before and after, as USD text).
   - When the viewer is an **editor** and any row is `below_cost`: the owner's bell (§5.7).
   - A fence miss gives `409 SPECIAL_OFFER_CHANGED` (`isFenceMiss`). Nothing is written.
9. **Answer:** `{ offer (windowView + offer_usd_prices), warnings, rows: PreviewRow[] }`. The owner's rows carry `owner`; nobody else's do.

### 5.4 `DELETE /api/admin/offers/:productId`

The batch removes:

- the window;
- the limits;
- **and the `offer_usd_prices` rows**, when installed.

Redemptions are kept, as today. `worker/lib/productDeletion.ts` also deletes the subject's `offer_usd_prices` rows, tolerating the table's absence.

### 5.5 Cache (F3)

- Mount `purgeCatalogueAfterWrite` on `adminOffersRoutes`.
- `writeOffer` and DELETE call `c.set('catalogueSlug', slug)`.
- The middleware's skip rule extends from `/pricing/preview$` to also skip `/api/admin/offers/<id>/preview`. A preview writes nothing.

### 5.6 Audit

The `offer.update` detail gains `offer_usd_prices`, and nothing else new.

USD offer prices are typed prices, not cost. Admins who can open the offers tab may read them. The accepted risk that a staff member can work out the rate (row 222 Q2) is unchanged.

### 5.7 The owner's bell (D6)

The model is `bell.ts` `belowMinProfitBell`.

- Event: `pricing.offer.below_cost`.
- Kind: `fx_attention`, which every other reader's bell already hides.
- Content: the product id and name only, never a figure.
- Link: `/admin?tab=products&edit=<id>&section=3`.
- Event key: `pricing.offer.below_cost:<id>:<window updated_at>`.
- Sentences:

| | ar | en | ckb |
|---|---|---|---|
| title | تخفيض تحت التكلفة | A sale below cost | داشکاندنێک لە خوار تێچوو |
| body | حُفظ تخفيض يبيع منتجًا تحت تكلفته. التخفيض محفوظ ومعروض للزبائن؛ راجعه في قسم «الأسعار». | A sale that sells a product below its cost was saved. It is saved and on sale; review it in the Prices section. | داشکاندنێک پاشەکەوت کرا کە بەرهەمێک لە خوار تێچووەکەی دەفرۆشێت. پاشەکەوت کراوە و بۆ کڕیاران دیارە؛ لە بەشی «نرخەکان» پێیدا بچۆرەوە. |

### 5.8 New refusals and warnings

Each is added to `ISSUES` in offers.ts and to `src/lib/refusalStrings.ts`. `tests/refusalStrings.test.ts` checks that no ckb slot copies the Arabic.

| Code | HTTP | ar | en | ckb |
|---|---|---|---|---|
| OFFER_USD_NOT_INSTALLED | 409 | سعر الخصم بالدولار غير متاح بعد على قاعدة البيانات هذه — نسبة الخصم تعمل | a dollar sale price is not available on this database yet — a discount percent works | نرخی داشکاندن بە دۆلار هێشتا لەم بنکەدراوەیە بەردەست نییە — ڕێژەی داشکاندن کار دەکات |
| OFFER_USD_ORDINARY_ONLY | 400 | سعر الخصم بالدولار للمنتجات العادية فقط — الباقات والعروض الغامضة تُسعَّر بالدينار | a dollar sale price is for ordinary products only — bundles and mystery offers are priced in dinars | نرخی داشکاندن بە دۆلار تەنها بۆ بەرهەمە ئاساییەکانە — پاکێج و ئۆفەرە نهێنییەکان بە دینار نرخ دەدرێن |
| OFFER_USD_NOT_PRICED | 409 | انشر أسعار المنتج أولًا؛ يُحسب الخصم من السعر المنشور | publish the product's prices first; the sale is taken from the published price | سەرەتا نرخەکانی بەرهەمەکە بڵاو بکەرەوە؛ داشکاندن لە نرخی بڵاوکراوە دەکرێت |
| OFFER_USD_PRICE_SHAPE | 400 | اكتب السعر بالدولار أكبر من صفر، برقمين عشريين على الأكثر، حتى 100,000 | enter the dollar price above zero, with at most two decimals, up to 100,000 | نرخەکە بە دۆلار لە سفر زیاتر بنووسە، بە زۆرترین دوو ژمارەی دەیی، تا 100,000 |
| OFFER_USD_SCOPE_MIXED | 400 | سعر واحد للمنتج كله أو سعر لكل موديل — لا الاثنان معًا | one price for the whole product or a price per model — not both | یەک نرخ بۆ هەموو بەرهەمەکە یان نرخێک بۆ هەر مۆدێلێک — نەک هەردووکیان |
| OFFER_USD_MODEL_UNKNOWN | 400 | أحد الموديلات ليس من موديلات هذا المنتج | one of the models is not a model of this product | یەکێک لە مۆدێلەکان مۆدێلی ئەم بەرهەمە نییە |
| OFFER_USD_PER_MODEL | 400 | موديلات هذا المنتج بأسعار مختلفة — اكتب سعرًا لكل موديل | this product's models have different prices — enter a price for each model | مۆدێلەکانی ئەم بەرهەمە نرخی جیاوازیان هەیە — نرخێک بۆ هەر مۆدێلێک بنووسە |
| OFFER_USD_MIXED_PRICES | 400 | ألوان هذا الموديل بأسعار مختلفة، فلا يصلح لها سعر واحد بعد الخصم — استعمل نسبة الخصم | this model's colours have different prices, so one price after the discount cannot fit them — use a discount percent | ڕەنگەکانی ئەم مۆدێلە نرخی جیاوازیان هەیە، بۆیە یەک نرخی دوای داشکاندن بۆیان ناگونجێت — ڕێژەی داشکاندن بەکاربهێنە |
| OFFER_USD_NOT_DIRECT | 400 | هذا الموديل لا يُباع بيعًا مباشرًا، فلا يوجد سعر حالي واحد يُخفَّض منه — استعمل نسبة الخصم | this model is not sold direct, so there is no single current price to discount from — use a discount percent | ئەم مۆدێلە ڕاستەوخۆ نافرۆشرێت، بۆیە یەک نرخی ئێستا نییە بۆ داشکاندن — ڕێژەی داشکاندن بەکاربهێنە |
| OFFER_NOT_LOWER | 400 | السعر بعد الخصم ليس أقل من السعر الحالي — لا يُعرض خصم لا يخفّض شيئًا | the price after the discount is not below the current price — a sale that lowers nothing is never shown | نرخی دوای داشکاندن لە نرخی ئێستا کەمتر نییە — داشکاندنێک کە هیچ کەم ناکاتەوە پیشان نادرێت |
| OFFER_ROUTE_BELOW_FLOOR | 400 | هذا الخصم يجعل سعر الطلب المسبق صفرًا أو أقل — ارفع السعر بعد الخصم | this sale brings a pre-order price to zero or less — raise the price after the discount | ئەم داشکاندنە نرخی پێشداواکردن دەکاتە سفر یان کەمتر — نرخی دوای داشکاندن بەرز بکەرەوە |
| SPECIAL_OFFER_CHANGED | 409 | عدّل أحدٌ هذا العرض بعد أن فتحته — أُعيد تحميله؛ راجعه ثم احفظ | someone changed this offer after you opened it — it has been reloaded; review it and save again | کەسێک دوای ئەوەی کردتەوە ئەم ئۆفەرەی گۆڕی — دووبارە بارکرایەوە؛ پێیدا بچۆرەوە و دووبارە پاشەکەوتی بکە |
| OFFER_PARTLY_NOT_LOWER (warning) | — | بعض الموديلات لن تُخفَّض لأن سعرها بعد الخصم ليس أقل من الحالي — تُباع بسعرها بلا شطب | some models are not reduced because their price after the discount is not below the current one — they sell at their price, with no strikethrough | هەندێک مۆدێل داناشکێن چونکە نرخی دوای داشکاندنیان لە ئێستا کەمتر نییە — بە نرخی خۆیان دەفرۆشرێن، بێ هێڵ بەسەرداهاتن |
| OFFER_BELOW_COST (warning, owner only) | — | هذا الخصم يبيع موديلًا أو مسارًا تحت تكلفته — محفوظ ومعروض للزبائن | this sale sells a model or route below its cost — saved and on sale | ئەم داشکاندنە مۆدێلێک یان ڕێڕەوێک لە خوار تێچووەکەی دەفرۆشێت — پاشەکەوت کراوە و بۆ کڕیاران دیارە |

`SPECIAL_OFFER_CHANGED` is not `OFFER_CHANGED`. That code already means a merchant's print offer in `refusalStrings.ts`.

---

## 6. The discount card — «تخفيض السعر»

### 6.1 Placement and wiring

- **File:** `src/components/adminProducts/form/ProductDiscountCard.tsx`, with its strings in `productDiscountStrings.ts` (ar, en, ckb).
- **Mounted in** `ProductForm.tsx`, section ٣:
  - after `<PricesSectionV2 …/>` and `InventorySummary`;
  - before `MembershipDiscountSection`;
  - with `productId={doc.id || null}`.
- **What it reads from `useV2()`:** `owner`, `money`, `hidden`, `drafting`, and `stored?.seq.write_seq`. When `write_seq` moves, the card refetches its GET.
- **It saves through its own button**, not the product save. It uses the same door as the offers tab (D1). The product form's dirty state and its «حفظ» are unaffected, exactly as `MembershipDiscountSection` behaves.
- **Primitives:**
  - Clay surface `lv-surface`;
  - `formUi` (`Field`, `Grid`, `Percent`, `TextInput type="datetime-local"`, `Toggle`, `Banner`, `btnPrimary`, `btnGhost`, `btnDanger`);
  - `v2Ui` (`UsdInput`, `V2Field`, `Readout`, `Chip`);
  - `useConfirm` (`src/components/ui/ConfirmDialog.tsx`).
- **No maths in the card.** Every after price, saving and flag comes from the preview endpoint, debounced 400 ms after typing stops. While the preview is in flight the card shows «…» in the after column. This is the V2 form's rule: no price is computed on the client.

### 6.2 States

| State | Shown |
|---|---|
| New product (no id) | One line: «احفظ المنتج أولًا، ثم أضف التخفيض.» |
| Composition (bundle or mystery) | The card does not render. Their own forms and the offers tab handle them. |
| Not published (`published = false`) | One line: «انشر أسعار المنتج أولًا؛ يُحسب الخصم من السعر المنشور.» |
| No window | «لا يوجد تخفيض على هذا المنتج.» and «+ إضافة تخفيض». The button opens the form with the USD mode when it is available, else percent. |
| Window exists, mode `fixed_usd` or `discount_percent` | The form, filled from the row. A state chip shows «لم يبدأ / يعمل الآن / انتهى» (the tab's chips), plus the countdown when live with an end. |
| Window exists, another mode (`discount_iqd`, `''` schedule-only) | The same form, which opens on the percent mode, with an info line naming what the row holds, e.g. «هذا المنتج عليه خصم بالدينار من «العروض الخاصة» (50,000 د.ع). الحفظ هنا يستبدل طريقة السعر فقط.» |
| Suspended by the clean start | Chip «موقوف: أُنشئ قبل التسعير الجديد» and the line «احفظ لتشغيله من جديد». |
| The row carries tiers or limits | Read-only line: «إعدادات أخرى لهذا العرض من «العروض الخاصة»: للمشتركين فقط: PLUS · حد 5 لكل زبون», with a link to the tab. These values are carried through a card save **untouched**: the PUT sends the whole row as read. |
| V2 draft not applied (`drafting`) | Info line: «السعر «قبل» هو المنشور الآن. احفظ تغييرات الأسعار أعلاه لتظهر هنا.» |
| USD mode unavailable | The segment is disabled, and the reason sentence sits under it (`usd.reason`, §6.6). |

### 6.3 Desktop layout (≥ 1024 px)

The real page is right-to-left. The ASCII shows reading order.

```
┌ تخفيض السعر ─────────────────────────────── ● يعمل الآن · ينتهي خلال 2 يوم 04:12:09 ┐
│ السعر الحالي هو السعر قبل الخصم تلقائيًا — اكتب السعر بعد الخصم بالدولار أو نسبة الخصم.  │
│                                                                                         │
│ [ سعر بعد الخصم ($) | نسبة الخصم (٪) ]            ← segmented, one pressed (clay well)  │
│ [ سعر واحد للمنتج كله | سعر لكل موديل ]            ← only when both scopes are possible │
│                                                                                         │
│ الموديل · اللون      الآن (قبل الخصم)           بعد الخصم                   التخفيض     │
│ P1S · كل الألوان     $600.00 · 900,000 د.ع      [$ 500.00 ] · 750,000 د.ع    −17٪       │
│ P1S Combo · كل…      $750.00 · 1,125,000 د.ع    [$ 640.00 ] · 960,000 د.ع    −15٪       │
│ ▸ الطلب المسبق (2)                                                                      │
│     P1S · بري         825,000                    675,000                      −18٪       │
│     P1S Combo · بري   1,050,000                  885,000                      −16٪       │
│                                                                                         │
│ يبدأ في (اختياري) [2026-10-20 12:00]   ينتهي في (اختياري) [2026-10-27 23:59]  بتوقيت بغداد │
│ (●) مفعّل                                                                               │
│ ⓘ يُحوَّل الدولار إلى الدينار بسعر الصرف نفسه الذي سُعِّر به المنتج، ويُقرَّب لأعلى …    │
│ ⓘ إعدادات أخرى لهذا العرض من «العروض الخاصة»: للمشتركين فقط: PLUS                       │
│                                                                                         │
│ [حفظ التخفيض]  [حذف التخفيض]                                فتح في «العروض الخاصة» ↗   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Rows** are grouped by model. A model whose colours share one price shows one row, «كل الألوان». Otherwise each colour has its own row.
- **Inputs by mode:**
  - In «سعر لكل موديل», the USD input sits on each model row. An empty field shows the hint «اتركه فارغًا ليبقى هذا الموديل بسعره».
  - In «سعر واحد», one `UsdInput` sits above the table, and the after column is read-only.
  - In the percent mode, one `Percent` (1–90) sits above the table.
- **The pre-order disclosure** is closed by default. Its count is the number of pre-order rows.
- **Row states:**
  - `not_lower` and `not_covered`: muted, with `Chip muted` «بلا تخفيض».
  - `not_lower` also carries the hint «ليس أقل من السعر الحالي — لا يظهر خصم».
  - `below_floor`: `Chip danger` «يجعل السعر صفرًا أو أقل».
  - Owner only: `Chip warning` «تحت التكلفة» or «تحت الحد الأدنى للربح».
- **USD columns:**
  - An editor on a cost-first product sees no USD column: the before column is IQD only, and the USD segment is disabled with the `OWNER_ONLY` sentence.
  - On a cost-first product the owner's USD reads «≈ $612.35»: it is `before_usd_exact: false`.
  - In the percent mode the after USD always carries «≈».
- **Banners:** server refusals and warnings render verbatim with `Banner`, in the reader's language (§11.3 rule). Warnings stay visible after a successful save.

### 6.4 Phone (360 px, 16 px gutters)

```
تخفيض السعر                       ● يعمل الآن
السعر الحالي هو السعر قبل الخصم تلقائيًا — …
[ سعر بعد الخصم ($) | نسبة (٪) ]
[ سعر واحد | لكل موديل ]
┌──────────────────────────────────────┐
│ P1S · كل الألوان                      │
│ الآن  $600.00 · 900,000 د.ع           │
│ بعد   [$ 500.00 ]                     │
│       ← 750,000 د.ع   −17٪            │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│ P1S Combo · كل الألوان   …            │
└──────────────────────────────────────┘
▸ الطلب المسبق (2)
يبدأ في [            ]
ينتهي في [            ]   بتوقيت بغداد
(●) مفعّل
[        حفظ التخفيض        ]
[        حذف التخفيض        ]
فتح في «العروض الخاصة» ↗
```

- Rows stack as cards.
- Every target is ≥ 44 px (`.lv-hit`).
- The page has no horizontal scroll.
- Amounts are `<bdi dir="ltr">` with tabular numerals.

### 6.5 Behaviour

- **Load:** `GET /api/admin/offers/:id`. This one request fills the row, `discount`, the redemption counts and `schedule_state`.
- **Typing:** the card POSTs the draft to `/preview`, debounced 400 ms, and the latest answer wins (a sequence guard, as `AdminOffers` `seq`). It never writes.
  - The preview's `issues` and `warnings` are shown at once, with the same banners as a save's (each code once). A draft refused at checks 1–6 answers `refused: true`: the card shows the before column and «—», never the «بلا تخفيض» chip (which reads as "this model will not be discounted"). The stored set's preview is how the owner learns that a later V2 save broke its scope (§4.6).
- **Save:** the card sends `PUT` with the **whole row as loaded**:
  - the changed fields;
  - tiers, limits, `locked_preview` and `plus_price_iqd` carried as read;
  - `offer_usd_prices` when the mode is `fixed_usd`;
  - `expected_updated_at` (the loaded stamp, or `null` when there was no row).
  - On `SPECIAL_OFFER_CHANGED` the card reloads and shows the sentence; the typed draft is kept so the owner can re-apply.
  - On success it shows «حُفظ التخفيض.» and the server's warnings.
- **Remove:** the confirm text is «حذف التخفيض؟ / يُحذف العرض من «العروض الخاصة» أيضًا، ومعه شرط الاشتراك والحدود إن وُجدت. ما بيع سابقًا لا يتغيّر.» Then `DELETE`. To pause instead of deleting, switch «مفعّل» off and save; the row stays.
- **Times:** `datetime-local` strings are shown and sent in Baghdad time through a shared helper, `src/lib/offerTime.ts`:
  - `isoToBaghdadInput(iso)` and `baghdadInputToNaive(local)`;
  - the naive value is sent, and the server's `normalizeUtc` reads it as +03:00.
  - The same helper replaces `toLocalInput` and `toIso` in AdminOffers (F4).

- **The pre-order disclosure:** its `<summary>` is a flex row, which draws no `::marker`, so the card draws its own chevron (`data-discount-preorder-marker`) that turns when the disclosure opens; the 44 px tap stays.
- **Amounts:** each row's IQD amount isolates the **figure** only (`<bdi dir="ltr">900,000</bdi> د.ع`); the unit follows the sentence, as every other price does.

### 6.6 Strings (`productDiscountStrings.ts`)

| key | ar | en | ckb |
|---|---|---|---|
| title | تخفيض السعر | Sale price | داشکاندنی نرخ |
| intro | السعر الحالي هو السعر قبل الخصم تلقائيًا — اكتب السعر بعد الخصم بالدولار أو نسبة الخصم. | The current price is the before price, automatically — enter the price after the discount in dollars, or a discount percent. | نرخی ئێستا خۆکارانە نرخی پێش داشکاندنە — نرخی دوای داشکاندن بە دۆلار بنووسە، یان ڕێژەی داشکاندن. |
| modeUsd | سعر بعد الخصم ($) | Price after discount ($) | نرخی دوای داشکاندن ($) |
| modePercent | نسبة الخصم (٪) | Discount percent (%) | ڕێژەی داشکاندن (٪) |
| scopeProduct | سعر واحد للمنتج كله | One price for the whole product | یەک نرخ بۆ هەموو بەرهەمەکە |
| scopeModel | سعر لكل موديل | A price for each model | نرخێک بۆ هەر مۆدێلێک |
| colModel | الموديل · اللون | Model · colour | مۆدێل · ڕەنگ |
| colBefore | الآن (قبل الخصم) | Now (before) | ئێستا (پێش داشکاندن) |
| colAfter | بعد الخصم | After | دوای داشکاندن |
| colSaving | التخفيض | Off | داشکاندن |
| allColours | كل الألوان | All colours | هەموو ڕەنگەکان |
| preorder(n) | الطلب المسبق (n) | Pre-order (n) | پێشداواکردن (n) |
| emptyKeeps | اتركه فارغًا ليبقى هذا الموديل بسعره | Leave empty to keep this model at its price | بەتاڵی بهێڵەوە تا ئەم مۆدێلە بە نرخی خۆی بمێنێتەوە |
| noSale | بلا تخفيض | No sale | بێ داشکاندن |
| notLower | ليس أقل من السعر الحالي — لا يظهر خصم | Not below the current price — no sale is shown | لە نرخی ئێستا کەمتر نییە — هیچ داشکاندنێک پیشان نادرێت |
| belowFloor | يجعل السعر صفرًا أو أقل | Brings the price to zero or less | نرخەکە دەکاتە سفر یان کەمتر |
| belowCost (owner) | تحت التكلفة | Below cost | لە خوار تێچوو |
| belowMinProfit (owner) | تحت الحد الأدنى للربح | Below the minimum profit | لە خوار کەمترین قازانج |
| startsAt | يبدأ في (اختياري) | Starts (optional) | دەست پێدەکات لە (ئارەزوومەندانە) |
| endsAt | ينتهي في (اختياري) | Ends (optional) | کۆتایی دێت لە (ئارەزوومەندانە) |
| tz | بتوقيت بغداد | Baghdad time | بە کاتی بەغدا |
| active | مفعّل | Active | چالاک |
| rateNote | يُحوَّل الدولار إلى الدينار بسعر الصرف نفسه الذي سُعِّر به المنتج، ويُقرَّب لأعلى إلى ألف دينار؛ فإذا تغيّر سعر الصرف تغيّر السعران قبل الخصم وبعده معًا. | Dollars convert to dinars at the same exchange rate the product is priced at, rounded up to the next 1,000 IQD; when the rate moves, the before and after prices move together. | دۆلار بە هەمان نرخی ئاڵوگۆڕ کە بەرهەمەکەی پێ نرخ دانراوە دەکرێتە دینار و بۆ سەرەوە دەگەیەنرێتە هەزار دینار؛ کاتێک نرخی ئاڵوگۆڕ دەگۆڕێت، نرخی پێش و دوای داشکاندن پێکەوە دەگۆڕێن. |
| percentNote | تُحسب النسبة من السعر المنشور لكل موديل ولون، وتتبع سعر الصرف معه. | The percent is taken off each model and colour's published price, and follows the exchange rate with it. | ڕێژەکە لە نرخی بڵاوکراوەی هەر مۆدێل و ڕەنگێک دەبڕدرێت، و لەگەڵیدا شوێن نرخی ئاڵوگۆڕ دەکەوێت. |
| otherSettings(list) | إعدادات أخرى لهذا العرض من «العروض الخاصة»: {list} | More settings of this offer, from Special offers: {list} | ڕێکخستنی تری ئەم ئۆفەرە لە «ئۆفەرە تایبەتەکان»: {list} |
| membersOnly(tiers) | للمشتركين فقط: {tiers} | Members only: {tiers} | تەنها بۆ ئەندامان: {tiers} |
| perCustomer(n) | حد {n} لكل زبون | Limit {n} per customer | سنووری {n} بۆ هەر کڕیارێک |
| totalLimit(n) | حد إجمالي {n} | Total limit {n} | سنووری گشتی {n} |
| otherMode(amount) | هذا المنتج عليه خصم بالدينار من «العروض الخاصة» ({amount}). الحفظ هنا يستبدل طريقة السعر فقط. | This product has a dinar amount-off from Special offers ({amount}). Saving here replaces the price method only. | ئەم بەرهەمە داشکاندنێکی دیناری لە «ئۆفەرە تایبەتەکان»ـەوە هەیە ({amount}). پاشەکەوتکردن لێرە تەنها شێوازی نرخ دەگۆڕێت. |
| draftNote | السعر «قبل» هو المنشور الآن. احفظ تغييرات الأسعار أعلاه لتظهر هنا. | The before price is the one published now. Apply the price changes above to see them here. | نرخی «پێش» ئەوەیە کە ئێستا بڵاوکراوەتەوە. گۆڕانکارییەکانی نرخ لە سەرەوە جێبەجێ بکە تا لێرە دەربکەون. |
| newProduct | احفظ المنتج أولًا، ثم أضف التخفيض. | Save the product first, then add a sale. | سەرەتا بەرهەمەکە پاشەکەوت بکە، پاشان داشکاندن زیاد بکە. |
| notPublished | انشر أسعار المنتج أولًا؛ يُحسب الخصم من السعر المنشور. | Publish the product's prices first; the sale is taken from the published price. | سەرەتا نرخەکانی بەرهەمەکە بڵاو بکەرەوە؛ داشکاندن لە نرخی بڵاوکراوە دەکرێت. |
| usdOwnerOnly | هذا المنتج مسعَّر من التكلفة، والسعر بعد الخصم بالدولار يضعه المالك. يمكنك استعمال نسبة الخصم. | This product is priced from cost; the owner sets a dollar price after the discount. You can use a discount percent. | ئەم بەرهەمە لە تێچووەوە نرخ دانراوە، و نرخی دوای داشکاندن بە دۆلار خاوەنەکە دایدەنێت. دەتوانیت ڕێژەی داشکاندن بەکاربهێنیت. |
| usdNotDirect | هذا المنتج لا يُباع بيعًا مباشرًا، فلا يوجد سعر حالي واحد يُخفَّض منه. استعمل نسبة الخصم. | This product is not sold direct, so there is no single current price to discount from. Use a discount percent. | ئەم بەرهەمە ڕاستەوخۆ نافرۆشرێت، بۆیە یەک نرخی ئێستا نییە بۆ داشکاندن. ڕێژەی داشکاندن بەکاربهێنە. |
| usdMixed | ألوان هذا المنتج بأسعار مختلفة، فلا يصلح لها سعر واحد بعد الخصم. استعمل نسبة الخصم. | This product's colours have different prices, so one price after the discount cannot fit them. Use a discount percent. | ڕەنگەکانی ئەم بەرهەمە نرخی جیاوازیان هەیە، بۆیە یەک نرخی دوای داشکاندن بۆیان ناگونجێت. ڕێژەی داشکاندن بەکاربهێنە. |
| usdNotInstalled | سعر الخصم بالدولار غير متاح بعد على هذه القاعدة. نسبة الخصم تعمل. | A dollar sale price is not available on this database yet. A discount percent works. | نرخی داشکاندن بە دۆلار هێشتا لەم بنکەدراوەیە بەردەست نییە. ڕێژەی داشکاندن کار دەکات. |
| suspendedSave | احفظ لتشغيله من جديد | Save to run it again | پاشەکەوتی بکە تا دووبارە کار بکات |
| none | لا يوجد تخفيض على هذا المنتج. | This product has no sale. | ئەم بەرهەمە هیچ داشکاندنێکی نییە. |
| add | + إضافة تخفيض | + Add a sale | + زیادکردنی داشکاندن |
| save | حفظ التخفيض | Save sale | پاشەکەوتکردنی داشکاندن |
| saving | جارٍ الحفظ… | Saving… | پاشەکەوت دەکرێت… |
| saved | حُفظ التخفيض. | Sale saved. | داشکاندنەکە پاشەکەوت کرا. |
| remove | حذف التخفيض | Remove sale | لابردنی داشکاندن |
| removeTitle | حذف التخفيض؟ | Remove the sale? | داشکاندنەکە لاببرێت؟ |
| removeBody | يُحذف العرض من «العروض الخاصة» أيضًا، ومعه شرط الاشتراك والحدود إن وُجدت. ما بيع سابقًا لا يتغيّر. | The offer is removed from Special offers too, with its membership gate and limits if any. Past orders do not change. | ئۆفەرەکە لە «ئۆفەرە تایبەتەکان»یش لادەبرێت، لەگەڵ مەرجی ئەندامێتی و سنوورەکانی ئەگەر هەبن. داواکارییە پێشووەکان ناگۆڕێن. |
| removed | حُذف التخفيض. | Sale removed. | داشکاندنەکە لابرا. |
| openOffers | فتح في «العروض الخاصة» | Open in Special offers | کردنەوە لە «ئۆفەرە تایبەتەکان» |

The state chips reuse the tab's strings: «لم يبدأ / يعمل الآن / انتهى» and «دەستی پێنەکردووە / ئێستا کار دەکات / کۆتایی هات». The suspended chip reuses «موقوف: أُنشئ قبل التسعير الجديد».

Vocabulary rules:

- The discount here is «تخفيض / داشکاندنی نرخ».
- It is never «الخصم ($)» alone. In section ٣ that word already names the **pre-order** discount (`v2Strings` `discount`: «داشکاندنی پێشداواکردن ($)»).
- Avoid «گواستنەوە» and «کاڵا» (`tests/productFormV2.test.ts` vocabulary rule).

### 6.7 Accessibility

- The segmented controls are `role="radiogroup"` with `aria-checked`, the pressed one drawn as a clay well (row 207).
- The table is a real `<table>` on desktop. On a phone it is a list of `<section aria-label="P1S · كل الألوان">`.
- Each after price has `aria-live="polite"` on its cell while previewing.
- Focus moves to the first refusal `Banner` after a failed save.

---

## 7. The special-offers tab (AdminOffers.tsx)

- **Price mode:** the select gains «سعر بعد الخصم ($)», with en "Price after discount ($)" and ckb «نرخی دوای داشکاندن ($)».
  - With it, one `UsdInput` edits the whole-product price, sent as `offer_usd_prices: [{ model_id: '', usd }]`.
  - When the row holds model rows, they are listed read-only («P1S $500.00 · P1S Combo $640.00»), with «عدّل في نموذج المنتج» / "Edit in the product form" / «لە فۆڕمی بەرهەمەکەدا دەستکاری بکە» linking to `/admin?tab=products&edit=<id>&section=3`. Each model row of `offer_usd_prices` carries its model's `names {ar, en, ckb}` (`windowView`, read from `product_option_values`), in the product's model order; the tab prints the name in the reader's language.
  - The tab does not send `offer_usd_prices` unless its own input changed, so the stored set is kept.
  - D7: each list row carries `usd_allowed` — false for an editor on a cost-first product — and the tab disables the dollar mode there with the card's sentence («هذا المنتج مسعَّر من التكلفة…»).
- **List line:** `$500.00` for the whole product; with ONE model on sale, that model's name (`$550.00 · P1S كومبو`); with several, a count read as a number of models is in each language: «موديلان», «3 موديلات», «11 موديلًا» / "2 models" / «2 مۆدێل».
- **Concurrency:** saves send `expected_updated_at` and handle `SPECIAL_OFFER_CHANGED` the same way the card does (D12).
- **Times:** fixed with `src/lib/offerTime.ts` (F4).
- **Errors:** the server's sentences render through `text(i)` from `details.errors`. The pricing programme's refusals this door raises (`PRICING_V2_OWNER_ONLY`, `PRICING_V2_MANAGED`) carry their three sentences there too, so a Sorani editor reads Sorani.

---

## 8. The customer side

### 8.1 Payload fields

Every one is an explicit allow-list entry. None carries a dollar figure, a rate or a cost.

| Where | New fields |
|---|---|
| `CustomerLinePrice` (quote, cart line `breakdown`, checkout line `breakdown`) | `offer_before_iqd: number \| null`, `offer_saving_percent: number \| null` |
| Checkout quote line (beside `component_total_iqd` and `saving_percent`) | `offer_before_iqd`, `offer_saving_percent` (unit figures) |
| Card projection | `display_offer_before_iqd`, `display_offer_saving_percent`; `offer.priced: boolean` (`offer_price_mode !== ''`) |
| Product detail `price_levels` grid | the two `CustomerLinePrice` fields on each level |
| `customerOrderPricing` (order JSON) | `offer_before_iqd` from the snapshot; `offer_saving_percent` recomputed from the frozen `offer_before_iqd` and `applied_iqd` (D9) |
| Invoice snapshot line (`InvoiceSnapshotV1`, optional) | `offer_before_iqd?`, `offer_saving_percent?`, read from the line's own `pricing_snapshot` in `lineFromItem` |

How the fields are filled:

- `offer_saving_percent = Math.round((before − applied) × 100 / before)` when `before` is set. Below 1 it is null.
- `offer_before_iqd` is null unless a live window lowered this line for this viewer.
- A members-only window, for a viewer who is not eligible, prices nothing. That viewer therefore gets null: no strike, and the card shows the existing lock badge.

### 8.2 Product card (`ProductCard.tsx`, `CardPrice.tsx`)

**Server (F2):**

- In the card projection, the offer is applied **inside the levels loop**: `withLiveOffer`-equivalent, `applyOfferToResolved(r, offer, …, doc)` per level. `best`, `maxApplied`, `primeMin` and `proMin` are then taken over the post-offer results, and the `delta` adjustment goes.
- A percent produces the same numbers as today, because it is monotone.
- When a `fixed_usd` window priced at least one SKU level, the non-SKU levels (base, option-only, colour-only) are left out of `best` and `maxApplied`. They read the rollback ladder and name no purchasable SKU, and including them would make «يبدأ من» claim a spread that does not exist. Each SKU level read on its direct line is then read on its **cheapest pre-order route** as well (`skuPreorderTwins`, the line the cart prices), so «يبدأ من» keeps the pre-order basis the option and base levels give it without the sale.
- **One basis for «يبدأ من» and its strike (O4).** The card's regular «from» before the sale (`preRegular`, the levels' pre-offer regular prices) and after it (`postRegular`) are taken over the **same** levels. `display_offer_before_iqd = preRegular` and `display_offer_saving_percent` = D9 of `preRegular` and the printed figure — only when a level was offer-priced and `postRegular < preRegular`; otherwise both are null, `offer.price_source` is `'ladder'` and the card shows no strike, no badge and no clock. Never one level's own before price beside another level's figure.
  - No sale: «يبدأ من 825,000» (P1S by land).
  - P1S $500 + Combo $640: «يبدأ من 675,000», ~~825,000~~, «−18٪» — the figure the product page shows.
  - Combo only, $550: «يبدأ من 750,000» (the Combo by land), ~~825,000~~, «−9٪».
  - Combo only, $700: «يبدأ من 825,000», no strike — the sale is on the Combo's page.

**Client:**

- **Photo badge** (top-end, where SALE sits):
  - When `display_offer_saving_percent ≥ 1`: `OfferBadge tone="sale"` reading «−17٪» (en «−17%»), in a `<bdi dir="ltr">`, plus sr-only text «تخفيض 17٪» / "17% off" / «17٪ داشکاندن».
  - Otherwise, today's SALE rule.
- **Compact price, row 2:** when `display_offer_before_iqd` is set, it shows the struck before price (sr-only «بدل» / "instead of" / «لە جیاتی»), and the member line yields. Otherwise today's rule.
- **Regular price:** `struck = display_offer_before_iqd ?? (main < regular ? regular : null)`.
- **Countdown:**
  - `upcoming` always shows «يبدأ خلال».
  - `live` with `ends_at` shows «ينتهي خلال» only when `!offer.priced || offer.price_source === 'offer'`. A priced window that lowers nothing on this card gets no clock.
  - An older payload without `priced` behaves as today.

### 8.3 Product page (`src/pages/Product.tsx`)

`shownPrice` gains `before` and `savingPercent`, from the quote or else the level.

```
750,000 د.ع   [سعر العرض]
~~900,000~~  [−17٪]   ينتهي خلال 2 يوم 04:12:09
```

- **Label:** when `before` is set and no member tier applies, the label is «سعر العرض» / "Sale price" / «نرخی ئۆفەر», replacing «السعر».
- **Members:** the member label and colour are unchanged («سعر PRO»). The existing member line `savedWithTier(regular − applied)` still says what the membership took off the **offer** price.
  - Example: PRO rule 20% gives `720,000 [سعر PRO]`, then `~~900,000~~ −20٪`, then «وفّرت 30,000 بعضوية PRO».
- **The struck line:**
  - `OfferSaving`: struck `before` plus the «−N٪» chip, in `OfferBadge tone="saving"`.
  - It is drawn whenever `before` is set. Otherwise today's member strike.
- **Countdown (F8):**
  - The existing `Countdown` (`kind="ends"`) sits after the chip when `product.offer.ends_at` is set and the selection on screen is discounted (`before !== null`).
  - When `product.offer.schedule_state === 'upcoming'`, it shows `kind="opens"` with no price promise.
- **The pills (`pricing_modes`)** keep final prices only (PRICING-V2 §7 default 5), already offer-priced.

### 8.4 Cart (`src/pages/Cart.tsx`)

- `regularUnit` becomes `breakdown.offer_before_iqd ?? breakdown.regular_iqd`.
- The percent becomes `breakdown.offer_saving_percent ??` the existing calculation.
- The struck figure uses `money()`, not `toLocaleString()`.
- The markup stays: unit price, struck, `−N٪`. The `−N٪` becomes `OfferBadge tone="saving"` for one style site-wide.
- No countdown in the cart.

### 8.5 Checkout (`src/pages/Checkout.tsx`)

- Each summary line with `offer_before_iqd` shows `OfferSaving` under its line total, exactly where `BundleSavingLine` sits for a bundle.
- The struck figure is `offer_before_iqd × qty`, and the badge is the line's percent.
- The figures come from the **quote** (one basis per screen, as the bundle line does). The cart line is only the fallback.

### 8.6 Order detail (`src/pages/OrderDetail.tsx`)

After «× 2 · 750,000» it shows `OfferSaving` (struck unit before, badge), from `it.pricing.offer_before_iqd`. A gift line never shows it, because a gift has no offer.

### 8.7 Invoice, printable document and email (`worker/lib/invoices.ts` and its templates)

Under the line's variant, a muted line:

| ar | en | ckb |
|---|---|---|
| السعر قبل العرض: {amount} للقطعة (−{n}٪) | Before the offer: {amount} each (−{n}%) | نرخی پێش ئۆفەر: {amount} بۆ هەر دانەیەک (−{n}٪) |

The invoice's own language decides which column is used (`invoiceLang`). Invoices issued before this change are immutable and stay as they are.

### 8.8 Listings, facets, flash deals, «المخفَّضة»

- **Listing item:**
  - `regular` becomes `display_offer_before_iqd ?? display_regular_iqd`, so «عليها عرض» (`onOffer`) sees a live offer through `price < regular`.
  - `scheduledOffer` is false for a **live, priced** window whose `price_source !== 'offer'`, because it lowers nothing here — unless the viewer is locked out of it (`offer.locked`), which keeps today's answer.
- **`discountedWhere` (F7)** gains `OR EXISTS (a live, active, priced, unsuspended offer_windows row for products.id)`:
  - `starts_at`/`ends_at` against a bound `nowIso`;
  - `OFFER_NOT_SUSPENDED_SQL`.
  - It degrades to today's predicate where `offer_windows` is missing.
  - A members-only window lists the product. The card wears the lock to whoever is not eligible: «حصري للمشتركين» / "Members only" / «تەنها بۆ ئەندامان» on the photograph (ProductCard `SaleBadge`, the bundle tile's words), with its clock, and it stays in «عليها عرض» — a window the viewer is locked out of is never "a priced window that lowers nothing" (`listingItemOf`, `offerClock`).
- **`flashDealIds`** is unchanged: `offer_price_mode <> ''` already includes `fixed_usd`.

### 8.9 One component, and the Sorani gaps (F6)

- **New** `src/components/ui/OfferSaving.tsx`: `{ beforeIqd: number; percent: number | null }`. It renders the struck amount (`money`, tabular, `line-through`, sr-only prefix) plus `OfferBadge tone="saving"` with «−N٪».
  - The struck amount (`StruckMoney`, beside `OfferSaving` in OfferBadge.tsx, and the cart's struck unit price) isolates the **figure** only — `<bdi dir="ltr">900,000</bdi> د.ع` — so the unit sits where the main price's does when the digits are Latin (an English-locale phone reading the Arabic or Sorani site).
  - Product page, cart, checkout and order detail use it.
  - The compact card keeps its own fixed-height row and the same text helper, `offerPercentText(n, lang)`.
- **`CompactPrice`:** `loc('لأعضاء', 'for', 'بۆ ئەندامانی')` and `loc('بدل', 'instead of', 'لە جیاتی')`.

| key | ar | en | ckb |
|---|---|---|---|
| badge(n) | −{n}٪ | −{n}% | −{n}٪ |
| badgeSr(n) | تخفيض {n}٪ | {n}% off | {n}٪ داشکاندن |
| was (sr-only) | بدل | instead of | لە جیاتی |
| salePrice | سعر العرض | Sale price | نرخی ئۆفەر |

---

## 9. Honesty, and members with offers

1. **The struck number is always the published regular price of that SKU and channel at this instant.**
   - It is `offer_before_iqd`, which is the `regular_iqd` the resolver held before the live window replaced it.
   - On a V2 product that is `product_sku_prices.regular_price_iqd`, live by `SKU_ROW_LIVE_V2`.
   - Nobody types it, and the database has no column for it.
2. **No strike, no badge, no live clock unless the window really lowered the line** (D4, §8.2). That covers:
   - an ineligible viewer of a members-only window;
   - a model without a row;
   - a USD price that rounds to the before price;
   - a regular price that has since dropped below the USD price;
   - a window that is upcoming, ended, inactive or suspended.
3. **Precedence (unchanged, D10):**

   | Viewer | Pays | Card shows |
   |---|---|---|
   | Guest / free | the offer price (750,000) | 750,000, ~~900,000~~, «−17٪» |
   | Member whose rule price is above the offer (PRO 5% = 855,000) | the offer price (clamped, 750,000) | as a guest: no member colour, label «سعر العرض» (the F5 fix) |
   | Member whose rule price is below the offer (PRO 20% = 720,000) | 720,000 | 720,000 in PRO red, ~~900,000~~, «−20٪»; the product page adds «وفّرت 30,000 بعضوية PRO» |
   | Gated window, ineligible viewer | the regular price | the regular price, the lock badge, no strike |

   A coupon still applies afterwards, to merchandise, as offers.ts states today.

   **A member rule applied at the line** (a `max_quantity`, a per-order cap or a minimum subtotal — `isUnitExpressible` false) never meets `clampMemberLadder`. On a line a live offer lowered it is worked out on the line's pre-offer regular price (`BenefitLineInput.offer_before_unit_iqd`), and only what it takes beyond the offer's own saving on the units it covers comes off the line (`resolveProductBenefits`). A PRO 10% rule on one unit under a $500 sale pays 750,000, not 675,000; a PRO 30% rule on one unit pays 630,000. A rule that cannot beat the sale on any unit spends none of the order's shared budget.

4. **The F5 label fix — a display label, never the price class.** `ResolvedPrice.applied_tier` is left exactly as it was: it is the buyer's **price class**, frozen into `order_items.pricing_snapshot`, and price protection reads it (`buyerClassOf`, worker/routes/returns.ts) to choose which of today's prices a claim is compared with. A PRO member clamped up to an offer price is still a PRO buyer.

   The label is derived where a customer reads it, by `offerLabelTier` (worker/lib/customerPricing.ts): when a live offer lowered the line (`offer_before_iqd` set) and the member rung is not below the offer price (`applied_iqd ≥ regular_iqd`), the label is `'regular'` («سعر العرض»); otherwise it is the rung. It is applied in `customerLinePrice` (quote, cart and checkout breakdowns), in `customerOrderPricing` (from the frozen snapshot), in the product page's price levels and in the card's `display_applied_tier`.

   No money changes and no class changes. Tests pin that a PRO buyer clamped to an offer price keeps `applied_tier: 'pro'` and `buyerClassOf … 'pro'` while every customer payload reads `'regular'` (tests/productDiscountResolver.test.ts, tests/productDiscountOrder.test.ts).
5. **Existing percent offers start showing their strike and badge.** This is intended. It is the card header's own §4 rule, which F1 had silently broken.

---

## 10. An older database, an older Worker (CLAUDE.md rule 2)

| Situation | Behaviour |
|---|---|
| New code, database without 0197 | `offerUsdInstalled` is false. The GET answers `usd_supported: false` (the card disables the USD segment with `usdNotInstalled`). `PUT fixed_usd` returns 409 `OFFER_USD_NOT_INSTALLED`. Percent saves work: `offerWindowStatements` is unchanged, and no 0197 statement is sent. `loadOffers`, the card, the cart and the checkout behave exactly as today. The probe is once per binding, with a 60 s recheck when absent. |
| New code, database without 0189 (no V2) | `published: false`: the card says «انشر أسعار المنتج أولًا». The overlay's V1 read carries no rate, so `fixed_usd` prices nothing. |
| Older Worker, database with 0197 and a `fixed_usd` row (a manual redeploy of an older commit) | `windowFromRow` maps `fixed_usd` to `''`: the window prices nothing. The product sells at its regular price, with a countdown if the window has an end. The flash board may list it at full price. No customer is charged a wrong amount. An older admin tab re-saving the row writes mode `''` and leaves `offer_usd_prices` rows the new code ignores; the next new-code save replaces them. |
| Window saved before the clean start | Suspended exactly as today. A save from the card re-activates it. |

---

## 11. Privacy (rows 220, 222)

- **Customers** receive IQD figures only: the final price, the before price and the percent.
  - Never the typed dollars (a customer could divide and learn the approved rate).
  - Never the rate, R, T or Δ.
  - A customer's USD display mode converts IQD at the public display rate, as every price does. It will not equal the owner's typed $500, because the dinar is the price.
- **The leak scanners** (`tests/costPublicChannels.test.ts`, `tests/securityPricingLeak.test.ts`) gain these keys as forbidden in every customer channel:
  - `usd_iqd_rate`;
  - `offer_usd_prices`;
  - `price_usd_cents`;
  - `offer_price_usd`;
  - `before_usd`, `after_usd`;
  - `sku`, which is server identity.
- **Editors** never receive a cost-derived figure, a `v2_*` key, or any below-cost signal (D6). Dollars reach them only on price-first products.
- **Logging:** no log line carries a price, a rate or a cost. Refusals name codes and fields, never values.

---

## 12. Tests to write

All are local. Run with `npx tsx --test --test-concurrency=4 <files>`.

New files will fail `tests/rootShardBalance.test.ts` only because they are new. The integrator regenerates `scripts/test-timings.json` from CI.

**Server: pure.** `tests/productDiscountResolver.test.ts`

- **`fixedUsdLine`:**
  - every row of §4.4's table, plus fractional rates (`"1527.5"`, `"1530.25"`);
  - the result is always a multiple of 1,000;
  - `none` for: a missing model row, a missing rate, a missing direct row, `after ≥ before`, and a V1 row;
  - `below_floor` when a route's saving ≥ its price;
  - cents 1 and 10,000,000;
  - no float anywhere: a property test over random cents and rates checks against a BigInt reference.
- **`resolveOfferPrice` / `applyOfferToResolved`:**
  - `fixed_usd` model row versus `''` row;
  - an uncovered model;
  - D4 for every mode;
  - `offer_before_iqd` is set only on `source: 'offer'`;
  - the PRO/PRIME label fix (F5), with `applied_iqd` unchanged;
  - COD pre-order priced at D_offer;
  - prepaid route at P − saving.
- **Mirror and call sites:**
  - the bundle mirror ignores `fixed_usd`;
  - a static check finds every `applyOfferToResolved` call site and requires `doc`.

**Server: the rate.** `tests/productDiscountRateChange.test.ts`. It uses a real D1 through `tests/fixtures/app` and migrations through 0197.

1. A price-first product is priced by the real V2 writer at U 1,500 (P1S $600, Combo $750, land Δ $50).
2. A `fixed_usd` window is saved through the route.
3. Card, quote, cart and checkout quote all show 900,000 → 750,000, −17٪.
4. Approve U 1,530 and run the real `autoReprice`. Everything reads 918,000 → 765,000, and the land route 842,000 → 689,000.
5. **Mid-wave:** two products, rate approved, only one repriced. Each uses its own row's rate. The not-yet-repriced one still reads 900,000 → 750,000, never 765,000 against 900,000.
6. A product whose owner lowers D to $480 by a V2 apply: the $500 sale shows no strike and no badge, and the line sells at 720,000.

**Server: the door.** `tests/productDiscountAdmin.test.ts`

- **Role answers:**
  - the owner gets USD and the `owner` flags;
  - an editor on price-first gets USD and no flags;
  - an editor on cost-first gets no USD, `usd.reason: 'OWNER_ONLY'`, and 403 `PRICING_V2_OWNER_ONLY` on a `fixed_usd` PUT;
  - leak-scan each answer for `usd_iqd_rate`, `v2_*`, `exact_iqd`, `replacement_*`, `target_*` and cost keys.
- **Preview** writes nothing: row counts and the audit table are unchanged, and no purge is recorded.
- **PUT, whole product and per model.**
- **Every refusal in §5.8**, with the three sentences present and the ckb differing from the ar. This includes the JSON number `500.5` and the text `"500.123"`.
- **Warnings:**
  - `OFFER_PARTLY_NOT_LOWER`;
  - `OFFER_PRICE_NEVER_ENDS`;
  - `OFFER_BELOW_COST`, owner only.
- **Not refused for cost:**
  - an editor's below-cost save rings **one** owner bell carrying no figure;
  - the editor's answer has no cost signal;
  - the owner's own save rings none.
- **A card save keeps** `required_tiers`, limits and `locked_preview`.
- **The set:**
  - the tab's PUT without `offer_usd_prices` keeps the set;
  - a mode change clears it;
  - DELETE removes the window, the limits and the USD prices, and keeps redemptions.
- **Concurrency:** `expected_updated_at` stale gives 409 `SPECIAL_OFFER_CHANGED` with nothing written. `null` against an existing row also gives 409.
- **Audit:** the row is inside the batch and includes the USD set.
- **Purge:** the catalogue paths and the product page are purged after PUT and DELETE, and not after preview.

**Server: 0197 and older databases.** `tests/productDiscount0197.test.ts`

- **Migration:** additive; `migrate-check --twice`; the trigger refuses a mixed scope; a REAL cent value is refused.
- **On a database at 0195** (no 0197):
  - the GET says `usd_supported: false`;
  - `fixed_usd` PUT gives 409;
  - percent PUT, `loadOffers`, the card, the cart and the checkout match today's answers;
  - the probe sends one statement per binding.
- **On a V1-only read:** `fixed_usd` prices nothing.

**Server: order and invoice.** `tests/productDiscountOrder.test.ts`

- **Checkout during a `fixed_usd` sale:**
  - `order_items.applied_iqd` and `unit` equal the after price;
  - `pricing_snapshot` carries `offer_before_iqd` and an `offer` block with `offer_price_mode: 'fixed_usd'`, `offer_price_usd: "500.00"` and `offer_model_id`;
  - a redemption row is written.
- **The customer order JSON** has `offer_before_iqd` and `offer_saving_percent`, and no USD, cents or rate.
- **The invoice:** the snapshot line carries `offer_before_iqd`. The HTML prints the before line in ar, en and ckb.
- **After the order:** editing the sale, deleting it, and moving the rate change nothing on the order or the invoice.
- **Line types:** a PRO line pays `min(member, offer)` with the right label. A percent sale gets the same strike fields.

**Server: customer surfaces.** `tests/productDiscountSurfaces.test.ts`

- **The card projection:**
  - per-level application with per-model prices: the cheapest after price wins, and `display_from` is honest;
  - `display_offer_*`;
  - `offer.priced`.
- **The listing:**
  - `scheduledOffer` is false for a live priced window that lowers nothing;
  - `onOffer` is true for a live sale;
  - `type=discounted` includes a live priced window and excludes an ended one.
- **Elsewhere:**
  - the flash board includes `fixed_usd`;
  - a gated window gives an ineligible viewer no `offer_before_iqd`;
  - the extended leak scanners pass.

**UI** (`renderToStaticMarkup`, as `tests/cardPriceCompact.test.ts` does).

- `tests/productDiscountCardPrice.test.ts`:
  - compact and regular price with `display_offer_before_iqd`: struck before, badge «−17٪», «−17%», «−17٪»;
  - the member line yields;
  - sr-only text in three languages;
  - no badge below 1;
  - the countdown rule (§8.2);
  - the F6 ckb strings.
- `tests/productDiscountCard.test.ts`: the form card in each §6.2 state, for owner and editor and for price-first and cost-first.
  - **Mode and scope controls:** the USD segment is disabled with the right sentence; the scope control appears only with both scopes; the per-model inputs; the empty-keeps hint.
  - **Preview rows:** `not_lower`, `below_floor` and the owner chips.
  - **Save body:** the PUT body carries the untouched tiers, limits and `expected_updated_at`.
  - **Strings:** every string key exists in ar, en and ckb, and ckb ≠ ar. The vocabulary rule of §6.6 holds.
- `tests/offerTime.test.ts`: Baghdad round trip, including midnight and the date line. AdminOffers no longer shows UTC as local.

**Real browser.** `scripts/e2e-product-discount.mjs`

It uses the harness of `scripts/e2e-pricing-v2-clean-start.mjs`:

- the built SPA;
- `wrangler dev --local`;
- a local D1 taken through the migrations to 0197.

Chromium comes from `/opt/pw-browsers`, and Playwright from `PLAYWRIGHT_MODULE=/opt/node22/lib/node_modules/playwright`. Nothing reaches levonis-iq.com.

1. **Owner sets the sale.** The owner opens a price-first two-model printer, section ٣, then «تخفيض السعر». He chooses «سعر لكل موديل» and types P1S $500 and Combo $640.
   - The preview shows 900,000 → 750,000 −17٪ and 1,125,000 → 960,000 −15٪.
   - He saves.
   - «العروض الخاصة» lists the same row as «$500.00 · 2 موديلات».
2. **Guest, in ar, en and ckb:**
   - the listing card shows 750,000 «يبدأ من», struck 900,000, «−17٪» and the countdown;
   - the product page shows «سعر العرض» / «نرخی ئۆفەر», the struck line and «ينتهي خلال»;
   - the cart line, then checkout with the struck total;
   - place a COD direct order;
   - the order detail shows the struck before;
   - the invoice HTML shows «السعر قبل العرض».
3. **Rate change:** approve rate 1,530 and run the reprice. The card reads 765,000 and struck 918,000, and the placed order is unchanged.
4. **Editor on a cost-first product:** no USD anywhere in section ٣ or the card, the USD segment is disabled with its sentence, and a percent sale saves.
5. **Removal:** delete from the tab. The card shows «لا يوجد تخفيض», and the listing shows no strike.
6. **Older database:** a database at 0195 shows the card with USD disabled and a percent working.
7. **Every page, every run:**
   - no console error;
   - no horizontal scroll at 360 px;
   - targets ≥ 44 px;
   - a network listener asserts that no customer response contains `usd_iqd_rate`, `_usd`, `price_usd_cents` or `offer_usd_prices`.
   - Screenshots are taken at 360 and 1280, in light and dark, and in ar and ckb.

**Neighbours that must stay green:**

- `offerPricing`, `offerEligibility`, `offerLimits`, `offerRedemptionState`, `specialOffers`;
- `pricingV2Overlay`, `pricingV2Roles`, `pricingV2ReviewLeaks`, `pricingV2ReviewSurfaces`, `pricingV2CleanStart`;
- `costPublicChannels`, `securityPricingLeak`, `cardPriceCompact`;
- `productFormV2`, `productFormV2Contract`;
- `refusalStrings`, `sqlSplit`;
- the bundle and mystery suites, `homeShelves`, and the listing facet tests.

---

## 13. Files

**New:**

- `migrations/0197_offer_usd_prices.sql`
- `worker/lib/offerUsd.ts`
- `src/lib/offerTime.ts`
- `src/components/ui/OfferSaving.tsx`
- `src/components/adminProducts/form/ProductDiscountCard.tsx`, `productDiscountStrings.ts`
- `scripts/e2e-product-discount.mjs`
- the test files of §12

**Changed:**

- `worker/lib/offers.ts`: types, `windowFromRow`, `loadOffers`, `resolveOfferPrice`, `applyOfferToResolved`, `offerWindowStatements` mode list.
- `packages/pricing/src/pricing.ts`: `SkuPriceRow.usd_iqd_rate`, `ResolvedPrice.sku`, `ResolvedPrice.offer_before_iqd`, `resolveUnitPrice` sets `sku`.
- `worker/lib/productOverlay.ts`: the rate column.
- `worker/routes/offers.ts`: GET `discount`, POST `/preview`, PUT checks, DELETE, purge, bell.
- `worker/lib/edgePolicy.ts`: the preview skip.
- `worker/lib/bundleRead.ts`: `windowPrices`.
- `worker/lib/productDeletion.ts`.
- `worker/routes/products.ts`: the card loop, `display_offer_*`, `offer.priced`, the listing item, `discountedWhere`, price levels.
- `worker/routes/cart.ts`, `worker/routes/orders.ts`: pass `doc`; the offer snapshot gains `offer_price_usd` and `offer_model_id`.
- `worker/lib/customerPricing.ts`.
- `worker/lib/invoices.ts` and its HTML and email templates.
- `src/lib/api.ts` types.
- `src/components/CardPrice.tsx`, `src/components/home/ProductCard.tsx`.
- `src/pages/{Product,Cart,Checkout,OrderDetail}.tsx`.
- `src/components/adminOffers/AdminOffers.tsx`.
- `src/components/adminProducts/ProductForm.tsx`: the mount.
- `src/lib/refusalStrings.ts`.
- `docs/DECISIONS.md`: a new row.

---

## 14. Out of scope, and open questions

None of these blocks the build. The default is stated for each.

1. **Price protection** (row 223 decision 8) reads the published V2 price and ignores offers today. A customer who bought at $600 a week before a $500 sale gets no automatic credit. *Default: unchanged.* Raise it with the owner separately.
2. **Percent rounding** stays at 1 IQD (D8), so 825,000 × 90% = 742,500. *Default: unchanged.* The owner may later prefer the 1,000 step.
3. **Badge rounding** is to the nearest whole percent (D9: $600 → $500 reads «−17٪», as the owner wrote). *Default: as stated.*
4. **Pre-order during a USD sale** keeps the same IQD saving as direct (D3). *Default: as stated.* That is PRICING-V2 §5.5.
5. **The V2 review sheet** does not yet warn when a new direct price cancels a live USD sale. The discount card shows it after the apply (row state `not_lower`). *Possible follow-up.*
6. **Compare, the printer finder and trade-in «today»** keep their current offer behaviour.
7. **Structured data** keeps the displayed price.

---

## 15. Shipping

- **One lane, two pushes, both through workflow 7.** Each push needs `npm run check` and `npm run test:unit` green locally first.
  - **(A) Server:** 0197, the resolver, the door, the customer payload fields and their tests. Until a `fixed_usd` row exists, nothing a customer sees changes, apart from the honest strike on any live percent offer (F1). The migration ships in the same push; workflow 7 applies it before the deploy.
  - **(B) UI:** the card, the tab, the customer components, the browser run.
- **After each push,** follow workflow 7 to green, then check the live site with read-only GETs:
  - `/api/products?type=discounted` answers;
  - a product page renders;
  - no customer JSON carries any key from §11's list.
