# Pricing V2 — design (owner decisions recorded 2026-10-13, DECISIONS row 221)

Date: 2026-10-13. Surveyed on default branch `10c6541a` with invented local products only; the
live site and its database were not read.

**Owner's answers (2026-10-13): A1, B1, C1, D1 — every recommended option, and the §7 defaults.**

**Superseding clarifications (2026-10-14, DECISIONS row 222):** a route the discount would put below its cost sells at the direct price; staff who edit prices see and edit USD; a typed USD price below cost + minimum profit saves with a warning; **clean start — the old IQD form and pricing are removed, every product is hidden the moment the release deploys and reappears automatically when its new pricing is complete. §3's "keep current prices" migration is replaced by that queue.**

Built from four local surveys (form P1–P16, engine D1–D25, finance F1–F17, customer C1–C9;
the P/D/F/C references below point into them). It also uses
DECISIONS rows 184–220, `FINANCIAL-INTEGRATION-AUDIT.md`, `HANDOFF.md`, the 2026-10-09 USD
procurement brief, the owner's decisions of 2026-10-09 and the FX programme plan §2–§3.

---

## بالعربية باختصار

- **سعر واحد أساسي: سعر البيع المباشر بالدولار.** يُحسب من التكلفة (تكلفة المورد + الشحن +
  الإضافات + الحد الأدنى للربح)، أو يكتبه المالك بالدولار. ثم يُضرب في سعر الصرف المعتمد
  ويُقرَّب لأعلى لأقرب 1,000 د.ع مرة واحدة.
- **الطلب المسبق = البيع المباشر − خصم بالدولار.** للخصم قيمة على مستوى المنتج، ويمكن وضع
  استثناء لموديل أو لون. بهذا لا يصبح الطلب المسبق أغلى من البيع المباشر أبدًا.
- **الموديل يرث من المنتج، واللون يرث من موديله.** الاستثناء سطر واحد في بطاقته، والقيمة
  الموروثة ظاهرة دائمًا.
- **تختفي كل حقول الدينار القديمة:**
  - السعر واللون والتكلفة القديمة؛
  - «زيادة البيع المباشر» بنسخها الثلاث؛
  - «زيادة هذا المسار» وعمولة النقل.
  تبقى قيمها القديمة سجلًّا للقراءة فقط.
- **تغيّر سعر الصرف المعتمد يعيد تسعير كل منتج.** الطلبات المنشأة والدفعات وسعر المحفظة
  (1,400) لا تتحرك.
- **لا يتغيّر أي سعر حالي قبل موافقتك.** يُنقل كل منتج بمعاينة «القديم ← الجديد». وأسعار
  المنتجات التي لها مسار شحن واحد تبقى كما هي بالضبط.
- **المحاسبة تبقى بالدينار.** تُحفظ لقطة سعر الصرف في أربع لحظات: كتابة السعر، والشراء من
  المورد، وطلب الزبون، وسحب القطعة من المخزون. وتكلفة سطر الطلب المسبق تقديرية وقت الطلب ثم
  فعلية عند وصول دفعته، ولا تُؤخذ من «التكلفة القديمة».
- **الزبون يرى السعر النهائي فقط.**
- **في آخر الوثيقة أربعة قرارات لك.**

---

## 0. Today vs V2

| Topic | Today (survey refs) | V2 |
|---|---|---|
| Price engines on a product | Two. The IQD ladder is the only read path, and the USD engine compiles into it (D-§0, P-§0.1) | One USD engine. It writes a final price per SKU × channel, and the old ladder is only a rollback copy |
| Anchor price | Pre-order on the base route. Direct = pre-order + an IQD extra (D1, P4) | **Direct-sale USD price**. Pre-order = direct − USD discount |
| «زيادة البيع المباشر» | Three fields with different storage (D9, P2) | Gone. Its value moves into the minimum profit and the discount at migration |
| Route fee «زيادة هذا المسار» / commission | IQD fee. PRO is waived in manual mode and not in engine mode (P16, D18) | Gone. Routes change pre-order prices only as Decision B says |
| Colour price | IQD last rung. A fixed colour price swallows the model and the extra (P1, D7) | Follows its model, with an optional ± USD exception (Decision C) |
| Manual IQD mode | The real price of most products. FX never moves it (P-§6.4) | Retired. Every product is priced in USD, either from cost or from a typed USD price (Decision A) |
| FX change | Reprices `mode='engine'` products only (D-§4) | Reprices every product |
| Stock purchase → price | Hidden «direct only» overlay. Pre-order stays frozen (D3, F10, 0186/0188) | One cost per product, and pre-order follows by the discount (Decision D) |
| Order-line cost | Legacy IQD cost cell, booked as *confirmed* (F1, P10) | FIFO actual cost. A pre-order is *estimated* at order time and becomes *actual* when its batch is linked |
| Customer payloads | Components, commission and surcharge fields and the raw ladder (C5, C6, D19) | Allow-listed final numbers only |

---

## 1. The price model

### 1.1 Currencies (unchanged chain, rows 189, 196)

- **Supplier cost** is entered in USD, EUR or CNY (or IQD, converted once to USD at the rate
  shown, row 214).
- **Conversion goes through the dollar:**
  - EUR: amount × E (EUR/USD), then × U;
  - CNY: amount × C (CNY/USD), then × U.

  E, C and U are the **approved** central rates. U = market + `market_adjustment_iqd`, or a
  manual value.
- **Central freight** (per kg for air and land, per CBM for sea) and the per-piece extra cost
  stay **IQD inputs**, as in the 10-09 brief («Shipping Cost USD = Shipping Cost IQD ÷
  Effective USD/IQD»). So they do not scale when USD/IQD moves (D5; see §7 default 8).
- **Minimum profit, the direct USD price, price differences and the pre-order discount are USD
  with 2 decimals.**
- **Accounting stays IQD as recorded** (rows 189 (1), 194). The wallet keeps 1,400 (decision 9).

### 1.2 The anchor: the direct-sale price D (per SKU = model × colour)

There are two ways to set it, chosen per product (Decision A):

- **«من التكلفة» (cost-first, the current engine's chain):**
  - R = supplier USD×U + freight on the **stock route** + extras. This is the replacement cost
    of a unit on the shelf.
  - D_usd = R/U + T, where T is the minimum profit.
  - The guarantee D − R ≥ T (row 187) now applies to the **direct** price.
- **«سعر بالدولار» (price-first):** the owner types D_usd. Cost inputs become optional and serve
  profit reports and estimates only.

Today's «مسار الشحن الأساسي» is renamed **«مسار شحن المخزون»** (how the stock arrives). It
affects the direct price only through R. It no longer hides any measure field: weight and box
are always both shown (fixes P4/P15).

### 1.3 Pre-order = direct − discount

- **Discount levels.** The discount Δ is USD ≥ 0 at product level. A model can carry an
  exception, and so can a colour (rare). The SKU table in «التفاصيل» can hold one too. The most
  specific level wins: SKU > colour > model > product (the existing scope order, rows 184 (1)
  and 200).
- **Formula.** For each route the product sells: P_r = D_usd − Δ, then × U, rounded once. How
  the route itself changes P is **Decision B**.
- **Never above direct.** Δ ≥ 0 and the rounding is monotone, so **P ≤ D always**. A pre-order
  can no longer cost more than direct sale (P1, P5, C1).
- **Never at a loss.** No route is priced below its own replacement cost R_r. If it would be,
  that route is lifted to its cost and the form says «الخصم أكبر من ربح هذا المسار». If even D <
  R_r, the route is blocked.
- **Pre-order-only products** have no discount field: their anchor *is* the pre-order price.
  In the census this is the R1 laser.
- **Cash on delivery of a pre-order** pays D. This is today's rule (`pricing.ts:993-1000`) and
  §7 default 2. Because P ≤ D, cash is never cheaper than prepaid, which closes C1.

### 1.4 Models and colours

| Level | Choices (one selector) | Effect on D (P follows through Δ) |
|---|---|---|
| Product | method + inputs (1.2) | base D |
| Model | «يتبع المنتج» · «تكلفة مختلفة» (cost-first, owner: own supplier cost and weight or box) · «فرق في السعر ± $» · «سعر خاص $» | replaces or adjusts D |
| Colour | «يتبع الموديل» · «± $ فوق الموديل» (Decision C) | adds to every model's D for that colour |
| SKU (model × colour) | in «التفاصيل» only: «سعر خاص $» | replaces D for that SKU |

- A colour difference adds the same USD to every model, so «Red +$2» never erases Combo's
  premium. The bug where a fixed Red price at 1,150,000 undercut Combo's 1,325,000 cannot
  happen.
- «كل الألوان بسعر واحد» is the default: colours follow the model. The colour list also has a
  bulk action, «طبّق على الألوان المحددة».

### 1.5 Rounding (one rule, one place)

1. Compute D_usd **exactly** (no intermediate rounding, as E1 does today).
2. D_iqd = ceil₁₀₀₀(D_usd × U).
3. P_r,iqd = ceil₁₀₀₀((D_usd − Δ) × U).

**One USD definition (fixes D6).** The owner's «السعر النهائي بالدولار» is the exact USD before
rounding. Price protection's base USD (row 191) is that same number for the line's channel.

### 1.6 Worked example (cost-first, U = 1,500, E = 1.08)

**Inputs.** Product: supplier €500 = $540; stock route land 9,000 IQD/kg × 22 kg = 198,000;
extras 15,000; minimum profit $318; discount $50.

**Standard model.** R = 810,000 + 198,000 + 15,000 = 1,023,000 ($682).
- D = $1,000 → **1,500,000**.
- P(land) = $950 → **1,425,000**.

**Combo model** («تكلفة مختلفة»: €650, 30 kg; discount exception $25).
- R = 1,053,000 + 270,000 + 15,000 = 1,338,000.
- D = $1,210 → **1,815,000**.
- P = $1,185 → 1,777,500 → **1,778,000**.

**Red colour** (+$2):
- Standard·Red: 1,503,000 / 1,428,000.
- Combo·Red: 1,818,000 / 1,780,500 → 1,781,000.

| Event | Standard D / P | Combo D / P | Why |
|---|---|---|---|
| Start | 1,500,000 / 1,425,000 | 1,815,000 / 1,778,000 | — |
| USD/IQD 1,500 → 1,530 (approved) | 1,526,000 / 1,450,000 | 1,846,000 / 1,808,000 | Supplier and profit scale with U. Freight and extras stay IQD |
| EUR/USD 1.08 → 1.12 (at U 1,500) | 1,530,000 / 1,455,000 | 1,854,000 / 1,817,000 | Supplier +$20 / +$26 |
| Same product, price-first «$1,000» and USD/IQD 1,500 → 1,530 | 1,530,000 / 1,454,000 | (model's own $) | Everything scales with U |

Arithmetic for the second row:
- Standard: 540×1,530 + 198,000 + 15,000 + 318×1,530 = 1,525,740 → 1,526,000. Minus 50×1,530
  gives 1,449,240 → 1,450,000.
- Combo: 702×1,530 + 270,000 + 15,000 + 318×1,530 = 1,845,600 → 1,846,000. Minus 25×1,530
  gives 1,807,350 → 1,808,000.

The build fixes these cells in a property test.

### 1.7 An FX change reprices every linked product

Every V2 product is linked, because there is no IQD mode left. The existing rate guards and
repricing machinery are kept unchanged:

- dead band 0.5% for USD, 0.3% for EUR and CNY;
- REVIEW_REQUIRED above 3% in 24 hours or 6% from the anchor (rows 189, 191);
- deficit-first repricing in budgeted atomic batches (FX-5, `autoReprice.ts`), with price
  history at U and its version;
- targeted cache purge.

The only change: `autoReprice` selects **all V2 products**, not just `mode='engine'` ones.

What does not move:
- placed orders (§7 default 1);
- batch costs;
- the wallet;
- price protection for FX-only drops (row 191).

### 1.8 What is stored and what is published

**Owner-only**, in `pricing_sku_costs` plus new columns, per SKU × channel: R, T, D_usd, Δ and
the scope that won, P_usd, U/E/C and their versions, and the method.

**Public**: one final IQD price per SKU × channel in `product_sku_prices`, read by the cart's
last rung. The old ladder rows hold each model's highest price as a rollback copy (as 0183
already does).

Two schema changes:
- **Option-less products get a product-level key `*`.** This needs a rebuild of the 0183 CHECK.
  It fixes D2: today an option-less product selling direct + pre-order can never be priced.
- **Every V2 product is written per-SKU.** The «per-model» path and its silent switch go
  (D7, P7).

### 1.9 Retired

- **DSE as a rule kind.**
- **Route `surcharge_iqd`, product `preorder_transports.commission_iqd` and the admin default
  commission.** These are zeroed on V2 products.
- **`products.direct_surcharge_iqd`.** This also removes C4.
- **The direct-cell `regular_adjust_iqd`.**
- **Typed PRO/PRIME prices.** Membership benefit rules stay read-time (row 184 (6)).
- **The `pricing_direct_purchase` overlay**, folded into inputs under Decision D, and the
  direct-only lock variant from 0188.
- **The `data_only` limbo state.**
- **`pricing_engine_control.new_products_use_engine`, `SOURCE` origin and other dead code**
  (D21, D22).

---

## 2. The product form

### 2.1 Principles

1. **One place per decision.**
   - Product-level money (method, cost, minimum profit, discount) lives in ٣ «الأسعار».
   - A model's or colour's exception lives in its own card in ٥ «الخيارات والألوان».
   - ٣ shows the resulting table with «عدّل» links that jump to the card.
2. **Every inherited field shows the inherited value in grey.** An override shows a chip
   «استثناء» and «رجوع للموروث».
3. **One status chip in the section header.** It is never contradictory (P11):
   - «● محدّثة»;
   - «● بانتظار مراجعتك (4 أسعار)»;
   - «● ناقص: الوزن لمسار جوي»;
   - «● متوقف: سعر الصرف بانتظار اعتمادك».
4. **Readiness is grouped by missing field and level.** An empty 2×3 product shows one line,
   «ناقص: تكلفة المورد (المنتج)», not 18 (P14).
5. **Everything works before the first save.** The preview takes the draft document with
   temporary ids (P13, D11).
6. **The real page is right-to-left.** The ASCII below shows reading order.

### 2.2 ٣ «الأسعار» — desktop (≥ 1024 px)

```
╭─ ٣ الأسعار ─────────────────────────────── ● محدّثة · 1 USD = 1,500 د.ع (معتمد 13/10)  [السجل]
│
│  كيف يُحسب السعر؟   [ ● من التكلفة | ○ سعر بالدولار ]
│
│  ┌ التكلفة — للمالك فقط ─────────────────┐  ┌ الربح والطلب المسبق ──────────────────┐
│  │ سعر المورد      [ 500.00 ] [ EUR ▾ ]   │  │ الحد الأدنى للربح    [ 318.00 ] $      │
│  │                 = $540.00 (1 EUR=1.08$)│  │ خصم الطلب المسبق     [  50.00 ] $      │
│  │ مسار شحن المخزون [ بري · ألمانيا ▾ ]    │  │   يُطرح من سعر البيع المباشر           │
│  │ الوزن [ 22 ] كغ   الصندوق [60×52×48] سم │  │   استثناءات: Combo −25$  [عرض ↘]       │
│  │   ↳ مأخوذ من «الأبعاد والوزن» [غيّر]     │  │                                        │
│  │ تكاليف إضافية للقطعة [ 15,000 ] د.ع     │  │                                        │
│  └────────────────────────────────────────┘  └────────────────────────────────────────┘
│
│  ┌ النتيجة (Standard) ──────────────────────────────────────────────────────────────┐
│  │ التكلفة $682.00 │ الحد الأدنى للربح +$318.00 │ السعر النهائي $1,000.00 │ 1,500,000 د.ع │
│  │                                   طلب مسبق: $950.00 → 1,425,000 د.ع              │
│  └──────────────────────────────────────────────────────────────────────────────────┘
│
│  الأسعار النهائية للزبون                                           [التفاصيل ▾]
│  الموديل · اللون      مباشر        طلب مسبق (بري)   من أين جاء السعر
│  Standard             1,500,000    1,425,000        المنتج
│  Standard · Red       1,503,000    1,428,000        اللون +$2                    [عدّل ↘]
│  Combo                1,815,000    1,778,000        تكلفة Combo · خصم 25$         [عدّل ↘]
│  Combo · Red          1,818,000    1,781,000        اللون +$2
│  ▸ 4 صفوف أخرى تتبع موديلها
╰───────────────────────────────────────────────────────────────────────────────────────
```

In price-first mode the two cost cards are replaced by:

```
│  كيف يُحسب السعر؟   [ ○ من التكلفة | ● سعر بالدولار ]
│  سعر البيع المباشر  [ 1,000.00 ] $   → 1,500,000 د.ع
│  خصم الطلب المسبق   [    50.00 ] $   → 1,425,000 د.ع
│  ▸ التكلفة (اختياري — للأرباح والتقدير فقط؛ بدونها يظهر ربح الطلب المسبق «غير معروف»)
```

«التفاصيل» (owner only) opens the SKU × channel table. It shows R, T, profit, U and version,
and has the per-SKU «سعر خاص $» editor.

### 2.3 ٣ «الأسعار» — phone (360 px, 16 px gutters)

```
╭─ ٣ الأسعار          ● محدّثة
│ 1 USD = 1,500 د.ع
│ [ من التكلفة | سعر بالدولار ]
│ ▸ التكلفة   $682.00
│   EUR 500 · بري · 22 كغ · +15,000 د.ع
│ الحد الأدنى للربح   [ 318.00 ] $
│ خصم الطلب المسبق    [  50.00 ] $
│ ┌──────────────┬──────────────┐
│ │ التكلفة       │ الربح         │
│ │ $682.00      │ +$318.00     │
│ ├──────────────┼──────────────┤
│ │ مباشر         │ طلب مسبق      │
│ │ 1,500,000    │ 1,425,000    │
│ └──────────────┴──────────────┘
│ ▸ الأسعار لكل موديل ولون (4)
╰──
```

The cards stack. The cost card collapses to its one-line summary. The 2×2 bar is the 10-09
four-cell bar plus the pre-order cell. The per-model table becomes one card per model.

### 2.4 ٥ «الخيارات والألوان» — desktop

```
╭─ ٥ الخيارات والألوان ─────────────────────────── مجموعة: الموديل [+ موديل]   الألوان (3) [+ لون]
│ ┌ Standard ──────────────────────────────────────────────────────────────────────────┐
│ │ السعر         [ يتبع المنتج ▾ ]                مباشر 1,500,000 · مسبق 1,425,000     │
│ │ خصم المسبق    [ يتبع المنتج: 50$ ▾ ]                                                │
│ │ يُباع         [✓] بيع مباشر · المخزون 2                                              │
│ │               [✓] طلب مسبق: [✓] بري 25–35 يوم   [ ] جوي   [ ] بحري                  │
│ │ الألوان       ● Black   ● White   ● Red (+$2)                                       │
│ └────────────────────────────────────────────────────────────────────────────────────┘
│ ┌ Combo ─────────────────────────────────────────────────────────────────────────────┐
│ │ السعر         [ تكلفة مختلفة ▾ ]  المورد [ 650.00 ][EUR]  الوزن [ 30 ] كغ          │
│ │                                                مباشر 1,815,000 · مسبق 1,778,000     │
│ │ خصم المسبق    [ استثناء ▾ ] [ 25.00 ] $   (المنتج: 50$)   [رجوع للموروث]            │
│ │ يُباع         [✓] بيع مباشر · المخزون 2   [✓] طلب مسبق: [✓] بري                     │
│ └────────────────────────────────────────────────────────────────────────────────────┘
│ الألوان   [☐ تحديد عدة ألوان → «طبّق نفس السعر على المحدد»]
│ ┌ Red ───────────────────────────────────────────┐
│ │ السعر   [ ± فوق الموديل ▾ ] [ +2.00 ] $         │
│ │         Standard 1,503,000 · Combo 1,818,000    │
│ │ يظهر مع [✓] Standard [✓] Combo · المخزون حسب الموديل │
│ └─────────────────────────────────────────────────┘
╰──
```

- The structure (models, colours, links, «يُباع» with routes and lead times, stock) stays here
  for everyone.
- The price selectors are the only money on these cards.
- «تكلفة مختلفة» appears only in cost-first mode and only for the owner.
- Adding a model or enabling a route is a normal edit. The same save computes and reviews the
  new SKU prices. There is no 409 `ENGINE_MANAGED` dead end any more (P9).

### 2.5 ٥ «الخيارات والألوان» — phone

```
╭─ ٥ الخيارات والألوان
│ ▾ Standard · يتبع المنتج
│   1,500,000 / مسبق 1,425,000
│   السعر      [ يتبع المنتج ▾ ]
│   خصم المسبق [ يتبع: 50$ ▾ ]
│   يُباع [✓] مباشر  [✓] مسبق: بري
│ ▸ Combo · تكلفة مختلفة · خصم 25$
│   1,815,000 / 1,778,000
│ الألوان: Black · White · Red +$2  [تحرير]
╰──
```

Each model card is one accordion row whose summary carries the result. The 5,364-px-tall page
from the survey becomes one screen per open model.

### 2.6 Save and review

- **One «نشر».**
  - When no price changes, it saves with no sheet.
  - When prices change, **one** review sheet lists only the changed SKU × channel rows (old →
    new). The confirm button sits under the table.
  - There are no PRO lines (P6).
  - A move above 15% needs the tick and a fresh sign-in (row 196). A drop above 30% is flagged.
- **Structure and prices commit together** in one atomic engine batch.
- **An incomplete product saves its data.** Its store prices stay at the last good write, or
  it stays hidden if it was never priced (row 205). The chip names what is missing.
- **The `data_only` / «راجع السعر الجديد واعتمده» second step is removed.** Row 213 (1) is
  superseded. Every save that changes a price shows the sheet. Its cancel keeps the typed
  values (row 214 F3 leave-guard).

### 2.7 Add product

- There is no IQD «السعر» starting at 0, and 0 is never accepted (P13).
- The method selector, cost and price cards and the colour/model selectors all work on the
  draft.
- The first «نشر» writes the product and its prices together. Publishing needs a complete
  price; a draft does not.

### 2.8 What disappears from the form

| Field today | Fate |
|---|---|
| ٣ «السعر» (`products.price_iqd`) as an input | Computed. It is shown in the table, never typed |
| «سعر LEVO PRO» | Gone. «خصم العضوية» rules stay in their own section |
| «التكلفة القديمة (د.ع)» and option/colour «التكلفة» | Gone. Read-only in «السعر القديم (سجل)» (§3) |
| `original_price_iqd` line | Gone |
| Option/colour «السعر» IQD inherit/adjust/fixed and PRO cells | Replaced by one selector per card (1.4) |
| Direct cell «زيادة البيع المباشر» and the engine rule of the same name | Gone (1.9) |
| Route box «زيادة هذا المسار» | Gone. Routes are tick boxes with lead times |
| `PinnedPriceNotice`, base-price notice (double list, P12), the 18-line readiness | Gone or grouped |
| Per-scope ScopeDraft (~11 fields × 4 levels, D13) | Product inputs once. Model gets supplier + measure only. Colour gets ± $ only |
| Hidden purchase overlay | Visible as «آخر تحديث للتكلفة: من شراء "…" 13/10» on the cost field |

### 2.9 Other screens

- **Stock screens: «تحديث سعر هذا الخيار في المتجر»** (`SelectionPriceUpdate.tsx`,
  `inventoryReferencePrice.ts`) is removed (D14, P11). It becomes «عدّل السعر في المنتج», which
  opens ٣ or ٥ at that model or colour. The inventory selection price reads the SKU final
  price (D15).
- **Price grid, CSV and TXT data file:** IQD price columns are read-only on V2 products. The
  TXT owner block carries the USD fields (method, D_usd, Δ, differences).
- **«التسعير والشحن» overview:**
  - lists the V2 status and the migration queue (§3);
  - drops the stale OPTION_GROUPS / COLOR_PRICE «unsupported» flags (D12).

### 2.10 Who sees and edits what

- **Cost, freight and extras, minimum profit, R and profit** are for the owner only (row
  184 (2)).
- **The USD price, model and colour differences and the discount** are editable by whoever
  can edit product prices today, so today's delegation is kept. They reveal no cost.
- **Final IQD prices** are read-only for everyone.

---

## 3. Migration of existing products

**No price changes without the owner's confirmation. Old IQD values become read-only
history.**

0. **Prerequisite.** U is approved. HANDOFF.md:361 lists rate approval as pending owner setup;
   without it nothing can be computed.
1. **Additive migrations ship first. The store does not change.**
   - New V2 tables and columns (§6).
   - `pricing_legacy_snapshots(product_id, captured_at, usd_iqd_rate, fx_version, actor,
     payload_json)`. The payload holds every legacy price, cost, surcharge, commission, DSE and
     member field, plus the 0186 overlay.
   - Reads tolerate the absence of all of these (CLAUDE.md rule 2).
2. **«نقل الأسعار إلى الدولار» (owner page)** builds a proposal per product. Nothing is written
   at this step.
   - **Default «احتفظ بالأسعار الحالية»** (price-first):
     - D_usd per model = floor to the cent of (today's direct IQD ÷ U). Because a cent × U is
       less than 1,000, ceil₁₀₀₀ gives back **exactly today's IQD**. A price that is not on a
       1,000 step (for example a route fee of 4,500) moves up to the next 1,000, and the
       preview shows it.
     - Δ = D_usd − floor to the cent of (pre-order IQD ÷ U). The most common Δ becomes the
       product discount; the others become model exceptions.
     - Current engine products: T_new = T + DSE/U and Δ = DSE/U. The ±1,000 rounding is shown
       if any appears (as row 196 (3)).
   - **«سعّر من التكلفة»** is offered where the cost inputs are complete. The diff is shown per
     SKU × channel.
   - **Flags shown before confirming:**
     - routes one discount cannot reproduce. The census has 1 such product of 41,
       `bambu-lab-ams-2-pro` (air + land); under Decision B1 one route moves;
     - today's pre-order above direct, which V2 caps at direct, so that pre-order price falls;
     - legacy colour prices, which become ± $ exceptions. The census has none of 153;
     - typed member prices that will drop;
     - an existing purchase overlay.
3. **The owner confirms per product.** «اعتمد كل المنتجات التي لا يتغيّر سعرها» does the
   zero-diff ones in one tap. Each product goes in one atomic batch: snapshot, V2 rows, SKU
   prices, method, audit, with a fresh sign-in.
4. **After migration:**
   - legacy columns stay in the database as the rollback copy (highest price), and no writer
     accepts them for V2 products. Refusals say «هذا المنتج يُسعَّر بالدولار — عدّل من قسم
     الأسعار» and name the section;
   - the form shows the old values only in «السعر القديم (سجل)»;
   - legacy cost cells stop feeding new order lines (§4.3).
5. **Unmigrated products behave exactly as today.** They are badged «لم يُنقل بعد» and their
   form shows the old fields read-only plus one action, «راجع وانقل». Manual IQD writers are
   deleted only after all products are V2 (last phase).
6. **Placed orders, invoices, lots, wallet rows, gifts and price-protection claims are never
   touched.**

---

## 4. Financial linkage

### 4.1 Kept as is (survey-finance §4)

- immutable IQD batch cost (0181/0182);
- FIFO atomic with deduction;
- returns restore the original lot cost;
- the 1,400 wallet rate;
- profit in IQD by default, with USD display only (row 194);
- owner-only cost.

### 4.2 Snapshots at every moment the owner named

| Moment | IQD (accounting) | USD / FX recorded | Status today → V2 |
|---|---|---|---|
| Price fixed (any write, incl. FX reprice and migration) | final per SKU × channel | D_usd, Δ and its scope, P_usd, U/E/C and versions, method | exists for engine writes → all writes |
| Supplier purchase confirmed | total at the **rates actually paid** | amount + currency, E_doc, U_doc, central U/E/C and versions | exists (0179/0182), but EUR/CNY skip USD (F3, F6) → EUR→USD→IQD |
| Batch received | lot unit cost (immutable) | lot USD = IQD ÷ U_doc (consistent) | inconsistent for EUR/CNY (F6) → fixed |
| Customer places an order | charged line price | **order**: market U + version at placement. **line**: exact USD of its channel, Δ applied, estimated cost IQD and USD (owner only) | partial (F7, F8) → every line |
| Stock withdrawn (FIFO) | allocation cost from the lot | U and version at withdrawal (the lot keeps its purchase U) | none (F-§2.4) → both |
| Pre-order batch arrives | line ↔ lot link; actual replaces estimated | both kept for «تقديري مقابل فعلي» | not built (F5, row 184 (9)/(16)) |
| Supplier paid | IQD paid | currency and rate (later phase) | none (F13) |

The customer's past orders are read in USD at the order's own snapshot, not at today's rate
(F7, `CurrencyContext.tsx:226`). The public dollar figure keeps row 220's rule.

### 4.3 Which cost a line carries (fixes F1, F2, P10)

1. FIFO allocation (actual).
2. Otherwise, the batch linked when the pre-order's stock arrives (actual).
3. Otherwise, the **estimated cost at order time**: R of that channel, frozen, marked
   `estimated`.
4. Otherwise «unknown».

- `product_cost_iqd` and option/colour cost cells are no longer read for new lines.
- Staff profit-share runs on estimated cost provisionally and is recalculated when the actual
  cost lands (existing temporal wage reconciliation, row 217).
- Investors stay tied to funded lots.
- Confirmation and FIFO deduction become one batch. If they cannot, the line is marked
  `unknown` and never falls back to a legacy number (F2).

### 4.4 Procurement uses the one chain (F3, F4, F6)

- The document's rates are **prefilled from the central rates**, never 1. EUR and CNY enter as
  EUR→USD and USD→IQD.
- A typed rate more than 6% from the central rate needs an explicit confirm (the anchor guard
  of row 189).
- Batch IQD cost = what was actually paid. The central values are kept beside it as the
  check.
- `procurement_cost_profiles.exchange_rate` stops being a rate source. It stays as history and
  its freight defaults stay.
- **«إضافة مخزون موجود»** becomes one server call (confirm + receive + price review), or the
  price review becomes a pending item on the product. Stock is never received while its price
  write silently fails (F9).

### 4.5 Stock purchase → prices

Decision D. The recommended option writes the purchase's supplier cost into the **same**
product inputs the form edits. Pre-order follows through Δ. The 0186 overlay and the 0188
direct-only locks retire.

### 4.6 Smaller finance fixes in the same programme

- `/adjustments` posts journals the way counts do (F12).
- Warranty «replacement» books a stock-out at FIFO cost (F11).
- Found stock records a snapshot (F-§2.9).
- Owner finance screens get Sorani: procurement 50 strings, selection dialog 6, legacy
  investment 13 (F17, row 183).

---

## 5. Customer view: final price only (C1–C9, D19, row 220)

1. **The server sends final numbers only.**
   - Replace `publicQuote`'s strip-cost with an **allow-list**: `unit_subtotal_iqd`,
     `applied_iqd`, `regular_iqd` (strike only for an offer or member price), `applied_tier`,
     fulfilment type and lead time, route, and errors.
   - Remove `components`, `commission_iqd`, `surcharge_iqd`, `price_source`, `member_rule` and
     the raw ladder from `projectPublic`, cart, checkout and order customer JSON (C5).
   - Δ, R and T never reach `pricing_snapshot` or any customer payload. Otherwise an exception
     would reveal the rule.
2. **Product page:**
   - the direct button shows D;
   - the pre-order button shows each route's P;
   - no «−$50» line and no arithmetic;
   - the quote and buttons include live offers (C2).
3. **Card:** one number, the lowest price a customer can pay, labelled «طلب مسبق» when it is a
   pre-order price (C7). Public API option and colour prices become «from» prices with a flag
   (C3).
4. **Checkout:** each payment option shows its final total. The «+ عمولة» row goes (C6).
   Invoices, email and PaymentBreakdown print unit prices only. Fees are always 0 under V2.
5. **Offers** move D and P together. A fixed-price offer sets D, and P stays Δ below it (so
   `offers.ts:194` no longer flattens channels).
6. **Policies** need new versions in ar, en and ckb, with the hash ledger: purchase 3.3, 4.10
   and 6.3, and FAQ 12.7. The new text says the pre-order price is lower than direct sale and
   lists no components.
7. **Tests that pin today's behaviour and will change:**
   - `codPricedAsDirect`, `codDifferenceDisclosed`, `checkoutPayment`;
   - `preorderChoiceVisible`, `skuPrices` (direct = sea + 2,000), `publicApi`;
   - `policyCorpus`, `policyHashLedger`, `noPremiumWord`.

   The leak scanners `costPublicChannels` and `securityPricingLeak` get the arithmetic keys
   added.

---

## 6. Build order (each push through workflow 7; migrations additive; reads tolerate absence)

- **V2-0 — independent fixes, no migration.** These can ship now:
  - allow-list on customer JSON (C5);
  - offer in quote, buttons and public API (C2);
  - public API «from» flags (C3);
  - COD price = max(direct, route prepaid) as a stop-gap for C1;
  - procurement rate prefill from central and the 6% guard (F4);
  - Sorani strings (F17).
- **V2-1 — pure maths and property tests:**
  - `packages/pricing`: anchor, Δ scopes, routes per Decision B, floor, rounding;
  - P ≤ D;
  - reproduce-at-migration.
- **V2-2 — additive migrations:**
  - `pricing_price_points` (scope, fixed/delta USD);
  - `pricing_preorder_discounts` (scope, plus a route if B2);
  - `pricing_legacy_snapshots`;
  - `product_pricing_state.method`;
  - order, line and allocation snapshot columns, owner-only and in `FINANCIAL_FIELDS`;
  - purchase E_doc/U_doc;
  - rebuild of `product_sku_prices` for key `*`.
- **V2-3 — writer and resolver:**
  - always per-SKU;
  - fees 0 on V2 products;
  - `autoReprice` over all V2 products;
  - verify-before-write kept.
- **V2-4 — form:** ٣, ٥, ٨ and add-product (§2), in ar, en and ckb.
- **V2-5 — the migration page and owner review (§3).**
- **V2-6 — finance:**
  - line cost precedence and estimated cost;
  - order and withdrawal snapshots;
  - pre-order ↔ batch link;
  - purchase → price;
  - atomic quick receive;
  - FIFO atomic confirm.
- **V2-7 — closing work:**
  - policies;
  - delete the legacy IQD writers, the selection-price dialog, the 0186 overlay reads and DSE
    paths, once every product is V2.

---

## 7. Defaults applied unless the owner says otherwise

1. **The price is fixed when the order is placed** (owner: «عند شراء المنتج … يثبت»).
   - The cart shows the live price.
   - Checkout re-quotes and says «تغيّر السعر من … إلى …» if the price moved since it was added.
   - Placed orders (unpaid COD included) never move up or down.
2. **A COD pre-order pays the direct price** (today's rule), so it loses the discount. Cash is
   never cheaper than prepaid.
3. **Pre-order-only products have no discount field.**
4. **PRO pays the same final prices.** Policy 6.3's exemption referred to fields that no longer
   exist. PRO is paused, so this changes nothing today. The policy gets a new version.
5. **No «وفّر X» hint.** Each button shows its final price.
6. **The minimum profit applies to the direct price.** The discount is the owner's explicit
   pre-order concession, with a no-loss floor (1.3).
7. **The price follows replacement cost both up and down** (row 187 default), never below
   R + T on direct.
8. **Central freight and per-piece extras stay IQD.** They do not scale with USD/IQD (10-09
   brief).

---

## 8. DECISIONS THE OWNER MUST MAKE (4)

All examples use U = 1,500 IQD per $ and a printer whose direct price is $1,000 = 1,500,000
IQD, with a pre-order discount of $50 = 75,000.

### القرار A — كيف يُحدَّد سعر البيع المباشر؟

- **A1 (موصى به) — الطريقتان بالدولار، تختار لكل منتج، ولا يبقى تسعير بالدينار.**
  - «من التكلفة»: المورد + الشحن + الإضافات + الحد الأدنى للربح. يكون الافتراضي حيث توجد
    بيانات التكلفة.
  - «سعر بالدولار»: تكتبه أنت، حيث تريد سعر سوق أو لا توجد تكلفة.
  - **لماذا:** يحفظ قراراتك السابقة (الحد الأدنى للربح، والسعر يتبع اليورو واليوان والشحن)،
    ولا يوقف منتجًا ينقصه بيانات، ويحتاج حقلًا واحدًا في طريقة السعر.
  - **بالأرقام:** إذا ارتفع اليورو من 1.08 إلى 1.12 على طابعة سعرها من المورد 500 يورو:
    - بطريقة التكلفة: البيع المباشر 1,500,000 ← 1,530,000، والمسبق 1,425,000 ← 1,455,000؛
    - بطريقة السعر بالدولار: الأسعار ثابتة، وربحك في القطعة أقل بـ 30,000.
- **A2 — من التكلفة فقط لكل منتج.**
  - كل منتج يحتاج تكلفة المورد والوزن أو الصندوق والحد الأدنى للربح قبل البيع، والناقص
    يُخفى.
  - **بالأرقام:** مثل عمود التكلفة أعلاه، ولا سعر يُكتب باليد.
- **A3 — سعر بالدولار فقط.**
  - التكلفة للأرباح فقط، وارتفاع اليورو أو الشحن لا يغيّر السعر أبدًا.
  - **بالأرقام:** شراء بـ 520 يورو بدل 500 ينقص ربح القطعة 32,400 حتى تعدّل السعر بنفسك.

### القرار B — الطلب المسبق عبر المسارات (بحري / جوي / بري)

المثال: المخزون يأتي برًّا بشحن 198,000. الشحن الجوي للقطعة نفسها 440,000.

- **B1 (موصى به) — خصم واحد لكل المسارات، مع حدٍّ يمنع البيع بخسارة.**
  - **بالأرقام:** بري 1,425,000، وجوي 1,425,000. ربح الجوي أقل بـ 242,000 (160,000 بدل
    402,000). إذا صار شحن الجوي أكبر من الربح يُرفع سعر الجوي إلى تكلفته ويُنبَّه عليك.
  - **لماذا:**
    - المسبق لا يتجاوز المباشر أبدًا، فيُغلق ثغرة «الدفع عند الاستلام أرخص من المحفظة»؛
    - حقل واحد؛
    - منتج واحد فقط من 41 (AMS 2 Pro) يبيع مسارين اليوم، والباقي لا يتأثر.
- **B2 — خصم لكل مسار.**
  - تكتب مثلًا بري −50$ وجوي −0$.
  - **بالأرقام:** بري 1,425,000، وجوي 1,500,000.
  - ثلاثة حقول في كل مستوى.
- **B3 — الشحن يقرر الفرق.**
  - المسبق = المباشر − الخصم + (شحن المسار − شحن المخزون)، ولا يتجاوز المباشر.
  - **بالأرقام:** بري 1,425,000، وجوي 1,500,000 (كان سيصير 1,667,000 فقُصّ).
  - يتحرك سعر الجوي وحده كلما تغيّر سعر الشحن الجوي.

### القرار C — أسعار الألوان

المثال: فلامنت بموديلين: «مع بكرة» 20$ (30,000) و«بدون بكرة» 16$ (24,000)، ولون ذهبي أغلى.

- **C1 (موصى به) — اللون يتبع موديله، والاستثناء فرق ± بالدولار فوق كل موديل.**
  - السعر الخاص الثابت متاح فقط لتركيبة موديل × لون في «التفاصيل».
  - **بالأرقام:** ذهبي +2$ → 33,000 و27,000.
  - **لماذا:** لا يوجد لون مسعّر اليوم (0 من 153)، فلا يتغيّر أي سعر عند النقل. ويمنع خطأ
    «لون بسعر ثابت يلغي فرق الموديل».
- **C2 — كل الألوان بسعر واحد على مستوى المنتج، يتجاهل الموديل.**
  - **بالأرقام:** كل الألوان 20$، فيصير «بدون بكرة» 30,000 بدل 24,000 (+6,000 للبكرة).
- **C3 — يُسمح بسعر ثابت لكل لون يحل محل سعر الموديل (كما اليوم).**
  - **بالأرقام:** ذهبي ثابت 22$ → 33,000 للموديلين، أي «بدون بكرة» أغلى بـ 9,000 من موديله.
  - يحتاج تحذيرًا دائمًا.

### القرار D — عندما يُشترى مخزون بتكلفة جديدة

المثال: كان المورد 500 يورو، والشراء الجديد 520 يورو.

- **D1 (موصى به) — الشراء المؤكَّد يصبح تكلفة المنتج الحالية، والمسبق يتبع بالخصم.**
  - تراجع سعر البيع المباشر وحده في شاشة الشراء كما طلبت (الصف 215).
  - **بالأرقام:** المباشر 1,500,000 ← 1,533,000، والمسبق 1,425,000 ← 1,458,000. القطع
    القديمة تبقى بتكلفة دفعتها للأرباح.
  - **لماذا:** تكلفة واحدة ظاهرة في نموذج المنتج («من شراء … بتاريخ»)، وتُلغى الطبقة المخفية
    «مباشر فقط».
- **D2 — الشراء يسجّل تكلفة المخزون فقط، والسعر لا يتغيّر حتى تعدّله.**
  - **بالأرقام:** يبقى 1,500,000 / 1,425,000، وربح القطعة الجديدة 444,600 أي أقل من الحد
    الأدنى 477,000، ويظهر تنبيه.
- **D3 — كما اليوم: يتغيّر المباشر وحده.**
  - **بالأرقام:** المباشر 1,533,000، والمسبق يبقى 1,425,000، فيكبر الخصم بصمت من 75,000 إلى
    108,000.

### English mirror (same options, same numbers)

- **A. How the direct price is set**
  - **A1 (recommended):** both USD methods per product, cost-first by default, and no IQD mode.
    EUR 1.08 → 1.12: cost-first 1,500,000 → 1,530,000; USD-typed unchanged, at −30,000
    profit per unit.
  - **A2:** cost-first only. Incomplete products stay hidden.
  - **A3:** USD-typed only. A €20 supplier rise costs 32,400 per unit until the owner retypes.
- **B. Pre-order across routes** (stock by land 198,000, air 440,000)
  - **B1 (recommended):** one discount for all routes, with a no-loss floor. Land and air are
    both 1,425,000, and air earns 242,000 less. Only 1 of 41 products sells two routes.
  - **B2:** discount per route, for example land 1,425,000 and air 1,500,000.
  - **B3:** the freight difference is added and capped at direct. Land 1,425,000, air
    1,500,000, and air moves with the air freight rate.
- **C. Colours** (models $20 / $16)
  - **C1 (recommended):** follow the model, with ± USD colour differences. Gold +$2 →
    33,000 / 27,000. No live price changes, since 0 of 153 colours are priced today.
  - **C2:** one product-wide colour price. Refill goes 24,000 → 30,000.
  - **C3:** a fixed colour price replaces the model. Refill Gold costs 9,000 over its model.
- **D. A stock purchase at a new cost** (€500 → €520)
  - **D1 (recommended):** the purchase becomes the current cost, and pre-order follows by the
    discount. Direct 1,533,000, pre-order 1,458,000.
  - **D2:** cost recorded only, prices unchanged. New units earn 444,600, below the 477,000
    minimum.
  - **D3:** today's rule. Direct 1,533,000 while pre-order stays 1,425,000, and the discount
    silently grows to 108,000.

---

## 9. Catalog-only products and price requests (DECISIONS rows 239 and 240, migration 0193)

**Two predicates, not one** (`worker/lib/listing.ts`):

- **VISIBLE**: the product is `active` and the owner's «إخفاء المنتجات الناقصة» switch does not hold it
  for a catalogue gap (`IMAGE` or `CATEGORY`, `CATALOG_BLOCKING_CODES`). Every customer READ asks it:
  the listing, search, sections, the product page, the public API, the sitemap, the bot preview, the
  comparison, both favourites lists, the community search, the printer finder, «يناسب» and the RPC feed.
- **SELLABLE**: the old «listed» predicate byte for byte — visible, not held for ANY gap, and
  V2-published. Every PURCHASE path asks it: cart add, read and edit, the quote, checkout, Quick Buy, new
  gifts, bundles and mystery offers, the trade-in target, «لكيتها بمكان أرخص», the print calculator's
  materials and the stock-alert arming.
- **Catalog-only** = visible and not sellable. It is derived, never stored. A database without 0189
  shows every active product catalog-only and sells nothing; one without 0184 drops both held clauses
  (`runListed` retries once per missing piece). `tests/listingPredicateGuard.test.ts` counts every
  call site per family and bans every VISIBLE question — `statesOf` included — in a purchase file,
  which asks `sellableAndCatalogOnly` (admit on the sellable set; the catalog-only set only names the
  refusal); `tests/listingSplit.test.ts` holds the matrix.

**No number for an unpriced product.** Every customer projection carries `price_status`
(`priced` / `unpriced`). An unpriced card is an allow-list (`catalogOnlyCard`): identity, text, media,
classification, specs, options and colours without a price or stock key, `price_iqd: null`,
`display_price_iqd: null`, no availability, no sale types — the legacy dinar columns are never read,
so the archive 0190 kept never surfaces. A purchase door answers 409 `PRICE_NOT_AVAILABLE`
(ar / en / ckb); checkout keeps `PRODUCT_CURRENTLY_UNAVAILABLE` naming the products; a granted gift is
honoured at its frozen value.

**Per SKU.** A V2 product whose engine priced some SKUs and not others (a colour added after
publication) stays sellable. The page lists `unpriced_selections`; `price_levels.combo` for those keys
and the levels with no priced SKU are `null` (never the ladder, which is another SKU's price); the
quote answers 200 `price_status: 'unpriced'` with no number for such a selection, and for any
selection naming a value or colour no priced SKU carries (`namesUnpricedChoice`); the cart add keeps
`VARIANT_UNAVAILABLE` for it, and a saved cart line on such a SKU is listed apart
(`PRICE_NOT_AVAILABLE`, with the product's `slug`) with no number and out of every total;
`initial_selection` is always a priced SKU.

**Order rules.** Browse lists (the listing without search, sections, home new arrivals, the finder)
put sellable first (`sellable_now DESC` in SQL, so the 300-candidate cap keeps priced items); search
keeps its relevance; both price sorts put unpriced last; price ranges, «عليها عرض» and «سعر أقل
للأعضاء» exclude unpriced; commercial shelves (featured, discounted, flash, best sellers, open box,
filament) are sellable only; new arrivals take at most 5 catalog-only products, only in slots fewer
than 20 priced ones leave empty. The edge-cache epoch and the public projection revision moved to
`catalog-only-2026-10-15`.

**«طلب السعر»** (`worker/routes/priceRequests.ts`, `worker/lib/priceRequests.ts`): signed-in only.
`POST /api/price-requests` `{ product_id, option_value_ids?, color_id?, notify? }` keeps ONE row per
(person, product, selection) — a repeat tap raises `click_count`, never the count of people — and
recomputes `product_price_request_stats` from source in the same batch. The selection is checked on the
server against the product's real SKUs (`checkSelection`, worker/lib/commercialState.ts). Caps: 50 open
a person, 20 a product; rate limits 20 / 600 s (ask), 120 / 60 s (read), 30 / 600 s (change). The
quarter-hour tick runs `sweepPriceRequests` last (its own 40 statements): a selection that became
sellable through any door is `notified` (in-app with Sorani in `meta`, plus outbox rows, key
`price_available:<id>:<cycle>`) or `closed(priced)` without consent. It reads 20 rows a product
(least recently checked first) and progresses PER ROW: each batch carries its rows' writes, their
cursor and the stats; a product with many people to tell takes a fair share of the tick and the rest
wait first in line, never blocking the products after it. Then `digestPriceRequests` sends at most one
Arabic digest an hour to the «البلاغات» topic, at 1, 3, 10, 25, 50, 100 people and every 100 after,
claim-then-send; the threshold test is SQL before the candidate LIMIT, the high-water mark follows the
open count down (returning demand is news again), and the routing's two reads are charged. The
needs-pricing queue orders by distinct requesters then the latest request in SQL (inside the 200
cap) and offers «الأكثر طلباً» with per-selection counts; the products list has a `price_requests`
column, a `requests` sort and `requested=1`. Customers never see counts.
