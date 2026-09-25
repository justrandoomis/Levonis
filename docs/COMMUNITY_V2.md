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
draft → expired   (an abandoned draft, by the sweep — W5-A)
```

Transitions are declared as data in `worker/lib/communityStates.ts`. **Absence
is refusal** — there is no "any other transition is probably fine" path.
`completed` and `cancelled` are terminal: reopening one would mean money that
has already settled could move again.

**`draft` is real (wave 1).** `POST /api/marketplace/requests` creates a
**draft** — invisible to everyone but its customer and not biddable — and
publishing (`POST /api/marketplace/print/requests/:id/publish`) is the one move
to `open`; it runs the matching ONCE and starts the expiry clock (a re-publish
that changes nothing merchants priced answers `replayed: true` and matches
nobody). «إعادة الطلب» creates a DRAFT the customer reviews and publishes the
same way (W5-A). A draft untouched for 14 days expires in the sweep. A change to
what merchants priced **after the first offer** moves the request's `revision`,
records the new revision (`community_request_revisions`, migration 0130) and
makes standing offers **`superseded`** in the same batch (not acceptable —
`OFFER_STALE` — until their merchant re-confirms or edits them; they are told
and can read what changed); a change nobody priced rewrites the current
revision in place. **Expiry is a state**: a request
past `expires_at` takes no offers and no acceptance, is not served to strangers,
and a scheduled sweep moves it (and its pending offers) to `expired`. The
customer cancels a request only while it is a draft or taking offers — once a
paid order exists the answer is `REQUEST_HAS_ORDER` (cancel the order, or
dispute). (`docs/merchant-platform/audit/03` §10 E, I, J, K; migration 0116.)

### What the public board shows

The job, and a display name. **Never** a phone, an email or an address, and
that is enforced by the server's `SELECT` list rather than by the frontend
choosing what to render (§24). A merchant learns how to reach the customer when
their offer is accepted, and not before: the acceptance batch writes the
order's `contact_snapshot` (the customer's name, phone and chosen delivery
address — name and phone only for a pickup — for the merchant; the store's
phone for the customer), and `GET /api/marketplace/orders/:id` returns each side
only the OTHER side's contact, with the request's conversation one tap away
(W5-A, `docs/PRINT_REQUESTS.md` §5).

---

## 2b. Attachments

A "make me this" request without the thing to make is half a request, so a
customer attaches reference photos, a drawing, or the model itself:
**JPEG, PNG, WebP, GIF, PDF, STL, 3MF, OBJ**. Six files, 8 MB for a picture
and 40 MB for a model.

### A declared type is a claim, not a fact

`worker/lib/attachments.ts`. `file.type` comes from the browser and the
extension comes from whoever named the file, so neither decides anything.
Every format is recognised from its **bytes**, or accepted only after a
structural check a wrong file would fail:

| Format | What proves it |
|---|---|
| Images, PDF | magic bytes |
| 3MF | ZIP magic **and** the name agreeing — a `.docx` is also a ZIP |
| Binary STL | `84 + 50 × triangleCount == fileSize`; a renamed `.exe` cannot satisfy that identity |
| ASCII STL, OBJ | valid UTF-8 whose first meaningful line is the token the format requires |

Nothing but an image is ever served inline, and even an image comes back with
`nosniff` and a sandbox CSP — so a file that somehow passed every check still
cannot run as script. `tests/attachments.test.ts` is written as forgery
attempts.

### The key never leaves the server

Attachments are stored under `requests/<user id>/`, a prefix `/files/*`
refuses outright, so there is no URL to guess and no bucket to walk. Every
read goes through `GET /requests/:id/files/:fileId`, which **re-derives** the
caller's right on every request rather than baking it into a link:

| Who | May read |
|---|---|
| The customer | always |
| Any signed-in caller | while the request is **on the board** — public, taking offers and **not expired** — and Levo Community lets them in (otherwise `503 COMMUNITY_CLOSED`, as the board answers); a merchant cannot quote a model they may not look at |
| The engaged merchant | after acceptance, for as long as the order lives |
| An admin | always, for moderation |
| Anyone else | 404 |

The **3D preview link** (`/model-viewer/{token}`) is narrower still: minted only
by the customer, the engaged merchant, or a merchant who could make an offer on
the board request right now; it lives one hour (server-fixed), carries no file
name, and is revoked when the request closes and, for the losing merchants, at
acceptance (`docs/PRINT_REQUESTS.md` §5).

When the request closes, the general permission closes with it, so a link
shared earlier simply stops working. `tests/requestFiles.test.ts` asserts the
key appears in **no** response body.

### Adding and removing stops when quoting stops

A merchant priced against these files. Changing them once the request has
left `open`/`receiving_offers` would change the job under a signed contract,
so the API refuses it and the UI does not offer the control.

The row is written **after** the object lands and deleted **before** it, so
the worst failure is an orphaned object that costs storage — never a row
pointing at nothing.

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
even by a request that tries. **Every edit is a new version** (`revision + 1`,
audited with what it replaced): the customer accepts the version they saw or
nothing. The advertised `offer_count` is recomputed from the live offers
(pending + accepted) in the same batch as every change, never incremented.

**A merchant cannot read a rival's price** on the same request. The offers
query filters to the caller's own unless they are the customer.

---

## 4. Acceptance — the transaction that matters most

Two taps, or two tabs, must not produce two contracts.

```sql
UPDATE community_requests
   SET state='in_progress', accepted_offer_id=?, community_order_id=?
 WHERE id=? AND customer_id=? AND state IN ('open','receiving_offers')
   AND revision=? AND (expires_at IS NULL OR expires_at > now)
```

Whoever wins that conditional update owns the acceptance. **Since wave 1 the
money is reserved first** (a wallet hold, nothing else written — a customer who
cannot pay has nothing to undo), and then the request's move, the freeze of the
**exact offer version the customer confirmed** (`expected_price_iqd` +
`offer_revision`; otherwise `409 OFFER_CHANGED` with the fresh offer), the
rivals' rejection, the order (born `funded`) and its escrow are ONE fenced
batch: a guard that matched nothing aborts all of it and the hold is released.
A crash between the reservation and the batch leaves only a hold, which the
community reconciliation sweep releases. `offer_selected` is no longer written
by acceptance; the sweep reopens requests the pre-wave-1 flow stranded there.

The database backs it up independently: one **live** community order per offer
(`idx_community_orders_offer_live`, migration 0116 — a cancelled attempt no
longer locks the offer for ever, which is what made a retry after topping up
fail with a 500).

### The snapshot

The accepted offer's price, timeline, delivery method and terms are **copied
onto the community order** (§26). Editing the offer afterwards — if it were
even possible — could not change what the merchant owes.

### If funding fails

Nothing was written, so nothing unwinds: the customer is told
`INSUFFICIENT_FUNDS` before the request, the offers or any order move. The
customer keeps their request, the merchants keep their offers, and nobody holds
a contract that was never paid for.

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
a human says so. The date is fixed when the merchant marks the work delivered
(`auto_complete_at`) and **a scheduled sweep honours it** (wave 1 — until then
nothing read it): a delivered, undisputed order past its date is released
through the same `releaseEscrow` and the same idempotency key as the customer's
own confirmation, so the two can never pay twice between them. Completion is
counted once (`completed_orders`, +10 reputation) however many confirmations
race. Both the confirmation and the sweep release only while the order is
still `merchant_marked_delivered` — asked inside the settlement batch, so a
dispute filed a moment earlier wins (review F1) — and the sweep reads only
orders whose escrow it can settle, counting the rest (review F3).

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

The refund and the cancellation are **one batch**, conditional on the order
still being `accepted`/`funded` (review F2): a cancel that loses to the
merchant's «ابدأ العمل» moves nothing and answers 409 `ORDER_CHANGED`, and the
merchant can start only on an escrow that is still `held` (409
`ESCROW_NOT_HELD` otherwise). A cancel that an older build left half-done — the
escrow refunded, the order still `funded` — is finished by the customer's
retry, with no money moving.

---

## 8. Disputes

Either party can raise one while an order is live. It creates a complaint **and
freezes the escrow** — which is the entire reason the money was held rather
than paid.

An admin resolves it as `release`, `refund` or `partial_refund`, with a
required reason. Every decision appends escrow events and ledger rows and
**never rewrites amounts**, so an admin can be asked months later exactly what
they decided and on what day, and the answer comes from the data (§45).

A disputed escrow is settled **only by an admin** (review F1): the system, the
customer and the merchant settle a `held` escrow and nothing else, and a fence
aborts any settlement whose escrow did not move in that same batch.

Wave 1: only a **disputed** escrow is decided (`ESCROW_NOT_DISPUTED` otherwise);
a repeated decision is a replay whose consequences apply once — one dispute
outcome on the merchant's reputation, the order out of `disputed`, the request
to `completed` (merchant paid, fully or in part) or `cancelled` (full refund),
and the complaint resolved. The dispute itself now freezes the escrow FIRST and
refuses (`ORDER_SETTLED`) when it was already settled. An admin cannot remove a
request with a live order or escrow (`REQUEST_HAS_ESCROW`).

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

**Nobody reviews their own shop.** The store's owner — by the merchant's user or
the store's — is `403 SELF_REVIEW`, and their own orders are never offered to
them as reviewable (audit 04 #3 / B11, audit 02 B17; the buying half, a merchant
ordering from their own store, is refused at the cart).

**An edit moves the score by the difference.** Editing a review appends a
`review_edited` event worth the change — 5★ → 1★ is −20 after the original +10 —
so the log always sums to what the review now says; editing only the text moves
nothing (audit 04 #16). Review pictures are the reviewer's own uploads, at most
six, or nothing (#17). A public store review names its author the way a platform
review does — «Ahmed K.» (#15).

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
it. An admin can pin a badge; a merchant never can (§42). A badge earned by
completed orders — with no review event to recompute it — is written by the
scheduled sweep `refreshStaleMerchantBadges` (worker/lib/jobs.ts, audit 04 #24).

---

## 11. API surface

### `/api/marketplace/*`
`GET /requests` · `GET /requests/:id` · `POST /requests` · `GET /my-requests` ·
`POST /requests/:id/cancel` ·
`POST|GET|DELETE /requests/:id/files[/:fileId]` · `GET /requests/:id/offers` ·
`POST /requests/:id/offers` · `PATCH /offers/:id` · `POST /offers/:id/reconfirm` ·
`POST /offers/:id/withdraw` · **`POST /offers/:id/accept`** · `GET /orders` ·
`GET /orders/:id` · `POST /orders/:id/start|delivered|confirm|dispute|cancel` ·
`GET /complaints` · `GET /complaints/:id` · `POST /complaints/:id/messages`

Making, editing and re-confirming an offer pass `requireOfferPrivileges`
(worker/lib/merchantAuth.ts): a `restricted` merchant is
`403 MERCHANT_RESTRICTED`, each other sanction its own code, and withdrawing is
never refused. A standing offer from a merchant Levonis has restricted or
suspended since — or whose store it suspended — cannot be accepted
(`409 MERCHANT_UNAVAILABLE`).

The community page's own doors (`/api/community/requests`) take the same road:
a request is created as a draft and published by `publishRequest`, the one door
onto the board; its list shows exactly what the board shows; and
`POST /api/community/requests/:id/close` answers `307` to
`/api/marketplace/requests/:id/cancel`.

### `/api/community-reviews/*`
`GET /eligible` · `POST /` · `PATCH /:id` · `POST|DELETE|PATCH /follow/:merchantId` ·
`GET /following`

### `/api/admin/community/*` — apex host only
`GET /overview` · `GET|PATCH /settings` · `GET|PUT /gate` · `GET /gate/lookup` ·
`GET /merchants` · `POST /merchants/:id/verify|status|badge` ·
`GET /merchants/:id/finance` · `POST /merchants/:id/payout` · `POST /merchants/:id/adjustment` ·
`GET /payouts?state=` · `POST /payouts/:id/approve|paid|fail` · `GET /ledger/parity` (W2-B) ·
`GET|POST /merchants/:id/reputation` · `GET /merchants/:id/products` ·
`POST /stores/:id/status` · `GET /requests` · `GET /requests/:id` ·
`POST /requests/:id/remove` · `POST /offers/:id/reject` · `GET /reviews` ·
`POST /reviews/:id/hide` · `POST /products/:id/hide {hidden, reason}` ·
`GET /complaints` · `GET /complaints/:id` · `POST /complaints/:id/status` ·
`POST /complaints/:id/messages` · **`POST /escrows/:id/resolve`**

Every one of these has a control in `src/components/adminCommunity/` — the
product hide included, in a merchant's detail («منتجات التاجر»), with the
required reason the merchant is shown. The mandate's rule against buttons that
do nothing runs the other way too: an endpoint an operator cannot reach is a
feature that does not exist.

**Money needs the financial scope** (audit 04 #2). `PATCH /settings` (the
commission), `GET /merchants/:id/finance`, `POST /merchants/:id/payout`, the
payout queue and its decisions, adjustments, the ledger parity report and
`POST /escrows/:id/resolve` carry `requireFinancialScope` in their route
declarations — the same rule as `walletAdjust.ts` — so an assistant-scope admin
gets `403 FINANCIAL_SCOPE_REQUIRED`, and the overview leaves the fee figures out
for them. `tests/communityMoneyScope.test.ts` walks the router so a new money
route cannot land without the guard.

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

The merchant and the store are two rows and each admin route writes only its
own (audit 04 #6). Suspending a **merchant** stops them trading everywhere and
shuts their shop with them — by being read, not by writing the store row: every
public reader asks `storeIsSuspended` (the store's own suspension OR its
merchant's). Restoring the merchant therefore brings back exactly the store
they had: open, paused by its merchant, or suspended on its own account.
Suspending a **store** takes the storefront down and stops new commitments made
in its name — store orders and offers (`STORE_SUSPENDED`) — while the merchant
goes on fulfilling and answering for the work they already owe. A bad banner
should not cancel someone else's half-finished order. **Restricting** a merchant
is the sanction short of either: the shop stays up and editable, but it takes no
new orders or offers (MERCHANT_STORES.md §4).

**A suspended store is an unavailable page** (owner decision, 2026-09-24). A
customer on a store suspended either way sees only «المتجر غير متاح حاليًا» and a
way back to Levonis and to their own orders: `/api/storefront/*` serves none of
its products, banner, bio or reviews (`404 STORE_UNAVAILABLE`), the web manifest
falls back to the platform's name and icon, the share card, the sitemap and the
community listings drop it, and `/api/community/store/:id` answers the same.
Nothing is deleted; lifting the suspension brings the page back as it was.

`paused` is the merchant's own switch and is not reachable from the admin
endpoint at all — if an admin could write it, the merchant re-opening their
shop would silently lift an admin decision (§50). For the same reason a store
cannot be re-opened while its owner is suspended (`MERCHANT_SUSPENDED` on
`open`): the two decisions would contradict each other and the storefront would
have to pick a winner.

### Staff never join a private thread

A store order's conversation is between the customer and the seller — both are
participants from the moment it opens, and each customer message notifies the
seller (audit 04 #4). An admin who opens it from an order **reads it read-only**
(audit 04 #11 — the option chosen of the two the brief offered, docs/DECISIONS.md):
they are not added as a participant, every write — a message, «يكتب…», a file —
is `403 CHAT_READ_ONLY` (one rule, `assertMayWriteInThread`; review S3), staff rows
an older build had added were removed by migration 0119, the thread
answers `read_only: true`, and each reading — of the messages or of a file sent in
the thread — writes an `admin.chat_read` audit row (at most one per admin, thread
and hour). A visible «انضم فريق الدعم» message was
the alternative; reading for an investigation should not have to announce
itself to both parties, and the silent JOIN — the defect — is gone either way.

---

## 12. Financial invariants

Enforced by the database, not only by application code:

1. `platform_fee_iqd + merchant_receivable_iqd = gross_iqd` — on both
   `community_orders` and `community_escrows`
2. `released_iqd + refunded_iqd <= gross_iqd`
3. One escrow per community order (unique)
4. One LIVE community order per offer (partial unique, migration 0116)
5. One review per transaction (two partial unique indexes)
6. One live offer per merchant per request (partial unique index)
7. A cart line names exactly one product source, matching its declared seller —
   and one user's cart holds ONE seller (triggers, migration 0114)
8. Escrow events and payout rows are **append-only** — no update path exists
9. A merchant balance is a `SUM`; there is no balance column anywhere.
   `available` counts available rows AND payouts (a payout lowers it, and the
   payout insert is conditional on it); `paid out` counts payouts only, never
   commission rows (`merchantBalance`, worker/lib/escrowOps.ts)
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
