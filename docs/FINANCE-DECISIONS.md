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
