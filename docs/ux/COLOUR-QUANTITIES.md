# Colour quantities: several colours in one add, and no quantity carried to the wrong colour

**Status:** design spec, 2026-10-16. Nothing here is built yet.
**Tree read:** `feat/colour-qty` at `0d8ed43b` (the live default). Every `file:line` below is at that commit; re-locate by name if the tree has moved.
**Owner's request:** «حل نقطة ضعف في التصميم لمنع الخطأ» (fix the design weakness so the mistake cannot happen).
**Ships through:** CI and workflow 7, like every change. **No migration.** Every new read of an optional table keeps its presence probe (CLAUDE.md rule 2).

This repository is public. The incident is described here by its pattern only. The order number, the customer, the product and the stock figures stay in the private investigation.

---

## 0. What happened, and what the page did to allow it

In October 2026 a customer believed they had ordered 50 spools of one filament in black, 5 in white and 1 in beige. The order held a single line: **56 × the last colour tapped**. The investigation found no fault in the server, the cart, the checkout or the database: each colour is its own cart line, and nothing merges two colours. The customer most likely tapped black, then white, then beige. This is the investigation's inference from the page's price checks, consistent with the data but not proven by it. The colour chips are single-select, so the last tap won. The one quantity box kept its number through every tap, and one add sent «beige × 56». 56 = 50 + 5 + 1, so the intent was real. The page made the mistake easy:

| # | Weakness on the live page | Where |
|---|---|---|
| W1 | One colour and one quantity per add. There is no way to say «50 of this, 5 of that». | `colorId` and `qty` state, `src/pages/Product.tsx:1063`, `:1066` |
| W2 | Tapping a colour chip replaces the previous colour. Nothing tells the customer that the chips are single-select. | `setColorId(selected ? '' : col.id)`, `Product.tsx:3725` |
| W3 | The quantity stays as typed when the colour changes. It resets only when a new product loads. | `Product.tsx:1266`. The clamp effect at `:1645-1648` only lowers it. |
| W4 | The add button never says what it adds. It reads «أضف إلى السلة» whatever the colour and quantity. | `buyButtonLabel`, `Product.tsx:4022-4030`; the label slot in `src/components/quickBuy/QuickBuyBar.tsx:502` |
| W5 | After the add, the confirmation says «تمت الإضافة إلى السلة (n)», where n is the number of items in the whole cart. It does not name the colour, and it is gone after 3 s. | `Product.tsx:1924`, `:1563-1573` |
| W6 | Most colours have no picture of their own, so the gallery does not change when a colour is tapped. Nothing on the photo says which colour is chosen. | `colorImage()`, `Product.tsx:2328` |
| W7 | On the checkout and cart screens the colour is only the last word of a 12 px grey label («With spool — 1 kg / BEIGE»), and the quantity is a 10 px badge on the photo. | `src/pages/Checkout.tsx:2508-2514`, `src/pages/Cart.tsx:1690` |
| W8 | The thermal ESC/POS receipt and the courier waybill do not print the colour. The packing caption has no Sorani. | `worker/lib/receipts.ts:595-597`, `worker/routes/admin.ts:3192`, `src/components/adminOrders/OrderDetailModal.tsx:717` |

The fix closes each of these. The guards are layered, so that missing one of them is not enough to repeat the incident:

1. **Before any tap:** the page shows that colours are chosen one at a time, and offers a mode for several colours (§3.2).
2. **While tapping:** changing the colour returns the quantity to 1, and the page offers the per-colour mode with the old quantity kept on its colour (D4). Tapping a third colour opens the same offer (D6).
3. **At the press:** the button names exactly what it will add, for example «أضف 56 × Beige» or «أضف 56 قطعة (3 ألوان)» (D3).
4. **After the press:** the confirmation lists each colour with its quantity (§3.8).
5. **At checkout and on paper:** every line shows its colour as a swatch and a name, in text that survives a thermal printer (§5–§7).

---

## 1. Principles

1. **A quantity always belongs to one colour.** No number entered while one colour was on screen is ever sent with another colour without the customer seeing it happen.
2. **The button says what it does.** Whenever a colour is involved, the label names the colour and the count.
3. **All or nothing.** Several colours are added in one request that either adds every line or adds none. A customer never gets 50 black added and the white refused without being told.
4. **The server's rules are written once.** Each line of a multi-colour add is judged by the same code as a single add, extracted rather than copied.
5. **Products without colours do not change.** No new control appears, the label stays «أضف إلى السلة», the quantity behaves as it does today, and the request stays the same.
6. **Clay and tokens only.** New surfaces are built from `lv-section`, `lv-choice` (`data-selected`), `lv-well`, `lv-button`, `Segmented`, `QuantityInput`, `Sheet` and `Toast`. They use no hand-written shadows, arbitrary radii or zinc utilities, and the `tests/claySystem.test.ts` ratchet does not rise.

---

## 2. Decisions

### D1. How the customer enters several colours: a two-way switch beside the colour chips

| Option | For | Against | Verdict |
|---|---|---|---|
| **A switch «لون واحد \| عدة ألوان» in the colour section; the chips become a list of colour rows in place** | The mode is visible **before** the first tap, which is the moment the incident went wrong. The single-colour flow is untouched. The row with a «+» is the pattern of the food-delivery apps Iraqi phone users order from every day: tap + on each thing you want, see the total, press once. | One more control on pages with colours. | **Chosen** |
| The list turns on by itself when the quantity is above 1 | No new control. | On a phone the quantity stepper is in the bottom bar, about 600 px below the chips, so the page would reshape out of the customer's view. A large quantity of one colour is a legitimate order, and the page would change its shape while the customer types. | Rejected |
| A sheet opened from a link «كميات لعدة ألوان» | Room for 30 colours. | It hides the right tool behind a link that a customer who believes the chips are multi-select will never look for. That is the incident's customer. | Rejected as the entry. The long-list case is handled by §3.3 (8 rows shown, then «عرض كل الألوان»). |
| Multi-select chips | Matches what the customer expected. | Each chip still needs its own quantity, so the chips become rows anyway. Chips that are multi-select here and single-select for every option group above them would be a second, invisible inconsistency. | Rejected |

The switch is `Segmented` (`src/components/ui/Segmented.tsx`) with `size="sm"`. It is a real radio group with arrow keys that follow the writing direction. The default is **«لون واحد»**. Its second item carries a badge with the number of colours that have a quantity («عدة ألوان (3)»), so quantities left in that mode are never invisible.

### D2. Server: a new all-or-nothing door, `POST /api/cart/items/batch`

| Option | Verdict |
|---|---|
| One `POST /api/cart/items` per colour, sent one after another | **Rejected.** A refusal on the second line leaves the first added. Deleting the first line to undo it is wrong when the add **merged** into a line that already existed, because the line has to go back to its old quantity, not disappear. The undo would also race the customer's other tabs. This is exactly the «50 black added, white refused» outcome the owner ruled out. |
| **A batch door that judges every line, then writes all of them in one D1 `batch()`** | **Chosen.** D1 runs a `batch()` as one transaction: if any statement fails (a CHECK, the 0114 seller trigger, a unique index), none of them is applied. |

The door's validation is the single add's validation, line by line. This is done by extracting it, not copying it (§4.2). It also adds the one rule a single add never needed: lines that draw on **the same stock counter** are summed before they are judged, with the checkout's own keying (§4.3).

### D3. The add button and the buy bar name what will be added

- **Single mode with a colour chosen:** «أضف 50 × Black», "Add 50 × Black", «زیادکردنی 50 × Black». At quantity 1 it is still «أضف 1 × Black». **It is never the bare «أضف إلى السلة» once a colour is chosen.**
- **Multi mode:** «أضف 56 قطعة (3 ألوان)», "Add 56 pieces (3 colours)", «زیادکردنی 56 پارچە (3 ڕەنگ)». With only one row filled, it is the single form «أضف 50 × Black».
- **A colour is required but not chosen:** «اختر لونًا أولًا», shown disabled. Today the label reads «أضف إلى السلة», also disabled.
- **A product without colours:** «أضف إلى السلة», unchanged.

Colour names are **English in every language**: this is the product-form mandate §7, enforced by `pickName` at `Product.tsx:821-830`. So the Arabic button reads «أضف 50 × Black», not «أضف 50 × أسود». See open question Q1.

### D4. When the colour changes in single mode while the quantity is above 1: reset to 1, and offer both meanings

**Decision: reset the quantity to 1.** A hint appears where the tap happened and offers two one-tap ways back:

> غيّرت اللون، فرجعت الكمية إلى 1 — كل كمية تخص لونًا واحدًا.
> [ حدّد كمية لكل لون ]   [ أبقِ 50 لـ White ]

**Why this and not «keep the quantity and show the colour on the button».** One reconstruction that fits the evidence is one quantity box adjusted while the customer moved between colours (black 50, then white with +5, then beige with +1), followed by one press. The other (three adds of the last colour: 50, then 5, then 1) is closed by D3 and D5: each press names the colour, and the quantity returns to 1 after each add. Keeping the number works only if the customer reads a button they believe they already understand. Resetting makes the rule visible **at the moment of the colour tap**: the number they typed visibly changes. The hint then offers the two things they might have meant:

- **«حدّد كمية لكل لون»** opens multi mode with the **previous** colour already holding the previous quantity (Black: 50) and focus on the **new** colour's row (White: 0). The customer's own mental model («50 black, now some white») is carried into the tool built for it.
- **«أبقِ 50 لـ White»** restores the number for the new colour, clamped to that colour's ceiling. This is the colour-swap case («I meant white, not black»), and it costs one tap.

Rules:

- The reset runs in the **chip's tap handler**, never in an effect. Programmatic colour changes keep today's behaviour: the opening selection (`:1315`), the price-request return (`:1710`), and a colour dropped because the option changed (`:1630-1632`).
- It applies to a product colour (`colorId`) and to the value of an option group whose `kind` is `'color'` (the import's colour groups, `Product.tsx:3339`).
- From no colour to a colour, the quantity is kept: that is the colour the quantity was typed for. From a colour to no colour (tapping the selected chip), the quantity is kept and the button reads «اختر لونًا أولًا».
- At quantity 1 nothing resets and no hint appears.
- The hint is `role="status"`. It stays until the customer next changes the quantity, adds, or taps «حسنًا». It is not timed out while it holds focus. On a phone the bar stepper shows the new 1 at once (a 160 ms highlight, none under reduced motion).
- Changing an **option** (size, spool type) or the **order type** keeps today's behaviour (keep, then clamp). The button names the colour, and the option chooser sits above the colour chooser, so the order of entry normally follows it.

### D5. After a successful add: confirm what was added, then start clean

- **Single mode (with a colour):** the existing success banner (phone bar `:4808-4822`, panel `:4004-4015`) reads «أُضيف إلى السلة: 50 × Black» with «عرض السلة», and stays **6 s** (paused while focused or hovered). For 3 s the button reads «أُضيف 50 × Black», built from the **added** values, not from the current state. Then **the quantity returns to 1**. If the merge was capped (§3.8), the banner says so instead.
- **Multi mode:** a confirmation sheet lists every line **as the server reports it** (`added[]`, §4.4): each colour's swatch, name and «× 50», a capped note where one applies, the number of pieces added, and «عرض السلة» (primary) with «متابعة التسوق». When the sheet closes, **every row returns to 0** and the page stays in multi mode.
- Quick Buy success (`runQuickBuy`, `:2080`) also returns the quantity to 1, so that no next colour inherits a quantity from either door.
- **Products without colours:** unchanged (banner text, 3 s, quantity kept).

A sheet, not a toast, for multi mode: the confirmation is a list, and the list is what the customer must check. Three lines of colour and quantity do not read in a 4 s toast.

### D6. A hint when the customer seems to be choosing several colours

In single mode, on a product with at least 2 colours that can be bought, the page shows once per product view:

> يُختار لون واحد في كل مرة. تريد عدة ألوان؟  [ حدّد كمية لكل لون ]  [ حسنًا ]

It appears when **three different colours are tapped within 30 s with no add in between**. Its action opens multi mode with those colours as rows (all at 0, focus on the first). A customer who is only comparing colours sees it at most once per view, and it blocks nothing.

**Second trigger:** a typed quantity of **10 or more** on a product with at least 2 sellable colours shows the quiet link «لعدة ألوان: حدّد كمية لكل لون» in the bar's note slot. That slot holds `inCartNote` today, and the link takes it only when nothing is in the cart for this selection. It shows once per view.

Priority when more than one would show: the D4 reset hint, then the three-colour hint, then the large-quantity link. Only one is ever on screen.

### D7. Cart and checkout show the colour as a swatch and a name, and group colours under their product

See §5 and §6. The colour moves out of the grey label into its own tag (swatch plus name) at body size. Several lines of one product are drawn as one group with a header.

### D8. Paper carries the colour as text

See §7. The ESC/POS receipt and the courier waybill gain the stored selection text. The HTML receipt prints it larger and bold. The packing caption gains its Sorani.

### D9. What does not change

The single add door `POST /api/cart/items` keeps its behaviour, its response and its tests. Its validation is moved into a shared function, and a parity test holds both doors to the same answers (§4.2). The cart's line identity and unique index are unchanged. Products without colours and option-only products are unchanged. Bundles, mystery products and merchant products are unchanged. Quick Buy takes one colour (§3.9).

---

## 3. Product page

### 3.1 Which products get multi mode

Multi mode (the switch) is offered when **all** of these hold:

- `source === 'catalog'` (not a community listing), and the page is not catalog-only or unpriced (`!noPrice`; DECISIONS rows 239-240);
- the product is not a composition (bundle or mystery); those have their own door;
- the **colour dimension** has at least **2 values that can take a quantity** for the current shared selection. Such a value is offered with the chosen options (`colorsForOption`, `:1605`; or `valueOffered` for a colour group), is not «بلا سعر» (`colorNoPrice`, `:3070`), and is not sold out when the order type is direct sale (`levelChip`, `:2426`).

The **colour dimension** is `product.colors` when there are any (`orderedColors`, `:2390`). Otherwise it is the relational option group with `kind === 'color'`, which only exists where migration 0194 is installed. When both exist, `product.colors` wins.

When the switch is not offered, nothing about the page changes from today except D3 to D6.

### 3.2 The switch

- **Placement:** inside the colour `fieldset` (`:3683-3760`, or the colour group's fieldset at `:3344`), on its own row under the legend and above the chips. It is not squeezed into the legend line: on a 360 px phone the legend «الألوان المتاحة · Cold White» already takes about 150 px.
- **Control:** `Segmented`, `size="sm"` (36 px track; each option still reaches a 44 px target through the track padding), `group="colour-mode"`, `label` = «طريقة اختيار الألوان», items «لون واحد» and «عدة ألوان». The second item's `badge` is the count of rows with a quantity, shown only when it is above 0.
- **Warming:** on `pointerdown` or `focus` of the switch, the page imports the lazy chunk `ColourQuantityPanel` (§3.11), the way `warmQuickBuy` does (`:2017`).
- **Entering multi mode:** if a colour is selected in single mode, its row starts with the single quantity. That number was typed for that colour, so nothing is inherited. Every other row starts at 0. Rows remembered from an earlier visit to multi mode on this view are restored, and the single colour's row takes the single quantity only if that row was at 0.
- **Leaving multi mode:** if exactly **one** row has a quantity, single mode takes that colour and that quantity. Otherwise single mode keeps its own last colour at quantity 1, and the rows are kept in memory; the badge on «عدة ألوان» shows their count. Nothing is lost by switching, and nothing moves to a colour the customer did not choose.
- The mode and the rows live for this product view only. They are not stored.

### 3.3 The list of colour rows

The list replaces the chips in place, in the same fieldset. The legend becomes «الكمية لكل لون». One line of intro sits under the switch: «اضغط + على كل لون تريده، ثم أضفها كلها بضغطة واحدة.»

**Row anatomy** (a 360 px phone with a 16 px gutter gives 328 px of content):

```
inline-start                                                   inline-end
┌───────────────────────────────────────────────────────────────────────┐
│ (swatch 32)  Jade White (10100)                  [ − ][  50  ][ + ]   │  ← min 56 px tall
│              متوفر 120 · في السلة: 10                                  │
└───────────────────────────────────────────────────────────────────────┘
```

- **The row:** a `div` with the class `lv-choice` and `data-selected="true"` when its quantity is above 0. That gives the house «ink border plus check» selection look, with `lv-choice-mark` at the end. The row is not itself a button; only the stepper is interactive.
- **Swatch:** the colour's own image when one is bound (`colorImage(id)`, 32 px, `rounded-full`, `object-cover`). Otherwise `hex` (or the colour group's `swatch.url` / `published_hex`) in a 32 px circle with `ring-1 ring-border-subtle`, so white and black stay visible in both themes. With no hex at all, a neutral `bg-surface-raised` circle.
- **Name:** 14 px bold, `text-text-primary`, in `<bdi>`, truncated with an ellipsis (`truncate`) inside the isolate. The full name is in the stepper's accessible name.
- **Second line** (12 px): items joined by « · », each shown only when it has something true to say:
  - availability: `levelChip` for this colour, so the shelf is shown only for a direct sale, with the existing «نفد» / «بقي n» / «متوفر n» words and tints;
  - «بلا سعر» (`noPriceTag`) for an unpriced colour;
  - the unit price, **only when the rows' unit prices differ**, from `price_levels` (`L.combo[optionId|colorId]` or `L.color[colorId]`) or the row's fresh quote (§3.6). The struck regular price is shown when the applied price is lower, as on the cart line;
  - «في السلة: n» when the cart already holds this exact selection, by the same identity as `inCartQty` (`:1805`).
- **Stepper:** `QuantityInput` `size="sm"` with **`min={0}`** (§3.10), `max` = the row's ceiling (§3.5), `autoClamp`, and `hintPlacement="above"` on the last two visible rows (`"below"` otherwise). The labels name the colour (§3.10). A row that cannot take a quantity (sold out on direct sale, unpriced, or not offered) has its stepper **disabled**. Such rows sit after the rows that can take a quantity, by the same stable rule as `orderedColors` (`:2390`).
- **Order:** `orderedColors` for product colours. For a colour group, the group's value order, with the same «in stock first on direct sale» rule.
- **Long lists:** a product can have 30 colours (Bambu PLA Basic). Shown: every row with a quantity, then the first **8** others. Then a text button «عرض كل الألوان (30)» that shows the rest. It stays open for this view.
- **Under the list:** a summary row with «مجموع القطع: 56 — الألوان: 3» at the start and «تصفير الكميات» (a text button) at the end. Clearing raises a toast «صُفّرت الكميات» with «تراجع» (`Toast`, at least 6 s with an action).
- **Shared stock note:** when the counter is shared by every colour (§3.5), a line under the summary reads «المخزون مشترك بين الألوان: 52 متوفر لها كلها معًا».

The phone bar (`:4794-4855`) in multi mode:

```
┌───────────────────────────────────────────────────┐
│ الإجمالي                                           │
│ 1,120,000 د.ع                                      │
│ [ 🛒  أضف 56 قطعة (3 ألوان)                       ] │
└───────────────────────────────────────────────────┘
```

- `barStepper` is hidden: the quantities are in the rows. `inCartNote` is hidden too, because the rows carry it.
- The price cell's caption reads «الإجمالي» (`totalCaption`, §8.1). Its figure is Σ unit × qty (§3.6), shown with the existing pending style while any quote for a row with a quantity is in flight.
- **Quick Buy:** the `QuickBuyBar` is replaced by the plain primary button (the existing non-Quick-Buy branch at `:4067-4074`, `data-testid="product-cta"` kept). One line under it reads «الشراء السريع يأخذ لونًا واحدًا — عدة ألوان تُضاف إلى السلة.» `quickBuyFor` is kept, so returning to single mode brings ⚡ back as it was.

On the desktop panel (`:4781-4786`), `qtyControl` is replaced by the same summary row, and the button is the multi button.

### 3.4 What the shared selection is

Options (every non-colour group), the order type («طريقة التوفر»), the pre-order route («وسيلة النقل») and the extended-warranty plan are chosen **once**, above the list, with the existing controls, and apply to every row.

- **Changing an option or the order type while rows hold quantities:** rows whose colour is still offered **keep** their quantity, re-clamped to the new ceiling with the existing quiet hint. Rows whose colour is no longer offered are removed. A polite status reads «تغيّر الخيار إلى Refill — الكميات كما هي، راجعها قبل الإضافة.» and, when rows were removed, «أُزيلت ألوان لا تتوفر مع هذا الخيار: 2». The quantities sit on screen next to their colours, so this is not the hidden inheritance of D4.
- **Warranty** (printers only) applies one plan to every line. The fee is priced per line by the server, so each row's quote includes it.

### 3.5 Each row's ceiling

The client ceiling is a convenience. The server is the authority (§4).

| Order type and counter | The row's `max` |
|---|---|
| Direct sale, counter per colour: `inventory_mode` `COLOR`, or `VARIANT_COMBINATION` whose `combo_key` includes the colour (or the colour-group value) | That colour's `available` (`availByColor` / `variantAvailable`, `:2340-2349`), and after the row's quote lands, its `availability.stock.max_qty`. Untracked (`null`) means `LINE_QTY_MAX` (9,999). |
| Direct sale, **shared** counter: the quote's `availability.stock.scope` is `product`, `base` or `option` | `pool − Σ (the other rows)`, where `pool` is `availability.stock.max_qty` of the shared selection. The shared-stock note (§3.3) is shown. |
| Pre-order | `LINE_QTY_MAX`. Pre-order carries no counter today (`resolveForOrderType`, `worker/lib/inventory.ts:419-433`). If `availability.preorder.capacity.tracked` is ever true again, the capacity is shared by the colours (its `scope_id` names the model or the route, never a colour), so it is treated like the shared row above. The note then reads «حصة الطلب المسبق مشتركة بين الألوان: بقي n». |
| Any | Never above `LINE_QTY_MAX` per row. |

A ceiling that falls under a row's quantity lowers it, with the existing hint («الحد الأقصى المتوفر: n» or its Sorani, §8.5). A ceiling of 0 lowers the row to 0, and the row says «نفد — لن يُضاف». This is the owner's quantity rule: «set the most, never say no» (`packages/pricing/src/quantity.ts`).

### 3.6 Prices, quotes and the add gate

- **The price on a row with no quantity** comes from `price_levels`, which the server resolved at the viewer's tier on the page request: the offer window, the membership price and the SKU rung of DECISIONS row 200. It is not authoritative for an add, and it is not used for one. A multi-group selection has no level price (`:2520`), so its row shows no figure until it is quoted.
- **A row with a quantity is quoted once** through the existing `POST /api/products/:slug/quote` (`:1466`) with `qty: 1`, the shared selection, and this row's `colorId` (or its colour-group value added to `optionValueIds`). It is quoted again only when the shared selection changes. A quantity change never re-quotes: quantity is not in `priceKey` (`:1429`). There are at most 3 requests in flight, a superseded request is aborted, and the 12 s timeout is kept. The quote's rate limit is 120 per minute (`worker/routes/products.ts:4377`); one quote per colour fits inside it.
- From each quote, the row takes `unit_subtotal_iqd` (its price, warranty fee included), `availability.stock.max_qty` and `scope` (its ceiling), and `errors`. A quote answering `price_status: 'unpriced'` turns the row into «بلا سعر» and lowers it to 0.
- **Membership teaser.** The «what PRO would pay» preview (§8/§9, `:2575+`) answers **one** selection. It is hidden in multi mode and comes back in single mode. The applied tier of each row is still visible in its own price (struck regular price).
- **Total** = Σ over rows with a quantity of `unit_subtotal_iqd × qty`, the worker's own arithmetic, as `lineTotal` does at `:2570`.
- **Add gate (multi):** all of these must hold:
  - `canBuy`'s product-level conditions, without the colour: `source === 'catalog'`, `!noPrice`, the shared selection is complete, `routeReady`;
  - at least one row has a quantity;
  - every row with a quantity has a **fresh, error-free quote** for the current shared selection, and its quantity is at or under its ceiling;
  - no add is in flight.

  When the gate is closed only because no row has a quantity, the disabled button reads «حدّد كمية لون واحد على الأقل».

### 3.7 The add, in multi mode

- **One press** sends one `POST /api/cart/items/batch` (§4) with the shared selection and one line per row with a quantity. The lines are in row order, and each carries `inCart`: the quantity of that exact line the page believes the cart holds. `inCart` is sent only when the cart lines were actually loaded. The page tracks a new `cartLinesLoaded` flag beside `cartLines` (`:1777`), because today a failed load is indistinguishable from an empty cart.
- **Double-tap guard:** the same `addInFlight` ref as the single add (`:1891`). There is no automatic retry.
- **Signed out:** redirect to sign-in, as at `:1892-1895`. The rows are not carried through sign-in (open question Q4).
- **On success:** update `cartLines` and the nav badge from the response's `items`. Open the confirmation sheet from `added[]`. On close, clear the rows (D5).
- **On a refusal: nothing was added.** This is guaranteed by §4.
  - The status area (`role="alert"`) says «لم يُضَف شيء. صحّح اللون المعلَّم ثم اضغط مرة أخرى.».
  - Each refused line's row is marked: `aria-invalid` on its stepper, and the refusal sentence on the row's second line, linked with `aria-describedby`. The sentence comes from `reasonText(s, code)`, then `stockRefusal` and `refusalText` (`src/lib/refusalStrings.ts`), exactly as the single add does (`:1980-2003`).
  - Focus moves to the first refused row's stepper input, scrolled into view. A `QTY_UNAVAILABLE` row with a remainder lowers itself to the remainder, as the single add does (`:1993-1995`). A shared-stock refusal names the pool with the shared-stock sentence.
  - `CART_SHIPPING_CONFLICT` opens the existing dialog (`:4915-4921`). Its «empty the cart and add» button repeats **the same batch** with `replaceCart: true`.
  - `CART_CHANGED` re-reads `GET /api/cart`. If every line's quantity now equals `inCart + qty` (capped), the earlier press **did** land and only its answer was lost: the page treats it as success and opens the confirmation sheet from the fresh cart. Otherwise it shows the `CART_CHANGED` sentence and keeps the rows for another press.
  - A 404 from the door (a stale page talking to an older Worker) shows the generic failure with «حدّث الصفحة» and adds nothing.

### 3.8 Confirmations

**Single mode** (D5): the banner reads «أُضيف إلى السلة: 50 × Black». The page knows the cart line's quantity **before** the add (`inCartQty`) and **after** it (from the response). If `after < before + qty`, the merge was capped by the door (`cart.ts:2391`), and the banner instead says «في سلتك الآن 150 × Black — أقصى ما يتوفر». The door never refused, and the customer is told the number they now hold.

**Multi mode:** the confirmation sheet.

```
┌──────────────────────────────────────────┐
│ أُضيف إلى سلتك                       [×] │
│ ● Black                         × 50     │
│ ● Cold White                    × 5      │
│ ● Beige                         × 1      │
│   صار في السلة 12 — أقصى ما يتوفر لهذا اللون │  ← only on a capped line
│ ────────────────────────────────────────  │
│ مجموع القطع المضافة: 56                   │
│ [   عرض السلة   ]  [ متابعة التسوق ]      │
└──────────────────────────────────────────┘
```

- Built with `Sheet` (`src/components/ui/Sheet.tsx`). On a phone it opens at the `medium` detent, scrolling for long lists. From `sm` up it is a centred window. `title` = «أُضيف إلى سلتك».
- The lines come from the response, never from the rows. The swatch, `<bdi>` name and «× n» use the `ColourTag` component (§5.1).
- «عرض السلة» is a `Link` to `/cart`. «متابعة التسوق» closes the sheet. Escape and the scrim close it. Focus goes to the title on open and returns to the add button on close.

### 3.9 Quick Buy

Quick Buy stays **one colour**. Its door (`worker/lib/quickBuy/session.ts`) has no batch, and a multi-line instant purchase is a separate decision (open question Q3). In multi mode ⚡ is not drawn (§3.3). In single mode ⚡ works as today: after a success the quantity returns to 1 (D5), and the bar's price caption names the colour (§3.12).

### 3.10 Component changes

- **`packages/pricing/src/quantity.ts`:** `clampQuantity` and `resolveQuantityDraft` accept `min === 0` exactly: the floor is `min === 0 ? 0 : Math.max(1, Math.trunc(min) || 1)`. Every existing caller passes nothing or 1 and is unchanged. The Worker never passes 0, so a cart line still has a floor of 1. A typed «0» in a row means 0, and an empty draft goes back to the previous value.
- **`src/components/ui/QuantityInput.tsx`:**
  - new optional props `increaseLabel`, `decreaseLabel` (each replaces the fixed «زيادة الكمية» / «إنقاص الكمية» at `:223`, `:293`);
  - new optional prop `stepButtonsInTabOrder` (default `true`). The rows pass `false`: the − and + buttons get `tabIndex={-1}`, still respond to touch and click, and the spinbutton keeps ↑/↓ (`:281-286`). A keyboard then crosses 30 rows in 30 stops, not 90.
  - Fill the two Sorani hints marked «OWNER: Sorani to be written by hand» (`:118-122`). The rows surface them, and row 183 forbids leaving them to fall back to Arabic (§8.5).
- **`src/lib/colourQuantities.ts`** (new, pure, small, in the opening chunk, because single mode needs it):
  - `addLabel(lang, lines)`, `addedLabel(lang, line)`, `noticeText(lang, line, capped?)`: the strings of §8 with the Arabic plural forms of §8.2;
  - `isolate(name)`: wraps in U+2068 … U+2069 for plain-text contexts;
  - `shortColourName(name, 18)`: drops a trailing «(code)» first, then ellipsizes. Used only for the visible button label;
  - `qtyAfterColourChange({ from, to, qty })` returns `{ qty, hint: null | { kind: 'reset', previous: { colour, qty } } }` (D4);
  - `rowCeilings(rows, counters)` (§3.5);
  - `prefillRows(...)`, `leaveMulti(...)` (§3.2).
- **`src/components/product/ColourQuantityPanel.tsx`** (new, **lazy**): the switch's second state (the list, the summary, the batch add and its refusal mapping) and the confirmation sheet.
- **`src/components/product/ColourTag.tsx`** (new, small, shared by the product, cart and checkout pages): `{ name, hex?, image?, size: 'sm' | 'md' }`. It draws the swatch (`aria-hidden`) and `<bdi>` name.
- **`src/pages/Product.tsx`:** the D3 labels, the D4 handler, the D5 resets, the D6 hints, the §3.12 gallery chip and price caption, and mounting the lazy panel with `<ChunkBoundary compact>` and `React.Suspense`, like `PriceRequestPanel` (`:3038-3055`).

### 3.11 Bundle budget

`ColourQuantityPanel` is its own chunk and is **not** in the product page's static closure. Add it to the exclusion list in `tests/bundleBudget.test.ts:455` («opening a product excludes …»). Most visits to a product page never open multi mode, and they must not pay for it. `colourQuantities.ts` and `ColourTag.tsx` are small enough to ride with the page. Neither imports `motion`, so `tests/motionLazy.test.ts` is unaffected.

### 3.12 The two other places the page says which colour

- **Price caption in the bar:** in single mode with a colour chosen, the caption above the bar's figure (`:4841`) changes from «السعر» to «السعر · ● Black», using `ColourTag` `size="sm"`, truncated inside the isolate. This is the line that names the colour while ⚡ Quick Buy has the wide capsule.
- **Gallery chip (W6):** when a colour is chosen, the product has at least 2 colours, and the chosen colour has **no** image of its own (`colorImage(id) === ''`), the lead image carries a chip at its bottom inline-start corner. The chip reads «اللون المختار: Beige» with the swatch, on `bg-surface-raised` at 90% opacity with `text-text-primary`, 12 px. Its accessible text adds «الصورة لا تُظهر هذا اللون». It is not drawn in multi mode. The owner's lasting fix is a picture per colour (open question Q5).

---

## 4. Server: `POST /api/cart/items/batch`

### 4.1 Request

Signed in, like every cart route (`cart.ts:156`). JSON:

```json
{
  "productId": "prd_…",
  "fulfillmentType": "direct_sale",
  "transportMethod": "",
  "warrantyPlanId": "",
  "replaceCart": false,
  "lines": [
    { "optionValueIds": ["ov_spool_1kg"], "colorId": "col_black", "qty": 50, "inCart": 0 },
    { "optionValueIds": ["ov_spool_1kg"], "colorId": "col_white", "qty": 5,  "inCart": 0 },
    { "optionValueIds": ["ov_spool_1kg"], "colorId": "col_beige", "qty": 1,  "inCart": 0 }
  ]
}
```

Parsing uses the single door's parsers (`cart.ts:2112-2123`):

- `productId`: `str(min 1, max 60)`.
- Per line:
  - `qty`: `int(min 1, max QTY_INPUT_MAX)`;
  - `optionValueIds`: `canonicalOptionValueIds(raw).slice(0, 12)`. There is no legacy `optionId`, because the batch door has only new clients;
  - `colorId`: `str(max 60)`;
  - `inCart`: an optional `int(min 0, max LINE_QTY_MAX)`.
- `transportMethod`: `parseTransportMethod`.
- `fulfillmentType`: `parseFulfillmentType`.
- `warrantyPlanId`: as in the single door.
- `lines`: 1 to **40**. Above 40: `400 BATCH_TOO_MANY_LINES`. 40 covers the largest colour list in the catalogue (30) with room to spare.
- `inCart` is on every line or on none. A mix is `400 VALIDATION`.
- Two lines with the same identity (canonical `optionValueIds` plus `colorId`): `400 BATCH_DUPLICATE_LINE` with `details.line_indexes`. Without this, the second upsert would merge into the first inside the same transaction, and one line would hold both quantities.
- A rate limit of `rateLimit(c, 'cart_batch', 20, 60)`. The single door has none. The batch does up to 40 times the validation work.

### 4.2 Validation is the single add's, extracted

The body of `cartRoutes.post('/items')` from the product read (`:2128`) to the upsert parameters (`:2392`) moves into `worker/lib/cartAdd.ts`, split at its natural seams:

- `loadAddContext(c, productId, { warrantyPlanId })`: the sellable product read with `refuseIfOnlyCatalog`, the composition refusal (the batch answers `400 BATCH_NOT_SUPPORTED`; the single door keeps calling `addCompositionLine`), `cartPricing`, `loadRelationsViews`, `isPrinterProduct`, `loadOffers`, `refuseNonPrinterWarranty` (`:2161`, before the offer gate, as today), the offer gate (`MEMBERSHIP_REQUIRED`), and the mystery `coarseStock` probe. These are **product-level** checks, done **once** per batch.
- `judgeLevonisLine(ctx, line, shared)`: **pure**, no I/O. It covers `resolveCartLine`, the `OFFER_INACTIVE` / `TRANSPORT_REQUIRED` / SKU-strict / `VALIDATION` refusals, `saleAvailability`, `refuseIncompleteSelection`, `lineOrderType` and `unusableOrderType`, the routeless pre-order refusal, the `unavailable` refusal and `refuseQty`, **in the same order** as today (`:2167-2318`). It returns `{ canonical, canonicalJson, primaryOption, availability, lineType, ceiling }` or the `HttpError` the single door would have thrown.
- `upsertStatement(db, user, productId, judged, line, shared)`: the exact statement at `:2369-2392`, ceiling included.

The single door becomes `loadAddContext` → `judgeLevonisLine` (throw on refusal) → `enforceCartScope` → existing-line warranty check → `batch([...replacing, upsertStatement])` → `loadCart`. Its responses, codes and messages are **unchanged**. `tests/cartUpsert.test.ts`, `cartSelection`, `cartQuantityCeiling`, `cartPreorderQuotaWording`, `cartSeller*`, `cartMultiOptionIdentity` and `cartIdentityContract` must pass untouched.

### 4.3 Order of the batch door

1. Parse (§4.1), then the rate limit.
2. `loadAddContext`: product-level refusals end the request with the same code as a single add.
3. `judgeLevonisLine` for **every** line. Collect all line refusals; do not stop at the first. If any line was refused, answer with the first refused line's status and code, plus `details.lines` (§4.5). **Nothing is written.**
4. **Shared counters.** Each line's stock targets come from the checkout's resolver, `resolveForOrderType(lineType, snapshot, selection, …)`, as `worker/routes/orders.ts:2579` does. Sum per key `${scope}:${scope_id || product_id}`. That is the checkout's keying in `refuseAggregateDemand` (`orders.ts:1669-1728`), extracted as `demandByCounter(lines)` into `worker/lib/aggregateDemand.ts`; the checkout keeps its own throw on top of it. When a counter's total demand exceeds its `available`, answer `400 QTY_UNAVAILABLE` with `details.available` (left out for a coarse mystery member, `docs/BUNDLES_MYSTERY.md` §8.2 row 18), `details.shared: true` and `details.line_indexes`. Nothing is written. Without this step, three colours that share one shelf of 52 would each pass alone (50, 5 and 1 against 52), and the checkout would refuse the cart later.
5. `enforceCartScope(c, typeForTransport(transportMethod), replaceCart)`: **one** check for the whole batch, because every line shares the route. A `CART_SHIPPING_CONFLICT` or seller conflict ends the request with nothing written.
6. Unless `replacing`, **one** read of this user's existing lines of this product: `SELECT id, option_id, option_value_ids, color_id, qty, warranty_plan_id FROM cart_items WHERE user_id = ? AND product_id = ? AND shipping_method_id = ''` (2 bound parameters, never an `IN` list). Then, per line:
   - `inCart` (when sent) must equal the existing line's quantity (0 if there is none). Otherwise answer `409 CART_CHANGED` with `details.lines = [{ index, in_cart }]` and write nothing. This guard is what makes a press whose answer was lost safe to press again: the second press sees the doubled-up cart and refuses instead of adding a second 50 (§3.7). It needs no table and no migration.
   - The warranty conflict rule (`:2357-2362`), per line: `409 CART_WARRANTY_CONFLICT` with `details.lines`.
7. Write: `DB.batch([...replacing, ...lines.map(upsertStatement)])`. That is at most 1 + 40 statements with 11 bound parameters each (D1 allows 100 per statement), all in **one transaction**. `isCartSellerAbort` maps to `sellerConflictRefusal`, as at `:2397-2401`. Any other failure rolls back every line.
8. `loadCart(c)`. Then compute `added[]` by matching each line's identity (product, canonical `option_value_ids`, `color_id`) in the returned `items`, as the event block does at `:2410-2415`.
9. `AddToCart` per line, best effort, under the same `eventsEnabled` gate (`:2409`).

**Cost per request:** the product, relations, offers and mystery reads once; one existing-lines read; one scope read; one batch of up to 41 statements; `loadCart`. This is far under D1's 1,000 statements per invocation (DECISIONS row 201). The CPU cost is up to 40 pure `resolveCartLine` + `saleAvailability` calls on one loaded document.

**Cart identity:** `idx_cart_levonis_line (user_id, product_id, option_id, option_value_ids, color_id, shipping_method_id)` (`migrations/0141_cart_qty_ceiling.sql:51`). Each line of a batch is its own identity, and the targetless `ON CONFLICT DO UPDATE` merges into an existing identical line **exactly** as the single door does, up to the same ceiling `max(qty, min(LINE_QTY_MAX, max_qty))`.

### 4.4 Success

```json
{
  "success": true,
  "items": [ /* the whole cart, as GET /api/cart */ ],
  "tier": "regular", "tierActive": false,
  "added": [
    { "index": 0, "line_id": "ci_…", "option_value_ids": ["ov_spool_1kg"], "color_id": "col_black",
      "requested": 50, "before": 0, "after": 50, "capped": false }
  ]
}
```

`capped` is `after < before + requested`. A merge held to the ceiling is reported, never silent.

### 4.5 Refusal shape

The single door's shape (`{ success: false, error, code, details }`). `details` adds:

```json
{ "lines": [ { "index": 2, "color_id": "col_beige", "option_value_ids": ["ov_spool_1kg"],
               "code": "QTY_UNAVAILABLE", "message": "…", "available": 4, "preorder": false } ] }
```

`details` carries only what the single door's `details` already carries per line (`available` or `max_qty` with `preorder`, from `refuseQty` at `cart.ts:1708-1716`; `transport_methods`), so no new fact is published. A coarse mystery member's line carries no count, as today.

**New codes** (each with ar, en and ckb in `src/lib/refusalStrings.ts`, §8.4): `BATCH_TOO_MANY_LINES`, `BATCH_DUPLICATE_LINE`, `BATCH_NOT_SUPPORTED`, `CART_CHANGED`.

### 4.6 The colour as a field, for the cart and the checkout

`resolveCartLine` (`cart.ts:380-470`) already finds the colour to build `variantLabel`. It also returns:

- `colorTag`: `{ id, name, hex, image } | null`.
  - **For a product colour:** `name` = `name_en || name_ar || id` (the label's own rule, `:454-457`), `hex` = the colour row's `hex`, `image` = the first relational image bound to this `color_id`.
  - **For a colour-group value:** this applies only where the relations view carries the group `kind` (0194 installed, through the existing presence probe `catalogKnowledgeInstalled`). Then `name` = the value's `name_en` and `hex` = `swatch.published_hex`, and `image` = `swatch.url`.
  - Absent 0194, or with no colour, `colorTag` is `null` and every screen falls back to today's label.
- `optionsLabel`: the variant label **without** the colour part (`labels` before the colour is pushed, `:451-453`).

`GET /api/cart` items gain `color_tag` and `options_label`. Checkout quote lines (`orders.ts:2941`) gain the same two fields. Both are **additive**: an older client ignores them, and a newer client with an older Worker falls back to `variantLabel` / `variant`. `variantLabel` keeps its exact value, because invoices, emails and `option_snapshot` read it.

---

## 5. Cart page

### 5.1 Each line shows its colour

In the chip row under the name (`Cart.tsx:1677-1711`), the **first** item is a `ColourTag` `size="md"`: a 16 px swatch and the name at 13 px semibold `text-text-primary`, inside the existing chip shape (`bg-surface-raised border border-border-subtle rounded px-2 py-1`). For lines with options, the variant chip that opens the variant sheet then shows `options_label` only, so the colour is not printed twice. Without `color_tag`, the line renders exactly as today. The tag's accessible text is «اللون: Black».

### 5.2 Several colours of one product are one group

A pure `groupCartLines(items)` (in `src/lib/cartGroups.ts`) groups lines when **two or more** lines share `productId` and are ordinary lines: not `kind` gift, bundle or mystery, and not merchant lines (merchant lines live in their own cart).

- **Position:** a group sits where its first line sits in the server's order (`created_at DESC`, `cart.ts:710`). This is stable: an add never reshuffles the other groups.
- **Order inside a group:** the product's colour order (the index in `item.colors`), then `options_label`.
- **Group header:** product image 40 px, name, and «الألوان: 3 · القطع: 56». It carries a tri-state checkbox (`role="checkbox"`, `aria-checked="mixed"` when only some lines are selected), labelled «تحديد كل ألوان {product}», which selects or clears the group's lines in the existing selection set.
- **Lines inside a group:** each keeps its own checkbox, stepper, variant sheet and delete. Each is indented with `border-s-2 border-border-subtle ps-3`, the bundle-contents pattern of `OrderDetailModal.tsx:610`. The product name is not repeated. The image slot shows the colour's own image when one is bound; otherwise it shows a 40 px swatch circle, because the product photo would be the same picture three times. The `ColourTag` is the line's first and largest text.

### 5.3 Unchanged

Quantities, the colour change through the variant sheet (`CART_LINE_ALREADY_EXISTS` still refuses a change onto an existing colour), totals, the coupon and checkout selection.

---

## 6. Checkout

- **Line** (`Checkout.tsx:2500-2560`): under the name, a row with a `ColourTag` `size="md"` and «× 56» at 13 px bold `tabular-nums`. Under it, `options_label` in the existing muted 12 px style. The 20 px quantity badge on the photo stays. The colour comes from the quote line's `color_tag`. Before a quote, or from an older Worker, it comes from the cart line (`cartById.get(l.cart_item_id)`, its `color_tag`, else `colors.find(c => c.id === color_id)`), and the plain `variant` text remains the last fallback.
- **Grouping:** `summaryLines` goes through the same `groupCartLines` rule. A group shows the product image and name once, then one sub-line per colour: «● Black × 50 — 1,200,000». The group total is the sum of the server's line totals, never recomputed from unit prices.
- Gift lines, bundle disclosures and mystery lines are unchanged and never grouped.

---

## 7. Paper and the packing screen

The documents keep their languages. The receipts are Arabic and English (`ReceiptLang`, `worker/lib/receipts.ts:29`; `printLang`, `admin.ts:2789`). The waybill text goes to the courier as is. The selection text is the stored `option_snapshot` («With spool — 1 kg / BEIGE»), which already holds the options and the colour. That snapshot is the authority for what was sold. No document prints a colour read from today's catalogue, for the reason given at `OrderDetailModal.tsx:597-600`: a guessed split or a renamed colour can put the wrong item in the box.

| Document | Today | Change |
|---|---|---|
| **HTML purchase receipt** (`renderPurchaseReceipt`, `receipts.ts:269-300`) | The selection is under the name at **10 px regular**. | Print it at **11.5 px bold** on its own line, wrapped in `<bdi>`, never truncated. Bundle parts are unchanged. |
| **ESC/POS receipt** (`escposReceipt`, `receipts.ts:570-617`) | Name, then `x<qty>` and the total. **No selection.** | After the name line, print the selection as one or more lines indented by 2, **wrapped** at `charsPerLine − 2` and never cut. It passes through `asciiForPrinter()`: «—» and «–» become «-», «×» becomes «x», curly quotes become straight, «…» becomes «...», a no-break space becomes a space, and any other non-ASCII character is dropped. If letters were dropped (a name stored in Arabic), the line ends with « (*)» and the footer adds «(*) full text on the printed receipt». Then `x<qty>` and the total, as today. |
| **Courier waybill** (`itemsSummary`, `admin.ts:3155-3193`) | `${name_snapshot} x${qty}`, joined, cut at 500 characters. **No selection, and the cut can fall mid-line.** | A pure `courierItemsSummary(items, 500)` in `worker/lib/courierSummary.ts`. Each line is `${name} [${option_snapshot}] x${qty}`, read from `SELECT name_snapshot, option_snapshot, qty …` (bundle parts still excluded). If the total is over 500, product names are shortened first (to 40 characters with «…»). The selection and the quantity are **never** shortened. If it is still too long, whole lines are dropped from the end and replaced by «+N more». No cut ever falls inside a line. |
| **Packing screen** (`PackingSelection`, `OrderDetailModal.tsx:711-722`) | Caption `loc('الخيار واللون المطلوبان', 'Selected option and colour')`, **with no Sorani**. | Add the Sorani: «هەڵبژاردە و ڕەنگی داواکراو». The value stays the full snapshot at 15 px bold. **No swatch is drawn here**, for the reason above. |
| Delivery sticker (`labelBody`, `receipts.ts:424-460`) | Address and piece count. It lists no lines. | Unchanged. A 100 × 70 mm sticker is the courier's address label, not a packing list. |

---

## 8. Strings

Every string exists in Arabic, English and real Sorani (`ckb`). No `ckb` slot copies the Arabic (DECISIONS row 183). The Sorani reuses the app's own words: «ڕەنگ», «بڕ», «پارچە» (as in `BundleContents.tsx:76`), «سەبەتە», «زیادکرا بۆ سەبەتەکەت», «پشکی پێشداواکاری», «بهێڵەرەوە», «پاککردنەوە», «پاشگەزبوونەوە», «ڕەنگی هەڵبژێردراو». `{name}` is always an isolated colour name (§10). `{n}`, `{m}` and `{k}` are Latin digits through `groupedNumber`, matching the stepper.

### 8.1 Product page: switch, list, labels, hints

| Key | ar | en | ckb |
|---|---|---|---|
| `colourModeLabel` | طريقة اختيار الألوان | How to pick colours | شێوازی هەڵبژاردنی ڕەنگەکان |
| `colourModeOne` | لون واحد | One colour | یەک ڕەنگ |
| `colourModeMany` | عدة ألوان | Several colours | چەند ڕەنگێک |
| `perColourLegend` | الكمية لكل لون | Quantity per colour | بڕی هەر ڕەنگێک |
| `perColourIntro` | اضغط + على كل لون تريده، ثم أضفها كلها بضغطة واحدة. | Tap + on each colour you want, then add them all with one tap. | کرتە لە + ی هەر ڕەنگێک بکە کە دەتەوێت، پاشان هەموویان بە یەک کرتە زیاد بکە. |
| `rowQty(name)` | كمية {name} | Quantity of {name} | بڕی {name} |
| `rowIncrease(name)` | زيادة {name} | Increase {name} | زیادکردنی بڕی {name} |
| `rowDecrease(name)` | إنقاص {name} | Decrease {name} | کەمکردنەوەی بڕی {name} |
| `rowSoldOutZero` | نفد — لن يُضاف | Sold out — will not be added | نەماوە — زیاد ناکرێت |
| `showAllColours(n)` | عرض كل الألوان ({n}) | Show all colours ({n}) | هەموو ڕەنگەکان پیشان بدە ({n}) |
| `clearQuantities` | تصفير الكميات | Clear quantities | پاککردنەوەی بڕەکان |
| `quantitiesCleared` | صُفّرت الكميات | Quantities cleared | بڕەکان پاک کرانەوە |
| `undo` | تراجع | Undo | پاشگەزبوونەوە |
| `totalLine(n,k)` | مجموع القطع: {n} — الألوان: {k} | {n} pieces in {k} colours | کۆی پارچەکان: {n} — ڕەنگەکان: {k} |
| `totalCaption` | الإجمالي | Total | کۆی گشتی |
| `sharedStock(n)` | المخزون مشترك بين الألوان: {n} متوفر لها كلها معًا | Stock is shared by the colours: {n} available for all of them together | کۆگا لە نێوان ڕەنگەکاندا هاوبەشە: {n} بەردەستە بۆ هەموویان پێکەوە |
| `sharedQuota(n)` | حصة الطلب المسبق مشتركة بين الألوان: بقي {n} | The pre-order quota is shared by the colours: {n} left | پشکی پێشداواکاری لە نێوان ڕەنگەکاندا هاوبەشە: {n} ماوە |
| `optionChangedKept(name)` | تغيّر الخيار إلى {name} — الكميات كما هي، راجعها قبل الإضافة. | The option is now {name} — the quantities stayed; check them before adding. | هەڵبژاردەکە بوو بە {name} — بڕەکان وەک خۆیان ماونەتەوە؛ پێش زیادکردن بیانپشکنە. |
| `rowsDropped(k)` | أُزيلت ألوان لا تتوفر مع هذا الخيار: {k} | Colours not offered with this option were removed: {k} | ئەو ڕەنگانەی لەگەڵ ئەم هەڵبژاردەیە نین لابران: {k} |
| `quickBuyOneColour` | الشراء السريع يأخذ لونًا واحدًا — عدة ألوان تُضاف إلى السلة. | Quick Buy takes one colour — several colours go to the cart. | کڕینی خێرا تەنها یەک ڕەنگ وەردەگرێت — چەند ڕەنگێک بۆ سەبەتە زیاد دەکرێن. |
| `addOne(n,name)` | أضف {n} × {name} | Add {n} × {name} | زیادکردنی {n} × {name} |
| `addMany(n,k)` | أضف {piecesAcc(n)} ({coloursNom(k)}) — §8.2 | Add {n} pieces ({k} colours) | زیادکردنی {n} پارچە ({k} ڕەنگ) |
| `addedOne(n,name)` | أُضيف {n} × {name} | Added {n} × {name} | زیادکرا {n} × {name} |
| `addNone` | حدّد كمية لون واحد على الأقل | Set a quantity for at least one colour | بڕی لانیکەم یەک ڕەنگ دیاری بکە |
| `chooseColourFirst` | اختر لونًا أولًا | Choose a colour first | سەرەتا ڕەنگێک هەڵبژێرە |
| `noticeOne(n,name)` | أُضيف إلى السلة: {n} × {name} | Added to your cart: {n} × {name} | زیادکرا بۆ سەبەتەکەت: {n} × {name} |
| `noticeCapped(m,name)` | في سلتك الآن {m} × {name} — أقصى ما يتوفر | Your cart now holds {m} × {name} — the most available | ئێستا {m} × {name} لە سەبەتەکەتدایە — زۆرترینی بەردەست |
| `resetHint` | غيّرت اللون، فرجعت الكمية إلى 1 — كل كمية تخص لونًا واحدًا. | You changed the colour, so the quantity went back to 1 — each quantity belongs to one colour. | ڕەنگەکەت گۆڕی، بۆیە بڕەکە گەڕایەوە بۆ 1 — هەر بڕێک تەنها بۆ یەک ڕەنگە. |
| `keepQty(n,name)` | أبقِ {n} لـ {name} | Keep {n} for {name} | {n} بۆ {name} بهێڵەرەوە |
| `perColourAction` | حدّد كمية لكل لون | Set a quantity per colour | بڕی هەر ڕەنگێک دیاری بکە |
| `discoveryHint` | يُختار لون واحد في كل مرة. تريد عدة ألوان؟ | One colour is chosen at a time. Want several colours? | لە هەر جارێکدا یەک ڕەنگ هەڵدەبژێردرێت. چەند ڕەنگێکت دەوێت؟ |
| `bigQtyTip` | لعدة ألوان: حدّد كمية لكل لون | For several colours: set a quantity per colour | بۆ چەند ڕەنگێک: بڕی هەر ڕەنگێک دیاری بکە |
| `dismissOk` | حسنًا | OK | باشە |
| `galleryChosenColour(name)` | اللون المختار: {name} | Chosen colour: {name} | ڕەنگی هەڵبژێردراو: {name} |
| `galleryNoColourPhoto` | الصورة لا تُظهر هذا اللون | The photo does not show this colour | وێنەکە ئەم ڕەنگە پیشان نادات |
| `priceWithColour(name)` | السعر · {name} | Price · {name} | نرخ · {name} |
| `batchRefusedTop` | لم يُضَف شيء. صحّح اللون المعلَّم ثم اضغط مرة أخرى. | Nothing was added. Fix the marked colour, then tap again. | هیچ شتێک زیاد نەکرا. ڕەنگە نیشانکراوەکە ڕاست بکەرەوە، پاشان دووبارە کرتە بکە. |
| `reloadPage` | حدّث الصفحة | Reload the page | پەڕەکە نوێ بکەرەوە |

### 8.2 Arabic counted forms (pieces and colours)

The Arabic counted noun changes with the number, so the multi-mode button uses two small functions in `colourQuantities.ts`. English uses "piece"/"pieces" and "colour"/"colours". Sorani keeps the noun singular after a number («56 پارچە», «3 ڕەنگ»).

| n | `piecesAcc(n)` (object of «أضف») | `coloursNom(k)` (in the parentheses) |
|---|---|---|
| 1 | قطعة واحدة | لون واحد |
| 2 | قطعتين | لونان |
| 3–10 | {n} قطع | {k} ألوان |
| 11–99 | {n} قطعة | {k} لونًا |
| 100+ | {n} قطعة | {k} لون |

Examples: «أضف قطعتين (لونان)», «أضف 7 قطع (3 ألوان)», «أضف 56 قطعة (3 ألوان)», «أضف 120 قطعة (12 لونًا)». Lines that state a total after a colon («مجموع القطع: 56») need no agreement, which is why the summary and the announcements use that form.

### 8.3 Confirmation sheet

| Key | ar | en | ckb |
|---|---|---|---|
| `addedSheetTitle` | أُضيف إلى سلتك | Added to your cart | زیادکرا بۆ سەبەتەکەت |
| `addedLineCapped(m)` | صار في السلة {m} — أقصى ما يتوفر لهذا اللون | Your cart now holds {m} — the most available for this colour | ئێستا {m} لە سەبەتەکەتدایە — زۆرترینی بەردەست بۆ ئەم ڕەنگە |
| `addedTotal(n)` | مجموع القطع المضافة: {n} | Pieces added: {n} | کۆی پارچە زیادکراوەکان: {n} |
| `viewCart` (exists) | عرض السلة | View cart | بینینی سەبەتە |
| `keepShopping` | متابعة التسوق | Keep shopping | بەردەوامبە لە بازاڕکردن |

### 8.4 Refusals (`src/lib/refusalStrings.ts`)

| Code | ar | en | ckb |
|---|---|---|---|
| `CART_CHANGED` | تغيّرت سلتك من مكان آخر، فلم يُضَف شيء. راجع الكميات ثم اضغط مرة أخرى. | Your cart changed somewhere else, so nothing was added. Check the quantities and tap again. | سەبەتەکەت لە شوێنێکی ترەوە گۆڕا، بۆیە هیچ شتێک زیاد نەکرا. بڕەکان بپشکنە و دووبارە کرتە بکە. |
| `BATCH_DUPLICATE_LINE` | اللون نفسه مكرر في هذه الإضافة. | The same colour appears twice in this add. | هەمان ڕەنگ دوو جار لەم زیادکردنەدا هاتووە. |
| `BATCH_TOO_MANY_LINES` | يمكن إضافة 40 لونًا على الأكثر في المرة الواحدة. | At most 40 colours can be added at once. | لە یەک جاردا زۆرترین 40 ڕەنگ زیاد دەکرێت. |
| `BATCH_NOT_SUPPORTED` | هذا المنتج لا يُضاف بعدة ألوان دفعة واحدة — أضفه من صفحته. | This product cannot be added in several colours at once — add it from its page. | ئەم بەرهەمە ناتوانرێت بە چەند ڕەنگێک پێکەوە زیاد بکرێت — لە پەڕەکەیەوە زیادی بکە. |

A shared-counter `QTY_UNAVAILABLE` keeps the existing counted sentence (`stockRefusal`), and the row adds `sharedStock(n)`.

### 8.5 Cart, checkout, packing, and Sorani gaps this change makes visible

| Key | ar | en | ckb |
|---|---|---|---|
| `colourA11y(name)` | اللون: {name} | Colour: {name} | ڕەنگ: {name} |
| `groupSummary(k,n)` | الألوان: {k} · القطع: {n} | {k} colours · {n} pieces | {k} ڕەنگ · {n} پارچە |
| `groupSelect(product)` | تحديد كل ألوان {product} | Select every colour of {product} | هەموو ڕەنگەکانی {product} دیاری بکە |
| Packing caption (`OrderDetailModal.tsx:717`) | الخيار واللون المطلوبان | Selected option and colour | هەڵبژاردە و ڕەنگی داواکراو |
| `QuantityInput` stock hint (`:121-122`) | الحد الأقصى المتوفر: {n} | Maximum available: {n} | زۆرترینی بەردەست: {n} |
| `QuantityInput` quota hint (`:118-119`) | المتبقي من حصة الطلب المسبق: {n} | Pre-order quota left: {n} | ماوەی پشکی پێشداواکاری: {n} |
| `Product.tsx` `ckb.PREORDER_CAPACITY_EXHAUSTED` (`:439`, Arabic today) | — | — | پشکی پێشداواکاری بۆ ئەم هەڵبژاردەیە تەواو بووە. |
| `Product.tsx` `ckb.routeQuotaFull` (Arabic today) | — | — | پشکی ئەم ڕێگایە تەواو بووە |
| `Product.tsx` `ckb.preorderLeft` (Arabic today) | — | — | {n} ماوە لە پشکی پێشداواکاری |
| `Product.tsx` `ckb.directSoldOutPreorderOpen` (Arabic today) | — | — | کۆگای فرۆشتنی ڕاستەوخۆ نەماوە — پێشداواکاری هێشتا کراوەیە. |

The last four replace Arabic left in the `ckb` block under an older rule (`Product.tsx:431-442`, «NO SORANI IS INVENTED HERE»). That rule was superseded by DECISIONS row 183, and the rows and the bar now surface these sentences, so they must read in Sorani. The comment there is updated to cite row 183.

### 8.6 Screen-reader announcements

| Key | ar | en | ckb |
|---|---|---|---|
| `announceTotal(n,k,money)` | مجموع القطع {n}، الألوان {k}، الإجمالي {money} | {n} pieces in {k} colours, total {money} | کۆی پارچەکان {n}، ڕەنگەکان {k}، کۆی گشتی {money} |
| `announceMode(on)` | عدة ألوان: حدّد الكمية لكل لون / لون واحد | Several colours: set a quantity for each / One colour | چەند ڕەنگێک: بڕی هەر ڕەنگێک دیاری بکە / یەک ڕەنگ |

---

## 9. Accessibility

- **Switch:** `Segmented` gives `role="radiogroup"` with the accessible name «طريقة اختيار الألوان», `role="radio"` and `aria-checked` on each option, a roving `tabindex`, and arrow keys that follow `dir`. Changing the mode does **not** move focus. A polite live region says `announceMode`.
- **List:** a `fieldset` whose `legend` is «الكمية لكل لون». Each row is `role="group"` with `aria-labelledby` on its name. The stepper's spinbutton is labelled `rowQty(name)`, with `aria-valuemin=0` and `aria-valuemax=ceiling`. Its − and + buttons are labelled `rowDecrease(name)` and `rowIncrease(name)`, and they sit outside the tab order (§3.10). The row's second line is its `aria-describedby`, so availability and «في السلة» are read with the quantity.
- **Running total:** a visible `<p aria-live="polite" aria-atomic="true">` with `announceTotal`, written **600 ms after the last change**, so that holding + is not read out on every step.
- **Add button:** its accessible name is the **full** label, with the full colour name and the count, even when the visible name is shortened (§3.10). `data-testid="product-cta"` is kept.
- **Hints (D4, D6):** `role="status"` and polite. Their actions are real buttons. They are never dismissed while focus is inside them, and they are not timed out.
- **Refusal:** the top sentence is `role="alert"`. Each refused row's input gets `aria-invalid="true"` and `aria-describedby` on the row's refusal sentence. Focus moves to the first refused row.
- **Confirmation sheet:** `Sheet` (dialog, focus trap, Escape, scrim). `aria-labelledby` on the title. The lines are a `<ul>`, and each line's text reads «Black، 50». Focus returns to the add button on close.
- **Colour is never the only cue:** every swatch has its name next to it in text. A swatch is `aria-hidden`.
- **Targets:** the stepper keys draw 36 px and hit 44 px (`lv-hit`). The switch reaches 44 px. A row is at least 56 px tall.
- **Reduced motion:** the list appears without movement, the bar stepper's highlight is not drawn, and the sheet crossfades (the `Sheet` behaviour).
- **Contrast:** the row text and the swatch rings use `text-text-*` and `ring-border-subtle`, which `claySystem` already proves at 4.5:1 and 3:1 in both themes.

---

## 10. Right-to-left and bidi rules

Colour names are Latin (English in every language), placed inside Arabic and Sorani sentences. Without isolation the bidi algorithm reorders them. For «أضف 50 × Jade White (10100)», the closing parenthesis takes the paragraph's direction and jumps to the far side of the name. A name that starts with a digit («3D Black») splits from its own digit. Rules:

1. **Every colour name is isolated.** In JSX, use `<bdi>{name}</bdi>`. In any string that leaves JSX (an `aria-label`, `title`, toast text, live-region text or `document.title`), wrap it with `isolate(name)` = U+2068 FIRST STRONG ISOLATE + name + U+2069 POP DIRECTIONAL ISOLATE. Never use LRM or RLM marks, and never put `dir="ltr"` on the whole label.
2. **The count and «×» belong to the sentence.** They take the page's direction. «×» is U+00D7: bidi-neutral and not mirrored, with a space on each side. The order of tokens is the same in all three languages, count then «×» then name: «50 × Black». In Arabic and Sorani it reads from the right: «أضف 50 × Black», «زیادکردنی 50 × Black».
3. **Digits are Latin**, from `groupedNumber`, the same digits as the stepper the customer typed in. Money keeps `formatIqd`'s locale digits, as today.
4. **Lists** are joined with « · » (U+00B7 with spaces), and each name is isolated: «50 × Black · 5 × Cold White · 1 × Beige». In Arabic and Sorani the first item is at the right.
5. **Truncation happens inside the isolate.** Use `truncate` on the `<bdi>` element, or `shortColourName` on the name alone. Never slice the sentence, which could cut off the count.
6. **Paper:** the HTML receipt takes its `dir` from `lang` (`receipts.ts:234`), and the selection text is in `<bdi>`. ESC/POS is ASCII and left-to-right (§7). The courier summary is plain Latin.
7. **Inputs:** the stepper's field already has `dir="ltr"` (`QuantityInput.tsx:245`). Keep it.

---

## 11. Tests

Each new file uses the existing harnesses. Route tests use the real migrations on `node:sqlite`, mounted by `tests/fixtures/app.ts`. If `tests/rootShardBalance.test.ts` fails only because a test file is new, `scripts/test-timings.json` is refreshed from CI with `scripts/update-test-timings.mjs`.

**`tests/colourQuantities.test.ts`** (pure)
- `addLabel`:
  - one line gives «أضف 50 × ⁨Black⁩», "Add 50 × ⁨Black⁩" and «زیادکردنی 50 × ⁨Black⁩», with FSI/PDI around the name;
  - three lines give «أضف 56 قطعة (3 ألوان)»;
  - the Arabic forms in §8.2 for n = 2, 7, 11, 56, 100, 120 and k = 2, 3, 10, 11, 12;
  - the label is never «أضف إلى السلة» when any line has a colour.
- `qtyAfterColourChange`:
  - black to white at 50 resets to 1 with `previous: { black, 50 }`;
  - no colour to black at 50 keeps 50;
  - black to no colour keeps 50;
  - black to white at 1 keeps 1 with no hint.
- `rowCeilings`:
  - a per-colour counter is independent;
  - shared `product`/`base`/`option` gives `pool − Σ others`;
  - untracked gives 9,999;
  - pre-order gives 9,999, or the shared quota when tracked;
  - never above 9,999.
- `prefillRows` and `leaveMulti` follow §3.2: one row with a quantity returns as the single colour; zero or two or more rows are kept and counted.
- `shortColourName` drops «(10100)» first and never returns an empty string.

**`tests/quantityInput.test.ts`** (extend)
- `clampQuantity(-1, 10, 0)` is 0; `resolveQuantityDraft('0', { max: 10, min: 0, previous: 3 })` is 0; an empty draft with `min: 0` goes back to `previous`.
- The default `min` still floors at 1. Existing assertions such as `clampQuantity(5, 0).value === 1` are unchanged.
- `QuantityInput` source: `increaseLabel`, `decreaseLabel` and `stepButtonsInTabOrder` are wired to `aria-label` and `tabIndex`.

**`tests/cartBatchAdd.test.ts`** (route-level, real `cartRoutes`)
1. Black 50, white 5 and beige 1 give three `cart_items` rows with the right `color_id` and quantity. `added[]` has three entries with `before 0` and `after` equal to the request.
2. Beige out of stock: `400 OUT_OF_STOCK`, with `details.lines[0].index === 2`. **The table is byte-identical before and after**, including when black already had a line that would have merged.
3. All failing lines are reported, not only the first.
4. Shared shelf of 52 (`inventory_mode` `BASE`, and `OPTION`): 50 + 5 gives `400 QTY_UNAVAILABLE` with `shared: true`, `available: 52` and `line_indexes [0, 1]`. Nothing is written. With `COLOR` stock, the same request passes.
5. Merge and ceiling: an existing black line of 120 on a shelf of 150, plus 50, gives `after 150` and `capped true`.
6. Duplicate identity gives `400 BATCH_DUPLICATE_LINE`. 41 lines give `400 BATCH_TOO_MANY_LINES`. A bundle or mystery product gives `400 BATCH_NOT_SUPPORTED`.
7. A cart of the other shipping type gives `409 CART_SHIPPING_CONFLICT` and nothing written. The same request with `replaceCart` empties the cart and writes three lines **in one batch**: no state exists with the cart empty and the lines missing.
8. `inCart` mismatch gives `409 CART_CHANGED` with nothing written. **Pressing twice after a lost answer:** the second identical request with the original `inCart` values gives `CART_CHANGED`, and the quantities stay 50/5/1, not 100/10/2. An `inCart` on some lines only gives `400 VALIDATION`.
9. A warranty conflict on one line of a printer with colours gives `409 CART_WARRANTY_CONFLICT`, naming that line, with nothing written.
10. The 0114 seller trigger: a merchant line inserted between the read and the write gives the seller refusal, with nothing written.
11. A colour **option group** (0194 data, `kind 'color'`): three lines that differ only in the colour value give three rows that differ in `option_value_ids`.
12. **End to end:** checkout of the batch cart gives three `order_items` with their own `color_id`, three reservations each on its own colour's counter, and three invoice lines.
13. Catalog-only product gives `409 PRICE_NOT_AVAILABLE`. A live members-only offer gives `403 MEMBERSHIP_REQUIRED` once, not per line.

**`tests/cartBatchParity.test.ts`**
- A table of single-add bodies covers `OPTION_REQUIRED`, `OPTION_GROUP_REQUIRED`, `COLOR_REQUIRED`, `COLOR_OPTION_MISMATCH`, `COLOR_INACTIVE`, `OUT_OF_STOCK`, `QTY_UNAVAILABLE` (with `available`), `TRANSPORT_REQUIRED` (with `transport_methods`), `PREORDER_NOT_ENABLED`, the SKU-strict code, `OFFER_INACTIVE`, `WARRANTY_NOT_PRINTER`, `REGULAR_PRICE_INVALID` and a success.
- Each body goes through `POST /items` and through `POST /items/batch` as a one-line batch. The **status, code and the line's `details` must be equal**, and a success must write the identical row.
- This is the proof that the batch door's validation **is** the single door's.

**`tests/cartColourTag.test.ts`**
- A product colour line gives `color_tag {name_en, hex, image}` and `options_label` without the colour. `variantLabel` is unchanged.
- A colour-group line with 0194 present gives the value's name and `published_hex`.
- **0194 absent** (the presence probe answers false): `color_tag` is `null` and nothing fails (CLAUDE.md rule 2).
- The checkout quote line carries the same fields.

**`tests/cartGroups.test.ts`** (pure)
- Groups sit at their first line's position and stay stable under a new add.
- Inside a group, lines follow the product's colour order.
- Gifts, bundles, mystery lines and merchant lines are never grouped.
- A single line is not a group.

**`tests/receipts.test.ts`** (extend)
- ESC/POS prints the selection for every line, wrapped at `cols − 2` and never cut. For 32 and 48 columns «BEIGE» is present, «—» becomes «-», and an Arabic-only name gets « (*)» plus the footer.
- The HTML receipt prints the selection at 11.5 px bold in `<bdi>`.
- The totals still match the passed figures, an existing assertion.

**`tests/courierSummary.test.ts`** (pure)
- The incident's shape gives `… [With spool — 1 kg / BLACK] x50, … [… / COLD WHITE] x5, … [… / BEIGE] x1`.
- Over 500 characters: names are shortened first, a selection is never shortened, no cut falls mid-line, and «+N more» appears.
- Bundle children stay excluded.
- `admin.ts` reads `option_snapshot`.

**`tests/colourQuantitiesSorani.test.ts`**
- For every key in §8 and every new `refusalStrings` code, the ckb text exists, is not equal to the ar text or the en text (the method of `tests/refusalStrings.test.ts:74-85`), and contains none of the letters Sorani does not use (`ة`, `ى`, `أ`, `إ`, `ؤ`).
- The packing caption's `loc` has three arguments.
- The two `QuantityInput` hints have Sorani.
- The four `Product.tsx` slots in §8.5 have Sorani.

**`tests/productColourFlow.test.ts`** (source level, as `productSelectionMemory.test.ts` does)
- `buyButtonLabel` reads `addLabel` whenever a colour is chosen. The literal `s.addToCart` is reached only for a product with no colour dimension.
- The D4 reset is called from the chip and swatch handlers, and **no** `useEffect` sets `qty` from `colorId`.
- After a successful single add, and after a Quick Buy success, `setQty(1)` runs.
- `data-testid="product-cta"` is kept in both buy-button branches.
- `ColourQuantityPanel` is imported only through `React.lazy`.

**`tests/bundleBudget.test.ts`** (extend): `ColourQuantityPanel` joins the «opening a product excludes …» list.

**`tests/claySystem.test.ts`:** unchanged. The ratchet must not rise. Run `node scripts/clay-census.mjs`.

**Browser walk** (local Playwright: the `playwright` package at `/opt/node22/lib/node_modules/playwright`, Chromium at `/opt/pw-browsers`; never against the live site):
- A local Worker with a seeded product with 3 colours and one with 30.
- At 360, 390 and 1280 px, in ar, en and ckb, light and dark:
  - single mode: tap black, type 50, tap white. The quantity shows 1, the hint shows, «أبقِ 50» works, and «حدّد كمية لكل لون» opens multi mode with Black 50;
  - multi mode: set 50/5/1. The button reads «أضف 56 قطعة (3 ألوان)». Press it; the sheet lists three lines;
  - the cart shows one group with three colour lines, and the checkout shows three colour tags;
  - the 30-colour product shows 8 rows plus «عرض كل الألوان (30)»;
  - «Jade White (10100)» renders with its parentheses intact in ar and ckb;
  - the keyboard reaches every row in one stop each;
  - VoiceOver/TalkBack spot check of the total announcement.
- Screenshots go to the scratchpad, not the repository.

**Neighbours to run** before pushing:
- `cartUpsert`, `cartSelection`, `cartQuantityCeiling`, `cartPreorderQuotaWording`, `cartSeller`, `cartSellerGuard`, `cartMultiOptionIdentity`, `cartIdentityContract`, `cartServerError`, `cartVariantSheetStock`;
- `bundleCart`, `giftCart`, `catalogCheckout`, `checkoutSummaryOrder`, `checkoutSorani`, `checkoutQuoteIsAPreview`;
- `productSelectionMemory`, `productPurchasePath`, `productGallerySelection`, `productSelectionImage`, `stockRevalidation`, `mascotInteraction`;
- `quickBuy`, `quantityInput`, `receipts`, `deliveryClient`, `refusalStrings`, `bundleBudget`, `motionLazy`, `claySystem`.

---

## 12. Build order

Every step is its own green push: `npm run check` and `npm run test:unit` pass locally, then workflow 7 runs to green, then the live site is checked. There is no migration in any step.

1. **Paper:** ESC/POS selection lines, `courierItemsSummary`, the HTML receipt size, the packing Sorani. This is independent, and it is the packing risk, so it ships first.
2. **Server:** extract `cartAdd.ts` with parity tests (the single door unchanged), then `POST /api/cart/items/batch`, `aggregateDemand.ts`, `color_tag` and `options_label`. Nothing calls the batch door yet.
3. **Product page, single mode:** the D3 labels, the D4 reset and hint, the D5 confirmations and resets, the D6 hints, the price caption and gallery chip, and the Sorani gaps. This alone closes the incident's path.
4. **Product page, multi mode:** `ColourQuantityPanel`, the confirmation sheet, `QuantityInput` `min 0` and labels, and the budget test.
5. **Cart and checkout:** `ColourTag`, grouping, colour fields.

**Rollback:** each step is an ordinary revert. The batch door is additive. Older clients never call it, and a newer client meeting an older Worker gets a 404 that adds nothing (§3.7).

After the owner approves, record a DECISIONS row naming D1 to D8.

---

## 13. Open questions for the owner

- **Q1. Arabic colour names.** The mandate keeps colour names in English, so the Arabic button reads «أضف 50 × Black». Some colours carry an Arabic name in `name_ar` (for example «بيج»). Should Arabic and Sorani pages show it beside the English («Beige · بيج»), on the button and on paper?
- **Q2. Opening in multi mode.** Should products in some categories (filaments, consumables) open in «عدة ألوان» by default? The default in this spec is «لون واحد» everywhere.
- **Q3. Quick Buy with several colours.** Quick Buy stays one colour in this spec. A multi-colour instant purchase needs a batch door in the Quick Buy session as well.
- **Q4. Signing in with rows filled.** A signed-out customer who fills rows and presses add is sent to sign in, and the rows are not carried back. Carrying them (like `?alert=` and `?price_request=`) is possible if wanted.
- **Q5. A picture per colour.** The gallery chip (§3.12) says the photo does not show the colour. The lasting fix is the owner's data: one image per colour. The admin product form could warn when a product with 2 or more colours has a colour without an image.

---

## 14. Defects found next to this work (separate fixes, not in this spec)

- **Concurrent colour changes in the cart:** when two land at the same moment, the loser gets a 500 from the unique index instead of `409 CART_LINE_ALREADY_EXISTS` (`cart.ts` PATCH `/items/:id`, around `:2751-2780`).
- **The cart's shipping sheet** sends `{ shippingMethodId }` (`Cart.tsx:983-985`), but the PATCH route never reads that field, so it is a 200 that does nothing.
- **No record of cart adds:** nothing records what is added to a cart on the live site. The `AddToCart` event is bound only in the dark environment, and there is no audit row. The next dispute will meet the same blind spot. A structured server log line per add, without the user's identity in clear, is worth a separate decision.
- **Re-order** (`ReorderButton.tsx`) adds lines one request at a time and reports each line's result. It could use the batch door for all-or-nothing behaviour.

---

## 15. After the review (2026-10-16): what changed from the text above

The review of the build found places where the page could still say one thing and do another. Each was fixed with a failing test first. Where this changes a rule written above, the new rule is here.

**The add door and the cart**

- **«Empty the cart and add» over the same colour.** The cart line's identity has no route, so the same colour can sit in the cart under another shipping type (3 Black by air, now 5 Black on the shelf). `inCart` is compared with what the cart held **before** the emptying; the merge report still starts each line from 0. Before, this press was refused with `CART_LINES_CHANGED` on every try (§4.3 step 6).
- **A shared shelf counts the cart (§4.3 step 6b).** After the existing-lines read, every line of the product that draws on one counter is summed: the batch's lines (with what their own line already holds) and the cart's other lines. Over the counter, the answer is `400 QTY_UNAVAILABLE`, `shared: true`, and `available` is what is left **after** the cart. A counter only one line draws on is a merge with itself and is still held to the ceiling, never refused. The panel's shared pool also subtracts what the cart holds on that shelf. The single door is unchanged here.
- **The single door takes `inCart` too.** `POST /api/cart/items` accepts an optional `inCart` and answers `409 CART_LINES_CHANGED` (`details.in_cart`) when the line holds something else, with nothing written. The page sends it when it read the cart. After a lost answer (`CART_LINES_CHANGED`, or a network failure or timeout) the page re-reads the cart: if the line holds what the press would have left, the add is confirmed as an add. This replaces D9's «the single door keeps its behaviour» for this one optional field. A client that sends no `inCart` gets exactly the old behaviour. Both doors read «this line» the way the page's `lineQtyIn` does (the selection as a set, the colour, every ordinary row summed), so an older row whose `option_id` is not the canonical first id never locks the button.
- **A lost answer with a capped line (§3.7).** A line landed when the cart holds `min(before + want, max(want, max_qty))`, the server's own arithmetic. When only some lines match, the sheet confirms those, the other rows stay, and the page says «أُضيف بعض الألوان فقط. راجع سلتك قبل أن تضغط مرة أخرى.». It never says «nothing was added» about a line that landed.

**The product page**

- **An option that leaves fewer than two colours (§3.2, §3.4).** «عدة ألوان» closes the way its switch does: rows whose colour is no longer offered are removed and named in the hint («لا تتوفر عدة ألوان مع هذا الخيار، فعادت الصفحة إلى لون واحد. أُزيلت: White، Beige»), one row left becomes the single selection with its quantity, otherwise quantity 1. The quantity from before «عدة ألوان» never comes back. The switch is not drawn while fewer than two colours can take a quantity (§3.1 is unchanged).
- **«اختر لونًا أولًا» (D3)** is said only when **this selection** has a colour to choose, and before «غير متوفر». A model whose colours belong to another model keeps «أضف إلى السلة».
- **«أُضيف 50 × Black» (D5)** stays on the button only while the selection and the quantity are still what was added. A colour tap or a new quantity inside the 3 s gives the label of the next press.
- **The memory of D4.** Every quantity typed for a colour the customer moved away from is kept for this view, not only the last: at the third colour, «حدّد كمية لكل لون» and the switch bring Black 50 and White 5. «أبقِ 50 لـ White» drops Black's number (the customer meant White). A successful add clears it.
- **D6 counts the colour the tap left**, so the colour the page opened on counts: two taps away from it are three colours.
- **In «عدة ألوان» the header's shelf note is hidden.** It described the colour the page holds behind the scenes, which is in no line being added.
- **⚡ names what it buys** (principle 2): «شراء سريع: 56 × Beige», "Quick Buy: 56 × Beige", «کڕینی خێرا: 56 × Beige», with the full name as its accessible name. Its success toast names what was bought: «أُضيف إلى طلب الشراء السريع: 56 × Beige». A confirmation step for ⚡ is not added (open question Q6).
- **The several-colours button for a guest** reads «سجّل الدخول للشراء», as single mode does. Rows are still not carried through sign-in (Q4).
- **Focus after the confirmation sheet (§3.8).** With no row filled, the add button is `aria-disabled` rather than `disabled`, so focus really returns to it; its press then does nothing.
- **Desktop.** The confirmation sheet is 440 px wide from `sm` up. A refusal is one `role="alert"` per layout, not two. «حدّث الصفحة» has a 44 px target.

**Words and paper**

- English counts agree with their nouns: «1 piece in 1 colour», «5 pieces in 1 colour».
- The Sorani row buttons are «زیادکردنی بڕی {name}» and «کەمکردنەوەی بڕی {name}» (§8.1), so they never sound like the add button.
- The sheet's line names use each language's comma («Black, 50» in English).
- The cart and checkout group header counts **colours**, not lines; a group with no colour counts pieces only. A coloured cart line's checkbox, quantity and delete name the colour («كمية Black», «حذف Black»).
- A swatch's ring is the 3:1 field line (`--clay-field`), not `border-subtle`: black now reads on the dark theme, white on the light.
- The courier waybill prints a bundle or mystery **parent** as its name and count only. Its stored selection is the member list, which a third-party courier is not told.

**New open question**

- **Q6. A confirmation step for ⚡.** ⚡ goes straight to an order paid from the wallet. With the label and the toast naming the colour and the count, it now has guards 3 and 4. A one-tap «تأكيد» for a large quantity after several colour taps would add a fifth; it is the owner's call because it slows every Quick Buy.
