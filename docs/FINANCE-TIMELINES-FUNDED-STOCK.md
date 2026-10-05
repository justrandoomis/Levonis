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

Apply requires a reason, operation ID and current preview token. It atomically saves the wage version, impact audit, pending targets and resumable reconciliation job. Unpaid reservations affected directly or through investor profit need explicit release; paid portions remain. Pending wage corrections reserve the necessary overpayment while independent wages remain withdrawable. Jobs resume through the existing reconciliation route/runner and post each difference once.

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
2. Unknown historical FIFO/verified costs: enter documented costs before profit-dependent entitlements become available. Fixed and sales-based wages do not depend on these costs. Earlier production diagnostics found 117 such profit-based pending wage costs.
3. Older payment rows without enough evidence for a balanced per-source split: preserve the payment and expose a review count.
4. Legacy USD investment rows without an evidenced link: retain as historical, non-withdrawable records; no assumed exchange rate.

## Validation

Behavioral suites: `financeWageTimeline`, `fundedProcurement`, `financeParticipants`, `financeEmployment`, `investorFinance`, `financeLegacyAndPrices`, `financeWorkspace`, `operationsErp` and procurement concurrency tests. They cover retroactive increases/decreases, Baghdad midnight, delivery after checkout, start-date changes, later rule boundaries, replay, partial payments/open withdrawals, exact-cost/principal remainders, multi-lot investors, delivery/collection gates, returns after payment, default immutability, period filters, account isolation and exact-option price edits.

Migrations 0167–0170 preserve existing source records. Register their tables with the Ledger owner and classify financial JSON as non-media so schema completeness checks continue to protect media cleanup.
