> Operations extension, authorized 2026-10-03: [OPERATIONS-UPGRADE.md](OPERATIONS-UPGRADE.md) documents versioned order costs, payroll, scoped overhead allocation, collections and accounting journals.

# The owner's accounting rules

Four questions decide every number on the financial dashboard. The owner
answered all four on 2026-09-19, and the answers are recorded here because a
rule that lives only in a chat message is a rule the next reader will
re-litigate — and because two of these choices are the kind that look like
implementation details until a figure moves and nobody can say why.

`worker/lib/financeReport.ts` implements them. If this file and that file ever
disagree, **this file is the specification** and the code is the defect.

---

## 1. A sale becomes profit ON DELIVERY

Not when the order is placed, and not when the money arrives.

The owner's words for the question: a pre-order whose price you collect today
and deliver in forty days — which month's profit is it? Answer: the month it
reaches the customer.

**Why this and not the alternatives.** This store sells cash on delivery and by
pre-order. An order that has not arrived can still be cancelled, or refused at
the door — so counting it at placement inflates a month and then deflates it,
and the owner cannot trust a figure until it has stopped moving. Counting at
PAYMENT is worse for the opposite reason: a pre-order paid today carries its
cost forty days later, so revenue and cost land in different months and the
margin for both months is fiction.

**What this rule costs, and what pays it back.** A pre-order you were paid for
in January does not appear in January's profit. That is money in the drawer
that the profit figure does not mention, so the dashboard carries its own
answer to that: a separate figure for **مقبوض ولم يُسلَّم بعد** — cash received
against undelivered orders. It is not profit and is never added to profit; it
is the other half of the picture, shown beside it rather than mixed into it.

## 2. A refund is deducted from the month it HAPPENS

A January sale returned in March reduces March, not January.

**Why.** January is closed. The owner has seen that number, may have printed
it, may have decided something on it. A report whose past silently rewrites
itself two months later cannot be reconciled against anything — not against a
cash count, not against a previous screenshot, not against a decision already
taken.

**What this costs.** A month carrying returns for old sales looks weaker than
its own trading deserves. So the returns figure is shown as its own line inside
that month rather than folded invisibly into profit, and it names how much of
it belongs to sales from earlier periods.

## 3. Orders sold before the cost snapshot are ESTIMATED, and say so

The cost of a sale is captured at the moment of the sale (§4 below). Orders
placed before that column existed have no captured cost, so their profit can
only be computed against the product's cost **today**.

Those figures are computed and shown — a dashboard that hides the store's whole
history is not useful — but every bucket containing one is marked, with the
count of estimated lines in it.

**The rule this enforces:** an estimate is never presented as a measurement.
The marking is not a footnote or a tooltip; it sits beside the number, because
somebody deciding a supplier price from that number needs to know which part of
it was reconstructed.

## 4. Delivery is not profit

The delivery fee a customer pays passes through. It is excluded from the profit
on goods and reported on its own line, and what the store pays a courier is an
operating expense the owner enters like any other.

**Why it matters more than it looks.** Delivery fees vary by governorate. Fold
them into revenue and a distant governorate looks more profitable than a near
one purely because its delivery costs more — and the margin on a product stops
being the margin on that product. Keeping it out is what lets "this product
earns 18%" mean what it says.

---

## And the rule underneath all four: cost is captured at the sale

The owner: «تغيير سعر التكلفة للمنتج لاحقًا — المنتجات القديمة التي بيعت لا
تتأثر، فقط المنتجات التي سوف تُباع بالتكلفة الجديدة».

`order_items` stores the unit cost as resolved at the moment of sale. Editing a
supplier price changes what future sales cost and nothing else. Before this,
the cost was deliberately discarded from the order snapshot
(`worker/routes/orders.ts` — `const { cost_iqd, ...snapshot }`), which was right
for its purpose, customer payloads must not carry cost, and wrong for this one:
it left profit computable only against the current price, so every historical
figure moved whenever a supplier did.

**The cost still never reaches the customer.** It is on the row now, and every
customer-facing serializer must keep stripping it. That is the way this change
can do harm, so it is the thing to check first when touching an order
serializer.

---

## Two profits, never one

- **الربح الإجمالي** — revenue minus the cost of the goods sold. Available per
  product, per category and per sub-category, because every part of it belongs
  to a product.
- **الربح الصافي** — gross profit minus operating expenses. Per period ONLY.

Rent, salaries and advertising belong to no product. Splitting them across
products by revenue share is an invention, and an invented per-product net
profit is exactly the kind of number that gets a real decision wrong. So the
dashboard refuses to compute it and says why where the owner would look for it.

## 5. A waived fee is not a smaller fee — it is a cost the store paid

Added 2026-09-19, and it refines rule 4 rather than replacing it.

The owner: «في اشتراك الأعضاء التوصيل لهم مجاني والضريبة لهم مجانية، إذا هذا
يخصم من الأرباح … إذا كان اكو كوبون فيه خصم توصيل مجاني أو بدون ضريبة فإنه
يخصم من الأرباح».

So delivery is pass-through **only while the customer pays it**. The moment the
store waives it — a membership benefit, a referral, a coupon — the courier is
still paid and the tax is still owed. That money leaves the store, and a profit
figure that does not subtract it is reporting a profit the owner does not have.

Worked through on the owner's own example. A product whose cost is 1,000,000
with delivery at 50,000 and COD tax at 12,000: a member pays neither, so the
store keeps **938,000**, not 1,000,000.

### Nothing new has to be recorded — migration 0074 already did it

The schema stores the amounts, not flags, and its own comment says why:

    -- The tax as CALCULATED, beside the part the membership waived. Both,
    -- always: an exemption that overwrites the tax with zero destroys the
    -- audit trail the invoice and the COD reconciliation both depend on.

    orders.shipping_before_benefit_iqd   orders.shipping_benefit_iqd
    orders.cod_tax_before_exemption_iqd  orders.cod_tax_exemption_iqd
    orders.membership_discount_iqd       order_items.membership_discount_iqd
    orders.benefit_snapshot              (which rules fired, what each was worth)
    orders.delivery_waived               orders.referral_delivery_waived

An exemption that had overwritten the tax with zero would have made this rule
unimplementable after the fact. It did not, so the cost of every benefit ever
granted is recoverable from orders already in the database.

### What the dashboard therefore shows

A line of its own — **تكلفة امتيازات الأعضاء** — totalling what was given away:
waived delivery, waived COD tax, and the membership discount on the goods. It
is subtracted in reaching net profit, and it is broken down by tier and by
source (membership, referral, coupon).

That figure answers a question the owner has never been able to ask: what does
the PRO and PRIME programme actually cost per month, against the extra sales it
brings. A benefit whose cost is invisible is a benefit nobody can price.

### The rule that keeps the two profits honest

The waived amount belongs to the ORDER, not to the product — the same reason
rent does. So it is subtracted in **net** profit, per period, and never spread
across products to make a per-product net figure. Gross margin on a product
stays the margin on that product.

## 6. Owner workspace and employment dates (2026-10-04)

The later owner requirements add managerial allocation alongside the original
accounting report. The workspace labels the owner's net share separately:
goods, delivery, payment fees, discounts, staff, investor distributions and
recorded expenses all affect it. Monthly promotion is allocated across the
whole month's sold units; narrowing the report's from/to filter does not move
the entire month's advertising bill onto the remaining products. The original
accounting view remains explicitly labelled as before profit distribution.

The overview supports inclusive report dates in Baghdad time, up to 365 days,
and daily revenue/cost/net, expense composition and main-section comparison
charts. Unknown costs remain unknown in figures and chart gaps. Monthly cost
entry retains its own month selector independently of the report's date range.

An employee's work start date is an **exclusive Baghdad delivery-day cutoff**,
as requested: a start date of 20 September makes deliveries from 21 September
eligible. Order creation time does not establish wage eligibility. Adding or
changing that cutoff queues resumable historical calculation; the browser
processes a short foreground batch and the scheduled worker resumes the rest.
Explicit earning-rule date limits remain visible and applicable.

Employment corrections append audited adjustments in an open period. Original
costs, settled payments, user accounts and closed-period journals remain
preserved. Deleting an employee archives them, stops new accrual, and allows
restoration without deleting financial history. Pending recalculation is
visible and protects withdrawals from stale balances. Metadata-only name and
job-title edits do not start another financial recalculation.

The employee earnings page keeps balances, withdrawals and investment capital;
the order-by-order earnings section is no longer shown there. Finance retains
the order-level audit and cost detail. Since 2026-10-10 (owner request,
DECISIONS row 215) the page also has no movements log («سجل الحركات»): the
server no longer builds or sends `movements`, `movement_count` or
`history_review_count` (`worker/lib/financeAccountHistory.ts` was deleted).
No ledger row changed; the owner's staff and payout views read the same
sources as before.

### Cost warnings and employee availability (2026-10-05)

A completed employment calculation can create valid wages on older delivered
orders whose inventory COGS is still unverified. A `cogs:<order>` posting warning
must not withhold fixed per-unit/per-order pay or a reconciled share of sales:
those rules do not use inventory cost. Profit-percentage pay and unknown legacy
rule bases remain blocked. Other posting failures, stale percentage bases,
employment cutoff jobs, holds and advances retain their existing payout guards.
The same eligibility predicate governs balances, withdrawal reservations,
approval, settlement and the older payroll screen. Inventory warnings and
investor safeguards remain intact; no cost estimate is substituted for FIFO.

The participant response now includes only the signed-in employee's start date,
first eligible Baghdad delivery day and calculation progress, even before the
first wage exists. The employee screen refreshes while that calculation runs
and when returning to the tab. A completed calculation with no deliveries after
the cutoff is explained to both employee and administrator, without changing
the configured date or exposing other accounts or raw diagnostic errors.

Regression coverage reproduces the original zero available balance for fixed
and revenue-share wages, verifies withdrawal/payroll settlement, and keeps
unverified profit shares and unrelated posting failures protected.

### Earnings screens opened before a date change (2026-10-05)

An employee can already have the earnings page open when the owner changes
their start date on another device. Polling only a job already observed as
pending misses that transition entirely. The screen now uses the existing
visibility-aware refresh hook every 30 seconds, accelerated to 15 seconds
while historical calculation is pending. It also refreshes on focus and browser
history restoration, and retries after temporary read failures. Hidden tabs,
in-flight reads, withdrawal forms and submissions pause refreshes. These are
read-only balance requests; no new accrual or withdrawal is initiated by polling.

### Frozen membership savings and financial revenue (2026-10-10)

Checkout records the full membership saving in `membership_discount_iqd`.
When the frozen `benefit_snapshot.lines` marks that saving as `applied_at:
'unit'`, it is already included in the stored unit price and line total.
Subtracting it again understates revenue. A saving marked `'line'` still
needs one subtraction. The canonical goods calculation and the accounting
report now share this distinction, using the frozen product/rule evidence.
They retain the previous interpretation when that evidence is missing,
malformed or contradictory; current membership rules never reprice an order.

This corrects historical reads where the snapshot proves an embedded saving.
It does not change stored orders, discount snapshots, already-issued invoices
or existing journal entries, and it does not run a migration or bulk reposting.
New invoices and explicit revisions display only the membership deduction
that is not already embedded in their subtotal. A native
sale journal already posted under the previous calculation remains part of
the recorded history. If its entire receivable/advance/revenue/shipping vector
exactly matches the former calculation, normal reconciliation appends one
balanced `membership-sale:<order>` correction in the current open period.
It neither collects cash nor rewrites the original journal. The existing bounded
recovery also reaches affected orders without employees or investors. Unexplained
old journals require review; concurrent corrections and replays cannot post twice.
Ordinary later wage or investor reconciliation can use the corrected
profit basis and append its usual adjustments in an open period, subject to
the existing payment and withdrawal guards. Frozen membership evidence is
included in the relevant source fingerprints so a concurrent change cannot
commit a calculation made from a different source.

`tests/financialIntegrationFinance.test.ts` covers the recorded IQD flow from
sale and FIFO through collections, expenses, promotions, cost corrections and
partial returns. It also checks embedded versus line membership savings,
historical fallback, and that changes to current catalogue prices or exchange
rates do not change recorded costs or post accounting entries.
It also verifies native-journal parity, unchanged advances and collections,
closed-period refusal, concurrent replay and subsequent actual refunds.


## 7. Participant shares use net profit (owner clarification, 2026-10-22)

The owner explicitly corrected the requested direction: «اجعله يحسب من الربح
الصافي بعد الخصومات وكل شي وليس قبلها».

Profit-percentage wages and investor distributions now include coupons,
points, membership and offer savings, accepted price reductions, actual
returns, credited price protection, verified inventory cost, direct costs,
collection fees and allocated ordinary monthly expenses. Promotion is borne
solely by the store (owner clarification, 2026-10-23). A line coupon or embedded
membership saving is counted once. A stocked trade-in credit remains payment
in kind; returned credit is removed from retained revenue.

Otherwise unlinked operating expenses, excluding the expense attached to a
monthly promotion, use all sold units in the delivery's Baghdad month.
Changes to that ordinary overhead or its sold-unit population invalidate
affected balances for bounded reconciliation. Promotion still uses the
monthly sold-unit allocation in the owner's report only. Adding, editing or
disabling promotion cannot reduce or block participant balances. Missing inventory
cost or other pending costs remain unknown rather than zero.

Staff profit percentages are calculated before their own percentage
allocations, avoiding a circular calculation. Fixed and revenue-based wages
are expenses. The established order remains: calculate staff pay first, then
investor shares after staff costs. Fixed wages, explicit manual overrides and
revenue-percentage contracts keep their respective rules.

This supersedes the former report-only coupon/price-protection exception and
owner-only ordinary-monthly-expense treatment for participant entitlements;
the owner's promotion exception remains in force. It does
not rewrite original orders, invoices, payments or closed-period journals.
Old projections are invalidated by the versioned financial fingerprint;
recovery appends the difference in an open period. Already-paid amounts remain
recorded and may become an outstanding offset; an open withdrawal must be
released before a reduction can consume its reservation.

Migration 0210 adds only preview-clock triggers for the newly relevant credit
and promotion sources. Existing financial rows are unchanged. A stored wage
preview expires when those sources change; an older database can still serve
earnings but must finish this update before accepting a new wage preview.

Example: sale 100,000, goods cost 60,000, discounts 20,000 leaves a 20,000
profit basis before any further costs. A 10% staff share is 2,000; a 35%
investor share, after that staff expense, is 6,300. Further recorded costs
reduce both bases through the same calculation.

### 7.1 Promotion correction (2026-10-23)

The owner explicitly confirmed that the «الترويج» section is paid by the
store, not employees or investors. It never reduces wages, investor profit
or investor principal, even if it exceeds the store's profit for the month.
The v1 fingerprint shape is preserved with an empty promotion slot: affected
old projections differ and the automatic minute recovery posts an offset to
restore the correct entitlement. Unaffected orders remain payable. Original
payments and negative adjustments remain as history; a matching positive
correction restores the balance once, without duplicating it on replay.
Wage preview calculation version 6 invalidates pre-correction previews.
