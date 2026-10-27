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

DECISIONS row 270 records the decision and its open owner questions.

---

## 1. Status, shape and API

| | |
|---|---|
| Migration | `migrations/0215_print_cloud.sql` — 70 `pc_*` tables, triggers and indexes; touches no existing table |
| Library | `worker/lib/printCloud/*.ts` (one module per domain, listed per section below) |
| Routers | `worker/routes/printCloud.ts` (customer), `printCloudAgent.ts` (workshop agent), `printCloudAdmin.ts` (administration) |
| Mounts | `/api/print-cloud/v1`, `/api/print-cloud/v1/agent`, `/api/admin/print-cloud` (`worker/index.ts`) |
| Hosts | the main host, the `cloud` system subdomain, and foreign hosts outside the root; **never** a merchant storefront (`printCloudHostAllowed`, `worker/lib/printCloud/http.ts`) |
| OpenAPI | `GET /api/print-cloud/v1/openapi.json` — generated from `worker/lib/printCloud/openapi.ts`; 148 operations, and `tests/printCloudOpenApi.test.ts` fails if a route and its documentation disagree. Owner-only cost fields are described in the owner's copy only |
| Default state | **closed**: `pc_settings.enabled = false`, customer doors answer `503 PRINT_CLOUD_DISABLED` (admins still work) until the owner opens the service |
| Without the migration | reads see an empty, closed service (lists empty, a named record 404, `GET /status` says `installed: false`) — exactly the answers of a migrated database with no data; every write answers `503 PRINT_CLOUD_NOT_INSTALLED` before any statement; the cron step does nothing (`tests/costDeployAhead.test.ts`) |

Response envelope: `{ "success": true, "data": … }`. A refusal is the
platform's `HttpError` with a stable `code` and `details.messages` in Arabic,
English and Sorani (`worker/lib/printCloud/errors.ts`; a Sorani string is never
the Arabic one — `tests/printCloudUnits.test.ts`).

Idempotency: every door that moves money, hours or grams on the customer's
behalf (`POST /orders`, `POST /jobs/:id/confirm`, `POST /shipments`,
`POST /me/credits/convert`, admin balance adjustments and refunds) takes an
`Idempotency-Key` header. The first answer is stored in `pc_operations` in the
SAME batch as the business writes; a replay returns it, and the same key with a
different request body is refused `IDEMPOTENCY_KEY_REUSED`.

### 1.1 Customer API (`/api/print-cloud/v1`)

Public: `GET /status`, `/printers`, `/printers/{id}`, `/printers/{id}/availability`,
`/packages`, `/store/categories`, `/store/products`, `/units`,
`POST /pricing/quote`, `POST /payments/webhook` (signed, §4.4).

Signed-in customer: `/me/dashboard`, `/me/credits` (+ `/ledger`,
`/reservations`, `POST /convert`), `/me/printers`, `/me/inventory` (+ `/ledger`,
`PATCH /{variantId}/alert`, `POST /top-up-quote`, `/reorder-suggestions`),
`/me/transactions`; quotes and orders (`POST /quotes`, `POST /orders`,
`POST /orders/{id}/cancel`, `POST /orders/{id}/dev-pay` — development only);
files (`POST /files`, list, read, delete, download, signed links); imports;
projects (create, update, duplicate, models, plates, accessory suggestions,
printer recommendations); print profiles; jobs (`POST /jobs`, `PATCH`,
`/analyze`, `/projection`, `/review`, `/confirm`, `/cancel`, `/requests`,
`/reschedule`); `GET /queue`; shipments; buybacks.

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
- **the `expire_credit_lots` task takes exactly its free part**, with its own
  ledger rows. The task's page holds only lots that have a free part (the
  filter is per lot), so lots wholly held for jobs never crowd out the ones
  that can expire. Each pass is fenced on the lot's remainder and holds and
  keyed by what the lot had left, so a lot may expire in several passes.

Hours a job came to hold before the expiry stay that job's: it prints from
them, and what it gives back (a cancellation, a settlement under the
estimate) is free and expires on the next run. The one exception is a **free reprint after a
workshop failure**: it inherits what its failed parent held and gave back,
lot by lot, taken first even past the expiry — and only that much — so the
customer loses no hour to the workshop's failure. Converted hours keep the
expiry they were bought under. A lot that fails to expire fails the task
(retried, its error visible in `GET /admin/print-cloud/tasks`).

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
| `levonis_wallet` | **not connected**: answers `ADAPTER_NOT_CONNECTED` |

Refunds (`POST /admin/print-cloud/orders/{id}/refunds`, idempotent) return only
the unused hours and grams of that purchase's own lots — for hours, the lot's
free part (never seconds a job holds), and nothing once it has expired.

## 5. Inventory — `inventory.ts`, `warehouse.ts`

### 5.1 What customers own

`pc_inventory_accounts` per customer and variant (`available`, `reserved`,
`consumed`, `delivered`, `sold_back`), in the variant's own unit — grams are
never added to pieces. Lots carry their purchase price; ledgers are append-only
with unique entry keys; jobs reserve and settle each material independently
(20 magnets owned, a job uses 2 → 18 left). Low-inventory reminders use the
customer's threshold or `low_inventory_default_g`.

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
longer be made (cancelled, or failed and closed without a reprint) the waiting
job is cancelled, its reservations released and the customer told. That release
is three reads and one fenced batch, and a pass bounded by a statement share
runs it only when all of it fits: it asks for 14 statements and 4 per
reservation (`releaseCost`, never below what a release sends, measured from one
reservation to the most a job holds in `tests/printCloudFixes-queue2.test.ts`).
A release that does not fit is skipped (counted `deferred`) and the pass goes
on placing the jobs behind it; a pass that deferred one asks to run again only
if it also changed something. The largest job — its hours, 16 colours and 20
accessories, 162 statements — is larger than the quarter-hour share (120, §12),
so the cron leaves it queued, its reservations held and the queue showing
`dependency_cannot_complete`. The operator releases it: with
`POST /admin/print-cloud/queue/run`, a pass without a share (the request's own
invocation), or with `POST /admin/print-cloud/tasks/run`, whose scheduling pass
leads the due work inside that run's 600 statements. A
partial unique index makes two active assignments on one printer impossible —
scheduler, operator and database all refuse. Customers see their position and
an estimate built from real queued durations.

### 7.6 Execution and settlement

Start, pause, resume and complete come from an operator or the agent.
Completion settles hours and every material from the job's reservation; with
`agent_reports_need_verification` an agent's report waits for an operator.

### 7.7 Failures and reprints

A failure records who is responsible; `failure_policy` decides the charge
(workshop → nothing; customer or model → printed seconds and failed grams,
never beyond the reservation; undetermined → manual review). A verified
workshop failure queues a free reprint automatically.

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

### 8.2 Buyback — `buyback.ts`

Unused filament may be sold back at the category's buyback rate, valued from
the customer's own purchase lots (500 g left of a 1 kg lot bought for 24,250
IQD at 50 % → 6,063 IQD). A request reserves the grams; an admin approves,
rejects or marks it paid; cancelling returns them once.

### 8.3 Levonis integration adapters — `adapters.ts`

| Adapter | State |
|---|---|
| identity | **connected** — customers are Levonis users; the shared session identifies them |
| notification | **connected** — in-app notices (`user_notifications`, kind `print_cloud`, three languages) |
| wallet_payment | not connected (`ADAPTER_NOT_CONNECTED`) |
| product_catalog | link only — a Print Cloud product may carry a Levonis product id; no sync |
| inventory | standalone ledger — not merged with `inventory_lots` |
| orders, accounting | outbox — events queued in `pc_integration_events`, not delivered |
| membership | not connected — membership-limited promotions do not apply |

Nothing in Print Cloud writes a Levonis wallet, product, order or inventory
row. `GET /status` and `GET /admin/print-cloud/adapters` report this table.

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
nothing), `GET /commands`, `POST /slicing/claim`,
`POST /slicing/{id}/result`, `POST /slicing/{id}/failure`, `GET /files/{id}`
(only a file of a job it is slicing, with `slicer`, or printing, with
`job_control`).

Telemetry older than `telemetry_stale_seconds` is reported **stale**, never as
live; a silent agent printer receives no work. A reading is dated by when it
was taken: its arrival less its age, the age being `sent_at - reported_at` (two
readings of the agent's one clock, so clock skew cancels; without `sent_at`,
`now - reported_at`); freshness is judged by that taken time. Readings are
ORDERED on the agent's own clock when they can be: one whose `reported_at` is
earlier than the stored reading's, from the agent that wrote it, is older
whenever it arrives (a body re-sent with its original stamps, a reading
overtaken in transit). A reading without `reported_at`, or a row another agent
wrote (a re-bound printer), is ordered by taken time. An older reading is
answered `superseded` and changes nothing; the batch re-checks the order, so
a race cannot slip one past. «Back from silence» is judged by the gap between
POST arrivals on the server clock (`arrived_at`, which only moves forward):
the POST that ends a silence — stored or superseded — records the outage on
the printer's row (`outage_from`, `outage_to`) and writes `connection_restored`,
once per outage even when two POSTs race at reconnection. A stored `finished`
reading for the assigned job the record still shows `printing`, taken during
that outage or the first one taken after it, writes `reconcile_needed` — once
per job per outage, whichever POST of the flush carries it. `GET /status`
calls the slicer `connected` only when a slicer agent called in within the same
window. Camera data is metadata only (availability, stream id, resolution).

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
unique indexes) and only for jobs on a machine, paid orders against payments.
Twenty-three checks; a mismatch is **reported**, never silently repaired.

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
so a release too large for the cron's share is done there (§7.5).

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
limit, low-inventory default, delivery fees, import providers, electricity
tariff. A patch merges key by key at every level (a governorate fee set to
`null` is removed; `import_providers` is replaced whole), and a value out of
range or of the wrong type is refused `VALIDATION`, never replaced by a default.

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
| `tests/printCloudUnits.test.ts` | money arithmetic, apportioning, lot valuation, the pricing engine, promotions, the state machine, plates, file sniffing, webhook signatures, settings, three languages, error mapping, hosts |
| `tests/printCloudOpenApi.test.ts` | the document equals the routers; access classes match the guards |

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

1. **A workshop agent** — software on the workshop LAN that drives the
   printers (Bambu LAN/MQTT, OctoPrint, Moonraker) and runs a slicer CLI
   (Bambu Studio / OrcaSlicer / PrusaSlicer), speaking §9. Without it jobs wait
   for an operator's manual estimate and manual start/finish.
2. **A payment processor** that can sign the §4.4 webhook — or the Levonis
   wallet adapter, once its contract is decided.
3. **Provider APIs** for URL imports (MakerWorld, Printables, Thingiverse) with
   terms that permit downloads; until then imports save the link only.
4. **DNS/route** for `cloud.levonis-iq.com`.
5. **Secrets** of §13.1 on the live Worker.

## 17. Implemented vs not connected

Implemented and tested on real persisted records: everything in §§2–12 — the
catalogue, credits, pricing and quotes, orders with holds, the payment door
and its manual/gateway/dev adapters, customer inventory, the warehouse, files
and their validation, imports (link saving and authorised download), projects,
plates, the job state machine, the queue and scheduler, the agent protocol,
the slicing request/lease/result protocol, failures and reprints,
fulfilment, buyback, recommendations, reports, reconciliation, background
work, RBAC, audit and the OpenAPI document.

Not connected (honestly reported by `/status` and `/adapters`): the Levonis
wallet, catalogue sync, shared inventory, order/accounting delivery (outbox
only), membership pricing; a contracted payment processor; provider download
APIs; the agent program and slicer themselves (the cloud side of their
protocol is built); the customer and admin interfaces (Phase 9).
