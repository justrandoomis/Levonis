# LEVO Community V2 — requests, offers, escrow

The custom-work marketplace: a customer describes a job, merchants offer, one
offer wins, and the money is **held** until the work is done.

For stores and the merchant dashboard see `MERCHANT_STORES.md`.
For hostnames see `SUBDOMAIN_ARCHITECTURE.md`.

---

## 1. The flow

```
customer posts a request
   → merchants submit offers          (one live offer each)
   → customer accepts ONE             (atomic; money is HELD, not paid)
   → community order + escrow created
   → merchant works, marks delivered  (this does NOT release money)
   → customer confirms                (this releases it)
   → merchant credited, review unlocked, reputation updated
```

At any live point either side can open a dispute, which **freezes settlement**
until an admin decides.

---

## 2. Request lifecycle

0001 gave `community_requests` only `open | closed`, which cannot express what
actually happens. 0031 adds a real state machine in a new column and keeps
`status` in step as a coarse mirror, so every pre-existing reader stays
truthful.

```
draft → open → receiving_offers → offer_selected → in_progress
                                                 → delivered → completed
                    ↘ cancelled / expired            ↘ disputed → completed|cancelled
```

Transitions are declared as data in `worker/lib/communityStates.ts`. **Absence
is refusal** — there is no "any other transition is probably fine" path.
`completed` and `cancelled` are terminal: reopening one would mean money that
has already settled could move again.

### What the public board shows

The job, and a display name. **Never** a phone, an email or an address, and
that is enforced by the server's `SELECT` list rather than by the frontend
choosing what to render (§24). A merchant learns how to reach the customer when
their offer is accepted, and not before.

---

## 3. Offers

One **live** offer per merchant per request, enforced by a partial unique
index:

```sql
CREATE UNIQUE INDEX idx_community_offers_one_live
  ON community_offers(request_id, merchant_id)
  WHERE state IN ('pending','accepted');
```

Withdrawing frees the slot, so a merchant is not locked out for good.

A merchant may edit an offer **only while it is pending** — `state = 'pending'`
is in the `WHERE` clause of the update, so an accepted offer cannot be edited
even by a request that tries.

**A merchant cannot read a rival's price** on the same request. The offers
query filters to the caller's own unless they are the customer.

---

## 4. Acceptance — the transaction that matters most

Two taps, or two tabs, must not produce two contracts.

```sql
UPDATE community_requests
   SET state='offer_selected', accepted_offer_id=?
 WHERE id=? AND customer_id=? AND state IN ('open','receiving_offers')
```

Whoever wins that conditional update owns the acceptance. A concurrent second
attempt changes **zero rows** and is told the request already has a winner.
Everything after — freezing the offer, rejecting the rest, creating the order —
happens only for the winner.

The database backs it up independently: `community_orders.offer_id` is unique,
so even a route that skipped the guard could not create two orders for one
offer.

### The snapshot

The accepted offer's price, timeline, delivery method and terms are **copied
onto the community order** (§26). Editing the offer afterwards — if it were
even possible — could not change what the merchant owes.

### If funding fails

Everything unwinds: the order is cancelled, the request reopens, every offer
returns to pending. The customer keeps their request, the merchants keep their
offers, and nobody holds a contract that was never paid for.

---

## 5. Escrow

`worker/lib/escrowOps.ts`. One rule shapes the whole file:

> **Money is never a mutable number.** Amounts are written once and never
> updated. A correction is a new append-only event.

### Why a wallet hold, not a debit

Accepting must not *spend* the customer's money — the merchant has not done
anything yet. It must also not leave it spendable, or one balance funds three
acceptances.

`wallet_holds` already solves exactly this for checkout, atomically: the
availability check lives **inside** the INSERT, so two racing acceptances on
one balance cannot both succeed. Reusing it rather than inventing a second
reservation mechanism is the point (§89).

### Currency

Escrow is denominated in **IQD** — what the parties agreed. The wallet holds
USD cents, so the hold is taken at the authoritative rate, rounded **up** so it
never under-reserves, and the rate is snapshot on the escrow event.

### States

```
pending → held → released
              → partially_refunded → refunded
              → disputed → released | refunded
```

A released escrow can **never** return to held.

### Two guards, not one

Every money-moving function has both, because they defend against different
things:

| Guard | Stops |
|---|---|
| UNIQUE idempotency key | a retry — double tap, network retry, resent request |
| Conditional `UPDATE ... WHERE state IN (...)` | a client retrying with a **fresh** key, which idempotency cannot see |

Both are tested (`tests/escrow.test.ts`, 18 tests written as attacks).

### Settlement

| Event | Effect |
|---|---|
| **Release** | hold committed, merchant credited `available`, commission recorded, escrow `released` |
| **Full refund** | hold **released** — nothing was ever spent, so the balance simply becomes available again |
| **Partial refund** | hold committed, refunded part credited back as its own wallet transaction, merchant keeps their share of the rest |

A partial refund is deliberately two visible movements rather than a quietly
shrunk hold — that is what an auditor needs to see.

---

## 6. Delivery and confirmation

**Marking work delivered does NOT release money** (§33). The merchant's own
action asks the customer; only the customer's confirmation releases. A merchant
marking their own work delivered and being paid for it would make escrow
decorative.

Auto-completion is configurable (`communityAutoCompleteDays`, default 7).
**Setting it to 0 disables automatic release entirely**, which is the safe
default for a policy that has not been decided: money then only ever moves when
a human says so.

A delivered order can go **back** to in-progress if the customer says it is not
done. Without that, the only way to reject bad work is a formal dispute, which
is a heavy answer to "you missed a part".

---

## 7. Cancellation

The rule follows the work, not the calendar (§35).

| State | Who may cancel | Refund |
|---|---|---|
| `accepted`, `funded` | customer, merchant, admin | full, automatic |
| `in_progress`, `merchant_marked_delivered` | **admin only** | admin decides |
| `disputed` | **admin only** | admin decides |
| settled | nobody | — |

Before work starts, walking away costs nobody anything. Once it is under way,
one side walking away imposes a real loss on the other, so it becomes a dispute
for an admin rather than a button either party can press.

---

## 8. Disputes

Either party can raise one while an order is live. It creates a complaint **and
freezes the escrow** — which is the entire reason the money was held rather
than paid.

An admin resolves it as `release`, `refund` or `partial_refund`, with a
required reason. Every decision appends escrow events and ledger rows and
**never rewrites amounts**, so an admin can be asked months later exactly what
they decided and on what day, and the answer comes from the data (§45).

---

## 9. Commission

Configurable, and **independent** for the two sale kinds (§30, §75):

| Setting | Default | Applies to |
|---|---|---|
| `communityFeeRequestPercentX100` | `500` (5.00%) | custom-request work |
| `communityFeeStorePercentX100` | `500` (5.00%) | direct store sales |
| `communityFeeMinIqd` | `0` | floor on either |

> **The 5% default is a conservative starting value, not a business decision.**
> The mandate requires the rate to be configurable and gives 10% only as an
> arithmetic example (50,000 → 5,000 → 45,000). **The owner must confirm the
> real rate** in community admin settings.

Percentages are held in **hundredths of a percent** so the split stays integer
arithmetic all the way to the ledger. The fee floors and the merchant keeps the
remainder, so the two parts always sum back to the gross exactly — which the
database requires:

```sql
CHECK (platform_fee_iqd + merchant_receivable_iqd = gross_iqd)
```

A rounding scheme off by one dinar does not produce a slightly wrong invoice;
it fails the insert and kills the customer's accepted offer at the last step.
`tests/merchantOps.test.ts` sweeps amounts and rates against that identity.

Changing the rate applies to **future transactions only** — the admin response
says so explicitly. Every existing order and escrow carries its own snapshot.

---

## 10. Reviews and reputation

A review is a claim about a real transaction, so the right to write one is
**derived from the transaction**, not granted by a form. The eligibility query
*is* the authorisation.

The database backs it up independently — unique indexes allow exactly one
review per order and per community order — so a route written later that forgot
to check still cannot produce a second review for one purchase. Fake reviews
are the failure mode that makes a marketplace's ratings worthless.

Ratings are **recomputed from the rows** on every change, including admin
moderation. A cached aggregate that drifts makes a store look better or worse
than the reviews it actually has (§40).

A merchant may reply **once**, publicly. Hiding a review is an admin moderation
decision, never the reviewed party's.

### Reputation

`merchant_reputation_events` is kept forever. The score is **derived**, so a
merchant can be shown why they have the standing they have, and a mistaken
event is countered by another event rather than by editing a number.

That is why `POST /merchants/:id/reputation` only ever INSERTs. An admin
reversing a wrong `dispute_lost` adds a `+20 admin_adjustment` with a reason;
both rows stay in the log and the derived score returns to where it should be.
There is no update path and no delete path, so the log can still be used as
evidence months later. `tests/adminCommunity.test.ts` asserts the two rows.

Badges (`new | trusted | professional | elite`) need **volume as well as a good
rating** — five stars from two customers is a good start, not a track record.
`elite` additionally requires admin verification, so volume alone cannot buy
it. An admin can pin a badge; a merchant never can (§42).

---

## 11. API surface

### `/api/marketplace/*`
`GET /requests` · `GET /requests/:id` · `POST /requests` · `GET /my-requests` ·
`POST /requests/:id/cancel` · `GET /requests/:id/offers` ·
`POST /requests/:id/offers` · `PATCH /offers/:id` · `POST /offers/:id/withdraw` ·
**`POST /offers/:id/accept`** · `GET /orders` · `GET /orders/:id` ·
`POST /orders/:id/start|delivered|confirm|dispute|cancel`

### `/api/community-reviews/*`
`GET /eligible` · `POST /` · `PATCH /:id` · `POST|DELETE|PATCH /follow/:merchantId` ·
`GET /following`

### `/api/admin/community/*` — apex host only
`GET /overview` · `GET|PATCH /settings` · `GET /merchants` ·
`POST /merchants/:id/verify|status|badge` · `GET /merchants/:id/finance` ·
`POST /merchants/:id/payout` · `GET|POST /merchants/:id/reputation` ·
`POST /stores/:id/status` · `GET /requests` · `GET /requests/:id` ·
`POST /requests/:id/remove` · `POST /offers/:id/reject` · `GET /reviews` ·
`POST /reviews/:id/hide` · `POST /products/:id/hide` · `GET /complaints` ·
`GET /complaints/:id` · `POST /complaints/:id/status` ·
**`POST /escrows/:id/resolve`**

Every one of these has a control in `src/components/adminCommunity/`. The
mandate's rule against buttons that do nothing runs the other way too: an
endpoint an operator cannot reach is a feature that does not exist.

### What an admin sees that a merchant does not

| | Public board | Merchant | Admin |
|---|---|---|---|
| Who posted a request | ✗ | only once their offer wins | ✓ |
| A rival's offer price | ✗ | ✗ | ✓ |
| Attachment file keys | ✗ | ✗ | **✗** |

The last row is not an oversight. R2 keys are never handed to any browser
(§67); an admin sees that three files exist and what they are, and downloads
stream through the Worker after an authorisation check.

### Two sanctions, not one

Suspending a **merchant** stops them trading everywhere and shuts their shop
with them. Suspending a **store** takes the storefront down and leaves the
merchant bidding, fulfilling and answering for the work they already owe.
A bad banner should not cancel someone else's half-finished order.

`paused` is the merchant's own switch and is not reachable from the admin
endpoint at all — if an admin could write it, the merchant re-opening their
shop would silently lift an admin decision (§50). For the same reason a store
cannot be re-opened while its owner is suspended: the two decisions would
contradict each other and the storefront would have to pick a winner.

---

## 12. Financial invariants

Enforced by the database, not only by application code:

1. `platform_fee_iqd + merchant_receivable_iqd = gross_iqd` — on both
   `community_orders` and `community_escrows`
2. `released_iqd + refunded_iqd <= gross_iqd`
3. One escrow per community order (unique)
4. One community order per accepted offer (unique)
5. One review per transaction (two partial unique indexes)
6. One live offer per merchant per request (partial unique index)
7. A cart line names exactly one product source, matching its declared seller
8. Escrow events and payout rows are **append-only** — no update path exists
9. A merchant balance is a `SUM`; there is no balance column anywhere
10. IQD is an integer everywhere; no money value touches floating point

---

## 13. Open owner decisions

| Item | Why it is not code |
|---|---|
| **Commission rate** | Seeded at 5%; the real rate is a business decision |
| **Auto-completion window** | Seeded at 7 days; 0 disables it entirely |
| **Minimum fee** | Seeded at 0 |
| BNPL for community orders | Eligibility, ceilings and default handling are unresolved (`DECISIONS.md` row 21) |
| External custom domains | Needs Cloudflare for SaaS, a per-hostname cost (row 12) |

Each is a setting with a documented default, not an invented rule.
