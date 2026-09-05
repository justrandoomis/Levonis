# Field Mapping — Product Template v2 ↔ API ↔ Database ↔ Storefront

> **Correction, 2026-09-04.** This file said it "is generated from
> `FIELD_REGISTRY`". It is not, and never was — there is no generator
> anywhere in the repository, and the table had drifted from the registry it
> claimed to mirror. A reader trusting that sentence would take the omissions
> below for the format's real limits.
>
> The registry in `worker/lib/template.ts` is the source of truth. This page
> is a HAND-WRITTEN companion to it, and the round of 2026-09-04 added keys it
> does not yet list: `category`, `sub_category`, `template_family`, `sku`,
> `low_stock_threshold`, `direct_surcharge_iqd`, the `spec.<field_id>` family,
> `options.N.group` / `sku_part` / `low_stock_threshold`, `colors.N.option_ids`
> / `sku_part` / `stock` / `low_stock_threshold`, and
> `images.N.option_value_id` / `color_id` / `variant_id` / `width` / `height`.
> Read the registry, or an actual export, for the complete list.

`FIELD_REGISTRY` in `worker/lib/template.ts` is the single source of truth for
what the TXT template can read and write. The template pipeline is fully
deterministic — **no AI is involved at any step** (parsing, merging,
validation, export, or translation bookkeeping).

Conventions used everywhere below:

- **Money is always an integer count of Iraqi dinars (IQD).** No decimals,
  no separators, no other currency.
- **`null` means "inherit / no value"; `0` is an explicit value.** They are
  never interchangeable and no code path uses truthiness on a price.
- **`__NULL__`** in a template sets an explicit null. **`__CLEAR__`** empties
  a previously stored value on update. **An omitted key preserves the
  existing value** on update. An empty value stays an empty string.
- Per-field price inheritance resolves **color → option → product base**,
  independently for each of the four price fields (regular, PRO, compare-at,
  cost). An option/colour regular price is a rung: fixed replaces, adjust
  moves — and the difference it makes is a surcharge **every tier pays**
  (PRIME/PRO inherit it unless the row states its own; see
  `docs/PRICING.md`, "The member ladder follows the regular one").
- `*_ckb` API fields carry Iraqi Kurdish (Sorani) content and are stored in
  the legacy `*_ku` database columns. Arabic (`*_ar`) is the source language.
- `product_cost_iqd` and every `cost_iqd` are **admin-only**: they exist in
  admin/template payloads and are stripped from all public projections
  (`projectPublic` in `worker/lib/productModel.ts`).

Repeatable groups are indexed from 1 (`options.1.…`, `options.2.…`). On
update a group **merges by id** when every template item carries its `id`
(omitted subfields preserved, unmentioned items kept); if any item lacks an
id the whole group is **replaced** and the pipeline warns about it.
`<group>=__CLEAR__` deletes all items of that group. Transports merge by
`method` instead of `id`.

### Scalar fields

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `name_ar` | string | yes | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الهوية (Identity) | `name_ar` | products.name_ar | Product title (Arabic source, honest fallback for other languages) |
| `name_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الهوية (Identity) | `name_en` | products.name | Product title when locale=en |
| `name_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الهوية (Identity) | `name_ckb` | products.name_ku | Product title when locale=ckb |
| `status` | enum | no | — | not nullable; omitted = keep | draft \| active \| hidden | الهوية (Identity) | `status` | products.status | Only status='active' rows are served publicly |
| `description_ar` | text | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | الوصف (Description) | `description_ar` | products.description_ar | Description (Arabic source) |
| `description_en` | text | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | الوصف (Description) | `description_en` | products.description | Description when locale=en |
| `description_ckb` | text | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | الوصف (Description) | `description_ckb` | products.description_ku | Description when locale=ckb |
| `how_to_use` | text | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | الوصف (Description) | `how_to_use` | products.how_to_use | Usage section on the product page |
| `price_iqd` | iqd | yes | — | not nullable; omitted = keep current value | integer IQD 0..2e9 | التسعير (Pricing) | `price_iqd` | products.price_iqd | Base regular price fed to the resolver |
| `pro_price_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | التسعير (Pricing) | `pro_price_iqd` | products.pro_price_iqd | Resolver PRO price (explicit); shown to active PRO members |
| `original_price_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | التسعير (Pricing) | `original_price_iqd` | products.original_price_iqd | Compare-at strikethrough, only when above the selling price |
| `product_cost_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | التسعير (Pricing) | `product_cost_iqd` | products.product_cost_iqd | NEVER — internal cost, stripped from every public payload |
| `brand` | ref | no | — | `__NULL__`/`__CLEAR__` = no brand; omitted = keep current brand | existing slug or id (DB-resolved; unknown → needs_review) | التصنيف (Classification) | `brand_id (resolved)` | products.brand_id → brands.id | Brand name/filter |
| `catalogs` | csv | no | — | `__NULL__`/`__CLEAR__` = remove from all catalogs; omitted = keep associations | comma-separated values | التصنيف (Classification) | `catalog_ids (resolved)` | product_catalogs (product_id, catalog_id, position) | Catalog listings and navigation |
| `hashtags` | csv | no | — | empty = empty list; `__CLEAR__` = empty list; omitted = keep | comma-separated values | التصنيف (Classification) | `hashtags` | products.hashtags (JSON string[]) | Hashtag chips / search |
| `is_featured` | bool | no | — | not nullable; omitted = keep | true / false | التصنيف (Classification) | `is_featured` | products.is_featured (0/1) | Featured sections |
| `display_order` | int | no | — | not nullable; omitted = keep current value | integer -100000..100000 | التصنيف (Classification) | `display_order` | products.display_order | Sort order in listings |
| `selling_type` | enum | no | — | not nullable; omitted = keep | direct_sale \| pre_order \| bundle | البيع والمخزون (Selling & stock) | `selling_type` | products.selling_type | Direct sale vs pre-order UI (transport picker) vs bundle |
| `stock` | int | no | — | `__NULL__` = untracked; 0 is explicit, never blank; omitted = keep | integer 0..1000000 | البيع والمخزون (Selling & stock) | `stock` | products.stock | Stock badge; null = untracked |
| `payment_options` | csv | no | — | empty = empty list; `__CLEAR__` = empty list; omitted = keep | comma-separated values | البيع والمخزون (Selling & stock) | `payment_options` | products.payment_options (JSON string[]) | Allowed checkout payment methods |
| `warranty_base_months` | int | no | — | `__NULL__` = not configured (units say needs_config); omitted = keep | integer 1..240 | خطط الضمان (Warranty plans) | `warranty_base_months` | products.ops_policy.warranty_base_months (JSON) | Base coverage from delivery; a PRINTER defaults to 12 on write; an extension plan adds to it (+12 → 24, +24 → 36) and the total rides in the order snapshot |
| `serialized` | bool | no | — | not nullable; omitted = keep the stored answer | true / false | خطط الضمان (Warranty plans) | `serialized` | products.ops_policy.serialized (JSON) | One `order_item_units` row per physical device at delivery — the record the extended warranty attaches to; a PRINTER defaults to true, and a printer offering plans may not be `false` |

### Repeatable group `transports.N.*` — شحن الطلب المسبق / Pre-order transports

Stored in products.preorder_transports (JSON); served as `preorder_transports[]`. Transport choice at pre-order; commission ADDED (waived for active PRO); only active offers shown.

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `transports.N.method` | enum | yes | — | not nullable; omitted = keep | air \| sea \| land | شحن الطلب المسبق (Pre-order transports) | `preorder_transports[].method` | products.preorder_transports (JSON) | Transport choice at pre-order; commission ADDED (waived for active PRO); only active offers shown |
| `transports.N.commission_iqd` | iqd | no | — | `__NULL__` = inherit admin default; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | شحن الطلب المسبق (Pre-order transports) | `preorder_transports[].commission_iqd` | products.preorder_transports (JSON) | Transport choice at pre-order; commission ADDED (waived for active PRO); only active offers shown |
| `transports.N.active` | bool | no | — | not nullable; omitted = keep | true / false | شحن الطلب المسبق (Pre-order transports) | `preorder_transports[].active` | products.preorder_transports (JSON) | Transport choice at pre-order; commission ADDED (waived for active PRO); only active offers shown |

### Repeatable group `images.N.*` — الوسائط / Media (gallery images)

Stored in products.images (JSON); served as `media[]`. Gallery; alt text per language; primary image is the cover.

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `images.N.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الوسائط (Media) | `media[].id` | products.images (JSON) | Not shown; selection identity in cart/orders |
| `images.N.url` | string | yes | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الوسائط (Media) | `media[].url` | products.images (JSON) | Gallery; alt text per language; primary image is the cover |
| `images.N.key` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الوسائط (Media) | `media[].key` | products.images (JSON) | Gallery; alt text per language; primary image is the cover |
| `images.N.alt_ar` | string | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الوسائط (Media) | `media[].alt_ar` | products.images (JSON) | Gallery; alt text per language; primary image is the cover |
| `images.N.alt_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الوسائط (Media) | `media[].alt_en` | products.images (JSON) | Gallery; alt text per language; primary image is the cover |
| `images.N.alt_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الوسائط (Media) | `media[].alt_ckb` | products.images (JSON) | Gallery; alt text per language; primary image is the cover |
| `images.N.primary` | bool | no | — | not nullable; omitted = keep | true / false | الوسائط (Media) | `media[].primary` | products.images (JSON) | Gallery; alt text per language; primary image is the cover |
| `images.N.source_url` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الوسائط (Media) | `media[].source_url` | products.images (JSON) | Gallery; alt text per language; primary image is the cover |

### Repeatable group `options.N.*` — الخيارات / Options (variants)

Stored in products.options (JSON); served as `options[]`. Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden.

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `options.N.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الخيارات (Options) | `options[].id` | products.options (JSON) | Not shown; selection identity in cart/orders |
| `options.N.name_ar` | string | yes | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الخيارات (Options) | `options[].name_ar` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.name_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الخيارات (Options) | `options[].name_en` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.name_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الخيارات (Options) | `options[].name_ckb` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.image` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الخيارات (Options) | `options[].image` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.active` | bool | no | — | not nullable; omitted = keep | true / false | الخيارات (Options) | `options[].active` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.regular_price_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الخيارات (Options) | `options[].regular_price_iqd` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.pro_price_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الخيارات (Options) | `options[].pro_price_iqd` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.compare_at_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الخيارات (Options) | `options[].compare_at_iqd` | products.options (JSON) | Variant picker; option regular price replaces/moves the base and its surcharge reaches PRIME/PRO; inactive hidden |
| `options.N.cost_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الخيارات (Options) | `options[].cost_iqd` | products.options (JSON) | NEVER — stripped from public payloads |

### Repeatable group `colors.N.*` — الألوان / Colors

Stored in products.colors (JSON); served as `colors[]`. Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden.

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `colors.N.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الألوان (Colors) | `colors[].id` | products.colors (JSON) | Not shown; selection identity in cart/orders |
| `colors.N.name_ar` | string | yes | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الألوان (Colors) | `colors[].name_ar` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.name_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الألوان (Colors) | `colors[].name_en` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.name_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الألوان (Colors) | `colors[].name_ckb` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.hex` | hex | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | #RRGGBB or empty | الألوان (Colors) | `colors[].hex` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.image` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الألوان (Colors) | `colors[].image` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.option_id` | string | no | — | `__NULL__` = null; omitted = keep | free text (single line) | الألوان (Colors) | `colors[].option_id` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.option_index` | int | no | — | not nullable; omitted = keep current value | integer 1..999 | الألوان (Colors) | `colors[].option_index` | products.colors (JSON) | Import-only convenience, resolved to option_id before save |
| `colors.N.active` | bool | no | — | not nullable; omitted = keep | true / false | الألوان (Colors) | `colors[].active` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.regular_price_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الألوان (Colors) | `colors[].regular_price_iqd` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.pro_price_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الألوان (Colors) | `colors[].pro_price_iqd` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.compare_at_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الألوان (Colors) | `colors[].compare_at_iqd` | products.colors (JSON) | Color picker; colour regular price replaces/moves (colour → option → base) and its surcharge reaches PRIME/PRO; inactive hidden |
| `colors.N.cost_iqd` | iqd | no | — | `__NULL__` = inherit / none; 0 is explicit, never blank; omitted = keep | integer IQD 0..2e9 | الألوان (Colors) | `colors[].cost_iqd` | products.colors (JSON) | NEVER — stripped from public payloads |

### Repeatable group `spec_groups.N.*` — المواصفات / Specification groups

Stored in products.specifications (JSON); served as `spec_groups[]`. Grouped specification tables with units.

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `spec_groups.N.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].id` | products.specifications (JSON) | Not shown; selection identity in cart/orders |
| `spec_groups.N.title_ar` | string | yes | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].title_ar` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.title_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].title_en` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.title_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].title_ckb` | products.specifications (JSON) | Grouped specification tables with units |

Rows (`spec_groups.N.rows.M.*`):

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `spec_groups.N.rows.M.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].id` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.rows.M.label_ar` | string | yes | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].label_ar` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.rows.M.label_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].label_en` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.rows.M.label_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].label_ckb` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.rows.M.value_ar` | string | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].value_ar` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.rows.M.value_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].value_en` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.rows.M.value_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].value_ckb` | products.specifications (JSON) | Grouped specification tables with units |
| `spec_groups.N.rows.M.unit` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | المواصفات (Specifications) | `spec_groups[].rows[].unit` | products.specifications (JSON) | Grouped specification tables with units |

### Repeatable group `labels.N.*` — الشارات / Labels / badges

Stored in products.labels (JSON); served as `labels[]`. Badges on cards/product page; visible=false hidden.

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `labels.N.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الشارات (Labels) | `labels[].id` | products.labels (JSON) | Not shown; selection identity in cart/orders |
| `labels.N.key` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الشارات (Labels) | `labels[].key` | products.labels (JSON) | Badges on cards/product page; visible=false hidden |
| `labels.N.text_ar` | string | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الشارات (Labels) | `labels[].text_ar` | products.labels (JSON) | Badges on cards/product page; visible=false hidden |
| `labels.N.text_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الشارات (Labels) | `labels[].text_en` | products.labels (JSON) | Badges on cards/product page; visible=false hidden |
| `labels.N.text_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الشارات (Labels) | `labels[].text_ckb` | products.labels (JSON) | Badges on cards/product page; visible=false hidden |
| `labels.N.icon` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | الشارات (Labels) | `labels[].icon` | products.labels (JSON) | Badges on cards/product page; visible=false hidden |
| `labels.N.visible` | bool | no | — | not nullable; omitted = keep | true / false | الشارات (Labels) | `labels[].visible` | products.labels (JSON) | Badges on cards/product page; visible=false hidden |

### Repeatable group `warranty_plans.N.*` — خطط الضمان / Warranty plans

Stored in products.warranty_plans (JSON); served as `warranty_plans[]`. Warranty selector; fee ADDED and never waived by membership; inactive hidden.

**Extended warranty is for PRINTERS only (owner mandate).** A product not filed
under a printer catalog (`catalogs.is_printer_catalog`) is refused with
`WARRANTY_NOT_PRINTER` on every write path (admin save, TXT analyze/apply, CSV
preview/confirm) and at runtime (cart add/update, checkout). A printer's plans
must be `duration_kind=extension` with `duration_months` 12 or 24 — one plan
per duration — read as **+12 → 24 months total** and **+24 → 36 months total**
over the 12-month base (`warranty_base_months`). The fee is a **percent of the
printer's REGULAR price** (`fee_percent`, e.g. 7.5 or 10; the owner's example
range 7.5–10 is a hint the form shows, not a cap), rounded once to an integer
dinar by `worker/lib/warrantyPlans.ts planFee` and identical for a guest, a
PRIME and a PRO; `fee_iqd` is the fixed fallback for a plan with no percent.
Legacy `total`-kind plans and non-printer plans already stored keep resolving
on read; the rules bite only on write. The plan can be bought before the order
only — nothing after checkout writes `order_items.warranty_snapshot`.

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `warranty_plans.N.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | خطط الضمان (Warranty plans) | `warranty_plans[].id` | products.warranty_plans (JSON) | Not shown; selection identity in cart/orders |
| `warranty_plans.N.title_ar` | string | yes | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | خطط الضمان (Warranty plans) | `warranty_plans[].title_ar` | products.warranty_plans (JSON) | Warranty selector; fee ADDED and never waived by membership; inactive hidden |
| `warranty_plans.N.title_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | خطط الضمان (Warranty plans) | `warranty_plans[].title_en` | products.warranty_plans (JSON) | Warranty selector; fee ADDED and never waived by membership; inactive hidden |
| `warranty_plans.N.title_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | خطط الضمان (Warranty plans) | `warranty_plans[].title_ckb` | products.warranty_plans (JSON) | Warranty selector; fee ADDED and never waived by membership; inactive hidden |
| `warranty_plans.N.terms_ar` | text | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | خطط الضمان (Warranty plans) | `warranty_plans[].terms_ar` | products.warranty_plans (JSON) | Warranty selector; fee ADDED and never waived by membership; inactive hidden |
| `warranty_plans.N.terms_en` | text | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | خطط الضمان (Warranty plans) | `warranty_plans[].terms_en` | products.warranty_plans (JSON) | Warranty selector; fee ADDED and never waived by membership; inactive hidden |
| `warranty_plans.N.terms_ckb` | text | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | خطط الضمان (Warranty plans) | `warranty_plans[].terms_ckb` | products.warranty_plans (JSON) | Warranty selector; fee ADDED and never waived by membership; inactive hidden |
| `warranty_plans.N.duration_months` | int | yes | — | not nullable; omitted = keep current value | integer 1..240; **printers: 12 or 24 only** | خطط الضمان (Warranty plans) | `warranty_plans[].duration_months` | products.warranty_plans (JSON) | "+12 months → 24 total" / "+24 months → 36 total" on the product page, in the cart and on the order |
| `warranty_plans.N.duration_kind` | enum | no | — | not nullable; omitted = keep | extension \| total; **printers: extension only** (default) | خطط الضمان (Warranty plans) | `warranty_plans[].duration_kind` | products.warranty_plans (JSON) | extension = added to the base; total = legacy whole-period plan, kept readable |
| `warranty_plans.N.fee_percent` | percent | no | — | `__NULL__` = no percent (the fixed `fee_iqd` applies); omitted = keep | 0.01..100, at most two decimals (7.5, 10); `+7.5` accepted | خطط الضمان (Warranty plans) | `warranty_plans[].fee_percent` | products.warranty_plans (JSON) | Fee = round(regular price of the selection × percent / 100), tier-neutral; the resolved dinar is served per plan (`fee_iqd`) and frozen with `basis_iqd` in the order snapshot |
| `warranty_plans.N.fee_iqd` | iqd | yes | — | not nullable; omitted = keep current value | integer IQD 0..2e9 | خطط الضمان (Warranty plans) | `warranty_plans[].fee_iqd` | products.warranty_plans (JSON) | Fixed fee, charged when `fee_percent` is null; 0 = explicitly free |
| `warranty_plans.N.active` | bool | no | — | not nullable; omitted = keep | true / false | خطط الضمان (Warranty plans) | `warranty_plans[].active` | products.warranty_plans (JSON) | Warranty selector; fee ADDED and never waived by membership; inactive hidden |

### Repeatable group `content_blocks.N.*` — كتل المحتوى / Bottom-of-page content blocks

Stored in products.content_blocks (JSON); served as `content_blocks[]`. Ordered bottom-of-page rich content (text / image / video embed).

| Template key | Type | Required | Lang | Null behavior | Validation | Editor group | API field | DB storage | Storefront use |
|---|---|---|---|---|---|---|---|---|---|
| `content_blocks.N.id` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].id` | products.content_blocks (JSON) | Not shown; selection identity in cart/orders |
| `content_blocks.N.kind` | enum | yes | — | not nullable; omitted = keep | text \| image \| video_embed | كتل المحتوى (Content blocks) | `content_blocks[].kind` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.body_ar` | text | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | كتل المحتوى (Content blocks) | `content_blocks[].body_ar` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.body_en` | text | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | كتل المحتوى (Content blocks) | `content_blocks[].body_en` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.body_ckb` | text | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text, heredoc for multiline | كتل المحتوى (Content blocks) | `content_blocks[].body_ckb` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.caption_ar` | string | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].caption_ar` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.caption_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].caption_en` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.caption_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].caption_ckb` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.alt_ar` | string | no | ar | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].alt_ar` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.alt_en` | string | no | en | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].alt_en` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.alt_ckb` | string | no | ckb | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].alt_ckb` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.url` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].url` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |
| `content_blocks.N.media_key` | string | no | — | empty stays empty; `__CLEAR__` = clear; omitted = keep | free text (single line) | كتل المحتوى (Content blocks) | `content_blocks[].media_key` | products.content_blocks (JSON) | Ordered bottom-of-page rich content (text / image / video embed) |

### Protected (non-template-editable) fields

| Key | Why it is protected |
|---|---|
| `product_id` | header — present in exports; absent = create. Identifies the row to update; never invent one. |
| `expected_updated_at` | header — optional optimistic-concurrency check; apply fails with 409 STALE when the product changed since export. |
| `slug` | stable public identity — preserved on update unless allow_slug_change=true is set in the same template; free on create. |
| `allow_slug_change` | header flag (true/false) unlocking a slug change on update. |
| `doc_version` | schema version managed by the persistence layer — never editable. |
| `content_rev` | Arabic-source revision counter — bumped automatically when Arabic source text changes. |
| `translation_meta` | per-field translation status bookkeeping — derived automatically, never hand-edited. |
| `created_at / updated_at` | timestamps managed by the database. |
| `legacy.*` | v1 passthrough columns (shipping_methods, features, stores, membership_prices, …) — preserved verbatim, not template-editable. |

## Legacy (v1) → v2 upgrade notes

Rows written by the old editor are upgraded **in code at read time**
(`worker/lib/productModel.ts` adapters); nothing is truncated and writes
always persist v2 shapes with `doc_version=2`.

| Legacy shape | v2 result | Rationale |
|---|---|---|
| Option/color `price_iqd`/`pro_price_iqd`/`original_price_iqd`/`cost_iqd` of `0` or absent | `null` (inherit) | The v1 resolver ignored non-positive overrides, so a stored 0 never meant "sells for 0" — upgrading it to `null` preserves observed behavior. New explicit zeros survive as `0`. |
| Flat `specifications` `[{key, value}]` | One general group `sg_general` («المواصفات» / "Specifications") containing all rows | v1 had no grouping; the language of legacy text is unknown, so it is stored as the Arabic source with en/ckb missing. |
| `images` as `string[]` | `MediaV2[]` with generated ids, order from position, first image primary, empty alt text | Alt text did not exist in v1. |
| String labels | `LabelV2` with the string as `text_ar`, visible, no key/icon | — |
| Warranty `[{name, price_iqd}]` | `WarrantyPlanV2` with `title_ar=name`, `fee_iqd=price_iqd`, `duration_months=12`, `duration_kind='total'` | v1 had no duration; 12/total is the conservative reading and is editable afterwards. |
| Color `linked_option_ids[]` (multi-link) | `option_id` = first link | v2 links a color to at most one option. |
| `name` / `description` / `*_ku` columns | Exposed as `name_en` / `description_en` / `*_ckb` | DB column names unchanged (nondestructive migration); `ku` columns hold `ckb` (Sorani) content. |
| `membership_prices`, `shipping_methods`, `features`, `stores`, `description_images`, `description_videos`, `algorithm_tags`, `brand` (text), `categories`, `subcategory_id` | Preserved verbatim in `legacy.*` passthrough; not editable via template | The template UPDATE writes only v2 columns, so legacy columns are never clobbered. |

## Endpoints backed by this registry

All under `/api/admin/template` (admin session required, server-side check):

- `GET /blank` — commented blank template (`levonis-product-template.txt`).
- `GET /export/:productId` — deterministic full export, all languages.
- `POST /parse` — dry-run preview + field diff; never writes.
- `POST /apply` — re-parses server side; create is forced to `draft`;
  update does an optimistic stale check (`expected_updated_at`) and an
  explicit-column UPDATE that preserves legacy columns and slug stability.
- `POST /parse-zip` — ZIP of `.txt` templates, parsed independently
  per file; one bad file never fails the rest.
