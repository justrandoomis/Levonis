# Bundles, Random Filament, Mystery Pools and Special Offers — the contract

> Status: canonical design. Implementation order lives in `docs/BUNDLES_MYSTERY_PLAN.md`.
> Companion reading before touching any product table: `docs/TXT_IMPORT_PARITY.md` §5.1.
> Companion reading before touching any price: `docs/PRICING.md`. Membership: `docs/MEMBERSHIPS.md`.

---

## الخلاصة التنفيذية

١. الحزمة وعرض الفتيل العشوائي كلاهما **صف حقيقي في جدول `products`** يحمل عمودًا جديدًا اسمه `composition` بقيمة `'bundle'` أو `'mystery'`؛ بذلك يرث كل واحد منهما الاسم بالعربية والإنجليزية والكردية، والـ slug، والغلاف، والمعرض، والحالة، وترتيب العرض، والسعر، والسعر المقارن، وسلّم أسعار العضوية، وسطر السلة، وسطر الطلب، والفاتورة، والبحث، وسجل الأسعار — دون كتابة أي منها من جديد.
٢. **لا يوجد مخزون خاص بالحزمة إطلاقًا.** `products.stock = NULL` دائمًا على صف التركيب، والتوفر يُحسب لحظيًا من المخزون الحقيقي: `min(floor(المتاح ÷ الكمية لكل حزمة))` عبر `resolveStock` الموجود.
٣. الحجز يتم **داخل دفعة الطلب نفسها** (`db.batch` واحدة) عبر `planInventory` نفسه، مع جدول سياج جديد `order_reservation_fence` يجعل الحجز الجزئي مستحيلًا — وهو إصلاح يفيد كل الطلبات لا الحزم فقط.
٤. **السعر لا يأتي من المتصفح أبدًا.** الخادم يحسب مجموع قيمة المكوّنات وسعر الحزمة وسعر العضوية والخصم ونسبة التوفير والعرض المطبَّق، ويجمّدها في لقطة غير قابلة للتغيير داخل الطلب.
٥. السلة تعرض الحزمة **سطرًا رئيسيًا واحدًا** قابلًا للتوسيع، بينما تُحفظ كل مكوّناتها داخليًا في `cart_bundle_choices`.
٦. الطلب يُخزَّن كسطر أب مُسعَّر + أسطر مكوّنات بسعر صفر تحمل معرّفات المنتج والخيار واللون الحقيقية ومرجع الحجز وحصّة الاسترجاع.
٧. اختيار الفتيل العشوائي يتم **في الخادم فقط**، بوزن احتمالي، من مولّد عشوائي ببذرة يحتفظ بها الخادم (`worker/lib/farm/rng.ts`). البذرة تُشتق من سر العرض ومن **ملح سحب** يكتبه الخادم على سطر السلة عند الإضافة — **لا يدخل أي مُدخل من المتصفح في البذرة إطلاقًا** (ولا مفتاح التكرار الذي يختاره العميل). النتيجة تُحفظ نهائيًا مع لقطة المرشّحين التي أنتجتها، فالتحديث أو إعادة المحاولة أو إعادة تشغيل الـ webhook لا تُغيّرها أبدًا، ويمكن إعادة التحقق من عدالة أي سحب قديم.
٨. الكشف يتم عند مرحلة يحددها المدير، وقبلها لا يُسرَّب المنتج المختار في أي حمولة API أو صورة أو إشعار — والسطر يُخزَّن بـ `product_id = NULL` حتى لا يكون التسريب ممكنًا بنيويًا.
٩. الأهلية والجدولة والحدود **والخصم المجدول** تعيش في نموذج ترويج **واحد** (`offer_windows` / `offer_limits` / `offer_redemptions`) يخدم الحزم والعروض العشوائية والعروض الخاصة على المنتجات العادية؛ ونافذة العرض تحمل سعرها بنفسها، فالعرض المحدود بوقت يغيّر السعر فعلًا لا العدّاد فقط.
١٠. الأهلية تُكتب **كمجموعة صريحة** من الطبقات المسموح لها (`required_tiers`) لا كحد أدنى خطي: PRO يرث PLUS، أما PRIME فطبقة مشترٍ مستقلة لا تُمنح وصول PLUS ضمنًا. و«premium» في التكليف هو **PRIME**؛ ولا تُخترع طبقة رابعة. العرض بلا طبقات مطلوبة **عام للجميع بمن فيهم الزائر غير المسجَّل**.
١١. جدولا `bundles` و`bundle_items` القديمان **يُستبدلان ويُرحَّلان ويُجمّدان** — الصفوف المرحّلة تصل كمسودات بلا سعر، ولا يُنشر شيء تلقائيًا.
١٢. كل رفض يحمل رمزًا آليًا ثابتًا، وكل تحذير إداري يُعرض حرفيًا بثلاث لغات ولا يُصلَح صامتًا.

---

## 0. What was decided, and where each idea came from

Two designs were written and judged: **product-native** (a bundle is a `products`
row) and **first-class entity** (a bundle is an `offers` row with its own cart and
order line kinds).

**The product-native design is the spine.** The mandate's own tie-breaker —
*"preserve the existing … cart, wallet, checkout, orders, shipping, inventory and
admin patterns where they are already correct, and extend rather than rewrite"* —
picks it: the cart line, the order line, the price resolver, the invoice, the
stage machine, the shipping quote, the points basis, price protection, favourites
and search all keep working with no shape change, because a bundle *is* a
product. The first-class design's own honest blast-radius table lists thirteen
files that must learn a second line kind, including a breaking change to the
`POST /api/orders` body.

**Seven ideas are grafted from the first-class design**, and are marked
`[from first-class]` where they appear:

| # | grafted idea | why it wins |
|---|---|---|
| 1 | a mystery component `order_items` row stores `product_id = NULL` | leak prevention **by construction** instead of by fourteen filters; the `ORDER_ITEMS_SELECT` join, `/units`, the invoice and the courier payload go quiet with no code |
| 2 | `mystery_allocations` freezes `name_snapshot` / `image_snapshot` / `variant_snapshot` | a later product rename cannot rewrite what the customer actually received |
| 3 | an offer-level `plus_price_iqd` | gives the mandate a real PLUS price without adding a fifth rung to the product ladder |
| 4 | `planInventory` returns `plannedLedgerRows`, and the fence uses it | precise `expected`, rather than inferring it from `ApplyResult.keys` |
| 5 | `duplicate_policy = 'forbid'` refuses with `MYSTERY_NOT_ENOUGH_VARIETY`; `'discourage'` halves the weight | never silently repairs a configuration; a defined, testable meaning |
| 6 | pool-level structured eligibility (`require_catalog_ids` / `require_facet_ids`) plus `min_available` | eligibility from structured taxonomy, never from a product name |
| 7 | the coarse-state-only list payload, the explicit `allocate:false` quote flag, the warning-code table, and the per-test-file test plan | sharper, more mechanically checkable |

**One defect in the product-native design is corrected here.** It claimed the
composition key could ride in `cart_items.option_id` and that
`resolveUnitPrice` would "fall back to base pricing". It does fall back for the
numbers, but `packages/pricing/src/pricing.ts:558` pushes `OPTION_NOT_FOUND` into
`ResolvedPrice.errors`, and `worker/routes/orders.ts:625` turns any resolver
error into a 400.

Blanking `optionId` alone does **not** fix it, and the first draft of §5.1 said
it did. `selectionFromCartRow` (`worker/routes/cart.ts:261-272`) returns
`optionValueIds: ids.length ? ids : legacy ? [legacy] : []`, so a composition row
— `option_value_ids = '[]'`, `option_id = 'bx_…'` — already carries
`optionValueIds: ['bx_…']` before anything is blanked, and `resolveCartLine`
rebuilds `optionId: valueIds[0]` from exactly that array
(`worker/routes/cart.ts:180-192`). The same array is handed to `saleAvailability`
(`worker/routes/cart.ts:333`, `worker/routes/orders.ts:647-654`), where it pushes
`OPTION_NOT_FOUND` into `selection.errors` and makes `refuseIncompleteSelection`
throw "Choose a colour before adding this item (OPTION_NOT_FOUND)". §5.1 below
therefore blanks the **whole selection** — `optionId` *and* `optionValueIds` —
for a composition row, decided from `products.composition`, which is threaded
into every cart and checkout `SELECT` for that purpose.

---

## 1. Data model

Nothing here creates a stock or reserved column outside the four real stock
tables (`products`, `product_option_values`, `product_colors`,
`product_variants`). That is the mandate's hardest schema rule and §15.2 pins it
with a test.

### 1.1 Migration order

The next free number is **0058** (`migrations/0057_core_outbox.sql` is the newest).

| file | contains |
|---|---|
| `migrations/0058_composition_core.sql` | `products.composition`; `cart_items.draw_salt`; `bundle_config`; `bundle_components`; `bundle_component_choices`; `cart_bundle_choices`; four `order_items` columns; `order_reservation_fence` |
| `migrations/0059_bundles_migrate_legacy.sql` | insert-only backfill of `bundles`/`bundle_items` into the new model |
| `migrations/0060_offer_eligibility.sql` | `offer_windows`, `offer_limits`, `offer_redemptions`, `trg_offer_redemption_limits` |
| `migrations/0061_mystery_pools.sql` | `mystery_pools`, `mystery_pool_entries`, `mystery_offers`, `mystery_offer_secrets`, `mystery_allocations`, `mystery_draw_audits` |
| `migrations/0062_composition_analytics.sql` | `composition_daily_metrics`, `mystery_allocation_stats` (view) |

Every file uses only `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`CREATE TRIGGER IF NOT EXISTS`, `CREATE VIEW IF NOT EXISTS`,
`ALTER TABLE … ADD COLUMN` and (0059 only) `INSERT OR IGNORE … SELECT`. That is
the established shape: `order_items` has grown by `ADD COLUMN` five times
already (0002:99-101, 0008:12-13, 0023:24, 0030:256-257). The gate is
`scripts/migrate-check.mjs --twice` via `tests/migrations.test.ts`: the second
full pass must apply zero files, the newest migration must contain re-runnable
statements, and `foreign_key_check` must report zero violations.
`scripts/check-migrations-additive.mjs` gates `studio/drizzle`, not `migrations/`.

### 1.2 `products` — one new column

```sql
-- 0058
ALTER TABLE products ADD COLUMN composition TEXT NOT NULL DEFAULT '';
--   ''        an ordinary catalogue product — every existing row
--   'bundle'  a fixed composition, listed in bundle_components
--   'mystery' a server-drawn composition, from a mystery pool
CREATE INDEX IF NOT EXISTS idx_products_composition
  ON products(composition, status, display_order);
```

**`selling_type` and `sale_types[0]` cannot disagree, by construction.**
`serializeDoc` writes `selling_type: doc.sale_types[0] ?? doc.selling_type`
(`worker/lib/productModel.ts:1141`), so pinning `'bundle'` to position 0 of
`sale_types` *is* what pins `selling_type = 'bundle'`; the two rows of the table
below are one rule, not two that could drift. The mode a buyer actually gets
comes from `compositionModes` (§2.4), never from either scalar. One consequence
must be written down rather than discovered: `isMixed(["bundle","pre_order"])` is
true, so the TXT exporter (`worker/lib/template.ts:924`) would write
`selling_type: mixed` — it emits `bundle` for a composition row instead, and the
importer refuses composition rows outright (`COMPOSITION_NOT_ALLOWED`), so the
value is never read back.

No SQLite `CHECK`. `sale_types` (0018:153) is the precedent — a
constrained-by-code column — so a future third value is an `ALTER`-free change.
The enum is normalised in `worker/lib/productModel.ts` and refused at every write
door (§16).

A composition row is **pinned** to these values, enforced inside
`planProductSave` (`worker/lib/productPersistence.ts:1678`):

| column | value | why |
|---|---|---|
| `selling_type` | `'bundle'` | already legal since `migrations/0001_init.sql:84`; `saleAvailability` already reads it as direct-enabled (`worker/routes/products.ts:271`) |
| `sale_types` | `["bundle"]`, or `["bundle","pre_order"]` for a pre-order bundle — **`'bundle'` is always `sale_types[0]`** | `deriveSaleTypes` (`packages/pricing/src/availability.ts:78`) already carries `'bundle'` through untouched |
| `stock` | `NULL` | **never stocked.** Availability is computed, never stored. The single most important invariant in this design |
| `stock_reserved` | `0`, never written | nothing reserves against the bundle row itself |
| `inventory_mode` | `'BASE'` | so `snapshotFrom` returns an untracked base and `resolveStock` answers `available: null` for the bundle row itself |
| `options`, `colors` | `[]`; no `product_option_groups`, `product_colors`, `product_variants` rows | a bundle has no variants of its own; its variability lives in `bundle_component_choices` |
| `price_iqd`, `prime_price_iqd`, `pro_price_iqd`, `original_price_iqd`, `product_cost_iqd` | the bundle's own ladder | free `clampMemberLadder`, free price history, free price protection |

Everything else — `slug` (UNIQUE), `name` / `name_ar` / `name_ku`,
`description` / `description_ar` / `description_ku`, `images`,
`description_images`, `display_order`, `is_featured`, `status`, `categories`,
`hashtags`, `ops_policy`, `preorder_transports`, `direct_surcharge_iqd`,
`payment_options` — is used exactly as an ordinary product uses it. The mandate's
"own title ar/en/ckb, slug, description, cover, gallery, status, display order,
regular price, compare price" is satisfied by columns that already exist.
`name_ku` is the ckb column; the storefront reads it through the existing
`loc(ar, en, ckb)` convention.

### 1.3 `bundle_config` — the per-offer knobs a product row has no home for

```sql
-- 0058
CREATE TABLE IF NOT EXISTS bundle_config (
  product_id         TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,

  -- PRICE MODE. 'fixed' uses the product's own ladder. The two discount modes
  -- derive the price from the live component total at every read.
  price_mode         TEXT NOT NULL DEFAULT 'fixed',   -- 'fixed'|'discount_percent'|'discount_iqd'
  discount_percent   INTEGER,                          -- 1..90, price_mode='discount_percent'
  discount_iqd       INTEGER,                          -- >0,   price_mode='discount_iqd'
  -- The floor a DERIVED price may never fall below. A derived price that
  -- computes below it is not sold at all (§4.3) — a bundle is never free
  -- because a component went free or an admin typed one zero too many.
  min_price_iqd      INTEGER NOT NULL DEFAULT 1 CHECK (min_price_iqd >= 1),
  -- [from first-class] the PLUS rung the product ladder does not have (§4.4).
  plus_price_iqd     INTEGER,

  -- PURCHASE SHAPE
  max_qty_per_order  INTEGER NOT NULL DEFAULT 5 CHECK (max_qty_per_order BETWEEN 1 AND 99),

  -- MYSTERY ONLY ('' on a bundle)
  duplicate_policy   TEXT NOT NULL DEFAULT '',         -- ''|'allow'|'discourage'|'forbid'
  reveal_stage       TEXT NOT NULL DEFAULT '',         -- ''|'paid'|'confirmed'|'preparing'|'shipped'|'delivered'
  show_odds          INTEGER NOT NULL DEFAULT 0,       -- [from first-class]

  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 1.4 Composition

```sql
-- 0058
CREATE TABLE IF NOT EXISTS bundle_components (
  id                     TEXT PRIMARY KEY,             -- 'bc_<20 hex>' via newId('bc') — a SURROGATE key
  bundle_product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  member_product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty                    INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0 AND qty <= 99),
  optional               INTEGER NOT NULL DEFAULT 0,   -- 0|1
  -- FIXED selection, pinned by the admin. Empty = not pinned at this level.
  option_value_ids       TEXT NOT NULL DEFAULT '[]',   -- JSON string[], stored SORTED
  color_id               TEXT NOT NULL DEFAULT '',
  -- CUSTOMER-SELECTABLE selection.
  customer_picks_option  INTEGER NOT NULL DEFAULT 0,
  customer_picks_color   INTEGER NOT NULL DEFAULT 0,
  sort                   INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_bundle_components_bundle
  ON bundle_components(bundle_product_id, sort, id);
CREATE INDEX IF NOT EXISTS idx_bundle_components_member
  ON bundle_components(member_product_id);

-- The allow-list a customer-selectable component may be chosen from.
-- No rows for a dimension = "any active value of that dimension".
CREATE TABLE IF NOT EXISTS bundle_component_choices (
  component_id TEXT NOT NULL REFERENCES bundle_components(id) ON DELETE CASCADE,
  dim          TEXT NOT NULL,                           -- 'option_value' | 'color'
  ref_id       TEXT NOT NULL,                           -- product_option_values.id | product_colors.id
  sort         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (component_id, dim, ref_id)
);
```

**The surrogate `bundle_components.id` is the reason the legacy pair is
superseded rather than extended.** `bundle_items PRIMARY KEY (bundle_id,
product_id)` (`migrations/0034_bundles_direct_surcharge.sql:40`) forbids the same
product twice in one bundle, which kills "two spools of PLA, one black one
white" and "three nozzles, two of 0.4 and one of 0.6" — both explicitly required.

`member_product_id … ON DELETE RESTRICT` on purpose: deleting a member product
must be *refused with the bundle named*, not silently cascade a bundle into
incoherence. The existing product-delete path
(`worker/routes/adminProducts.ts`, the archive-instead-of-delete branch) gains
that check, and `idx_bundle_components_member` makes it one indexed read.

### 1.5 The cart child table

```sql
-- 0058
CREATE TABLE IF NOT EXISTS cart_bundle_choices (
  cart_item_id     TEXT NOT NULL REFERENCES cart_items(id) ON DELETE CASCADE,
  component_id     TEXT NOT NULL REFERENCES bundle_components(id) ON DELETE CASCADE,
  option_value_ids TEXT NOT NULL DEFAULT '[]',          -- JSON string[], SORTED server-side
  color_id         TEXT NOT NULL DEFAULT '',
  included         INTEGER NOT NULL DEFAULT 1,          -- an optional component the buyer declined = 0
  PRIMARY KEY (cart_item_id, component_id)
);
```

One additive column joins it, and **no index is rebuilt**:

```sql
-- 0058
ALTER TABLE cart_items ADD COLUMN draw_salt TEXT NOT NULL DEFAULT '';
--  64 hex from randomSeedHex(), written by the SERVER when a mystery line is
--  created, rewritten never. It is the only variable input to the draw seed
--  (§7.3), and it exists so that no value the client chooses — least of all the
--  checkout idempotency key — can be ground for a favourable roll.
```

`cart_items` is otherwise **not** rebuilt and its indexes are **not** touched —
see §5.1 for why that matters (`migrations/0032_cart_line_identity.sql` exists
because a nullable column silently disarmed a unique index once already).
`ALTER TABLE … ADD COLUMN` does not touch `idx_cart_levonis_line`; a new column
inside the `UNIQUE (…)` tuple would have rebuilt it, which is exactly why
`composition_key` is **not** that column (§5.1, §17 decision 9).

### 1.6 `order_items` — four additive columns

```sql
-- 0058
ALTER TABLE order_items ADD COLUMN bundle_parent_item_id TEXT;    -- NULL on a parent and on ordinary lines
ALTER TABLE order_items ADD COLUMN bundle_component_id  TEXT;     -- bundle_components.id, provenance
ALTER TABLE order_items ADD COLUMN component_value_iqd  INTEGER;  -- undiscounted standalone value
ALTER TABLE order_items ADD COLUMN component_alloc_iqd  INTEGER;  -- this component's share of the bundle price
CREATE INDEX IF NOT EXISTS idx_order_items_bundle_parent
  ON order_items(bundle_parent_item_id);
```

`orders` gains **nothing**. The bundle-level snapshot lives inside the parent
row's existing `pricing_snapshot` column (§6.2).

### 1.7 The reservation fence

```sql
-- 0058
CREATE TABLE IF NOT EXISTS order_reservation_fence (
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,        -- 'reserve' | 'deduct' | 'release' | 'restore'
  expected   INTEGER NOT NULL,
  actual     INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (order_id, kind),
  CHECK (actual = expected)
);
```

Ten lines that make a partial inventory movement impossible — for every order,
not only bundles, and on **every** kind, not only `reserve`. The key is
`(order_id, kind)` because confirmation, cancellation and return move the same
order's stock again later, each in its own batch, and each needs its own fence
row. A guarded release that matches zero rows is exactly as expensive as a
guarded reserve that does: the customer is refunded and the units stay held for
ever. §3.3.

### 1.8 One promotion model: windows, limits, redemptions

```sql
-- 0060
CREATE TABLE IF NOT EXISTS offer_windows (
  subject_type  TEXT NOT NULL,            -- 'product' (a bundle, a mystery offer and an ordinary product are all products)
  subject_id    TEXT NOT NULL,
  id            TEXT NOT NULL UNIQUE,     -- 'ofw_<20 hex>' — the offer identity frozen into the order snapshot
  starts_at     TEXT,                     -- ISO-8601 with an explicit Z; NULL = no start bound
  ends_at       TEXT,                     -- ISO-8601 with an explicit Z; NULL = no end bound
  -- THE ALLOWED SET, not a ladder minimum. JSON array of tier names, sorted.
  -- '[]' = public, including a signed-out visitor. '["plus"]' admits PLUS and
  -- PRO (PRO inherits PLUS) and NOT PRIME. '["plus","prime"]' admits all three
  -- paid tiers. See §9 for the inherits map and why a minimum is wrong here.
  required_tiers TEXT NOT NULL DEFAULT '[]',
  -- THE SCHEDULED PRICE. '' = the window changes no price and is a pure
  -- schedule/gate/limit. Otherwise this offer, and only this offer, sets the
  -- price for its window (§4.6). Never stacked with bundle_config.price_mode.
  offer_price_mode TEXT NOT NULL DEFAULT '',  -- ''|'fixed'|'discount_percent'|'discount_iqd'
  offer_price_iqd  INTEGER,                   -- offer_price_mode='fixed'
  discount_percent INTEGER,                   -- 1..90
  discount_iqd     INTEGER,                   -- > 0
  plus_price_iqd   INTEGER,                   -- the offer's PLUS rung (§4.4)
  locked_preview INTEGER NOT NULL DEFAULT 1,   -- may a non-eligible viewer see a polished lock?
  active        INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS offer_limits (
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  max_per_user INTEGER,                   -- NULL = unlimited
  max_global   INTEGER,                   -- NULL = unlimited
  PRIMARY KEY (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS offer_redemptions (
  id           TEXT PRIMARY KEY,          -- 'ofr_<20 hex>'
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- ONE row per (subject, order), with qty SUMMED over that subject's lines.
  -- An order may legitimately hold two lines of the same bundle (two different
  -- colour choices, §5.1); inserting one row per LINE would abort the batch on
  -- this constraint with a message containing neither 'idempotency_key' nor any
  -- code the catch block maps, i.e. a permanent generic failure on a cart that
  -- could never succeed. Summing is also exactly what the trigger's SUM(qty)
  -- limit semantics want. §3.1 step 3.
  UNIQUE (subject_type, subject_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_offer_redemptions_user
  ON offer_redemptions(subject_type, subject_id, user_id);
CREATE INDEX IF NOT EXISTS idx_offer_redemptions_subject
  ON offer_redemptions(subject_type, subject_id);
```

and the limit trigger, copied in shape from
`migrations/0049_security_hardening.sql:29-40` — the only concurrency-safe limit
mechanism in the tree:

```sql
CREATE TRIGGER IF NOT EXISTS trg_offer_redemption_limits
BEFORE INSERT ON offer_redemptions
BEGIN
  SELECT RAISE(ABORT, 'OFFER_PER_USER_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_per_user IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id
               AND r.user_id = NEW.user_id), 0) > l.max_per_user);
  SELECT RAISE(ABORT, 'OFFER_GLOBAL_LIMIT') WHERE EXISTS (
    SELECT 1 FROM offer_limits l
     WHERE l.subject_type = NEW.subject_type AND l.subject_id = NEW.subject_id
       AND l.max_global IS NOT NULL
       AND NEW.qty + COALESCE((SELECT SUM(r.qty) FROM offer_redemptions r
             WHERE r.subject_type = NEW.subject_type AND r.subject_id = NEW.subject_id), 0) > l.max_global);
END;
```

The read-time count in the route is **advice** for a friendly message; this
trigger is **the decision**, and a refusal aborts the whole checkout batch —
exactly the contract stated at `worker/routes/orders.ts:1374-1386` for coupons.
`worker/routes/orders.ts:1589-1596` already maps `RAISE(ABORT)` substrings to API
codes; two branches are added there (§15.3).

### 1.9 Mystery pools, offers and allocations

```sql
-- 0061  (pools first: mystery_offers references them)
CREATE TABLE IF NOT EXISTS mystery_pools (
  id                  TEXT PRIMARY KEY,                  -- 'mpl_<20 hex>'
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'direct',    -- 'direct' | 'preorder'  — separate pools, never mixed
  active              INTEGER NOT NULL DEFAULT 1,
  -- [from first-class] structured eligibility. NEVER a product-name match.
  require_catalog_ids TEXT NOT NULL DEFAULT '[]',        -- JSON array of catalog ids
  require_facet_ids   TEXT NOT NULL DEFAULT '[]',        -- JSON array of facet value ids (material, brand)
  min_available       INTEGER NOT NULL DEFAULT 1,        -- free stock an entry needs to be a candidate
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mystery_pool_entries (
  id               TEXT PRIMARY KEY,                     -- 'mpe_<20 hex>'
  pool_id          TEXT NOT NULL REFERENCES mystery_pools(id) ON DELETE CASCADE,
  -- RESTRICT, symmetrical with bundle_components.member_product_id: deleting a
  -- product that a pool draws from must be REFUSED with the pool named, never
  -- silently empty a live pool. adminProducts.ts's delete check names pools
  -- beside bundles (§16).
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  option_value_ids TEXT NOT NULL DEFAULT '[]',           -- JSON, SORTED; [] = the product needs no option
  color_id         TEXT NOT NULL DEFAULT '',
  family_id        TEXT NOT NULL DEFAULT '',             -- a catalog/facet id the buyer may narrow to — NEVER a name
  weight           INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 0),   -- 0 = excluded, kept for history
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mystery_entries_pool
  ON mystery_pool_entries(pool_id, active, weight);
CREATE INDEX IF NOT EXISTS idx_mystery_entries_product
  ON mystery_pool_entries(product_id);

CREATE TABLE IF NOT EXISTS mystery_offers (
  product_id            TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  direct_pool_id        TEXT REFERENCES mystery_pools(id) ON DELETE RESTRICT,
  preorder_pool_id      TEXT REFERENCES mystery_pools(id) ON DELETE RESTRICT,
  spool_qty             INTEGER NOT NULL DEFAULT 1 CHECK (spool_qty BETWEEN 1 AND 20),
  allow_direct          INTEGER NOT NULL DEFAULT 1,
  allow_preorder        INTEGER NOT NULL DEFAULT 0,
  customer_picks_family INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- THE SECRET LIVES IN ITS OWN TABLE, and no read route joins it.
-- Keeping it on mystery_offers made its safety depend on every future reader
-- remembering to enumerate columns instead of `SELECT *` — and the admin bundle
-- read, the duplicate response and any export are all readers. One leaked admin
-- payload (a screenshot, a HAR file, a support ticket) would let anyone
-- precompute every future draw, because the seed is a pure function of it.
CREATE TABLE IF NOT EXISTS mystery_offer_secrets (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  secret     TEXT NOT NULL,                             -- 64 hex from randomSeedHex()
  rotated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mystery_allocations (
  order_item_id    TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  spool_index      INTEGER NOT NULL CHECK (spool_index >= 0),
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  offer_product_id TEXT NOT NULL REFERENCES products(id),
  pool_id          TEXT NOT NULL REFERENCES mystery_pools(id),
  pool_entry_id    TEXT NOT NULL REFERENCES mystery_pool_entries(id),
  -- THE FROZEN PICK. Never mutated. Never in a customer payload before reveal.
  product_id       TEXT NOT NULL REFERENCES products(id),
  option_value_ids TEXT NOT NULL DEFAULT '[]',
  color_id         TEXT NOT NULL DEFAULT '',
  -- [from first-class] frozen display, so a later rename cannot rewrite history.
  name_snapshot    TEXT NOT NULL,
  image_snapshot   TEXT NOT NULL DEFAULT '',
  variant_snapshot TEXT NOT NULL DEFAULT '',
  sale_mode        TEXT NOT NULL,                        -- 'direct' | 'preorder'
  seed             TEXT NOT NULL,                        -- 64 hex, server-held, never returned
  -- THE MILESTONE THIS ORDER WAS SOLD UNDER, frozen. bundle_config.reveal_stage
  -- is one mutable row shared by every past and in-flight order; editing it
  -- must not retroactively hide a pick a customer has already seen, nor reveal
  -- every in-flight order at once (§8.1).
  reveal_stage_snapshot TEXT NOT NULL,
  -- sha256 over the canonical candidate list this draw ran against, so
  -- (seed, candidates, weightedIndex) reproduces the winner years later. The
  -- list itself is in mystery_draw_audits, once per line rather than per spool.
  candidates_sha256 TEXT NOT NULL,
  revealed_at      TEXT,                                 -- NULL until the milestone is crossed
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (order_item_id, spool_index)                -- ★ THE REPLAY FENCE
);

-- Why this one: the outcome is a function of (seed, candidate list, weights),
-- and both the list and the weights change continuously with stock and admin
-- edits. Without the inputs, nobody — including the owner — can ever verify
-- that a past draw of an expensive filament was fair, which is the only thing
-- an audit trail for a randomised money mechanism exists to provide.
CREATE TABLE IF NOT EXISTS mystery_draw_audits (
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  offer_product_id TEXT NOT NULL,
  cart_item_id     TEXT NOT NULL,
  pool_id          TEXT NOT NULL,
  -- [{entry_id, product_id, weight, available}], sorted by entry_id — the
  -- canonical form whose sha256 is on every allocation this line produced.
  candidates       TEXT NOT NULL,
  candidates_sha256 TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (order_id, offer_product_id, cart_item_id)
);
CREATE INDEX IF NOT EXISTS idx_mystery_alloc_order   ON mystery_allocations(order_id);
CREATE INDEX IF NOT EXISTS idx_mystery_alloc_product ON mystery_allocations(product_id, color_id);
CREATE INDEX IF NOT EXISTS idx_mystery_alloc_entry   ON mystery_allocations(pool_entry_id, created_at);
```

### 1.10 Analytics storage

```sql
-- 0062
CREATE TABLE IF NOT EXISTS composition_daily_metrics (
  day        TEXT NOT NULL,                -- 'YYYY-MM-DD' UTC
  subject_id TEXT NOT NULL,                -- the composition product id
  views      INTEGER NOT NULL DEFAULT 0,
  adds       INTEGER NOT NULL DEFAULT 0,
  oos_blocks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject_id)
);

CREATE VIEW IF NOT EXISTS mystery_allocation_stats AS
  SELECT substr(a.created_at, 1, 10) AS day,
         a.pool_id, a.pool_entry_id, a.product_id, a.color_id, a.sale_mode,
         COUNT(*) AS n
    FROM mystery_allocations a
   GROUP BY 1, 2, 3, 4, 5, 6;
```

No `user_id`, no `order_id`, no address. §12.

### 1.11 What happens to `bundles` / `bundle_items`

**Superseded, migrated, frozen — never dropped.**
`migrations/0059_bundles_migrate_legacy.sql` is insert-only:

```sql
INSERT OR IGNORE INTO products
  (id, slug, status, name, name_ar, name_ku, description, images,
   selling_type, sale_types, composition, price_iqd, stock, display_order,
   inventory_mode, created_at, updated_at)
SELECT 'prd_bnd_' || b.id,
       'bundle-' || lower(hex(randomblob(6))),
       'draft',                                        -- ★ never auto-published
       b.name, '', '', b.description,
       CASE WHEN b.image = '' THEN '[]' ELSE json_array(b.image) END,
       'bundle', '["bundle"]', 'bundle',
       0,                                              -- no honest price exists to migrate
       NULL,                                           -- ★ never stocked
       b.sort, 'BASE',
       strftime('%Y-%m-%dT%H:%M:%fZ', b.created_at / 1000, 'unixepoch'),
       strftime('%Y-%m-%dT%H:%M:%fZ', b.updated_at / 1000, 'unixepoch')
  FROM bundles b;

INSERT OR IGNORE INTO bundle_config (product_id, price_mode, max_qty_per_order)
SELECT 'prd_bnd_' || b.id, 'fixed', 5 FROM bundles b;

-- preserves today's members-only gate exactly (worker/routes/bundles.ts:74-78),
-- which is exclusiveSections = PLUS or PRIME or PRO — all three, as a SET.
INSERT OR IGNORE INTO offer_windows (subject_type, subject_id, id, required_tiers, active)
SELECT 'product', 'prd_bnd_' || b.id, 'ofw_bnd_' || b.id,
       '["plus","prime","pro"]', b.active FROM bundles b;

INSERT OR IGNORE INTO bundle_components
  (id, bundle_product_id, member_product_id, qty, sort)
SELECT 'bc_' || lower(hex(randomblob(10))), 'prd_bnd_' || i.bundle_id,
       i.product_id, i.qty, i.sort
  FROM bundle_items i;
```

`bundles.created_at` / `updated_at` are epoch **milliseconds**
(`worker/routes/bundles.ts` writes `Date.now()`); `products` uses ISO text. The
migration converts. `INSERT OR IGNORE` plus the deterministic `prd_bnd_` /
component ids keyed off existing rows makes a second pass a no-op — which is what
`tests/migrations.test.ts` demands of the newest migration.

Every migrated bundle lands as **`status='draft'` with `price_iqd = 0`**. 0034
deliberately gave bundles no price, so there is no honest price to migrate, and
silently publishing an unpriced sellable product is exactly the "never silently
repair" failure the mandate forbids. The admin panel shows a loud banner on every
such row (§11.3, warning code `MIGRATED_NEEDS_PRICE`).

`worker/routes/bundles.ts` keeps exporting `bundlesRoutes` and
`adminBundlesRoutes` so `worker/index.ts:51,123-124` needs no edit, but both are
re-implemented over the new model (§10). `bundles` / `bundle_items` become
read-only history; nothing writes them after 0059.

---

## 2. Availability — the scarcest component

### 2.1 Where it lives

New pure module **`worker/lib/bundleComposition.ts`**. No SQL, no state, no stock
arithmetic of its own — it composes `resolveStock`
(`worker/lib/inventory.ts:139`).

```ts
export interface ResolvedComponent {
  component_id: string;
  member_product_id: string;
  qty_per_bundle: number;
  optional: boolean;
  included: boolean;
  selection: { option_value_ids: string[]; color_id: string | null };
  resolution: StockResolution;        // worker/lib/inventory.ts:73
  unit: ResolvedPrice;                // packages/pricing/src/pricing.ts:281
  shipping_type: ShippingType;        // packages/pricing/src/shippingType.ts:23
}

export type CompositionState =
  | 'in_stock' | 'low' | 'sold_out'
  | 'upcoming'          // the window has not opened — a countdown to open
  | 'ending_soon'       // live, ends_at within ENDING_SOON_MS — a countdown to close
  | 'ended'
  | 'preorder'          // every required component is pre-order; no stock gate
  | 'locked'            // membership-exclusive, and this viewer is not entitled
  | 'member_exclusive'  // membership-exclusive, and this viewer IS entitled
  | 'unconfigured';

export interface CompositionAvailability {
  state: CompositionState;            // ONE server verdict, used by card, detail, cart and door
  max_bundles: number | null;         // null = every required component untracked
  blocking: Array<{ component_id: string; product_id: string; available: number; needed: number; reason: string }>;
  shipping_type: ShippingType | 'mixed';
  errors: string[];                   // machine codes
}

export function bundleAvailability(
  components: ResolvedComponent[],
  window: { starts_at: string | null; ends_at: string | null; nowMs: number },
  active: boolean,
  offer: OfferCheck                   // worker/lib/offers.ts §9 — the tier verdict
): CompositionAvailability;
```

The eight states §13.3 requires are **all** produced here, by this one function,
so the card, the detail page, the cart and the door can never disagree and the
browser classifies nothing. The tier states come from the `offer` argument, not
from a second client-side comparison. Precedence, evaluated top down:
`unconfigured` → `ended` → `upcoming` → `locked` → `sold_out` → `preorder` →
`ending_soon` → `low` → `in_stock` → `member_exclusive` decorates any live state
for an entitled viewer of a gated offer.

**`ended` has two causes and the listing distinguishes them.** A window that has
merely EXPIRED is a fact about a real offer and keeps its card and its countdown
— §13.3 lists `ended` as one of the eight card states for exactly that. An offer
the owner switched OFF (`offer_windows.active = 0`) is not a card at all: the
listing filters it on the window's own `active` flag, which is the one thing the
owner toggled. Filtering on the STATE would have caught the derived-price-below-
floor case too, and §4.3 wants that one to stay on the grid showing its
unavailable state.

`low` has an explicit rule, because a composition row has no
`low_stock_threshold` of its own and inventing one in the panel is exactly the
silent repair the mandate forbids: **`low` is true when the blocking component's
own `isLowStock(resolution)` (`worker/lib/inventory.ts:216`) is true, or when
`max_bundles <= COMPOSITION_LOW_BUNDLES` (a documented constant, 3).** The
worked example below is extended with a `low` case in
`tests/bundleAvailability.test.ts`.

### 2.2 The rule, and nothing more

```
demand = {}                                  # (scope, scope_id) -> units per ONE bundle
for each REQUIRED, INCLUDED component:
    if component.resolution.error -> max_bundles = 0, push blocking[] with the machine code
    for each target in component.resolution.targets:
        demand[target.key] += qty_per_bundle          # ★ SUMMED, never per component

for each (key, needed) in demand:
    a = available(key)
    if a === null                   -> untracked: contributes nothing (unbounded)
    else                            -> candidate = floor(a / needed)
max_bundles = min(candidates)   or   null when there were no candidates
```

**Demand is aggregated by stock target, never evaluated per component.** The
surrogate `bundle_components.id` exists precisely so one product may appear twice
in a bundle, and two components can also resolve to one row through different
routes. Dividing independently would advertise stock that cannot be bought: with
`available = 3` and two components needing 2 each, both report `floor(3/2) = 1`,
so `max_bundles = 1` while buying one bundle needs 4 units. That is not an
oversell — the guards and the fence hold — but the customer gets a permanent,
deterministic `CONFLICT_RETRY` on a cart nothing is racing, and no screen can
tell them why. §3.2 carries the same aggregation across *lines*.

The owner's worked example: printer `available 5`, `qty_per 1` → 5; filament
`available 6`, `qty_per 2` → 3; nozzle `available 20`, `qty_per 1` → 20;
`min(5, 3, 20) = 3`. ✔

Optional components the buyer **declined** (`included = 0`) never lower
`max_bundles` and never appear in the order snapshot.

An optional component the buyer **opted into** and that cannot be satisfied is
**refused**, with `BUNDLE_OPTIONAL_UNAVAILABLE` naming the component — it is not
dropped. Dropping it would change what the customer bought after they pressed
*Place order*, at the full fixed price, with the change visible only in the
snapshot afterwards: the silent repair the mandate forbids, on the money path.
The cart disclosure lets them un-tick that component and retry, the same shape as
the `CART_SHIPPING_CONFLICT` dialog at `src/pages/Product.tsx:814`. If a drop is
ever permitted by a later flag, it must reduce the charged price by that
component's allocated share **and** be shown in the quote before payment.

**Pre-order components are exempt from the stock test**, exactly as an ordinary
pre-order line is. `effectiveAvailability(component, memberProduct.sale_types)`
(`packages/pricing/src/availability.ts:53`) decides; a component whose effective
availability is `pre_order` and whose stock is untracked contributes nothing to
`max_bundles`. That is how a pre-order bundle sells without physical stock, with
no new concept and no invented inventory. A tracked pre-order component still
reserves normally.

**A pre-order bundle carries fees, and they are not free.** Two facts make this
explicit rather than implied:

* **The transport method lives on the parent cart row.** `cartShippingType(rows)`
  reads `rows[0].transport_method` (`worker/routes/orders.ts:544-548`), the
  mixed-cart guard reads the same field (`worker/routes/cart.ts:609-618`) and
  `orderShippingType` derives from the lines' `transport_snapshot.method`. A
  bundle whose parent row carried `transport_method: ''` would be classified
  `direct` — the five-stage path, the wrong `allowedPaymentMethods`, and a
  mixed-cart guard that lets it sit beside direct products. So the buyer's chosen
  method is validated to be one **every** pre-order component offers, and is
  stored on the bundle's own `cart_items.transport_method` (§5.2). Nothing
  downstream changes.
* **The components' commissions are charged on the parent.** `resolveUnitPrice`
  computes a per-line pre-order transport commission and `direct_surcharge_iqd`
  (`packages/pricing/src/pricing.ts:665-698, 719-724`). Zero-pricing the
  component lines (§5.3) would drop that real money, and the store would eat the
  air-versus-sea difference on every choice. The components' effective
  commissions and surcharges are therefore summed into the **parent's**
  `unit_subtotal_iqd` and recorded in the parent's `transport_snapshot`, while
  `merchandise` stays exactly `bundle_price_iqd` so the points basis, the coupon
  minimum and the accrual are unaffected. The admin sets one merchandise price;
  the transport fee still follows the transport.

For a **mystery** offer, `max_bundles` is instead the number of one-spool offers
the eligible pool can back: `floor(Σ over eligible entries of available /
spool_qty)`, computed by the candidate query of §7.2 and fed through the same
function. `available === null` on a direct pool entry excludes it (untracked
stock cannot back a direct sale).

### 2.3 Where it is computed — and where it is not cached

| surface | how |
|---|---|
| `/api/bundles` listing | live, batched: 4 D1 round trips for the whole page (§14) |
| `/api/bundles/:slug` detail | the same pass for one bundle |
| `POST /api/cart/items` | the same pass, and it is authoritative |
| `GET /api/cart` (`loadCart`) | folded into the existing `loadRelationsViews` call in `worker/routes/cart.ts` |
| `computeCheckout` → `priceLines` | the same pass, and **this one alone decides money and stock** |
| `GET /api/admin/bundles/:productId/preview` | the same functions, so admin and shop can never disagree |

**No server cache in v1.** A cached availability number that disagrees with
`resolveStock` is exactly the shadow inventory the mandate forbids, and it would
need invalidation on every `inventory_ledger` write — the highest-volume write in
the system. If measurement ever demands one, the escape hatch is written down
here so nobody invents it silently: an explicitly **advisory** table refreshed by
a new `await step(...)` in `worker/lib/jobs.ts`, used only to sort and badge a
grid, never to permit a purchase.

### 2.4 The change to `saleAvailability` — and why it must fail CLOSED

`worker/routes/products.ts:168` gains a composition input:

```ts
saleAvailability(doc, {
  ...existing,
  // doc.composition is already on the doc; these two say what the caller knows.
  compositionMax?: number | null,          // bundleAvailability().max_bundles
  compositionModes?: SaleModeName[],       // ['direct_sale'] | ['pre_order'] | []
})
```

**Optional is the wrong default for a money gate.** `available = null` means
"untracked → sell 99" (`maxQty = QTY_CEILING`), and there are **six** call sites
— `worker/routes/cart.ts:333, 527, 788`, `worker/routes/orders.ts:647`,
`worker/routes/products.ts:825, 942`. Any one of them that forgot to thread
`compositionMax` would advertise 99 units of a bundle whose real availability may
be 0. So:

```ts
const isComposition = (doc.composition ?? '') !== '';

if (isComposition && input.compositionMax === undefined) {
  // FAIL CLOSED. Never an untracked 99 for a row whose stock is NULL by design.
  mode = 'unavailable'; reason = 'COMPOSITION_MAX_REQUIRED';
  available = 0; tracked = true; scope = 'composition'; maxQty = 0;
} else if (isComposition) {
  available = input.compositionMax;      // the bundle row's own stock is NULL and irrelevant
  tracked   = input.compositionMax !== null;
  scope     = 'composition';             // a new value in the scope union
}
```

Two further corrections, both load-bearing:

* **`directEnabled` must not come from the `'bundle'` token.** Today
  `directEnabled = saleTypes.includes('direct_sale') || saleTypes.includes('bundle')`
  (`worker/routes/products.ts:271`), so `sale_types = ["bundle","pre_order"]`
  always turns direct sale **on**. A pre-order bundle would then offer a
  direct-sale button, a direct price basis with no transport commission and a
  five-stage delivery promise on a bundle that has no stock. For a composition
  row, `directEnabled` and `preorderEnabled` come from `compositionModes` —
  computed by `bundleAvailability` from
  `effectiveAvailability(component, member.sale_types)` over the **required**
  components. A bundle whose required components are all pre-order reports
  `modes = [pre_order]` and no direct button.
* **`maxQty` must be clamped on the pre-order branch too.** Today
  `maxQty = mode === 'preorder' || available === null ? QTY_CEILING : min(QTY_CEILING, available)`
  (`worker/routes/products.ts:318-322`) discards `available` whenever the mode is
  `preorder` — and a pre-order bundle may still carry *tracked* direct components
  that reserve normally (§2.2). For a composition row the clamp is
  `min(QTY_CEILING, compositionMax ?? QTY_CEILING, bundle_config.max_qty_per_order)`
  on **both** branches.

With that, the product page, the cart, the add-to-cart gate and the checkout all
inherit the right answer, because all six call sites already call
`saleAvailability` — and a call site that forgets the input gets `max_qty = 0`,
not 99. `tests/bundleAvailability.test.ts` walks **every** call site with a
composition product and asserts none of them can return `max_qty > 0` without an
explicit `compositionMax`.

Without this, `stock = NULL` would read as "untracked → sell 99". That is the
single biggest hazard of putting a bundle in `products`, and it is contained
here plus the write-door pins of §1.2.

### 2.5 Mixed modes are refused, twice

`bundleAvailability` returns `shipping_type: 'mixed'` when required components
resolve to more than one `ShippingType`. The platform holds one shipping type per
cart (`worker/routes/cart.ts`, `CART_SHIPPING_CONFLICT`) and freezes one onto
`orders.shipping_type` (`migrations/0027_shipping_type.sql`), so a mixed bundle
has no honest delivery date.

* **Admin save refuses it** with `BUNDLE_SHIPPING_MIXED`, naming both components.
* **Add-to-cart refuses it** as a second door, in case a member product's sale
  type changed after the bundle was saved.

Never split into two orders, never force onto the slowest transport — both
silently change what the customer bought.

---

## 3. Reservation

### 3.1 One batch, no exceptions

`worker/routes/orders.ts` builds one `stmts: D1PreparedStatement[]` and runs a
single `await c.env.DB.batch(stmts)`. D1 runs a batch as one transaction. Every
statement below goes into that one array, in this order:

1. `INSERT INTO orders …` *(existing)*
2. `INSERT INTO coupon_redemptions …` *(existing, trigger-guarded)*
3. **`INSERT INTO offer_redemptions …`** — **one row per (subject, order)**, with `qty` summed across every line of that subject in this order, trigger-guarded *(new)*. Never one row per line: §5.1 deliberately produces two parent lines for one bundle when the colour choices differ, and a second INSERT would hit `UNIQUE (subject_type, subject_id, order_id)` and abort the batch with a message the catch block does not map
4. `INSERT INTO order_items …` × parent and ordinary lines *(existing shape)*
5. **`INSERT INTO order_items …` × component lines** — `bundle_parent_item_id` set, price 0 *(new)*
6. **`INSERT INTO mystery_allocations …` × spool** — PK-fenced *(new)*
7. points reservation + POINT withdrawal *(existing, self-guarded)*
8. USD wallet spend *(existing, self-guarded)*
9. accrual + settlement *(existing)*
10. `DELETE FROM cart_items …` *(existing; `cart_bundle_choices` follows by cascade)*
11. `planInventory(…, {kind:'reserve', operationId: orderId})` statements — component moves and ordinary-line moves in the **same call** *(existing call site, more moves)*
12. **the reservation fence** *(new, §3.3)*
13. `outboxStatement(OrderCreated)` *(existing)*

There is no second batch, no post-response write, no compensating transaction.

**And the batch has a written ceiling.** D1 caps both bound parameters per query
and total request size, and this feature is the first thing in the tree that can
multiply statements without bound: `max_qty_per_order` reaches 99 and `spool_qty`
reaches 20, so one mystery line could ask for ~2 000 `order_items`, ~2 000
allocations and ~4 000 inventory statements in one batch, and
`planInventory`'s `SELECT … WHERE idempotency_key IN (…)`
(`worker/lib/inventory.ts:421-425`) binds one placeholder per (move × target).
Three rules, all tested by a maximal legal order in
`tests/bundleCheckout.test.ts`:

* **`Σ over lines of (components or spools) × qty ≤ MAX_PHYSICAL_LINES` (250)**,
  refused with `COMPOSITION_TOO_LARGE` naming the limit. It is a checkout-door
  refusal, not a clamp. **What that bounds is ROWS, and the derived statement
  count is ~5× it**: each physical line costs its `order_items` INSERT plus its
  guarded ledger INSERT and guarded counter UPDATE, and a mystery spool adds a
  `mystery_allocations` INSERT on top — so the worst legal order reaches roughly
  1,200 statements in the one batch, measured at 1,209. The figure is written
  beside the constant so that anyone adding a per-line statement can see it is
  adding ~250 to that number, and `tests/bundleBatchLimits.test.ts` holds the
  derived bound.
* **`spool_qty × max_qty_per_order ≤ MAX_PHYSICAL_LINES` is refused at offer
  save**, so the customer never meets the door limit on a legal configuration.
* **Every `IN (…)` list this feature adds is chunked** to a documented safe size
  — the idempotency-key pre-read, the member-product read, the pool candidate
  read and `loadRelationsViews`' own batching.

### 3.2 The moves

`ComputedLine` already carries `stock_targets`. Component `ComputedLine`s are
built by `priceLines` exactly like ordinary lines (§5.3) and therefore already
carry `stock_targets` from their own `resolveStock`. The existing map in
`worker/routes/orders.ts` needs **zero changes**:

```ts
const stockMoves: StockMove[] = comp.lines
  .filter((it) => it.stock_targets.length > 0)
  .map((it) => ({ product_id: it.product_id, qty: it.qty, line_id: it.id, targets: it.stock_targets }));
```

Bundle **parent** lines have `stock_targets: []` (the bundle row is untracked)
and are filtered out. Bundle **component** lines have real targets and real line
ids. That fit is the clearest evidence the spine is right.

Three rules the composition builder must obey, enforced in
`worker/lib/bundleComposition.ts` and tested:

* **`line_id` must contain no `':'`.** `worker/lib/orderInventory.ts:53` recovers
  it as `idempotency_key.split(':')[2]`. Component ids come from `newId('oi')` →
  `oi_<20 hex>`. Safe by construction.
* **`line_id` must be unique per component.** Each component line gets its own
  `newId('oi')`, so two identical components in one bundle get two ids and two
  ledger rows. Correct: collapsing them would lose the per-`order_item` trail
  returns depend on.
* **Two different component lines that resolve to the same stock row stay two
  independent guarded moves**, because collapsing them would lose the
  per-`order_item` trail returns depend on. But their **demand is summed before
  it is judged**: `planInventory`'s pre-check builds a `(scope, scope_id) →
  Σ qty` map across every move in the call — bundle components, mystery spools
  and ordinary lines alike — and rejects when the total exceeds the row's live
  `available`, instead of evaluating each move against the full `available`
  independently (`worker/lib/inventory.ts:436-459`). `priceLines` builds the same
  map one step earlier and refuses with `OUT_OF_STOCK` naming the product. Without
  it, `rejected` is empty, the friendly `CONFLICT_RETRY` never fires, and the
  sequential guards fail at commit — a permanent, deterministic "a stock level
  changed, review your cart" on a cart nobody is racing.
* **That pre-check is one batched read, not a loop.** Today it is a sequential
  `await … .first()` per candidate move; with a dozen components on the hottest
  path in the system, latency scales linearly. It becomes one read keyed by
  `(table, id)` over the whole move set.

Idempotency key per move (`worker/lib/inventory.ts:272`), unchanged:

```
reserve:<orderId>:<componentOrderItemId>:<scope>:<scopeId|'-'>
```

`operationId = orderId`, so a retried checkout under the same
`orders.idempotency_key` replays the stored order before `planInventory` is ever
reached; and if it somehow were, every key is present and the plan is empty.

### 3.3 Why a partial reservation is impossible

`planInventory` writes a guarded `INSERT` and a guarded `UPDATE` per target
(`worker/lib/inventory.ts:474-505`). A guard that stops holding **between the
plan-time read and the commit** makes both statements match zero rows — *without
failing the batch*. The order then commits with a component unreserved.
`assertMovesApplied` (`worker/lib/inventory.ts:620`) was written for this and has
**zero callers**.

The same hole exists on `release`, `restore` and `deduct`, and a bundle
multiplies the exposure there from one or two guarded rows to a dozen. The cancel
route runs the release statements in the same batch as the status flip and the
wallet and points refunds (`worker/routes/orders.ts:1863-1872`), and
`orderCancelOps`' own fence proves only that the **status flip** landed. A
release whose guard stopped holding leaves the customer refunded and the units
held for ever, invisible to every screen. That is why the fence below is keyed
`(order_id, kind)` and pushed into `planOrderReturn`'s and `planOrderDeduction`'s
batches too, not only into checkout's.

The fence closes it inside the same transaction. `planInventory` gains one
returned field — `plannedLedgerRows` *(from first-class)* — and
`worker/lib/inventory.ts` gains one exported helper:

```ts
export function reservationFenceStatement(
  db: D1Database, orderId: string, kind: LedgerKind, expected: number
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO order_reservation_fence (order_id, kind, expected, actual)
     SELECT ?1, ?2, ?3, (SELECT COUNT(*) FROM inventory_ledger
                          WHERE order_id = ?1 AND kind = ?2)`
  ).bind(orderId, kind, expected);
}
```

One helper, four call sites: checkout (`reserve`), confirmation (`deduct`),
cancellation (`release` / `restore`) and the return approval (`restore`).

Earlier statements in a D1 batch are visible to later ones, so the `COUNT` sees
the ledger rows this batch just wrote. If any guarded insert matched zero rows,
`actual < expected`, the table's `CHECK (actual = expected)` fires, and **the
whole batch rolls back** — order, wallet spend, points, allocations, redemptions
and every other reservation with it. The customer sees the existing
`CONFLICT_RETRY` 400, because `worker/routes/orders.ts` already maps
`msg.includes('CHECK')` to it. **No catch-block change is needed for the fence.**

`planInventory`'s own plan-time rejection (`reservePlan.rejected.length > 0` →
`CONFLICT_RETRY`) stays as the friendly first line of defence.
`assertMovesApplied` stays as a post-commit assertion used by tests and the admin
stock screen; the fence is the production guarantee.

**All-or-nothing is therefore three-layered:** the pre-check rejection, the
in-statement guards, and the fence.

### 3.4 Confirmation, cancellation, return

**Almost unchanged.** `worker/lib/orderInventory.ts` replays the stored `reserve`
ledger rows and never recomputes targets from a product's current shape. Component
reservations are ordinary ledger rows carrying `order_id`, so:

* confirmation → `planOrderDeduction` / `deductOrderStock` deducts every component;
* cancellation → `planOrderReturn` / `returnOrderStock` releases or restores every
  component, inside the same batch as the status flip and the refunds.

**Two corrections, both in scope, both benefiting every order:**

1. **Each of those batches carries its own fence row** (§3.3), so a release or a
   deduction that matched zero rows rolls the refund back with it instead of
   committing a silent divergence.
2. **Release versus restore is decided per ledger row, not per order.**
   `hasLedgerKind` today picks one kind for the whole order
   (`worker/lib/orderInventory.ts:126-129`), so a partially deducted order
   restores rows that were never deducted — every one of which then fails its
   guard and matches zero rows. The rule becomes: a row with a matching `deduct`
   restores; a row without one releases.

**One prerequisite fix, in scope.** `worker/routes/returns.ts` restores stock with
a raw `UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL`.
That bypasses `inventory_ledger` entirely and always credits the BASE row: it is
already wrong for any OPTION / COLOR / VARIANT_COMBINATION product, and it would
be wrong once per component for a bundle. It is replaced with

```ts
await applyInventory(db, moves, {
  kind: 'restore', operationId: caseId, orderId, actorUserId: admin.id, reason: 'return',
});
```

with `moves` reconstructed from the order's stored `deduct` ledger rows the way
`worker/lib/orderInventory.ts` does. This is a prerequisite, not a cleanup, and
it lands before any bundle can be returned.

---

## 4. Pricing and snapshots

### 4.1 The bundle price is a product price

`resolveUnitPrice` (`packages/pricing/src/pricing.ts:521`) prices the bundle
product row with **no changes at all**: `price_iqd` / `prime_price_iqd` /
`pro_price_iqd`, `clampMemberLadder` (PRO ≤ PRIME ≤ Regular), the PRO policy,
`direct_surcharge_iqd`, the transport commission for a pre-order bundle, and
`pricing_basis` for a cash-on-delivery pre-order. `applied_tier` is the server's
verdict; `unit_subtotal_iqd` is what the line costs.

No second price resolver. No reimplementation of `clampMemberLadder`.
`src/components/CardPrice.tsx` renders a bundle card unchanged, because a bundle
*is* an `ApiProduct` carrying the `display_*` fields
`publicWithDisplayPrice` (`worker/routes/products.ts:558`) already emits.

### 4.2 The component total, the discount, the saving

Computed server-side, per component, with the *same* `resolveCartLine` /
`resolveUnitPrice` the cart uses for that product standing alone, at the *same*
tier:

```
component_total_iqd = Σ over included components of  unit.applied_iqd × qty_per_bundle
bundle_price_iqd    = the resolved bundle price (§4.3, §4.4)
discount_iqd        = max(0, component_total_iqd - bundle_price_iqd)
saving_percent      = component_total_iqd > 0 ? round(discount_iqd * 100 / component_total_iqd) : 0
```

`compare price` on the storefront is `products.original_price_iqd`, shown **only**
when strictly greater than the resolved price — the existing rule in
`docs/PRICING.md` and `src/components/CardPrice.tsx`. A compare-at that is not
real is not shown.

### 4.3 `price_mode`

* **`'fixed'`** *(default)* — the product's own ladder, as above.
* **`'discount_percent'`** — `bundle_price_iqd = floor(component_total × (100 − p) / 100)`,
  recomputed at every read and again at checkout, so a component reprice can
  never let a stale number be charged.
* **`'discount_iqd'`** — `bundle_price_iqd = max(min_price_iqd, component_total − d)`,
  same rules.

**The card must quote the number the door charges.** In the two derived modes the
charged price comes from the live component total while `products.price_iqd` is a
cached copy the admin save wrote. A card resolved from the cache would show one
price and the cart would charge another, with only a client-side "the price
moved" note as protection. The listing and the detail pass already resolve every
component — that is what produces `component_total_iqd` and `saving_percent`
(§14) — so the fresh figure is in hand at exactly the point the stale one would
be serialized. Therefore: **for a derived-mode bundle, `display_price_iqd`,
`display_regular_iqd` and the member rungs are overwritten with the freshly
derived figures before serializing the listing, the detail, the home shelf and
search.** `products.price_iqd` remains the sort and search key only, and
`DERIVED_PRICE_DRIFT` is the admin-side warning about *that key*, never a
customer-visible discrepancy and never a silent reconciliation.

**Never negative, and never free.** The `max(min_price_iqd, …)` above, plus the
`CHECK (… >= 0)` on `orders.subtotal_iqd`, `orders.total_iqd`,
`order_items.unit_price_iqd` and `order_items.line_total_iqd` since
`migrations/0001_init.sql`. But "not negative" is not enough on its own: a
`discount_iqd` of 200000 typed for 20000 would produce a bundle that costs
nothing, passes every gate, accrues no points and is never warned about — the
mandate's *prevent negative totals* satisfied at the letter and lost at the
intent. So there are two floors:

* **at save**, `discount_iqd >= component_total` is a hard refusal,
  `BUNDLE_DISCOUNT_EXCEEDS_TOTAL` (§4.7);
* **at read and at checkout**, a derived `bundle_price_iqd` below
  `bundle_config.min_price_iqd` (default 1) does not clamp and does not sell: the
  offer answers `OFFER_INACTIVE`, the card shows the unavailable state, and the
  admin gets the loud `DERIVED_PRICE_BELOW_FLOOR` warning. A component that went
  free, or a member product temporarily priced at 0, therefore stops the sale
  instead of dragging the bundle to zero with no admin action at all.

**AND BOTH FLOORS APPLY TO AN `offer_windows` PRICE, NOT ONLY TO
`bundle_config.price_mode`.** As first written they lived on the derived branch
alone, while §4.6 makes a live window the **sole** price source when it is set —
so `offer_price_mode='fixed'` with `offer_price_iqd = 0`, or a `discount_iqd`
with one zero too many, sold any product **or bundle** for 0 IQD merchandise,
passed every gate, accrued no points and produced no warning. `Math.max(0, …)`
is what made it silent: it turned an impossible price into a free one. So:

* **at save**, `offer_price_mode='fixed'` with `offer_price_iqd < 1` is refused
  with `OFFER_PRICE_BELOW_FLOOR`, and `discount_iqd >= the subject's current
  regular price` with `BUNDLE_DISCOUNT_EXCEEDS_TOTAL` — both in the ISSUES table
  of `worker/routes/offers.ts`, verbatim and trilingual;
* **at read and at checkout**, `resolveOfferPrice` returns `errors:
  ['DERIVED_PRICE_BELOW_FLOOR', 'OFFER_INACTIVE']` and contributes **no price**
  when the window's own price falls below the floor — `bundle_config.min_price_iqd`
  for a composition subject, 1 for an ordinary product. `applyOfferToResolved`
  pushes those into `ResolvedPrice.errors`, and every purchase door already
  refuses on a non-empty `errors`; `refuseComposition` already refuses on
  `OFFER_INACTIVE`. Nothing is ever sold at 0 IQD because an admin typed one
  zero too many.

### 4.4 The PLUS rung *(from first-class)*

`packages/pricing/src/pricing.ts` has three rungs — regular, PRIME, PRO — and no
`plus_price_iqd`. The mandate's "PLUS/PRO/premium" maps onto Levonis's
**PLUS (access) / PRIME (the middle paid tier — the mandate's "premium") / PRO**,
and no fourth tier is invented. But the mandate also asks for PLUS *pricing*, so
one offer-scoped rung is added — and **only** offer-scoped:

```ts
// worker/lib/bundleComposition.ts
export function resolveBundlePrice(input: {
  resolved: ResolvedPrice;            // from resolveUnitPrice on the bundle product row
  config: { price_mode: string; discount_percent: number | null; discount_iqd: number | null; plus_price_iqd: number | null };
  componentTotalIqd: number;
  tier: Tier;                          // packages/pricing/src/pricing.ts:63
  tierActive: boolean;                 // pricingTierContext(...).pricingTierActive
}): {
  bundle_price_iqd: number;            // the merchandise figure
  unit_subtotal_iqd: number;           // + the fees resolveUnitPrice already computed
  applied_tier: 'regular' | 'plus' | 'prime' | 'pro';
  component_total_iqd: number;
  discount_iqd: number;
  saving_percent: number;
  errors: string[];
};
```

Rules:

* the base ladder (regular / PRIME / PRO) comes from `resolveUnitPrice`
  untouched — the fee logic, the PRO waivers and `pricing_basis` are inherited;
* **the ladder is anchored on the DERIVED regular price, not the cached one.**
  In a discount mode the regular price is derived first, and `clampMemberLadder`
  then runs against that derived figure. Anchoring on `products.price_iqd` would
  break in a way nothing else could catch: `resolveUnitPrice` computes the PRO
  price from `regularIqd` = the cached number under
  `proPolicy.mode = 'global_percent'` (`packages/pricing/src/pricing.ts:585-590`)
  and clamps against the same cached number, so if the components get cheaper the
  derived regular can fall **below** the cached PRO price and a PRO member is
  charged more than a regular buyer, with no clamp able to see it. The rule is
  therefore explicit: **derive regular, then clamp**, and
  `tests/bundlePricing.test.ts` asserts `pro ≤ prime ≤ plus ≤ derived_regular` —
  the anchor, not only the ladder;
* a PLUS price applies only to an **active** PLUS viewer who has no better rung,
  and is clamped `pro ≤ prime ≤ plus ≤ regular`, so a member never pays more than
  the tier below them and never more than the regular price;
* **the PLUS rung reaches the card.** `display_price_iqd` /
  `display_applied_tier` come from `resolveUnitPrice`, which has no PLUS rung, so
  a PLUS member would be shown the regular price on the grid, the home shelf and
  search, and then charged the PLUS price in the cart and at the door — breaking
  the page/cart/door identity case 9 asserts. For a **composition row only**,
  `publicWithDisplayPrice` resolves the PLUS rung into `display_price_iqd` and
  emits `display_applied_tier: 'plus'`; the client tier union and
  `src/components/CardPrice.tsx` gain that one value (§13.2, §16). No product
  row ever emits it;
* `tierActive` is `pricingTierContext(db, userId, address).pricingTierActive`
  (`worker/lib/entitlements.ts:217`), **never** `tierStatus.active` and never
  `tier === 'pro'`. A PRO away from their approved default address pays the
  regular bundle price, exactly as they do for a product;
* `ResolvedPrice.applied_tier` (a shared type) is **not** widened; the four-value
  tier lives on the composition block and on the `display_*` projection only.

**This does not create a product-level PLUS price.** Doing that would touch four
ladder rungs, `clampMemberLadder`, `validatePriceLadder`
(`worker/lib/productRelations.ts:355`), the Quick Edit grid, the TXT template and
the CSV importer. That remains an owner decision (§17).

### 4.5 No fourth discount stage

The bundle price is a *product* price: it is already inside `merchandise` before
`settle` runs in `worker/routes/orders.ts`. So the coupon minimum, the points cap
(`eligibleMerchandiseIqd`, `worker/lib/pointsOps.ts:85`), the PRO and PRIME
delivery thresholds and the accrual basis all follow with **zero changes to
`settle`**. Coupon → points → wallet is untouched.

Stacking is therefore well-defined by construction: a coupon applies to the
bundle price like any other merchandise, and there is no second offer discount to
stack invalidly. **An offer has exactly one price**, and §4.6 makes that a
refusal rather than a hope: a subject may carry `bundle_config.price_mode` **or**
`offer_windows.offer_price_mode`, never both.

### 4.6 Scheduling, and the scheduled discount

`offer_windows.starts_at` / `ends_at`, ISO-8601 with an explicit `Z`, normalised
at the admin write boundary. One shared pure helper in the new
`worker/lib/offers.ts`:

```ts
export type ScheduleState = 'upcoming' | 'live' | 'ended';
export function scheduleState(startsAt: string | null, endsAt: string | null, nowMs: number): ScheduleState;
export function resolveOfferPrice(input: {
  base: ResolvedPrice;                 // the subject's own ladder, already resolved
  window: OfferWindow | null;          // §1.8, carrying the price columns
  scheduleState: ScheduleState;
  tier: Tier; tierActive: boolean;
}): { applied_iqd: number; regular_iqd: number; plus_iqd: number | null;
      offer_id: string | null; source: 'ladder' | 'offer' };
```

**A window carries its own price**, or "limited offer" would be a countdown over
an unchanged number: the only way to run *20 % off this week* would be an admin
edit at the start and another at the end, and the order snapshot's `offer` block
could not answer "which offer produced this price". So `offer_windows` gains
`offer_price_mode` / `offer_price_iqd` / `discount_percent` / `discount_iqd` /
`plus_price_iqd` (§1.8), and **one** helper resolves them for a bundle, a mystery
offer and an ordinary product alike. That is what makes slice 10's headline true:
a scheduled, tier-gated, limited, **discounted** offer on an ordinary product
ships with no new table and no second discount code path.

**Precedence is a refusal, not an arithmetic.** Exactly one of the two may set a
price for a subject:

| subject state | price |
|---|---|
| no window price (`offer_price_mode = ''`) | the subject's own ladder (a product's rungs, or `bundle_config.price_mode`) |
| a window price, live | the window's price, `source: 'offer'`; the member ladder is clamped against **it** as the regular anchor (§4.4) |
| a window price on a bundle that also sets `bundle_config.price_mode <> 'fixed'` | **refused at admin save**, `OFFER_PRICE_CONFLICT` |
| a window price, `upcoming` or `ended` | the subject's own ladder; the window contributes only its state and its countdown |

Never both, never summed, never a percentage of a percentage — that is precisely
the "invalid stacking" the mandate names. A coupon still applies afterwards, to
merchandise, exactly as §4.5 describes.

Evaluated at read time in the storefront query **and again in `priceLines`** at
checkout. No cron flips an `active` flag — a 15-minute cron would make a
countdown lie by up to 15 minutes. `ends_at` is shipped to the client for the
countdown; the client's clock decorates, the server decides.

Note the existing hazard: `src/components/adminCoupons/AdminCoupons.tsx` posts
timezone-less `datetime-local` strings which the Worker parses as UTC. The new
admin panel converts to explicit UTC before POST and displays Baghdad time
(UTC+3, as `worker/routes/rewards.ts` already hardcodes).

### 4.7 Admin-save refusals — never silently repaired

`planBundleComposition` returns `{ errors[] }` or `{ statements, warnings[] }` —
the exact contract `planRelationsWriteFrom`
(`worker/lib/productPersistence.ts:429`) uses.

Hard refusals: no components; a component naming another composition product (no
nesting); mixed shipping types; a pinned option value or colour that does not
exist on the member product or is inactive; a `COLOR`-mode member with neither a
pinned colour nor `customer_picks_color` (`resolveStock` would answer
`SELECTION_INCOMPLETE`, which is neither sellable nor wordable); publishing with
`price_iqd = 0` while `price_mode='fixed'`; `discount_percent` outside 1..90;
both `discount_percent` and `discount_iqd` set; a `VARIANT_COMBINATION` member
whose pinned selection has no `product_variants` row (`VARIANT_NOT_MODELLED`);
`ends_at <= starts_at` (the coupon rule); an inverted member ladder;
`discount_iqd >= the current component total` (`BUNDLE_DISCOUNT_EXCEEDS_TOTAL` —
one typed zero must not publish a free bundle); a window price set alongside a
non-`fixed` `bundle_config.price_mode` (`OFFER_PRICE_CONFLICT`, §4.6);
`offer_windows.discount_percent` outside 1..90; `spool_qty × max_qty_per_order >
MAX_PHYSICAL_LINES` (§3.1).

---

## 5. The cart

### 5.1 Line identity — no schema rebuild, and the corrected trick

A bundle cart line is an **ordinary `cart_items` row** with
`product_id = <the bundle product id>`. It satisfies the 0030 table `CHECK` (a
levonis line has a `product_id`), the table-level `UNIQUE (user_id, product_id,
community_product_id, option_id, color_id, shipping_method_id)`, the partial
index `idx_cart_levonis_line` (`migrations/0032_cart_line_identity.sql:98-100`)
and the `ON CONFLICT(...)` upsert in `worker/routes/cart.ts` — **with no index
change and no table rebuild**. That matters: 0032 exists precisely because a
nullable column silently disarmed that index once and took add-to-cart to a 500.

The only remaining question is: two bundle lines with **different component
choices must be two lines**. The composition key lives in `cart_items.option_id`,
which is structurally free on a composition row because a composition product has
no `product_option_groups` and no JSON `options`:

```ts
// worker/lib/bundleComposition.ts — mirrors comboKey() in worker/lib/inventory.ts:128
export function compositionKey(choices: Array<{
  component_id: string; option_value_ids: string[]; color_id: string | null; included: boolean;
}>): string;                       // 'bx_' + 16 hex, ≤ 19 chars
```

Server-computed only. A client-supplied key is ignored, exactly as `comboKey` is.

> **The correction — and it is bigger than one line.** `resolveUnitPrice` pushes
> `OPTION_NOT_FOUND` into `ResolvedPrice.errors` for any `optionId` it cannot find
> (`packages/pricing/src/pricing.ts:557-558`), and `priceLines` turns any resolver
> error into a 400 (`worker/routes/orders.ts:620-622`). Blanking `sel.optionId`
> is **not sufficient**, because `selectionFromCartRow`
> (`worker/routes/cart.ts:261-272`) returns
> `optionValueIds: ids.length ? ids : legacy ? [legacy] : []` — with
> `option_value_ids = '[]'` and `option_id = 'bx_…'`, `optionValueIds` is already
> `['bx_…']` — and `resolveCartLine` rebuilds `optionId: valueIds[0]` from that
> array (`worker/routes/cart.ts:180-192`). The same array reaches
> `saleAvailability` (`worker/routes/cart.ts:333`,
> `worker/routes/orders.ts:647-654`), which with no `doc.options` pushes
> `OPTION_NOT_FOUND` into `selection.errors`, leaving `selection.complete = false`
> and `refuseIncompleteSelection` (`worker/routes/cart.ts:42-49`) throwing the
> nonsense "Choose a colour before adding this item (OPTION_NOT_FOUND)".
>
> **The rule: `selectionFromCartRow` returns an EMPTY selection for a composition
> row** — `{ optionId: '', optionValueIds: [], colorId: '' }` — decided from
> `products.composition`, which is added to the cart and checkout `SELECT`s for
> exactly this purpose. Not the caller's job to remember: the one function that
> derives a selection from a row is the one place that knows the row is a
> composition. `cart_items.option_id` keeps the `bx_…` key for line identity and
> **nothing else derives anything from it**, which
> `tests/bundleCart.test.ts` case 10b asserts by checking that BOTH
> `ResolvedPrice.errors` and `saleAvailability(...).selection.errors` are empty
> for a composition line. Getting it wrong makes every bundle checkout fail with
> `VALIDATION`.
>
> Overloading `option_id` is still a live trap for future readers — the key is
> load-bearing in `selectionFromCartRow`, `resolveCartLine`, `saleAvailability`
> and price protection's variant key. A dedicated `cart_items.composition_key`
> would be cleaner, but making it load-bearing means rebuilding the partial
> unique index `idx_cart_levonis_line` and the `ON CONFLICT(...)` upsert — the
> exact operation `migrations/0032_cart_line_identity.sql` exists because of. It
> is §17 decision 9, not a v1 change; the containment above is the v1 answer.

Consequences, all verified against the code:

* `validateSelection` with no groups and no colours returns `[]`; ✔
* `resolveUnitPrice` is called with `optionId: null`, so `ResolvedPrice.errors` is
  empty; ✔
* `saleAvailability` is called with an empty `optionValueIds`, so
  `selection.complete = true` (nothing is required); ✔
* `refuseIncompleteSelection` passes; ✔
* two identical bundles with identical choices merge into one line at qty 2 — correct;
* two bundles with different colours are two lines — correct;
* a fixed-composition bundle has exactly one possible key, so it always merges — correct.

A **mystery** line uses a coarser key: `compositionKey` over
`[{component_id: family_id ?? '', …}]` when the admin allows family narrowing,
and a constant otherwise. There is nothing else to distinguish — the buyer
explicitly does not choose the product, and each spool is drawn independently at
checkout, so merging costs nothing and prevents a cart of forty identical rows.

The readable choices live in `cart_bundle_choices`, written in the **same batch**
as the `cart_items` upsert. The add path generates the row id up front (as
`worker/routes/cart.ts` already does for a fresh line); on the merge path it
reads the existing id and rewrites the choices idempotently — identical key
implies identical choices, so the rewrite is a no-op.

### 5.2 What the client sends, and never sends

**Sends** — `POST /api/cart/items`, the existing endpoint and the existing field:

```jsonc
{ "productId": "prd_…",          // the BUNDLE product id
  "qty": 2,
  // '' for a direct bundle. For a PRE-ORDER bundle this is REQUIRED and is
  // validated to be a method EVERY pre-order component offers; it is stored on
  // the bundle's own cart_items.transport_method so cartShippingType, the
  // mixed-cart guard and orderShippingType keep working unchanged (§2.2).
  "transportMethod": "",
  "bundleChoices": [             // ONLY for a composition product, ONLY where the admin allows a choice
    { "componentId": "bc_…", "optionValueIds": ["ov_…"], "colorId": "clr_…", "included": true }
  ],
  "mysteryFamilyId": "cat_…",    // ONLY when mystery_offers.customer_picks_family = 1
  "mysteryMode": "direct"        // ONLY when both modes are enabled: 'direct' | 'preorder'
}
```

**Never sends** — and any such field in the body is ignored, not echoed: a price,
a component total, a saving, a bundle price, a discount, a stock number, a
membership tier or flag, a composition key, the component *list* (the server owns
which components a bundle has), a pool, a weight, a seed, a drawn product, an
availability figure.

**Receives** — `GET /api/cart`, grouped server-side in `loadCart`:

```jsonc
{ "id": "ci_…", "kind": "bundle",
  "product": { "…ordinary card fields, slug, image…" },
  "qty": 2,
  "unit_price_iqd": 145000,
  "breakdown": { "…publicBreakdown(resolved), cost stripped…" },
  "composition": {
    "component_total_iqd": 190000,
    "bundle_price_iqd": 145000,
    "discount_iqd": 45000,
    "saving_percent": 24,
    "applied_tier": "prime",
    "max_bundles": 3,
    "components": [
      { "component_id": "bc_…", "product": { "name": "…", "slug": "…", "image": "…" },
        "variant": "PLA · Black", "qty_per_bundle": 2, "optional": false, "included": true,
        "value_iqd": 30000, "editable": true, "availability": { "state": "in_stock" } }
    ]
  },
  "availability": { "…saleAvailability, scope: 'composition'…" }
}
```

The components appear **only** under `composition.components`. They are never
top-level `items[]` entries, so the cart's own totals and the coupon merchandise
sum cannot double-count. The per-component figure is its **standalone** value,
labelled as such; the discount is stated once, on the bundle.

For a **mystery** line, `composition.components` is `[]` and
`composition.mystery` carries only
`{ spool_qty, family_label?, mode: 'direct'|'preorder', reveal_stage }`. **No
pool, no candidate, no weight, no product ever crosses that boundary.**

### 5.3 The one branch in `priceLines`

`worker/routes/orders.ts` iterates cart rows. For a row whose product has
`composition <> ''`, after `resolveCartLine` (called with a blanked `optionId`,
§5.1):

**Everything asynchronous happens before the closure.** `priceLines` is a
synchronous pure function over already-loaded rows, and that is load-bearing:
`computeCheckout` calls it up to **three** times (requested basis, prepaid, COD)
and may then swap the whole priced set (`worker/routes/orders.ts:761-766, 906`).
So, beside the existing `loadRelationsViews` and `printerProductIds` pre-loads
(`worker/routes/orders.ts:568-582`), one pre-pass loads: the components and the
stored `cart_bundle_choices`; for each mystery cart row the candidate pool, one
`await seedFrom(...)` and the **resolved draw** (§7.3). `priceLines` then only
reads what that pass produced.

1. **Read** the pre-loaded components and choices for this row.
2. For a **mystery** line, read the pre-computed allocation (§7) instead of
   `bundle_components`. Nothing is drawn inside `priceLines`.
3. **Re-validate**: offer window, tier, composition availability ≥ qty, aggregated
   per-target demand across every line (§3.2), shipping type consistency, the
   parent's transport method offered by every pre-order component, every stored
   choice still legal, every opted-in optional component satisfiable,
   `qty <= max_qty_per_order`, the physical-line ceiling (§3.1).
4. Push the **parent** `ComputedLine`: `stock_targets: []`,
   `unit = resolveBundlePrice(...).unit_subtotal_iqd` — the bundle merchandise
   price **plus the components' effective pre-order commissions and
   `direct_surcharge_iqd`** (§2.2) — `line = unit × qty`, `transport_snapshot`
   recording the chosen method and those per-component fees, `pricing_snapshot` =
   the resolver output with its `applied_iqd` / `regular_iqd` / `prime_iqd` /
   `pro_iqd` **overwritten with the figures actually charged** (§6.2) plus the
   composition block. `subtotal += line`; `merchandise += bundle_price_iqd × qty`
   (merchandise never includes the fees, so the points basis, the coupon minimum
   and the accrual stay right); `shippingItems.push(...)` built from the
   **components'** `ops_policy` facts, so a bundle containing a printer reaches
   the printer freight branch and twelve spools reach the carton threshold inside
   the existing `quoteShipping`, and `is_printer` is carried up onto the parent
   line so the checkout's printer delivery note still fires (§6.3).
5. Push one **component** `ComputedLine` per included component:
   `qty = qty_per_bundle × parentQty`, `unit = 0`, `line = 0`, `stock_targets`
   from its own `resolveStock`, plus `bundle_parent_item_id`,
   `bundle_component_id`, `component_value_iqd`, `component_alloc_iqd`.
   **`subtotal` and `merchandise` are not touched** — the money is on the parent.

`ComputedLine` gains four optional fields and nothing else. Everything downstream
— the `order_items` INSERT, the `stockMoves` map, `orderPublic`, the invoice —
reads them or ignores them.

Because the draw is pre-computed and salted on the **cart item id** (§7.3), all
three `priceLines` passes see the same filament regardless of which priced set
`computeCheckout` finally keeps.

---

## 6. Checkout and the order snapshot

### 6.1 Re-validation at the door

Everything in the table below, inside `priceLines`, on the **stored cart row** —
never on the client's claim. Plus, unchanged and inherited: payment method versus
shipping type, one shipping type per cart, address and PRO context,
`shipping.needs_config` → `SHIPPING_NEEDS_CONFIG`.

| check | list | detail | add to cart | quote | `POST /api/orders` |
|---|---|---|---|---|---|
| `status='active'` / `offer_windows.active` | filters | ✔ | refuses | ✔ | refuses |
| schedule (`starts_at` / `ends_at`) | filters | ✔ | refuses | ✔ | refuses |
| `required_tiers` | locks the card | locks the CTA | refuses | ✔ | refuses |
| per-user / global limit | advisory | advisory | advisory | advisory | **the trigger decides** |
| composition availability | badge | ✔ | refuses | ✔ | refuses **and reserves** |
| selected options / colours still legal | — | ✔ | refuses | ✔ | refuses |
| shipping compatibility, and the transport offered by every pre-order component | — | ✔ | refuses | ✔ | refuses |
| an opted-in optional component is satisfiable | — | ✔ | refuses | ✔ | refuses (`BUNDLE_OPTIONAL_UNAVAILABLE`) |
| aggregated demand per stock target across all lines | — | — | refuses | ✔ | refuses |
| the derived price is at or above `min_price_iqd` | filters | ✔ | refuses | ✔ | refuses (`OFFER_INACTIVE`) |
| physical lines per order ≤ `MAX_PHYSICAL_LINES` | — | — | refuses | ✔ | refuses |
| price | server | server | — | server | server, then snapshot |

The per-line refusals live beside the ones already there: `status !== 'active'`,
resolver errors, selection errors, `refuseIncompleteSelection`,
`refuseNonPrinterWarranty`, the stock check. One place, one shape.

### 6.2 The snapshot

**Parent `order_items` row** — `product_id` = the bundle product id:

| column | value |
|---|---|
| `name_snapshot` / `image_snapshot` | the bundle's name and cover, frozen |
| `option_snapshot` | **data only**: `"PLA Black ×2 · Nozzle 0.4"`. No prose, no count, no English word. A snapshot is immutable and is rendered on the order page, the invoice, the printed receipt and the return case for Arabic and Sorani customers for ever, so freezing "3 items" into it would freeze an English sentence into every future rendering. The count is rendered client-side by the existing trilingual `itemCountLabel(n, lang)` (`src/components/orders/format.ts:89`) from the component count the payload already carries |
| `qty` / `unit_price_iqd` / `line_total_iqd` | the bundle's own numbers |
| `pricing_snapshot` | `ResolvedPrice` **minus `cost_iqd`**, with the price rungs **overwritten with what was charged** (below), **plus** the composition block |
| `bundle_parent_item_id` | `NULL` |

**The parent's `applied_iqd` is pinned to `bundle_price_iqd`, and the other rungs
with it.** In a derived mode the charged price comes from the live component
total while `resolveUnitPrice`'s `applied_iqd` comes from the deliberately
drift-allowed `products.price_iqd` (§4.3). Everything downstream reads the
snapshot, not the order line: `unitMerchandiseIqd` / `eligibleMerchandiseIqd`
prefer `pricing_snapshot.applied_iqd` (`worker/lib/pointsOps.ts:70-74`), so the
points reversal on a refund would use the stale number;
`financialSnapshot`'s legacy recomputation (`worker/routes/orders.ts:106-118`)
would disagree with `orders.merchandise_iqd`; and price protection takes
`originalUnit` from it verbatim (`worker/routes/returns.ts:552-556`). So the
composition branch of `priceLines` overwrites `applied_iqd`, `regular_iqd`,
`prime_iqd` and `pro_iqd` with the figures `resolveBundlePrice` actually charged
before `JSON.stringify`, exactly as the component branch zeroes them. The
invariant is asserted directly: **for every order containing a bundle,
`eligibleMerchandiseIqd(items) === orders.merchandise_iqd`.**

The composition block inside `pricing_snapshot` — immutable and cost-free:

```jsonc
"composition": {
  "kind": "bundle",
  "bundle_product_id": "prd_…",
  "bundle_name": { "ar": "…", "en": "…", "ckb": "…" },
  "component_total_iqd": 190000,
  "bundle_price_iqd": 145000,
  "bundle_discount_iqd": 45000,
  "saving_percent": 24,
  "price_mode": "fixed",
  "applied_tier": "prime",
  "transport": { "method": "air", "component_commission_iqd": 12000, "direct_surcharge_iqd": 0 },
  "offer": { "offer_id": "ofw_…", "subject_type": "product", "subject_id": "prd_…",
             "required_tiers": ["plus"], "starts_at": "…", "ends_at": "…",
             "price_source": "offer", "offer_price_mode": "discount_percent",
             "offer_discount_percent": 20, "offer_applied_iqd": 145000 },
  "items": [
    { "order_item_id": "oi_…", "component_id": "bc_…", "product_id": "prd_…",
      "name": "PLA Basic", "variant": "Black",
      "option_value_ids": ["ov_…"], "color_id": "clr_…",
      "qty": 2, "value_iqd": 30000, "alloc_iqd": 22800,
      "reservation_line_id": "oi_…", "optional": false }
  ]
}
```

`reservation_line_id` is the component's `order_items.id`, which is *also* the
ledger `line_id` inside `inventory_ledger.idempotency_key`. **That is the
"inventory reservation reference" the mandate asks for** — no new column, and it
is provably the same value the ledger holds. `idx_inventory_ledger_order`
(`migrations/0020_inventory_adjust_direction.sql:43`) makes the lookup one
indexed read.

**Component `order_items` rows**: real `product_id`, `option_id`,
`option_value_ids`, `color_id`, real `qty`, `name_snapshot` / `image_snapshot` /
`option_snapshot` frozen, `unit_price_iqd = 0`, `line_total_iqd = 0`,
`component_value_iqd`, `component_alloc_iqd`, `bundle_parent_item_id`,
`bundle_component_id`, and `pricing_snapshot` = the component's own resolver
output with `applied_iqd` **set to 0 after the cost strip**.

**A MYSTERY component row persists `pricing_snapshot = null` instead**, and its
`component_value_iqd` / `component_alloc_iqd` are the **offer-derived share**
(`bundle_price_iqd` split across the spools by largest remainder), never the
drawn item's standalone value. `product_id = NULL` hides the join to `products`;
it does **not** hide the JSON the row carries itself. A `ResolvedPrice` carries
`regular_iqd`, `prime_iqd`, `pro_iqd` and `price_source: 'color'|'option'|'base'`
(`packages/pricing/src/pricing.ts:281-311`), every catalogue price is public, and
`ORDER_ITEMS_SELECT` is `SELECT oi.*` — so in a pool of a few dozen filaments the
price ladder alone usually identifies the entry, and §6.3 puts component values
into the invoice's `included[]` list, a document the customer downloads. The real
resolver output lives only in `mystery_allocations`, and §15.4 case 15 asserts
that **no number equal to the drawn item's `regular_iqd`, `prime_iqd`, `pro_iqd`
or standalone value appears in any pre-reveal customer payload, invoice or
receipt**.

**Why the money sits on the parent and the components are zero-priced**

* `Σ line_total_iqd` still equals `orders.subtotal_iqd`, so `financialSnapshot`'s
  legacy recomputation path and the invoice totals stay consistent with no
  special case.
* `unitMerchandiseIqd` (`worker/lib/pointsOps.ts:69`) prefers
  `pricing_snapshot.applied_iqd`. Components carry 0 and the parent carries the
  bundle price, so points accrue on exactly what was paid — no double accrual,
  no accrual on an inflated component total. **This is why the component
  snapshot's `applied_iqd` must be 0 and is asserted by a test.**
* Device units (`worker/lib/deviceOps.ts:201`, `ON CONFLICT(order_item_id,
  unit_index)`), warranty coverage, `return_cases.order_item_id` and
  `price_protection_claims.order_item_id` all key on `order_items.id` — and the
  **component** row is the one naming the real product, so a printer inside a
  bundle gets its unit and its warranty clock automatically.

`component_alloc_iqd` is computed at checkout by **largest-remainder allocation**
of the parent's `line_total_iqd` across components in proportion to
`component_value_iqd`, so `Σ alloc === line_total_iqd` exactly, with no runtime
rounding. When `Σ value === 0` the allocation is uniform. It is stored, never
re-derived, and it is what a return refunds.

### 6.3 What must filter component rows

Every consumer of `ORDER_ITEMS_SELECT` (`worker/routes/orders.ts:302`) was
audited — **and one consumer that is not an order-items consumer at all**, the
checkout quote. These **must** exclude `bundle_parent_item_id IS NOT NULL` rows
from the top level and nest them under the parent instead:

| file | why |
|---|---|
| `worker/routes/orders.ts` — the **quote** serializer (`comp.lines.map(...)`, `worker/routes/orders.ts:1127-1138`) | `POST /api/orders/quote` never touches `order_items`, so the audit above missed it — and §5.3 pushes one component `ComputedLine` per component into that same `comp.lines`, each carrying the **parent's** `cart_item_id`. `src/pages/Checkout.tsx:452-471` maps `quote.lines` 1:1 with `key={l.cart_item_id}`, so a four-component bundle would render the bundle plus four extra 0 IQD rows under four duplicate React keys, naming the member products, **on the last screen before payment** — the mandate's "not separate top-level lines" rule broken at the highest-stakes surface. Components become `included[]` under the parent, and `is_printer` is carried up so the printer delivery note at `src/pages/Checkout.tsx:1032` (`summaryLines.some(l => l.isPrinter)`) still fires |
| `worker/routes/orders.ts` — `orderPublic` items | the customer sees one line with `bundle.components[]` |
| `worker/lib/invoices.ts` — `lineFromItem` | priced lines only; components become an `included[]` list under the parent |
| `worker/routes/admin.ts` — the printed receipt and the ESC-POS body | same |
| `worker/routes/admin.ts` — the courier `itemsSummary` | the courier gets the parent name and the physical count |
| `worker/routes/orders.ts` — the admin Telegram message | one item count, not two |

**Six filters, added once, one line each** — plus
`src/components/adminOrders/OrderDetailModal.tsx`, which is not a filter but a
**grouping**: it renders `detail.items` flatly (`:373-392`) and is the screen
staff read when packing a box, so it groups `bundle_parent_item_id` children
under their parent and renders the mystery allocation with the "not yet revealed
to the customer" chip. `tests/bundleCheckout.test.ts` asserts
`quote.lines.length === 1` for a four-component bundle and that the printer note
still fires.

These **must keep** component rows, because they are the physical truth:
`createUnitsOnDelivery`, `worker/routes/returns.ts`, `price_protection_claims`,
`GET /api/orders/:id/units`, the `OrderDelivered` item list in
`worker/lib/orderStageOps.ts`, the `idx_order_items_product` sold-index queries,
and every inventory replay.

### 6.4 Returns, cancellation, refunds

* **Cancellation**: no change. `planOrderReturn` replays the reserve ledger;
  every component releases or restores inside the same batch as the status flip
  and the refunds. `offer_redemptions` rows are **not** deleted on cancellation —
  the same rule coupons follow today (§17 flags it as an owner decision).
* **Returns**: a case is opened against a **component** `order_items.id`;
  `worker/routes/returns.ts` gains a `bundle_parent_item_id` lookup so staff see
  "1 of 3 items in Bundle X" and the sibling components.
* **Policy, v1**: whole-bundle returns only. Opening a case on one component is
  refused with `BUNDLE_PARTIAL_RETURN_NOT_ALLOWED`; the UI offers "return the
  whole bundle", which opens one case per component. Per-component returns become
  a config flag in a later slice; the data is already there.
* **The returnable quota is judged on the rows the cases are opened against.**
  A whole-bundle return opens its cases against the CHILD rows, never against the
  parent, so a quota read keyed on the parent counts zero for ever: the same
  delivered bundle could otherwise be re-POSTed for the whole 7-day window, each
  round opening a fresh full set of component cases, each priced off
  `component_alloc_iqd`, each credited under a `wtx_ret_<caseId>` the wallet's
  idempotency guard has never seen, and each restoring stock under a fresh
  `operationId = caseId` the ledger's UNIQUE key has never seen either — three
  rounds on one 400,000 IQD bundle refunding 1,200,000 IQD and turning one
  ordered printer into +3 stock. The reservation fence cannot help: every round
  is a legitimately planned restore whose `expected` equals its `actual`. So the
  check is **per child**, against the very ids the fan-out will bind, and it runs
  BEFORE the batch so the fan-out stays all-or-nothing. It is also the shape a
  later per-component-return flag needs (§17 decision 3).
* **The refund basis is explicit, and it is NET** — this is a change to
  `worker/routes/returns.ts`'s arithmetic, listed in §16. Today a case is priced
  `lineGross = unit_price_iqd × kase.qty` then `refundIqd = lineGross − alloc`
  (`worker/routes/returns.ts:333-339`), and §6.2 pins a component's
  `unit_price_iqd` to 0 — so **every component case would refund 0 IQD** and the
  points reversal beside it, which reads `unitMerchandiseIqd` and therefore
  `pricing_snapshot.applied_iqd` (`worker/lib/pointsOps.ts:70-74`), would reverse
  nothing. Naively substituting `component_alloc_iqd` **over**-refunds instead,
  because the existing formula still has to subtract the line's proportional
  share of coupon and points (`alloc = floor(discounts × lineGross / base)`) and
  `Σ component_alloc_iqd` is the parent's **gross** line total. So:

  ```
  caseGross = COALESCE(component_alloc_iqd, unit_price_iqd × order_items.qty)
              × kase.qty / order_items.qty        -- partial-qty returns of a multi-qty bundle
  alloc     = base > 0 ? floor(discounts × caseGross / base) : 0      -- unchanged
  refundIqd = max(0, caseGross − alloc)
  ```

  and the **same `caseGross`** is fed to `reversePointsForOrder` in place of
  `unitMerchandiseIqd × kase.qty`. `tests/bundleReturns.test.ts` asserts that
  `Σ refundIqd` over a fully returned bundle equals the parent's `line_total_iqd`
  minus its share of coupon and points — not the gross.
* **Stock back**: through `applyInventory({kind:'restore'})` per §3.4, never the
  raw `UPDATE products`.
* **Which physical components belong to the bundle**: three independent answers,
  all already stored — `order_items.bundle_parent_item_id`, the parent's
  `pricing_snapshot.composition.items[].order_item_id`, and
  `inventory_ledger WHERE order_id = ? AND kind = 'reserve'` with the line id
  inside the idempotency key.
* **Price protection**: two silent kills had to be fixed for the sentence below
  to be true, and both are in §16 as changes to `worker/routes/returns.ts`.
  * On a **component**, `originalUnit` is **the component's share of what was
    paid** — `floor(component_alloc_iqd / qty)` — never
    `pricing_snapshot.applied_iqd` (§6.2 pins it to 0, making
    `perUnitDrop = max(0, 0 − observed) = 0` and every claim a misleading
    `NO_ELIGIBLE_DROP`) and never `component_value_iqd`.

    **This corrects an earlier version of this section, which named
    `component_value_iqd` and produced an over-credit.** That column is the
    component's UNDISCOUNTED standalone catalogue value, a number the customer
    never paid: on a bundle whose parts are worth 425,000 and which sold for
    200,000, a component pinned at 400,000 would be credited 380,000 when its
    catalogue price fell to 20,000 — 1.9× what was paid for it, 1.9× the price of
    the whole order, with the goods kept, and `priorCreditedIqd` caps only the
    repeats and not the size of the first claim. Every other price-protection
    path compares against what was actually charged, and this one now does too.
    `component_alloc_iqd` is the same stored figure this section already makes
    the refund basis, so a refund and a price-protection credit cannot disagree
    about what one component cost. `component_value_iqd` stays in
    `policy_snapshot` as the provenance of the comparison, never as its ceiling.

    The price-history `variantKeys` (`worker/routes/returns.ts`) are built from
    the **component's** real `option_id` / `color_id`, which is what they already
    are on a component row.
  * On the **parent**, `order_items.option_id` is the `bx_…` composition key,
    which matches no `price_history.variant_key`, so a bundle-level claim can
    only ever end in `NO_ELIGIBLE_DROP`. It is refused explicitly with
    `COMPOSITION_NOT_ELIGIBLE` — "the bundle's parts are covered individually" —
    rather than pretending it was evaluated.
  * A **mystery** line is excluded outright (there is no comparable list price,
    and any comparison would leak the pick): `MYSTERY_NOT_REVEALED` before the
    milestone, `COMPOSITION_NOT_ELIGIBLE` after it.

---

## 7. The mystery engine

### 7.1 Shape

A mystery offer is a `products` row with `composition = 'mystery'`,
`stock = NULL`, its own price ladder, cover, gallery, ar/en/ckb title, slug,
schedule, tier gate and limits — all inherited. `mystery_offers` adds
`spool_qty`, the two pool ids, the two mode switches and the server secret. So a
mystery offer is **a bundle whose components are drawn instead of listed**, and
every word of §3, §4, §5 and §6 applies unchanged.

### 7.2 The candidate query

Built server-side, per pool, per checkout — never per spool, never cached, never
shipped to the browser.

```sql
SELECT e.id AS entry_id, e.product_id, e.option_value_ids, e.color_id, e.weight,
       p.inventory_mode, p.stock, p.stock_reserved, p.low_stock_threshold,
       p.status, p.sale_types, p.name
  FROM mystery_pool_entries e
  JOIN products p ON p.id = e.product_id
 WHERE e.pool_id = ?1
   AND e.active = 1
   AND e.weight > 0
   AND p.status = 'active'
   AND p.composition = ''                       -- never a bundle inside a mystery
   AND (?2 = '' OR e.family_id = ?2)            -- the buyer's family narrowing, a CATALOG/FACET ID
```

Then, in memory, using one batched `loadRelationsViews`
(`worker/lib/productOverlay.ts:191`) over the distinct product ids:
`snapshotFrom` + `resolveStock` per entry, and drop every entry where

* `resolution.error` is set, or
* the pool is `kind='direct'` and (`available === null` or
  `available < pool.min_available`) — untracked stock cannot back a direct sale, or
* the entry names an inactive option value or colour (the relations view says so), or
* `effectiveAvailability(option, sale_types)` disagrees with the pool `kind` — a
  direct pool takes only direct-sellable entries; a pre-order pool takes
  procurement-eligible ones and does **not** test stock, or
* the product fails the pool's `require_catalog_ids` / `require_facet_ids`.

**Eligibility is never inferred from a product NAME.** `family_id`,
`require_catalog_ids` and `require_facet_ids` are structured taxonomy ids.
`packages/pricing/src/availability.ts` documents name parsing as a last resort;
it is not used here at all.

If the surviving list is empty → **`unavailable(msg,
'MYSTERY_NO_ELIGIBLE_STOCK')`** (503, the honest "nothing to sell" answer,
`worker/lib/http.ts:28`). The buy button is disabled and the storefront shows a
genuine out-of-stock state. No invented inventory, and a direct-sale purchase is
**never** silently converted to a pre-order.

### 7.3 Weighted selection and the RNG

**Algorithm.** Cumulative-weight (roulette-wheel) selection, already implemented
and tested in the tree: `weightedIndex(weights, r)`
(`worker/lib/farm/rng.ts:97`). Default weight 1; weight 0 excluded by the query;
higher weight means proportionally more likely. Exact probabilities are shown to
customers only when `bundle_config.show_odds = 1`; the admin preview always shows
them.

**RNG.** `worker/lib/farm/rng.ts` — the server-held-seed generator this codebase
already uses, whose header documents the exact bug avoided here: a seed derived
from ids the client knows can be ground offline for a favourable roll. That
header names *"their idempotency key"* as the phase-1 input that made grinding
possible, so **the checkout idempotency key is not an input to this seed**, and
neither is any other value the client chooses.

```ts
import { seedFrom, sequence, weightedIndex } from './farm/rng';
```

The seed cannot be freshly random at draw time, because `priceLines` runs up to
**three** times per checkout (requested, prepaid and COD bases) and once more on
the quote. It is salted instead on identity that already exists and that the
client cannot vary:

```
-- written by the SERVER when the mystery cart line is created (§1.5)
cart_items.draw_salt = randomSeedHex()

seed = await seedFrom(secret, cart_items.draw_salt)      -- secret from mystery_offer_secrets
rand = sequence(seed, `mystery:${cartItemId}:${spoolIndex}`)
```

**`order_items.id` is deliberately NOT in the salt.** `priceLines` assigns
`id: newId('oi')` — crypto-random — on *every* call
(`worker/routes/orders.ts:693`), and `computeCheckout` can swap the whole priced
set afterwards (`priced = prepaidPriced`, `worker/routes/orders.ts:906`). Salting
on it would make each pass draw a different filament and let the
wallet-covers-the-total branch decide which draw was persisted. `cart_items.id`
is stable across all three passes, across the quote, and across a retry under the
same idempotency key.

`seedFrom` is async and the candidate query is a database read, so **both happen
in the pre-pass**, not inside `priceLines` (§5.3) — one `await seedFrom(...)` and
one candidate load per mystery cart row, exactly as `loadRelationsViews` and
`printerProductIds` are pre-loaded at `worker/routes/orders.ts:568-582`.
`tests/mysteryAllocation.test.ts` asserts the three passes produce identical
allocations.

The secret is 64 hex from `randomSeedHex()`, stored in `mystery_offer_secrets`
(§1.9), regenerated on duplicate, rotatable by the owner, and joined by **no**
read route. Consequences:

* all three `priceLines` passes draw the same filament, so the price bases agree;
* the quote and the order draw the same filament, so the customer is not shown one
  thing and sold another;
* a pre-batch failure retried under the same idempotency key redraws **the same**
  filament from the same cart row (unless that exact entry has since gone out of
  stock, in which case a different one is drawn — correct, because nothing had
  committed and nothing had been shown);
* re-purchasing the same cart line replays the same pick, because the allocation
  is bound to the salt;
* no client input can grind for a rare filament: the secret is server-only, the
  salt is server-written, and **no refusal path may name, price or hint at the
  drawn item** (§15.1). A 400 body, a `blockers[]` entry or an error message that
  identified the unlucky component would turn a deterministic seed into a free
  oracle, and that is the property the seed alone cannot protect.

**And the reroll is closed.** A wallet-paid mystery order with
`reveal_stage = 'paid'` is revealed while `orders.status` is still `pending`, and
`POST /api/orders/:id/cancel` refunds it in full and releases the stock
(`worker/routes/orders.ts:1839-1878`) — so a buyer could look, self-cancel and
re-post for a new draw, unbounded, since `offer_limits.max_per_user` defaults to
NULL. Two rules, both required: **customer self-cancellation is refused once a
mystery line on the order is revealed** (`MYSTERY_REVEALED_NO_CANCEL`; an admin
may still cancel, and the refund path is unchanged), and **cancelling an order
does not free the per-user redemption slot for a mystery subject** — the same
rule coupons follow, made explicit here rather than left to §17. The admin panel
defaults `max_per_user` to a finite number for every mystery offer.

### 7.4 Permanence — three independent fences

1. **`mystery_allocations PRIMARY KEY (order_item_id, spool_index)`** — the row is
   written in the order's own batch. A replay that somehow re-entered the write
   path collides and aborts the whole batch, exactly as `gift_redemptions`'
   primary key does in `worker/routes/reviews.ts`.
2. **`orders.idempotency_key UNIQUE`** (`migrations/0001_init.sql:156`) — the
   replay branch in `worker/routes/orders.ts` returns the stored order without
   recomputing anything.
3. **The deterministic seed** — even a path that recomputed would recompute the
   same value.

Refreshing, retrying checkout, reopening the order or replaying a webhook
therefore cannot produce a different filament. The allocation is permanent:
nothing ever updates `mystery_allocations.product_id` or `color_id`; a cancelled
order keeps its allocation row for audit while its reservation is released.

**`POST /api/orders/quote` never allocates** *(from first-class)*.
`computeCheckout` takes an explicit `{ allocate: boolean }` flag: `false` for the
quote, `true` for `POST /api/orders`. With `allocate: false` the mystery line
prices at the offer price and reports availability, and nothing is drawn and
nothing is written — a hard guard on top of determinism, honouring the rule that
the quote is read-only.

### 7.5 Multi-spool and the duplicate policy

`spool_qty × qty` spools are drawn sequentially with
`salt = mystery:<orderItemId>:<spoolIndex>`. After each draw the chosen
candidate's remaining `available` is decremented **in memory**, and a candidate at
zero leaves the wheel — so two spools cannot both claim the last unit of one
colour. The **real** enforcement is still `planInventory`'s guard plus the fence:
all spools' reservations are in one batch, so a partial multi-spool reservation
cannot commit.

`bundle_config.duplicate_policy` *(behaviour from first-class)*:

* **`'allow'`** — the wheel is unchanged between draws.
* **`'discourage'`** — after a candidate is drawn its weight is **halved (integer
  division, minimum 1)** for the remaining draws on this line. A concrete,
  testable rule.
* **`'forbid'`** — the drawn candidate is removed from the wheel. If the wheel
  empties before every spool is drawn, the checkout is **refused** with
  `MYSTERY_NOT_ENOUGH_VARIETY`. It is **never** silently downgraded to `allow` —
  silently pretending duplicates were forbidden is exactly the dishonesty the
  mandate forbids.

  **The customer refusal carries no number.** Naming how many distinct choices
  exist would let a buyer binary-search their own `qty` against the refusal and
  read back the exact count of currently eligible, in-stock, distinct pool
  entries — on demand, repeatedly, for free, with no purchase, tracking live
  inventory, and composing with the public availability channel (§8.2 row 18) to
  shrink the candidate set to near certainty *before* buying. The count lives in
  the **admin preview** and in the save-time `POOL_TOO_SMALL_FOR_FORBID` warning
  only. The composition quote and add-to-cart paths are rate-limited per user —
  `rateLimit(c, 'composition_quote', 60, 300)` on **`POST /api/cart/items`,
  `PATCH /api/cart/items/:id` and the composition branch of
  `POST /api/products/:slug/quote`, all three**, since removing a mystery line
  and re-adding it writes a fresh `randomSeedHex()` and therefore a fresh draw.
  On its own that is harmless; combined with any availability oracle it turns a
  deterministic seed into a free, unbounded grinder for a favourable roll, which
  is exactly the property §7.3 says the seed alone cannot protect. The residual
  enumeration risk is recorded in §15.1 as a known accepted bound **on the basis
  that this limiter exists**, so the doors it must cover are enumerated here
  rather than assumed.

### 7.6 Direct versus pre-order

The buyer's chosen mode — or the offer's only enabled mode — selects
`direct_pool_id` or `preorder_pool_id`. They are **separate pools**
(`mystery_pools.kind`) so a direct-sale mystery purchase can never silently
become a pre-order. A direct draw requires real stock and reserves it. A
pre-order draw does not test stock and, following the existing pre-order rule,
still names a real product row — `inventory_ledger.product_id` has a foreign key
to `products(id)` — and the line reserves nothing when its component targets are
empty (untracked). The order rides the fourteen-stage pre-order journey via the
component's transport method, exactly like an ordinary pre-order line.

If the requested mode is not enabled or its pool is missing:
`MYSTERY_MODE_NOT_AVAILABLE`.

### 7.7 What the mystery order item looks like *(from first-class)*

For each spool, one component `order_items` row with:

* **`product_id = NULL`** — deliberately. `order_items.product_id` is nullable
  (`migrations/0001_init.sql:166`). This single choice removes the largest class
  of leak: the `ORDER_ITEMS_SELECT` join to `products` yields no `product_slug`,
  `GET /api/orders/:id/units` finds nothing to join, the invoice writes the
  offer's name and the courier payload says the offer's name — **with no filtering
  code at all**.
* `name_snapshot` = the offer title, `image_snapshot` = the offer cover,
  `option_snapshot` = `''`, `option_id` = `''`, `color_id` = `''`.
* `bundle_parent_item_id`, `bundle_component_id = ''`, `component_value_iqd`,
  `component_alloc_iqd`, `unit_price_iqd = 0`, `line_total_iqd = 0`.

The real pick lives **only** in `mystery_allocations`, with its own frozen
`name_snapshot` / `image_snapshot` / `variant_snapshot`. At reveal, the customer
projection joins it in and substitutes name, image and variant. The `order_items`
row is **never mutated** — snapshots are immutable.

Two documented consequences: `createUnitsOnDelivery` keys on
`order_items.product_id`, so a mystery spool creates no device unit (filament is
not a device — a mystery offer over printers is out of scope); and the
`idx_order_items_product` sold-index does not count mystery spools —
`mystery_allocations` is the sold-index for them, which is what
`mystery_allocation_stats` exists for.

The **reservation** move for a mystery spool is still built from the allocation's
real product and targets: `ComputedLine.product_id` carries the real product (it
must — `planInventory` and `shippingFactsFrom` need it), and only the
`INSERT INTO order_items` binds `NULL` in its place. `inventory_ledger.product_id`
names the real product, as it must, and is never a customer payload (§8.2).

**But `ComputedLine` is also what builds the `OrderCreated` event**
(`worker/routes/orders.ts:1541-1549` maps `comp.lines` to
`{ product_id: l.product_id }`), so as written every mystery order would publish
the drawn product id into the event bus and the analytics service at creation —
the one analytics surface the mandate names explicitly. And simply binding `null`
there is worse: `orderItemRef.product_id` is `nonEmptyStr` in the v1 contract
(`packages/contracts/src/events/common.ts:18-25`), `buildEnvelope` would reject
the payload, `outboxStatement` catches and returns `null`
(`worker/lib/eventBus.ts:308-315`), and `OrderCreated` would **silently
disappear** for every bundle and mystery order. `OrderDelivered` has the
mirror-image bug: `String(r.product_id)` (`worker/lib/orderStageOps.ts:287`)
writes the literal string `"null"`. So:

* `packages/contracts` is in §16's change list: `orderItemRef.product_id` becomes
  nullable and the ref gains
  `item_kind: 'ordinary' | 'bundle_parent' | 'bundle_component' | 'mystery'`;
* `OrderCreated.items[]` is built from the **persisted `order_items` rows**, not
  from `comp.lines`, so what the bus sees is what the database holds;
* `orderStageOps.ts:287` coerces `String(r.product_id ?? '') || null`;
* a test asserts a mystery order produces **exactly one valid `OrderCreated`
  outbox row** carrying no drawn product id — the row's existence and its
  contents both, because a swallowed validation error is invisible otherwise.

---

## 8. The reveal state machine

### 8.1 States

```
allocated ──(milestone reached)──▶ revealed        (monotone: never goes back)
```

The milestone is `mystery_allocations.reveal_stage_snapshot` — a copy of
`bundle_config.reveal_stage` frozen onto the allocation at draw time:

| value | reached when |
|---|---|
| `'paid'` | a settlement or prepayment is recorded — the wallet debit at creation, or `POST /api/orders/:id/settlement` for a cash-on-delivery order |
| `'confirmed'` | `orders.stage` index ≥ `confirmed` |
| `'preparing'` | direct: `preparing`; pre-order: `supplier_preparing` |
| `'shipped'` | `out_for_delivery` |
| `'delivered'` | `delivered` |

Evaluated by a pure function over stored facts — testable with no database, and
incapable of disagreeing between two screens:

```ts
// worker/lib/mysteryReveal.ts
export type RevealStage = 'paid' | 'confirmed' | 'preparing' | 'shipped' | 'delivered';
export function isRevealed(
  allocation: { revealed_at: string | null; reveal_stage_snapshot: RevealStage },
  order: { stage: OrderStage; status: string; shipping_type: ShippingType },
  paid: boolean
): boolean;   // revealed_at !== null  ||  derive(reveal_stage_snapshot, order, paid)
```

It compares **stage indices within `stagesFor(order.shipping_type)`**
(`worker/lib/orderStages.ts:84`), so the five-stage direct path and the
fourteen-stage pre-order path both work.

**Once written, `revealed_at` IS the truth.** It is stamped the first time the
derivation returns true, by `moveOrderStage` (`worker/lib/orderStageOps.ts:136` —
the single writer of `orders.stage`) as one more statement in its existing batch,
and by `POST /api/orders/:id/settlement` for the `'paid'` milestone. It is never
cleared, and `isRevealed` short-circuits on it. An admin moving a stage backwards
(allowed one step by `canMoveStage`) does **not** un-reveal — un-telling a
customer what they bought would be the worse lie, and the same rule already
governs delivered effects.

The monotone guarantee has **two** axes, and the first draft asserted only one.
`bundle_config.reveal_stage` is a single mutable row shared by every past and
in-flight order of that offer: editing it from `'paid'` to `'delivered'` would
retroactively hide picks customers have already been shown, and from
`'delivered'` to `'paid'` would reveal every in-flight order at once — while a
test that only walks the **order's** stage backwards passes throughout.
Duplicating or archiving an offer has the same reach. That is why the milestone
is snapshotted onto the allocation at draw time: a later config edit changes what
**future** orders are sold under and cannot move an existing order's milestone in
either direction. §15.4 case 15 exercises both directions of a `bundle_config`
edit as well as the stage move.

### 8.2 Every leak surface, and what it does before reveal

Before reveal, a customer-facing payload may carry **only**
`{ mystery: { revealed: false, spools: 2, reveal_at: 'delivered',
reveal_stage_label: '…', sale_mode: 'direct' } }`. Not a product id, not a name,
not a slug, not an image URL, not an R2 key, not a colour hex, not a stock delta,
not a weight, not a pool id.

`reveal_stage_label` is the milestone in the viewer's own language, rendered by
the server's existing `stageLabel` so no screen keeps a second stage table, and
`sale_mode` is the mode the buyer themselves chose. Neither identifies the pick,
and both are legitimately useful to the storefront — but the allow-list is the
checklist §15.4 case 15 tests against, so they are NAMED here rather than left as
two fields that happen to be harmless. `tests/mysteryReveal.test.ts` pins the
pre-reveal key set positively, so a field added beside them fails.

| # | surface | file | why it is safe |
|---|---|---|---|
| 1 | `orderPublic` items | `worker/routes/orders.ts` | `product_id` is NULL; the mystery object carries `revealed:false` and nothing else |
| 2 | `ORDER_ITEMS_SELECT`'s `products` join for `product_slug` | `worker/routes/orders.ts:302` | NULL `product_id` ⇒ NULL slug, structurally |
| 3 | `GET /api/orders/:id/units` | `worker/routes/orders.ts` | joins on `order_items.product_id`; NULL ⇒ no row |
| 4 | `GET /api/orders/:id/tracking` | `worker/routes/orders.ts` | stage labels only; asserted to carry no item names |
| 5 | the invoice snapshot | `worker/lib/invoices.ts` (`lineFromItem`) | writes `name_snapshot`, which is the offer title |
| 6 | the printed receipt / ESC-POS body | `worker/routes/admin.ts` | the **customer copy** prints the offer title and a "mystery" marker; the pick is on the admin order screen |
| 7 | the courier `itemsSummary` | `worker/routes/admin.ts` | offer title × qty; the courier is a third party |
| 8 | the admin Telegram message | `worker/routes/orders.ts` | counts only; it is an external service |
| 9 | the `OrderCreated` outbox event | `worker/routes/orders.ts` | `items[].product_id` is null for a mystery line; the pick is not an analytics fact until revealed |
| 10 | `InventoryChanged` | `worker/lib/inventory.ts` | names the real product — it **must**, it is the stock truth — and is an **internal bus payload only**, never customer-visible. **Its `order_id` is `null` for a mystery spool**: row 9 nulls `OrderCreated.items[].product_id` because "the pick is not an analytics fact until revealed", so leaving the order id here would let any bus consumer reconstruct exactly that with one join, from the moment the order commits. The `inventory_ledger` row keeps the real `order_id`, so operational traceability is untouched |
| 11 | the inventory ledger and the admin stock screen | `worker/routes/adminProductRelations.ts` | admin-only; authorised operational access by design |
| 12 | the cart payload | `worker/routes/cart.ts` | `composition.components = []` for a mystery line, always |
| 13 | availability numbers | `publicRelations`, `saleAvailability` | a mystery offer reports a coarse state only — `in_stock`/`low`/`sold_out` — never a candidate count |
| 14 | "buy again" / reorder selection | `worker/routes/orders.ts` | a mystery item returns `{ offer_product_id }` and no product selection |
| 15 | the return case payload | `worker/routes/returns.ts` | pre-reveal shows the offer; a return before reveal is refused with `MYSTERY_NOT_REVEALED` rather than leaking |
| 16 | order emails and notifications | `worker/lib/emailTemplates.ts` | the line name comes from `name_snapshot` |
| 17 | analytics | §12 | aggregates only; nothing per-order before reveal |
| 18 | **the MEMBER product's own public availability** | `worker/lib/productOverlay.ts:505-546`, `worker/routes/products.ts:569, 944-960` | **the one channel the "use real inventory" rule creates, and the only one not downstream of something already closed.** See below |
| 19 | the component `pricing_snapshot` and `component_value_iqd` | `worker/routes/orders.ts:273, 302` | a mystery component persists `pricing_snapshot = null` and an offer-derived share, never the drawn item's ladder (§6.2) |
| 20 | the checkout **quote** lines | `worker/routes/orders.ts:1127-1138` | components are nested as `included[]`, never top-level (§6.3) |
| 21 | **the shipping quote and the frozen `delivery_method_snapshot`** | `worker/routes/orders.ts` | a mystery spool's shipping facts come from **the OFFER's own `ops_policy`**, never the drawn candidate's. See below |

**Row 21 in full.** The shipping engine was fed the DRAWN candidate's real
`ops_policy`, and the resulting breakdown is published verbatim:
`quote.shipping.components = [{kind:'printer_large', fee_iqd:25000, units:1}]`.
That breakdown is then frozen into `delivery_method_snapshot` and served back on
`GET /api/orders/:id` from the first second — a customer payload naming the
pick's size class for an order whose milestone is `'delivered'`. Any pool that is
not perfectly homogeneous in `size_class` / `is_spool` leaked a partition of the
candidate set. And it was a **pre-purchase oracle**: the same block is on
`POST /api/orders/quote`, which draws but writes nothing, so a caller could grind
quotes and read the partition off the fee alone without buying anything.

Redacting only the breakdown would leave that half open, because **the FEE is the
oracle**. So the offer row's own `ops_policy` decides — one fact for every spool
of that offer, whatever is drawn. A mystery offer over devices is out of scope
(§17 decision 7), so the pools are filament and the offer's own `is_spool` is the
honest fact; the owner sets it where they set every other shipping fact.

**Row 18 in full, because it defeats four of the five milestones on its own.**
Levonis publishes *exact* sellable counts per option value and per colour to
anonymous callers (`publicRelations` emits `available` at every level;
`saleAvailability` returns `stock.available` and `max_qty`). A buyer snapshots
the admin-curated filament catalogue, checks out, and snapshots again: exactly
one colour row has dropped by exactly `spool_qty × qty`. Two unauthenticated GETs
defeat `'confirmed'`, `'preparing'`, `'shipped'` and `'delivered'` completely,
deterministically, not statistically. Every other defence in this design is
downstream of a channel that is already open.

**The rule: membership of an active mystery pool is a publication rule.** For any
product with an active `mystery_pool_entries` row, exact `available` is
suppressed in `publicRelations` and in `saleAvailability`'s stock block at base,
option-value **and** colour level — the customer sees `in_stock` / `low` /
`sold_out` and a clamped `max_qty`, and admins keep the exact counts.

**"Publication rule" means EVERY surface that reads the four stock tables, not
the anonymous catalogue routes.** Three corrections, each of which reopened the
channel on its own:

* **The coarse projection blanks the PER-LEVEL counters too.** `projectPublic`
  emits `product.options[]` and `product.colors[]`, and `applyRelations` overlays
  the raw `product_option_values.stock` / `product_colors.stock` onto them.
  Nulling only the base `stock` left two anonymous GETs around a **confirmation**
  identifying the drawn colour exactly, because `deduct` decrements `stock`
  itself. The suppression therefore lives inside `projectPublic`, which takes a
  `coarse` argument, rather than beside each caller.
* **`GET /api/cart` and every cart and checkout refusal obey it.** They read the
  same four tables, and `reserve` bumps `stock_reserved` inside the order's own
  batch — so a buyer could snapshot the candidates through their OWN cart before
  and after checking out and read the pick and the spool count off the delta,
  defeating every milestone including `'paid'`, the one §17 decision 10 promises
  is deliverable even if coarse counts are rejected. `activePoolProductIds` is
  resolved once per cart and once per checkout (§14) and threaded into every
  `saleAvailability` call and into the cart line's own `stock`, `options[]`,
  `colors[]` and `publicRelations`. The refusal sentences degrade to their
  existing count-free branches — `saleAvailability`'s coarse branch returns
  `available: null`, so `Only N left` and `Only N of "X" left in stock` take the
  paths they already had, with no new branch.
* **A MYSTERY OFFER'S OWN `availability` BLOCK CARRIES NO COUNT EITHER** (row 13,
  and §10's "coarse availability state only, no counts"). `publicAvailability`
  correctly drops every count from the `composition` block, but the `availability`
  block beside it published `on_hand` / `available` = `floor(Σ eligible available
  ÷ spool_qty)` — the live sellable supply of the whole eligible pool, to an
  anonymous caller, with `max-age=60`, moving with every mystery purchase.
  `max_qty` stays, because §10 requires it so the stepper disables at the limit
  and it is already clamped by `bundle_config.max_qty_per_order`. The pool
membership set is one indexed read per request
(`idx_mystery_entries_product`), resolved once and passed down beside
`pricingTierContext` (§14). §15.4 case 15 adds a **differential** assertion:
capture the whole public catalogue JSON before and after a mystery purchase and
assert that no per-colour or per-option number changed.

If the owner will not accept coarse counts on pool products, then only
`reveal_stage = 'paid'` is honestly deliverable and §8.1 must say so, rather than
promising a guarantee the inventory model cannot keep. That trade is §17
decision 10.

Enforcement is **one projection function**,
`mysteryProjection(allocation, revealed, viewer)` in
`worker/lib/mysteryReveal.ts` — every mystery row is routed through it on the way
out, rather than relying on the NULL `product_id` to do the work — and **one
test** that walks every customer route above with an unrevealed order and asserts
that the drawn product's id, slug, name, image URL, colour id **and every one of
its prices** appear in none of the serialized response bodies, plus the public
catalogue differential of row 18 (§15.4, case 15). The table is the checklist;
the test is the guarantee.

**Admins always have full operational access** — and it is *rendered*, not merely
returned: `src/components/adminOrders/OrderDetailModal.tsx` shows product,
variant and colour from the first second with a "not yet revealed to the
customer" chip, and groups a bundle's components under their parent instead of
listing them as N ungrouped zero-price rows. It is the screen staff read when
packing, so an allocation that reached the API and stopped there would leave the
justification for admin access unimplemented. Case 15 asserts the admin payload
**does** carry the pick throughout, positively.

---

## 9. Eligibility and promotions — one model

One model, one subject key, one validator, in the new `worker/lib/offers.ts`:

```ts
export type OfferReason =
  | 'OFFER_INACTIVE' | 'OFFER_WINDOW_NOT_STARTED' | 'OFFER_WINDOW_EXPIRED'
  | 'MEMBERSHIP_REQUIRED' | 'PER_USER_LIMIT_REACHED' | 'GLOBAL_LIMIT_REACHED';

export interface OfferView {
  window: { id: string; starts_at: string | null; ends_at: string | null;
            required_tiers: Tier[];          // [] = public, including a guest
            offer_price_mode: string; offer_price_iqd: number | null;
            discount_percent: number | null; discount_iqd: number | null;
            plus_price_iqd: number | null;
            locked_preview: boolean; active: boolean } | null;
  limits: { max_per_user: number | null; max_global: number | null } | null;
}
export interface OfferCheck { ok: boolean; reason: OfferReason | null; required_tiers: Tier[]; locked_preview: boolean }

export function scheduleState(startsAt: string | null, endsAt: string | null, nowMs: number): ScheduleState;
export function offerEligible(status: TierStatus | null, view: OfferView | null, nowMs: number): OfferCheck;
export async function loadOffers(db: D1Database, subjects: Array<[string, string]>): Promise<Map<string, OfferView>>;
export async function offerLimitAdvice(db: D1Database, subject: [string, string], userId: string, qty: number): Promise<OfferCheck>;
export function offerRedemptionStatement(db: D1Database, subject: [string, string], userId: string, orderId: string, qty: number): D1PreparedStatement;
```

* **The subject key is `('product', productId)` for a bundle, a mystery offer AND
  an ordinary product.** That is what makes this literally one promotion model
  rather than three: a **special offer on an ordinary product** — scheduled,
  tier-gated, limited, with a countdown — is the same `offer_windows` +
  `offer_limits` pair with no new machinery. This is the strongest dividend of
  putting bundles in `products`.
* **`required_tiers` is an explicit SET, not a ladder minimum**, and this is a
  deliberate departure from `validateCoupon`. `TIER_RANK` is
  `{ free: 0, plus: 1, prime: 2, pro: 3 }`
  (`packages/pricing/src/pricing.ts:68`), so a minimum of `'plus'` would silently
  admit **PRIME** to every PLUS-exclusive offer and hand it the PLUS member
  price. The repo's own entitlements module states the opposite intent for buyer
  tiers in as many words — *"PRIME does NOT [inherit PLUS]: it is a
  delivery/priority tier for buyers"* (`worker/lib/entitlements.ts:250-258`) —
  and the mandate enumerates the configurations as a set ("public,
  PLUS-exclusive, PRO-exclusive, PLUS+PRO"), of which *PLUS+PRO but not PRIME* is
  simply unrepresentable as a linear minimum. `validateCoupon`'s precedent was
  set for discount **codes**, not for gating access to a product and its member
  price, and the mandate names "unauthorised membership pricing" as a thing to
  prevent. So:

  ```ts
  const INHERITS: Record<Tier, Tier[]> = {
    free:  ['free'],
    plus:  ['free', 'plus'],
    prime: ['free', 'prime'],          // a buyer tier, standing alone
    pro:   ['free', 'plus', 'pro'],    // PRO inherits PLUS — the mandate's rule
  };
  const tierAllowed = required.some((r) => INHERITS[status.tier].includes(r));
  ```

  `TIER_RANK` remains the only *ranking* in the tree — this is a membership
  relation, not a second ranking, and `tests/offerEligibility.test.ts` asserts
  the whole `{free, plus, prime, pro} × {no gate, plus, prime, pro, plus+pro}`
  matrix, storefront lock and purchase verdict agreeing on every cell.
* **The `exclusiveSections` benefit is ANDed only when a tier is actually
  required.** ANDing it unconditionally would make *every* offer
  paid-members-only — `benefits.exclusiveSections` requires
  `t.active && tier ∈ {plus, prime, pro}` (`worker/lib/entitlements.ts:296-297`)
  — which would lock guests out of an ungated offer entirely and destroy §10's
  headline dividend, since attaching an `offer_windows` row to an ordinary
  product purely for a schedule or a countdown would instantly make it
  subscriber-only. The rule is:

  ```ts
  offerEligible(status, view, now):
    required.length === 0
      ? true                                            // public, guests included
      : (status !== null && benefits.exclusiveSections(status) && tierAllowed)
  ```

  so `offerEligible(null, view, now)` — a signed-out visitor — is **eligible
  unless a tier is required**, and an admin restriction case still pauses gated
  offer access without cancelling a paid membership.
* **Locked but visible — and the locked payload is an ALLOW-LIST**, because the
  `display_*` block as it exists today contains `display_prime_iqd` and
  `display_pro_iqd` (`worker/routes/bundles.ts:55-64`), so "carries a price
  teaser" and "never the member price a non-member cannot get" cannot both be
  satisfied by shipping that block. A locked card carries **exactly**:

  ```
  id · product_slug · name/name_ar/name_ku · cover · required_tiers ·
  starts_at · ends_at · locked: true · availability_state ·
  display_regular_iqd            (only when locked_preview = 1)
  ```

  and **explicitly strips** `display_price_iqd`, `display_prime_iqd`,
  `display_pro_iqd`, `display_applied_tier`, `composition.*` (including
  `component_total_iqd`, `saving_percent` and `main_items[]`), every availability
  count and every offer price figure. §15.4 case 9 asserts the **stripped key
  list**, not the absence of one number.

  **And it is a property of the SUBJECT, not of `GET /api/bundles/:slug`.**
  `GET /api/products?type=bundle`, the `search` branch and
  `POST /api/products/:slug/quote` all resolve the same composition rows, and
  serializing them through `publicWithDisplayPrice` published `price_iqd`,
  `prime_price_iqd`, `pro_price_iqd`, `display_price_iqd`, `display_prime_iqd`
  and `display_pro_iqd` for a GATED offer to a viewer who may not buy it — the
  last two being the keys this section names in as many words. All three doors
  now serialize a composition row through `resolveCompositionPageWithMystery` +
  `compositionCard` / `compositionDetailBody`, the one builder
  `GET /api/bundles` already used, so a locked row comes back as `lockedCard`
  wherever it appears. The quote answers a locked viewer with `quote: null` and
  the lock: the lock IS the answer, and pricing it would be the disagreement.
  §15.4 case 9 asserts the stripped key list against **every** door. The purchase endpoints re-check and
  refuse with `MEMBERSHIP_REQUIRED`. The 200-with-a-lock convention is the
  existing one (`worker/routes/bundles.ts:74-78`), so the page renders an honest
  lock instead of an error path.
* **Limits use the coupon two-layer pattern**: read-time advice for a friendly
  refusal, a `BEFORE INSERT` trigger for the decision (§1.8).
* **Coupons stay as they are.** `coupons` / `coupon_redemptions` is a *code-entry*
  mechanism; `offer_*` is an *entity-attached* mechanism. They compose cleanly
  because the bundle price is already inside `merchandise` before the coupon
  applies (§4.5). Re-homing `coupons.tier_required` / `starts_at` / `ends_at` onto
  `offer_windows` with `subject_type = 'coupon'` is optional and not on the
  critical path.
* **PRIME is the mandate's "premium".** No fourth tier is invented (§17).

---

## 10. API surface

No new version prefix. Every route is either an existing route with a richer
payload or a new route under an existing prefix. Composition fields are additive
and optional, so a client deployed before the feature keeps working — and a
missing field means *absent*, never an assumed `false`.

### Public

| route | shape |
|---|---|
| `GET /api/bundles?kind=bundle\|mystery&search&category_id&family&featured&limit&offset` | `{ entitled, signed_in, bundles: BundleCard[] }` — **the 0034 response keys are preserved**. `BundleCard` adds `product_slug`, the `display_*` price block, `composition { component_total_iqd, saving_percent, availability_state, main_items[≤3] }`, `offer { offer_id, required_tiers, starts_at, ends_at }`, `locked`. `search` and `category_id` mirror `GET /api/products` exactly — same normalisation, same index — and `featured=1` reads the `is_featured` column §1.2 already inherits, so the storefront gets search, a category facet and a featured rail with no new machinery. A locked card is the §9 allow-list. **Coarse availability state only, no counts** |
| `GET /api/bundles/:slug` | `{ bundle: BundleDetail }` — components with names, images, variant labels, `qty_per_bundle`, `optional`, `editable`, per-component coarse state, and the allowed choices for editable ones; plus `availability`, `pricing_modes`, `offer`, `viewer_tier`. For a mystery offer: `{ mystery: { spool_qty, families[], modes[], reveal_stage, odds? } }` and **never a pool** |
| `GET /api/products?type=bundle` | the existing filter (`worker/routes/products.ts`), now returning composition products — serialized by `compositionCard`, **not** by `publicWithDisplayPrice`, so a gated row is the §9 allow-list here exactly as it is on `GET /api/bundles`. The card carries `product_slug`, which is how a grid knows to link to `/bundles/<slug>` rather than to the ordinary product renderer |
| `GET /api/products/:slug` | for a composition slug, returns the bundle payload plus `redirect: '/bundles/<slug>'`, so an old link works |

The default `GET /api/products` listing gains `AND composition = ''` so bundles do
not appear as ordinary products with no stock; `type=bundle` flips it; search
still finds them, deliberately.

### Authenticated

| route | change |
|---|---|
| `POST /api/products/:slug/quote` | accepts `bundleChoices[]` / `mysteryFamilyId` / `mysteryMode`; returns the composition block, built by `compositionDetailBody` — the same builder `GET /api/bundles/:slug` uses, so it honours the §9 lock and re-checks eligibility like every other door (§6.1). Rate-limited as `composition_quote` (§7.5). **Never draws an allocation** |
| `POST /api/cart/items` | accepts the §5.2 body; refuses with the §15 codes |
| `PATCH /api/cart/items/:id` | a `qty` above `min(max_bundles, max_qty_per_order, 99)` is **refused** with `BUNDLE_QTY_LIMIT` naming the number — never silently clamped, matching `worker/routes/cart.ts:557-563`, which refuses with `QTY_UNAVAILABLE` and "Only N left" rather than rewriting the one number the customer is touching. The composition availability exposes `max_qty` so the stepper disables at the limit, the same shape `availability.stock.max_qty` already has. A choice edit rewrites `cart_bundle_choices` and recomputes `option_id`, which may merge the line — the response says so |
| `GET /api/cart` | the grouped payload of §5.2 |
| `POST /api/orders/quote` | composition lines; `blockers[]` gains the offer reasons. **Read-only: `allocate: false`, no allocation, no reservation** |
| `POST /api/orders` | unchanged signature; the batch of §3.1 |
| `GET /api/orders/:id` | the parent item carries `bundle { … }`; a mystery item carries `mystery { revealed }` and is redacted until reveal |
| `POST /api/bundles/:productId/view` | fire-and-forget analytics counter. **Requires a session** and validates that the subject is a `products` row with `composition <> ''` before the upsert, so arbitrary rows cannot be seeded into `composition_daily_metrics`; rate-limited via `rateLimit(c, 'bundle_view', 60, 300)`. Anonymous callers fall back to an IP bucket that Iraqi carriers NAT heavily (`worker/lib/ratelimit.ts:37-42`), which would both undercount real customers and let anyone inflate the denominator of the only conversion figure the owner reads. §12 states the consequence: `views` counts **signed-in** views, is best-effort, and is never an input to a price, a limit or an eligibility decision |

### Admin — all under `/api/admin/*`, apex-only via `requireMainHost` plus `requireAdmin`

**`requireMainHost` is a host check, never a role check** (`worker/index.ts:117`),
and `requireAdmin` is attached **per router** in this codebase
(`worker/routes/bundles.ts:149`). A new mount without its own
`.use('*', requireAdmin)` is an open admin API guarded only by hostname —
exposing pool weights, eligible-stock previews and pool mutation to any signed-in
customer. Routes under `/api/admin/mystery` and `/api/admin/offers` also cannot
be served by a router mounted at `/api/admin/bundles`, so they are separate
mounts. Each is named in §16 with its mount path and each attaches its own guard:

| router export | mounted at |
|---|---|
| `adminBundlesRoutes` (`worker/routes/bundles.ts`) | `/api/admin/bundles` *(existing mount)* |
| `adminMysteryRoutes` (`worker/routes/mystery.ts`) | `/api/admin/mystery` |
| `adminOffersRoutes` (`worker/routes/offers.ts`) | `/api/admin/offers` |

`tests/adminHostGuard.test.ts` gains a table-driven case that **enumerates every
route registered under `/api/admin/*`** and asserts a non-admin session receives
403 and a merchant host receives 404 — so the guard cannot be forgotten on this
router or on the next one.

| route | purpose |
|---|---|
| `GET /api/admin/bundles?search&status&kind` | listing with `component_count`, `max_bundles`, `warnings[]` |
| `GET /api/admin/bundles/:productId` | the product doc + `bundle_config` + components + choices + `offer_windows` / `offer_limits` + a live availability and value preview |
| `POST /api/admin/bundles`, `PUT /api/admin/bundles/:productId` | one call writes the product row **and** the composition, in one batch (§11.2) |
| `POST /api/admin/bundles/:productId/duplicate` | copies doc + composition + config as a new draft with a new slug |
| `PATCH /api/admin/bundles/:productId/status` | enable / disable / archive |
| `PUT /api/admin/bundles/reorder` | `display_order` on the product rows |
| `GET /api/admin/bundles/:productId/preview` | component value, saving, `max_bundles`, blocking components, `warnings[]` |
| `GET/POST/PUT/DELETE /api/admin/mystery/pools[/:id]` | pool CRUD |
| `GET /api/admin/mystery/pools/:id/entries?page` | the entries list, **paginated and filterable** — a filament pool is product × option values × colour, so a realistic one is hundreds of rows and an unpaginated `Repeater` is unusable |
| `POST /api/admin/mystery/pools/:id/entries/generate` | **bulk generator**: takes product ids plus a weight and expands their active options and colours **on the server**, so nothing is invented in the browser and the admin does not add hundreds of rows one at a time |
| `PUT /api/admin/mystery/pools/:id/entries` | whole-set replace. Requires `expected_updated_at`; a mismatch is 409 `STALE_EDIT` echoing `current`, the idiom `worker/routes/adminProducts.ts:750-764` already uses — without it the second of two admins editing one pool silently destroys the first's work. **It never DELETEs**: an entry that disappears from the set is set `active = 0, weight = 0` (which §1.9 already defines as "excluded, kept for history"), and only genuinely new entries are INSERTed. Deleting would fail `mystery_allocations.pool_entry_id`'s foreign key the moment an entry had ever been drawn, and the admin could then never edit that pool again — a runtime violation `foreign_key_check` in `tests/migrations.test.ts` cannot catch. Returns `warnings[]` |
| `GET /api/admin/mystery/pools/:id/eligible` | the live candidate list: per-entry `available`, weight, computed probability, exclusion reason, and the distinct-choice count that §7.5 keeps out of every customer refusal |
| `GET/POST/PUT /api/admin/offers` | `offer_windows` (schedule, `required_tiers`, the offer price) + `offer_limits` for any subject |
| `GET /api/admin/analytics/bundles`, `GET /api/admin/analytics/mystery` | §12 |

Every admin write calls `audit(db, admin.id, 'bundle.create|bundle.update|bundle.archive|mystery.pool.update|offer.update', id, detail)` after its batch — **except** every write that changes odds or disclosure, which uses `auditStatements` (`worker/lib/audit.ts:49-60`) **inside** the mutation's own batch, with before and after values in the detail: a pool, an entry, a weight, `duplicate_policy`, `reveal_stage`, and an offer price or tier gate. Auditing an odds change *after* its batch means a crash between the two leaves an unaudited change to the table that decides who gets the expensive filament.

---

## 11. Admin

### 11.1 Panels

Four tabs are added to `src/pages/Admin.tsx`: a value in the `AdminTab` union, a
`React.lazy` import, a `sidebarItems` row, a render line, and a chunk name in
`tests/bundleBudget.test.ts`.

1. **`bundles`** — replaces today's `src/components/AdminBundles.tsx`, rebuilt as
   `src/components/adminBundles/AdminBundles.tsx` on the `.ap` token system
   (`src/components/adminProducts/theme.css` + `theme.ts`), modelled on
   `src/components/adminTaxonomy/AdminTaxonomy.tsx` (roving-tabindex tablist,
   topbar breadcrumb portal, sequence-guarded reload, `Notice` result line).
   **The default export path and the chunk name stay `AdminBundles`**, because
   `tests/bundleBudget.test.ts` already pins that name.
2. **`mystery`** — offers list and the offer editor: spool quantity, mode
   switches, pools, duplicate policy, reveal milestone, family narrowing,
   `show_odds`.
3. **`mystery_pools`** — pools and entries with weights, active flags, live
   available counts, the distinct-choice count and the eligible-stock preview.
   The entries list is **paginated and filterable**, and rows are added with the
   server-side bulk generator (§10), never one at a time through a `Repeater`: a
   filament pool is product × option values × colour, so a realistic one is
   hundreds of rows. The whole-set save sends `expected_updated_at` and shows the
   409 `STALE_EDIT` body verbatim rather than overwriting another admin's work,
   and entries that leave the set are deactivated, not deleted
   (`POOL_ENTRY_DEACTIVATED`).
4. **`offers`** — windows, tiers and limits for any subject; the existing coupon
   panel gets a link to it.

Editor sections use the existing form primitives in
`src/components/adminProducts/form/formUi.tsx`: `SectionCard`, `Grid`, `Field`,
`TextInput`, `TextArea`, `Select`, `Money` (null ≠ 0), `Percent`, `Qty`,
`Toggle`, `CheckCard`, `Repeater`, `Banner`, `ImgSlot`, plus `TriText` from
`src/components/adminProducts/ui.tsx` for the ar/en/ckb triple.

### 11.2 The save is one plan, one batch

```ts
const plan = await planProductSave(db, intent);              // THE only product writer
const comp = await planBundleComposition(db, plan.productId, body.composition);
if (comp.errors.length) throw badRequest('…', 'BUNDLE_VALIDATION', { errors: comp.errors });
plan.statements.push(...comp.statements, ...offerStatements(db, subject, body.offer));
const out = await saveProductAtomic(db, plan);               // one db.batch
const stored = await reloadForVerification(db, plan.productId);
const mismatches = verifyApplied(plan, stored);
```

`ProductSavePlan.statements` is a plain array, so appending to it before
`saveProductAtomic` keeps the single-writer contract of
`docs/TXT_IMPORT_PARITY.md` §5.1 **exactly**: the composition rides the product's
own transaction and there is no second product write path. This is the single
most important integration decision in the design.

### 11.3 Warnings — verbatim, trilingual, never repaired

Every save and every preview returns

```ts
warnings: Array<{ code: string; message: string; key?: string; line?: number;
                  ar: string; en: string; ckb: string;
                  component_id?: string; entry_id?: string }>
```

and refusals arrive as `{ success: false, code: 'BUNDLE_VALIDATION', errors: [...] }`
with entries of the **same shape**. The `message` field is not decoration — it is
what makes both existing decoders work unmodified, and without it the three
warnings the mandate quotes word for word would never reach the admin at all:

* `refusalIssues` (`src/components/adminProducts/applyResult.ts:166-174`) renders
  `` `${t.line}${t.key}${t.message}` ``, so an object with no `message` prints the
  literal string **"undefined"**;
* `strList` (`:49`) filters a list down to `typeof x === 'string'`, so an
  object-shaped `warnings[]` on the success path becomes an **empty list**;
* `ProductForm.tsx:580` joins warnings with `' · '`, producing
  **"[object Object]"**.

So `message` carries the sentence in the admin shell's own language (English on
the current shell), `ar`/`en`/`ckb` carry all three for the `Banner` and for any
future language switch, and the panel's bilingual label primitive
`L({ ar, en })` (`src/components/adminProducts/ui.tsx:32`) is used only for
static labels, never for these server sentences. Warnings render as
`Banner kind="warn"` and are **kept visible after a successful save** (the
`ProductForm.tsx` pattern). `tests/adminBundlesRoutes.test.ts` pins it:
`refusalIssues(body)` contains no `'undefined'`, and the success-path `warnings`
survive `strList`.

| code | meaning |
|---|---|
| `NO_ELIGIBLE_DIRECT_INVENTORY` | "no eligible direct-sale inventory in this pool" |
| `COMPONENT_SHORT` | "the bundle needs 2 units of X but only 1 is available" |
| `POOL_ZERO_WEIGHT` | "3 pool entries have weight 0 and can never be drawn" |
| `POOL_EMPTY` | "this pool has no eligible entry right now" |
| `POOL_TOO_SMALL_FOR_FORBID` | "duplicates are forbidden but only 2 distinct choices exist for 3 spools" |
| `PRICE_ABOVE_COMPONENTS` | "this bundle costs more than buying the parts" |
| `MIGRATED_NEEDS_PRICE` | "this bundle was a display list with no price — set one before publishing" |
| `DERIVED_PRICE_DRIFT` | "the stored product price no longer matches the derived bundle price" — about the sort/search key only; the card and the door already quote the derived figure (§4.3) |
| `DERIVED_PRICE_BELOW_FLOOR` | "the derived price has fallen below the minimum price — this bundle is not being sold" |
| `POOL_ENTRY_DEACTIVATED` | "4 entries left the set and were deactivated rather than deleted, because they have been drawn before" |
| `COMPONENT_PRODUCT_INACTIVE` | a member product is draft or hidden |
| **refusals** | `BUNDLE_SHIPPING_MIXED`, `MEMBER_LADDER_INVERTED`, `SCHEDULE_INVERTED`, `COMPONENT_SELECTION_INVALID`, `BUNDLE_NESTING_NOT_ALLOWED`, `BUNDLE_DISCOUNT_EXCEEDS_TOTAL`, `OFFER_PRICE_CONFLICT`, `COMPOSITION_TOO_LARGE`, `STALE_EDIT` |

The **preview** — component value, saving, `max_bundles`, the blocking component,
per-entry probability — is computed **server-side by the same
`bundleComposition.ts` functions the storefront uses**, so admin and shop can
never disagree. Nothing is computed in the panel.

`archive` replaces `delete` once any order names the bundle, with the count in the
response — the `adminTaxonomy` deactivate-when-in-use idiom.

### 11.4 Financial scope

Component **cost** and margin go through `projectForAdmin`
(`worker/lib/adminScope.ts:82`); a pool weight, a probability and an availability
count are operational, not financial, and stay visible to an assistant admin.

---

## 12. Analytics

**Derived wherever possible; counted only where nothing records the fact.**

`composition_daily_metrics` counts the three things no table records:
`views` (signed-in views of the detail route only, never the listing — §10),
`adds` (on a successful add-to-cart), `oos_blocks` (when availability refuses a
purchase). **`views` is best-effort and is never an input to a price, a limit or
an eligibility decision**; it is the denominator of a conversion figure and
nothing else, and the conversion figure is labelled as being over signed-in
views. Written with
one `INSERT … ON CONFLICT(day, subject_id) DO UPDATE SET …` — an aggregate upsert
with **no user id, no order id, no address**. This mirrors the deliberate choice
that add-to-cart analytics are best-effort and not five D1 writes per tap.

Everything else is a query:

| question | source |
|---|---|
| purchases, units, revenue | parent `order_items` (`bundle_parent_item_id IS NULL`) joined to `orders` in the stock-deducted states |
| savings delivered | `SUM(json_extract(pricing_snapshot, '$.composition.bundle_discount_iqd'))` on parent rows |
| best bundles | the same, grouped by `product_id`, ordered by revenue |
| conversion | purchases ÷ `composition_daily_metrics.views`, labelled **over signed-in views** |
| component shortages | `bundleAvailability().blocking[]` recorded on a refused purchase, plus a live pass over active bundles |
| mystery direct vs pre-order, pool usage, product and colour allocation counts | the `mystery_allocation_stats` view |
| out-of-stock attempts | `composition_daily_metrics.oos_blocks` |

`mystery_allocation_stats` exposes only `(day, pool_id, pool_entry_id,
product_id, color_id, sale_mode, n)` — **no order id, no user id** — so an admin
can see how weights and inventory shape allocations without touching customer
data. A pool entry with weight 10 and zero allocations is immediately visible as
a stock problem.

---

## 13. Storefront

### 13.1 Routes

`src/pages/Bundles.tsx` moves from its **eager** import in `src/App.tsx` into the
`React.lazy` block (which *reduces* the entry chunk), and `/bundles/:slug` is
added beside `/bundles` in the **second** `<Routes>` block — the one with
`Header` and `BottomNav`. A mystery offer uses the same two routes with a
`?kind=mystery` filter; `/product/:slug` for a composition slug redirects to
`/bundles/:slug`. Because the detail page uses the product page's sticky bottom
purchase bar, `/bundles/` joins the `isBottomNavHidden` list in
`src/components/BottomNav.tsx`.

The page itself is **not one wall of cards**. It carries, above the grid: a
featured rail driven by `is_featured` (the `useRail` + `SectionHeader` vocabulary
below), a search box and a category facet bound to the `search` / `category_id`
parameters of §10, and the filter-chip row from `src/pages/Products.tsx` for
`kind` (bundles / mystery), availability and membership-exclusive. Those are the
mandate's "page, featured, categories, filters, search" — all reusing existing
components and existing query shapes, none of them new machinery. A shop with
forty bundles must not be an offset-paginated wall.

**Not on merchant subdomains.** `StorefrontApp` gains no bundle routes — LEVONIS
bundles inside someone else's shop is exactly what
`tests/storefrontIsolation.test.ts` guards against.

### 13.2 Components — existing vocabulary wherever one exists

| need | reuse |
|---|---|
| card surface | `bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden`, `aspect-square`, two-line clamped name, price at `mt-auto` (`src/components/home/ProductCard.tsx`) |
| price | `src/components/CardPrice.tsx` — a bundle *is* an `ApiProduct` with `display_*` fields, so the whole rung/teaser/struck logic is inherited. **One value is added**: `display_applied_tier` gains `'plus'` (§4.4) and the component gains that branch, because otherwise a PLUS member is shown the regular price on every card and charged the PLUS price at the door. Emitted for composition rows only |
| the bundle's original total and savings | **new** `src/components/bundles/BundleSavingLine.tsx` — `CardPrice` provably cannot render these: its `struck` is `display_regular_iqd`, the bundle's *own* regular price, not `component_total_iqd`. This one-line component renders the struck component total and the `OfferBadge` savings percentage from the server's `composition` block, beside `CardPrice` |
| savings badge | the SALE badge from `ProductCard.tsx`, promoted to `src/components/ui/OfferBadge.tsx` and used by both, retiring the second style in `src/pages/Products.tsx`. Its `tracking-wide` becomes **conditional on latin content**: harmless on "SALE", it violates §13.3's own no-letter-spacing rule the moment the same badge reads «وفّر ٢٤٪» |
| grid | `grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4` (`src/pages/Products.tsx`) |
| home shelf | `useRail()` + `SectionHeader` + `AnimatedItem`. Registering it in `src/pages/Home.tsx`'s ordered list is **not enough**: `orderOf` / `sectionVisible` read `settings.homeSections`, which `mergeSections` builds from the hard-coded `INITIAL_SECTIONS` list and `SECTION_ICONS` map in `src/components/AdminHomeSettings.tsx:85-102`. A section id absent from those gets `orderOf = Number.MAX_SAFE_INTEGER` (pinned to the bottom for ever), `sectionVisible = true` (impossible to hide) and no row in the admin's drag-to-reorder list. So the same slice adds `{ id: 'bundles', titleEn, titleAr, isVisible: true }` to `INITIAL_SECTIONS` and an icon to `SECTION_ICONS`, and `src/components/AdminHomeSettings.tsx` is in §16 |
| detail page | `src/pages/Product.tsx` as the template: `priceIsAuthoritative`, `canBuy`, `reasonText`, the emerald/amber/red mode chips, `Section`, the 220 ms debounced quote |
| images | `src/components/ui/SafeImage.tsx`, always |
| async states | `src/components/ui/AsyncStates.tsx` — `ErrorState` / `EmptyState` / `UnauthorizedState`, replacing the hand-rolled spinner and error div in today's `Bundles.tsx` |
| skeletons | new `BundleCardSkeleton` / `BundleGridSkeleton` / `BundleDetailSkeleton` **inside** `src/components/ui/Skeleton.tsx` |
| cart expandable contents | the extended-warranty disclosure in `src/pages/Cart.tsx`: a `min-h-[36px]` button with `aria-expanded` / `aria-controls`, `AnimatePresence` height 0→auto on `m.spring('quick')`, cross-fade under reduced motion |
| locked membership card | today's lock panel in `src/pages/Bundles.tsx` + `TIER_META` / `tierLabel` from `src/components/subscription/tierMeta.ts`; `useSignInPrompt()` from `src/lib/guest.ts` for guests |
| countdown | **new** `src/components/ui/Countdown.tsx` — one shared 1 Hz ticker for a whole grid (never one `setInterval` per card), takes an absolute server ISO timestamp, `tabular-nums`, plural forms via `daysLeftLabel` in `src/components/orders/format.ts`. **Decoration only** — the API still refuses an expired offer. Three details the first draft left open: **at zero** it fires the page's existing `useFreshOnReturn` revalidate **once** and re-renders from the server's new state (otherwise an `upcoming` offer keeps showing a lock past its start and an `ending soon` one counts into negative time — the single most visible moment of a limited offer), and renders an em dash rather than a negative value in the gap; the anonymous listing is cached 60 s (§14) so the state can be a minute stale at exactly that boundary and the revalidate is what closes it; and under `useMotion().reduced` the **digits keep updating at 1 Hz** and only the transition is dropped (`m.spring()` already collapses to a cross-fade) — `prefers-reduced-motion` governs animation, not live data, and freezing the clock would show those users a stale time presented as current. The coarse `daysLeftLabel` text, which needs no tick at all, is the fallback |
| the clock's direction | the digits are wrapped in `<bdi dir="ltr">` — an `HH:MM:SS` string inside an Arabic or Sorani paragraph is bidi-reordered around its colons, which is why the codebase already puts `dir="ltr"` on every product name (`Bundles.tsx`, `ProductCard.tsx`, `Cart.tsx`) |
| mystery reveal | new `src/components/offers/MysteryReveal.tsx` — pre-reveal: offer cover, "your selection is confirmed", and the milestone rendered from a server-sent **`reveal_stage_label`** computed by the existing `stageLabel(stage, shipping_type, lang)` (`worker/routes/orders.ts:1807-1831`) and shipped beside `reveal_stage`. A second client-side five-stages-by-three-languages table would drift from `OrderTracker` on the very same screen and would re-encode §8.1's `'preparing' → supplier_preparing` mapping a second time. Post-reveal: product image, name, material, variant, colour from the allocation snapshot |

### 13.3 States a card must express

`in stock` · `low` · `sold out` · `upcoming` (with a countdown to open) ·
`ending soon` (with a countdown to close) · `membership-exclusive (locked)` ·
`membership-exclusive (yours)` · `pre-order`. Each is a **server-sent** string
plus the existing chip palette; the browser classifies nothing. All eight are
produced by `bundleAvailability`'s `CompositionState` union (§2.1) — including
`low`, which has an explicit rule there rather than a threshold invented in the
panel — so the card, the detail page, the cart and the door cannot disagree.

Product, option and colour **names stay English in every language** — and are
rendered with `dir="ltr"`, as every other product name in the app is, or a latin
name and its `×2` suffix are bidi-reordered inside an Arabic panel. The bundle's
own title is owner-authored ar/en/ckb via `name` / `name_ar` / `name_ku`.

**The cart line says how many AND when.** A mystery line carries
`composition.mystery.reveal_stage_label`, rendered by the server's own
`stageLabel` — never a second stage table in the browser — so the one screen
where the customer is committing to a purchase whose contents are hidden is not
the screen that tells them the least about it.

**The countdown's day part is `daysLeftLabel(days, lang)`, not `Nd`.** A latin
unit suffix inside «يبدأ خلال …» is exactly the mixed-script sentence §13.3
forbids; the clock stays isolated in its `<bdi dir="ltr">`. Page
copy lives in a page-local `STRINGS = {ar, en, ckb}` const, **not** in
`src/translations.ts` (which every visitor downloads as `vendor-i18n`). No
`letter-spacing` on Arabic text.

---

## 14. Performance

* **Payloads.** The listing ships, per bundle: id, slug, the three names, cover,
  the `display_*` prices, `component_total_iqd`, `saving_percent`, a **coarse**
  `availability_state`, the tier badge and up to **three** main included items
  (name + thumbnail). Never the full component list, never per-component stock,
  never a pool, never a weight, never a seed. Detail is fetched on demand.
* **N+1.** Four batched reads serve a whole bundles page: (1) the composition
  products, (2) `bundle_components WHERE bundle_product_id IN (…)`, (3)
  `products WHERE id IN (…distinct members)`, (4) one `loadRelationsViews` over
  those members (itself six queries for N products). For 24 bundles × 12
  components that is 4 round trips, not 288. The same pass feeds the cart's
  grouped read, folded into the `loadRelationsViews` call already there.
* **The candidate query is one query per pool per checkout**, never per spool.
* **Write-batch size is bounded, not merely discussed.** §3.1 caps physical lines
  per order at `MAX_PHYSICAL_LINES`, caps `spool_qty × max_qty_per_order` at offer
  save, chunks every `IN (…)` list this feature adds, and replaces
  `planInventory`'s per-move sequential pre-check `SELECT` with one batched read
  — the difference between a linear-latency hot path and a constant one, and
  between an opaque D1 parameter-limit error and a `CONFLICT_RETRY`.
* **The mystery pool-membership set is one indexed read per request**
  (`idx_mystery_entries_product`), resolved once and passed down beside
  `pricingTierContext`, so §8.2 row 18's coarse-availability rule costs one query
  per request, not one per product.
* **`getTierStatus` is per-request, never per-row** — it performs two writes per
  call. One `pricingTierContext` result is resolved once and passed down, exactly
  as today's `worker/routes/bundles.ts` does.
* **Indexes.** `idx_products_composition`, `idx_bundle_components_bundle`,
  `idx_bundle_components_member`, `idx_order_items_bundle_parent`,
  `idx_mystery_entries_pool`, `idx_mystery_entries_product`,
  `idx_mystery_alloc_order`, `idx_mystery_alloc_product`,
  `idx_mystery_alloc_entry`, `idx_offer_redemptions_user`,
  `idx_offer_redemptions_subject`.
* **Caching, and the cookie hazard.** No server-side availability cache (§2.3).
  `GET /api/bundles` is edge-cacheable for **anonymous** viewers only. The
  session is a cookie scoped to `.levonis-iq.com` (`worker/index.ts:96`,
  `worker/lib/http.ts:54,121`), so it rides **every** request to this route —
  which means "keyed without a cookie" alone would have members and strangers
  share one entry, and whichever body landed there first would be served to the
  other: an entitled member's tier prices and unlocked composition to anonymous
  visitors, or the locked anonymous body to members. The rule is explicit:
  **read the session first; never write the shared cache when a session cookie is
  present; `Vary: Cookie` on the public variant; `private, no-store` otherwise**
  (`max-age=60` on the public one). A test asserts that a request carrying a
  session cookie never receives a response with `Cache-Control: public`.
  Client-side, the existing `useFreshOnReturn` revalidation and its
  "the price moved" note already cover a stale tab, and the countdown's
  zero-crossing triggers one (§13.2).
* **Bundle budget.** `Bundles` becomes lazy; `BundleDetail`, `AdminBundles`,
  `AdminMystery`, `AdminMysteryPools` and `AdminOffers` each get their own chunk
  and are added to `tests/bundleBudget.test.ts`. Entry ≤ 350 KB gzip, any chunk
  ≤ 250 KB, static closure ≤ 470 KB, CSS ≤ 60 KB.
* **Mobile Safari.** One shared countdown tick per page; no per-card timers; no
  per-component `IntersectionObserver`; the detail page is one request.

---

## 15. Security

### 15.1 The rules

1. **Nothing that costs money, grants access or decides a random outcome is read
   from the browser.** Price, discount, saving, component total, stock,
   membership tier, composition, pool, weight, seed and the drawn filament are all
   server-computed. A client-sent field of any of those names is *ignored*, not
   echoed.
2. **The order, its money and its stock commit or roll back together** — one
   `db.batch`, §3.1. There is no post-response write.
3. **Reservation is all-or-nothing**, three-layered: plan-time rejection,
   in-statement guards, and `order_reservation_fence`.
4. **Idempotency is layered**: `orders.idempotency_key UNIQUE` +
   `inventory_ledger.idempotency_key UNIQUE` +
   `offer_redemptions UNIQUE (subject_type, subject_id, order_id)` +
   `mystery_allocations PRIMARY KEY (order_item_id, spool_index)`. A double tap, a
   network retry, a refresh, a webhook retry and two concurrent checkouts all land
   on exactly one order and exactly one set of ledger rows.
5. **Limits are the database's decision**, not the route's — the `BEFORE INSERT`
   trigger of §1.8.
6. **Eligibility is server-side at every door**: the list may show a locked card,
   but add-to-cart, the quote and `POST /api/orders` each re-check independently.
7. **Cost never crosses a public boundary** at any level — `cost_iqd` is stripped
   before `pricing_snapshot` is persisted, and `projectForAdmin` strips it for an
   assistant admin.
8. **The pre-reveal pick never leaves the server** in any customer payload,
   image URL, R2 key, analytics event or notification (§8.2), and the mystery
   `order_items.product_id = NULL` makes most of that structural rather than
   procedural.
9. **The RNG seed is server-held** and derived from a secret in
   `mystery_offer_secrets` — a table no read route joins — plus a server-written
   `cart_items.draw_salt`. **No value the client chooses is an input**, the
   checkout idempotency key least of all. And **no refusal path may name, price
   or hint at the drawn item**: not a 400 body, not `blockers[]`, not a message.
   A deterministic seed plus any oracle is a grinder, so the absence of the
   oracle is part of the guarantee, not an accident of the current wording.
   `MYSTERY_NOT_ENOUGH_VARIETY` therefore carries no count (§7.5), and the
   composition quote and add-to-cart paths are rate-limited per user. The
   residual, accepted bound: a determined caller can still learn *whether* a
   configuration is currently satisfiable, which is unavoidable for any honest
   sold-out state.
10. **Admin surfaces are apex-host-only** (`requireMainHost` on `/api/admin/*`,
    a **host** check and never a role check) **and** `requireAdmin` attached
    inside every new router — enumerated and asserted route by route (§10).
    Every mutation writes an `audit` row, and every write that changes odds or
    disclosure writes it *inside* the same batch via `auditStatements`.
11. **No configuration is silently repaired.** An invalid bundle or pool is
    refused or warned, verbatim, in three languages.
12. **`worker/lib/productPersistence.ts` stays the only writer of the product
    tables.** The composition rides its plan (§11.2).

### 15.2 The invariant with a test attached

**No stock or reserved column exists outside `products`,
`product_option_values`, `product_colors`, `product_variants`.** A static test
reads migrations 0058-0062 and fails if any of them adds a column named `stock`,
`stock_reserved`, `reserved`, `available` or `quantity` to a `bundle_*`,
`mystery_*`, `offer_*` or `cart_bundle_*` table, and asserts every composition
column is a foreign key into the real catalogue. It also asserts that no file
outside `worker/lib/mysteryDraw.ts` references `mystery_offer_secrets`, and that
`cart_items` gained only `draw_salt` — no column inside the
`UNIQUE (user_id, product_id, community_product_id, option_id, color_id,
shipping_method_id)` tuple, so `idx_cart_levonis_line` is never rebuilt.

### 15.3 Refusal codes

**New codes.** Composition:

| code | HTTP | when |
|---|---|---|
| `BUNDLE_VALIDATION` | 400 | admin save refused; `details.errors[]` carries the row-level lines |
| `BUNDLE_SHIPPING_MIXED` | 400 | required components resolve to more than one shipping type |
| `BUNDLE_NESTING_NOT_ALLOWED` | 400 | a component names another composition product |
| `BUNDLE_CHOICE_INVALID` | 400 | a submitted choice is not on the component's allow-list, or fails `validateSelection` |
| `BUNDLE_CHOICE_NOT_ALLOWED` | 400 | a choice was submitted for a component the admin pinned |
| `BUNDLE_QTY_LIMIT` | 400 | `qty > bundle_config.max_qty_per_order` |
| `BUNDLE_COMPOSITION_CHANGED` | 400 | a stored cart choice no longer matches the bundle |
| `BUNDLE_PARTIAL_RETURN_NOT_ALLOWED` | 400 | v1 policy: return the whole bundle |
| `BUNDLE_OPTIONAL_UNAVAILABLE` | 400 | an optional component the buyer opted into cannot be satisfied — never a silent drop (§2.2) |
| `BUNDLE_DISCOUNT_EXCEEDS_TOTAL` | 400 | admin save: `discount_iqd >= the component total` |
| `OFFER_PRICE_CONFLICT` | 400 | admin save: a window price and a non-`fixed` `bundle_config.price_mode` on one subject |
| `OFFER_PRICE_BELOW_FLOOR` | 400 | admin save: `offer_price_mode='fixed'` with `offer_price_iqd < 1` — one typed zero too many must not publish a free offer (§4.3). Admin-facing, so it carries no customer string |
| `COMPOSITION_MAX_REQUIRED` | — | not an HTTP code: `saleAvailability`'s fail-closed reason when a composition row reaches it with no `compositionMax` (§2.4) |
| `COMPOSITION_TOO_LARGE` | 400 | physical lines per order above `MAX_PHYSICAL_LINES` (§3.1) |
| `COMPOSITION_NOT_ELIGIBLE` | 400 | a price-protection claim on a bundle parent or a mystery line (§6.4) |
| `MYSTERY_REVEALED_NO_CANCEL` | 400 | customer self-cancellation of an order whose mystery line is already revealed (§7.3) |
| `COMPOSITION_PRODUCT` | 409 | the product admin route refuses to edit a composition row; the body links to the bundles panel |
| `COMPOSITION_NOT_ALLOWED` | 400 | the TXT template or the CSV importer tried to create or edit a composition product |

Offers and eligibility:

| code | HTTP | when |
|---|---|---|
| `OFFER_INACTIVE` | 400 | `offer_windows.active = 0` or the product is not `active` |
| `OFFER_WINDOW_NOT_STARTED` | 400 | `now < starts_at` |
| `OFFER_WINDOW_EXPIRED` | 400 | `now > ends_at` |
| `MEMBERSHIP_REQUIRED` | 403 | `required_tiers` is non-empty and the viewer's tier is not in it (or is gated by `exclusiveSections`) |
| `PER_USER_LIMIT_REACHED` | 400 | mapped from the trigger's `OFFER_PER_USER_LIMIT` |
| `GLOBAL_LIMIT_REACHED` | 400 | mapped from the trigger's `OFFER_GLOBAL_LIMIT` |

> `OFFER_WINDOW_*` rather than `OFFER_EXPIRED` deliberately: `OFFER_EXPIRED` is
> already taken by the printer farm (`worker/routes/farm.ts`) and is translated in
> `src/pages/farm/strings.ts`. Two meanings behind one code would break the
> client's error map.

Mystery:

| code | HTTP | when |
|---|---|---|
| `MYSTERY_NO_ELIGIBLE_STOCK` | 503 | the candidate list is empty — an honest sold-out, never invented inventory |
| `MYSTERY_NOT_ENOUGH_VARIETY` | 400 | `duplicate_policy='forbid'` and the wheel empties before every spool is drawn |
| `MYSTERY_MODE_NOT_AVAILABLE` | 400 | the requested direct/pre-order mode is disabled or has no pool |
| `MYSTERY_NOT_REVEALED` | 400 | a return or a price-protection claim was attempted before the reveal milestone |

**Every customer-facing code is translated, and a test proves it.** `HttpError`
carries one untranslated sentence (`worker/lib/http.ts:20-28`); the cart renders
`err.message` verbatim (`src/pages/Cart.tsx:359, 482, 605`) and the product page
maps a code through `reasonText`, whose fallback is `map[code] || code`
(`src/pages/Product.tsx:101-113, 413-417`) — so an unmapped code is printed to
the customer as the literal string `MYSTERY_NO_ELIGIBLE_STOCK`. The
customer-facing subset of the tables above —
`MEMBERSHIP_REQUIRED`, `OFFER_INACTIVE`, `OFFER_WINDOW_NOT_STARTED`,
`OFFER_WINDOW_EXPIRED`, `PER_USER_LIMIT_REACHED`, `GLOBAL_LIMIT_REACHED`,
`BUNDLE_QTY_LIMIT`, `BUNDLE_CHOICE_INVALID`, `BUNDLE_CHOICE_NOT_ALLOWED`,
`BUNDLE_COMPOSITION_CHANGED`, `BUNDLE_OPTIONAL_UNAVAILABLE`,
`BUNDLE_PARTIAL_RETURN_NOT_ALLOWED`, `COMPOSITION_TOO_LARGE`,
`COMPOSITION_NOT_ELIGIBLE`, `MYSTERY_NO_ELIGIBLE_STOCK`,
`MYSTERY_NOT_ENOUGH_VARIETY`, `MYSTERY_MODE_NOT_AVAILABLE`,
`MYSTERY_NOT_REVEALED`, `MYSTERY_REVEALED_NO_CANCEL` — gets an `ar`/`en`/`ckb`
entry in `src/pages/Product.tsx`'s `STRINGS`, the cart's strings and each new
page's page-local `STRINGS`, in the slice that introduces it. **A static test
walks this table and fails if any customer-facing code lacks all three
languages** — the repo already uses that style of check elsewhere. This table is
the checklist.

**Reused codes, unchanged in meaning**: `VALIDATION`, `OUT_OF_STOCK`,
`QTY_UNAVAILABLE`, `VARIANT_NOT_MODELLED`, `SELECTION_INCOMPLETE`,
`OPTION_REQUIRED`, `COLOR_REQUIRED`, `CONFLICT_RETRY`, `CART_SHIPPING_CONFLICT`,
`CART_SELLER_CONFLICT`, `CART_WARRANTY_CONFLICT`, `SHIPPING_NEEDS_CONFIG`,
`PAYMENT_METHOD_NOT_ALLOWED`, `STALE_EDIT`, `NOT_FOUND`, `FORBIDDEN`,
`RATE_LIMITED`.

**Trigger messages** (`RAISE(ABORT, …)`), mapped in the existing catch block of
`worker/routes/orders.ts`: `OFFER_PER_USER_LIMIT` → `PER_USER_LIMIT_REACHED`,
`OFFER_GLOBAL_LIMIT` → `GLOBAL_LIMIT_REACHED`. The fence needs **no** new branch:
its `CHECK` violation already maps to `CONFLICT_RETRY`.

**One pre-existing trap this design must not lean on.**
`orders.idempotency_key` is globally `UNIQUE`
(`migrations/0001_init.sql:156`) while both the pre-check and the replay lookup
are scoped by `user_id` (`worker/routes/orders.ts:1235-1240, 1579-1587`), so a
key already consumed by *another* account fails the batch, finds no replay for
this user, and falls through to the generic "Order could not be placed" for ever.
Any client deriving keys predictably can be denied checkout by someone who claims
them first. It is why §7.3 refuses to use that field as a seed input, and the fix
itself — `UNIQUE (user_id, idempotency_key)` in a later migration, or namespacing
the stored key as `` `${user.id}:${key}` `` — plus a distinct refusal code for
the fall-through, is §17 decision 11.

### 15.4 The seventeen mandated cases

They are enumerated, with their owning slice and test file, in
`docs/BUNDLES_MYSTERY_PLAN.md` §2. All of them run at route level against
`tests/fixtures/app.ts` (`freshDb()` applies every migration; `stubApp` builds
the real Hono app; `failingD1` injects batch failures and pre-batch concurrent
writers) over `tests/fixtures/d1.ts`'s real transactional `SqliteD1`, so `CHECK`,
`UNIQUE`, trigger and zero-row-guard behaviour executes for real. No mocks of D1
or of the routers.

---

## 16. What changes in existing files

Honest inventory. Nothing outside this list changes shape.

| file | change |
|---|---|
| `migrations/` | five new files, 0058-0062 |
| `worker/lib/inventory.ts` | `planInventory` returns `plannedLedgerRows`; its pre-check sums demand per `(scope, scope_id)` across all moves and becomes one batched read instead of a sequential `SELECT` per move; every `IN (…)` list is chunked; new export `reservationFenceStatement(db, orderId, kind, expected)` |
| `worker/routes/orders.ts` | one branch in `priceLines` (parent snapshot rungs pinned to the charged figures; component commissions summed onto the parent); the mystery pre-pass beside `loadRelationsViews`; four optional `ComputedLine` fields; four new columns on the `order_items` INSERT + a `NULL` `product_id` for a mystery spool; **one** `offer_redemptions` row per (subject, order) with `qty` summed; `mystery_allocations`, `mystery_draw_audits` and the per-kind fence appended to the batch; the per-target demand map and the `MAX_PHYSICAL_LINES` ceiling; two trigger-message branches in the catch; `computeCheckout` gains `{ allocate }`; **six** component filters — `orderPublic`, the **quote serializer**, the invoice, the receipt, the courier summary and the Telegram message; `OrderCreated.items[]` built from the persisted rows; `MYSTERY_REVEALED_NO_CANCEL` on the self-cancel route |
| `worker/routes/cart.ts` | `selectionFromCartRow` returns an **empty selection** for a composition row (§5.1), and `products.composition` joins the cart `SELECT`s so it can; the composition branch in the add path, the pre-order transport validation and `draw_salt`, `cart_bundle_choices` writes, the grouped `loadCart` payload, `BUNDLE_QTY_LIMIT` on `PATCH` |
| `worker/routes/products.ts` | `saleAvailability` gains `compositionMax` / `compositionModes`, the `'composition'` scope, the fail-closed `COMPOSITION_MAX_REQUIRED` branch and the `maxQty` clamp on **both** mode branches; `directEnabled` for a composition row stops deriving from the `'bundle'` token; `publicWithDisplayPrice` overrides the `display_*` block with the derived price and emits `display_applied_tier: 'plus'` for composition rows; exact `available` suppressed for mystery-pool members (§8.2 row 18); the default listing gains `AND composition = ''` |
| `worker/routes/bundles.ts` | re-implemented over the new model, same two exports, same response keys |
| `worker/routes/returns.ts` | the raw `UPDATE products SET stock …` becomes `applyInventory({kind:'restore'})` with its own fence row; **the refund arithmetic** — `caseGross` from `component_alloc_iqd`, scaled by `kase.qty / order_items.qty`, and the same figure fed to `reversePointsForOrder` (§6.4); price protection reads `component_value_iqd` as `originalUnit` and refuses a parent or mystery claim with `COMPOSITION_NOT_ELIGIBLE`; the bundle group is surfaced |
| `worker/lib/productPersistence.ts` | `ProductWriteIntent` gains `allowComposition`; the §1.2 pins and the composition refusals |
| `worker/lib/productModel.ts` | `composition` normalisation beside `normalizeSaleTypes` |
| `worker/lib/orderStageOps.ts` | one statement stamping `mystery_allocations.revealed_at` when the milestone is crossed; `String(r.product_id ?? '') \|\| null` in the `OrderDelivered` item map |
| `worker/lib/orderInventory.ts` | release versus restore decided **per ledger row**, not per order; `planOrderReturn` / `planOrderDeduction` carry their own fence rows |
| `worker/lib/productOverlay.ts` | `publicRelations` suppresses exact `available` at option-value and colour level for products in an active mystery pool |
| `packages/contracts` | `orderItemRef.product_id` becomes nullable; the ref gains `item_kind` |
| `worker/routes/mystery.ts`, `worker/routes/offers.ts` | **new** admin routers, each with its own `.use('*', requireAdmin)` (§10) |
| `worker/lib/invoices.ts` | components become an `included[]` list under the parent line |
| `worker/routes/adminProducts.ts` | 409 `COMPOSITION_PRODUCT` on a composition row; the listing badges it; the delete path names the bundles that use a member product |
| `worker/lib/template.ts`, `worker/routes/adminImport.ts` | refuse `COMPOSITION_NOT_ALLOWED` (the guard itself lives in `planProductSave`, so every writer inherits it) |
| `worker/index.ts` | mount `adminMysteryRoutes` at `/api/admin/mystery` and `adminOffersRoutes` at `/api/admin/offers` |
| `src/App.tsx` | `Bundles` becomes lazy; `/bundles/:slug` added |
| `src/pages/Bundles.tsx`, `src/pages/Cart.tsx`, `src/pages/OrderDetail.tsx` | the new payloads |
| `src/pages/Checkout.tsx` | the bundle renders as one line with the same expandable disclosure the cart uses; `is_printer` read from the parent line so the printer delivery note still fires |
| `src/components/adminOrders/OrderDetailModal.tsx` | components grouped under their parent; the mystery allocation shown with the "not yet revealed to the customer" chip — the screen staff read when packing |
| `src/components/CardPrice.tsx` | one added `'plus'` branch in `display_applied_tier` |
| `src/components/AdminHomeSettings.tsx` | the `bundles` row in `INITIAL_SECTIONS` and its `SECTION_ICONS` entry, so the shelf can be reordered and hidden |
| `src/lib/api.ts` | `composition` on `CartItem`, `bundle` / `mystery` on `ApiOrderItem` |
| `src/components/AdminBundles.tsx` | rebuilt at `src/components/adminBundles/AdminBundles.tsx`, same chunk name |
| `tests/bundleBudget.test.ts` | the new chunk names |

Five further files left the "not changed" side of this list during the fix pass,
and each departure is a finding rather than a convenience: `worker/routes/admin.ts`
(the deduction fence abort became an operator note rather than a 500),
`worker/lib/productModel.ts` (`projectPublic` takes the `coarse` flag, so §8.2
row 18's suppression lives in ONE projector instead of beside each caller),
`worker/lib/mysteryLine.ts` (the reveal milestone in words, from the server's own
`stageLabel`), `worker/lib/inventory.ts` (`StockMove.mystery`, so a spool's
`InventoryChanged` names no order) and `src/pages/Product.tsx` /
`src/pages/Products.tsx` (the composition redirect and the card link, without
which a bundle found by search opens the renderer that has nothing to show it).

**Not changed at all**: `packages/pricing/src/pricing.ts`,
`packages/pricing/src/shippingType.ts`, `packages/pricing/src/paymentPolicy.ts`,
`packages/shipping/src/shipping.ts`, `worker/lib/orderStages.ts`,
`worker/lib/orderCancelOps.ts`, `worker/lib/pointsOps.ts`,
`worker/lib/walletOps.ts`, `worker/lib/entitlements.ts`,
`worker/lib/deviceOps.ts`, `worker/lib/membershipOps.ts`.

Four files left this list during review, and each departure is a finding, not a
convenience: `worker/lib/orderInventory.ts` (the fence and the per-row
release/restore decision), `packages/contracts` (a nullable `product_id` the
mystery line requires), `src/components/CardPrice.tsx` (the PLUS rung, without
which the card and the door quote different prices) and
`src/components/AdminHomeSettings.tsx` (without which the home shelf can be
neither reordered nor hidden).

---

## 17. Open decisions for the owner

These are genuinely undecidable from the code. Each has a defaulted behaviour
above so nothing is blocked, and each default is reversible.

1. **A real PLUS price on products.** §4.4 gives bundles and mystery offers a
   PLUS rung. Extending it to products, options, colours and variants would touch
   the ladder, `validatePriceLadder`, the Quick Edit grid, the TXT template and
   the CSV importer. *Default: bundle/offer-scoped only.*
2. **Do migrated legacy bundles stay members-only?** 0059 preserves
   `required_tiers = ["plus","prime","pro"]`, which is exactly today's
   `exclusiveSections` gate written as a set. *Default: preserved; the admin may
   set any bundle public by emptying the set.*
3. **Partial bundle returns.** *Default: whole-bundle only in v1
   (`BUNDLE_PARTIAL_RETURN_NOT_ALLOWED`); the per-component data is stored so a
   flag can enable it later.*
4. **Does cancelling free an offer redemption slot?** Coupons do not, and for a
   **mystery** subject it must not — otherwise a buyer revealed at `'paid'` could
   self-cancel and re-roll for ever (§7.3). *Default: it does not, for every
   subject; a `state` column on `offer_redemptions` would change it for bundles
   only.*
5. **Reservation expiry.** A pending order holds its components until it is
   confirmed or cancelled; there is no TTL sweep today for any product.
   *Default: unchanged. A sweep would be a new `step` in `worker/lib/jobs.ts`.*
6. **Merchant subdomains.** *Default: composition products are platform-only;
   the merchant storefront filters `composition = ''` and `storeOrders` refuses one.*
7. **A mystery offer over devices** (printers rather than filament) would need
   device units and warranty for a NULL-`product_id` line. *Default: out of scope.*
8. **Showing odds.** *Default: `show_odds = 0`; the admin may enable it per offer.*
9. **A dedicated `cart_items.composition_key`.** The `bx_…` key rides in
   `option_id` because making a new column load-bearing means rebuilding the
   partial unique index `idx_cart_levonis_line` and the `ON CONFLICT(...)`
   upsert — the operation `migrations/0032_cart_line_identity.sql` exists
   because of. §5.1 contains the risk instead: one function derives the
   selection, it returns empty for a composition row, and a test asserts nothing
   downstream reads the key. *Default: keep `option_id`; revisit only with a
   dedicated migration and a rebuilt index.*
10. **Coarse public availability on mystery-pool products.** §8.2 row 18
    suppresses exact per-colour counts for any product in an active pool,
    because two anonymous GETs otherwise defeat every reveal milestone after
    `'paid'`. The cost is that those filaments no longer show an exact "3 left"
    to anyone. *Default: coarse. The only honest alternative is to restrict
    offers to `reveal_stage = 'paid'` and say so on the admin screen.*
11. **`orders.idempotency_key` scoping.** Globally `UNIQUE` while every lookup is
    per user, so one account can permanently deny another's checkout with a
    predictable key (§15.3). *Default: unchanged in this feature — the seed no
    longer touches it — with `UNIQUE (user_id, idempotency_key)` or a namespaced
    stored key as a small follow-up migration.*
12. **Per-component pre-order transports.** §2.2 requires one transport method
    offered by **every** pre-order component, because the platform holds one
    shipping type per cart. *Default: refuse a bundle whose pre-order components
    share no method (`BUNDLE_SHIPPING_MIXED`); per-component transports would be
    a different order model entirely.*
