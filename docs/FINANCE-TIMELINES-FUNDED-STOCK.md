# Effective wages and funded inventory

This extends the existing finance, FIFO inventory and account withdrawal systems. Amounts are integer IQD. Unknown costs remain null. No migration posts a payment, changes historical USD amounts or turns a forecast into an entitlement.

## Authority and ordering

- `financeWageTimeline` selects one immutable wage version per rule on the Baghdad delivery day. Starts are inclusive; the next boundary is exclusive. Historical insertion stops at the next saved boundary.
- Undated legacy task-assignment rules keep their existing posting path until an employment date or explicit wage revision moves them into the timeline. Pending FIFO wages still follow a valid task reassignment.
- Employment eligibility remains the day after `start_work_date`. Default rules follow that first eligible day; explicit effective dates retain their meaning. Archives and inactive intervals preserve earlier entitlement.
- `financeWageCalculation` is shared by preview and posting. Original costs and payment evidence stay intact. Only the difference from the already-adjusted amount is posted.
- Pre-timeline snapshots remain evidence of an already-earned historical value until an explicit new effective boundary applies. The migration cannot reconstruct dates that the old system never recorded.
- Wage basis labels distinguish unit, order, retained sales and retained goods profit. The last basis is revenue after goods discounts/returns less verified COGS, before wages and investment distribution.
- Wages precede the distributable order profit, investor share and owner remainder. Delivery's internal preparation pass does not attempt to publish investor profits before the sale/COGS journal exists.
- `participantSummary` and `participantWithdrawableSources` are the balance and allocation authority for account pages, contract details and withdrawals. Wage, investment-profit and capital ledgers have independent budgets.

A paid 100,000 corrected to 70,000 leaves debt 30,000 and no availability. Earning 10,000 leaves debt 20,000; earning another 25,000 leaves availability 5,000. Reservations are not cash debt, and unsettled advances are counted once.

## Preview and application

Owner-only routes under `/api/admin/finance-people/rules/:id` accept `preview` and `apply`. Preview processes six real orders per page, saves a durable cursor and accumulates totals for every match. Detail display is bounded, totals are not. Refresh/retry reuses the job. Source-clock changes require a fresh preview.

The preview distinguishes all reviewed orders from orders/units in the changed scope, including the previous scope and displaced rules. Earnings totals cover the reviewed orders; balance and paid amounts are cumulative. Known corrected wages remain visible when other profit-based wages need verified costs; previously recorded amounts awaiting verification are disclosed separately. Unknown line profit keeps the owner's result unknown instead of presenting a partial sum as net profit. Investor uncertainty is evaluated separately. A calculation revision invalidates saved and interrupted previews across deployments, requiring a new review before application.

Apply requires a reason, operation ID and current preview token. It atomically saves the wage version, impact audit, pending targets and resumable reconciliation job. Unpaid reservations affected directly or through investor profit need explicit release; paid portions remain. Pending wage corrections reserve the necessary overpayment while independent wages remain withdrawable. Jobs resume through the existing reconciliation route/runner and post each difference once.

Employment-date recalculation is separate from saving the date. The previous browser loop stopped after five seconds, while a reconciliation HTTP request could attempt ten orders within the client's twenty-second timeout. A request could commit several orders before disconnecting, leaving the screen displaying an old partial balance until a refresh or the fifteen-minute scheduled runner. Keep HTTP pages bounded to one order, read durable job status after uncertain responses, and continue serially while the employee screen remains open. Refresh balances during progress and at completion; a failed job must remain visible for explicit retry. Neither a reconnect nor a revision change may replay an already-posted monetary difference.

Delivery awaits its own financial posting before returning. A historical reconciliation cursor must not hide a newly posted wage when its target proves the current employment revision, delivery day and effective amount. Historical overpayment reserves remain in the balance calculation. Scheduled jobs are recovery, not the normal delivery accrual trigger; an already-open earnings screen still refreshes through its normal polling/focus behavior.

Direct staff payments use the same wage-only availability budget as withdrawals, including prior paid amounts awaiting reconciliation, advances and open reservations. Approved positive cost rows alone are not a complete balance. A source-set fence protects that budget before recording a payment; investor capital and profits are not used to cover wage debt.

The wage editor separates fixed IQD from percentages, then offers fixed pay per sold unit or once per eligible order. Six eligible units earn six unit wages or one order wage. Profit and sales percentages apply to the eligible products' financial base, which already includes quantity; they never multiply that result by quantity again. Per-employee order totals group distinct product/rule costs without deleting or combining their accounting records.

## Cost evidence and review

`cost_basis=snapshot` means a cost recorded at checkout under migration 0095. With no FIFO allocation, a valid saved integer cost is `recorded_snapshot` and can support profit-based wages. It is distinct from legacy `unrecorded` reference values and `unpriced` unknown costs. Existing FIFO allocations take precedence: incomplete quantity or missing allocation costs cannot fall back to a product snapshot. Current catalogue suggestions require explicit per-order verification and never rewrite historical costs automatically.

Active orders that have not been delivered can show a separate goods-cost and goods-margin forecast from the exact saved option-value IDs and colour. Store orders do not need the marketplace `variant_id` to identify their inventory selection. The forecast names its confirmed-lot or catalogue source and never changes the recorded order cost, payable wages, investor entitlement or ledger. It is not labelled final owner profit. Cancelled orders retain their actual status rather than requiring a missing-stock review merely because no stock was issued; genuine financial or refund gaps remain reviewable.

Order detail explains missing allocation quantity, unknown lot cost, unverified historical cost, return/refund gaps and pending wage reconciliation beside the relevant product. Proven snapshot costs need recalculation of previously pending wages, not manual approval of an invented cost. Existing order reconciliation and the resumable employee job preserve original entries, payments, manual overrides and idempotent adjustments.

A staff-only recheck does not post the order's native goods expense. When a historical delivered order has a proven snapshot but no COGS journal, retain its accounting alert and identify the missing posting explicitly. Full order-finance retry posts that expense once; only a posted journal, a reconciled manual-cost overlay or a genuine zero cost can clear the old COGS alert. A known cost alone must not hide an unposted expense.

An unknown refund amount also leaves sales/profit-based pay unknown. Both the original and timeline writers use the corrected order basis, and refreshing a legacy wage fingerprint cannot make an unrecorded refund withdrawable. Fixed pay remains independent of the refund amount. Saved wage previews from calculation version 2 must be reviewed again after these changes.

Adjustments use the open posting day and separately preserve historical earning day. Manual per-order overrides remain visible and are preserved. Correcting them remains a separate order-finance action.

## Funded procurement

The four steps are funding, product selections, costs and review. Drafts preserve input. Incoming orders do not add sellable stock; the on-hand path confirms and receives with independently idempotent operations.

Registered investors must be eligible assistant accounts. Profiles contain defaults, while each funded purchase has immutable agreed terms. Profit, capital contribution and loss share are independent. Updating defaults does not update existing agreements. Monthly promotion and owner overhead remain owner costs.

Agreement alone is not cash. Receipt events record actual amount, date and reference. Funding is allocated by landed line value, once across selected lines; surplus remains unallocated and any shortfall/store contribution is displayed. Each line links to its incoming inventory, contract and received lots.

Total and unit purchase modes preserve the entered total. Shared charges declare quantity, value, weight or volume allocation. Receipt lots split at purchase, freight and funded-principal remainder boundaries, so partial receipt, FIFO sale, return and resale retain every dinar. Procurement suggestions use the latest confirmed received cost for the exact selection; unknown cost is not zero. Updating the public selection price is a separate explicit, version-guarded action.

Acceptance example: five A1 Combo units, purchase 2,500,000 plus inbound freight 500,000, cost 600,000 each. Sale 965,000 gives profit 365,000; a 35% investor share is 127,750 and owner remainder 237,250. A further 10,000 direct order cost makes the investor share 124,250. Profit availability additionally requires delivery, collection, verified costs and funding.

## Reporting and historical review

Staff and investor period earnings use delivery day in Baghdad. Payments and adjustments use posting day. Account balances are cumulative and explicitly separate from period results. Filters apply on the server; aggregate totals are not limited to the visible page. New charts cover participant accrual/payment, capital recovery, adjustments and batch quantities.

Old `/invest` and `/admin/invest` routes redirect to the current account or authorized financial workspace. Legacy API reads remain compatible; legacy writes return 410. Historical investment amounts retain `USD`/`cent`, including expected profits. Matching requires documented evidence and the same account and posts no money.

Records requiring human review:

1. Pre-timeline changes without an actual effective date: preserved as history, never assigned an invented date.
2. Unknown historical FIFO/verified costs: enter documented costs before profit-dependent entitlements become available. Fixed and sales-based wages do not depend on these costs. An earlier count of 117 pending profit-based wage costs predates the recorded-snapshot correction; it must not be interpreted as 117 records requiring manual cost entry. Reconcile proven saved costs first, then review the remaining explicit gaps.
3. Older payment rows without enough evidence for a balanced per-source split: preserve the payment and expose a review count.
4. Legacy USD investment rows without an evidenced link: retain as historical, non-withdrawable records; no assumed exchange rate.

## Validation

Behavioral suites: `financeWageTimeline`, `fundedProcurement`, `financeParticipants`, `financeEmployment`, `investorFinance`, `financeLegacyAndPrices`, `financeWorkspace`, `operationsErp` and procurement concurrency tests. They cover retroactive increases/decreases, Baghdad midnight, delivery after checkout, start-date changes, later rule boundaries, replay, partial payments/open withdrawals, exact-cost/principal remainders, multi-lot investors, delivery/collection gates, returns after payment, default immutability, period filters, account isolation and exact-option price edits.

Migrations 0167–0170 preserve existing source records. Register their tables with the Ledger owner and classify financial JSON as non-media so schema completeness checks continue to protect media cleanup.
