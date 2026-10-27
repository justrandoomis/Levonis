# Levonis Print Cloud — backend

Remote rental of the workshop's 3D printers (cloud.levonis-iq.com): customers
buy prepaid printing hours per printer class and filament by the gram, upload
models, build projects and plates, and send jobs to real machines in the
workshop; operators run the queue; finished prints and unused material are
picked up, delivered or sold back.

This document covers the BACKEND as built: data model, guarantees, flows, API,
roles, adapters, configuration, tests, deployment, and an honest list of what is
implemented and what is not connected yet. The customer and admin interfaces
are **not built** (Phase 9 of the specification is postponed); every screen the
specification describes has its data API here.

DECISIONS row 271 records the decision and its open owner questions.

---

## 1. Status, shape and API

| | |
|---|---|
| Migration | `migrations/0215_print_cloud.sql` — 70 `pc_*` tables, triggers and indexes; touches no existing table |
| Library | `worker/lib/printCloud/*.ts` (one module per domain, listed per section below) |
| Routers | `worker/routes/printCloud.ts` (customer), `printCloudAgent.ts` (workshop agent), `printCloudAdmin.ts` (administration) |
| Mounts | `/api/print-cloud/v1`, `/api/print-cloud/v1/agent`, `/api/admin/print-cloud` (`worker/index.ts`) |
| Hosts | the main host, the `cloud` system subdomain, and foreign hosts outside the root; **never** a merchant storefront (`printCloudHostAllowed`, `worker/lib/printCloud/http.ts`) |
| OpenAPI | `GET /api/print-cloud/v1/openapi.json` — generated from `worker/lib/printCloud/openapi.ts`; 156 operations, and `tests/printCloudOpenApi.test.ts` fails if a route and its documentation disagree. Owner-only cost fields are described in the owner's copy only |
| Default state | **closed**: `pc_settings.enabled = false`, customer doors answer `503 PRINT_CLOUD_DISABLED` (admins still work) until the owner opens the service |
| Without the migration | reads see an empty, closed service (lists empty, a named record 404, `GET /status` says `installed: false`) — exactly the answers of a migrated database with no data; every write answers `503 PRINT_CLOUD_NOT_INSTALLED` before any statement; the cron step does nothing (`tests/costDeployAhead.test.ts`) |

Response envelope: `{ "success": true, "data": … }`. A refusal is the
platform's `HttpError` with a stable `code` and `details.messages` in Arabic,
English and Sorani (`worker/lib/printCloud/errors.ts`; a Sorani string is never
the Arabic one — `tests/printCloudUnits.test.ts`).

Idempotency: every door that moves money, hours or grams on the customer's
behalf (`POST /orders`, `POST /orders/:id/pay/wallet`, `POST /jobs/:id/confirm`,
`POST /shipments`, `POST /me/credits/convert`, `POST /buybacks`, admin balance
adjustments and refunds) takes an `Idempotency-Key` header — required: without
one the door refuses `IDEMPOTENCY_KEY_REQUIRED` and writes nothing. The first answer is stored in
`pc_operations` in the SAME batch as the business writes; a replay returns it,
and the same key with a different request body is refused
`IDEMPOTENCY_KEY_REUSED`.

### 1.1 Customer API (`/api/print-cloud/v1`)

Public: `GET /status`, `/printers`, `/printers/{id}`, `/printers/{id}/availability`,
`/packages`, `/store/categories`, `/store/products`, `/units`,
`POST /pricing/quote`, `POST /payments/webhook` (signed, §4.4).

Signed-in customer: `/me/dashboard`, `/me/credits` (+ `/ledger`,
`/reservations`, `/conversions`, `POST /convert`, `POST /convert/quote` — §3.4),
`/me/printers`, `/me/inventory` (+ `/ledger`, `PATCH /{variantId}/alert`,
`POST /top-up-quote`, `/reorder-suggestions` — §5.1), `/me/transactions`,
`/me/wallet` (§4.4); quotes and orders (`POST /quotes`,
`POST /orders`, `POST /orders/{id}/cancel`, `POST /orders/{id}/pay/wallet`
(§4.4), `POST /orders/{id}/dev-pay` — development only);
files (`POST /files`, list, read, delete, download, signed links); imports;
projects (create, update, duplicate, models, plates, accessory suggestions,
printer recommendations); print profiles; jobs (`POST /jobs`, `PATCH`,
`/analyze`, `/projection`, `/review`, `/confirm`, `/cancel`, `/requests`,
`/reschedule`); `GET /queue`; shipments (`POST /shipments`, `POST /shipments/quote`,
list, detail, cancel — §8.1); buybacks (§8.2).

The two ledgers (`/me/credits/ledger`, `/me/inventory/ledger`) are newest
first and paged EXACTLY on the last row's (`created_at`, `id`): the next page
is `before=<its created_at>&before_id=<its id>` (`reports.ts ledgerCursor`).
One batch writes several rows at one instant (a payment's purchases, a
settlement's consume and release), so a page that ended inside that instant
on the time alone skipped the rest of it. `before` alone keeps its old
meaning — strictly before that instant — and `before_id` without `before` is
refused `VALIDATION`. `/me/transactions` has its own exact cursor
(`next_before`, §10.1); no other Print Cloud list pages — the rest, customer
and admin, are capped lists (the newest N), and the agent's `GET /commands`
pages forward by `since` with the agent reading one millisecond back and
dropping ids it has seen (`tools/print-cloud-agent`).

### 1.2 Agent API (`/api/print-cloud/v1/agent`) — §9

### 1.3 Admin API (`/api/admin/print-cloud`) — §10.2

The complete list, with access class and schemas, is the OpenAPI document.

---

## 2. Catalogue — `catalog.ts`

Owner-managed rows, all through `POST/PATCH /api/admin/print-cloud/catalog/{entity}`:

- **Credit tiers** (`pc_credit_tiers`): a printing-hour class with its hourly
  price (integer IQD). Hours of one tier only run printers of that tier.
- **Printer models** (`pc_printer_models`): specification, build volume, colour
  count, materials, nozzle; each belongs to a tier.
- **Printers** (`pc_printers`): physical machines with status, location,
  adapter (`manual` | `agent`), nozzle, loaded materials and an opaque
  `connection_ref`. Acquisition and upkeep costs are owner-only fields.
- **Credit packages** (`pc_credit_packages`): hours of one tier for a price,
  limits, optional bundled material/accessories, optional expiry (§3.2).
- **Products and variants** (`pc_products`, `pc_variants`): filaments,
  accessories, magnets, rings, glue, tools… in twelve seeded categories. Every
  variant has ONE unit (`g`, `kg`, `pc`, `set`, `mm`, `m` — `pc_units`), a
  min/step/max quantity and the fulfilment modes it allows.
- **Price tiers** (`pc_price_tiers`): `pack` rows (exact quantity → price) and
  `bracket` rows (from-quantity → unit price in milli-IQD).
- **Promotions**, **warehouse locations**, **accessory rules**, **conversion rules**.

Every price edit writes a `pc_price_changes` row (who, before, after). A
price is also every term that decides what a customer pays — a promotion's or
a package's switch, window and limits, a tier's switch, a printer model's tier,
a machine moved to a model of another tier, a machine registered at all — so
each needs money scope. A
catalogue answer leaves through `stripCost` unless the caller is the owner.

## 3. Printing-hour credits — `credits.ts`

### 3.1 The account

Per customer and tier: `pc_credit_accounts` holds three cached numbers in
**integer seconds** — `available`, `reserved`, `used` — and named CHECK
constraints keep each non-negative. Every change is an append-only
`pc_credit_ledger` row with a unique `entry_key` naming the business event (an
order line, a job, a refund), so a replayed event cannot apply twice. Credits
arrive as **lots** (`pc_credit_lots`) carrying what was paid; spending draws
lots FIFO (`pc_credit_lot_draws`) with cumulative valuation, so the dinars
recognised for a lot always sum to exactly what was paid for it (`lots.ts`).

**Holds are recorded per lot.** A reservation names the lots it holds and how
many seconds of each (`pc_credit_reservation_lots`, append-only), and each lot
carries the seconds held on it (`seconds_held`, kept between 0 and what the
lot has left by the named CHECK `ck_pc_credit_lot_held` — a race on the same
hours aborts the batch and re-plans). A lot's **free part** is
`seconds_remaining − seconds_held`; only free parts are ever debited,
converted or expired. Always, and proven by reconciliation (§11):

    available = Σ free parts of the account's lots
    reserved  = Σ seconds held on them = Σ the active reservations' hold rows

so which hours a job holds is a record, never inferred from an order of lots.
A reservation gives its holds back — a cancellation, a release, a settlement —
in **one** statement however many lots they are on: a single `UPDATE` takes
each lot's own hold row off it (`unholdAll`), in the batch whose flip of the
reservation is fenced, a fence that also proves the hold rows sum to what the
account moves. A release is five statements and no read, for one lot or a
hundred.

### 3.2 Expiry

Credits never expire. An administrator may set `expires_after_days` on a
package; the package then states it to the customer before purchase. Once a
lot's expiry has come:

- **nobody new holds it.** A confirmation holds only lots not yet expired, so
  a job confirmed after the expiry — before the sweep came by — holds only
  good hours, and is refused `INSUFFICIENT_CREDIT` when they fall short, even
  while the available balance still counts the unswept expired seconds;
- **no debit draws it**: a refund, an admin debit and a conversion take only
  free parts of lots not yet expired, and a credit line whose lot has expired
  refunds nothing;
- **the `expire_credit_lots` task takes its free part** — less what a free
  reprint still waiting for its confirmation is entitled to there (below) —
  with its own ledger rows. The task's page holds only lots that have
  something to expire (the filter is per lot), so lots wholly held for jobs,
  or wholly owed to a pending reprint, never crowd out the ones that can
  expire. Each pass is fenced on the lot's remainder and holds, and on the
  pending reprints' entitlement there not having grown, and keyed by what the
  lot had left, so a lot may expire in several passes.

Hours a job came to hold before the expiry stay that job's: it prints from
them, and what it gives back (a cancellation, a settlement under the
estimate) is free and expires on the next run. The one exception is a **free reprint after a
workshop failure**: it inherits what its failed parent held and gave back,
lot by lot, taken first even past the expiry — and only that much — so the
customer loses no hour to the workshop's failure. The failure's resolution
gives the parent's holds back and the reprint's confirmation holds them again:
two batches, and the sweep may run between them. So the entitlement is
derived from records, not from timing — the parent's hold rows less what its
settlement consumed, for a reprint its failure names
(`pc_failures.reprint_job_id`, resolved as the workshop's) and that names it
(`pc_print_jobs.parent_job_id`) — and **while that reprint is not yet
confirmed** (`ready` or `awaiting_confirmation`) the sweep leaves those seconds
on their lots: a sweep racing the automatic confirmation, or running while
the reprint waits for the customer, takes none of them. Whoever confirms it —
the system on the customer's behalf, or the customer by hand — holds them.
Once the reprint is confirmed (it then holds them, and gives back like any
job) or cancelled, normal expiry resumes. Converted hours keep the expiry
they were bought under. A lot that fails to expire fails the task (retried,
its error visible in `GET /admin/print-cloud/tasks`).

### 3.3 Reservation and settlement

`POST /jobs/{id}/confirm` reserves the estimated seconds (a job without an
estimate cannot be confirmed), holding them on lots in spend order — expiring
first, then oldest. At settlement the actual seconds are consumed from the
lots the reservation held, in the order it took them, and the rest of each
hold is released, in one batch:

    24 h bought → 8.9 h reserved → 8.5 h used → 15.5 h available, 0.4 h released

Overage (actual > reserved) follows `time_overage_policy`: `cap_at_reserved`
(default — the customer is never billed beyond what they approved) or
`charge_from_balance` (only from free hours not yet expired, never negative).

### 3.4 Conversion

Moving hours between tiers is **off** until the owner enables a conversion rule
(`pc_credit_conversion_rules.enabled`, default 0). A conversion moves the value
of the drawn lots with the hours.

The customer sees what is allowed before asking: `GET /me/credits/conversions`
lists every ENABLED rule out of a class they hold an account in, with its
ratio (`to = floor(from × ratio_num / ratio_den)`) and both classes' names —
exactly the rules `conversionRule` accepts. `POST /me/credits/convert/quote`
takes the conversion's own body and answers the conversion's own plan
(`credits.ts planConversion`, the one `convertCredits` writes): the seconds
received, the purchase lots the hours would come from (free hours not past
their expiry, expiring first) and the lots they would arrive as, one per
expiry, each keeping its date. Same refusals (`CONVERSION_DISABLED`,
`INSUFFICIENT_CREDIT`, `QUANTITY_NOT_ALLOWED`, `VALIDATION`); nothing is
written or held — the conversion plans again at its own moment.

## 4. Pricing, quotes, orders and payments — `pricing.ts`, `orders.ts`, `payments.ts`

### 4.1 Material pricing

Integer dinars only. An exact pack quantity costs the pack price. A custom
quantity is priced by its bracket (milli-IQD per unit), rounded UP to
`material_price_rounding_iqd` (250), and — with `cap_custom_price_at_next_pack`
— never above the next pack that covers it (490 g costs no more than the
500 g pack). `POST /me/inventory/top-up-quote` prices «top up to N» as a new
purchase of the missing quantity (490 g owned → top up to 1 kg = 510 g bought).

### 4.2 Quotes

`POST /quotes` freezes priced lines, promotions and totals under a quote id
that expires after `quote_ttl_minutes`. An order is made only from a live
quote; the price a customer approved is the price they pay.

### 4.3 Orders and stock holds

`POST /orders` (idempotent) creates the order, its lines and a **stock hold**
for every physical line in one batch. The hold is fenced against the shelf
(`notOversoldFence`): two customers buying the last 100 g at the same moment get
one hold and one `OUT_OF_STOCK`, never an oversold shelf. Unpaid orders expire
after `stock_hold_minutes` (task `expire_orders`) and their holds return once.
Per-customer limits and promotion redemptions are fenced in the same batch.

### 4.4 Payments

Every confirmation goes through ONE function, `confirmPayment`: an event is
recorded once per `(provider, event id)` and an order is fulfilled once, whatever
arrives (duplicate webhook, a second event for a paid order, an amount
mismatch — each has its own recorded outcome). Fulfilment grants credit lots,
inventory lots and bundles, converts holds into allocations, creates a delivery
shipment when asked, notifies the customer and queues integration events — in
the same batch as the payment row.

| Adapter | State |
|---|---|
| `manual` | always on: a full admin records a cash or transfer receipt (`POST /admin/print-cloud/orders/{id}/confirm-payment`, audited) |
| `gateway` | on only when `PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET` (≥ 32 chars) is set. `POST /payments/webhook` with `X-PrintCloud-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`, five-minute window, body `{event_id, order_id, amount_iqd, status:"succeeded"}`. **No processor is contracted**; this is the tested contract one must meet |
| `dev` | development only: `PRINT_CLOUD_DEV_PAYMENTS=on` lets a customer pay their own order; labelled provider `dev`. Never set it on a deployed Worker |
| `levonis_wallet` | **connected**: the customer pays from their own Levonis wallet (`POST /orders/{id}/pay/wallet`, below). On unless a money-scope admin sets `wallet_payment_enabled: false` (§13.2), which answers `503 PAYMENT_ADAPTER_DISABLED` |

Refunds (`POST /admin/print-cloud/orders/{id}/refunds`, idempotent) return only
the unused hours and grams of that purchase's own lots — for hours, the lot's
free part (never seconds a job holds), and nothing once it has expired. The
money goes back the way it came: an order paid from the Levonis wallet is
credited back to the wallet in the refund's own batch (below); a manual,
gateway or development payment's refund is recorded for the money desk under
its `method` (`manual` when left out) — the money returns outside the system.

#### The Levonis wallet — `wallet.ts`

`GET /me/wallet` → `{ connected, available_iqd, exchange_rate }`: `connected`
is false only while the owner has switched wallet payments off;
`available_iqd` is the SAME figure the Levonis wallet page prints
(`walletIqdAvailable` over the spendable cents — settled minus active holds,
so a pending withdrawal's money is not spendable — and the dinar remainders
recorded by migration 0108); `exchange_rate` is the platform's one official
IQD per USD (`fx/officialRate.ts`). It reads platform tables only, so it
answers on a database without 0215 too (from the default settings).

`POST /orders/{id}/pay/wallet` (own order, `Idempotency-Key`, body `{}`) pays
the order's whole `total_iqd` in ONE D1 batch: the `pc_operations` row of the
key, the wallet debit, then everything `confirmPayment` writes (the payment
event `wallet:<order>`, the order's fenced flip to fulfilled, the confirmed
payment, the grants, the stock allocations, the shipment, the notice, the
outbox and the audit) — the money moves exactly when the order is confirmed,
or not at all. 201 `{ order_id, status: "paid", provider: "levonis_wallet",
amount_iqd, charged_usd_cents, exchange_rate, wallet_tx_id }`; a replay of the
key returns the first answer (200, `replayed: true`). Any awaiting order of
the customer's may be paid this way; the order then records `levonis_wallet`
as its payment method.

- **Asked in dinars first.** A total above the wallet page's figure is refused
  `402 INSUFFICIENT_BALANCE { available_iqd, required_iqd }` before anything is
  written (a refusal is not stored: top up and retry with the same key).
- **Charged in cents by the platform's rules.** `walletSpendCents` floors the
  total and caps it at the cents on hand, at least one cent: `CHECK (amount >
  0)` forbids a zero debit, so a total under one cent's worth is charged one
  cent (as the membership purchase is). The debit is the platform's one
  conditional spend (`usdSpendStatement`, `wtx_pc_<order>`, ref = the order,
  `created_by = 'system'`), recording the total's dinars and the rate when the
  ledger has 0108's columns — so the wallet page falls by the total (by the
  cents' worth when the wallet's deposits recorded too few remainders to carry
  the debit's own; never by more than the total).
- **A zero total** is confirmed with no debit (nothing to collect), as
  `confirmPayment` confirms a zero amount for any adapter.
- **Exactly one payment, at most one debit.** Two wallet payments with
  different keys collide on the debit's primary key and the event's unique
  key; a manual receipt or a gateway webhook that lands first takes the
  order's state and the wallet batch fails its fence (a receipt that lands
  second is recorded `duplicate_order` for the refund desk). A batch the
  database refused is classified from the facts read again —
  `409 ORDER_NOT_PAYABLE` (paid, cancelled, expired — also past the order's
  own deadline before the sweep ran — or a delivery fee whose shipment no
  longer waits), else `402 INSUFFICIENT_BALANCE`, else re-planned (twice),
  then the database's own refusal or `409 STATE_CHANGED`. An outage is a 500,
  never a refusal. Nothing is charged in any refused case.
- **Refunds** of a wallet-paid order credit the wallet in the refund's batch:
  an approved deposit `wtx_pc_<refund id>` (ref = the order,
  `created_by = 'admin'`) recording the refund's dinars at the debit's rate;
  the refund row is `paid_out`. The cents are CUMULATIVE — after refunds
  totalling R of the P dinars paid, the wallet has had back floor(D × R / P)
  of the D cents debited — so the refunded cents never exceed the debit (also
  fenced in the batch), the whole paid amount, in one refund or many, returns
  exactly D, and the refund batch's fence on the order's refunded total keeps
  two refunds from crediting the same step. One full refund mirrors the debit
  to the dinar; refunds in parts may leave the page up to 13 IQD (one cent's
  worth) per refund above the pre-order figure, never below, because a row's
  cents worth more than its dinars record no negative remainder. A refund
  worth under one cent is refused `VALIDATION below_one_cent` with
  `min_amount_iqd`. `method` may be left out or `levonis_wallet` for a
  wallet-paid order; another method is refused (`order_paid_from_wallet` —
  cash as well would refund it twice), and `levonis_wallet` for any other
  order is refused (`order_not_paid_from_wallet` — it would mint money).
  Switching wallet payments off never strands money: refunds still go to the
  wallet.

## 5. Inventory — `inventory.ts`, `warehouse.ts`

### 5.1 What customers own

`pc_inventory_accounts` per customer and variant (`available`, `reserved`,
`consumed`, `delivered`, `sold_back`), in the variant's own unit — grams are
never added to pieces. Lots carry their purchase price; ledgers are append-only
with unique entry keys; jobs reserve and settle each material independently
(20 magnets owned, a job uses 2 → 18 left). Low-inventory reminders use the
customer's threshold or `low_inventory_default_g`, which applies to balances
in grams only (`inventory.ts lowStockDefaultQty`) — no gram figure is ever
applied to pieces.

Every `GET /me/inventory` row (and the dashboard's) states the two workshop
defaults it lives under, and no other setting reaches a customer:
`low_stock_alert_default_qty` (the reminder amount the scan applies while the
customer set none; null where no default applies) and
`top_up_default_target_qty` (the balance `POST /me/inventory/top-up-quote`
aims at when no `target_qty` is sent, `TOP_UP_DEFAULT_TARGET_QTY` = 1,000 in
the variant's base unit).

### 5.2 Units

`GET /units` lists them; conversion happens only inside one dimension
(`g`↔`kg`, `mm`↔`m`) and only for display.

### 5.3 The workshop's warehouse

Not the same thing as what customers own. `pc_stock_positions` per variant and
location: `on_hand`, `held` (unpaid orders), `allocated` (bought, still on the
shelf for customers), with `sellable = on_hand − held − allocated` fenced
non-negative. Stock lots record supplier cost (owner-only) — or cost
pending, when an operator receives a lot (or a count finds one) without it;
consumption draws them FIFO, each lot's share kept (`pc_stock_lot_draws`);
every movement is a `pc_warehouse_ledger` row. Customer-owned
material stays physically in the warehouse as an allocation until printed,
delivered or bought back.

## 6. Model files — `files.ts`, `imports.ts`

### 6.1 Uploads, storage and retention

`POST /files` (multipart): STL (binary and ASCII), 3MF and OBJ, up to
`max_upload_bytes` (40 MB, also the ceiling the gateway enforces). The **bytes** must prove the format — a renamed
file is refused; a 3MF archive's directory is read without inflating anything
(too many entries, path traversal, executable or script entries, and an archive
with no `.model` part are refused). Objects go
to the PRIVATE bucket under `print-cloud/<user>/models/<file>.<ext>`; the
content hash is recorded. Measurement (size, volume, triangles, build-volume
fit) runs in the background task `analyze_model_file`; until then the file is
`uploaded`/`processing` and nothing pretends to know its size. Downloads are
owner-only, or by a short-lived signed link (`PRINT_CLOUD_FILE_URL_SECRET`).
Files are kept until the owner deletes them; a file a live job uses cannot be
deleted. The media sweeper knows the key (`worker/lib/mediaRefs.ts`).

### 6.2 URL imports

`POST /imports`: MakerWorld, Printables and Thingiverse links only, `https`
only, through the platform's SSRF guard. Without a configured provider API
that answers with an authorised download on an allow-listed host, the link is
saved as `link_saved` with `MANUAL_UPLOAD_REQUIRED` — the service **never**
reports a file it did not download, and never scrapes, bypasses a login,
paywall or licence. The provider API URLs are empty by default
(`import_providers` in settings).

### 6.3 Preview metadata

The measured bounding box, volume and triangle count are returned with the
file; rendering is the interface's job.

## 7. Projects and printing

### 7.1 Projects — `projects.ts`

Projects (types: generic, keychain, medal, magnetic, NFC, LED, nameplate, storage,
holder, figure, mechanical), members,
models with quantity, transform and per-part material assignments, print
profiles, duplication.

### 7.2 Slicing adapter — `slicing.ts`

The cloud **does not slice**. A job's analysis creates a `pc_slicing_requests`
row; a workshop agent with the `slicer` capability claims it (10-minute lease,
three attempts), runs a real slicer and posts the result: print seconds, grams
per material, support and purge grams, colour changes, warnings. Until then the
job is `analyzing` with `awaiting_slicer`. An operator may enter an estimate
by hand; every estimate records its provenance (`slicer` | `operator`) and
none is invented.

### 7.3 Plates — `plates.ts`

Manual placements are validated against the bed, the height and each other
(rotated footprints). The automatic arrangement is a bounding-box shelf packer
named `bbox_shelf_v1` in its answer — an honest arrangement, not an
optimisation claim.

### 7.4 The job state machine — `jobs.ts`

    draft → uploaded → analyzing → ready → awaiting_confirmation → confirmed
          → queued → preparing → printing ⇄ paused → completed
    failed → reprint_requested · cancelled from any pre-print state

Only the declared transitions exist (`TRANSITIONS`); each is a compare-and-swap
on `op_token` plus a fence, and writes an immutable `pc_print_job_events` row.
Terminal: `completed`, `cancelled`, `reprint_requested`.

### 7.5 Queue and scheduler — `queue.ts`

Confirmed jobs wait in `pc_queue_entries` by priority and time. The scheduler
(task `schedule_queue`, or `POST /admin/print-cloud/queue/run`) assigns a job
only to a printer of the right model that is idle, live (fresh telemetry for an
agent printer, in which the agent reaches it and it runs no print of its own),
loaded with compatible material, and not in maintenance. A pass reads the whole
queue a page at a time and spends its statement share only on work, so jobs no
machine can take never hide the ones behind them. A job that depends on
another runs once that print is made — the job or its reprint; when it can no
longer be made the waiting job is cancelled, its reservations released and the
customer told. A print can no longer be made when it is cancelled, failed and
closed without a reprint, or — judged across the whole chain
(`dependencyStates`, one statement) — stranded itself: a job before a machine
(queued, or earlier) whose own dependency can no longer be made, however far
up. A stranded job is dead for whatever waits on it even while its own release
waits for room: with head ← Large ← Small and the head cancelled, the queue
shows both `dependency_cannot_complete` and the cron releases Small while
Large waits (`tests/printCloudFixes-round4-queue.test.ts`). A dependency is
fixed when its job is created and a reprint waits for nothing, so the walk ends
and a dead answer is final.

Releasing a stranded job is three reads and one fenced batch, and a bounded
pass runs it only when all of it fits: it asks for 15 statements and 4 per
reservation (`releaseCost`, never below what a release sends). Nothing in it
grows with the lots the job's hours are held on — one statement gives every
hold back (§3.1) — and its size is measured from one reservation to the most a
job holds in `tests/printCloudFixes-queue2.test.ts`, and with the hours on a
hundred lots in `tests/printCloudFixes-round4-credits.test.ts`. A release that does not fit is
skipped — deferred, and named in the pass's answer (`deferred`) — and the pass
goes on placing the jobs behind it; a pass that deferred one asks to run again
(`more`) only if it also changed something. The largest job — its hours, 16
colours and 20 accessories, 163 statements — is larger than the quarter-hour
share (120, §12), so the cron leaves it queued, its reservations held and the
queue showing `dependency_cannot_complete`. The operator releases it, with
`POST /admin/print-cloud/queue/run` or `POST /admin/print-cloud/tasks/run`
(whose scheduling pass leads the due work): each is a pass within 600
statements of its own request, and D1 allows 1,000 an invocation. A backlog of
large releases therefore goes a few a run — seven of the largest take three
runs — and the queue run's answer names the releases it deferred and sets
`more` until none is left, so the operator runs it again.

No runner of the queue is unbounded: the cron has its share, the operator's
doors their 600, and the runner after an upload or an import (`waitUntil`)
claims only the kind of work its own request enqueued, within 300 statements
(§12) — a customer's request never works the scheduler's backlog, and a pass
left due waits for the cron or the operator. A partial unique index makes two
active assignments on one printer impossible — scheduler, operator and
database all refuse. Customers see their position and an estimate built from
real queued durations.

### 7.6 Execution and settlement

Start, pause, resume and complete come from an operator or the agent.
Completion settles hours and every material from the job's reservation; with
`agent_reports_need_verification` an agent's report waits for an operator.

### 7.7 Failures and reprints

A failure records who is responsible; `failure_policy` decides the charge
(workshop → nothing; customer or model → printed seconds and failed grams,
never beyond the reservation; undetermined → manual review). A verified
workshop failure queues a free reprint automatically, on the hours its parent
held — even expired ones, which wait for it until it is confirmed or
cancelled (§3.2).

### 7.8 Recommendations — `recommendations.ts`

Accessory suggestions from owner-written rules matched against the project
(magnets for a magnetic kit, rings for keychains…), each accepted or dismissed
by the customer. Printer recommendations rank the customer's tiers by fit
(build volume, colours, materials), balance and real queue length.

## 8. Fulfilment, buyback and the Levonis adapters

### 8.1 Fulfilment — `fulfillment.ts`, `shipments.ts`

Finished prints and owned material leave by pickup or delivery, singly or
grouped. A delivery request creates a shipping order for the fee
(`delivery.flat_fee_iqd` or per governorate); paying it moves the shipment to
`preparing`; `shipped`/`picked_up` settles the delivered material and takes it
off the shelf.

A finished print is on **at most one live shipment**. A request naming a
print already on one — waiting, being prepared, handed over — is refused
`ALREADY_IN_SHIPMENT` with the job and that shipment's id; a cancelled
shipment frees its prints. The batch is the guard, not the plan: the job's
`shipment_id` is taken by a CAS (completed and on none) followed by a fence
that it now names this shipment, and the live item collides with any other
(`uq_pc_shipment_items_job`). Two requests racing for one print make one
shipment; the loser's batch fails, is planned again and refused by name.
`GET /jobs` names each finished print's live shipment (`shipment_id`).

`POST /shipments/quote` takes the request's own body and answers the
request's own assessment (`fulfillment.ts assessShipmentRequest`, from which
`POST /shipments` plans): `fee_iqd` and the rule that set it (`pickup` — free,
`governorate` — the owner's fee for it, `flat`), the status it would start in
(`awaiting_payment` with a fee order of its own, or `preparing`), the prints
and material that would leave (material only as much as is free), and the
ways offered now (`available.pickup`, `available.delivery`). Same refusals;
nothing is written, held or ordered.

### 8.2 Buyback — `buyback.ts`

Unused filament may be sold back at the category's buyback rate, valued from
the customer's own purchase lots (500 g left of a 1 kg lot bought for 24,250
IQD at 50 % → 6,063 IQD). A request reserves the grams; an admin approves,
rejects or marks it paid; cancelling returns them once. `POST /buybacks` is a
money door: its required `Idempotency-Key` stores the answer in
`pc_operations` in the batch that reserves the grams, so a retry after a lost
answer replays it (200, `replayed: true`) instead of reserving twice.

### 8.3 Levonis integration adapters — `adapters.ts`

| Adapter | State |
|---|---|
| identity | **connected** — customers are Levonis users; the shared session identifies them |
| notification | **connected** — in-app notices (`user_notifications`, kind `print_cloud`, three languages) |
| wallet_payment | **connected** — orders paid from the customer's Levonis wallet in one batch with their confirmation, refunds credited back (§4.4); reported not connected while the owner has switched wallet payments off |
| product_catalog | link only — a Print Cloud product may carry a Levonis product id; no sync |
| inventory | standalone ledger — not merged with `inventory_lots` |
| orders, accounting | outbox — events queued in `pc_integration_events`, not delivered |
| membership | not connected — membership-limited promotions do not apply |

Print Cloud writes a Levonis wallet row only through the wallet adapter — the
debit of an order paid from the wallet and the credit of its refund, each in
the Print Cloud batch it belongs to — and no Levonis product, order or
inventory row. `GET /status` and `GET /admin/print-cloud/adapters` report this
table.

## 9. The workshop agent — `printers.ts`, `routes/printCloudAgent.ts`

A small program on the workshop network talks to the printers (Bambu LAN,
OctoPrint, Moonraker…) and to the cloud with a bearer token
(`Authorization: Bearer pca_…`). Tokens are minted by a full admin
(`POST /admin/print-cloud/agents`), shown once, stored as a hash, scoped to a
list of printers and capabilities (`telemetry`, `job_control`, `slicer`,
`camera`), and revocable. Printer credentials never reach the cloud;
`connection_ref` is an opaque name the agent understands.

Agent doors: `GET /printers`, `POST /printers/{id}/telemetry`,
`POST /jobs/{id}/events` (`started`, `paused`, `resumed`, `completed`,
`failed`; `started` only out of `preparing`, `paused` and `resumed` carry the
agent's `event_id`, and a re-sent event answers `already_applied` and changes
nothing), `GET /jobs/{id}` (with `job_control`, only a job holding one of its
printers: the job's slicing input — models and their files, settings, plate,
materials — and its file doors; read-only), `GET /commands`,
`POST /slicing/claim`, `POST /slicing/{id}/result`,
`POST /slicing/{id}/failure`, `GET /files/{id}` (only a file of a job it is
slicing, with `slicer`, or printing, with `job_control`). Without
`GET /jobs/{id}` the file door's printing branch named no file: an agent that
had not sliced the job itself (an operator's estimate, a workshop reprint)
could not learn what to print.

The agent program is `tools/print-cloud-agent/` (docs/PRINT_CLOUD_AGENT.md).

**Order.** Every telemetry body carries `boot` — the agent's boot counter, an
integer it persists and raises by one at every start of its process — and
`seq`, an integer from 0 to 2^53−1 that strictly increases within that boot
(one counter for the process or one per printer: readings are only compared
for the same printer). Both are required; a body without them is refused
`VALIDATION`. Readings are ordered by `(boot, seq)` and by nothing else: a
higher boot is a later run, and within a boot the higher `seq` is newer. Both
numbers are the agent's own, so neither arrival order nor any clock — not even
the server's — can reorder a dead process's late reading ahead of the live
one. A counter that goes back (a lost or restored file) makes the agent's
readings superseded until it passes the stored one; the cloud writes
`boot_regressed` once per such boot so an operator sees why, and re-binding the
printer to a fresh agent token clears it. When the stored reading came from
another agent (the printer was re-bound), the bound agent's reading replaces
it, whatever its numbers. A reading that is not newer is
answered `superseded` and changes no state. No clock is consulted, so a
replayed body, a reading overtaken in transit, an agent clock stepped back or a
stamp in the year 2100 cannot reorder anything. The pre-read, the upsert's
`WHERE` and a fence on the row's fresh `op_token` apply the same order, so two
racing readings end with the higher one stored and only its events. The batch
is also fenced on the printer still being bound to the agent. An error reading
writes `machine_error` once per reading, whether it is stored or superseded
(the event id is derived from printer, agent, boot and `seq`). A fault reported
out of order is never lost, though it changes nothing.

**Freshness.** Telemetry older than `telemetry_stale_seconds` is reported
**stale**, never as live, and a silent agent printer receives no work. A
reading is dated by when it was taken: its arrival less its age. The age is
`sent_at - reported_at` when both stamps are present (two readings of the
agent's one clock, so clock skew cancels). It is 0 for a pair out of order and
is capped one second past the window, so a huge age makes a reading stale but
never dates it further back. Without both stamps a reading is as old as its
arrival. That taken time (`received_at`) is the only thing freshness is judged
by, and it is written only with its own reading. The stamps are optional and
never order anything.

**Outages.** «Back from silence» is judged by the gap between POST arrivals on
the server clock (`arrived_at`, which only moves forward), never by a reading
or its order. The POST that ends a silence, stored or superseded, records the
outage on the printer's row (`outage_from`, `outage_to`) and writes
`connection_restored`, once per outage even when two POSTs race at
reconnection. A stored `finished` reading for the assigned job that the record
still shows `printing` writes `reconcile_needed` when it was taken during that
outage, or is the first one taken after it. That happens once per job per
outage, whichever POST of the flush carries it. `GET /status` calls the slicer
`connected` only when a slicer agent called in within the same window. Camera
data is metadata only (availability, stream id, resolution).

## 10. Dashboards, notifications and administration

### 10.1 Customer data — `reports.ts`, `notify.ts`

`/me/dashboard` gathers balances, reservations, active jobs, queue positions,
shipments and reminders; `/me/transactions` merges the credit, inventory and
order histories, paged on a strict (time, ledger, id) cursor (`next_before`),
so rows one batch wrote at one instant are never skipped between pages.
Customers are notified (three languages) on payment, job
transitions, failures, shipment changes and low inventory.

### 10.2 Administration — `routes/printCloudAdmin.ts`

| Role | Can |
|---|---|
| assistant admin (workshop operator) | queue, jobs, printers, maintenance, stock counts, shipments, estimates, tasks — `op` |
| full admin | everything above plus prices, payments, refunds, balance adjustments, buybacks, agent tokens, revenue, reconciliation, audit — `money` |
| owner | everything, plus costs: stock lot costs, machine acquisition, profit — `cost_read` |

On the mixed doors the split is per field: a price field needs money scope, a
cost field the owner. Every admin write is audited (`print_cloud.*` actions in
the platform audit log). `tests/routeClass/printCloud.ts` classifies every
admin route for the platform's role-matrix sweeps.

The console is Admin → Services → «الطباعة السحابية» (`src/components/adminPrintCloud`,
one lazy chunk per section). It offers only what the reader's scope allows
(`can_move_money`, `can_view_cost`, `can_write_cost`, read `=== true`), only the
job and shipment moves the server's machines allow, and the server's own
three-language refusal. Two reads exist for it: `GET /printers/{id}/maintenance`
(the windows `PATCH /maintenance/{id}` closes; their cost for the owner only)
and `GET /shipments/{id}` (the packing list; the fee for money scope only).

Reports: revenue (cash collected and revenue recognised from lot draws),
profit (owner only — revenue minus material, machine and electricity cost),
operations (utilisation, failures, queue). A refund of unused hours or grams
gives back deferred value, never revenue: profit moves only by what was paid
back beyond (or kept of) that value, or by a refunded delivery fee. Units
drawn from a lot whose cost is still pending are listed (`cost_pending`,
`cost_complete: false`), never costed as a known zero; the owner states the
lot's cost once (`POST /admin/print-cloud/stock/lots/{id}/cost`) and the
units already used are then valued from it in the period they left.

## 11. Reconciliation — `reconcile.ts`

`GET /admin/print-cloud/reconcile` and the daily `reconcile` task prove that
every cached balance equals its ledger and lots: credit and inventory accounts,
each credit, inventory and stock lot against its own draws (remainder and
value), each credit account's available and reserved seconds against its
lots' free parts and holds, each active credit reservation against its hold
rows and each lot's holds against the active reservations on it, stock
positions, holds and allocations, active reservations against job states,
one active assignment per printer and per job (also enforced by the partial
unique indexes) and only for jobs on a machine, paid orders against payments,
orders paid from the Levonis wallet against the wallet ledger (one debit,
refund credits never above it, no debit without a wallet payment).
Twenty-four checks; a mismatch is **reported**, never silently repaired. The
platform's own wallet reconciliation (`walletReconciliationReport`) reads the
Print Cloud debit as a system purchase (`created_by = 'system'`), never as a
payout without a request.

## 12. Background work — `background.ts`, `tasks.ts`

`pc_background_jobs` is a durable queue: `analyze_model_file`,
`import_model_url`, `expire_orders`, `expire_credit_lots`,
`low_inventory_scan`, `schedule_queue`, `slicing_lease_sweep`, `reconcile`.
Each claim takes a lease; a failure retries with backoff and dies after its
last attempt; every attempt is logged (`pc_background_job_logs`). The platform's
quarter-hour cron runs it as its LAST step with its own share of the tick's D1
statement budget — 120, cut to what the earlier steps left
(`quarterHourPrintCloudBudget`, `worker/lib/quarterHourBudget.ts` step 8). A
task starts, and each unit of its work (one order, one lot, one notice, one
assignment, one lease, the whole reconciliation) runs, only while a whole unit
still fits; a task cut short is queued again and finishes on a later tick
(`tests/printCloudOperations.test.ts`, `tests/fxSweepBudget.test.ts`). An admin
may run due work by hand (`POST /admin/print-cloud/tasks/run`, within 600
statements of that request); a scheduling pass leads it, at most one a minute,
so a release too large for the cron's share is done there (§7.5). The runner a
request starts after its answer (`waitUntil` after `POST /files` and
`POST /imports`, `runAfterRequest`) claims only the kinds of work that
request enqueued — `analyze_model_file` after an upload; `import_model_url`,
and the analysis of the file an import brings in, after an import (the claim
filters on them) — at most two tasks within 300 statements of that
invocation; every other due task waits for the cron or the admin's run.

## 13. Configuration

### 13.1 Environment

| Variable | Purpose | Without it |
|---|---|---|
| `PRINT_CLOUD_PAYMENT_WEBHOOK_SECRET` | HMAC secret of the gateway webhook (≥ 32 chars). A dashboard SECRET | the gateway adapter is off |
| `PRINT_CLOUD_FILE_URL_SECRET` | signs short-lived download links | signed links are refused; owners still download directly |
| `PRINT_CLOUD_DEV_PAYMENTS` | `on` enables the development payment door. **Local only** | off |

Bindings used: `DB` (D1), the private R2 bucket (`mediaBucket(env, 'private')`).

### 13.2 Settings

One versioned row (`pc_settings`), edited with `PATCH /admin/print-cloud/settings`
(money scope; `cost_*` keys owner only), normalised on every read
(`settings.ts`): `enabled`, quote/hold/confirmation durations, rounding, the
next-pack cap, overage policies, operator approval, agent verification,
telemetry staleness, failure policy, free reprint, upload limit, active-job
limit, low-inventory default, delivery fees, import providers,
`wallet_payment_enabled` (default `true`: paying from the Levonis wallet;
`false` refuses new wallet payments `503 PAYMENT_ADAPTER_DISABLED` and reports
the adapter not connected — refunds of wallet-paid orders still go to the
wallet), electricity tariff. A patch merges key by key at every level (a
governorate fee set to `null` is removed; `import_providers` is replaced
whole), and a value out of range or of the wrong type is refused `VALIDATION`,
never replaced by a default.

### 13.3 Local development

```bash
npm install
npm run db:migrate:local                       # applies 0215 with the rest
npx wrangler d1 execute levonis-db --local --file scripts/print-cloud-seed-dev.sql
printf 'PRINT_CLOUD_DEV_PAYMENTS=on\nPRINT_CLOUD_FILE_URL_SECRET=dev-file-secret-0123456789abcdef\n' >> .dev.vars
npm run dev                                    # http://127.0.0.1:8787
curl http://127.0.0.1:8787/api/print-cloud/v1/openapi.json
```

The seed (development only, ids prefixed `dev_`) opens the service and adds
three tiers, printer models and machines, packages, filaments and accessories
with price tiers, warehouse stock consistent with its ledger, and accessory
rules. Sign up a user through the normal Levonis flow, then buy a package
(`POST /quotes` → `POST /orders` → `POST /orders/{id}/dev-pay`).

## 14. Tests

| File | Covers |
|---|---|
| `tests/printCloudScenarios.test.ts` | the specification's §36 scenarios: credits 24 h / 8.9 h / 8.5 h, top-up 490 + 250 = 740, gram pricing, multi-material, accessories 20 → 18, queue exclusivity, concurrent last 100 g, duplicate webhook, cancellation, workshop and customer failures, buyback 6,063 IQD, cross-customer isolation |
| `tests/printCloudAcceptance.test.ts` | §39 end to end on real records: purchase → STL/3MF/OBJ files and an import → five jobs → agent slicer → scheduler → agent events → verification → delivery → notifications, audit, revenue/profit, clean reconciliation |
| `tests/printCloudOperations.test.ts` | gates, roles, idempotency, expiry, imports and SSRF, uploads, plates, the agent, refunds, conversion, fulfilment, append-only ledgers, buyback reservations, durable tasks |
| `tests/printCloudFixes-account.test.ts` | the account screens' server gaps: one live shipment per print (raced), the exact ledger cursor, the keyed sell-back (raced), the conversion rules and quote, the shipment quote (same refusals), the inventory defaults |
| `tests/printCloudAdminUi.test.ts` | the admin console against the server: catalogue fields, settings bounds, job and shipment moves, the price preview, three languages, the keyed money doors |
| `tests/printCloudAdminReads.test.ts` | the console's two reads: maintenance windows (cost owner-only) and one shipment's packing list (fee money-only) |
| `tests/printCloudUnits.test.ts` | money arithmetic, apportioning, lot valuation, the pricing engine, promotions, the state machine, plates, file sniffing, webhook signatures, settings, three languages, error mapping, hosts |
| `tests/printCloudOpenApi.test.ts` | the document equals the routers; access classes match the guards |
| `tests/printCloudWallet.test.ts` | the Levonis wallet adapter on funded wallets with dinar testimony: the page figure, the one-batch payment, 402 in three languages with nothing written, holds, races (wallet × wallet, wallet × manual, wallet × gateway, wallet × cancel), replays, expiry, zero totals, delivery fees, the owner switch, refunds (partial, full, racing, under a cent, other methods), deploy ahead of 0215 and 0108 |
| `tests/printCloudAgentJobDoor.test.ts` | the agent's job door `GET /agent/jobs/{id}`: `job_control` only, only a job on one of the agent's printers, its input and file doors, read-only |
| `tests/printCloudAgentProgram.test.ts` | the workshop agent program (`tools/print-cloud-agent`) against the real app in process: telemetry order and the boot counter, a whole job from slicing claim to completion on the simulator, printing an operator-estimated job through the job door, commands, restarts, failures; MQTT, FTPS, Bambu, OctoPrint and Moonraker drivers against local fakes; slicer figure parsing |

Concurrency is proven with `RaceD1` (`tests/fixtures/printCloud.ts`), which
interleaves a competing request immediately before a batch and enforces D1's
limits.

    node --import tsx --test tests/printCloud*.test.ts

## 15. Deployment

Merging to the default branch deploys through workflow 7, which applies
`0215_print_cloud.sql` before the code that needs it. Every read tolerates its
absence (an empty service) and every write refuses it (`503
PRINT_CLOUD_NOT_INSTALLED`) — §1. The service is deployed **closed**;
opening it is the owner's `PATCH /settings {"enabled": true}` after the
catalogue and prices are entered. The `cloud` subdomain is a reserved system
name; pointing `cloud.levonis-iq.com` at the Worker is a DNS/route step in the
Cloudflare dashboard (docs/SUBDOMAIN_ARCHITECTURE.md).

## 16. External services still required

1. **The workshop agent, installed and validated** — the program exists
   (`tools/print-cloud-agent/`, docs/PRINT_CLOUD_AGENT.md): it drives Bambu
   Lab (LAN MQTT + FTPS), OctoPrint and Moonraker printers, runs an
   OrcaSlicer / Bambu Studio / PrusaSlicer CLI and speaks §9. It has been
   exercised only against the simulator and local fakes, **never against a
   real printer or a real slicer binary**; it still has to be installed on
   the workshop LAN and validated machine by machine. Until then jobs wait for
   an operator's manual estimate and manual start/finish.
2. **A payment processor** that can sign the §4.4 webhook, for card
   payments. (Paying from the Levonis wallet is connected — §4.4.)
3. **Provider APIs** for URL imports (MakerWorld, Printables, Thingiverse) with
   terms that permit downloads; until then imports save the link only.
4. **DNS/route** for `cloud.levonis-iq.com`.
5. **Secrets** of §13.1 on the live Worker.

## 17. Implemented vs not connected

Implemented and tested on real persisted records: everything in §§2–12 — the
catalogue, credits, pricing and quotes, orders with holds, the payment door
and its manual/gateway/dev adapters, the Levonis wallet adapter (payments and
refunds, §4.4), customer inventory, the warehouse, files and their
validation, imports (link saving and authorised download), projects,
plates, the job state machine, the queue and scheduler, the agent protocol,
the slicing request/lease/result protocol, failures and reprints,
fulfilment, buyback, recommendations, reports, reconciliation, background
work, RBAC, audit and the OpenAPI document.

Not connected (honestly reported by `/status` and `/adapters`): catalogue
sync, shared inventory, order/accounting delivery (outbox only), membership
pricing; a contracted payment processor; provider download APIs; a workshop
agent and slicer running on the workshop LAN (the cloud side of their
protocol is built, and the agent program exists in `tools/print-cloud-agent/`
— tested against the simulator and local fakes only; no real printer or
slicer binary has run it yet, docs/PRINT_CLOUD_AGENT.md); the customer and
admin interfaces (Phase 9).
