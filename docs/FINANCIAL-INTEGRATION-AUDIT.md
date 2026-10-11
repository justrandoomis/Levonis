# Price and cost integration review — 2026-10-11 (Baghdad)

Scope: the owner's request to trace every connected price/cost workflow, from
product inputs and procurement through retail orders, refunds, profit, employee
wages and investor earnings. This review supplements DECISIONS 215–216 and the
existing accounting policies; it does not introduce a new accounting currency,
profit-sharing formula or valuation policy.

## Field propagation

| System / input | Authoritative path | What changes / what is preserved |
|---|---|---|
| Product supplier amount and currency | ProductForm → UsdPricingSection → pricing preview/inputs parser → `pricing_inputs` / `pricing_rules` → common engine evaluator and writer | USD/EUR/CNY source amounts retain their currency. IQD convenience input records its conversion rate/version and stays fixed until explicitly reconverted. |
| Product weight, box dimensions, manual CBM, shipping profile | Same pricing parser and resolver; SKU → colour → selected options → base precedence | Kilograms become grams; centimetres become millimetres. Manual CBM takes precedence at the same specificity. Only the selected route's relevant measurements enter its cost. Conflicts refuse instead of choosing silently. |
| Extra cost, minimum profit, direct-sale extra | Exact decimal engine maths → `pricing_sku_costs` plus stored sale ladder | Extra cost is per-piece IQD, minimum profit is canonical USD, direct extra is IQD in the existing 1,000-dinar steps. Engine writes price/provenance together; cart and checkout resolve the saved price server-side. |
| Procurement supplier amount, quantity, FX snapshot | Purchase line → exact `purchase_total_iqd` | Actual cost uses the purchase's recorded rate, not today's market rate. |
| Procurement shipping and other charges | Packed measures and route snapshot + named charges → `charges_iqd` → receipt allocation | Quotient/remainder allocation preserves the whole purchase and every charge exactly across partial receipts. Investor principal stays separately tracked. |
| Received stock and direct pricing | Integer-cost inventory lots; separate private direct-purchase pricing overlay | FIFO uses actual received cost. The overlay uses purchase inputs to price replacement stock with current rates, without replacing prepaid preorder inputs. Explicit complete review can activate all channels. |
| Direct/preorder orders | Common saved price resolver → frozen `order_items`, benefits, fees, points and accepted price adjustment | New orders receive the applicable saved channel price. Existing orders retain their agreed numbers. Existing COD/direct-price alias and preorder policy are unchanged. |
| Cost of goods sold | FIFO lot allocations → recorded COGS → central profit and journals | Simultaneous deductions must either retain a complete FIFO allocation or refuse for retry. Returns restore the original lots. Later landed-cost corrections append versions/shares rather than overwriting the original allocation. |
| Revenue, costs and profit | Recorded order goods + recorded FIFO + linked expenses, collections, refund facts and append-only corrections → `getOrderProfitBases` → finance workspace / journals | Current catalogue costs do not replace actual COGS. Unknown/partial actual COGS remains explicitly unknown. Legacy estimates are labelled separately. |
| Employees | Shared recorded order profit basis → effective wage rules → `finance_order_costs` and adjustments → withdrawal reservations/payments | Existing wage policy remains. A concurrent withdrawal cannot reserve more than a recalculated entitlement; already-paid reductions remain recorded debt under existing policy. |
| Investors | Funded-stock participation and recorded retained sales/expenses → earnings ledger and withdrawal availability | Capital and earnings remain separate. Unused capital returns once at confirmation. Historical purchase rates are not revalued by market FX changes. |
| Central FX and shipping | Approved effective rates + versions → atomic derived currency rows → immediate repricing and scheduled backlog processing | Only adopted products using affected inputs reprice. Held/rejected candidates do not apply. Incomplete products keep their last price with an owner notice. Successful rate actions refresh both pricing lists. |

The existing `price_iqd` field is the real stored/manual sale price, not an unused
legacy label. `product_cost_iqd` / legacy cost cells remain fallback inputs for
legacy completeness and explicitly estimated accounting paths. Neither field
was deleted, zeroed, or silently reinterpreted in this work.

## Boundaries that must stay separate

- **Shop FX versus wallet rate:** market pricing uses the approved FX chain;
  wallet balances remain integer USD cents and use the separate `exchangeRate`.
  Memberships, escrow and Quick Buy use that wallet contract. Market FX must not
  revalue wallet transactions, completed memberships or existing escrow deals.
- **New prices versus past costs:** today's replacement/selling price can move;
  a paid purchase, received lot, accepted order and original allocation are
  recorded facts. Corrections use the established adjustment workflow.
- **Central finance versus legacy report:** the central workspace includes
  order-specific corrections and investor distribution. The legacy report
  explicitly identifies figures before those entries; report-only coupon and
  price-protection overlays do not settle earnings or rewrite journals.
- **Retail versus print/marketplace quotes:** new print quotes read current
  material catalogue prices through their source hierarchy, then preserve the
  quote's input/cost/result snapshot. Accepted community offers freeze price,
  delivery, fee and merchant receivable at the accepted revision. Their wallet
  escrow is not retail inventory COGS.
- **Inventory shipping versus selling shipping:** actual purchase charges,
  procurement defaults, central pricing freight and customer delivery fees have
  different jobs. Sharing the word “shipping” does not make them one mutable
  number. Customer delivery remains outside goods profit under existing policy.

## Reproduced defects addressed

1. An all-channel engine review could silently fall back to direct-only success
   when preorder inputs were incomplete. The requested channel set now either
   passes completely or refuses without a partial save.
2. A market-rate update between two reads could save a new IQD conversion with
   stale rate provenance. The commit now checks both effective values and the
   USD rate version, including a rate that moves away and back to the same value.
3. A concurrent stock deduction could leave a stock movement without its FIFO
   allocation. Lot availability is checked inside the same atomic batch, also
   on the old schema that predates the operations-guard table.
4. Legacy incoming receipts rounded one average unit cost and could lose a
   remainder when all pieces were sold. They now split uniform integer-cost
   lots at the component remainder positions, like modern procurement.
5. Editing incoming financial fields during receipt could record different
   purchase and lot costs. Receipt checks its exact source snapshot/cursor;
   financial edits check that receipt has not started. A stale request gets a
   localized retry refusal. Paperwork edits remain available.
6. Temporal wage reconciliation could reduce an entitlement after a concurrent
   withdrawal had reserved it. A single aggregated in-transaction reservation
   guard protects the adjustment without a per-employee query increase.
7. Successful rate actions refreshed one embedded list but left sibling pricing
   views stale. The parent refresh key now updates both while retaining filters.
8. Finance interpreted every recorded membership saving as an additional line
   discount, although checkout can already embed it in the unit price. Shared
   frozen-snapshot interpretation distinguishes these cases; missing or ambiguous
   evidence retains the legacy reading. Current membership rules never decide
   what an old customer paid.
9. A return could ignore an accepted price change and line-level membership
   saving. Invoice-based return maths now incorporates those amounts while
   preserving the existing coupon/points, shipping and Gini policies.
10. Separate partial returns could create or lose a dinar through independent
    rounding. Cumulative remainder allocation and a prior-refund fence make
    their combined amount exact; the case decision and wallet credit commit
    together. Existing credited transactions are not rewritten.
11. Supplier reports multiplied a rounded per-unit purchase cost by quantity,
    understating a recorded fractional-currency invoice. They now use the exact
    recorded purchase total, with the existing fallback on older schemas.
12. New invoices could print an embedded unit membership saving as a second
    subtraction, so the displayed breakdown disagreed with the correct order
    total. Their snapshot builder removes only that duplicate deduction. Order
    totals and already-issued invoice snapshots remain unchanged.
13. Trade-in paid-value caps made the same duplicate membership deduction.
    They now share the frozen evidence rule without changing their existing
    warranty, coupon or valuation policy.
14. Corrected membership reads did not by themselves update old native sale
    journals or persisted earnings projections. Affected financial fingerprints
    now require reconciliation. The existing bounded recovery covers staff,
    investor-only and owner-only orders. A proved old native sale receives one
    balanced correction to receivable/advance/revenue/shipping in an open period;
    original journal lines, payments and withdrawals remain unchanged. Unexplained
    journal differences require review rather than an invented adjustment.

Actual cart → checkout → accepted adjustment → delivery → return regressions
cover the membership and return findings. They include simultaneous partial
refunds, exact remainder allocation, rollback on failed wallet credit and the
accepted-price ceiling. Existing Gini and bundle-component compatibility suites
also pass. Unknown prior refunds and
positive wallet refunds below one cent stop for explicit review before a case
is marked resolved. Trade-in and earnings use the same frozen membership evidence.

## Verification and release

The `tests/financialIntegration*.test.ts` files exercise cross-system paths
with synthetic values. Relevant existing compatibility, privacy and query-budget
suites passed alongside independent reviews. Separate
wallet, membership, print quote, escrow and price-protection tests cover the
boundaries above. No audit fixture is written to production.

Full release status is maintained in `HANDOFF.md`. Workflow 7 must pass the
entire unit suite, migration replay, restore-point gate, deployment, matching
live bundle, current schema and read-only probes before this work is called live.
Local browser E2E was unavailable; source/runtime tests and successful frontend
builds are not described as a browser pass.
