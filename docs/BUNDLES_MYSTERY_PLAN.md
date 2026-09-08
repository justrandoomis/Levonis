# Bundles, Random Filament, Mystery Pools and Special Offers — the implementation plan

> The contract this plan implements is `docs/BUNDLES_MYSTERY.md`. Read §1 (data
> model), §3 (reservation) and §15 (security) before starting slice 1.
> Read `docs/TXT_IMPORT_PARITY.md` §5.1 before any change to
> `worker/lib/productPersistence.ts`.

---

## الخلاصة التنفيذية

١. العمل مقسّم إلى **عشر شرائح** مرتّبة؛ كل شريحة قابلة للشحن وحدها وقابلة للتراجع وحدها، ولا شيء يظهر للعميل قبل الشريحة السادسة.
٢. الشريحتان الأولى والثانية **إصلاحان حقيقيان لأخطاء قائمة اليوم** — سياج الحركة المخزنية الذي يمنع الحركة الجزئية في كل الطلبات (حجزًا وخصمًا وإفراجًا وإرجاعًا، لا الحجز وحده)، وإرجاع المخزون عبر السجل بدل تحديث `products.stock` مباشرة — وينبغي دمجهما حتى لو توقّف باقي التكليف.
٣. الشريحة الثالثة تبني نموذج الترويج الواحد (نافذة زمنية تحمل سعرها + حدود + مُحفِّز قاعدة بيانات)، وهو نموذج خامل تمامًا حتى يرتبط به شيء.
٤. الشريحة الرابعة دوالّ نقية فقط: حساب التوفر وسعر الحزمة ومفتاح التركيب — تُختبر بلا قاعدة بيانات وبلا مسار HTTP.
٥. الشريحة الخامسة تنقل الحزم القديمة وتفتح لوحة الإدارة؛ كل حزمة مرحّلة تصل **مسودة بلا سعر** مع تحذير صريح، ولا يُنشر شيء تلقائيًا.
٦. الشريحة السادسة تعرض الحزم للقراءة فقط، والسابعة تجعلها قابلة للشراء فعليًا، والثامنة تضيف محرّك الفتيل العشوائي، والتاسعة الكشف، والعاشرة التحليلات والعروض الخاصة.
٧. لكل شريحة **بوابة** لا تُدمج قبل تحقّقها، و**طريقة تراجع** مكتوبة، و**اختبارات** يجب أن تضيفها.
٨. الحالات السبع عشرة التي نصّ عليها المالك موزّعة على الشرائح في القسم ٢، ولكل حالة ملف اختبار يملكها.
٩. كل الاختبارات على مستوى المسار الحقيقي عبر `tests/fixtures/app.ts` و`tests/fixtures/d1.ts`؛ لا محاكاة لـ D1 ولا للموجّهات، فالـ CHECK والـ UNIQUE والمُحفِّزات تعمل فعلًا.
١٠. المسار الحرج هو ٤ ← ٥ ← ٧؛ ويمكن تنفيذ ١ و٢ و٣ بالتوازي، والسادسة تبدأ فور تجميد أشكال استجابات الخامسة.
١١. لا شريحة تنشئ عمود مخزون خارج جداول المخزون الأربعة الحقيقية، ولا شريحة تفتح مسار كتابة ثانيًا لجداول المنتجات.
١٢. أي إعداد غير صالح يُرفض أو يُحذَّر منه حرفيًا بثلاث لغات، ولا يُصلَح صامتًا في أي شريحة.

---

## 0. How to read a slice

* **Scope** — the files and tables the slice touches. Nothing outside it changes.
* **Gate** — what must be true before it merges. Every gate includes
  `npm run test:unit` green (≈1934 assertions today, plus the slice's own).
* **Rollback** — how to undo it without a data migration.
* **Tests it must add** — new files, and existing suites it must extend.

Migration numbers are fixed: **0058, 0059, 0060, 0061, 0062**. The next free
number in the tree is 0058 (`migrations/0057_core_outbox.sql` is the newest).
Every migration is gated by `tests/migrations.test.ts`, which runs
`scripts/migrate-check.mjs --twice` and requires: a second full pass applying
zero files, at least one re-runnable statement in the newest migration, and
`foreign_key_check violations: 0`.

---

## 1. The slices

### Slice 1 — Foundations and the reservation fence

**Scope**

* `migrations/0058_composition_core.sql` — `products.composition` +
  `idx_products_composition`; `cart_items.draw_salt`; `bundle_config` (including
  `min_price_iqd`); `bundle_components`; `bundle_component_choices`;
  `cart_bundle_choices`; four `order_items` columns
  (`bundle_parent_item_id`, `bundle_component_id`, `component_value_iqd`,
  `component_alloc_iqd`) + `idx_order_items_bundle_parent`;
  `order_reservation_fence` keyed **`(order_id, kind)`**.
* `worker/lib/inventory.ts` — `planInventory` returns `plannedLedgerRows`; its
  pre-check sums demand per `(scope, scope_id)` across all moves instead of
  judging each move against the full `available`, and becomes **one batched
  read** rather than a sequential `SELECT` per move
  (`worker/lib/inventory.ts:436-459`); every `IN (…)` list is chunked
  (`:421-425`); new export
  `reservationFenceStatement(db, orderId, kind, expected)`.
* `worker/lib/orderInventory.ts` — `planOrderReturn` and `planOrderDeduction`
  carry their own fence rows, so a release or a deduction that matched zero rows
  rolls its refund back with it instead of committing a silent divergence.
* `worker/routes/orders.ts` — push the fence statement as the **last** inventory
  statement of the existing `stmts` array, for **every** order, bundle or not,
  and in the confirm and cancel batches too.
* `worker/lib/productModel.ts` — normalise `composition` beside
  `normalizeSaleTypes`.
* `worker/lib/productPersistence.ts` — `ProductWriteIntent` gains
  `allowComposition: boolean`; the §1.2 pins (`stock = NULL`,
  `inventory_mode='BASE'`, no options/colours/variants, `selling_type='bundle'`)
  and the `COMPOSITION_NOT_ALLOWED` refusal for any writer that did not set the
  flag. Because every writer goes through `planProductSave`, the TXT template and
  the CSV importer inherit the guard with no edit of their own.

**Gate**

* `tests/migrations.test.ts` green: 0058 applies twice, moves no row, zero
  foreign-key violations.
* The fence is live on ordinary single-product **checkout, confirmation and
  cancellation**, and **no existing test changes** — the fence writes one row per
  `(order, kind)` and passes.
* A deliberately short-guarded reservation, injected with `failingD1`'s pre-batch
  writer, aborts the whole batch: zero rows in `orders`, `order_items`,
  `inventory_ledger`, and the wallet balance unchanged.
* A deliberately short-guarded **release** during cancellation aborts the cancel
  batch: the order is still `pending`, the wallet is **not** refunded, and no
  stock is left held while the money has gone back.
* Two moves against one stock row are judged on their **sum**: a plan needing 2+2
  units of a row with 3 available is `rejected` at plan time with the friendly
  `CONFLICT_RETRY`, not accepted and then failed by the fence at commit.
* No new column named `stock` / `stock_reserved` / `reserved` / `available` /
  `quantity` outside the four real stock tables.

**Rollback** — revert the `stmts.push(reservationFenceStatement(...))` calls.
The tables are inert; `composition` defaults to `''` and `draw_salt` to `''`, so
every existing row behaves exactly as today.

**Tests it must add**

* `tests/reservationFence.test.ts` — the fence fires and passes on **each** of
  `reserve` / `deduct` / `release` / `restore`; it is idempotent under the
  order's replay path; a short-guarded release rolls the refund back with it;
  `planInventory`'s pre-check rejects summed over-demand on one row.
* `tests/compositionSchema.test.ts` — the §15.2 static invariant, reading
  `migrations/0058_*.sql`.
* extend `tests/migrations.test.ts` implicitly (it globs `migrations/`).

---

### Slice 2 — Inventory correctness prerequisite

A live bug, fixed before anything depends on it.

**Scope**

* `worker/routes/returns.ts` — replace
  `UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL`
  with `applyInventory(db, moves, { kind: 'restore', operationId: caseId,
  orderId, actorUserId, reason: 'return' })`, with `moves` reconstructed from the
  order's stored `deduct` ledger rows the way `worker/lib/orderInventory.ts` does.
* `worker/lib/orderInventory.ts` — release versus restore is decided **per ledger
  row** (a row with a matching `deduct` restores, one without releases), not once
  for the whole order via `hasLedgerKind` (`:126-129`), which today makes a
  partially deducted order try to restore rows that were never deducted — every
  one of which then fails its guard and matches zero rows.
* `worker/lib/inventory.ts` — `assertMovesApplied` gains its first callers: the
  admin stock screen and the new tests.

**Gate**

* A return on an `OPTION`, `COLOR` and `VARIANT_COMBINATION` product credits the
  **authoritative** row, writes an `inventory_ledger` row with kind `restore` and
  emits `InventoryChanged` — none of which happens today.
* A **partially deducted** order cancels correctly: the deducted rows restore, the
  never-deducted rows release, and no guard matches zero rows.
* The restore is idempotent: replaying the approval moves nothing a second time.
* No change to a `BASE`-mode product's observable behaviour.

**Rollback** — revert one function. No schema change.

**Tests it must add**

* `tests/returnsLedgerRestore.test.ts` — the four inventory modes × restore, plus
  the replay.

---

### Slice 3 — The one promotion model

**Scope**

* `migrations/0060_offer_eligibility.sql` — `offer_windows` (with `id`,
  `required_tiers` as a JSON **set**, and the offer price columns
  `offer_price_mode` / `offer_price_iqd` / `discount_percent` / `discount_iqd` /
  `plus_price_iqd`), `offer_limits`, `offer_redemptions` +
  `trg_offer_redemption_limits` + the two indexes.
* `worker/lib/offers.ts` — `scheduleState`, `offerEligible`, `resolveOfferPrice`,
  `loadOffers`, `offerLimitAdvice`, `offerRedemptionStatement`.
* `worker/routes/orders.ts` — two branches in the existing catch block:
  `OFFER_PER_USER_LIMIT` → 400 `PER_USER_LIMIT_REACHED`, `OFFER_GLOBAL_LIMIT` →
  400 `GLOBAL_LIMIT_REACHED`.

**Gate**

* `offerEligible` gates on an explicit **set** with the `INHERITS` map of
  contract §9 (`pro ⊇ plus`; `prime` standalone), so a PLUS-exclusive offer and
  its PLUS price are **not** handed to PRIME, and `plus+pro but not prime` is
  representable. `TIER_RANK` remains the only *ranking* in the tree and a grep
  proves no second one is introduced.
* `benefits.exclusiveSections` is ANDed **only when `required_tiers` is
  non-empty**. An ungated window is public: `offerEligible(null, view, now)` — a
  signed-out visitor — is eligible, and a `free` account can buy. Without this,
  attaching a window to an ordinary product purely for a schedule would silently
  make it subscriber-only and destroy slice 10's dividend.
* `resolveOfferPrice` is the **only** price a live window contributes; a window
  price beside a non-`fixed` `bundle_config.price_mode` is refused
  (`OFFER_PRICE_CONFLICT`), never summed.
* Two concurrent checkouts against `max_global = 1` produce exactly one order;
  the loser's whole batch, wallet spend and points included, rolls back.
* The tables are inert until a row exists: a checkout for a subject with no
  `offer_windows` row behaves exactly as today.

**Rollback** — a follow-up migration dropping the trigger; the three tables can
stay, unread.

**Tests it must add**

* `tests/offerEligibility.test.ts` — schedule states; the full
  `{guest, free, plus, prime, pro} × {no gate, plus, prime, pro, plus+pro}`
  matrix (PRO satisfies a PLUS requirement; **PRIME does not**; guest and free
  buy an ungated offer successfully); a restriction case pausing access.
* `tests/offerPricing.test.ts` — a live window price replaces the ladder and is
  the anchor the member rungs clamp against; an `upcoming` or `ended` window
  changes no price; the two price sources are never combined.
* `tests/offerLimits.test.ts` — per-user and global limits under concurrency, and
  the route's advisory count agreeing with the trigger's verdict.

---

### Slice 4 — The composition read model (pure functions only)

**Scope**

* `worker/lib/bundleComposition.ts` — `bundleAvailability` (demand aggregated per
  `(scope, scope_id)`, the eight-value `CompositionState` union, the `low` rule,
  the tier states from `OfferCheck`), `resolveBundlePrice` (derive the regular
  price first, then clamp the ladder against it), `compositionKey`,
  `allocateComponentValue` (largest remainder), `loadBundleComponents` (the
  batched loader).
* `worker/routes/products.ts` — `saleAvailability` gains `compositionMax` /
  `compositionModes`, the `'composition'` scope, the **fail-closed**
  `COMPOSITION_MAX_REQUIRED` branch, the `maxQty` clamp on the `preorder` branch
  as well as the direct one, and a `directEnabled` for composition rows that no
  longer derives from the `'bundle'` sale-type token.

**Gate**

* No route, no panel and no page calls anything here yet.
* `bundleAvailability` reproduces the owner's example exactly:
  printer 5 / filament needs 2 of 6 / nozzle 20 → `max_bundles = 3`; **and** two
  components resolving to one stock row with 3 available and 2 needed each give
  `max_bundles = 1`, not 1-per-component.
* All eight `CompositionState` values are producible, `low` included, from the
  rule written in contract §2.1 — nothing is left for a panel to invent.
* `resolveBundlePrice` never returns a negative price, never returns a price
  below `min_price_iqd` (it refuses instead), never inverts the ladder, and
  anchors the clamp on the **derived** regular price:
  `pro ≤ prime ≤ plus ≤ derived_regular`. It reads `tierActive` only from a
  caller that got it from `pricingTierContext`.
* `allocateComponentValue` sums **exactly** to the parent line total over 500
  randomised compositions, with every share ≥ 0.
* `saleAvailability` with `compositionMax` undefined is byte-identical to today
  **for an ordinary product**, and returns `mode: 'unavailable'`,
  `reason: 'COMPOSITION_MAX_REQUIRED'`, `max_qty: 0` for a composition row —
  asserted by walking all six call sites (`worker/routes/cart.ts:333, 527, 788`,
  `worker/routes/orders.ts:647`, `worker/routes/products.ts:825, 942`).
* A pre-order bundle reports `modes = [pre_order]` and never a direct-sale
  button, and `max_qty` is clamped by `compositionMax` on that branch too.

**Rollback** — delete the module; revert three lines in `saleAvailability`.

**Tests it must add**

* `tests/bundleAvailability.test.ts`
* `tests/bundlePricing.test.ts`
* `tests/bundleAllocation.test.ts`

---

### Slice 5 — Bundles admin, and the legacy migration

**Scope**

* `migrations/0059_bundles_migrate_legacy.sql` — the insert-only backfill.
* `worker/routes/bundles.ts` — `adminBundlesRoutes` re-implemented over the new
  model: list, read, create/update (`planProductSave` + `planBundleComposition`
  in one `saveProductAtomic` batch), duplicate, status, reorder, preview.
  `planBundleComposition` lives in `worker/lib/bundleComposition.ts`.
* `worker/routes/adminProducts.ts` — 409 `COMPOSITION_PRODUCT` when the product
  editor opens a composition row; the listing badges it; the delete path names
  the bundles that use a member product (via `idx_bundle_components_member`).
* `src/components/adminBundles/AdminBundles.tsx` — the rebuilt panel on the
  `.ap` token system. **Same default-export chunk name `AdminBundles`.**
* `src/pages/Admin.tsx` — the tab stays `bundles`, the lazy import path changes.

**Gate**

* 0059 applies twice and moves no row; every legacy bundle arrives as
  `status='draft'`, `price_iqd = 0`, `stock IS NULL`, with an `offer_windows` row
  carrying `required_tiers = ["plus","prime","pro"]` — today's `exclusiveSections`
  gate, written as a set and preserved exactly.
* Every migrated row shows the `MIGRATED_NEEDS_PRICE` warning, and publishing one
  with `price_mode='fixed'` and `price_iqd = 0` is **refused**.
* The composition write is inside `saveProductAtomic`'s single batch — a test
  asserts no second `db.batch` touches a product table.
* Every §11.3 warning and refusal is produced by the server, verbatim, in three
  languages, in the `{ code, message, key?, line?, ar, en, ckb }` shape both
  existing decoders already understand; nothing is repaired.
  `refusalIssues(body)` contains no `'undefined'` and the success-path
  `warnings` survive `strList` — asserted directly, because an object-shaped
  warning renders as "[object Object]" or vanishes entirely, which is how the
  three warnings the owner quoted word for word would never reach an admin.
* `discount_iqd >= the component total` is **refused**
  (`BUNDLE_DISCOUNT_EXCEEDS_TOTAL`), and a window price beside a non-`fixed`
  `price_mode` is refused (`OFFER_PRICE_CONFLICT`).
* `tests/adminHostGuard.test.ts` and `tests/adminScope.test.ts` extended: the new
  routes 404 on a merchant host, and component cost never reaches an assistant
  admin's preview.

**Rollback** — unmount the new admin handlers; the migrated products are drafts
and invisible; the legacy `bundles` / `bundle_items` rows are untouched.

**Tests it must add**

* `tests/bundlesMigrateLegacy.test.ts`
* `tests/adminBundlesRoutes.test.ts` (CRUD, refusals, warnings, audit rows,
  single-batch assertion)
* extend `tests/bundleBudget.test.ts` with `AdminBundles` still present.

---

### Slice 6 — The public read path

**Scope**

* `worker/routes/bundles.ts` — `GET /api/bundles`, `GET /api/bundles/:slug`,
  preserving the `{ entitled, signed_in, bundles[] }` keys.
* `worker/routes/products.ts` — `AND composition = ''` on the default listing;
  the `type=bundle` flip; the composition redirect on `GET /api/products/:slug`.
* `src/pages/Bundles.tsx` rebuilt and **moved to `React.lazy`** in
  `src/App.tsx`; `src/pages/BundleDetail.tsx` added at `/bundles/:slug`;
  `src/components/BottomNav.tsx` gains `/bundles/`.
* `src/components/ui/OfferBadge.tsx` (with `tracking-wide` conditional on latin
  content), `src/components/ui/Countdown.tsx` (`<bdi dir="ltr">`, a shared 1 Hz
  tick that keeps running under reduced motion, and one `useFreshOnReturn`
  revalidate when it reaches zero),
  `src/components/bundles/BundleSavingLine.tsx` (the struck component total and
  the savings badge — `CardPrice` cannot render either), the `'plus'` branch in
  `src/components/CardPrice.tsx`, and
  `BundleCardSkeleton` / `BundleGridSkeleton` / `BundleDetailSkeleton` inside
  `src/components/ui/Skeleton.tsx`.
* Search, the category facet, the filter chips and the `is_featured` rail on
  `/bundles`, reusing the `GET /api/products` parameter shapes and the
  `Products.tsx` chip layout.
* A home shelf registered in `src/pages/Home.tsx`'s ordered section list **and**
  in `INITIAL_SECTIONS` + `SECTION_ICONS` in
  `src/components/AdminHomeSettings.tsx` — without the second half the shelf is
  pinned to the bottom of the home page for ever, cannot be hidden, and never
  appears in the admin's drag-to-reorder list.

**Gate**

* A browsable, honest, **unbuyable** catalogue: no add-to-cart path exists yet.
* The list payload carries a coarse availability state and **no counts, no
  components, no pool, no weights** — asserted on the serialized JSON.
* A locked card is a 200 with `entitled:false`, never a 403, and its payload is
  the contract §9 **allow-list**: the test asserts the **stripped key list**
  (`display_price_iqd`, `display_prime_iqd`, `display_pro_iqd`,
  `display_applied_tier`, `composition.*`, `saving_percent`, every availability
  count), not the absence of one number.
* A signed-out visitor and a `free` account both see and can reach an **ungated**
  bundle; only a gated one locks.
* A PLUS member sees the PLUS price on the card, and it is the same number the
  cart and the door will charge.
* A derived-mode bundle serves the **freshly derived** price on the card, not the
  cached `products.price_iqd`.
* A request carrying a session cookie never receives `Cache-Control: public`; the
  anonymous variant carries `Vary: Cookie`.
* The hand-rolled spinner and error div in today's `Bundles.tsx` are gone,
  replaced by `AsyncStates`.
* `tests/bundleBudget.test.ts` green with the new chunk names; the entry chunk
  **shrinks** because `Bundles` is no longer eager.
* One page of 24 bundles costs four D1 round trips.

**Rollback** — revert the two routes and the two pages; the admin panel keeps
working.

**Tests it must add**

* `tests/bundlesPublicRoutes.test.ts` (payload shape, locked cards, no leakage of
  counts or components, the four-query budget)
* extend `tests/asyncStates.test.ts` coverage for the new pages.

---

### Slice 7 — The buy path (bundles become sellable)

The critical slice.

**Scope**

* `worker/routes/cart.ts` — `selectionFromCartRow` returns an **empty selection**
  (`optionId` *and* `optionValueIds`) for a composition row, with
  `products.composition` threaded into the cart `SELECT`s so it can (contract
  §5.1); the composition branch in `POST /api/cart/items` (validate choices,
  canonicalise and sort `option_value_ids`, compute `compositionKey` into
  `option_id`, validate and store the pre-order `transport_method` on the parent
  row, write `cart_bundle_choices` in the same batch); `PATCH` **refuses**
  `BUNDLE_QTY_LIMIT` rather than clamping, and choice edits; the grouped
  `loadCart` payload.
* `worker/routes/orders.ts` — the `priceLines` composition branch (parent
  snapshot rungs pinned to the charged figures; component pre-order commissions
  and `direct_surcharge_iqd` summed onto the parent's `unit_subtotal_iqd` and
  `transport_snapshot`, with `merchandise` left at `bundle_price_iqd`; the
  per-target demand map; the `MAX_PHYSICAL_LINES` ceiling;
  `BUNDLE_OPTIONAL_UNAVAILABLE` instead of a silent drop); four optional
  `ComputedLine` fields; the parent + component `order_items` INSERTs;
  **one** `offer_redemptions` row per (subject, order) with `qty` summed; the
  **six** component filters — `orderPublic`, the **quote serializer**, the
  invoice, the receipt, the courier summary and the Telegram message;
  `computeCheckout` gains `{ allocate }` (always `false` for now).
* `worker/lib/invoices.ts` — components become `included[]` under the parent.
* `worker/routes/returns.ts` — the **refund arithmetic** (`caseGross` from
  `component_alloc_iqd`, scaled by `kase.qty / order_items.qty`, fed to
  `reversePointsForOrder` as well); price protection reads `component_value_iqd`
  and refuses a parent claim with `COMPOSITION_NOT_ELIGIBLE`; the bundle group is
  surfaced; `BUNDLE_PARTIAL_RETURN_NOT_ALLOWED`.
* `src/pages/Cart.tsx` (the expandable disclosure), `src/pages/Checkout.tsx` (the
  same disclosure on the review screen, and `is_printer` read from the parent so
  the printer delivery note still fires),
  `src/components/adminOrders/OrderDetailModal.tsx` (components grouped under
  their parent for the staff who pack the box), `src/pages/OrderDetail.tsx` (the
  grouped item), `src/lib/api.ts` (`composition` on `CartItem`, `bundle` on
  `ApiOrderItem`, `'plus'` in the display-tier union).

**Gate**

* A bundle is purchasable end to end, and **cases 1, 2, 5, 6, 7, 8, 10, 11, 12,
  17** of §2 pass.
* `Σ order_items.line_total_iqd === orders.subtotal_iqd` with a bundle in the
  order; `Σ component_alloc_iqd === the parent's line_total_iqd` exactly.
* Every component `pricing_snapshot.applied_iqd` is `0` **and the parent's is
  exactly `bundle_price_iqd`**, so points accrue only on the parent and on the
  number actually charged. The invariant is asserted directly, because this is
  the one thing that silently gives away money if it is wrong:
  `eligibleMerchandiseIqd(items) === orders.merchandise_iqd` for every order
  containing a bundle, in a derived price mode as well as `fixed`.
* `quote.lines.length === 1` for a four-component bundle, with the components
  nested as `included[]`, and the checkout's printer delivery note still fires
  for a bundle containing a printer.
* A whole-bundle return refunds the parent's `line_total_iqd` **net of** its
  share of coupon and points — not 0, and not the gross.
* `tests/cartUpsert.test.ts` extended with a bundle line, proving
  `idx_cart_levonis_line` still binds and `ON CONFLICT` still names a real index.
* No component row appears as a top-level cart item, order item **or quote
  line** in any customer payload.
* An order may contain two lines of the same bundle with different colour
  choices, and it writes exactly **one** `offer_redemptions` row with the summed
  `qty`.
* An optional component the buyer opted into and that cannot be satisfied is
  **refused** with `BUNDLE_OPTIONAL_UNAVAILABLE` naming it — never dropped, and
  never charged for.

**Rollback** — set every composition product to `status='draft'`. The branch is
reached only by a composition row, so the ordinary path is untouched.

**Tests it must add**

* `tests/bundleCart.test.ts`
* `tests/bundleCheckout.test.ts`
* `tests/bundleOrderSnapshot.test.ts`
* `tests/bundleReturns.test.ts`
* `tests/bundleBatchLimits.test.ts` — a maximal legal order stays inside D1's
  bound-parameter and request-size limits; one above `MAX_PHYSICAL_LINES` is
  refused with `COMPOSITION_TOO_LARGE`, not an opaque D1 error
* extend `tests/cartUpsert.test.ts`

---

### Slice 8 — The mystery engine

**Scope**

* `migrations/0061_mystery_pools.sql` — `mystery_pools`,
  `mystery_pool_entries` (`product_id … ON DELETE RESTRICT`), `mystery_offers`,
  `mystery_offer_secrets`, `mystery_allocations` (with `reveal_stage_snapshot`
  and `candidates_sha256`), `mystery_draw_audits` (pools first).
* `worker/lib/mysteryDraw.ts` — the candidate query, the structured eligibility
  filter, `drawSpools` using `seedFrom` / `sequence` / `weightedIndex` from
  `worker/lib/farm/rng.ts`, and the duplicate policy. **The only file that reads
  `mystery_offer_secrets`**, asserted by a static test.
* `worker/routes/orders.ts` — the mystery **pre-pass** beside `loadRelationsViews`
  (candidate load, one `await seedFrom(secret, cart_items.draw_salt)` per mystery
  cart row, and the resolved draw), so `priceLines` stays synchronous and pure and
  all three of its passes see the same filament; `mystery_allocations` and
  `mystery_draw_audits` rows appended to the order's batch;
  `product_id = NULL` bound on a mystery component's `order_items` INSERT with
  `pricing_snapshot = null`; `OrderCreated.items[]` built from the persisted
  rows; `MYSTERY_REVEALED_NO_CANCEL` on the self-cancel route;
  `computeCheckout({ allocate: true })` for `POST /api/orders` and
  `{ allocate: false }` for the quote.
* `worker/routes/cart.ts` — `draw_salt = randomSeedHex()` written when a mystery
  line is created; `rateLimit(c, 'composition_quote', …)` on the composition
  add-to-cart and quote paths.
* `packages/contracts` — `orderItemRef.product_id` nullable, plus `item_kind`.
* `worker/lib/orderStageOps.ts` — `String(r.product_id ?? '') || null` in the
  `OrderDelivered` item map.
* `worker/routes/mystery.ts` — **a new admin router with its own
  `.use('*', requireAdmin)`**, mounted at `/api/admin/mystery` in
  `worker/index.ts`: pools CRUD, the paginated entries list, the server-side bulk
  generator, the whole-set replace (`expected_updated_at` → 409 `STALE_EDIT`,
  deactivating rather than deleting), and
  `GET /api/admin/mystery/pools/:id/eligible`. Every odds- or disclosure-changing
  write uses `auditStatements` **inside** its batch.
* `worker/routes/products.ts`, `worker/lib/productOverlay.ts` — exact `available`
  suppressed for any product in an active pool (contract §8.2 row 18).
* `src/components/adminMystery/AdminMystery.tsx`,
  `src/components/adminMystery/AdminMysteryPools.tsx`, and their two tabs in
  `src/pages/Admin.tsx`.

**Gate**

* **Cases 13, 14** of §2 pass, and the two supplementary statistical tests below.
* The offer secret appears in **no** API response — asserted by walking every
  serialized admin **and** public payload in the whole suite, not only the
  mystery tests, and by a static assertion that no file outside
  `worker/lib/mysteryDraw.ts` references `mystery_offer_secrets`. Duplicating an
  offer generates a **new** secret.
* No client-chosen value reaches the seed: a grep proves the checkout idempotency
  key and `user.id` are not seed inputs, and the three `priceLines` passes plus
  the quote produce identical allocations.
* The quote draws nothing and writes nothing.
* A mystery order emits exactly **one** valid `OrderCreated` outbox row, carrying
  no drawn product id — the row's existence asserted as well as its contents,
  because `outboxStatement` swallows a validation failure and returns `null`.
* Editing a pool that has already been drawn from **succeeds**: entries that
  leave the set are deactivated, and no foreign key is violated.
* `MYSTERY_NOT_ENOUGH_VARIETY` reaches the customer with **no count**; the count
  appears only in the admin preview and the save-time warning.
* A direct purchase is never converted to a pre-order, and a mode with no pool
  refuses with `MYSTERY_MODE_NOT_AVAILABLE`.
* The admin eligible-stock preview and the storefront availability come from the
  same function.

**Rollback** — leave every mystery offer `status='draft'`. The tables and the
draw code are unreachable.

**Tests it must add**

* `tests/mysteryAllocation.test.ts` (permanence, replay, concurrency; the three
  `priceLines` passes agree; the wallet-covers-the-total branch persists the same
  draw; the draw is reproducible years later from `seed` + `mystery_draw_audits`)
* `tests/mysteryPoolAdmin.test.ts` (sell from a pool, then edit it; the bulk
  generator; `STALE_EDIT` on a concurrent whole-set replace; deactivation instead
  of deletion; `auditStatements` inside the batch)
* `tests/mysteryPool.test.ts` (candidate exclusion: zero stock, weight 0,
  inactive product/option/colour, wrong pool kind, failed catalog/facet
  requirement; **never** a name match)
* `tests/mysteryWeights.test.ts` — 10 000 seeded draws over weights {1, 3, 6}
  land within 2 % of 10 / 30 / 60 %; weight 0 is never drawn; a given
  `(seed, salt)` reproduces the same sequence
* `tests/mysteryMultiSpool.test.ts` — `forbid` never repeats and refuses with
  `MYSTERY_NOT_ENOUGH_VARIETY` when the wheel empties; `discourage` halves;
  three spools produce three allocations and three ledger rows, or none at all

---

### Slice 9 — Reveal

**Scope**

* `worker/lib/mysteryReveal.ts` — `isRevealed` (`revealed_at !== null ||`
  derivation over `reveal_stage_snapshot`, stage-index based over `stagesFor`)
  and `mysteryProjection`, through which **every** mystery row is routed on the
  way out rather than relying on the NULL `product_id`.
* `worker/lib/orderStageOps.ts` — one statement in `moveOrderStage`'s existing
  batch stamping `mystery_allocations.revealed_at`.
* `worker/routes/orders.ts` — the `'paid'` milestone stamped by
  `POST /api/orders/:id/settlement`; the projection applied in `orderPublic`.
* `worker/routes/admin.ts` — the admin order payload carries the pick with a
  "not yet revealed to the customer" chip; the customer receipt copy does not.
  `reveal_stage_label` is computed by the existing
  `stageLabel(stage, shipping_type, lang)` and shipped beside `reveal_stage`.
* `src/components/adminOrders/OrderDetailModal.tsx` — the pick actually
  **rendered** on the screen staff read when packing; without this the allocation
  reaches the API and stops there.
* `src/components/offers/MysteryReveal.tsx` (rendering the server's
  `reveal_stage_label`, never a second client-side stage table) and the
  order-detail rendering.

**Gate**

* **Case 15** of §2 passes across all **twenty** surfaces of contract §8.2,
  including the public catalogue differential and the component
  `pricing_snapshot`.
* Reveal is monotone on **both** axes: a backwards order-stage move does not
  un-reveal, **and** editing `bundle_config.reveal_stage` in either direction
  leaves every existing order's milestone where it was.
* Admins see the pick throughout — asserted positively, on the admin payload, not
  only by the absence of leaks elsewhere. The courier payload and the customer
  receipt never do before the milestone.
* A customer cannot self-cancel a revealed mystery order
  (`MYSTERY_REVEALED_NO_CANCEL`), and cancelling does not free the per-user
  redemption slot — so a reveal-at-`paid` offer cannot be re-rolled.

**Rollback** — set `bundle_config.reveal_stage = 'paid'` on every **new** offer,
which is honest (reveal after payment) and leaks nothing earlier. Existing orders
keep the milestone frozen on their allocation, which is the point of
`reveal_stage_snapshot`.

**Tests it must add**

* `tests/mysteryReveal.test.ts` — the leak walk plus the monotonicity assertion.

---

### Slice 10 — Analytics, special offers, and polish

**Scope**

* `migrations/0062_composition_analytics.sql` — `composition_daily_metrics`,
  `mystery_allocation_stats`.
* `worker/routes/bundles.ts` — `POST /api/bundles/:productId/view`
  (**session-required**, subject validated to be a `composition <> ''` row,
  rate-limited), the `adds` and `oos_blocks` upserts, and the two admin analytics
  routes.
* `worker/routes/offers.ts` — **a new admin router with its own
  `.use('*', requireAdmin)`**, mounted at `/api/admin/offers`.
* `worker/routes/products.ts` — `resolveOfferPrice` applied to an **ordinary**
  product's public payload, so a scheduled discount changes the price the card
  and the door quote, through the same helper bundles use.
* `src/components/adminOffers/AdminOffers.tsx` — windows, `required_tiers`,
  limits **and the offer price** for **any** subject, which is how a scheduled,
  tier-gated, limited, **discounted** special offer on an ordinary product ships
  with no new table and no second discount code path.
* The countdown and savings badge applied to ordinary product cards for scheduled
  special offers.

**Gate**

* Every analytics figure is either a counter of something no table records, or a
  query over `order_items` / `order_offer` snapshots / `mystery_allocations`.
  Nothing is double-counted and nothing joins `users`.
* `mystery_allocation_stats` exposes no order id and no user id.
* A scheduled, tier-gated, limited **and discounted** offer on an ordinary
  product works using only `offer_windows` + `offer_limits` — no new table, no
  new code path — and the price it produced is frozen in the order snapshot's
  `offer` block with its `offer_id`, so "which offer produced this price" is
  answerable years later.
* `views` is signed-in-only, is never an input to a price, a limit or an
  eligibility decision, and an unvalidated subject cannot be seeded into
  `composition_daily_metrics`.

**Rollback** — drop the table and the view; remove the tab.

**Tests it must add**

* `tests/compositionAnalytics.test.ts` (no customer-sensitive column reachable;
  counters idempotent per day)
* `tests/specialOffers.test.ts` (an ordinary product gated, scheduled **and
  repriced** by `offer_windows`: the card, the cart and the door quote the offer
  price while live and the ladder price when the window is `upcoming` or `ended`;
  the offer id and its figures are frozen in the snapshot; refused at the door
  when the gate fails)

---

### Order, parallelism and the critical path

```
1 ─┬─ 2                    (both are standalone bug fixes; land first regardless)
   ├─ 3
   └─ 4 ─ 5 ─ 6
             └─ 7 ─ 8 ─ 9 ─ 10
```

* **Slices 1, 2 and 3 are independent** and can be built in parallel by two
  people. Slices 1 and 2 are pure fixes to live defects and should merge even if
  the rest of the mandate stops.
* **The critical path is 4 → 5 → 7.**
* **Slice 6 can start against a fixture** as soon as slice 5's response shapes are
  frozen.
* Nothing is customer-visible before slice 6, and nothing is purchasable before
  slice 7.

---

## 2. The seventeen mandated cases, and the slice that owns each

Every case runs at route level using `tests/fixtures/app.ts` — `freshDb()`
applies every migration, `stubApp` builds the real Hono app with a stub session
user, `failingD1` injects batch failures and pre-batch concurrent writers — over
`tests/fixtures/d1.ts`'s `SqliteD1`, whose `batch` is a real transaction with
`ROLLBACK`. `CHECK`, `UNIQUE`, trigger and zero-row-guard behaviour therefore
executes for real. **No mocks of D1 and no mocks of the routers.**

| # | case | owning slice | test file | the assertion |
|---|---|---|---|---|
| 1 | **Availability is the scarcest component** | 4 (unit) + 7 (route) | `tests/bundleAvailability.test.ts`, `tests/bundleCheckout.test.ts` | printer 5, filament needs 2 of 6, nozzle 20 → `max_bundles === 3`; qty 4 refused `OUT_OF_STOCK`; qty 3 accepted; an untracked required component contributes nothing; a `VARIANT_NOT_MODELLED` component contributes 0 with its code in `blocking[]`; **two components resolving to one stock row are summed** (3 available, 2 needed each → `max_bundles === 1`), and a bundle plus a bare product of the same colour in one cart is refused at plan time, not at the fence; every `saleAvailability` call site returns `max_qty === 0` for a composition row with no `compositionMax` |
| 2 | **Atomic reservation; any component failing fails the whole operation safely** | 1 (fence) + 7 (bundles) | `tests/reservationFence.test.ts`, `tests/bundleCheckout.test.ts` | a 3-component bundle whose 2nd component is taken by `failingD1`'s pre-batch writer between plan and commit ⇒ the fence `CHECK` fires; **zero** rows in `orders`, `order_items`, `inventory_ledger`, `offer_redemptions`, `mystery_allocations`, `order_reservation_fence`; the wallet and points balances unchanged; the customer gets `CONFLICT_RETRY` |
| 3 | **Never duplicate product inventory** | 1 | `tests/compositionSchema.test.ts` | migrations 0058-0062 add no `stock` / `stock_reserved` / `reserved` / `available` / `quantity` column to any `bundle_*`, `mystery_*`, `offer_*` or `cart_bundle_*` table; after a bundle purchase the only changed counters are on `products`, `product_option_values`, `product_colors`, `product_variants` |
| 4 | **A pre-order bundle sells without physical stock** | 7 | `tests/bundleCheckout.test.ts` | every component `pre_order` with `stock IS NULL` ⇒ purchasable. **Before the order**: the detail payload's `mode` is `pre_order`, there is no direct-sale button and `max_qty` is not 99. The chosen transport is validated against every component and stored on the parent cart row, so `orders.shipping_type = 'preorder_air'` and the 14-stage path follow; the components' transport commissions and surcharges appear in the parent's `unit_subtotal_iqd` and `transport_snapshot` while `merchandise` stays `bundle_price_iqd`; **zero** `reserve` ledger rows; the fence still passes with `expected = 0`. A bundle whose pre-order components share no transport method is refused at save |
| 5 | **Incompatible selling/shipping modes are never mixed** | 5 (admin) + 7 (door) | `tests/adminBundlesRoutes.test.ts`, `tests/bundleCart.test.ts` | admin save of a direct + pre-order bundle ⇒ 400 `BUNDLE_SHIPPING_MIXED` naming both components; a bundle that *became* mixed after save is refused at add-to-cart; it is never split and never forced onto the slowest transport |
| 6 | **Price is never trusted from the browser** | 7 | `tests/bundleCheckout.test.ts` | a cart and checkout body carrying `bundle_price_iqd`, `component_total_iqd`, `saving_percent`, `discount_iqd` and `applied_tier` is ignored; the stored order carries the server's figures byte for byte |
| 7 | **The order snapshot is immutable** | 7 | `tests/bundleOrderSnapshot.test.ts` | buy, then change every component price and name, deactivate a colour and delete an option value ⇒ `GET /api/orders/:id` and the invoice are unchanged; no `cost_iqd` anywhere in the snapshot |
| 8 | **No negative total, no invalid stacking** | 4 (unit) + 7 (route) | `tests/bundlePricing.test.ts`, `tests/bundleCheckout.test.ts` | a `discount_iqd` at or above the component total is **refused at admin save** with `BUNDLE_DISCOUNT_EXCEEDS_TOTAL` — a free bundle is never published, and the old expectation that it merely produced `bundle_price_iqd = 0` is replaced; a derived price that later falls below `min_price_iqd` (a component went free) stops the sale with `OFFER_INACTIVE` and a loud admin warning rather than selling at 0; `discount_percent = 200` refused at admin save; a window price beside a non-`fixed` `price_mode` refused with `OFFER_PRICE_CONFLICT`; the member ladder is clamped against the **derived** regular price, so a PRO is never charged more than a regular buyer; a coupon on a bundle order applies once, to merchandise that already contains the bundle price, with `settle` unchanged |
| 9 | **No unauthorised membership pricing; the locked purchase API rejects** | 3 (model) + 6 (lock) + 7 (door) | `tests/offerEligibility.test.ts`, `tests/bundlesPublicRoutes.test.ts`, `tests/bundleCheckout.test.ts` | a free account and a `required_tiers=["plus"]` bundle: the list returns 200 with a locked card whose **stripped key list** is asserted (`display_price_iqd`, `display_prime_iqd`, `display_pro_iqd`, `display_applied_tier`, `composition.*`, `saving_percent`, every count), `POST /api/cart/items` refuses `MEMBERSHIP_REQUIRED`, `POST /api/orders` refuses; a PRO buying a PLUS-required bundle **succeeds** and a **PRIME does not**; an active PLUS member is shown the PLUS price on the card and charged that same number in the cart and at the door; a PRO away from the approved default address is charged the regular price on the page, in the cart and at the door, identically |
| 10 | **The cart is ONE main item with expandable contents** | 7 | `tests/bundleCart.test.ts` | `GET /api/cart` returns exactly one top-level item for a 4-component bundle; `composition.components.length === 4`; the merchandise sum and the coupon basis count the bundle once; `cart_bundle_choices` holds four rows. **10b:** a composition line derives an **empty selection** — `optionId` *and* `optionValueIds` — so `OPTION_NOT_FOUND` reaches neither `ResolvedPrice.errors` **nor** `saleAvailability(...).selection.errors`, and `refuseIncompleteSelection` passes (contract §5.1). Both are asserted; blanking only `optionId` leaves the second one failing |
| 11 | **Checkout re-validates everything** | 7 | `tests/bundleCheckout.test.ts` | mutate each of `{status, offer_windows.active, starts_at, ends_at, required_tiers, price, component stock, a chosen colour deactivated, a component's sale type, an opted-in optional component made unsatisfiable, a component's transport method withdrawn, qty above max_qty_per_order, physical lines above MAX_PHYSICAL_LINES}` **after** the cart row is written ⇒ each produces its own named 400 and writes nothing |
| 12 | **Returns, cancellation and refunds know the physical components** | 2 (ledger) + 7 (grouping) | `tests/returnsLedgerRestore.test.ts`, `tests/bundleReturns.test.ts` | cancellation releases every component in the same batch as the status flip, **and its own fence row proves each release landed** — a short-guarded release rolls the refund back rather than refunding money while the units stay held; after delivery the return flow lists the four component `order_items` with `Σ component_alloc_iqd === the parent's line_total_iqd`, and **`Σ refundIqd` equals that total minus its share of coupon and points** (not 0, which is what pricing a component case off `unit_price_iqd` would give, and not the gross); the points reversal uses the same basis; a partial-qty return of a multi-qty bundle scales by `kase.qty / order_items.qty`; the restore writes `inventory_ledger` rows against the **colour** row, never `products.stock`; a single-component case is refused `BUNDLE_PARTIAL_RETURN_NOT_ALLOWED`; a price-protection claim on the parent is refused `COMPOSITION_NOT_ELIGIBLE` while a component claim is evaluated on its `component_value_iqd` |
| 13 | **A mystery pick never changes** | 8 | `tests/mysteryAllocation.test.ts` | draw, then: re-POST with the same idempotency key; re-request the quote; re-read the order; replay the webhook; fire the route 20× concurrently ⇒ the same `mystery_allocations` row every time, one `reserve` ledger row per spool, one order. The quote writes **no** allocation |
| 14 | **No eligible stock ⇒ a genuine out-of-stock state** | 8 | `tests/mysteryPool.test.ts` | a pool whose every entry is stock 0, weight 0, inactive, disabled-colour or of the wrong pool kind ⇒ `GET /api/bundles/:slug` reports `sold_out`, `POST /api/cart/items` returns 503 `MYSTERY_NO_ELIGIBLE_STOCK`, nothing is written, and a direct purchase is **not** converted to a pre-order. Eligibility is never decided by a product name |
| 15 | **The reveal leaks nothing before the milestone** | 9 | `tests/mysteryReveal.test.ts` | for each of the **twenty** surfaces in contract §8.2, `JSON.stringify(payload)` contains **none** of the drawn product's id, slug, name, image URL or colour id before `revealed_at` — **and none of its prices**: no number equal to its `regular_iqd`, `prime_iqd`, `pro_iqd` or standalone value appears in any pre-reveal payload, invoice or receipt (the component `pricing_snapshot` is `null` and the component value is the offer-derived share). Plus a **differential** assertion on surface 18: the whole public catalogue JSON is captured before and after the purchase and no per-colour or per-option number changed. After the milestone the customer payload contains all of them; the admin payload contains them **throughout — asserted positively**, including on `OrderDetailModal`'s data; a backwards stage move does not un-reveal, **and** editing `bundle_config.reveal_stage` in either direction moves no existing order's milestone |
| 16 | **PRO inherits PLUS; every eligibility check is server-side** | 3 | `tests/offerEligibility.test.ts` | a matrix over {**guest**, free, plus, prime, pro} × {no gate, plus, prime, pro, **plus+pro**} × {active, expired, restricted via `gated_benefits`} — every cell asserts the list payload **and** the purchase verdict, and asserts they agree. The load-bearing cells: PRO satisfies a PLUS requirement; **PRIME does not** and is not offered the PLUS price; `plus+pro` admits both and excludes PRIME; the whole **no-gate column purchases successfully, guests and free accounts included**. `TIER_RANK` is the only ranking used; the tier *set* uses the `INHERITS` map |
| 17 | **Double purchase or double reservation is impossible** | 1 + 3 + 7 | `tests/bundleCheckout.test.ts`, `tests/offerLimits.test.ts` | double tap (two concurrent POSTs, same key), network retry, refresh, webhook retry and two concurrent checkouts for the last available bundle ⇒ exactly one order, exactly one set of ledger rows, exactly one `offer_redemptions` row; the loser receives `CONFLICT_RETRY` or the replayed order, never a second charge |

### Supplementary tests each slice must also add

Not among the owner's seventeen, but required by the contract:

| test | slice | asserts |
|---|---|---|
| `tests/bundleAllocation.test.ts` | 4 | largest-remainder allocation sums exactly over 500 randomised compositions; every share ≥ 0 |
| `tests/bundlePricing.test.ts` | 4 | the ladder never inverts **and its anchor is the derived regular price** (`pro ≤ prime ≤ plus ≤ derived_regular`); a PLUS price is offer-scoped and appears on no ordinary product payload; a derived price below `min_price_iqd` refuses rather than sells |
| `tests/offerPricing.test.ts` | 3 | a live window price replaces the ladder and anchors the member rungs; an `upcoming` or `ended` window changes no price; the two sources are never combined |
| `tests/bundleBatchLimits.test.ts` | 7 | a maximal legal order stays inside D1's bound-parameter and request-size limits; one above `MAX_PHYSICAL_LINES` is refused with `COMPOSITION_TOO_LARGE` |
| `tests/mysteryPoolAdmin.test.ts` | 8 | selling from a pool does not lock it: entries are deactivated, not deleted; the bulk generator; `STALE_EDIT` on a concurrent whole-set replace; odds changes audited inside their batch |
| `tests/refusalStrings.test.ts` | 7 + 8 | every customer-facing code in contract §15.3 has an `ar`, `en` and `ckb` string, so no code is ever printed to a customer as a bare identifier |
| `tests/contractsOrderItems.test.ts` | 8 | a mystery order emits exactly one valid `OrderCreated` outbox row carrying no drawn product id; `OrderDelivered` never writes the string `"null"` as a product id |
| `tests/mysteryWeights.test.ts` | 8 | 10 000 seeded draws land within 2 % of the configured weights; weight 0 is never drawn; `(seed, salt)` is reproducible |
| `tests/mysteryMultiSpool.test.ts` | 8 | `forbid` / `discourage` / `allow` behave as specified; a partial multi-spool reservation cannot commit |
| `tests/bundlesMigrateLegacy.test.ts` | 5 | 0059 applies twice, moves no row, converts epoch-ms to ISO, and lands every row as an unpriced draft with the PLUS gate preserved |
| `tests/compositionAnalytics.test.ts` | 10 | no user id or order id is reachable from `mystery_allocation_stats`; counters are idempotent per day |
| `tests/specialOffers.test.ts` | 10 | a scheduled, tier-gated, limited offer on an **ordinary** product uses only `offer_windows` + `offer_limits` |

---

## 3. Standing suites that must keep passing, unchanged

| suite | why it matters here |
|---|---|
| `tests/migrations.test.ts` | every new migration applies twice, moves no row, has a re-runnable statement, and leaves zero foreign-key violations |
| `tests/migrationsAdditive.test.ts` | the classifier itself; the new files must not regress it |
| `tests/cartUpsert.test.ts` | `idx_cart_levonis_line` still binds and `ON CONFLICT` still names a real index once bundle lines exist — the exact regression `migrations/0032_cart_line_identity.sql` was written to end |
| `tests/bundleBudget.test.ts` | the new chunk names are pinned; `AdminBundles` keeps its chunk; the entry chunk shrinks when `Bundles` goes lazy |
| `tests/adminHostGuard.test.ts` | every new admin router 404s on a merchant host — extended to **enumerate every route registered under `/api/admin/*`** and assert a non-admin session gets 403, since `requireMainHost` is a host check and `requireAdmin` is attached per router, so a new mount without its own guard is an open admin API |
| `tests/adminScope.test.ts` | component cost and margin never reach an assistant admin |
| `tests/asyncStates.test.ts` | 401 is never rendered as "no bundles"; 404 is never an error toast |
| `tests/shippingType.test.ts` | the shipping-type vocabulary is not forked |
| `tests/orderStages.test.ts` | **no stage is added**; reveal milestones map onto the existing five and fourteen, and the reveal label comes from the server's existing `stageLabel`, never a second client table |
| `tests/events.test.ts` (contracts) | the widened `orderItemRef` still validates every existing producer; a nullable `product_id` breaks no consumer |
| `tests/storefrontIsolation.test.ts` | no bundle route reaches a merchant subdomain |

---

## 4. Definition of done

The mandate is delivered when, in one continuous flow on a fresh database:

1. an admin composes a bundle from real products, variants and colours, sees the
   server's component value, saving and `max_bundles`, sees every warning
   verbatim in three languages, and publishes it;
2. an admin configures a mystery pool with weights, sees the eligible-stock
   preview and the computed probabilities, and publishes a mystery offer;
3. a signed-out visitor browses `/bundles`, sees honest availability, a countdown
   and a polished locked card, and is invited to sign in;
4. an eligible member adds a bundle to the cart as **one** expandable line, and a
   mystery offer as one line that reveals nothing;
5. the checkout re-validates everything, computes every figure server-side,
   reserves every component atomically in one batch, draws the filament
   server-side and permanently, and writes an immutable snapshot;
6. a double tap, a refresh, a retry and a webhook replay all produce exactly one
   order;
7. the order walks its existing stage path; the filament is revealed at the
   milestone frozen on the allocation and not one stage earlier — and no later
   edit of the offer's configuration moves that milestone for an order already
   placed;
8. a return finds the real physical components and puts the units back on the
   rows they came from, through the ledger;
9. the admin sees purchases, revenue, savings, pool usage and allocation counts
   with no customer-sensitive data, and can reconstruct **why** any past draw
   produced what it did from its seed and its candidate snapshot;
10. and `npm run test:unit` is green, including all seventeen cases above.
