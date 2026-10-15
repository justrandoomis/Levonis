# Bambu Lab US store: source analysis for the Levonis catalog import

Reference for engineers building the one-time import from `https://us.store.bambulab.com`.
Everything here was observed on 2026-10-15 (store build id `8ee96d3a8`).

Files next to this document:

- `samples/*.json`: 8 trimmed fixtures. Each holds the product object, its description payload and the JSON-LD. Prices, compare-at prices, purchase limits and promotions have been removed.
- `collections.json`: all 458 collection handles, with titles where known, a group (type or marketing), listed counts and the taxonomy proposal.
- `products_sitemap.xml`: the 1,115 product URLs, already present.

---

## 0. Key facts (read first)

1. **The site has no `__NEXT_DATA__`.** It is a Next.js **App Router** site. The data comes as a React Server Components (RSC) "flight" stream, embedded as `<script>self.__next_f.push([1,"…"])</script>` chunks. There is also exactly one JSON-LD block, `<script id="product-jsonld" type="application/ld+json">`.
2. **The platform is no longer Shopify.** It is Bambu's own backend, with SPU/SKU naming. Old Shopify ids were kept for older products, so ids come in two shapes: 13–14 digits (Shopify era, e.g. `6945416380552`) and 18 digits (new platform, e.g. `581025672328126464`). **18-digit ids exceed 2^53. Treat every id as a string.** One product can mix both shapes. PLA Basic, for example, has variants `40475106640008` and `565815336288092161`.
3. **The product object** (called `P` below) is a plain JSON object inside the flight data. It contains the id, handle, title, options, variants, gallery, variant→image links and availability. **The description is not in `P`.** It is a separate RSC element, in one of 4 formats (§4).
4. **There is no SKU, barcode or GTIN on the product page.** `P.productSkuList[].skuCode` is `null` for all 134 sampled variants. JSON-LD `hasVariant[].sku` is just the variant id. Real SKU codes (`RSP001`, `B-SA001`, `FAP027+FAP028+SCA003` …) appear only in the cross-sell payload for *other* products (§3.9).
5. **Variant→image mapping is 100 % reliable as a link, but it is not unique per variant.** All 134 variants point to an image that exists in the gallery. However, the 134 variants map to only 86 distinct images. For example, PLA Basic *Black Refill* and *Black with spool* share one image (§7).
6. **Breadcrumbs and category names are not server-rendered.** You get only a category id path, `P.currentAllIdRoute` (e.g. `552709755819347968>552709755857096704>552709755890651136`). Those ids are still the most reliable product-type signal available (§8).

---

## 1. Access and crawling

| Item | Observation |
|---|---|
| robots.txt (`User-agent: *`) | Disallows include `/cart`, `/carts`, `/checkout(s)`, `/account`, `/orders`, `/search`, `/policies/`, `/collections/*sort_by*`, `/collections/*+*` (and `%2B`), `*/collections/*filter*&*filter*`, `/recommendations/products`, `/coupon-products/`, `/a/downloads/-/*`, `/*?*oseid=*`. `Crawl-delay: 10` appears only for AhrefsBot/MJ12bot; we used ≥11 s for everything. `Claude*` user agents get the same disallow list (not a full block). `Allow: /llms.txt`. |
| Sitemaps | `/sitemap.xml` → `sitemap_products_1.xml` (1,115 URLs), `sitemap_collections_1.xml` (458), `sitemap_pages_1.xml` (9). |
| Bot protection | No challenge on `us.store.bambulab.com` with the `LevonisCatalogImport/1.0` UA: 46/46 requests returned 200 or 301. `bambulab.com` returns a Cloudflare 403 "Just a moment…"; we did not touch it. |
| Response | `text/html`, brotli, `cache-control: private, no-store`, about 1.0–1.6 MB uncompressed (~100–145 KB on the wire). `x-middleware-rewrite: /en/products/<handle>`. About 160 KB of every page is the i18n `messages` bundle, which is embedded twice. |
| RSC-only fetch | Sending the same URL with the header `RSC: 1` returns `text/x-component`: the bare flight stream (561 KB for filament-buffer) in the same row format. It is easier to parse but no smaller on the wire. Either form works with the parser below. |
| Locale | Everything is `en` / USD. `<link rel="alternate" hreflang>` points to `uk.`, `au.` … stores with the same handles. |

---

## 2. Parsing recipe (flight data → objects)

```text
1. html → for each <script>self.__next_f.push(ARR)</script>: ARR = JSON.parse(ARR); if ARR[0]==1: buf += ARR[1]
2. split buf (as UTF-8 bytes) into rows:  <hexId>:<payload>\n
      payload "T<hexLen>,<raw bytes>"  → text row of exactly hexLen BYTES (no trailing \n). Used for long HTML strings.
      payload "I[...]"                 → client-module import (component reference, ignore)
      otherwise                        → JSON value
3. resolve string references recursively:
      "$<hex>"        → value of row <hex>   ("$<hex>:a:b" = path into it)
      "$L<hex>"       → lazy row <hex> (same thing for data; for element *types* it names a client component)
      "$$…"           → literal string starting with "$"
      "$undefined"    → null ;  "$D<iso>" → date string
   React elements are arrays ["$", type, key, props].
4. product object P = the object having keys {id, seoCode, name, productSkuList, productPropertyList, mediaFiles}.
   It appears twice by reference: props.data of the buy-box element
   (props also contain lowPriceSku, relationProducts, sku, propertyList, actuallySelectPropertyList …)
   and props.product of the element {name:<handle>, product, sku, type, …} inside <div class="shopify-section">.
   Row ids differ per page, so always locate P by its shape, never by row id.
```

Working reference implementation (Python, no dependencies): `scratchpad/bambu_tools/rsc.py`, `resolve.py`, `extract.py`, `analyze.py`.

---

## 3. Field reference (`P` = resolved product object)

### 3.1 Identity and naming

| Need | Path | Example / notes |
|---|---|---|
| Product id | `P.id` | `"7706060161160"` (A1, Shopify era) / `"581025672328126464"` (H2D). Equals JSON-LD `productGroupID`. |
| Handle | `P.seoCode` | `"a1"`. Stored **percent-encoded** for non-ASCII handles: `"usb%E2%80%91c-soldering-iron-kit-for-heat-set-inserts"` (U+2011). |
| Canonical URL | `P.seoUrlHandle` | `"https://us.store.bambulab.com/products/a1"`. Prefer this to `<link rel=canonical>` (§11). |
| Title | `P.name` | `"Bambu Lab A1 3D Printer"`. `P.subTitle` was `null` or empty in all samples. |
| SEO | `P.seoTitle`, `P.seoMetaDescription` | Meta description = JSON-LD `description`. The HTML `<title>` = `<seoTitle> \| Bambu Lab US Store`. |
| Vendor / brand | not in `P` | JSON-LD `brand.name` = `"Bambu Lab"` on every product. |
| Product type | no string field | `P.type` = `1` everywhere (not useful). `P.isFilament` (bool) is true only for filaments. Use `P.currentAllIdRoute` (category id path, §8). |
| Feature bullets | `P.productFeaturesModuleList[0].content` (HTML `<ul>`), title `P.productFeaturesTitle` | Present on printers and filaments; empty on most parts. |
| Videos | `P.externalVideoLinkList[]` | YouTube embed URLs (A1: 8). `[""]` when there are none. `P.productExtraInfoVO.productVideoVOList` was `null` everywhere. |
| MakerWorld models | `P.showMwModelIds[]` | Example: PLA Basic → 10 MakerWorld model ids. |
| "New" flag | `P.newFlag` (0/1) | |

### 3.2 Options (option names and values)

`P.productPropertyList[]` (ordered by `position`):

```json
{ "propertyKey": "Color", "propertyKeyId": "9000351531144", "type": 1, "title": "", "position": 1,
  "introduction": null, "explanation": null,
  "productPropertyValueList": [
    { "id": "564681938135969792", "value": "Jade White (10100)", "selectedDefault": 1, "newFlag": 0,
      "colorUrl": "https://store.bblcdn.com/s7/default/825e…/Rectangle_1279.jpg",
      "propertyValueMediaFile": null, "tag": "" } ] }
```

- `type: 4` with `title: "3D Printer"` marks the printer configuration option (`"Variant"`: `A1` / `A1 Combo` / `A1 Combo Print with Care Bundle`). Every other option had `type: 1`.
- Option names are free text and can be whole questions. AMS 2 Pro has *"Select the type of printer you plan to use the AMS 2 Pro"* × *"How many AMS 2 Pro unit(s) do you plan to connect to your printer"*.
- Values can carry manufacturer codes: filament colour codes `"Black (10101)"`, Maker's Supply item codes `"Manta ray automato - ZH133"`.
- `propertyValueMediaFile` was `null` for all values in the sample, so images are linked through variants (§3.4).

### 3.3 Variants

`P.productSkuList[]`:

| Need | Path | Notes |
|---|---|---|
| Variant id | `.id` | String; also used in `?id=<variantId>` URLs (JSON-LD `offers.url`). |
| Option values | `.productSkuPropertyList[] {propertyKey, propertyKeyId, propertyValue, position, colorUrl}` | Join to options by `propertyKeyId` + value text. `propertyValueId` was always `null`, so you must match on the **value text**. |
| SKU code | `.skuCode` | **Always `null`** (134/134). |
| Barcode / GTIN | none | No field anywhere in `P` or the JSON-LD. |
| Availability | `.isSoldOut` (bool), `.outOfStockMsg` (`""` / `"Sold Out"` / `"Restocking"`), `.eta`, `.requiresNotify` (0/1), `.addFlag`, `.saleTime` | Also JSON-LD `hasVariant[].offers.availability` (`InStock`/`OutOfStock`). |
| Variant notes | `.description` (HTML or `""`) | Variant-specific copy, e.g. H2D Laser *"Laser module(s) will be shipped in separate boxes."*, A1 bundle *"Add only $50 to the A1 Combo …"* (**may contain prices; scrub it**). |
| Bundle components | `.subProductSkuSimpleList`, `P.subProductList` | `null` in every sample, bundles included. Bundle contents exist only as description text. |
| **Do not import** | `price`, `discountPrice`, `discountOffText`, `gradientDiscountSkus`, `flashSaleVO`, `priceExplanation`, `pointsInfo`, `minimum`, `maximum`, `quantityLimitType/Value`, `productSkuPreSale`, `productSkuBuyAndGetVO` | Removed from the fixtures. |

### 3.4 Per-variant image

`P.productSkuList[].mediaFile = {resourceFileId, url}`. It always matches an entry in `P.mediaFiles[]` on **both** `resourceFileId` and `url` (134/134). JSON-LD `hasVariant[].image` = the same URL.

### 3.5 Gallery

`P.mediaFiles[] = {resourceFileId, url}`. **That is all.** There is no alt text, no width/height, no position (array order is the display order) and no media type. The storefront uses `P.name` as `alt`. `resourceFileId` is a 14-digit Shopify-era id or an 18-digit new id. The sitemap `<image:loc>` equals `P.mediaFiles[0].url` (22/22).

### 3.6 Colour swatches

`P.productPropertyList[k].productPropertyValueList[].colorUrl` is repeated in `productSkuPropertyList[].colorUrl`. It is a **swatch image**, not a hex value: a 128×128 PNG/JPG, sometimes with a `.media` extension served as `content-type: multipart/form-data`, so sniff the bytes. **There is no hex on the product page.** Hex sources:

- the PLA Basic "Hex Code" PDF (`…/Bambu_PLA_Basic_Hex_Code.pdf`, in the page-builder Download block);
- the colour-family filter on `/collections/bambu-lab-3d-printer-filament` (`filters[label=Color].values[] {label, value, hex:[…]}`, e.g. Black `#000000`). This is generic, not per product.

### 3.7 Category, breadcrumbs, collections

- `P.currentAllIdRoute`: backend category id path, 1–3 levels, separated by `>`. **There are no names on the page.** §8 maps the ids seen so far.
- Breadcrumb elements carry only the product name: `{text: P.name}` and `{fallbackLabel: P.name}`. Category labels are resolved client-side.
- The product page carries **no collection membership**. Membership can only be read from collection pages (§8).

### 3.8 JSON-LD (`script#product-jsonld`)

`ProductGroup {name, description (= P.seoMetaDescription), url, brand.name, productGroupID (= P.id), hasVariant[] {sku (= variant id!), image (= variant mediaFile.url), name ("<P.name> - <values joined ' / '>"), offers {url "<canonical>?id=<variantId>", availability, itemCondition, price, priceCurrency, priceSpecification(strike-through)}}}`.
It contains nothing that `P` lacks. Use it only as a cross-check.

### 3.9 Where SKU codes do exist (cross-sell payload)

The buy-box props hold `relationProducts.randomBuyRangeGroupList[]` (add-on groups) → `spuList[]` / `skuList[]` → `productSku {id, productId, name, skuName, seoCode, skuCode, status, image, productSkuPropertyList, subProductSkuList, subSkuSimpleList, …}`. 163 distinct SKUs with codes appeared across the sampled pages, for example:

- `bambu-reusable-spool` Low Temp → `RSP001`
- `mag-alloy-scraper` → `B-SA001`
- `cutting-essentials-refill-pack` → `FAP027+FAP028+SCA003` (a bundle shown as its component codes)
- `pebbled-pu-leatherette-fabric` Black → `B-YD001`

This payload **also carries `trackingQuantity`/`availableStock` (inventory) and prices: do not import those.** It only covers products that appear as add-ons, so it is not a complete SKU source.

---

## 4. Description: four formats (find them in this order)

| Kind | How to detect | Where the content is | Seen on |
|---|---|---|---|
| **A. legacy_html** | element with props `{description: <html>, isOldVersion: true}` (inside `div.shopify-section`) | `props.description`: one HTML string (often a `T` text row) using the `pct_*` CSS template: `<h3 class="pct_st">Overview</h3>…<h3>Compatibility</h3>…<h3>In the Box</h3>…<table class="pct_tb">` | spare parts, plates, hotends, AMS lite, A1 mini, P1S, kits (12/22) |
| **B. sections_html** | element with props `{sections:[{id,name}]}` followed by `<section id=…>` children, each containing an element with props `{description: <html>}` | one HTML string per named section: `Overview`, `Product Specifications`, `User Instructions`, `In the box`, `WARNING`, `Comparison` … | long-nose pliers, soldering iron kit, build-plate combo, manta-ray model (4/22) |
| **C. page_builder** | element with props `{config:{schemaVersion:"1.0", templateId, components:[…]}}` | JSON component tree: `components[] {id, type (banner/chapter/content_block), variant, name, anchor{enabled,name}, modules{typeStyles.content{title,description}, media{pc,mo}, featureConfig{items[]}}, children[]}`. Downloads live in the component named `"Download"`: `modules.featureConfig.items[] {description:"Filament TDS", link:"…pdf"}`. FAQ is `content-block-21-pro`. | PLA Basic, PLA-CF (filaments) |
| **D. bespoke React tree** | (D1) a lazy row containing `shopify-section-template--…__product_description_<kind>_<id>` divs (port of the old Shopify theme); (D2) element `{sections:[{id,label}]}` (`overview/specs/instruction/faq`) followed by product-specific client components | fully server-rendered element tree. Text comes from the i18n `messages` bundle (e.g. `messages.production["A1 Description"]`, `messages.production.H2D`, `messages.AMSPro`, `messages.AMSHT`) | A1 (D1); H2D, refurbished H2D, AMS 2 Pro (D2) |

For D, flatten the element tree: take text children, `dangerouslySetInnerHTML.__html`, `td`/`tr`, and `img src`/`data-src`. D1 section kinds seen: `grip`, `pic_and_text`, `special` (spec table), `unboxing`, `what_is_in_the_box`, `youtubers`, `faq`.

Description HTML quirks to clean:
- Every `<img alt>` in `pct` templates is the placeholder `图片加载失败文案` ("image failed to load"). Drop it.
- Comments are in Chinese (`<!-- 卖点1 -->`).
- Inline `<style>` blocks and `<button id="paste-helper-id">` junk.
- Links are relative (`../../../products/bambu-engineering-plate`) or absolute store links with Shopify-era `?id=41588992999539&_pos=1&_sid=…&skr=yes`. There are also `e.bambulab.com/t?c=…` tracking links, `makerworld.com` links and `.zip` model downloads. Rewrite or strip all of these.

---

## 5. Specs, documents, in-the-box, compatibility, weights

| Data | Where | Path / example |
|---|---|---|
| **Specs table** | A: `<h3>Product Specification(s)</h3>` followed by `<table class="pct_tb">` with **4 cells per row = 2 key/value pairs** (`Voltage \| 24V \| Electricity \| Below 10mA`). Some tables are compatibility matrices with `rowspan` (hotend/plate glue matrix). B: section `"Product Specifications"` / "Basic Information" (2-column). D1: section `product_description_special` (`<table>` Item / Specification, with `rowSpan`). D2 H2D: client component props `{link:"…/TDS.pdf", collapseTable:"$…", notCollapseTable:"<table>…"}`; the HTML is also in `messages.production.H2D["Specs Table No Collapse 110V"]` (US). D2 AMS 2 Pro: rendered client-side from `messages.AMSPro.SpecificationTable` (key/value object: `dimensionsValue: "372*280*226 mm³"`, `netWeightValue: "2.5 kg"`, …) plus props `{dtsLink:"…/AMS_2_Pro-EN.pdf"}`. C (filaments): **no spec table on the page**. Specs are only in the TDS PDF. | Spec keys found: printers ~18–19 rows; spare parts 4–6 (Color, Materials, Packaging Weight, Packaging Size). |
| **Documents** | C: Download block (PLA Basic: TDS, SDS, RoHS, Hex Code, SVHC, CP65, EN71-3, TSCA, PAHS, POPs = 10 PDFs). A/B: `<a href=…pdf/zip>` in the HTML (P1S tech-spec PDF, A1 starter kit `A1_Spec_EN_1214.pdf`, Maker's Supply `.zip` 3D models). D2: `link` / `dtsLink` props. `P.productExtraInfoVO.productFileList` exists but was `null` in all 22. A1's own "Download A1 TDS" is a `<button>` with **no URL** in the data. | Hosts: `store.bblcdn.com/s1|s3|s7/…`, `store.bblcdn.com/4731f4c55a/…`, and legacy `cdn.shopify.com/s/files/1/0573/5320/7868/files/…`. |
| **Wiki links** | in description HTML / FAQ / page-builder text | e.g. `https://wiki.bambulab.com/en/general/filament-guide-material-table` (hotends, AMS lite), `…/a1/manual/faq`. |
| **In the box** | A: `<h3>In the Box</h3><p>Filament buffer, 2x M3*21.5 screws</p>`. B: section `"In the box"`. D1: `product_description_what_is_in_the_box` (items = `img[data-src]` + `div.witb-item-name`; a second block for "Combo Add-ons"). D2 AMS 2 Pro: images whose `alt` is the item name. C (filament): none (only a gallery photo `In_the_Box_3.jpg`). | 16/22 sampled pages had one. |
| **Compatibility / works with** | (1) option values: `Compatibility`, `Printer Model`, AMS 2 Pro printer question (variant-level, best signal); (2) A: `<h3>Compatibility</h3>`; (3) spec rows ("Supported Filament", "Build Plate Surface Compatibility"); (4) the wiki filament material table (§9). | Textured PEI plate: `Printer Model` = A2L, X2D, P2S, H2C, H2S, H2D, A1, A1 mini, P1 Series, X1 Series. |
| **Weights / dimensions** | **Only free text in spec tables**: `Package weight 50 g`, `Package size 109*55*33 mm`, A1 `Net weight 8.3 kg, Gross weight 13 kg`, AMS 2 Pro `netWeightValue "2.5 kg"`. No structured field. `og:image:width/height` is hard-coded `800×600` (wrong). | Parse with a units regex if shipping weights are needed. |

---

## 6. Coverage sample (22 products, 134 variants, 166 gallery images)

`type` = first segment of `currentAllIdRoute` (§8). `var/matrix` = variants present / options' Cartesian product. `imgs` = gallery size. `v-imgs` = distinct variant images. Collections are those whose first page (12 items) listed the product.

| handle | type | option groups (values) | var/matrix | imgs | v-imgs | desc | specs | docs | in-box | sold-out var | collections seen |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `a1` | machine | Variant(3) [type 4] | 3/3 | 10 | 3 | D1 | yes (D1 table) | button w/o URL | yes | 0 | 3d-printer |
| `a1-mini` | machine | Variant(2) | 2/2 | 7 | 2 | A | yes | 1 | yes | 0 | 3d-printer |
| `p1s` | machine | Variant(3) [type 4] | 3/3 | 8 | 3 | A | yes | 2 | yes | 0 | 3d-printer |
| `h2d` | machine | Variant(3); Option(6) | 6/18 | 17 | 5 | D2 | yes (props HTML) | TDS | yes | 0 | 3d-printer, laser-crafting |
| `refurbished-bambu-lab-h2d-3d-printer` | machine | Variant(1) | 1/1 | 7 | 1 | D2 | yes | TDS | yes | **1 (Restocking)** | 3d-printer, refurbished-3d-printers |
| `bambu-lab-a1-combo-starter-kit` (bundle) | machine | Variant(1) | 1/1 | 7 | 1 | A | yes | 1 | yes | 0 | – |
| `ams-2-pro` | machine | printer question(7); units question(6) | 15/42 | 8 | 3 | D2 | yes (i18n) | 1 | yes | 0 | all-ams |
| `ams-lite` | machine | Compatibility(1) | 1/1 | 4 | 1 | A | yes | 0 | yes | 0 | all-ams |
| `ams-2-pro-feeder-unit` (AMS spare) | spare part | Compatibility(1) | 1/1 | 6 | 1 | A | yes | 0 | yes | 0 | – |
| `filament-buffer` | spare part | Compatibility(1) | 1/1 | 4 | 1 | A | yes | 0 | yes | 0 | – |
| `front-housing-assembly-x1-series` | spare part | Compatibility(1) | 1/1 | 2 | 1 | A | yes | 0 | yes | 0 | – |
| `pla-basic-filament` | filament | Color(30); Type(2); Size(1) | **43/60** | 32 | 30 | C | TDS only | 10 | no | **1 (Beige Refill)** | bambu-lab-3d-printer-filament, sale |
| `pla-cf` (speciality CF) | filament | Color(7); Type(2); Size(1) | **9/14** | 12 | 7 | C | TDS only | 4 | no | 0 | pla |
| `bambu-hotend-a1-a2` | accessory | Printer Model(3); Size(5) | 15/15 | 7 | 5 | A | yes | 0 | yes | 0 | – |
| `hotends-combo-h2-series` (bundle) | accessory | Compatibility(1); Type(9) | 9/9 | 9 | 9 | A | yes | 0 | no | 0 | – |
| `bambu-textured-pei-plate` | accessory | Printer Model(10) | 10/10 | 5 | 4 | A | yes | 0 | no | 0 | accessories |
| `build-plate-combo` (bundle) | accessory | Compatibility(4); Combo Type(2) | 8/8 | 4 | 4 | B | yes | 0 | no | 0 | accessories, sale |
| `maker-s-supply-long-nose-pliers` (tool) | accessory | Item(1) | 1/1 | 4 | 1 | B | yes ("Basic Information") | 0 | no | 0 | – |
| `usb%E2%80%91c-soldering-iron-kit-for-heat-set-inserts` (tool) | accessory | item(1) | 1/1 | 4 | 1 | B | yes | zip | yes | 0 | – |
| `makers-supply-electronics-bundle` | maker's supply | Size(1) | 1/1 | 2 | 1 | A | yes | zip | yes | 0 | – |
| `wireless-charger-kit-k012` | maker's supply | Type(1) | 1/1 | 4 | 1 | A | yes | zip | yes | 0 | – |
| `manta-ray-automaton` (model kit) | maker's supply | Item(1) | 1/1 | 3 | 1 | B | yes | 0 | yes | 0 | – |

Products seen in more than one collection (first pages only):

| product | collections |
|---|---|
| `h2d`, `h2s`, `h2c`, `a2l` | 3d-printer + laser-crafting |
| `pla-basic-filament`, `pla-matte`, `pla-silk-upgrade` | filament + sale |
| `pla-pure` | filament + sale + new-arrivals + pla |
| `build-plate-combo`, `multi-size-hotends-kit` | accessories + sale |
| `rotary-attachment` | accessories + laser-crafting |
| `laser-material-kit-%E2%80%93-starter-pack-for-h-series` | bambu-material + laser-crafting |
| `pla-basic-beginner-s-filament-pack` | bundles + pla |

Bundles: none of the sampled bundles (starter kit, hotends combo, build-plate combo, electronics bundle) exposes structured components. Contents appear only in the description and the variant `description`.

---

## 7. Variant → image mapping: how it works and how reliable it is

The mechanism is `variant.mediaFile.resourceFileId` → `P.mediaFiles[i].resourceFileId`. It was verified for 134/134 variants: always present, always in the gallery, URLs identical.

The image belongs to **one option dimension only** (colour, nozzle size, plate size …). So:

| Example | Variants | Image |
|---|---|---|
| PLA Basic **Black Refill** `40988815556744` and **Black with spool** `41078274654344` | 2 | same `32186496942216` (`PLA-Basic_Black_….png`, gallery #31) |
| PLA Basic **Jade White Refill** `40475106640008` and **with spool** `41078274687112` | 2 | same `756356718673268736` (`PLA_Basic_White.jpg`, gallery #0) |
| PLA-CF **Black spool** `41003202248840` and **Black Refill** `42831855747208` | 2 | same `PLA-CFBlack.jpg` (gallery #8) |
| Hotend `A1 / 0.4mm Hardened Steel`, `A1 mini / 0.4mm …`, `A2L / 0.4mm …` | 3 | same image (gallery #2). The image tracks Size and ignores Printer Model. |
| Textured PEI plate: A1, P1, X1, P2S, X2D | 5 | `FAP033.jpg`. H2D/H2S → `FAP025.jpg`; A1 mini → `FAP009.jpg`; A2L/H2C → `FAP035.jpg` (the image tracks plate size). |
| H2D Laser Full Combo 10 W and 40 W | 2 | same `H2DL-10w-compressed.jpg` |
| AMS 2 Pro: 13 of 15 variants | 13 | gallery #0. Only the two "Bundle Deals" variants have their own image. |

**Verdict:** you can rely on the mapping to choose the variant's hero image. You cannot rely on it to tell variants apart: Refill and Spool look identical. Galleries also contain images no variant uses (PLA Basic #1 `PLABasic.jpg`, #2 `In_the_Box_3.jpg`; plate `Textured_Surface_1600.png`). Galleries can hold the same file twice under different ids (A1: `A1-compressed.jpg` at #0 and #3; H2D: 5 duplicate file names), so de-duplicate by content (S3 `ETag`).

---

## 8. Collections and taxonomy

The full list (458 handles, 86 with titles, group and subgroup for every handle) is in `collections.json`. The collections sitemap carries **only handle + lastmod**. Titles come from these sources, each marked in `title_source`:

- collection pages: `productSeriesName`, 16 fetched;
- the navigation;
- `llms.txt`;
- filter labels whose slug equals a handle.

The other 372 handles have only a `title_guess`.

Collection page data: the object `{id (category id), productSeriesId (Shopify-era 12-digit or new id), productSeriesName (= title), seoTitle, seoMetaDescription, seoUrlHandle, seoCode (= handle), bannerContent, productFilterOptionList[] {label, type, optionVariantJson}}`. The product grid is `{productList[12], total}`. Pagination is client-side, and only page 1 is server-rendered. `optionVariantJson` lists sub-collections as `{label, value: productSeriesId}`, which is where the sub-collection titles come from.

**Group counts (458 handles):** spare_parts 145 · makers_supply 123 · marketing 57 · laser_materials 39 · filament 29 · accessories 24 · legacy single-product 20 · printers 8 · seo_landing 6 · ams 3 · laser_cutting 3 · system 1.

**Proposed Levonis product types**, with counts. "Listed" is the `total` of the fetched top-level collection. "Sitemap est." is a title heuristic over the 1,115 sitemap URLs.

| Type | Source collections | Listed | Sitemap est. | Sub-types |
|---|---|---|---|---|
| 3D Printers | `3d-printer` (+ `a1-series`, `p-series`, `x1-series`, `h2-series`, `refurbished-3d-printers`) | 14 (5 refurbished) | 18 (10 new, 5 refurb, 3 starter kits) | Standard/Combo is an **option**, not a product |
| Laser cutter | `laser-cutter-engraver`, `laser-crafting` | 12 (mixed) | 1 (R1) | |
| AMS | `all-ams` | 4 | 4 | |
| Filament | `bambu-lab-3d-printer-filament` | 51 | 46 | PLA (19 listed), PETG, ABS/ASA, TPU, PC, PA/PET, PPS, Support, Fiber Reinforced; Refill/Spool is an option |
| Accessories | `accessories` | 71 | 47 + part of 142 unclassified | Build Plate, Hotend, Upgrade Parts, Workflow, Consumables, Bundle, Cutting Parts, Laser Parts, Tools |
| Spare Parts | `spare-parts` | 201 (AMS alone 24) | ~470 | by machine × part group |
| Laser & cutting materials | `bambu-material` | 42 | 40 | wood, acrylic, PU, paper, vinyl, metal …; thickness; laser vs blade |
| Maker's Supply | `makers-supply` | 356 (Model Kits 140, CyberBrick 58) | ~347 | Model Kits, CyberBrick, Hardware, Electronics, Combo Kits, MakerLab Accessories |

The 7 disjoint listed totals sum to **739**, while the sitemap has **1,115** URLs. Many reachable products are not counted in the grids (spare parts especially; `front-housing-assembly-x1-series` is live, in stock and not in the first page of any grid fetched). **Recommendation:** import every sitemap URL. Assign each product its type from `currentAllIdRoute` level 1 (and level 2 for the sub-type). Use collections only for naming and for marketing tags. The route ids seen so far:

| route id | meaning (inferred) | level-2 ids seen |
|---|---|---|
| `552709755391528960` | machines (printers + AMS) | `552709755571884032` A1 series, `552709755467026432` P1, `666870992645718016` H2, `552709755685130240` AMS |
| `552709755819347968` | filament | `552709755857096704` PLA (L3 = product line) |
| `552709757765505024` | accessories | `552709757794865152` plates, `552709757979414528` hotends, `750510267545833472` tools (incl. "Maker's Supply"-branded tools) |
| `552709758222684160` | spare parts | `552709759099293696`, `552709760676352000` (X1/P1), `581730574607491072` (AMS 2 Pro) |
| `552709760852512768` | Maker's Supply | `552709760911233024` kits/models, `552709760978341888` electronics |

The title heuristic agreed with the route type for 19 of the 22 sampled products. The three misses were filament-buffer, manta-ray-automaton and the soldering-iron kit, which is why the heuristic counts above are only estimates.

**Non-type collections:**

- **Marketing** (57): `sale`, `*-sale`, deals, seasonal, `new-arrivals`, `best-seller`, curated landings, MakerLab app landings. Map these to tags, or drop them.
- **SEO landings** (6): `fdm-3d-printer`, `fully-enclosed-3d-printer`, `corexy-3d-printer` … These are printer attributes.
- **Legacy one-product collections** (20, e.g. `servo-motor-1`): ignore.
- `frontpage`: ignore.

---

## 9. Wiki enrichment (wiki.bambulab.com: Wiki.js, server-rendered HTML, robots.txt empty)

| Product | Reachable how | What the wiki offers |
|---|---|---|
| **A1** | Store FAQ links `wiki.bambulab.com/a1/manual/faq`, `…/unboxing-a1-combo`; hub `/en/a1` | The hub is a link list with **no spec table** (specs live on bambulab.com, which is challenge-blocked). `/en/a1/manual/acc-in-the-box` has a **structured packing-list table** (`No. \| Photo \| Description \| Application`, 21 rows, combo-only rows marked) and a 2-column non-combo/combo list. Useful for "In the box". No TDS link. |
| **PLA Basic** (filament) | Page-builder links to `/en/filament-acc/filament/dry-filament`; hub `/en/filament-acc` → `/en/filament/pla`, `/en/general/filament-guide-material-table` | `/en/general/filament-guide-material-table` has **structured tables per filament family**: nozzle compatibility (0.2/0.4/0.6/0.8, high-flow), hardened-steel requirement, **nozzle temperature range** (PLA 190–240 °C, PLA-CF 210–240 °C …), open/enclosed printer suitability, AMS / AMS lite compatibility. `/en/filament/pla` adds drying settings per product line (oven/heatbed/AMS 2 Pro) and impact strength (PLA Basic 13.8 kJ/m²). No TDS PDFs on the wiki; the TDS is on the store CDN. |
| **Bambu Hotend** (nozzles) | Hotend description links `/en/general/filament-guide-material-table`, `/en/a1-mini/maintenance/toolhead` | `/en/filament-acc/acc/nozzles` has a **nozzle-diameter table** (use case, layer heights, drawbacks) and a **material table** (hardened vs stainless steel, applicable filaments). |

Conclusion: the wiki is a good source of **compatibility and print-settings enrichment** for filaments, nozzles and plates. It is not a source of product specs or TDS files. Pages are English-first with `/zh/` mirrors (no Arabic or Kurdish).

---

## 10. Images

| Item | Finding |
|---|---|
| Hosts | `store.bblcdn.com` (CloudFront → S3, `server: AmazonS3`, `lambda-edge` resizer). Path families: `/s7/default/<32hex>/<original-filename>` (gallery, swatches, most media), `/s1/…` (description images, PDFs), `/s2/…` (logos), `/s3/…` (PDFs), `/4731f4c55a/<32hex>/<name>` (bespoke-page media incl. `.mp4`), legacy `/<32hex>.webp` (old Shopify theme, served as `application/octet-stream`), `cdn.shopify.com/s/files/1/0573/5320/7868/files/…` (legacy PDFs/zips still linked). **Ignore `store-test.bblcdn.com`**, which appears in page-builder `image.src`; use `media.pc.src` / `media.mo.src` instead. |
| Size parameters | The storefront appends `__op__resize,m_lfit,w_<W>__op__format,f_auto__op__quality,q_<Q>` to the path. **The original is the URL without the suffix**, which is exactly what `P.mediaFiles[].url` holds. `w_750` returned 700×700 from a 1600×1600 original, so widths are bucketed. Don't rely on exact sizes; download originals. |
| Typical originals | Gallery: JPEG 1600×1600 (332 KB), progressive JPEG 2400×2400 (257 KB, `*-compressed.jpg`), PNG 2800×2800 RGB (1.2 MB). Swatch: 128×128 PNG (103 B, `.media` extension). Bespoke banners up to 7680×2400 (declared in props). Description images: webp 768×576 (legacy). Square aspect ratio for all gallery images seen. |
| Dimensions in data | None for the gallery. Page-builder media carries `naturalWidth/naturalHeight`; bespoke `Image` props carry `width/height`. |
| Variant image in gallery? | Yes, 134/134 (§7). |
| Id stability | `resourceFileId` + URL are stable per upload. Shopify-era ids (14-digit) survived the platform migration: the filament-buffer PNG has S3 `last-modified: 2025-01-06`, yet its id is still `30390683533448`. Replacing an image creates a **new id and a new URL**: PLA Basic Jade White is now `756356718673268736`, S3 last-modified 2026-07-22. Key images on `resourceFileId`, and de-duplicate content by `ETag` (MD5). |

---

## 11. Edge cases

1. **Missing option combinations.**
   - PLA Basic: 43 of 60. 17 colours exist only as Refill: Beige, Light Gray, Yellow, Orange, Gold, Bright Green, Pink, Magenta, Maroon Red, Purple, Turquoise, Cobalt Blue, Brown, Bronze, Silver, Blue Grey, Dark Gray.
   - PLA-CF: 9 of 14 (5 colours are spool only).
   - H2D (6/18) and AMS 2 Pro (15/42) have **dependent options**. The second option's values only make sense for one first-option value: H2D `Standard` vs `10W`/`40W` vs `standard`.
   - Build the variant list from `productSkuList`. Never build it from the Cartesian product.
2. **Near-duplicate and odd option text.**
   - Values that differ only in case: `Standard`/`standard`.
   - Typos: `Texture PEl` (lowercase L), `Manta ray automato - ZH133`.
   - Option names in different case: `item`/`Item`.
   - Option names that are whole questions.
3. **Sold out.**
   - A variant can be sold out while others are not: Beige Refill has `isSoldOut:true, outOfStockMsg:"Sold Out"` and JSON-LD `OutOfStock`.
   - A whole product can be sold out: refurbished H2D has `isSoldOut:true, outOfStockMsg:"Restocking", requiresNotify:1`.
   - Collection cards show `outOfStockMsg:"Sold Out"`, `requiresNotify:true`.
4. **Discontinued products.** `/products/x1-carbon` → **301** to `/collections/3d-printer` (Cloudflare redirect). `llms.txt` still lists `x1-carbon`, `p1p` and `x1e`, which are not in the sitemap. Treat the sitemap as the truth.
5. **Canonical and case.** `/products/A1` returns **200** with `<link rel=canonical href=".../products/A1">`: the canonical echoes the request and is not normalised. `P.seoCode` is `a1`. Always key on `P.seoCode`.
6. **Handles vs sitemap.** For all 22 fetched products, the sitemap handle equals `P.seoCode`.
   - 10 product handles (and 1 collection handle, `%E2%89%A4-0-4mm`) are stored **percent-encoded with uppercase hex**. Examples: `usb%E2%80%91c-…`, `…-180-270%C2%B0-adjustable`, `cyberbrick-mk20-1a4-waffentr%C3%A4ger`. Decode and NFC-normalise them, then generate an ASCII slug for Levonis.
   - Handles often disagree with titles: `pla-basic-beginner-s-filament-pack` = "PLA Basic Starter Classic Pack"; `ams-multicolor-printing` = "Bambu Lab AMS"; `tungsten-carbide-nozzle-h2-p2s` = "Tungsten Carbide Hotend - H2/P2S/X2D"; typo handle `fcyberbrick-official-forklift-and-truck`.
   - The navigation links `/collections/refurbished-3d-printer`, but the sitemap has `refurbished-3d-printers`. The singular form was not fetched.
7. **Non-product URLs.**
   - The products sitemap contains only `/products/` URLs and **no gift card**.
   - `sitemap_pages_1.xml` lists 9 pages: `/about-us`, `/pages/*`, `/a/faq`, `/agree-terms`, and `/policies/*`, which robots.txt disallows.
   - `/collections/all` returns 200 with no data (`total 0`, empty title).
8. **Prices in text.** Variant `description` and feature HTML can contain dollar amounts ("Add only $50 …"). The fixtures replace them with `$[redacted]`. The importer must strip them too.
9. **Ids > 2^53** for product, variant, media and category ids. Use strings end to end, and in JSON parsers that default to doubles use BigInt or string mode.

---

## 12. Fixtures (`samples/`)

| File | Why it was chosen | description.kind |
|---|---|---|
| `pla-basic-filament.json` | multi-colour, Refill/Spool, missing combos, 1 sold-out variant, 10 documents | page_builder |
| `a1.json` | printer with Standard/Combo/Bundle (`type 4` option) | bespoke_shopify_port |
| `h2d.json` | flagship printer, dependent options, laser variants | bespoke_new |
| `bambu-hotend-a1-a2.json` | 3 printers × 5 nozzle sizes, image follows size | legacy_html |
| `bambu-textured-pei-plate.json` | one plate, 10 printer models, image follows plate size | legacy_html |
| `ams-2-pro-feeder-unit.json` | typical spare part, 18-digit ids, short pct template | legacy_html |
| `build-plate-combo.json` | bundle, multi-section HTML | sections_html |
| `refurbished-bambu-lab-h2d-3d-printer.json` | fully sold out ("Restocking") | bespoke_new |

Each file is `{_meta, product, description, jsonld}`:

- `product`: `P` minus price, promotion, limit and points keys, and minus store-wide shipping/service boilerplate (`orderInfo`, `serviceGuaranteeList`, A/B keys).
- `description`: `{kind, …}`, with styling props dropped from React trees.
- `jsonld`: the JSON-LD without `price`, `priceCurrency` and `priceSpecification`.
- `_meta.removed_keys`: the list of what was removed.

---

## 13. Requests made

| Host | Count | What |
|---|---|---|
| `us.store.bambulab.com` | **46** | robots, 3 sitemaps, llms.txt, 20 product pages + 1 RSC-only probe, 16 collection pages, 3 redirect/edge tests. Spacing ≥ 11 s. |
| `wiki.bambulab.com` | 7 | robots + 6 pages, ≥ 5 s apart |
| `store.bblcdn.com` | 6 | images, ≥ 2.5 s apart |

Before this session, the caller had already saved `page.html` (filament-buffer) and `tos.html` (`/policies/terms-of-service`, which robots.txt disallows) from the store, plus two bambulab.com challenge pages. Those 2 store pages were reused; they are not in the 46.

All requests used User-Agent `Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)`. The request log is `scratchpad/bambu_work/requests.log`.

---

## 14. Recommendations for the importer

1. Fetch every product URL from the sitemap at ≥10 s spacing: 1,115 pages ≈ 3.1 h. Parse with §2, then key products, variants and media on string ids.
2. Type each product from `currentAllIdRoute`. Name the distinct route ids (expect a few dozen) once by hand after the crawl.
3. Read descriptions in the order of §4 (A → B → C → D), and keep the raw HTML/JSON alongside the extracted text. Extract specs only from tables under a "Specification" heading, as key/value rows. Keep matrix tables as HTML.
4. Images: download originals (no `__op__` suffix), de-duplicate by `ETag`, and generate `alt` yourself, in ar/en/ckb. The source has no alt text worth keeping.
5. There are no SKUs or GTINs. Use the variant id as the external key. Optionally harvest `skuCode` from the cross-sell payload (§3.9) and colour codes from option values (`(10101)`).
6. Weights and dimensions need regex parsing from spec text, so plan a manual review for printers and AMS.
7. Never import `price*`, `discount*`, `availableStock`, `trackingQuantity` or `quantityLimit*`. Scrub `$<number>` patterns from all text.
