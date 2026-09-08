# TXT Import Parity — لماذا يفتح المنتج المستورد فارغًا في ProductForm، وكيف يُصلَح معماريًا

> Status: **FIXED — the plan in §5 is implemented and pinned by tests.**
> Diagnosis written 2026-09-08 from four independent code reviews and 16
> executable repros (node:test over the real routes and all migrations);
> the fix landed in the same round. Nothing in this document was concluded
> from the parser succeeding — every verdict, before and after, was taken by
> reading the product back through the SAME two endpoints `ProductForm` uses
> (`GET /api/admin/products-v2/:id` and `GET /api/admin/products/:id/relations`)
> and, in the integration suite, by running the form's own client transforms
> over those answers.
>
> **How to read this document.** §2–§4 are the DIAGNOSIS, kept verbatim with
> their `file:line` references to the tree as it was: they are the record of
> what was wrong and why. The **Status column of every §2 table and the
> divergence column of §3 have been rewritten to the post-fix truth**; the
> Note column beside them still describes the old behaviour, which is what
> makes each row readable as "this is what it was, this is what it is".
> §7 lists what changed, where it lives and which test proves it.
>
> Evidence, runnable from the repository root with `npm run test:unit`:
> `tests/templateApplyParity.test.ts` (the database and the two admin
> endpoints, one test per root cause), `tests/templateParity.test.ts`
> (tests A–D of §5.5: the same journey judged after the client transforms
> `toEditorDoc` / `hydrateRelations` the admin form runs) and
> `tests/productSaveParity.test.ts` (**§8** — the second round, which reviewed
> the contract of §5 itself and found nine more defects in it).

---

## 1. الملخّص التنفيذي (بالعربية)

1. القالب النصّي (TXT) يُحلَّل بشكل صحيح: كل مفتاح في السجل يُقرأ، و`__NULL__`/`__CLEAR__`/الحذف تعمل كما هو موثّق، والمفاتيح غير المعروفة تُجمَع في `unknown_keys` مع تحذير (`worker/lib/template.ts:455-546, 716-753`).
2. العطب معماري وليس في حقل بعينه: مسار `POST /api/admin/template/apply` عند **الإنشاء** يكتب صفًّا واحدًا في `products` فقط (`worker/routes/template.ts:1341-1345`) — الخيارات والألوان والصور تُحفَظ كـ JSON داخل `products.options/colors/images` ولا يصل صفٌّ واحد إلى `product_option_groups` / `product_option_values` / `product_colors` / `product_color_option_links` / `product_images`.
3. عند **التحديث**، الكاتب العلائقي `planRelationsWrite` لا يُستدعى إلا إذا كان للمنتج صفوف علائقية مسبقًا (`hasRelationalStructure`, `worker/routes/template.ts:468-484, 1227-1228`)، فلا يمكن للملف أن يضيف **أول** خيار أو لون أو صورة لمنتج بلا صفوف — وبلا أي تحذير (`:1262-1270` يحذّر فقط عندما يكون المنتج علائقيًا أصلًا).
4. ProductForm يقرأ الخيارات والألوان والصور من `GET /products/:id/relations` **حصرًا** (`src/components/adminProducts/ProductForm.tsx:287-290`, `form/model.ts:279-360`) ولا يعرض JSON المنتج أبدًا؛ لذلك يظهر القسم 5 والقسم 6 فارغَين بينما المتجر العام يبيع نفس الخيارات عبر السقوط إلى JSON (`worker/lib/productOverlay.ts:304`).
5. المخزون: مسار TXT لا يكتب `products.inventory_mode` إطلاقًا (لا مفتاح في القالب، `relationsBodyFromDoc` لا يرسله — `worker/lib/templateRelations.ts:266`، و`PRODUCT_COLUMNS` لا يحتويه — `worker/lib/productModel.ts:1259-1267`)، فيبقى `BASE` ويصبح مخزون الخيارات/الألوان غير معتمد.
6. النصف "الوثائقي" يُحفَظ ويُقرأ بشكل صحيح: الأوصاف (ar/en/ckb)، `spec.*`، `spec_groups`، `labels`، الضمان (خطط + أشهر أساسية + serialized)، `content_blocks`، دليل الاستخدام، أنواع البيع، وسائل النقل، `direct_surcharge_iqd`، `payment_options`، `hashtags`، التصنيفات، SKU — كلها تصل إلى `products-v2` (repro A).
7. لكن النموذج لا يملك واجهة لعرض `labels` و`content_blocks` و`spec_groups` و`payment_options` و`description_ar/ckb` (لا مكوّن في `src/components/adminProducts/` يقرأها — grep يعيد `types.ts` فقط)، ويعرض `spec.*` فقط لحقول قالب القسم المختار (`ProductForm.tsx:319-343, 1196-1247`)، والضمان فقط عندما يكون القسم طابعات (`form/WarrantySection.tsx:67-82`) — فتظهر هذه الأقسام "فارغة" رغم أنها محفوظة.
8. انحرافات أخرى عن مسار النموذج: لا `price_history`، لا `registerHashtags`، لا `localizeProductDoc`/`syncProductTranslations`، بوابة الكلفة §11 لا تغطي الإنشاء ولا مرآة JSON للخيارات (`worker/routes/template.ts:1286-1293` تغطي `product_cost_iqd` عند التحديث فقط)، و`compare_at_iqd` للخيارات/الألوان يُحلَّل ثم يُهمَل (`worker/lib/productModel.ts:329-356`).
9. الإصلاح المطلوب: عقد حفظ واحد مشترك (`worker/lib/productPersistence.ts`: `normaliseProductWrite → planProductWrite → commitProductWrite` في `db.batch` واحد يشمل صف المنتج + الخيارات + الألوان + الروابط + الصور + المتغيّرات + الكتالوجات + inventory_mode) يستدعيه كلٌّ من `products-v2` + `/relations` (النموذج)، و`/template/apply`، و`/import` (CSV/ZIP)، مع تحقّق خادمي بعد الحفظ يعيد قراءة المنتج بنفس واجهات النموذج ويقارن المطلوب بالمخزّن ويُرجع عدّادات مهيكلة.
10. معيار النجاح الوحيد المقبول: اختبار يطبّق TXT ثم يقرأ عبر `GET /products-v2/:id` و`GET /products/:id/relations` ويطابق عدد المجموعات/القيم/الألوان/الروابط/الصور/المواصفات مع الملف — لا اختبار على المحلّل وحده.

---

## 2. The full mapping table

Legend for **status** (post-fix): `OK` · `OK — rows` (real rows in the relation tables, not a JSON mirror) · `OK — shown read-only` (stored, and rendered by the form as preserved) · `OK — columns (0055)` · `removed from the registry → unknown_keys` · `refused by name` · `not in template` · `protected by design`.
"Read-back" = the admin endpoints the form calls: `V2` = `GET /api/admin/products-v2/:id` (`worker/routes/adminProducts.ts:746-757`, `parseProductRow` over the `products` row only, **no overlay**), `REL` = `GET /api/admin/products/:id/relations` (`worker/routes/adminProductRelations.ts:167-204`, tables only).
Registry references are `worker/lib/template.ts` (`FIELD_REGISTRY`, lines 141-400); parser `parseTemplate` (`:548-753`); merge `toDocBody` (`:1685-1954`); bridge `relationsBodyFromDoc` (`worker/lib/templateRelations.ts:80-267`).

### 2.1 Header keys

| TXT key | Parsed field | ProductDoc field | DB column / table | ProductForm field (component · state) | Admin read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `template_version` | `header.template_version` (must be 2) | — | — | — | — | OK | Required first key; `worker/lib/template.ts:625-631`. |
| `product_id` | `header.product_id` | `doc.id` (update target) | `products.id` | `ProductForm` · `productId` prop | V2 `product.id` | OK | Absent → create; in `mode=draft` ignored with warning (`worker/routes/template.ts:1129-1131`). |
| `expected_updated_at` | `header.expected_updated_at` | — (stale check) | compared with `products.updated_at` | `ProductForm` · `loadedUpdatedAt` (`ProductForm.tsx:505`) | — | OK | 409 `STALE` (`worker/routes/template.ts:1191-1202`); form path uses `STALE_EDIT` (`adminProducts.ts:865-877`). |
| `allow_slug_change` | `header.allow_slug_change` | — | — | body `allow_slug_change` (`adminProducts.ts:881`) | — | OK | Header key, `worker/lib/template.ts:644-647`. |
| `slug` | `fields.slug` (HEADER_KEYS bypass coerce, `:412,631`) | `slug` | `products.slug` | `ProductForm` · read-only `doc.slug` | V2 `product.slug` | OK | Derived on create; preserved on update unless `allow_slug_change=true` (`worker/lib/template.ts:1760-1784`). |

### 2.2 Identity, text, status

| TXT key | Parsed field | ProductDoc field | DB column / table | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `name_ar` | `fields.name_ar` (registry `required`, `:141`) | `name_ar` | `products.name_ar` | **none** — form is English-only (`form/model.ts:15-16`) | V2 `product.name_ar` | OK — shown read-only | Stored; regenerated from `name_en` by `localizeProductDoc` on the next form save (`worker/lib/translate/localizeProduct.ts:63-66`, `adminProducts.ts:902`). |
| `name_en` | `fields.name_en` | `name_en` | `products.name` | `ProductForm` · `doc.name_en` (TextInput) | V2 `product.name_en` | OK | |
| `name_ckb` | `fields.name_ckb` | `name_ckb` | `products.name_ku` | none | V2 `product.name_ckb` | OK — shown read-only | Same as `name_ar`. |
| `status` | enum `draft\|active\|hidden` | `status` | `products.status` | `doc.status` (Select) | V2 | OK | Create forced to `draft` + warning (`worker/routes/template.ts:1324-1329`). |
| `description_ar` / `description_ckb` | text (heredoc) | `description_ar/ckb` | `products.description_ar` / `description_ku` | **none** (only `description_en` TextArea) | V2 | OK — shown read-only | Overwritten by machine translation on form save (`localizeProduct.ts:69-72`). |
| `description_en` | text | `description_en` | `products.description` | `doc.description_en` | V2 | OK | |
| `how_to_use` | text | `how_to_use` | `products.how_to_use` | `doc.how_to_use` TextArea | V2 | OK | |
| `is_featured` | bool | `is_featured` | `products.is_featured` | `doc.is_featured` Toggle | V2 | OK | `__CLEAR__`/`__NULL__` → error (`worker/lib/template.ts:466-477`). |
| `display_order` | int ±100000 | `display_order` | `products.display_order` | `doc.display_order` Qty | V2 | OK | Not nullable. |

### 2.3 Pricing

| TXT key | Parsed field | ProductDoc field | DB column | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `price_iqd` | iqd, required (`:151`) | `price_iqd` | `products.price_iqd` | `doc.price_iqd` | V2 | OK | May be rewritten to cheapest sellable when `options.*`/`colors.*` present (`normalizeCheapestBase`, `worker/routes/template.ts:661`; `worker/lib/template.ts:1465`). |
| `pro_price_iqd` / `prime_price_iqd` | iqd nullable | same | `products.pro_price_iqd` / `prime_price_iqd` | `doc.*` | V2 | OK | Ladder validated in `validateProductDoc`. |
| `original_price_iqd` | iqd nullable (`:154`) | `original_price_iqd` | `products.original_price_iqd` | **none** in form | V2 | OK — shown read-only | No input in `ProductForm`; carried by `toEditorDoc` (`types.ts:72-95`). |
| `product_cost_iqd` | iqd nullable | `product_cost_iqd` | `products.product_cost_iqd` | `doc.product_cost_iqd` (if `canSeeCost`) | V2 (stripped by `projectForAdmin`) | OK — create and update | Update: reset to stored + warning for non-financial (`worker/routes/template.ts:1286-1293`); create branch has no gate (`:1323-1366`, repro D3/F). Form path refuses with 403 (`adminProducts.ts:839-845`). |
| (price change side effect) | — | — | `price_history` | — | — | OK | TXT writes no `price_history` row; form path does (`adminProducts.ts:948`, repro D5). |

### 2.4 Classification

| TXT key | Parsed field | ProductDoc field | DB column / table | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `brand` | ref (slug or id) | `brand_id` via `resolveRefs` | `products.brand_id` | `doc.brand_id` Select | V2 | OK | Unknown → `needs_review`; `__NULL__` counted under `applied_fields` (`worker/lib/template.ts:1829-1831`) while category `__NULL__` is `cleared_fields` (`:1854-1857`) — inconsistent counters. |
| `catalogs` | csv of slugs/ids | — (`refs.catalog_ids`) | `product_catalogs` | `doc.catalog_ids` (carried, no editor) | V2 `catalog_ids` | OK — inside the one batch | Written after the product row, sequential `.run()`, failure → warning only (`worker/routes/template.ts:563-598, 1372-1381`). Form path: `syncCatalogs` (`adminProducts.ts:931`). |
| `category` / `sub_category` | ref nullable | `category_id` / `sub_category_id` | `products.category_id` / `sub_category_id` | Select of **active** roots/children (`ProductForm.tsx:346-350`) | V2 | OK | `resolveRefs` does not check `active`; an inactive catalog shows as "— اختر —". Drives spec rendering (§2.7). |
| `template_family` | enum `''\|devices\|materials` | `template_family` | `products.template_family` | read-only; **overwritten** from `/taxonomy/templates` on load (`ProductForm.tsx:333-335`) | V2 | OK — filled, never overwritten | File value is never authoritative on screen. |
| `sku` | string ≤60 | `sku` | `products.sku` | `doc.sku` | V2 | OK | |
| `hashtags` | csv | `hashtags` | `products.hashtags` JSON | hashtag chips | V2 | OK | TXT never calls `registerHashtags` (form: `adminProducts.ts:939`; repro D5). |

### 2.5 Selling, availability, inventory (product level)

| TXT key | Parsed field | ProductDoc field | DB column | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `selling_type` | enum `direct_sale\|pre_order\|bundle\|mixed` | `selling_type` + `sale_types` (`mixed` expanded, options' `availability_type` wins; `worker/lib/productModel.ts:788-810`) | `products.selling_type` (CHECK 3 values) + `products.sale_types` JSON | `doc.sale_types` CheckCards; **disabled + rewritten** when any active option declares availability (`ProductForm.tsx:431-466`) | V2 `sale_types` | OK | The option-derived re-derivation now runs on every path (create included), inside the shared contract. Still no explicit `sale_types` key: bundle + another type is not expressible in the file. |
| `stock` | int nullable | `stock` | `products.stock` | `doc.stock` Qty "مخزون المنتج" (`ProductForm.tsx:1125-1135`) | V2 + REL `product.stock` | OK | Base level only. |
| `low_stock_threshold` | int nullable | `low_stock_threshold` | `products.low_stock_threshold` | `doc.low_stock_threshold` | V2 | OK | |
| `direct_surcharge_iqd` | iqd nullable, `+N` plain (`:179`) | `direct_surcharge_iqd` | `products.direct_surcharge_iqd` | Money, rendered only if `sale_types` has `direct_sale` | V2 | OK / gated | |
| `payment_options` | csv ≤20 | `payment_options` | `products.payment_options` JSON | **none** | V2 | OK — shown read-only | No renderer (grep over `src/components/adminProducts/` hits only `types.ts`). Ids not validated. |
| `warranty_base_months` | int 1..240 nullable | `warranty_base_months` | `products.ops_policy.warranty_base_months` (JSON) | `WarrantySection` Qty — **printer sections only** (`WarrantySection.tsx:140-149`) | V2 | OK / gated | Client `isPrinter` from `category_id/sub_category_id` (`ProductForm.tsx:370-372`); server from `catalogs` list (`worker/lib/warrantyPlans.ts`). |
| `serialized` | bool | `serialized` | `products.ops_policy.serialized` | `WarrantySection` Toggle (printer only) | V2 | OK / gated | |
| — (`inventory_mode`) | — | — (not on ProductDoc) | `products.inventory_mode` | `rel.inventory_mode` derived by `deriveInventoryMode` (`form/model.ts:400-405`) and sent in every PUT (`:407-409`) | REL `product.inventory_mode` | OK — `inventory_mode` key + derivation | Only writer is `planRelationsWrite` (`adminProductRelations.ts:641`); TXT bridge omits it (`templateRelations.ts:266`) so the stored mode falls back (`adminProductRelations.ts:338-341`). CSV has a column (`worker/lib/importCsv.ts:1868`). |
| — (`stock_reserved`) | — | — | `products.stock_reserved` | not shown | REL | not in template (by design) | Never touched by either path. |

### 2.6 Usage guide

| TXT key | Parsed field | ProductDoc field | DB column | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `usage_official_url` | string | `usage_guide.official_url` via `safeLink` | `products.usage_guide` JSON | `UsageGuideSection` · `doc.usage_guide.official_url` | V2 | OK / silent blanking | Non-`http(s)://`, non-`/relative` URL → `''` with no warning (`worker/lib/productModel.ts:638`; `worker/lib/homeContent.ts:62-69`). |
| `usage_steps.N.id/kind/title/body` | string / enum `setup\|usage` / string / text | `usage_guide.steps[]` | `products.usage_guide` JSON | `UsageGuideSection` steps | V2 | OK | Step with neither title nor body dropped by `upgradeUsageGuide` (`productModel.ts:635`); `toDocBody` warns (`worker/lib/template.ts:1938-1946`). |
| `usage_steps.N.images/video_url/link_url` | csv / string / string | `steps[].images (≤6) / video_url / link_url`, each `safeLink` | JSON | `steps[].*` | V2 | OK / silent blanking | `productModel.ts:621-632`. |
| `usage_steps=__CLEAR__` | `groupClears.usage_steps` | `usage_guide.steps=[]` | JSON | — | V2 | OK | |

### 2.7 Spec sheet (`spec.*`) and spec groups

| TXT key | Parsed field | ProductDoc field | DB column | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `spec.<id>` (`/^spec\.([a-z0-9_]{1,80})$/`, `:679`) | `specFields[id]` | `spec_fields[id]` merged onto existing (`:1810-1824`) | `products.spec_fields` JSON | Section 7 inputs **only** for ids in `GET /taxonomy/templates?category=<sub_category_id\|\|category_id>` (`ProductForm.tsx:319-343, 1196-1247`); badge counts all keys (`:1185`) | V2 `spec_fields` | OK — stored, reported and rendered beside the section's fields | Semantics differ from every other key: `''`, `__NULL__`, `__CLEAR__` all DELETE the key (`:1815`). No family/type/select validation (CSV path validates, `docs/IMPORT_TEMPLATE.md:124-130`); `spec.made_up_field` accepted silently (repro D1). |
| `spec_groups.N.id/title_ar/title_en/title_ckb` | string (title_ar required, `:308`) | `spec_groups[]` | `products.specifications` JSON | **none** | V2 `spec_groups` | OK — shown read-only | Stored and returned (repro A: 1 group); no editor; ar/ckb regenerated on form save. |
| `spec_groups.N.rows.M.id/label_*/value_*/unit` | string (label_ar required, `:314`) | `spec_groups[].rows[]` | JSON | none | V2 | OK — shown read-only | Unknown row subkeys → `unknown_keys` (`:716`). |
| `spec_groups=__CLEAR__` | groupClears | `spec_groups=[]` | JSON | — | V2 | OK | |

### 2.8 Pre-order transports

| TXT key | Parsed field | ProductDoc field | DB column | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `transports.N.method` | enum `air\|sea\|land` (required, merge key) | `preorder_transports[].method` | `products.preorder_transports` JSON | TRANSPORTS cards, rendered only if `sale_types` has `pre_order` (`ProductForm.tsx:1049-1106`) | V2 | OK / gated | Export emits undeclared methods with `active=false` (`worker/lib/template.ts:935-950`) → round trip appends inactive rows (repro C1). |
| `transports.N.commission_iqd` | iqd nullable, `+N` plain | `[].commission_iqd` | JSON | Money per method | V2 | OK | `__NULL__` = admin default. |
| `transports.N.surcharge_iqd` | alias of `commission_iqd`, import-only | `[].commission_iqd` | JSON | — | as commission | OK | Never exported. |
| `transports.N.active` | bool | `[].active` | JSON | toggle | V2 | OK | Auto-deactivated when `sale_types` lacks `pre_order` (`productModel.ts:806-810`). |
| `transports=__CLEAR__` | groupClears | `[]` | JSON | — | V2 | OK | |

### 2.9 Images (`images.N.*`)

Persistence for the whole group: **create** → `products.images` JSON only (`worker/routes/template.ts:1341-1345`); **update on a product with no relational rows** → JSON only (`:1227-1228`); **update on a relational product** → `product_images` via `planRelationsWrite` (`adminProductRelations.ts:818-850`). The form reads `REL images[]` only (`form/model.ts:279-360`; `ProductForm.tsx:1165-1176` `<ImagesSection rel>`).

| TXT key | Parsed field | ProductDoc field | DB column / table | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `images.N.id` | string (merge key) | `media[].id` (`newId('img')` when empty) | `product_images.id` (relational path only) / JSON | `rel.images[].id` | REL | OK — rows | Repro A/B/readback: `product_images` 0 rows, REL `images 0`, V2 `media 1-3`. |
| `images.N.url` | string required (`:207`) | `media[].url` | `product_images.url` / JSON | `FormImage.url` | REL | OK — rows | URL not validated. |
| `images.N.key` | string | `media[].key` | `product_images.r2_key` (preserve-if-empty) | none (not in `FormImage`) | REL `r2_key` | OK — rows, `__CLEAR__` clears | `CASE WHEN excluded.r2_key <> ''` (`adminProductRelations.ts:846`). |
| `images.N.alt_ar` / `alt_ckb` | string | `media[].alt_ar/alt_ckb` | `product_images.alt_ar/alt_ckb` (0048, `migrations/0048_image_provenance.sql:20-21`, preserve-if-empty) | none (form has `alt_en` only) | REL | OK — rows + shown read-only | Value identical to `alt_en` dropped as "fake" (`templateRelations.ts:215-226`); `''` cannot clear (`adminProductRelations.ts:844-845`) yet key is listed under `cleared_fields`. |
| `images.N.alt_en` | string | `media[].alt_en` | `product_images.alt_en` | `FormImage.alt_en` | REL | OK — rows | |
| `images.N.primary` | bool | `media[].primary` | `product_images.is_primary` | `FormImage.is_primary` | REL | OK — rows | Writer promotes first image when none primary (`adminProductRelations.ts:545-552`). |
| `images.N.source_url` | string | `media[].source_url` | `product_images.source_url` (preserve-if-empty) | `FormImage.source_url` | REL | OK — rows, `__CLEAR__` clears | `:847`. |
| `images.N.option_value_id` / `color_id` / `variant_id` | string | `media[].*` | `product_images.*` | `FormImage.*` | REL | OK — rows | Relational path drops a binding whose target is not in the file (`templateRelations.ts:208-210`). |
| `images.N.width` / `height` | int 1..100000 nullable | `media[].width/height` | `product_images.width/height` | `FormImage.width/height` | REL | OK — rows | |
| `images=__CLEAR__` | groupClears | `media=[]` | JSON; rows deleted only on relational path | — | REL | OK | |
| — (`content_type`, `bytes`) | — | — | `product_images.content_type/bytes` | — | REL | not in template | Carried from the existing row (`templateRelations.ts:239-240`). |

### 2.10 Options (`options.N.*`)

Persistence for the group: identical gate to images. Form reads `REL groups[]/values[]` only (`ProductForm.tsx:1147-1163` `<OptionsSection rel>`).

| TXT key | Parsed field | ProductDoc field | DB column / table | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `options.N.id` | string (merge key) | `options[].id` (`newId('opt')`) | `product_option_values.id` (relational path only) / JSON | `FormValue.id` | REL `values[].id` | OK — rows | Repro A: REL `values 0`, V2 `options 4`. Writer refuses ids owned by another product (`adminProductRelations.ts:593-611`). |
| `options.N.group` | string | `options[].group_en` | `product_option_groups.name_en` (groups rebuilt by name, `templateRelations.ts:103-152`) / JSON | `FormGroup.name_en` | REL `groups[].name_en` | OK — rows | Group table exists only on the relational path. Group `active`/`sort` not expressible. |
| `options.N.name_ar` (required, `:237`) / `name_ckb` | string | `options[].name_ar/name_ckb` | **JSON only** — `product_option_values` has no such column (`migrations/0018_prime_taxonomy_inventory.sql:196-219`) | none | REL returns `name_en` copied into `name_ar/name_ckb` by the overlay (`productOverlay.ts:311-313`) | OK — columns (0055) + shown | `templateRelations.ts:157` sends `name_en \|\| name_ar`. A file written to match the (English-only) form is refused: `NEEDS_REVIEW name_ar is required` (repro readback). |
| `options.N.name_en` | string | `options[].name_en` | `product_option_values.name_en` / JSON | `FormValue.name_en` | REL | OK — rows | |
| `options.N.image` | string | `options[].image` | `product_option_values.image` | `FormValue.image` | REL | OK — rows | |
| `options.N.active` | bool | `options[].active` | `product_option_values.active` | `FormValue.active` | REL | OK — rows | |
| `options.N.regular_price_iqd` | iqd nullable; `+N/-N` → `regular_adjust_iqd` (`:246`, `:1515-1527`) | `options[].regular_price_iqd` / `regular_adjust_iqd` | `product_option_values.regular_price_iqd/regular_adjust_iqd` | `FormPrices.regular_price_iqd/regular_adjust_iqd` | REL | OK — rows | Plain number re-expressed as adjust by `normalizeCheapestBase`. |
| `options.N.pro_price_iqd` / `prime_price_iqd` | iqd nullable; signed → adjust twin | `options[].*` | `product_option_values.*` | `FormPrices.*` | REL | OK — rows | |
| `options.N.compare_at_iqd` | iqd nullable (`:249`) | **none** — `PriceFields` has no compare-at | — | — | — | removed from the registry → `unknown_keys` | `upgradePriceFields` drops it ("Compare-at is gone (mandate §4)", `worker/lib/productModel.ts:329-356`); still in blank template and `docs/FIELD_MAPPING.md:117`. |
| `options.N.cost_iqd` | iqd nullable; signed → `cost_adjust_iqd` | `options[].cost_iqd` | `product_option_values.cost_iqd` (only when `money`) / JSON (ungated) | `FormPrices.cost_iqd` | REL (stripped) | OK — rows, §11 holds | Relational upsert gated (`adminProductRelations.ts:737`); JSON mirror written for assistants (repro F/G). |
| `options.N.regular_adjust_iqd` / `prime_adjust_iqd` / `pro_adjust_iqd` / `cost_adjust_iqd` | int signed nullable (`:254`) | `options[].*_adjust_iqd` | `product_option_values.*_adjust_iqd` (0044) | carried in `FormPrices` | REL | OK — rows | |
| `options.N.availability_type` | enum `''\|direct_sale\|pre_order` | `options[].availability_type` | `product_option_values.availability_type` (0043) | `FormValue.availability_type` | REL | OK — rows | Drives `sale_types` in both `validateProductDoc` and the writer. |
| `options.N.stock` | int nullable (`:260`) | `options[].stock` | `product_option_values.stock` | `FormValue.stock` | REL | OK — rows, tracked level | `inventory_mode` stays `BASE` (repro A: `availability scope=base on_hand=7`). |
| `options.N.lead_time_text/min_days/max_days` | string / int 0..3650 | `options[].lead_time_*` | `product_option_values.lead_time_*` | `FormValue.lead_time_*` | REL | OK — rows | text max 120 in writer vs 200 in model (`productModel.ts:405`). |
| `options.N.variant_key` / `variant_label` | string | `options[].variant_key/label` | `product_option_values.variant_key/label` | `FormValue.variant_key/label` | REL | OK — rows | Fallback derived from `name_ar` in model (`productModel.ts:408`) but `name_en` in writer. |
| `options.N.sku_part` | string | `options[].sku_part` | `product_option_values.sku_part` | `FormValue.sku_part` | REL | OK — rows | |
| `options.N.low_stock_threshold` | int nullable (`:267`) | `options[].low_stock_threshold` | `product_option_values.low_stock_threshold` | `FormValue.low_stock_threshold` | REL | OK — rows | |
| `options=__CLEAR__` | groupClears | `options=[]` | rows deleted only on relational path | — | REL | OK | Refused when reserved units exist (`adminProductRelations.ts:567-583`, repro D4). |
| — (group `active`, `sort`) | — | — | `product_option_groups.active/sort` | `FormGroup.active` | REL | not in template | Groups rebuilt with `active:true`, sort = first appearance (`templateRelations.ts:107`). Round trip of a form-built product flips group order (repro C2; cause `productRelations.ts:242` flat `ORDER BY sort, name_en`). |

### 2.11 Colours (`colors.N.*`)

| TXT key | Parsed field | ProductDoc field | DB column / table | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `colors.N.id` | string (merge key) | `colors[].id` (`newId('col')`) | `product_colors.id` (relational path only) / JSON | `FormColor.id` | REL `colors[].id` | OK — rows | Repro A: REL `colors 0 links 0`. |
| `colors.N.name_ar` (required, `:275`) / `name_ckb` | string | `colors[].name_ar/name_ckb` | JSON only — `product_colors` has only `name_en` (`0018:220-244`) | none | REL `name_en` copied (`productOverlay.ts:359-361`) | OK — columns (0055) + shown | `templateRelations.ts:185`. |
| `colors.N.name_en` | string | `colors[].name_en` | `product_colors.name_en` | `FormColor.name_en` | REL | OK — rows | |
| `colors.N.hex` | `#RRGGBB` or `''` (`:487`) | `colors[].hex` | `product_colors.hex` | `FormColor.hex` | REL | refused by name (see §7.2) | Parser allows `''`; relational writer refuses it (`RELATIONS_VALIDATION`). |
| `colors.N.image` | string | `colors[].image` | `product_colors.image` | `FormColor.image` | REL | OK — rows | |
| `colors.N.option_id` | string nullable (`:280`) | `colors[].option_id` (+ `option_ids=[option_id]` when list absent, `productModel.ts:451-457`) | `product_color_option_links` | `FormColor.option_value_ids` | REL `links[]` | OK — rows; `option_ids` is the link set | `option_ids` (always exported) wins (`templateRelations.ts:176-182`). |
| `colors.N.option_index` | int 1..999 import-only (`:281`) | → `colors[].option_id` via options index map (`:1919-1935`) | as `option_id` | — | — | OK | Overridden by a non-empty `option_ids` on the same item. |
| `colors.N.option_ids` | csv | `colors[].option_ids` (full link set) | `product_color_option_links` rows | `FormColor.option_value_ids` | REL `links[]` | OK — rows | Links to ids not in the file silently dropped (`templateRelations.ts:178-182`). |
| `colors.N.sku_part` | string | `colors[].sku_part` | `product_colors.sku_part` | `FormColor.sku_part` | REL | OK — rows | |
| `colors.N.stock` / `low_stock_threshold` | int nullable (`:288-289`) | `colors[].*` | `product_colors.*` | `FormColor.*` | REL | OK — rows, tracked level | `inventory_mode` never `COLOR`. |
| `colors.N.active` | bool | `colors[].active` | `product_colors.active` | `FormColor.active` | REL | OK — rows | |
| `colors.N.regular_price_iqd` / `pro_price_iqd` / `prime_price_iqd` | iqd nullable; signed → adjust twin (`:291-293`) | `colors[].*` | `product_colors.*` | `FormPrices.*` | REL | OK — rows | |
| `colors.N.compare_at_iqd` | iqd nullable (`:294`) | none | — | — | — | removed from the registry → `unknown_keys` | Same as options. |
| `colors.N.cost_iqd` | iqd nullable; signed → `cost_adjust_iqd` | `colors[].cost_iqd` | `product_colors.cost_iqd` (money only, `adminProductRelations.ts:769`) / JSON ungated | `FormPrices.cost_iqd` | REL (stripped) | OK — rows, §11 holds | Repro F: assistant wrote `333444`. |
| `colors.N.*_adjust_iqd` | int signed nullable (`:297`) | `colors[].*_adjust_iqd` | `product_colors.*_adjust_iqd` | carried | REL | OK — rows | |
| `colors=__CLEAR__` | groupClears | `colors=[]` | rows deleted only on relational path | — | REL | OK | Reserved guard applies. |

### 2.12 Labels, warranty plans, content blocks

| TXT key | Parsed field | ProductDoc field | DB column | ProductForm field | Read-back | Status | Note |
|---|---|---|---|---|---|---|---|
| `labels.N.id/key/text_ar/text_en/text_ckb/icon/visible` | string / string / string×3 / string / bool | `labels[]` | `products.labels` JSON | **none** | V2 `labels` | OK — shown read-only | Stored (repro A: 1); `key` not validated. |
| `labels=__CLEAR__` | groupClears | `labels=[]` | JSON | — | V2 | OK | |
| `warranty_plans.N.id/title_ar/title_en/title_ckb/terms_*` | string / text (title_ar required, `:341`) | `warranty_plans[]` | `products.warranty_plans` JSON | `WarrantySection` (title/duration/fee, English, printer sections only) | V2 | OK / gated | `applyPrinterWarrantyRules` refuses plans outside printer catalogs (`worker/routes/template.ts:636`; `adminProducts.ts:857`). Non-printer section → banner + delete button (`WarrantySection.tsx:67-82`). |
| `warranty_plans.N.duration_months` / `duration_kind` | int 1..240 required (`:347`) / enum `extension\|total` | `[].duration_months/kind` | JSON | plan switches | V2 | OK | Printers: 12\|24 + extension only. |
| `warranty_plans.N.fee_percent` / `fee_iqd` | percent nullable (`:349`) / iqd required `+N` plain (`:350`) | `[].fee_percent/fee_iqd` | JSON | plan inputs | V2 | OK | |
| `warranty_plans.N.active` | bool | `[].active` | JSON | switch | V2 | OK | |
| `warranty_plans=__CLEAR__` | groupClears | `[]` | JSON | — | V2 | OK | |
| `content_blocks.N.id/kind/body_*/caption_*/alt_*/url/media_key` | string / enum `text\|image\|video_embed` required (`:359`) / … | `content_blocks[]` | `products.content_blocks` JSON | **none** | V2 `content_blocks` | OK — shown read-only | Stored (repro A: 1); ar/ckb regenerated on form save. |
| `content_blocks=__CLEAR__` | groupClears | `[]` | JSON | — | V2 | OK | |

### 2.13 Not in template / form-only / protected

| Item | ProductDoc / DB | ProductForm | Read-back | Status | Note |
|---|---|---|---|---|---|
| `variants.N.*` (option_value_ids, color_id, sku, active, stock, prices) | `product_variants` (no JSON mirror) | `rel.variants[]` via `parseComboKey` | REL `variants[]` | not in template | Carried unchanged from the view; combinations whose option/colour left the file are dropped with a warning (`templateRelations.ts:245-264`; `worker/routes/template.ts:1246-1260`). Never created by TXT. |
| `facet_ids` | `product_facets` | form omits → preserved | REL `facet_ids` | not in template (intentional) | `adminProductRelations.ts:559-565`. |
| `sale_types` explicit list | `products.sale_types` | multi-select | V2 | not in template | Only via `selling_type=mixed` or option `availability_type`. |
| `catalog_ids` editor | `product_catalogs` | no editor in ProductForm (carried) | V2 `catalog_ids` | OK — listed read-only | `PUT /products-v2/:id/catalogs` exists (`adminProducts.ts:1209`). |
| `doc_version`, `content_rev`, `translation_meta`, `created_at`, `updated_at`, `legacy.*` | `products.*` | — | V2 | protected by design | `PROTECTED_FIELDS` (`worker/lib/template.ts:394-400`); TXT bookkeeping is Arabic-sourced (`:1976-2005`) vs the form's English-sourced `localizeProductDoc` + `applyTranslationTracking` (`adminProducts.ts:164, 902-903`). |
| `product_translations` rows | `product_translations` | — | — | OK | Form path `syncProductTranslations` (`adminProducts.ts:960`); TXT never writes them. |
| Unknown / unsupported keys | — | ImportPanel shows `unknownColumns` one amber line at **check** time (`ImportPanel.tsx:776-781`); `/apply` response has no `unknown_keys` field (`worker/routes/template.ts:1397-1408`); `applyTxt` discards `out.warnings` (`ImportPanel.tsx:1012-1045`) | — | OK — in the `/apply` answer too | `options.1.colour=...` imports "successfully" with the value missing (repro D1). |

---

## 3. Persistence contract comparison — FORM save vs TEMPLATE apply

| Table / field | FORM save (`POST /api/admin/products-v2` then `PUT /api/admin/products/:id/relations`) | TEMPLATE apply (`POST /api/admin/template/apply`) | Divergence |
|---|---|---|---|
| `products` scalar + JSON columns | `validateProductDoc` → `localizeProductDoc` → `serializeDoc` → INSERT/UPDATE (`adminProducts.ts:819-1000`) | `toDocBody` → `validateProductDoc` → `serializeDoc` → INSERT (`worker/routes/template.ts:1341-1345`) / explicit-column UPDATE (`:1298-1314`) | Same columns. TXT skips `localizeProductDoc` (by design: file carries ar/ckb) but then writes `products.options/colors/images` JSON that nothing reads once rows exist (repro C2: JSON mirror populated on a form-built product). |
| `product_option_groups` / `product_option_values` | `planRelationsWrite` upsert (`adminProductRelations.ts:695-745`) — **always** | Only `if (relational && (structureTouched \|\| mediaTouched))` (`worker/routes/template.ts:1227-1228`); never on create (`:1323-1366`) | RESOLVED — one contract, both paths write the rows. |
| `product_colors` / `product_color_option_links` | links deleted and rebuilt, colours upserted (`:681-687, 747-790`) | same gate | RESOLVED — same. |
| `product_variants` | upsert from `rel.variants` (`:793-815`) | carried from view, filtered (`templateRelations.ts:245-264`); never created | Partial (carry-only). |
| `product_images` | upsert, `is_primary` reset then set (`:818-850`) | same gate as options | RESOLVED — one contract, both paths write the rows. |
| `products.inventory_mode` | `deriveInventoryMode(rel)` in every PUT (`form/model.ts:400-409`) → `UPDATE products SET inventory_mode` (`:641`) | never set (no key; bridge omits; `PRODUCT_COLUMNS` lacks it) | RESOLVED — derived once, for every caller. |
| `products.sale_types` / `selling_type` re-derived from options | `planRelationsWrite` (`:658-668`) after every PUT | only when the relational branch runs | OK. |
| `product_catalogs` | `syncCatalogs` in the products-v2 request (`adminProducts.ts:99-138, 931`) | `applyCatalogs` sequential `.run()` after the product write; failure → warning (`worker/routes/template.ts:563-598, 1372-1381`) | RESOLVED — catalogs are in the batch. |
| Atomicity | Two HTTP requests (product then relations); UI admits half-save (`ProductForm.tsx:515-527`) | Create: single `.run()` + catalogs + audit as separate awaits; relational update: one `db.batch([productStmt, ...relationStmts])` (`:1313`) then catalogs | Neither path is atomic across product + relations + catalogs. CSV path: two batches (`worker/routes/adminImport.ts:1116, 1149`). |
| Cost (§11 financial scope) | `attemptedFinancialWrites` → 403; `carryStoredCostForward` (`adminProducts.ts:839-845`); writer omits cost columns when `money=false` (`adminProductRelations.ts:737, 769, 806`) | Update: `product_cost_iqd` reset to stored + warning (`:1286-1293`); create: **no gate**; option/colour cost in JSON mirror **ungated** (`:1298`, `:1341`) | RESOLVED — the gate is inside the contract. |
| Reserved inventory / live variants | `planRelationsWrite` refuses removals with `reserved > 0` (`:567-583`) | Same guard, only when the relational branch runs; JSON path has nothing to guard | Parity where rows exist (repro D4). |
| `price_history` | `recordPriceHistory` on update (`adminProducts.ts:948`) | none | RESOLVED — the rows are statements in the same batch. |
| Hashtag vocabulary | `registerHashtags` (`adminProducts.ts:939`) | none | Diverges (repro D5). |
| Translations | `localizeProductDoc` + `applyTranslationTracking` + `syncProductTranslations` (`adminProducts.ts:902-903, 960`) | `translationBookkeeping` (Arabic-sourced, `worker/lib/template.ts:1976-2005`); no `product_translations` rows | Diverges; the next form save overwrites TXT Arabic with machine text. |
| Audit | `product_v2.create/update` (`adminProducts.ts:967`) + `product.relations.save` (`adminProductRelations.ts:901`) | one `template.apply` row (`worker/routes/template.ts:1385`) | Different shape; no relation summary. |
| Stale-edit guard | `STALE_EDIT` 409 (`adminProducts.ts:865-877`) | `STALE` 409 (`worker/routes/template.ts:1191-1202`) | Parity (different codes). |
| Slug | stable unless `allow_slug_change` (`adminProducts.ts:880-898`) | same via `toDocBody` (`worker/lib/template.ts:1760-1784`) | Parity. |
| Response | `product` (V2 projection) + `translation_review_needed`; relations PUT returns fresh relations + `inventory_mode` (`adminProductRelations.ts:904`) | `product` (JSON mirror), `applied/cleared/preserved_fields`, `warnings` — no relation counts, no `unknown_keys` (`:1397-1408`) | UI cannot tell 0 rows from N rows. |

---

## 4. Root causes (numbered)

> All fifteen are resolved. Each entry below is the DIAGNOSIS as written, with
> the `file:line` references of the tree at that moment; §7 states what
> replaced it and names the test that would fail if it came back.

1. **Two persistence paths for one product; the TXT path picks the dead one.** `POST /apply` create runs `serializeDoc` → `INSERT INTO products` and returns (`worker/routes/template.ts:1341-1345`); `planRelationsWrite` — the only writer of `product_option_groups`, `product_option_values`, `product_colors`, `product_color_option_links`, `product_variants`, `product_images` and `products.inventory_mode` — is referenced only in the update branch (`:1232`). Evidence: repro A/readback/applyVsForm — `product_option_groups/values/colors/links/variants/images` all 0 rows; `GET /relations` `groups 0 values 0 colors 0 links 0 images 0 inventory_mode BASE`; `GET /products-v2` `options 4 colors 1 media 3`. Loses: every `options.N.*`, `colors.N.*`, `images.N.*` key, option/colour stock, option-derived `sale_types`, variant/colour image bindings.
2. **The update gate `hasRelationalStructure()` makes "first relation" impossible.** `const relational = await hasRelationalStructure(...); if (relational && (structureTouched.length > 0 || mediaTouched))` (`worker/routes/template.ts:1227-1228`, function at `:468-484` counts existing values/colours/images). A product with none (every TXT-born product, every legacy JSON product) falls to the plain UPDATE (`:1298-1314`); the only warning branch is `else if (relational)` (`:1262-1270`), so the JSON-only write is silent. Evidence: repro B — `applied_fields [options,images,colors] warnings []`, tables 0, REL 0, JSON `options 3`. Loses: the same groups on update.
3. **`inventory_mode` has no owner on the TXT path.** No registry key (`worker/lib/template.ts:141-400`), not in `PRODUCT_COLUMNS` (`worker/lib/productModel.ts:1259-1267`), not returned by `relationsBodyFromDoc` (`worker/lib/templateRelations.ts:266`); `planRelationsWrite` falls back to the stored mode (`adminProductRelations.ts:338-341`). The form derives it from stock placement on every PUT (`form/model.ts:400-409`). Evidence: readback repro — relational update wrote `Large stock 3` yet `inventory_mode BASE`; repro A — public availability `scope base on_hand 7`. Loses: `options.N.stock`, `colors.N.stock`, `*.low_stock_threshold` as the tracked level.
4. **The form reads one store, `products-v2` returns another, the storefront reads a third fallback.** `GET /products-v2/:id` is `parseProductRow` without overlay (`adminProducts.ts:746-757`); the form renders `rel` only for sections 5/6 (`ProductForm.tsx:1147-1176`) but `PricePreview` still lists `savedDoc.options/colors` (`PricePreview.tsx:94-105`) and the save response rehydrates `doc` from the mirror (`ProductForm.tsx:531`); the storefront falls through to JSON when `!view.has_relations` (`productOverlay.ts:304`). Evidence: repro E — owner opens TXT-born product, sees 0 groups/0 images, saves untouched; storefront still sells 3 options/1 colour/3 images with `OPTION_REQUIRED, COLOR_REQUIRED`. Loses: admin visibility and control over live structure.
5. **Relational schema cannot hold what the registry requires.** `product_option_values`/`product_colors` have only `name_en` (`migrations/0018_prime_taxonomy_inventory.sql:196-244`); bridge sends `name_en || name_ar` (`templateRelations.ts:157, 185`); overlay fakes `name_ar = name_ckb = name_en` (`productOverlay.ts:311-313, 359-361`); yet `options.N.name_ar`/`colors.N.name_ar` are `required` (`worker/lib/template.ts:237, 275`). Evidence: readback repro — English-only option row refused `NEEDS_REVIEW name_ar is required`. Loses: `options.N.name_ar/name_ckb`, `colors.N.name_ar/name_ckb`; blocks files authored from the form's own view.
6. **Registry keys the model has no slot for.** `options.N.compare_at_iqd` / `colors.N.compare_at_iqd` (`worker/lib/template.ts:249, 294`) are coerced and written by `applyItemField` but discarded by `upgradePriceFields` (`worker/lib/productModel.ts:329-356`) with no warning; never exported; still documented as stored (`docs/FIELD_MAPPING.md:117, 137`). Loses: both keys.
7. **`__CLEAR__` is not honoured for image provenance on relational products.** Upsert keeps stored values when the incoming one is `''` (`adminProductRelations.ts:844-847`); `alt_ar`/`alt_ckb` identical to `alt_en` are dropped before the write (`templateRelations.ts:215-226`); the response still lists the key under `cleared_fields`. Loses: `images.N.alt_ar/alt_ckb/key/source_url` clears.
8. **Financial scope (§11) is enforced in only one of three places.** Update gate covers `products.product_cost_iqd` only (`worker/routes/template.ts:1286-1293`); create has none (`:1323-1366`); `serializeDoc` writes option/colour `cost_iqd`/`cost_adjust_iqd` into JSON unconditionally (`:1298, :1341`). Evidence: repro D3/F — assistant stored `product_cost_iqd 123456`, `option cost 111222`, `color cost 333444`; repro G — relational cost kept but JSON mirror overwritten with `1`. Loses: the cost invariant.
9. **`spec.*` accepts any id, invisible without the matching section.** Parser regex only (`worker/lib/template.ts:679`), merge unconditional (`:1810-1824`), no family/select/number validation (CSV path has it, `docs/IMPORT_TEMPLATE.md:124-130`); `readSpecFields` has no family check (`productModel.ts:361-372`). Form renders only `fieldsFor(family, section_slugs)` (`worker/routes/adminTaxonomy.ts:119-155`; `ProductForm.tsx:319-343, 1196-1247`) and overwrites `template_family` from the section (`:333-335`). Evidence: repro D1 — `spec.made_up_field` stored, `invisible_in_form=[made_up_field]`. Loses: any `spec.<id>` outside the section's list; all `spec.*` when `category`/`sub_category` are absent or family-less.
10. **No editor for five ProductDoc groups; the form regenerates their Arabic.** `labels`, `content_blocks`, `spec_groups`, `payment_options`, `description_ar/ckb`, `name_ar/ckb` are carried by `toEditorDoc` (`types.ts:72-95`) but no component renders them (grep hits only `types.ts`); `localizeProductDoc` rewrites ar/ckb from English on every form save (`localizeProduct.ts:38-75`; `adminProducts.ts:902`). Loses (in UI): those groups; loses (on next form save): TXT-authored Arabic.
11. **Apply reports parser success, not read-back truth.** Response has no `unknown_keys`, no relation/spec/image counts (`worker/routes/template.ts:1397-1408`); `ImportPanel.applyTxt` records only `created`/`product_id`/`already_applied` and drops `out.warnings` (`ImportPanel.tsx:1012-1045`); "N img" is a regex over the file text (`countTxtImages`, `:387-396`). Evidence: repro D1 — file with 4 options/3 images/7 specs → response carries none of those counts; UI says "1 img" for a product with 0 `product_images` rows. Loses: the owner's ability to notice any of the above.
12. **Side effects the form performs are absent.** `price_history` (`adminProducts.ts:948`), `registerHashtags` (`:939`), `syncProductTranslations` (`:960`), `product.relations.save` audit (`adminProductRelations.ts:901`) — none in `worker/routes/template.ts` (imports `:33-77`). Evidence: repro D5 — `price_history 0` vs form `1`; `hashtags_registered 0`.
13. **Ordering is not round-trip stable.** `loadProductRelations` orders values flat `ORDER BY sort, name_en` (`productRelations.ts:242`), `orderedOptions` derives group order from first appearance (`worker/lib/template.ts:849-861`), the bridge assigns `sort = groups.length` / `o.order` (`templateRelations.ts:107, 160`). Evidence: repro C2 — groups `[Model 0, Nozzle 1]` → `[Nozzle 0, Model 1]`, value sorts renumbered `0..3`, `/parse` diff `[]`.
14. **Catalogs and audit sit outside the write batch.** `applyCatalogs` runs after the product write with per-row `.run()` and a warning on failure (`worker/routes/template.ts:563-598, 1372-1381`). Loses: `catalogs` on a partial failure; violates "no half-saved product".
15. **Tests judge the parser.** `tests/templateRoundTrip.test.ts` drives `applyRelations → exportProduct → parseTemplate → toDocBody → relationsBodyFromDoc` in-process (`:20-24`); no test mounts `/apply` and reads `GET /relations` after a TXT create or a first-option update (`tests/templateDownload.test.ts` mounts the routes for download only).

---

## 5. Architecture fix plan

### 5.1 One shared persistence contract — `worker/lib/productPersistence.ts`

Both the form (`adminProducts.ts` + `adminProductRelations.ts`), the TXT route (`worker/routes/template.ts`) and the CSV/ZIP importer (`worker/routes/adminImport.ts`) must call the same three functions, in order, and nothing else may write the product tables.

```ts
// worker/lib/productPersistence.ts
export type ProductWriteIntent = {
  mode: 'create' | 'update';
  doc: ProductDoc;                       // already validated by validateProductDoc
  relations: RelationsWireBody | null;   // the SAME shape ProductForm PUTs (groups, colors, images, variants, inventory_mode, facet_ids?)
  catalogIds?: string[];                 // undefined = preserve
  touched: { fields: Set<string>; groups: Set<'options'|'colors'|'images'|'variants'|'catalogs'> }; // what the caller actually asked for
  actor: { adminId: string; money: boolean };
  expectedUpdatedAt?: string | null;
};

export function normaliseProductWrite(intent, existing: LoadedProduct | null): NormalisedWrite;
//  - applies omitted=preserve (from existing), __CLEAR__, __NULL__ per field type (reuses toDocBody / form body semantics)
//  - derives inventory_mode exactly like form/model.ts deriveInventoryMode when the caller did not state one
//  - derives sale_types from option availability (deriveSaleTypes) once, here
//  - §11: when !actor.money, copies every stored cost (product, option, colour, variant, JSON mirror) forward and records a warning
//  - never invents values; no defaults beyond what validateProductDoc already applies

export async function planProductWrite(db, n: NormalisedWrite): Promise<PlannedWrite | { errors: string[] }>;
//  - products INSERT (create) or explicit-column UPDATE (update)
//  - planRelationsWrite(...) statements — ALWAYS, for create and update, including the empty→first-relation case
//    (planRelationsWrite needs the row: on create, pass the doc-derived ladder/mode instead of SELECTing — refactor its
//     first 40 lines (adminProductRelations.ts:301-341) into planRelationsWriteFrom(existingSnapshot, body, opts))
//  - product_catalogs DELETE + INSERT statements (from adminImport.ts:1136-1147 pattern)
//  - reserved-inventory and live-variant guards stay inside planRelationsWrite (adminProductRelations.ts:567-583); "tied to a live order" must ALSO
//    check order_items referencing the variant/value id, not only reserved>0
//  - price_history rows, hashtags registry rows, product_translations rows as statements, so they join the batch

export async function commitProductWrite(db, p: PlannedWrite): Promise<CommitResult>;
//  - ONE db.batch([...]) for row + relations + images + variants + catalogs + dependent rows (D1 batch is atomic)
//  - audit row written after the batch with p.summary
```

Rules pinned by the contract (each becomes a test):

- **create vs update**: `mode='create'` always emits INSERT + full relation plan; `mode='update'` emits UPDATE + relation plan whenever `touched.groups` is non-empty — the `hasRelationalStructure()` gate is deleted. JSON mirrors `products.options/colors/images` are written only as a read-only fallback copy (or emptied) — they are never the destination.
- **first-relation creation**: a product with 0 rows receiving `options.1.*` gets group + value rows; with `images.1.*` gets a `product_images` row; verified by reading `GET /relations`.
- **preserve / clear / null**: omitted key → existing value; `__CLEAR__` → `''`/`[]`/delete-rows where the type allows (image provenance included — replace the `CASE WHEN excluded.x <> ''` at `adminProductRelations.ts:844-847` with an explicit `clear` flag per field); `__NULL__` → null only for nullable fields (parser already enforces).
- **financial scope**: `actor.money=false` → no cost column, no JSON cost, no `product_cost_iqd` changes on create or update; response carries a warning.
- **reserved inventory**: any deletion of a value/colour/variant with `reserved > 0` fails the whole write (`RELATIONS_VALIDATION`), nothing lands.
- **live variants**: a variant referenced by an `order_items` row (any non-cancelled order) is never deleted — deactivate instead; the response says so.
- **inventory_mode**: derived once in `normaliseProductWrite` from where stock is stated (colour → `COLOR`, option → `OPTION`, existing `VARIANT_COMBINATION` with variants kept, else `BASE`); TXT gains an optional explicit `inventory_mode` key (mirrors CSV, `importCsv.ts:1868`).

Callers after the refactor:

- `POST /api/admin/products-v2` + `PUT /api/admin/products/:id/relations`: keep the two HTTP endpoints for compatibility but make `products-v2` accept an optional `relations` body and call the contract once; the PUT becomes a thin wrapper that builds an intent with `touched.groups = {options,colors,images,variants}`.
- `POST /api/admin/template/apply`: `toDocBody` → `validateProductDoc` → `relationsBodyFromDoc(doc, viewOrEmpty)` (+ `inventory_mode`) → `normaliseProductWrite` → `planProductWrite` → `commitProductWrite`. Remove `hasRelationalStructure`, the `else if (relational)` warning, the separate `applyCatalogs`, and the update-only cost block (`worker/routes/template.ts:468-484, 563-598, 1227-1270, 1286-1293, 1341-1345, 1372-1381`).
- `POST /api/admin/import` (CSV/ZIP): replace the two batches (`adminImport.ts:1116, 1149`) with one commit.

Schema and registry alignment that the contract exposes:

- Either add `name_ar`/`name_ckb` columns to `product_option_values` and `product_colors` (new migration; overlay stops faking them) **or** drop `required` from `options.N.name_ar`/`colors.N.name_ar` and mark them `exported:false` — the doc recommends the first, since the storefront is trilingual.
- Remove `options.N.compare_at_iqd` / `colors.N.compare_at_iqd` from `FIELD_REGISTRY` (and the blank template) or add a `compare_at_iqd` slot to `PriceFields`; unknown → `unknown_keys`.
- Parser-level `spec.<id>` validation against `fieldsFor(family, section_slugs)` of the resolved `category`/`sub_category` — unknown id → `needs_review` (or warning + `unknown_keys`), select/number/hex coercion as the CSV path does.
- `colors.N.option_id=__NULL__` with an `option_ids` line present → error "conflicting link keys" rather than silent precedence.
- Export ordering: `orderedOptions` must follow `view.groups.sort` then `values.sort` within group; `loadProductRelations` values ordered by `(group sort, value sort)`.

### 5.2 Post-apply server-side verification (inside `/apply`, after `commitProductWrite`)

```ts
const stored = await loadProductDocWithView(db, id);      // same loaders the form endpoints use
const relations = await loadRelationsResponse(db, id);    // exactly GET /products/:id/relations
const v2 = projectAdmin(parseProductRow(row));            // exactly GET /products-v2/:id
const report = verifyApplied(requested /* NormalisedWrite */, { v2, relations });
```

`verifyApplied` compares every requested field/group against what the two endpoints return and produces the structured result the route returns:

```ts
{
  success: true, created, product_id, fingerprint,
  applied_fields: string[], preserved_fields: string[], cleared_fields: string[],
  unknown_keys: string[],                 // from the parser — no longer dropped
  warnings: string[],
  relations: { groups: n, values: n, colors: n, links: n, variants: n, images: n, primary_image: id|null, inventory_mode },
  spec_fields: { stored: n, visible_in_form: n, outside_section: string[] },
  images: { requested: n, stored: n },
  option_groups: { requested: n, stored: n }, option_values: { requested: n, stored: n }, colors: { requested: n, stored: n },
  mismatches: Array<{ section: 'options'|'colors'|'images'|'spec'|'catalogs'|'inventory'|'scalars', key, requested, stored }>
}
```

Any non-empty `mismatches` → HTTP 500 `APPLY_VERIFY_FAILED` naming the section (`"options: requested 3 values, stored 0"`), the batch is already committed so the response must say the product exists and what is missing; the fingerprint is released so a retry is possible. Counts come from the read-back, never from the file.

### 5.3 ProductForm hydration fixes

1. `GET /api/admin/products-v2/:id` returns the overlay (`applyRelations(parseProductRow(row), view)`, as `adminProducts.ts:1243` already does for another route) so `doc.options/colors/media` and `rel` never disagree; `PricePreview` reads from `rel` (or the overlaid doc) — one source on screen.
2. Add read/edit surfaces for `labels`, `content_blocks`, `spec_groups`, `payment_options`, and a read-only "Arabic/Kurdish text (imported)" panel for `name_ar/ckb`, `description_ar/ckb`; until editors exist, show them as "preserved, edit via TXT" so the owner sees they are stored.
3. `localizeProductDoc` must skip fields whose `translation_meta` status is `imported`/`approved` (from `translationBookkeeping`) instead of regenerating them on every form save.
4. Spec section: render the union of the section's template fields **and** any stored `spec_fields` ids not in the template (flagged "outside this section's template"); stop overwriting `doc.template_family` silently (`ProductForm.tsx:333-335`) — show a mismatch hint instead.
5. Catalog selects include the stored catalog even when inactive (as the brand select already does, `ProductForm.tsx:359`).
6. Warranty: compute `isPrinter` from `catalog_ids` as the server does (`worker/lib/warrantyPlans.ts`), not from `category_id` only.
7. `relationsFromWire`: do not drop values whose `group_id` has no group — surface them as an error row.

### 5.4 ImportPanel counters

- After `/apply`, render the verification block: `groups / values / colours / links / images / spec fields / variants` from the response (read-back), plus `inventory_mode`; the "N img" column switches from `countTxtImages` to `images.stored` once applied.
- Show `warnings` and `unknown_keys` per row at apply time (not only at check); unknown keys require an explicit "import anyway, ignoring N keys" acknowledgement.
- A row whose `mismatches` is non-empty is rendered as `failed` with the section name, never as `created/updated`.
- Result table exposes "Open in form" so the owner can immediately verify the same two endpoints render the data.

### 5.5 Tests

Harness: `tests/fixtures/app.ts` `stubApp` over `freshDb()` (all migrations, `SqliteD1` from `tests/fixtures/d1.ts`) with `templateRoutes`, `adminProductsRoutes`, `adminProductRelationsRoutes`, `adminTaxonomyRoutes`, public `productRoutes` mounted — the pattern already used by the scratchpad repros and by `tests/farmHardening.test.ts` / `tests/adminHostGuard.test.ts`.

> Delivered as two suites: `tests/templateApplyParity.test.ts` (25 tests —
> the tables and the two admin endpoints, one per root cause) and
> `tests/templateParity.test.ts` (16 tests — A, B, C, D below, each judged
> after `toEditorDoc` / `hydrateRelations` have run over the endpoints'
> answers, so a value that reaches the database but not the screen fails).

- **Test A — TXT create parity**: apply `buildExampleTemplate()` + `images.1.*` in `mode=draft`; assert via `GET /products/:id/relations` `groups ≥ 1`, `values = file count`, `colors = file count`, `links = declared`, `images = file count`, `inventory_mode = OPTION` (file has option stock); via `GET /products-v2/:id` spec/labels/warranty/content/usage/transports/sale_types equal the file; DB row counts match; storefront and form agree.
- **Test B — first relation on update**: create via `POST products-v2` with no relations; apply TXT with `options.1..2`, `colors.1` linked, `images.1..2`; assert rows created, REL counts, and that the response `relations` block equals the read-back.
- **Test C — form-built product round trip**: build via form endpoints (2 groups, links, variants, images, costs, adjusts); export → parse → apply; assert group order, value sort per group, every price/adjust/cost/link/variant/image identical; `/parse` diff empty only when nothing changed.
- **Test D — semantics & guards**: omitted preserves (all groups); `__CLEAR__` clears scalars, csv, groups, image provenance; `__NULL__` refused on non-nullable (400) and nulls nullable; assistant admin cannot write cost on create, update, JSON or rows (owner GET unchanged, response stripped); deleting a value/colour/variant with `reserved>0` → 400 and rows intact; variant referenced by a live `order_items` row is never deleted; `catalogs` failure leaves no product row (atomic batch); unknown key → present in `unknown_keys` of `/apply`; `spec.<outside_family>` → needs_review; `price_history` and hashtag registry rows written; `verifyApplied` returns `mismatches=[]`.
- **Delivered beyond the sketch above**: a legacy product with zero relation
  rows really grows its first option / colour / images (B); the round trip is
  compared field-by-field over the WHOLE admin document and is a fixed point
  on the second pass (C); result honesty is proved with a D1 adapter that
  silently drops one relation statement, on create (no product left behind)
  and on update (refused, section named, the product id given), plus the same
  adapter throwing, which leaves the update byte-for-byte unchanged (D).
- **Regressions to keep green**: `tests/templateRoundTrip.test.ts` (43), `templateDownload` (19), `templateExportRelations` (10), `templateCostGate` (6), `productRelations` (19), `productModelLadder`, `productOverlayResilience`, `importCsv`, `inventory`, `orderInventory`, `pricingLadder`, `cheapestBase`, `warranty`, `usageGuide`, `hashtags`, `translateStore`.

### 5.6 Ordered delivery

1. Land `worker/lib/productPersistence.ts` (normalise → plan → commit) with unit tests; refactor `planRelationsWrite` to accept a snapshot so it can run before the product row exists.
2. Switch `/api/admin/template/apply` create and update to the contract; delete `hasRelationalStructure` and `applyCatalogs`; add `inventory_mode` derivation and the create-time §11 gate.
3. Add `verifyApplied` and the structured response (`unknown_keys`, relation summary, counts, `mismatches`).
4. Switch `products-v2` + `/relations` PUT and the CSV importer to the same contract (single batch each).
5. Schema/registry alignment: `name_ar/name_ckb` columns (or registry change), drop `compare_at_iqd`, `spec.*` validation, `option_id`/`option_ids` conflict error, `__CLEAR__` for image provenance, export ordering.
6. `products-v2` GET returns the overlay; `PricePreview` and save rehydration use one source.
7. ProductForm editors/read-only panels for labels, content blocks, spec groups, payment options, ar/ckb text; `localizeProductDoc` respects imported/approved translations; spec union rendering; catalog/warranty gating fixes.
8. ImportPanel: read-back counters, apply-time warnings/unknown keys acknowledgement, mismatch rows as failed.
9. Tests A–D + regressions; update `docs/FIELD_MAPPING.md` (generate it from `FIELD_REGISTRY`), `docs/TEMPLATE_GUIDE.md`, `docs/IMPORT_TEMPLATE.md`.

---

## 6. Repro inventory

All under `/tmp/claude-0/-home-user-Levonis/041d9bb7-5d80-5439-af4d-63c140a4adfc/scratchpad/txt/`; run with `cd /home/user/Levonis && npx tsx --test <file>`. They record observations (`# OBS …` TAP comments) rather than asserting the losses, so they pass today (run1.log: 9/9; run2.log: 7/7). No repository file was modified by them.

| Path | Scenarios | What it proved |
|---|---|---|
| `repro.test.ts` (547 lines) | A create; B legacy update; C1 TXT-born round trip; C2 form-born round trip; D1 counters/unknown/mismatched spec; D2 omitted/`__CLEAR__`/`__NULL__`; D3 assistant cost gate; D4 reserved/live-variant guards; D5 price_history + hashtags | A: `option_groups 0 option_values 0 colors 0 links 0 variants 0 images 0`, JSON `options 4 colors 1 images 3`, REL empty, `inventory_mode BASE`, storefront sells 3 options/1 colour/3 images; document half (descriptions, spec ×5, spec_groups, labels, 2 warranty plans, ops_policy, content block, usage guide, transports, surcharge, payment options, hashtags, refs, catalogs ×2) all stored and returned. B: update with 2 groups/3 values/1 colour/2 images on a rowless product → `warnings []`, rows 0. C2: group order flipped, value sort renumbered, `/parse` diff `[]`. D1: `unknown_keys` present at `/parse`, absent from `/apply`; `spec.made_up_field` stored, invisible in form. D2: semantics hold (400 `TEMPLATE_ERRORS` on non-nullable `__NULL__`). D3: assistant create stored cost; update kept product cost with warning. D4: `RELATIONS_VALIDATION`, rows intact. D5: `price_history 0` vs form `1`; hashtags not registered. |
| `applyVsForm.repro.test.ts` (89 lines) | A create read back through form APIs; C form-built product then TXT update | A: V2 `options 2 colors 2 media 1 spec_groups 1 labels 1 content_blocks 1 usage_steps 1`, REL `0/0/0/0/0`. C: relational update works (`values [ov_f1, ov_new]`, `colors [pc_new]`, `images 1`), JSON mirror also written, `price_history 0`. |
| `readback.test.ts` (100 lines) | TXT create → form endpoints; TXT update on form-built (relational) and on JSON-only product | Create: tables 0, REL 0, V2 populated. Update on JSON-only: `options.3 stock 4` + `images.1` → tables still 0. Update on relational: values `[Small null, Large 3]`, `inventory_mode BASE` despite option stock; V2 `doc.options` stale mirror; English-only option row refused `NEEDS_REVIEW name_ar is required`. |
| `extra.test.ts` (86 lines) | E owner opens TXT-born product in form and saves untouched; F assistant create numeric leak; G assistant update JSON-mirror cost | E: form saw 0 groups/0 images; save + relations PUT ok (0 rows); storefront still `options 3 media 3 selection [OPTION_REQUIRED, COLOR_REQUIRED]`. F: no cost numbers leak in responses but `product_cost 123456 / option 111222 / color 333444` stored. G: relational option cost kept (`280000`), JSON mirror option cost overwritten (`1`). |
| `run1.log`, `run2.log` | TAP output with every `# OBS` line | Evidence quoted above. |
| `fix.js`, `understand.js` | helper scripts used while building the repros | not evidence. |

The repros were the diagnosis. Their fixed form is in the repository and runs
in `npm run test:unit`: `tests/templateApplyParity.test.ts` and
`tests/templateParity.test.ts` (§7.1). The older template tests stay green and
keep the ground they always covered — `tests/templateRoundTrip.test.ts:20-24`
(in-process merge/bridge), `tests/templateExportRelations.test.ts` (export
side), `tests/templateCostGate.test.ts` (response stripping),
`tests/templateDownload.test.ts` (blank/example endpoints) — but none of them
is the parity proof any more; the two suites above are.


---

## 7. What was actually changed (post-fix record)

### 7.1 Root cause → what replaced it → the test that keeps it fixed

`AP` = `tests/templateApplyParity.test.ts` (the tables and the two admin
endpoints). `PA` = `tests/templateParity.test.ts` (the same journey, judged
after the client transforms `toEditorDoc` / `hydrateRelations` have run).

| # | What replaced it | Where | Proof |
|---|---|---|---|
| 1 | One shared persistence contract: `planProductSave` → `saveProductAtomic`, ONE `db.batch` for the row + groups + values + colours + links + images + variants + catalogs + price history + hashtags + translations. Create and update both go through it. | `worker/lib/productPersistence.ts` | AP «root cause 1»; PA TEST A (rows + client transforms) |
| 2 | `hasRelationalStructure()` is gone — a product with zero rows receives its first option, colour and image from a file. | `worker/routes/template.ts` | AP «root cause 2»; PA TEST B |
| 3 | `inventory_mode` has an owner: an explicit template key, else derived from where the stock is stated, by the same rule as `deriveInventoryMode` in the form. | `productPersistence.ts` · `worker/lib/template.ts` (`inventory_mode`) | AP «root cause 3»; PA TEST A/B |
| 4 | `GET /products-v2/:id` returns the overlay, so the document, the relation rows and the storefront describe one product; the form renders rows and falls back to the document exactly where the storefront does, and says so. | `worker/routes/adminProducts.ts` · `src/components/adminProducts/form/model.ts` | PA «root cause 4 (client)» |
| 5 | `product_option_values` and `product_colors` carry `name_ar` / `name_ckb`. | `migrations/0055_option_color_names.sql` | AP «root cause 5»; PA TEST A |
| 6 | `options.N.compare_at_iqd` / `colors.N.compare_at_iqd` are out of the registry: they are reported in `unknown_keys`, never parsed and dropped. | `worker/lib/template.ts` | AP «root cause 6»; PA TEST D |
| 7 | Image provenance clears: `alt_ar`, `alt_ckb`, `key`, `source_url` honour `__CLEAR__`, and an `alt_ar` equal to `alt_en` is stored instead of discarded. | `productPersistence.ts` | AP «root cause 7» |
| 8 | The §11 cost gate is inside the contract — create and update, product row, relation rows and JSON mirror alike — and a refused cost is reported under `preserved_fields` + `cost_refused`, never as applied. | `productPersistence.ts` · `worker/routes/template.ts` | AP «root cause 8»; PA «assistant admin cannot write cost» |
| 9 | A `spec.<id>` outside the section's template is stored, warned about, named in `spec_fields.outside_section`, and rendered by the form beside the section's own fields. | `worker/routes/template.ts` · `src/components/adminProducts/types.ts` | AP «root cause 9»; PA «root cause 9 (client)» |
| 10 | `localizeRespectingAuthored` keeps imported/approved Arabic and Kurdish; the form shows them (and the four editor-less groups) as preserved. | `productPersistence.ts` · `types.ts` (`importedTexts`, `preservedGroups`) | AP «root cause 10»; PA «root cause 10 (client)» |
| 11 | The answer is the read-back: relation counts, spec report, requested-vs-stored counters, `unknown_keys`, `warnings`, `mismatches`. A mismatch is `500 APPLY_VERIFY_FAILED` naming section and field; a failed create removes the product again. The import window reads only those numbers. | `worker/routes/template.ts` · `src/components/adminProducts/applyResult.ts` | AP «root cause 11»; PA TEST D (all three) |
| 12 | `price_history`, the hashtag vocabulary, `product_translations` and the relations audit are statements in the same batch. | `productPersistence.ts` | AP «root cause 12» |
| 13 | Export ordering is stable; export → parse → apply is a fixed point. | `worker/lib/template.ts` · `worker/lib/productRelations.ts` | AP «root cause 13»; PA TEST C |
| 14 | Catalogs and the dependent rows are inside the batch; a failure leaves no product, no relations, no catalogs, and releases the fingerprint. | `productPersistence.ts` | AP «root cause 14»; PA TEST D |
| 15 | The tests judge the database and the screen, never the parser. | `tests/templateApplyParity.test.ts`, `tests/templateParity.test.ts` | PA «root cause 15» (a TXT-built and a form-built product end up the same shape) |

### 7.2 Known limits that survive the fix (recorded, not hidden)

- **`colors.N.hex`**: the registry still describes it as “`#RRGGBB` or empty”,
  while the single save path requires a real code — the same rule
  `validateForm` applies in `ProductForm`. A file with an empty hex is
  **refused** with `400 RELATIONS_VALIDATION` naming `colors[0].hex` and
  nothing is written; it is never stored as a colour the form cannot show.
  Pinned by PA «a value the save path cannot accept is refused by name».
  Aligning the registry text with the writer is a documentation/registry
  change, not a persistence one.
- **`colors.N.option_id=__NULL__`** cannot unlink while an `option_ids` line
  is present on the same item: `option_ids` is the full link set and wins.
- **Pre-order transports on export**: the export deliberately writes all three
  methods, the undeclared ones `active=false`, so an admin can switch one on
  by editing the file. Applying an export therefore adds the inactive entries
  once; the product converges immediately and the second round trip is an
  exact fixed point. PA TEST C asserts both halves rather than waving it
  through.
- **Variants** are still carry-only: no template key creates one.
- **No editors** for `spec_groups`, `labels`, `content_blocks`,
  `payment_options`, `name_ar/ckb`, `description_ar/ckb`,
  `original_price_iqd` or catalog placement — they are rendered read-only as
  “preserved, edit via the TXT template”, which is what makes them visible
  rather than lost. Building the editors is a separate step.
- **The CSV/ZIP importer** shares the contract's planner and, since the second
  parity round, the contract's LOCALISER (`localizeRespectingAuthored`), so a
  CSV pass over a TXT-imported product no longer regenerates the Arabic and
  Kurdish the file authored. It still commits in two batches and still bypasses
  `planProductSave`'s cost-gate ordering, price-history and hashtag statements
  (`worker/routes/adminImport.ts`); routing it through the contract row by row
  is a separate step.

### 7.3 Contract changes a caller can see

- `POST /api/admin/template/apply` (200) gained: `relations`
  (`groups`/`values`/`colors`/`links`/`variants`/`images`/`primary_image`/`inventory_mode`),
  `spec_fields` (`stored`/`visible_in_form`/`outside_section`/`family`/`warnings`),
  `images` / `option_groups` / `option_values` / `colors` as
  `{ requested, stored }`, `mismatches`, `unknown_keys`, `cost_refused`,
  `price_history_rows`, `hashtags_registered`, `translation_review_needed`.
  Every number is read back after the batch; `requested` is `null` when the
  file asked for no structure at all (which is not “0 stored”).
- The refusal body of `APPLY_VERIFY_FAILED` carries `section`, `field`,
  `expected`, `stored`, `product_id`, `created` and `mismatches` **at the top
  level** (not under `details`).
- `POST /api/admin/template/parse` — and, since the second round,
  `POST /api/admin/template/parse-zip` per file — gained `spec_fields` and
  `inventory_mode`, and the import window RENDERS them beside the row action
  (`planLine`, `data-import-plan`), so the check step really does say what the
  apply will do with the spec sheet and the stock level before anything is
  written. `parse-zip` also gained `skipped_oversized`.
- The template gained the `inventory_mode` key and lost
  `options.N.compare_at_iqd` / `colors.N.compare_at_iqd`.

---

## 8. The second parity round (2026-09-08) — what four more reviews found, and what changed

§7 is the record of the first round: the fifteen root causes and the one
persistence contract that replaced them. This section is the record of the
SECOND round, which reviewed that contract itself under four lenses (parity,
semantics/safety, UI hydration, and the oversized-input surface). It found
nine defects the contract had introduced or still carried. Every fix is
pinned by `tests/productSaveParity.test.ts` (14 tests) unless another suite is
named; `npm run check`, `npm run test:unit`, `npm run build` and
`node scripts/migrate-check.mjs --twice` are green.

### 8.1 The JSON mirror is a derived artefact (HIGH ×2 — parity and UI)

`GET /api/admin/products-v2/:id` returns the relational overlay, so
`ProductForm`'s `doc.options / colors / media` were a COPY of the rows. The
form posted the whole document back, `serializeDoc` wrote that copy into
`products.options / colors / images`, and the rows were written by a SEPARATE
request that never touched the document. Delete the last option and colour and
save: the rows went to 0, the mirror still held them, `has_relations` turned
false, and the overlay fell back to the mirror — the admin GET and the
storefront both served the deleted structure again.

`planProductSave` now builds the mirror from `plan.relations.requested`,
through the same `applyRelations` the readers use (`plannedRelationsView` +
`applyPlannedMirror` in `worker/lib/productPersistence.ts`), whenever a
relations body is planned — including a relations-ONLY write (`PUT
/:id/relations`, which sends no document), which rewrites the three columns in
its own batch. When no relations body is present and the product has rows, the
stored mirror is carried forward rather than accepting the caller's copy.
`ProductForm` no longer sends `options` / `colors` / `media` at all.

Consequence recorded as a fixed point: the same two options and one colour now
leave an IDENTICAL `products` row whether they arrived from a TXT file or from
the form.

### 8.2 A form CREATE is one batch (HIGH — semantics; MEDIUM — parity)

`POST /api/admin/products-v2` had accepted an optional `relations` body since
the first round, and `ProductForm` never sent it: the row committed, then the
structure was refused independently, and «حُفظ المنتج، لكن تعذّر حفظ
الخيارات/الصور» left a product row the admin never meant to create alone —
while the TXT apply refused the whole thing and rolled its create back. The
form now posts the document and `relations: relationsToWire(rel)` together and
drops the second request; a refusal names the row (`refusalIssues`, shared with
the import window) instead of «Server error (400)», and the "the product IS
saved but the options failed" branch is gone because it can no longer happen.

### 8.3 Reserved inventory survives a group move (HIGH — semantics)

`product_option_values.group_id` cascades on `product_option_groups` and
`reserved` is a plain column with `DEFAULT 0`. The planner deleted groups
BEFORE upserting values, so moving a value into another group and emptying its
old one cascade-deleted the still-stored row and re-created it with `reserved`
back at 0 — units promised to live orders vanished from the counter, with a 200
and no warning, from the form's relations PUT and from an ordinary TXT edit.
The statement order is now: upsert the groups, upsert the values (which
re-points every kept row), THEN delete what is left. A kept value is never
deleted, so the writer cannot touch `reserved` or `stock` at all.

### 8.4 The VARIANT_COMBINATION guard judges what REMAINS (HIGH — semantics)

The guard read `variantInputs.length === 0 && snap.existingVariants.length === 0`,
which is satisfied by the very variants the save is about to delete: a product
could be stored in `VARIANT_COMBINATION` with zero variant rows, answering
`VARIANT_NOT_MODELLED` for every selection, reported as a success. It now
counts `variantInputs.length + retainedVariants.length` — what will remain.

### 8.5 `inventory_mode` preserves before it derives (MEDIUM — semantics)

An omitted `inventory_mode` re-derived the level from where the stock numbers
happened to be, so a body that said nothing about the mode could flip a stored
COLOR or OPTION product to BASE and silently change which level counts the
stock. The rule is now: a body that states a mode owns it; otherwise the stored
mode is preserved while the level it names still has rows; otherwise it is
derived AND a warning names the old level and the new one.

### 8.6 Named refusals, and D1's parameter limit (MEDIUM — semantics)

- A duplicate `products.sku` blew the batch up with `UNIQUE constraint failed`
  and answered «Something went wrong». `planProductSave` now checks it before
  planning and refuses `400 SKU_TAKEN` with `section: 'product', field: 'sku'`
  on BOTH paths; the UNIQUE index stays as the race backstop and both routes
  recognise it by name.
- The id-ownership and variant-SKU lookups built one placeholder per row plus
  the product id, so ≥100 option values or images produced a query D1 refuses.
  Both are chunked at 90 (`chunked()`), and a stated ceiling of 400 rows per
  collection replaces "discover it as a timeout".

### 8.7 The confirm-once answer stopped dropping the parser's keys (MEDIUM)

`repeatSubmission` answered 200 with hard-coded empty `unknown_keys`,
`applied_fields`, `cleared_fields` and `preserved_fields` — in precisely the
case where the admin never saw the first answer. It now echoes the re-parse.

### 8.8 Client hydration: an ar/ckb name equal to the English one (MEDIUM)

Root cause 7 was fixed on the server bridge but its twin survived in
`relationsFromDoc`, the fallback that hydrates a legacy JSON-only product: a
`name_ar` / `name_ckb` / `alt_ar` / `alt_ckb` equal to the English text was
dropped as a "fake translation", `relationsToWire` then sent `''`, and the
writer — which now honours an explicit clear — BLANKED the row being created
for the first time. In this catalogue an Arabic option name is routinely a
latin model token (`A1`, `0.4mm`). The equality test is gone.

### 8.9 The panel says what it means (MEDIUM ×2, LOW ×2 — UI)

- The word `outside` («visible in the form») labelled the ids the section's
  template does NOT show. A separate `outsideSection` word («خارج قالب القسم» /
  «outside the section template») now labels them.
- «أفرغ القيمة لحذف الحقل» is true: emptying an outside-template spec DELETES
  the key, and `storedSpecCount` counts only non-empty values.
- The English label slot of that block carries English, not Arabic.
- `payment_options` has ONE home (section 4), not two.

### 8.10 Smaller repairs (LOW)

- A failed create's rollback is guarded: the fingerprint is always released,
  the hashtag rows this apply registered go with it, and a
  `template.apply.rolled_back` audit row keeps the trail from describing a
  product that no longer exists.
- `loadLiveLines` distinguishes "this database predates 0023" (reads as no live
  lines, as documented) from any other failure, which now REFUSES a save that
  would delete a variant, option value or colour rather than deleting on an
  unevaluated guard.
- An option value or colour a live order names is deactivated instead of
  deleted, with the same warning variants already got — and the GROUP such a
  retained value belongs to is deactivated too, because deleting it would
  cascade over the row the retention just saved.
- `POST /parse-zip` filters entries in the central directory, so a non-`.txt`
  entry, an entry larger than `MAX_TEMPLATE_CHARS` uncompressed, and anything
  past `MAX_ZIP_FILES` are never inflated at all.
- The CSV importer uses `localizeRespectingAuthored`, so a CSV pass no longer
  regenerates Arabic and Kurdish a file authored (§7.2).
- The template path records an EMPTY nested `ar`/`ckb` slot as `missing`, and
  the form's localiser keeps such a slot empty while its English source is
  unchanged — an empty field is a stated absence, not a gap to fill. Top-level
  `name`/`description` are excluded: §3 requires the name to read identically
  in all three languages.

### 8.11 Reported and NOT changed

- **An omitted COLLECTION in a relations body is a full replacement with an
  empty list**, not a preserve. The module header claimed "omitted = preserve,
  at every level", which was false for `groups`, `colors`, `variants` and
  `images`. The header and `docs/FIELD_MAPPING.md` now state the real rule per
  level, and a test pins it. Making `undefined` mean preserve would have
  required loading and re-parsing the stored rows for four collections and
  would have changed the meaning of every existing caller's payload; the
  documented replacement is what all three callers already rely on.
- **Routing the CSV importer through `planProductSave` per row** (one batch,
  the cost-gate ordering, price history, hashtags). Only its localiser
  divergence — the actual data loss — was fixed; the two-batch commit stays
  recorded in §7.2.
