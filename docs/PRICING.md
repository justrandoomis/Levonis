# Pricing resolution and fee composition

Single implementation: `worker/lib/pricing.ts` (`resolveUnitPrice`) — used by
the product page quote, cart, server checkout, admin preview and tests.
Unit tests pinning every rule: `tests/pricing.test.ts` (`npm run test:unit`).

## Currency model

- **IQD is canonical** for every entered monetary value (integer dinars).
- **The wallet's rate** is the admin setting `exchangeRate`, defined as
  **1 USD = X IQD** (1,400, DECISIONS row 6). It is the Levo Wallet's own
  rate — every wallet screen and operation — and nothing else. The
  storefront's dollar reading uses the shop's market rate instead
  (`displayUsdRate`, below); the two never stand in for each other (owner
  decision 9).
- Wallet balances are stored as integer **USD cents**; conversions IQD→cents
  use `ceil(iqd × 100 / X)` (rounding up so the wallet never undercharges);
  cents→IQD displays use `floor(cents × X / 100)`. Formatting never changes
  stored values.
- Changing the exchange rate changes **derived USD display only** — never
  stored IQD prices and never existing orders (each order snapshots
  `exchange_rate` at creation).

## Currency roles (FX programme, DECISIONS row 189)

The FX programme (push FX-1, migration `0179_fx_rates.sql`) gives each
currency one job. The wallet model above is unchanged.

| Currency | Role | Where it lives |
|---|---|---|
| **USD** | The **pricing base**. A supplier cost entered in USD, EUR or CNY becomes one canonical current USD cost. | `packages/pricing/src/fxChain.ts` |
| **EUR, CNY** | Supplier currencies only. Each stays in its source currency and is converted at today's rate whenever a price is computed. | `fx_rate_pairs` rows `EUR_USD`, `CNY_USD` |
| **IQD** | The **accounting currency**: every price, order, lot, wallet figure and report. Inventory keeps the IQD actually paid and is never re-converted. | unchanged tables |

**The chain (the final rule, FX plan §36).** SOURCE (USD / EUR / CNY) →
CANONICAL CURRENT USD → CURRENT IQD (× the effective USD/IQD) → final price
(the replacement cost plus the minimum target profit, rounded up to 1,000, plus
the Direct Sale Extra). The pure maths is `fxChain.ts`; exact decimals
throughout, never a float.

**The rates.**

- **USD/IQD**: the Iraqi parallel market, from IQWealth
  (`GET https://iraqsm.com/api/v1/fx`, the Worker secret
  `IRAQ_PARALLEL_FX_API_KEY`, read in one place:
  `worker/lib/fx/providers/iqwealth.ts`). Automatic every 6 or 12 hours, or OFF
  with a manual rate. The owner's adjustment, `market_adjustment_iqd`, is a
  **fixed number of dinars per dollar, never a percentage** (owner decision 5,
  2026-10-09): market 1,660 + 20 = an effective 1 USD = 1,680 IQD. It is
  signed (a negative number lowers the rate), added to the market sell, and
  never added to a manual rate (a manual rate is final). Every row of the
  private history (`fx_rate_log.market_adjustment_iqd`) records the
  adjustment its USD/IQD rate carries — NULL on the ECB pairs, and NULL on a
  manual rate, which carries none (so the history never shows an adjustment
  under it and the 24-hour guard never re-bases it). The body key is
  `market_adjustment_iqd`; the retired `adjustment_iqd_per_usd` is refused
  (400 `UNKNOWN_FIELD`) and stays in FINANCIAL_FIELDS. «0.5%», an exponent or
  more than 4 decimals is 400 `PRICING_INPUT_INVALID` naming the field.
- **EUR/USD and CNY/USD**: the ECB daily reference rates, once a day. CNY/USD
  = (USD per EUR) ÷ (CNY per EUR), rounded up at 10 places.
- **EUR/IQD and CNY/IQD**: computed centrally in `pricing_fx_rates` whenever
  either side changes, in the same batch (a trigger refuses a stale derived
  row).
- **The guard** (owner decision 11): a rate waits for the owner's approval —
  status `REVIEW_REQUIRED`, the last confirmed / last known good rate stays
  in force, nothing is repriced — when it is the first value, jumps more than
  3% in one step, moves more than 3% against **any** rate in force during the
  last 24 hours, or drifts more than 6% from the **Confirmed Rate**
  (`drift_anchor_rate` / `drift_anchor_at`: the last rate the owner approved,
  set by hand or confirmed with «تأكيد السعر الحالي»; the panel calls it «آخر
  سعر أكّدته»). The 24-hour references are the rate in force 24 hours ago and
  every `effective_after` written since (`fx_rate_log`, one indexed read of at
  most 200 rows); when the owner confirmed a rate inside the window, the
  Confirmed Rate replaces the first and only the rates after it count — an
  approval makes the new rate the Confirmed Rate and later measurement starts
  from it. A USD/IQD reference written under another adjustment is re-based
  onto today's (`rate − then + now`), so an adjustment change is never a
  market jump. It **fails closed**: more than 200 rates in the window is held
  `ANOMALY_24H`; a window (or the rate of 24 hours ago) that the statement
  budget did not let the scheduler read, or whose read failed, applies
  nothing that tick for that pair alone (`DEFERRED` / `FX_GUARD_UNREAD`, one
  log row, no bell; the run's other pairs still commit); a window rate whose
  time does not parse is still measured. Exactly 3% (or 6%) applies; above it is held. An adjustment moves
  the Confirmed Rate by its own change and never re-bases it. A value the
  owner rejected is not held again for 24 hours, the rejection keeps the
  Confirmed Rate and the last known good, and it never stops an ordinary
  move. A failing source keeps the last
  known good rate; a rate is never 0; a candidate out of bounds (an
  adjustment typed wrong) is recorded INVALID for that pair alone.
- **Small moves are ignored** (owner decision 10): below the dead band —
  `min_change_pct`, seeded 0.5% USD/IQD, 0.3% EUR/USD and CNY/USD, strictly
  below (exactly 0.5% is a move) — a check records one `check` row and one
  `fx.check` audit and nothing else: no `pricing_fx_rates` revision, no
  product price (no repricing, no final_price write — FX-5 reprices only from
  a committed rate) and no cache purge. Such a tick also clears a value held for review, since the market is
  back near the rate in force; that is neither a repricing nor a purge. The
  owner edits each band at `PUT /api/admin/pricing/rates/fx/:pair/settings`
  (owner only, a fresh sign-in, 0 to 5 and below the 3% guard); the
  `settings_change` history row keeps every changed setting as
  `settings_diff = [{field, before, after}]` (the adjustment and the bounds
  included — values live in the private log, never in `audit_log`), and the
  history sheet shows each one old → new.
- **The owner's acts**: a change of mode (keep-as-manual included), interval,
  threshold or bounds, a change of the adjustment, and «تأكيد السعر الحالي»,
  need a sign-in from the last 10 minutes (a stale session: 401
  `REAUTH_REQUIRED`, nothing written). The adjustment is not a guard setting
  (it rings no guard-change notice), but it moves the effective USD/IQD — and
  the public `displayUsdRate` — with no market guard in between, so a stale
  session cannot use it. On USD/IQD, the owner's acts of the last 24 hours — the act
  being made included — above 15% need the explicit confirmation and that
  fresh sign-in too. An adjustment that would make the rate implausible is
  refused (400 `FX_RATE_OUT_OF_BOUNDS`).
- **The wallet keeps its own rate** (owner decision 9): `exchangeRate`
  (1 USD = 1,400 IQD, DECISIONS row 6) stays the rate of every wallet screen
  and operation — deposits, wallet payments at checkout, refunds, escrow,
  Quick Buy, memberships — and a market update never changes it (market
  1,670 beside wallet 1,400 is the normal state). No wallet, escrow, Quick
  Buy, membership or checkout code imports the FX module or names its
  tables, and no FX or engine code reads `exchangeRate`
  (`tests/walletRateSeparation.test.ts`). The display currency never falls
  back to it: before the owner approves the first USD/IQD value,
  `displayUsdRate` is null and the storefront reads in dinars with a note
  that the dollar reading comes once the shop's rate is approved. The admin
  product price preview reads the shop's rate too (`usd_preview` null before
  that approval). Checkout's points line reads in dinars (1 point = 1 IQD).
- **Public**: only the effective USD/IQD, as `displayUsdRate` (decimal text or
  `null`) in `/api/settings/public` and `/api/home`, for the display currency,
  with one flag and no figure, `displayUsdRateAttributed`: false when the
  owner typed the rate, so the menu and Settings credit IQWealth only for its
  own figure. Every other FX figure is the verified owner's
  (`/api/admin/pricing/rates*`).
- **The rates move engine prices automatically (FX-5)** — see "Automatic
  repricing" below. The FX module itself still names no price column.

**One scheduler, one cron.** `0 */6 * * *` runs `runFxScheduler`
(`worker/lib/fx/scheduler.ts`); a pair is due by its interval measured from
the run's `scheduledTime`. No provider is ever called from a customer request.
The cron strings and the exact-match dispatch table live in
`worker/lib/cronSchedules.ts` (the six-hour string maps to the FX job set and
nothing else); `worker/index.ts` never spells a cron step.

**Deploy ahead of 0179.** On a database at 0178 the owner's
`/api/admin/pricing/rates` and `/rates/history` answer 503
`PRICING_NOT_INSTALLED`, the scheduler skips without calling a provider, and
`displayUsdRate` is null; every other GET answers as on the migrated database
(`tests/fxDeployAhead.test.ts`; the two routes are the named entries of
`tests/fixtures/deployAhead.ts`, which the 0176 sweep in
`tests/costDeployAhead.test.ts` reads too).

**Rollback runbook (cron triggers).** Cron triggers are Worker settings, not
part of a version. A workflow 7 redeploy of an older commit replaces them with
that commit's list. A **dashboard rollback** or `wrangler rollback` does not:
after one, run `npx wrangler triggers deploy --env staging` from the rollback
target's checkout. (A target from P1 on ignores the 6-hour trigger anyway:
`scheduled()` runs only the crons it knows.)

## Accounting stays IQD — «الأرباح والتكاليف» (USD-pricing design P-A, DECISIONS row 194)

Owner brief 2026-10-09, "Accounting Currency": USD is the base of the
**pricing engine only**. Costs, profit, inventory, batch costs, actual
shipping, expenses, revenue and order reports stay in the **IQD recorded at
the time of the operation**, and IQD is always the default. P-A (no
migration) closes the places that did otherwise and adds a display toggle.

| Fix | Where | What it does now |
|---|---|---|
| **F1** | `worker/lib/financeReport.ts` | A line whose cost was never recorded at sale (`cost_confidence = 'estimated'`: today's `products.product_cost_iqd`) leaves `costed_revenue_iqd` and `cogs_iqd`, so gross and net profit carry recorded costs only. The estimate stands apart: `estimated_revenue_iqd`, `estimated_cogs_iqd`, `estimated_profit_iqd`, shown as «تقدير بتكلفة اليوم — ليس ربحاً فعلياً». `costed + uncosted + estimated revenue = revenue`. |
| **F2** | `worker/lib/orderCostProjection.ts` | A delivered (or returned, refunded, cancelled) order gets no current-catalogue and no current-stock cost, not even as a suggestion; the cost recorded on the line at sale is its only suggestion, otherwise manual entry («لا توجد تكلفة مسجلة وقت البيع…»). Orders in flight keep their labelled forecast. |
| **F3** | `worker/routes/adminFinanceWorkspace.ts` | A promotion in USD/EUR/CNY needs the exchange rate **actually paid**: without it, and without an existing same-currency row, 400 `PROMOTION_RATE_REQUIRED`. The wallet's 1 USD = 1,400 IQD never fills the gap (owner decision 9). The page suggests the shop's rate on the month's first day (`rate_suggestion`) and fills it only on a tap. |
| **F4/F5** | `worker/lib/financeReportOverlay.ts` | The order-level coupon (`coupon_snapshot.discount_iqd` ?? `orders.coupon_discount_iqd`, less any line share) and credited price-protection claims are **deductions in this report only** (owner question Q3, default "report only"): `coupon_iqd`, `price_protection_iqd`, `net_after_report_adjustments_iqd` = owner net − both. Products take `min(coupon, net goods)`; the excess stays at the order. `calculateGoods`, `getOrderProfitBase(s)` and every writer are untouched — no investor share, wage or journal moves (`tests/financeOverlayNoSettlement.test.ts`). |

**The display toggle «عملة العرض» (IQD / USD).** `?display=IQD|USD` on
`GET /api/admin/finance-workspace/summary`, `/orders` and `/orders/:id`
(anything else is 400 `DISPLAY_CURRENCY_INVALID`). IQD answers exactly as
before. USD adds one `display_usd` block and changes no IQD field and writes
nothing:

- **The rate**: the shop's **effective** USD/IQD in force when each order was
  **created**, from the append-only `fx_rate_log` (`worker/lib/fx/historyRate.ts`,
  the only FX import of the profit route) → `usd_basis: 'at_time'`. An order
  older than the first applied rate uses today's effective rate, marked «≈»
  (`'today'`). No applied rate, or a database before 0179 → `available: false`
  and the page stays in dinars. Never the wallet rate, never a purchase rate.
  Expenses convert at the start of their own Baghdad day, an unallocated
  promotion at the start of its month.
- **The cents** (`worker/lib/financeUsdDisplay.ts`, pure): each additive dinar
  field converts exactly to integer cents, half away from zero; derived figures
  (retained revenue, gross and contribution profit, profit basis, owner net,
  net after the report deductions) are recomputed from the cents with the same
  formulas, so revenue − cost = profit to the cent; groups, kinds, days and
  totals are sums of rows; margins come from IQD; the CSV stays IQD.
- **The client** (`src/components/financeWorkspace/displayCurrency.tsx`)
  starts at IQD on every load, stores nothing, formats the server's cents with
  `formatUsdCents` and shows «القيمة المحاسبية: … د.ع» beneath each dollar
  figure. Overview (figures, breakdown, kinds, charts), delivered orders,
  products and the order sheet; edits stay in dinars.
- **Privacy**: owner only, private, no-store — the workspace door
  (`requireCostRead`). `display_usd`, the deduction amounts, today's rate and the
  suggestion are in both FINANCIAL_FIELDS copies; `usd_basis` and the counts are
  registered as private keys that carry no amount.

## The writer: engine prices in the existing price fields (DECISIONS row 196)

Owner decision 8, migration `0181_pricing_engine_core.sql`. There is no
separate activation step: **the save that leaves a product complete adopts the
engine** and writes its prices in that same batch.

- **The preview first.** A save that would write prices, sent without the
  preview's hash (or with the dinar conversion's hash only), answers 409
  `PRICING_PREVIEW_REQUIRED` carrying the six figures per model × channel; the
  same save with that `preview_hash` writes. Data or a rate that moved since
  the preview answers 409 `PRICING_PREVIEW_STALE` with the fresh preview. A
  price moving more than 15% needs `confirm_large_change: true` and a fresh
  sign-in (`REAUTH_REQUIRED` otherwise); a fall above 30% is flagged. An
  incomplete manual product stores its data and keeps its manual price; an
  engine product never saves into an incomplete state
  (`PRICING_ENGINE_INCOMPLETE`).
- **Where the prices go** (`worker/lib/pricingEngine/writer.ts`): each route
  row its engine price with route surcharge 0, the direct-sale cell the
  pre-order price plus the Direct Sale Extra, the pre-order cell the highest
  route, the option row the highest of its cells, `products.price_iqd` the
  lowest. The plan is verified against the cart's own resolver before anything
  is written (any mismatch = nothing written). The final price in USD is kept
  beside it in `pricing_sku_costs`, owner only.
- **One write** (`engineWrite.ts`): one atomic batch per product, fenced on the
  product's pricing state, idempotent on the preview hash, audited (values in
  `pricing_audit`, ids and counts in `audit_log`), at most 200 statements. Only
  the last CONFIRMED central rates price; a rate held for review never does.
- **The doors**: the product form (`PUT …/products/:id/inputs`), a confirmed
  purchase that completes the product (`…/apply-purchase`, after the review
  showed the prices), and the stale list on «التسعير والشحن» (`GET /save-list`,
  `POST /save-list/preview`, `POST /products/save-bulk`, up to 20 at once).
  `POST …/products/:id/manual` takes a product back to manual pricing with its
  prices exactly as they are.
- **ENGINE_MANAGED.** On an engine product the old dinar writers refuse with
  `ENGINE_MANAGED` (the product's price, the option price cells, the quick
  price grid and its undo, the selection price, the CSV import); the
  database's value-compared lock is the enforcement. Cost stays editable.
- **Colour and variant prices** are the SKU rung below (FX-7). On a database
  without migration 0183 a product priced per colour or variant, or with more
  than one option group, is still refused `PRICE_SHAPE_UNSUPPORTED` and stays
  manual, exactly as before.

## Colour and variant prices — the SKU rung (FX-7, DECISIONS row 200)

Owner decision 1 of 2026-10-07 (DECISIONS row 184 (1)): «SKU آخر درجة وأكثرها
تحديدًا في السُّلّم (منتج ← خيار ← لون ← SKU)». Migration
`0183_product_sku_prices.sql`.

- **The levels.** Engine inputs (`pricing_product_inputs`) and minimum-profit
  rules (`pricing_rules`) take two more scopes: `color` (a colour of the
  product) and `sku` (one SKU, by its `combo_key`: the option value ids
  sorted, each `o:<id>`, then `c:<colour id>`, joined by `|` — the identity
  `product_variants.combo_key` already uses). Each value inherits product →
  option → colour → SKU; an empty field inherits, a rule left at INHERIT
  inherits. Owner only, audited, bounded like the product and option levels;
  a colour or SKU the product does not sell is refused (`…scope_id`), and
  both levels are refused (`…scope`) on a database without 0183.
- **When a product is priced per SKU.** When a colour or a SKU carries its own
  input or a rule that is not INHERIT, when it has more than one option group,
  or when an active colour still carries a dinar price of its own — and only
  on a database with 0183. Otherwise it is priced per model, byte for byte as
  before FX-7 (same plan, same batch, same preview hash).
- **What is written.** Every sellable SKU (every option value × colour the
  storefront offers; with several groups, every combination — at most 240,
  `SKU_GRID_TOO_LARGE` beyond) × channel gets its own engine price in
  `product_sku_prices` (public final regular price; the private figures stay in
  `pricing_sku_costs`, one row per SKU × channel). The resolver
  (`packages/pricing/src/pricing.ts`) reads it as the last rung after the
  colour: the selection's SKU row on the line's channel (`direct_sale`, or
  `pre_order_<route>`) is the regular price; member layers, warranty and the
  payment rule stay read-time (owner decision 6). The cart, the quote, the
  product page's first price, the membership and pricing-mode previews and
  price-protection claims pass the selected option values.
- **Rollback safety.** Underneath, each model's route rows, order-type cells
  and option row hold the HIGHEST price of its SKUs, the colour rows' price
  fields are cleared, and `products.price_iqd` is the lowest written price (the
  highest when the product has no option group and only colours, since the
  product price is then the ladder every colour falls back to). A Worker that
  ignores the table (an older commit) therefore never charges a SKU less than
  its engine price. The variant rows mirror the SKU's direct price (the
  purchase screens read them; the cart never does).
- **Checked before anything is written.** `verifyPlan` re-runs the cart's own
  resolver on the document as it would be after the write, for every SKU ×
  channel, prepaid and cash on delivery: any figure that is not the engine's
  is `RESOLVER_MISMATCH`; the same resolver without the SKU rung must never
  charge less (`:rollback`). Then the same fenced, idempotent, audited batch
  (now also replacing the product's SKU rows, with `write_seq` the pricing
  state's next sequence).
- **The database guards it.** Inserts and updates need the engine's token
  (`engine-price:<product>`) or the repricing token (`pricing-rates-apply`);
  deleting an engine product's rows needs it too. Every refusal is
  `ENGINE_MANAGED`. A product being deleted takes its rows with it.
- **Everything per SKU**: the six-figure preview (one row per SKU × channel),
  the FX-5 automatic repricing and the stale list (a per-SKU product missing a
  row for a sellable SKU is listed with reason `SKUS`), and the decision-6
  order snapshot (`order_items.engine_combo_key` is the SKU's key; a claim
  looks the SKU up first, then its model).
- **Back to manual** (`POST …/products/:id/manual`) keeps the ladder as it is
  (each model at its highest SKU) and deletes the SKU rows in the same batch.
- **The product form** («الخيارات والألوان»): each colour, and each variant row
  with a colour or two option values, gets the same inputs and minimum-profit
  rule as its model, empty = inherited (the placeholder shows the inherited
  value), with its computed customer price per channel. The model card no
  longer says its colours follow it. Shown only when the database has 0183;
  owner only.
- **Not covered by the rung**: bundles, trade-in, gifts, compare and the
  product page's price levels read an option and a colour only, so a SKU of a
  multi-group product falls back there to its model's highest price (never
  lower). Purchase lines entered per colour or variant still feed the model's
  or the product's cost.

## Automatic repricing when a confirmed rate changes (FX-5)

`worker/lib/pricingEngine/autoReprice.ts`, called through
`worker/lib/fx/reprice.ts`. No migration: it uses 0181's
`product_pricing_state.reprice_blocked_code` / `_at`, the `reprice_auto`
action and `price_history.price_source = 'engine_fx'`.

- **When.** The FX scheduler commits a new effective rate (USD/IQD, EUR/USD,
  CNY/USD) — the engine products it left stale are repriced at the end of the
  same run; the owner approves a held rate, sets a manual rate or changes the
  adjustment, or changes a central shipping rate — repriced inside the same
  request; and every quarter hour the sweep takes up whatever is still stale.
  Below the dead band nothing is committed, so nothing is written or purged
  (owner decision 10). A rate held for review (REVIEW_REQUIRED) or rejected is
  never effective, so it reprices nothing until the owner approves it; the
  approval makes it the Confirmed Rate and reprices at it (decision 11).
- **What.** Exactly the stale list: engine products whose stored price was
  computed at a confirmed rate that has changed since. Manual products are
  never read for writing.
- **How.** The writer's own path, never a second computation: the evaluation
  (E1 at the last confirmed central rates, the plan, the exact check against
  the cart's resolver), then one atomic batch per product, fenced on its
  pricing state, the engine's config version and pause, its price image and
  the very rates it was priced at; idempotent (`auto:<product>:<hash>`);
  audited — values in `pricing_audit` (`reprice_auto`), ids and codes only in
  `audit_log` (`pricing.engine.repriced_auto`), one `run_finished` record per
  run with counts. A price that only exchange rates moved is recorded as
  `engine_fx` (decision 6: an FX-only drop is not price protection); a
  shipping rate the owner changed is `engine_owner`. When the new figures round
  to today's prices, only the stored engine figures are re-stamped (no price
  row, no history, no purge).
- **Deficit first, within the budget.** Every due product is evaluated from
  bulk reads (a constant number of statements), then written in order of how
  far today's price lies below the new replacement cost + minimum profit,
  largest first. Every read and batch is charged to the invocation's statement
  budget — 600 for the six-hour run and an owner's request; the quarter-hour
  sweep runs LAST in its invocation, after the staff recalculation, the durable
  jobs and the upload sweep have settled, with its own 200 cut to what they
  left of D1's 1,000 less a reserve of 50 (`quarterHourSweepBudget`; the jobs
  run on a counting view of the binding, `worker/lib/d1Count.ts`). So the
  sweep never takes the tick past the limit and never costs the jobs a
  statement; when they leave nothing, it yields completely. A batch the budget
  cannot cover is not sent; it and the products after it wait, in the same
  order, for the next tick, until the list is empty
  (tests/fxSweepBudget.test.ts: the usual tick at its bounds — 200 upload
  sessions, a full outbox, a dozen stale products — executes about 600
  statements; a staff recalculation at its own bound of 2 × 10 orders, or a
  search-index catch-up chunk, takes the jobs ALONE past 1,000 — theirs, not
  the sweep's, which then spends nothing).
- **The preview before an owner rate act (§7.8).** `POST /rates/fx/:pair/review/preview`,
  `POST /rates/fx/:pair/manual/preview {rate | market_adjustment_iqd}` and
  `POST /rates/shipping/:profile/preview {rate_iqd}` answer, writing nothing,
  what the act would reprice: every affected engine product with today's
  customer price → the new one per model × channel, the change, the deficit
  (new replacement cost + minimum profit − today's price, the order the run
  writes in), the 15% and 30% flags, the products the engine cannot reprice
  (a code), how many follow on the quarter-hour sweep, whether the act will
  ask for a fresh sign-in, and `preview_hash` — over the act, the pair's owner
  version (or the profile's version), every rate read and each affected
  product's own evaluation hash. Once any product is engine-priced, an act
  that moves a rate (an approval, a manual rate, the adjustment, a shipping
  rate) without that hash is 409 `PRICING_PREVIEW_REQUIRED`, one read before
  something moved is 409 `PRICING_PREVIEW_STALE`, both carrying the fresh
  preview; a customer price moving more than 15% also needs
  `confirm_large_change`, and the act a sign-in within the last ten minutes.
  The rates panel shows the preview sheet («قبل التطبيق: ما الذي سيتغيّر»)
  before a manual rate, the adjustment or a shipping rate is applied, and the
  review sheet shows it under a held rate before «اعتماد السعر الجديد».
- **A product that cannot be repriced** (incomplete, a shape the fields cannot
  carry, a resolver mismatch, a database refusal) keeps its prices, stays on
  the stale list with its code (`blocked_code`, never a figure), rings the
  verified owner's bell once (no figure), and never blocks the others. It is
  tried again when a rate changes again, when the owner saves it (the writer
  clears the code), or after 24 hours.
- **The purge.** After the run, `purgeCatalogueFromJob` for the products whose
  customer price moved (their `/api/products/<slug>`, the listing and the home
  shelves); nothing moved, nothing purged.
- **The owner sees** «يُعاد التسعير تلقائياً» on «التسعير والشحن» and in the
  rates panel (`GET /save-list` → `auto`: whether products wait, the pause,
  how many could not be reached, the last run); `GET /rates` carries the
  counts (`stale_products`, `reprice_blocked`). The stale list's preview and
  bulk save stay the owner's manual tool.
- **Never in the customer path**: the storefront, the cart and checkout read
  the stored prices only (tests/fxRepricing.test.ts, tests/fxNoCustomerPath.test.ts).

**Price protection on the USD base price (owner decision 6, policy v5).** An
order line bought at an engine price snapshots its base price in USD and the
USD/IQD it was bought at (`order_items.price_basis = 'engine'`). A claim on an
order created on or after 2026-10-09 pays per unit the lower of (the USD drop ×
that purchase rate) and the actual dinar drop; a drop that comes from the
exchange rate alone pays nothing (`FX_ONLY_DROP`). A line bought at a manual
price keeps the dinar rule. Orders created earlier keep the rule they were
bought under (`worker/lib/pricingEngine/protectionBasis.ts`).

## A batch remembers the rates of its purchase (FX-6, migration 0182, DECISIONS row 199)

FX programme plan §4.3 and §9 §16-§19. `inventory_lots` IS the batch. Two
costs are never mixed (§19): what a batch **actually cost** — its IQD, fixed
at receipt — and the engine's **current replacement cost** (`pricing_*`),
which follows today's rates. The profit and FIFO paths read lot costs only;
the engine reads no lot (`tests/pricingCurrencyRoles.test.ts`).

- **When it is written.** A purchase confirmed `ordered` takes the central
  effective USD/IQD (U), EUR/USD (E) and CNY/USD (C) once (FX-1), and from
  0182 each rate's `effective_version` beside it
  (`purchase_orders.fx_*_version_at_purchase`). When it is **received**, each
  new lot records, in its own INSERT and never again
  (`worker/lib/batchSnapshot.ts` through `planReceive`): the supplier's own
  currency and amount per unit (`supplier_original_*`; a 'total' line's
  `supplier_line_total_original`), the document's own rate
  (`exchange_rate_at_purchase`), U / E / C with their versions and the moment
  the purchase took them (`fx_snapshot_at`), where U came from
  (`fx_snapshot_source`: `document` — a USD document's own rate, the rate
  actually paid — or `central`), the supplier cost in USD
  (`supplier_cost_usd_at_purchase`: USD as is, EUR × E, CNY × C, an IQD price
  ÷ U floored to 6 places) and the historical USD equivalent
  (`historical_usd_equivalent` = the lot's unit cost ÷ U, floored to 6 places
  — an audit figure only). A bare incoming record (no purchase document)
  records its own currency, amount and rate (`snapshot_source =
  'legacy_incoming'`). A transfer split's child copies its parent's snapshot
  and names it (`split_from_lot_id`). Found units (a positive count
  adjustment) carry no purchase and no snapshot. The batch's landed IQD is the
  existing `unit_cost_iqd` (an owner reconciliation wins, through
  `effectiveLotCostSql`) — no duplicate column. Nothing reads today's rate.
- **Immutable (§16).** `inventory_lot_snapshot_immutable` refuses any change
  to a snapshot column — `NULL → value` included, so an old batch can never be
  back-filled — beside 0181's lock on the cost columns, its no-delete and
  no-re-insert. `inventory_lot_snapshot_shape` refuses a half-written
  snapshot. A purchase's own FX snapshot is frozen once taken
  (`purchase_order_fx_snapshot_frozen`), and a received purchase's cost
  columns on `incoming_inventory`, `purchase_lines`, `purchase_orders` and
  `purchase_charges` are frozen in the database too (value-compared; no
  DELETE, no re-INSERT under its own id) — the routes already refused, and
  every live path after a receipt still works
  (`tests/receivedPurchaseFreezeLivePaths.test.ts`). A refused write answers
  409 `PURCHASE_FROZEN` / `BATCH_COST_IMMUTABLE`.
- **Old batches (§18).** Every lot received before 0182 keeps every new column
  NULL. The owner's read model shows it «بالدينار فقط» / known only in IQD /
  «تەنها بە دینار», each FX figure «غير معروف» / Unknown / «نەزانراو» — or,
  when the purchase-time USD/IQD is known from its own purchase (a USD
  document's rate, or a purchase ordered after FX-1 with its central
  snapshot), a historical equivalent **derived for display, not stored**,
  labelled «مشتق من مستند الشراء» / «مشتق من سعر الشراء المسجَّل».
- **Where the owner sees it.** `GET /api/admin/pricing/batches?product_id= |
  lot_id= | purchase_id=` (the owner's door; a read): per batch `batch_cost`
  (booked unit cost, actual landed unit and total, the components) and, apart,
  `snapshot` (recorded), `derived` or nothing, with `unknown_fields`. The card
  «الدفعة وأسعار الشراء» shows it in the lot details of «المخزون» and under a
  received purchase in «المشتريات» (ar / en / ckb); refused callers see nothing.
- **Privacy.** Every snapshot figure, rate, rate version and source is in both
  FINANCIAL_FIELDS copies. The two lot reads open to assistant admins
  (`GET /api/admin/inventory/lots`, `POST /api/admin/stock-operations/scan`)
  select the pre-0182 columns by name, so no snapshot column — private or
  merely generic — reaches them (`tests/batchSnapshotPrivacy.test.ts`).
- **The profit page's USD view** («الأرباح والتكاليف», `?display=USD`): a
  line's cost of goods converts at the USD/IQD its **batches recorded** when
  every FIFO allocation of the line came from such a batch and the
  allocations add up to the line's cost exactly; otherwise at the order's rate
  (the P-A history rate) as before. Revenue stays at the order's rate, the
  derived figures are recomputed from the cents, and `batch_cost_lines` says
  how many lines were costed so («تكلفة البضاعة في {n} بندًا محسوبة بسعر
  الدولار الذي سجّلته دفعاتها وقت الشراء»). The dinars are untouched.
- **Deploy-ahead.** Without 0182 the lot INSERT, the purchase snapshot and the
  split are byte-identical to before; the read model shows no snapshot and the
  USD view converts at the order's rate.
- **Not stored (yet):** v2's split of a batch's charges into freight and other
  additional costs per unit, and the route's profile, weight and volume on
  the lot. The lot keeps its recorded IQD components (purchase, shipping incl.
  the purchase's charges, internal delivery) and the purchase document keeps
  the rest.

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

An option/colour regular price is a rung on the ladder: a **fixed** number
replaces what is beneath it, an **adjustment** moves it. Either way the
difference it makes to the regular price is a **surcharge every tier pays** —
see "The member ladder follows the regular one" below.

## The member ladder follows the regular one (the owner's rule)

> Base Regular 150,000 / PRIME 125,000 / PRO 100,000. Option 2 adds 25,000 →
> 175,000 / 150,000 / 125,000. Direct sale adds 100,000 on top → 275,000 /
> 250,000 / 225,000. Options, colours, availability and shipping are
> **additional costs for every tier**.

**Amended by the payment-method mandate (2026-09-05):** «Pro Card users are
exempt from this additional shipping-type cost.» Options and colours still
cost every tier the same, but the *availability* fee — the direct-sale premium
exactly like the pre-order commission — is **waived for an active PRO**, on the
same gate (`proContext`: approved default address, benefits not restricted).
The owner's example therefore ends **275,000 / 250,000 / 125,000**: the PRO
member pays the option surcharge and nothing for immediacy.

Implemented in `worker/lib/pricing.ts` `memberAtRung`, mirrored by the Quick
Edit grid (`priceGrid.ts step/cellOf`) and the write-time validators
(`derivedRung`). At each rung (option, then colour) a PRIME/PRO field that
states nothing of its own inherits the value beneath **plus the change this
rung made to the regular price**. A rung that states its own member price
replaces it; a rung with a member *adjustment* applies it on top of that
carried value ("PRO gets 5,000 more off on this option"), or on the rung's
regular price when no member price exists beneath. Cost never follows: a
surcharge says nothing about what the extra costs the store.

A reduction at least as large as the member price it would inherit (base PRO
90,000, option −100,000) leaves nothing to carry: the resolver charges the
member the reduced regular price — or, for a PRO member whose line still has
a PRIME price, that PRIME price (see *PRO resolution* below: **a PRO member
never pays more than a PRIME member**) — and every validator refuses such a
row unless it states its own member price.

**What the validators refuse, on the DERIVED numbers.** `derivedRung` is run
by `productModel.validateProductDoc`, `productRelations.validatePriceLadder`,
`importCsv.parseImport`, the Quick Edit routes, and the product form's client
mirror (`src/components/adminProducts/form/model.ts`, which replicates
`memberAtRung`/`derivedRung` line for line). One fixture list,
`tests/pricingLadderFixtures.ts`, is run through the three server validators
and the client mirror in `tests/productModelLadder.test.ts` and through the
Quick Edit route in `tests/adminPriceGridRoute.test.ts`, and all five must
refuse exactly the same inputs:

- a reduction that swallows an inherited member price (above);
- a derived PRIME or PRO above the row's own regular price — base 150,000
  with no member prices, option +25,000 with `pro_adjust +10,000` puts PRO at
  185,000 on a 175,000 row;
- a derived PRIME below the derived PRO — option +25,000 with its own PRIME
  120,000 while it carries PRO 125,000: the resolver would clamp PRIME up to
  125,000 and charge a PRIME member a number the row never shows;
- for a **colour**, the swallowed-member-price and PRIME-below-PRO checks
  again under **each option it can be sold with** (its link set, else every
  active option), via `derivedRung(colour, derivedRung(option, base))` —
  because the resolver anchors a colour on the option the customer picked.
  Base 150/125/100k, option +100,000 with its own PRO 40,000, colour fixed
  130,000: under that option the colour's −120,000 swallows the 40,000 PRO,
  and the refusal names both the option and the colour. A colour is still
  measured against the base as every other row is.

**Legacy rows.** A product stored before these rules (base 100,000 / PRO
90,000, option fixed 5,000) exports as `options.N.regular_adjust_iqd=-95000`
with a note beside `price_iqd` saying the base stayed because lowering it
would take the product PRO to zero. Re-applying that file — exactly like
saving the product itself — is refused with `options.<id>.regular_price_iqd:
the reduction on this row is larger than the PRO price it inherits (90000) —
state a PRO price for this row, or reduce less`. That is the intended path:
the owner gives that row its own `options.N.pro_price_iqd` and the file
applies (`tests/templateRoundTrip.test.ts`).

Consequences: the same option written as `regular_price_iqd=175000` or as
`regular_adjust_iqd=+25000` prices every tier identically; the cheapest-base
normaliser (`cheapestBase.ts`) moves the product's PRIME/PRO by the same
amount it moves the base, so member prices are offsets that survive the
rewrite; and a product-level `pro_price_iqd` is the PRO price of the *base
selection only* — every surface shows the resolver's `pro_iqd` for the
selection in hand.

## Inherit, adjust, fixed — the three modes (0044)

Each of the four fields on an option or a colour row is in exactly one of three
modes, and **the mode is read from the row, never stored beside it**:

| `<field>_price_iqd` | `<field>_adjust_iqd` | mode | what the row does |
| --- | --- | --- | --- |
| `NULL` | `NULL` | **inherit** | takes whatever the level below resolved to |
| `NULL` | set | **adjust** | that value **plus a signed number of dinars** |
| set | (ignored) | **fixed** | its own number, whatever the base does |

A fixed price wins over an adjustment on the same row: a number the owner typed
is an answer, and an adjustment beside it is at most a leftover.
`worker/lib/pricing.ts` exports `priceMode(row, field)` so nothing has to
re-derive the rule, and every row written before 0044 has `NULL` in all four
adjustment columns — so a catalogue that has never used one resolves exactly as
it did before.

**Why adjust exists.** A fixed price is a *pin*: raise the product's base price
and the pinned option stays where it was, so the headline changes while a
customer who picks that option is charged the old number. That failure is the
whole subject of `worker/lib/pinnedPrices.ts`. An adjustment says "this option
is 60,000 above the base" once, and keeps saying it after every future base
change.

**Anchoring.** An adjustment applies to the value the row would otherwise have
inherited *for the same field* — which, for PRIME/PRO, already carries the
row's regular surcharge (see the owner's rule above). When a member field has
nothing to inherit — no member price is set anywhere below it — the adjustment
anchors on the **regular price resolved at that same rung**, because "PRO pays
15,000 less" can only mean less than what everyone else pays. **Cost has no such fallback**: a
cost adjustment with no cost beneath it stays `inherit`, because inventing a cost
from a selling price would make the profit figures confidently wrong. The result
is clamped at zero and rounded to whole dinars.

`product_variants` deliberately has **no** adjustment columns: `resolveUnitPrice`
takes an option and a colour and never reads a variant price, so a variant
adjustment would be a field an admin could set that no customer could be charged
from.
Since FX-7 the resolver also takes the selected option values, but only to
read the engine's own per-SKU row (`product_sku_prices`, written by the writer
alone); a variant still has no price field an admin can set.

## Quick Edit — the whole price table of one product

`worker/lib/priceGrid.ts` projects a product into one flat grid (the base row,
then one row per option, then one per colour) with a cell per field carrying its
mode, its stored value, its **effective** price and the price it would fall back
to on `inherit`. `effective` is computed by the same ladder `resolveUnitPrice`
walks **and then clamped exactly as the resolver clamps the line**
(`clampMemberLadder`: neither member price above the row's regular price,
PRIME never below PRO, PRO falling back to PRIME), so the admin preview and
the customer's cart cannot disagree — `tests/priceGridAgreement.test.ts`
asserts cell-for-cell equality with the resolver over the whole fixture set,
and `scripts/e2e-quick-price.mjs` row by row against a running worker. Two
details keep that true: the value a rung passes UP to the next one is the raw
ladder value (that is how `pickMember` carries it; the clamp is the last word
on the line the customer actually picked), and a member cell's `inherited` is
that raw carried value too, because it is the anchor a member *adjustment*
applies to, exactly as `memberAtRung` anchors one. A PRO cell that inherits
nothing (no PRO price beneath, none of its own) shows the PRIME price PRO
members fall back to; a bulk `add`/`subtract`/percent on such a cell is
skipped as `NO_CURRENT_VALUE` rather than pinning a PRO number onto a row that
never had one.

**Write-time ladder.** `PATCH /price-grid`, and `bulk`/`copy` with
`apply: true`, rebuild the product as it would read after the change and run
`validatePriceLadder` — the validator the relations PUT runs — over every row
whose derived ladder can have moved: every row when the base row changed (it
is beneath all of them), an option and the colours sold with it when that
option changed, a colour alone (under each option it is sold with) when only
it changed. A violation answers `400 {code: 'VALIDATION', errors: […]}` with
the same messages the product form's save would show, before anything is
written; the preview responses carry the same list as `errors`. A legacy row
that is already wrong elsewhere in the product does not block an unrelated
edit, and undo is exempt — restoring a previous state is always allowed.

The endpoints live in `worker/routes/adminPriceGrid.ts`, all under
`/api/admin/products/:id`:

| Route | What it does |
| --- | --- |
| `GET /price-grid` | the grid, the scope vocabulary, the margin floor |
| `PATCH /price-grid` | writes **only** the cells in the body |
| `POST /price-grid/bulk` | preview by default; `apply: true` writes what the preview returned |
| `POST /price-grid/copy` | pre-order↔direct, or model↔model, same two-step |
| `POST /price-grid/undo` | reverses one `batch_id`, out of `price_history` |
| `GET /price-history` | the timeline (financial admins only) |
| `POST /price-grid/cost-change` | the supplier-cost difference and a suggestion; **writes nothing** |

Every write appends to `price_history` (the table the seven-day price protection
already reads) stamped with a `batch_id`, which is what makes undo possible
without a snapshot table.

**Profit and the guard.** `profitOf(price, cost)` reports margin as profit over
the **selling price** — the retail convention — so a floor set at 20% is not
quietly satisfied at 16%. A missing cost yields `null`, never `0`. The guard
warns when a price is under its cost, or under the `minMarginPercent` admin
setting when one is configured, and it **warns rather than vetoes**: the write is
refused with `409 PROFIT_GUARD` until the caller sends `confirm: true`, because a
launch sold at cost and a clearance sold below it are both real decisions. A
guard only ever speaks about the fields the request changed — except a cost
change, which re-checks all three selling prices because it can put any of them
under water at once (`guardedFields`).

**Amounts.** `parseAmount` accepts `950K`, `1.25M`, `950,000`, Arabic-Indic
digits and `مليون`, and **refuses rather than guesses** on anything ambiguous —
a bare fraction of a dinar, two suffixes, a suffix that lands between dinars.
The admin drawer runs the same rule locally so a typo turns red as it is typed,
but the server is what parses the value that is written.

## PRO resolution

1. Resolved explicit PRO price (color→option→base) when present — the base
   PRO price plus every regular surcharge on the way up, unless a rung states
   its own PRO price (`memberAtRung`).
2. Otherwise the store-wide policy `proPricingPolicy`:
   - `explicit_only` (default): **no discount** — no fabricated percentages.
   - `global_percent` (owner-approved only): `regular − floor(regular×p/100)`.
3. Otherwise the PRIME price resolved for the same line, when one exists:
   **a PRO member never pays more than a PRIME member** (`clampMemberLadder`).
   This covers a PRIME-only product and a line whose base PRO was swallowed by
   a reduction (base 150/125/100k, option +100,000 with its own PRO 40,000,
   colour fixed 130,000 → PRIME 105,000, and PRO members pay 105,000 too).
   `pro_iqd` reports the number actually charged, so the product page, the
   cart, the admin preview and the Quick Edit grid all agree. No discount is
   invented: with no member price on the line at all, the regular price
   applies.
4. A PRO member never pays more than the regular price (misconfigured PRO
   prices clamp to regular), and PRIME is never below PRO (a legacy inverted
   row clamps PRIME up to PRO). Every resolved line therefore satisfies
   PRO ≤ PRIME ≤ Regular wherever the values exist —
   `tests/pricingLadder.test.ts` asserts it over the fixture set, and that
   `product_cost_iqd` never influences any of the three.

`compare_at` is shown only when it exceeds the applicable selling price —
no misleading strikethroughs.

## Fee composition (unit)

```
chosen selling price   (color/option/base; regular, PRIME or PRO)
+ ONE availability fee, never both:
    preorder transport commission   (air/sea/land; product override else
                                     admin default; WAIVED for active PRO)
    — on a pre-order line paid in advance
    direct-sale surcharge           (products.direct_surcharge_iqd;
                                     WAIVED for active PRO, same gate as
                                     the commission)
    — on a direct line, and on a pre-order line paid CASH ON DELIVERY
+ selected warranty fee           (added on top; NEVER waived by membership)
= unit subtotal
```

Then, at order level: × quantity → coupon discount (if valid) → points
(1 pt = 1 IQD) → wallet application → **last-mile delivery** (chosen
delivery method price; **0 + `delivery_waived`=1 for active PRO**, or for a
referred friend's qualifying printer purchase). The availability fee,
last-mile delivery and warranty fees are three distinct charges — a waiver of
one never touches the others.

The resolver reports which rule priced the line as `pricing_basis`
(`'preorder'` = the commission is the fee; `'direct'` = the surcharge is), and
`direct: { surcharge_iqd, waived }` / `transport: { …, waived, waived_by }`
so every surface can name the fee instead of folding it silently. The printer
home-delivery **note** (setting `printerHomeDeliveryNoteIqd`, default 50,000)
is not in this list on purpose: it is shown, never added.

## Extended warranty (printers only — owner mandate, 2026-09-05)

`worker/lib/warrantyPlans.ts` is the one place the rules live;
`tests/extendedWarranty.test.ts` runs them through the real cart, product,
checkout and policy routes.

- **Eligibility**: a product filed under a printer catalog
  (`catalogs.is_printer_catalog`, answered by `worker/lib/printerIdentity.ts`).
  Anything else is refused a plan on every write path (admin save, TXT
  analyze/apply, CSV preview/confirm → `400 WARRANTY_NOT_PRINTER`) and at
  runtime (cart add/update, checkout → `WARRANTY_NOT_PRINTER`; the quote
  reports it in `errors`). Stored legacy plans keep resolving on read.
- **Shape**: `duration_kind = 'extension'`, `duration_months ∈ {12, 24}`, one
  plan per duration — "+12 months → 24 months total", "+24 → 36" over the
  12-month base (`warranty_base_months`, a printer's default; `serialized`
  defaults to true so a unit row exists for the coverage to attach to).
  **Read-time defaults** (`effectiveDevicePolicy` / `effectiveBaseMonths`):
  a printer whose stored `ops_policy` lacks the keys (`'{}'`, or only a
  base — rows written before this round) is READ as serialized with the
  12-month base by the resolver, `pricedPlans`, the cart and
  `deviceOps.createUnitsOnDelivery`, so its snapshot carries `base_months
  12 / total_months 24|36` and its delivery creates the units; an explicit
  `serialized: false` is the owner's word and is kept. No migration rewrites
  old rows. The admin ops-policy route refuses `serialized: false` on a
  printer with active plans (`400 WARRANTY_PLAN_INVALID`), as the form does,
  and the legacy `POST /api/admin/products` runs the same printer guard.
- **One plan per line, the customer's to change**: re-adding the same
  printer merges into the existing line; an add that names a different plan
  than the line holds (including a line with none) is refused `409
  CART_WARRANTY_CONFLICT` ("already in your cart with a different
  extended-warranty choice — change it from the cart"); an add naming no plan
  keeps the line's plan. The plan changes only through `PATCH
  /api/cart/items/:id`.
- **Fee** = `round(REGULAR price of the selection × fee_percent / 100)` in
  integer IQD (basis points, one rounding), else the fixed `fee_iqd`. The
  basis is the regular price — never the member price — so a guest, a PRIME
  and a PRO pay the same dinar for the same extension; the warranty fee is
  still **never waived by membership**. An option or colour surcharge moves
  the basis (A1 899,000 × 7.5 % = 67,425; Combo 1,099,000 → 82,425). The
  owner's 7.5–10 % is a hint the admin form shows, not a server cap
  (0.01–100, ≤ 2 decimals).
- **Where it is chosen**: the product page (before add-to-cart) or the cart's
  "Extended Warranty" disclosure, through `warrantyPlanId` on
  `POST /api/cart/items` and `PATCH /api/cart/items/:id`. One plan per line,
  applied to every unit of the line. `GET /api/products/:slug`,
  `POST /api/products/:slug/quote` and `GET /api/cart` serve each plan with
  its `fee_iqd` already resolved for the selection's regular price plus
  `basis_iqd`, `base_months`, `total_months` — the storefront never computes a
  fee.
- **Before the order only**: checkout freezes `ResolvedPrice.warranty`
  (`plan_id, title_ar, title_en, fee_iqd, duration_months, duration_kind,
  fee_percent, basis_iqd, base_months, total_months`) into
  `order_items.warranty_snapshot`; no route writes that column afterwards.
  At delivery `deviceOps.computeCoverage` prefers the snapshot's
  `total_months`/`base_months`, so the 24/36 promise survives a later product
  edit. The fee counts as a fee (`fees_iqd`), earns no points, and is invoiced
  under the plan's own title.
- **Policy text**: `policy_documents` key `extended_warranty` (LEVONIS's own
  draft in ar/en/ckb, seeded and published like every other policy); the
  storefront links to `/policies/extended_warranty` beside the chooser.

## Payment method × shipping type (owner mandate, 2026-09-05)

`worker/lib/paymentPolicy.ts` is the one place the rule lives; `computeCheckout`
applies it and `tests/checkoutPayment.test.ts` runs it through the real routes.

| Cart | Pay in advance (`wallet`) | Cash on delivery (`cash`) |
| --- | --- | --- |
| Direct sale | base + direct surcharge (PRO: base) | the same — the method never changes a direct line |
| Pre-order (air/sea/land), product **with** a direct surcharge | base + transport commission (PRO: base) — **exactly as configured** | **priced as a direct sale**: base + direct surcharge (PRO: base); the commission is not charged |
| Pre-order, product with **no** direct surcharge (`direct_surcharge_iqd` null/0 — the normal pre-order-only shape) | base + transport commission (PRO: base) | **the same** — there is no direct premium to price the line "as direct" with, so the commission stays, `pricing_basis` stays `'preorder'`, nothing is waived |
| Pre-order paid `cash` but the wallet settles the **whole** total (`due_on_delivery_iqd = 0`) | — | **a prepaid order**: re-priced under the pre-order rule (the cheaper figure, still covered), `prepaid_by_wallet: true` on the quote; `payment_method_id` stays `cash` |

- **Decisions from the adversarial review (2026-09-05).** (a) "Priced as a
  direct sale" applies only when the product actually carries a direct-sale
  premium; with none, cash on delivery would otherwise drop the commission
  and charge nothing in its place — the store loses the commission and the
  door becomes cheaper than the wallet, the opposite of the owner's intent.
  (b) «مدفوع مقدمًا» means nothing is left to collect at the door: a cash
  order the wallet covers in full is a prepaid order whatever button was
  pressed, so it gets pre-order pricing (and, for a PRO at the approved
  address, the prepaid gift); a cash order the wallet covers only in part
  stays COD-priced. `computeCheckout` prices the cart under the requested
  basis, and re-settles it as prepaid when that condition holds.
- The quote also says whether the method matters at all: `cod_reprices` is
  true only when some line's price differs between prepaid and cash (a direct
  premium this customer pays). The product quote's `pricing_modes` (direct,
  and per journey prepaid/cod with `cod_reprices`) and the cart line's
  `cod_reprices` carry the same fact, so the product page, the cart and the
  checkout explain the cash rule **only where the number would move** — and
  the product page computes none of its figures (no browser arithmetic).
- The offered ids are `wallet` and `cash` for **every** shipping type
  (`allowedPaymentMethods`), echoed on the quote as `allowed_payment_methods`;
  the storefront draws exactly those. `full_advance` is tolerated as an alias
  of `wallet` (stored orders, API scripts) and never offered; `half_advance`
  is refused with `400 PAYMENT_METHOD_NOT_ALLOWED`. No id is ever renamed —
  `cash` stays the platform COD id the admin labels and stickers branch on.
- A cash-on-delivery pre-order **stays a pre-order**: the resolver keeps the
  transport object with its method (`waived: true, waived_by:
  'cod_direct_pricing'`), so `orders.shipping_type` is still `preorder_*`, the
  order walks the fourteen pre-order stages, tracking labels the freight, and
  "buy again" repeats the pre-order line. Only the commission/pricing logic
  differs, which is what the owner asked for.
- The pre-order gift («PRO + طلب مسبق مدفوع مقدمًا = فلمنت هدية») still requires
  `due_on_delivery_iqd = 0`, so a COD pre-order earns none — unchanged.
- The cart and the product page know no payment method, so they show the
  **prepaid** pre-order price and say so; the checkout quote's `lines` and
  `subtotal_iqd` are the price authority once a method is chosen, and the
  checkout screen renders those, never the cart's numbers, beside the total.
- **One PRO purchase context on every surface** (`worker/lib/entitlements.ts`
  `pricingTierContext`): PRO prices and both availability waivers apply only
  at the approved default PRO address with benefits not restricted. The
  checkout judges the address the customer selected; the product page, the
  product quote and the cart — which have no selection yet — judge the
  customer's DEFAULT address. So an active PRO whose default address is not
  approved sees the surcharge on the product page, in the cart and at the
  checkout alike (`viewer_tier.pricing_active` / `pro_benefits_context` say
  so), never a price the door will not honour.
- Snapshots: `pricing_snapshot` carries `direct.waived`, `transport.waived_by`
  and `pricing_basis`; the invoice line carries `direct_surcharge_iqd` (0 when
  none or waived) beside `transport_commission_iqd` (0 when waived, for either
  reason). An order can therefore explain its own price after the cart is gone.

Validation errors (`OPTION_NOT_FOUND`, `COLOR_OPTION_MISMATCH`,
`TRANSPORT_REQUIRED`, `TRANSPORT_NOT_OFFERED`,
`TRANSPORT_COMMISSION_UNCONFIGURED`, `TRANSPORT_NOT_APPLICABLE`,
`WARRANTY_PLAN_NOT_FOUND`, `OPTION_INACTIVE`, `COLOR_INACTIVE`) reject the
selection server-side; the UI mirrors them but is never the enforcement.

## Worked examples (from the unit tests)

1. Base 100,000; option regular 120,000 selected → applied 120,000.
2. Option regular 120,000 with PRIME 115,000; colour regular 130,000 (PRIME
   null) → applied 130,000, PRIME 125,000: the colour's +10,000 is paid by
   every tier, inherited per-field from the option.
2b. Base 150,000 / 125,000 / 100,000, option +25,000, direct-sale premium
   100,000 → 175,000 / 150,000 / 125,000 for the item and 275,000 / 250,000 /
   **125,000** per unit — the PRO member is exempt from the premium.
3. Preorder, sea commission 15,000, free tier → unit subtotal 115,000.
3b. The same pre-order line paid **cash on delivery**, direct premium 50,000
   → 150,000 (base + premium; the commission steps aside); PRO → 100,000. The
   order is still `preorder_sea` with fourteen stages.
3c. A pre-order line with **no** direct premium paid cash on delivery →
   115,000, identical to prepaid: the commission stays (`pricing_basis:
   'preorder'`, `cod_reprices: false`). PRO → 100,000 (`waived_by: 'pro'`).
3d. The 3b line paid `cash` with a wallet that covers the whole 155,000 →
   re-priced as prepaid: 115,000 + 5,000 delivery = 120,000, all from the
   wallet, `due_on_delivery_iqd: 0`, `prepaid_by_wallet: true`. A wallet that
   covers only 70,000 of it stays COD-priced: 150,000, 85,000 due at the door.
4. PRO + air commission 25,000 + 2-year warranty 20,000, no PRO price →
   100,000 + 0 (waived) + 20,000 = 120,000.
4b. Printer 899,000 (PRIME 885,000 / PRO 799,000), extension +12 at 7.5 % →
   the fee is 67,425 for every tier (7.5 % of the REGULAR 899,000): free
   966,425 / PRIME 952,425 / PRO 866,425; +24 at 10 % → 89,900. Total
   coverage 24 / 36 months, frozen in the snapshot.
5. PRO with `explicit_only` policy and no explicit PRO price → pays the
   regular price; the UI shows no PRO discount.

## Snapshots

Each order line stores `pricing_snapshot` (the resolver output minus cost
fields — including `direct.waived`, `transport.waived_by` and
`pricing_basis`), `warranty_snapshot` and `transport_snapshot`; the order
stores `membership_tier_snapshot`, `exchange_rate`, `delivery_waived`,
`coupon_snapshot`. Later edits to products, prices, policies or the
exchange rate never alter historical orders.


## Points — earning, waiting and redeeming (mandate §4.2–§4.4)

This section **supersedes** the earlier "1 point per 1,000 IQD, awarded at
delivery" rule. Implementation: `worker/lib/pointsOps.ts`, migration
`0014_points_rule.sql`, tests `tests/points.test.ts`.

### Two different rates

| Direction | Rate |
| --- | --- |
| **Earning** | `floor(net eligible merchandise / 100)` — 100 IQD = 1 point |
| **Redeeming** | 1 point = **exactly 1 IQD** (739 points → 739 IQD, never rounded) |

They are deliberately not each other's inverse.

### The eligible basis

```
Σ (applied product price × qty)      official-store merchandise only
− coupon discount                     order-level
− points spent on this order          so points are not re-earned on
                                      value the customer never paid
= net eligible                        floor(…/100) ONCE, on the ORDER TOTAL
```

* Lines are **summed first and floored once**. Three 199 IQD lines earn
  `floor(597/100) = 5` points, not `1+1+1 = 3`.
* **Never in the basis**: last-mile delivery, preorder transport commissions,
  warranty fees. Changing the delivery method alone cannot change the points.
* Order-level discounts are subtracted from the merchandise pool **in full** —
  the documented conservative distribution rule, because a coupon may partly
  cover shipping and shipping must never earn points.
* Community-store lines and subscriptions are not eligible. (Today the
  checkout only ever loads the official `products` catalogue;
  `community_products` has no checkout path, so no mixed cart can leak in.)

### Redemption (§4.4)

"Use my points" applies **all available points**, capped at the eligible
merchandise value **after** product/membership/coupon discounts — never
delivery, never fees. Anything above that cap stays in the balance.

Only **released** points are spendable: pending accruals live in
`points_accruals`, not in the ledger, so they cannot be redeemed by
construction. Availability is read through the wallet slice's frozen
`getAvailableBalances` contract (settled minus active holds/reservations).

Points are **reserved and committed inside the same checkout batch** as the
order (`points_reservations`, UNIQUE per order). The ledger withdrawal
computes its amount against the live balance *inside* the statement, so a
losing concurrent order produces a negative amount, violates
`CHECK (amount > 0)` and aborts its whole batch — order, stock, wallet and
points roll back together. A failed checkout therefore leaves no reservation
to release: there is no orphan state to clean up.

### The seven-day wait (§4.3)

| Field | Meaning |
| --- | --- |
| `purchase_at` | the **server instant the checkout transaction committed the order** — the same transaction that reserved stock and debited money and points. Not cart creation, not a failed attempt, never the browser clock. |
| `available_at` | `purchase_at + 7 × 24h`, fixed at creation and never moved |
| `settled_at` | stamped when RECORDED collections cover `total_iqd` |

An accrual releases only when **both** hold. Wallet-prepaid orders settle at
purchase; a COD order settles when a collection is recorded in
`order_payment_settlements` — **delivery is not collection** (§11.5), and the
delivered transition never records one. A COD order collected on day 9
releases on day 9: settlement does **not** start a new seven-day clock. A
partially collected order stays pending.

Release runs in the durable job (`worker/lib/jobs.ts`, step 7) and on the
settlement event itself. Never on page open. Each release is one D1 batch:
a conditional `UPDATE` picks a single winner, the dependent statements repeat
that winner's `released_at` token, and the POINT deposit carries a
deterministic id — so a retried cron, an overlapping run and a concurrent
settlement can never credit twice.

### Reversals

Cancellations and returns write **negative accrual entries recomputed from
the remaining eligible amount** — `points_now − floor(remaining/rate)` — not a
floor of the returned portion, which would drift on repeated partial returns.
History is never edited or deleted.

* Accrual still pending → the reversal only reduces the pending amount; no
  ledger movement ever happened.
* Accrual already released → a balance-guarded claw-back. If the customer
  already spent the points the call reports
  `insufficient_points_balance` honestly instead of faking a claw-back, and
  the reversal row is rolled back with it.
* Refunds return **points as points** and cash by its own channel. Points are
  never converted to cash.

### Rule versioning (acceptance test PTS-07)

Setting `pointsRuleConfig`:

```json
{"iqd_per_point": 100, "legacy_iqd_per_point": 1000,
 "version": "v2", "legacy_version": "v1", "effective_at": "<ISO UTC>"}
```

The rate is resolved **once, at purchase time**, and frozen on the accrual row
(`iqd_per_point`, `rule_version`). Changing the setting later cannot re-price
history. Orders purchased before `effective_at` keep the legacy rate; orders
that predate migration 0014 have no accrual row at all and keep the original
`points_awards` delivered-award path, rows and rate untouched. **No existing
balance is ever multiplied, re-granted or recomputed.**

Migration 0014 seeds `effective_at` to its own application time, so every
order that already existed is unambiguously "before" it. The owner can move
that date (decision register row 20 / mandate §13 item 4).

## The §5 unified financial snapshot

Every cart, checkout, order-detail, admin-prep and invoice screen reads ONE
server-computed money view — `financial` on the order payload
(`worker/routes/orders.ts`). No screen recomputes totals, and nothing is
computed in the browser.

| Field | Honesty rule |
| --- | --- |
| `merchandise_iqd` / `fees_iqd` | goods separated from transport commissions and warranty fees |
| `coupon_discount_iqd` | shown on its own line |
| `points_used` / `points_value_iqd` | 1 : 1, applied to merchandise only |
| `shipping_iqd`, `delivery_waived` | declared, never hidden |
| `total_iqd` | after coupon and points, before wallet |
| `wallet_applied_iqd`, `wallet_tx_id` | the wallet is a **payment means**, not a discount — it never reduces the goods price |
| `due_on_delivery_iqd`, `collected_iqd`, `outstanding_iqd` | a COD balance is never "paid" at creation |
| `payment_state` | `cod_due` / `partial` / `paid`, derived from RECORDED collections |
| `points.pending`, `points.available_at` | what was earned and when it can be released |
| `support` | attribution with an explicit `discount_iqd: 0` — a support code is **not** a discount |

Worked example (the mandate's §5 arithmetic, pinned in
`tests/points.test.ts`):

| Step | IQD |
| --- | --- |
| Merchandise net of commercial discounts | 75,000 |
| − 739 points redeemed (739 IQD) | 74,261 |
| + delivery | 5,000 |
| **Total** | **79,261** |
| − wallet payment | 30,000 |
| **Due on delivery (COD)** | **49,261** |
| Pending points accrued: `floor(74,261 / 100)` | **742 points** |
