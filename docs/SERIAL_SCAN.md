# Serial scan at order preparation — server and screens

Owner brief 2026-10-07 (33 sections): every printer / AMS unit in an order is
bound to its real serial while the order is prepared, by camera, a USB or
Bluetooth scanner, or typing. Design: the serial-scan spec with both critiques
applied. Code: `worker/lib/serialAssignments.ts` (the rules),
`worker/lib/serialPolicy.ts` (which products need a serial),
`worker/routes/adminOrderSerials.ts` (the doors), migration
`0178_serial_assignments.sql`.

## Not a second serial or warranty system

| Brief | Implementation |
|---|---|
| `serial_assets` (one row per serial, UNIQUE) | `serial_inventory`, reused — `serial_norm` is its PRIMARY KEY. Created once with `INSERT … ON CONFLICT DO NOTHING`; never carries an order id (§6). |
| Order assignment | NEW `serial_assignments`, keyed like `order_item_units`: `(order_item_id, unit_index, part, part_index)`. Released, never deleted. |
| Warranty record | `order_item_units`, created at delivery by `createUnitsOnDelivery` with the existing `computeCoverage`. New nullable `warranty_closed_at / _reason / return_case_id` record RETURNED without zeroing a date. |
| Asset → warranty | `device_serials` (one open unit per serial), moved to the new unit on resale. |
| History | `audit_log`, target = `serial_norm` (`serial_inventory.*`, `serial.*`, plus `device.*` on every unit the serial was bound to and its receipts' `warranty.*`). |
| `current_status` | Derived, never stored: `void · reserved · in_stock · returned · unavailable · sold · registered` (`serialStatusSql`). |

## Invariants (database-enforced)

- `ux_serial_assignments_serial_pending`: one pending (not delivered) binding per serial — the same serial on two orders, or twice in one order, cannot both be live.
- `ux_serial_assignments_serial_active`: one delivered binding per serial.
- `ux_serial_assignments_slot_live`: one live serial per physical unit slot.
- `ux_serial_assignments_unit_live`: one live binding per warranty unit (released rows keep `unit_id` as history).
- `idempotency_key UNIQUE` (`scan:<op_id>`): a double tap or a retried request links once.
- `trg_orders_serial_assignments_cancelled`: a cancel by ANY door (stage, legacy PATCH, customer, sweeps, store ops) releases the order's bindings in the same statement as the status flip.

## Doors

| Route | Who | Notes |
|---|---|---|
| `GET /api/admin/orders/:id` | admin | adds `serials` (slots, linked, gate, re-open suggestions) through `soft()`; `installed:false` before 0178. |
| `GET /api/admin/orders/:id/serials` | admin | the same view alone. |
| `GET /api/admin/orders` (the board) | admin | each shelf row adds `serials: {required, linked, gate, holds_next}`; absent before 0178. |
| `POST /api/admin/orders/:id/serials/scan` | admin with the `receive` capability | `{order_item_id, unit_index, part?, code, ean?, box_sn?, source, op_id}` → `outcome: created · existing · already`. «أعد ربطه» sends `previous_assignment_id` (a released binding of this order and unit) instead of `code`, so an assistant re-links a serial it only sees masked. |
| `POST /api/admin/orders/:id/serials/change` | same | `{assignment_id, code, …, op_id}` — the old binding is released in the same batch; a failed new link leaves it intact. A retry with the same `op_id` answers the link it made (`already`), as does the override's. |
| `POST /api/admin/orders/:id/serials/unlink` | same; owner only outside the window or once a courier shipment exists (reason 5–500) | targets the assignment id, so a replay can never release a newer link. |
| `POST /api/admin/orders/:id/serials/override` | owner only, reason 5–500 | `kind: take_from_order · delivered_device · unavailable · outside_window · batch · model_family`, optional `warranty_mode: carry · restart`; audited inside the batch. |
| `GET /api/devices/admin/serial-inventory/:serial` | admin | the §16 page: `story` (status, current/previous orders, warranty, lot, full timeline); order ids and the full serial for the owner and full-scope admins only — in the `row` too, and every serial a history line names (another device's in a «change», a replaced or corrected serial, a box SN — at any depth of the row) is masked for an assistant. Answers devices known only to `device_serials` too. |
| `POST /api/devices/admin/units/:unitId/serial` | admin; owner to take a serial off an open warranty, in EITHER direction (the serial's old unit, or this unit's own serial) | a delivered order's open unit only (`ORDER_NOT_PREPARABLE` / `UNIT_NOT_OPEN`), the one canonicaliser, no live preparation binding elsewhere — re-checked inside the batch. |
| `POST /api/devices/admin/units/:unitId/replace` | admin | the replacement serial's bindings are re-checked inside the batch. |
| `POST /api/admin/stock-operations/serial-link` | `receive` | a serial with a live binding takes only a lot that binding's line was allocated (`SERIAL_BATCH_MISMATCH`); a pending binding takes it as its verified lot in the same batch (an inferred lot on that lot trades places; a lot full of verified serials refuses). |
| `POST /api/devices/admin/serial-inventory/:serial/warranty-mode` | owner | `carry` (original end, default) or `restart` for a resold returned device, while its new binding is not delivered. |
| `PUT /api/admin/taxonomy/catalogs/:id/serial-policy` | owner | `inherit · required · off`. |
| `PUT /api/admin/settings/serialPrepGate` | owner | `{enabled, since}`; switching on without `since` stamps now. |
| `PATCH /api/admin/orders/:id/stage`, `PATCH /api/admin/orders/:id`, `POST /api/admin/orders/:id/delivery` | as before | the §19 gate; optional `serials_override_reason` (owner). |
| `POST /api/returns/admin/:id/transition` | as before | optional `serials[]` (scanned at inspection) or `unit_ids[]`; answers `serials:{closed, unattributed}`. |

Every refusal is a code with the brief's Arabic sentence (§31, §9, §10, §11,
§17, §19) — the programme contract's two codes, `OWNER_ONLY` and
`IDEMPOTENCY_MISMATCH`, with the contract's own sentence — never a trace; the
screen localises by code
(`src/lib/refusalStrings.ts`, ar / en / ckb).

## The scan (one atomic batch)

Before the batch, read-only: the ONE canonicaliser (`classifyScanInput`, every
source) refuses receipts, an EAN / UPC / ITF-14 of any length and anything not
serial-shaped; a box SN counts only through the asset that carries it;
`SN 0391…` with a space is stripped like `SN: …`. Then the classifier
(`classifyLink`, also re-run after a failed batch for the honest reason):
window, shipment lock, stock deducted, asset void / product / option, box↔serial
collisions, EAN product, serial-prefix model family, live elsewhere, delivered
(legacy keys included), unsellable, slot taken, lot.

Inside the batch, each re-asserted: S1 window + line + unit (+ no courier
shipment for staff, + the deduct happened), find-or-create the asset, S4 asset
usable and compatible and not another box's SN, S5 not delivered under an open
warranty or live receipt, adopt the line's product when the asset had none
(undone if that first scan is unlinked and the asset has no other history), S8
the lot still owes this line a unit, the assignment, the audit rows.

Window: `status ∈ {confirmed, processing}` and a direct order at
`confirmed / preparing`, or a pre-order at `at_levo_warehouse /
local_delivery_prep` (`serialScanWindow`, pinned against `scanWindowSql`).

## Delivery → warranty (§8, §28)

`createUnitsOnDelivery` keeps its unit batch exactly as before, then calls
`activateOrderSerials` — one batch PER assignment, fenced so it commits whole
or not at all (the old serial A0 detaches is audited and rolls back with a
binding that could not be made), after the units committed,
so nothing new can cost a customer their warranty units. It moves
`device_serials` to the new unit (only off a closed / replaced unit or the unit
an owner override named), marks the assignment activated only if the pointer
really moved, and then: carry (`carried:'original_end'` + `resale_of`),
closes an overridden prior unit (receipt voided, registration revoked),
re-opens a unit closed by an undone-delivery cancel, writes the serial-verified
lot to `order_item_units.inventory_lot_id`, and audits
`serial.warranty_activated`. A slot whose line is no longer serialized releases
its binding (`policy_changed`). `sweepUnactivatedSerials` retries (five
attempts per row) from the cron.

## Cancel, return, re-open

- Cancel before delivery: the trigger releases (`order_cancelled`); asset and identity kept; the next scan of the same serial is `existing`.
- Return (`resolved` + `refund`): the unit closes (`returned` / `returned_unsellable` after a quarantine inspection) with its dates kept, its live receipt is voided, its registration revoked, its binding released. Attribution is by evidence only (scanned serials, explicit unit ids, or every open feature unit when the case covers them all) — never the customer's own unit pick on a multi-unit line. `sweepReturnedSerials` retries, bounded to cases decided after their serial activated. A returned device is not re-registrable, leaves «add from my orders», and the customer's order says «returned».
- Re-open: released rows stay released; the slot offers the previous serial, which goes through a normal scan.
- Re-delivery after an undone delivery + cancel (`reopenRedeliveredUnits`, integrity #1, regressions #1/#2): every unit the trigger closed `order_cancelled` re-opens when the order is delivered again, with or without a new scan. The account link the cancel revoked and (same device) the receipt it voided come back — matched by `revoked_at` / `voided_at` ≥ the closure — so a stranger can never claim the device as «released». No new scan: the old device stays with the unit (an activated `relink` binding) if it is still free, otherwise its pointer leaves the unit (`serial.detached`). Until that step runs, such a unit of a delivered order reads as delivered (S5, the classifier, A3), and the activation sweep picks the order up.

## Preparation gate (§19)

`serialPrepGate` ships OFF. When the owner switches it on (cutover `since`),
an order created after the cutover cannot move into `out_for_delivery` /
`delivered` or get a courier shipment while a serial-required unit has no
serial, or a serial's own lot is no longer among the line's allocations. The
pre-read gives the missing list; a count fence rides the stage flip itself and
the legacy flip, so an unlink racing the move is caught inside the move — also
when the owner passed a reason the order turned out not to need. A serial's
own lot is the verified one or, failing that, the one the receiving desk
linked it to (`stock_serial_links`). The courier door stores the owner's
override audit in the same batch as the shipment, and re-checks after the
shipment is stored and records a breach. The owner's take-from-order only
takes from an order still in its scan window and without a shipment, checked
again inside the batch (`OVERRIDE_UNAVAILABLE`: `other_order_shipped`,
`other_order_delivered`, `other_order_outside_window`).
Courier sync, the cron and backward moves are not gated. Merchant orders and
bundle parents never have slots.

## Which products need a serial (§29)

Resolved at read time, never written onto products: the product's own
`ops_policy.serialized`, else a printer catalog (always on), else the nearest
section on its branch with `serial_policy ≠ inherit` ('required' wins across
branches), else off. Owner only: the section policy, the printer flag (in
both catalog editors: `POST /api/admin/taxonomy/catalogs` and
`POST|PATCH /api/admin/products-v2/catalogs`), the product's flag, a re-filing
that flips the answer for a product with no word of its own, and moving a
section under a parent whose policy flips one of its products
(`reparentSerialFlips`, both editors). Every product door judges a non-owner's
write by ONE rule, `serializedWriteVerdict` (worker/lib/serialPolicy.ts): the
form on create and on update (by `serialized` or `ops_policy.serialized`), the
ops-policy route, the placement route, the import sheet (its preview, with the
section policies and the filing the confirm will write — `serialImportIssue`)
and the TXT template. A non-owner never changes the product's own word: an
echo of the effective answer passes and is NOT written down, so a product that
inherits its answer keeps following its section.

Refusals: 403 `OWNER_ONLY` with `details.via` = `flag`, `placement` or
`reparent`; the import sheet refuses by line in ar / en / ckb
(`IMPORT_SERIALIZED_OWNER_ONLY`, `IMPORT_SERIAL_REFILE_OWNER_ONLY`); the
template preview shows it as its validation error (code `OWNER_ONLY`).

## Owner defaults (changeable later, no migration)

1. A Combo carries ONE serial — the box Product SN. `part='ams'` / `part_index` exist in the schema; the routes refuse them until the owner decides.
2. AMS: no name inference. The owner sets `required` on the section holding AMS products.
3. The owner (INITIAL_ADMIN_EMAIL) and full-scope (or legacy NULL-scope) admins see the full serial; assistants the masked form. On S1 this is `canMoveMoney` (`serialActor.fullSerial`, worker/lib/serialAssignments.ts): a serial is no cost, so the owner-only cost predicates do not decide it.
4. Resale of a returned device carries the original warranty end; `restart` only by the owner (a purchased plan on the new line raises `RESTART_SUGGESTED`, never a silent restart).
5. The preparation gate ships OFF; the owner switches it on with a cutover date.
6. Serial-policy writes are owner-only.

**Who "the owner" is (S1, DECISIONS row 185).** Every owner-only serial act —
the exceptions (`/serials/override`, unlink outside the window), the serial
policy (`PUT /api/admin/taxonomy/catalogs/:id/serial-policy`, product and
import `serialized`), the §19 gate setting, warranty restart — uses S1's rule
for owner-only acts that carry no cost: `isOwner` on an admin row
(`requireOwner`, `userPatchRefusal`), not the verified-owner rule of cost
(`canViewCost`). No serial answer carries a cost, a lot cost or a margin
(`serialPrepPrivacy`; the GET and write sweeps of `tests/costRoleMatrix*.test.ts`).
The refusal code is the programme contract's `OWNER_ONLY` (its three sentences
in `packages/contracts/src/costRefusals.ts`), and the server sends the
contract's one sentence for it (`serverMessage`, as S1's `ownerOnly()` does) —
`IDEMPOTENCY_MISMATCH` the same: one code, one sentence, from every door. The router is classified in `tests/routeClass/serials.ts`
(`op`, the override `owner`) and the policy route in `tests/routeClass/catalogue.ts`.

## Screens

Every word is in ar / en / ckb (`src/components/adminOrders/serials/strings.ts`;
refusals by code from `src/lib/refusalStrings.ts`, with the brief's Arabic).

- **Order window → «الضمان والأرقام التسلسلية»** (`UnitSerialSlots`, rendered by
  `adminWarranty/WarrantySection` before delivery): one row per physical unit.
  An empty unit is ONE capsule control: a field that takes a USB / Bluetooth /
  keyboard-style reader or typing (Enter, or Tab from a reader), with the
  camera button inside it. A reader's burst is rebuilt from the physical keys
  (`wedge.ts`), so an Arabic or Sorani keyboard layout cannot garble it. After
  a link the cursor moves to the next empty unit, never after a BOX SN. A
  linked unit shows ✓, the serial (whole or masked, as the server decided),
  «تغيير» / «إزالة» and its chips (warranty starts at delivery, a returned
  device's carried end, the batch). Each line card carries a «الأرقام n/m» chip.
- **Camera sheet** (`SerialScanSheet`): the shared lazy `BarcodeScanner` in a
  bottom sheet pulled down by its header; guide frame, torch where the camera
  has one, tap to focus, photo fallback, typed field, «استخدم قارئًا أو لوحة
  مفاتيح». One read, then the camera stops; the sound and the light tap follow
  the SERVER's answer. A refusal stays with «امسح مجددًا»; the owner also gets
  the matching exception with a mandatory reason.
- **Stages tab**: the §19 blocker card (only while the gate applies) lists the
  missing units with «اذهب إلى الوحدة»; a refused stage move or legacy status
  correction shows the same refusal, and the owner may proceed with a reason.
- **Serial / warranty page** (`adminWarranty/serial/SerialDetail`, a sheet):
  from a linked unit, the units view and the serial inventory. Identity,
  whereabouts, warranty, batch (no cost) and the whole history.
- **Policy**: product form «تتبّع الرقم التسلسلي» and the section editor's
  three-way policy, editable by the owner only (others see a lock); the gate
  switch with its cutover date sits on the serial inventory panel.
- **Orders board**: each row on the shelf (confirmed / processing) carries
  «الأرقام n/m» (`boardSerialCounts` — three reads for the whole page, the same
  slot rule as the order window). It opens the order. When the owner's gate
  would refuse the row's one-tap move (`holds_next`), the chip turns amber and
  the move button is not drawn.

**Pressed and photographed**: `tests/browser/serial-prep.html` mounts the real
screens on canned answers that follow the server's contract, and
`scripts/e2e-serial-prep.mjs` drives them in Arabic, English and Sorani, dark
and light, 390 and 1280 px (the Sorani pass with reduced motion): a reader's
burst, the BOX SN rule, refusals and the owner's exceptions, the camera sheet —
including a real camera read through Chromium's fake device filming a label —
the serial page, remove, re-open, the gate, the board chip, the gate switch and
both policy controls.

    npx vite --port 4191 --host 127.0.0.1 &
    node --import tsx scripts/e2e-serial-prep.mjs

## Known limits / owner questions

- The serial INVENTORY list (and «أجهزة الطلبات») still shows assistants the whole serial, as before this feature: the list is keyed by the serial and assistants register stock there. Masking it is the owner's call; the serial page itself now follows owner default 3 everywhere on it.
- The inventory's bulk add now refuses a product barcode of any length and a box-SN-shaped value in the serial column (the same reading as the scan). A non-Bambu device whose real serial looks like a Bambu box SN (`B` + 4 digits + a letter …) can no longer be filed — say so if the shop sells such brands. The post-delivery and replacement doors read through the same canonicaliser (no `/ . _`, 6 characters at least).
- The inventory panel has no Sorani table (pre-existing: Sorani readers get its Arabic). Its two new bulk problems (a product barcode, a box SN in the serial column) carry their own Sorani (`PROBLEMS_CKB` / `problemText` in `src/components/adminWarranty/serialInventory/model.ts`).

- Trade-in completion does not close the traded unit yet (`traded_in` is in the CHECK list): reselling a traded-in device needs the owner's `delivered_device` override.
- Phase 2 (with the inventory programme): the owner batch re-pin that moves the accounting allocation; until then the owner's `batch` exception records the mismatch without re-pinning.
- Open `warranty_claims` on a returned unit are left to the claims workflow.
- Re-open does not take stock again (pre-existing, DECISIONS 184(15)); the slot shows `STOCK_NOT_RETAKEN`.

## Live checks after the deploy (read-only)

```sql
-- the migration landed
SELECT name, type FROM sqlite_master WHERE name IN
  ('serial_assignments','ux_serial_assignments_serial_pending','ux_serial_assignments_slot_live','trg_orders_serial_assignments_cancelled');
-- no serial live twice, no live binding on a cancelled order
SELECT serial_norm FROM serial_assignments WHERE released_at IS NULL AND activated_at IS NULL GROUP BY 1 HAVING COUNT(*) > 1;
SELECT COUNT(*) FROM serial_assignments a JOIN orders o ON o.id = a.order_id WHERE a.released_at IS NULL AND o.status = 'cancelled';
-- critique M7: keys stored before the normaliser's last rules (the scan treats them as the same device)
SELECT serial_norm FROM device_serials WHERE serial_norm GLOB '*[^0-9A-Z]*';
SELECT serial_norm FROM warranty_receipts WHERE status IN ('draft','active') AND serial_norm GLOB '*[^0-9A-Z]*';
```

## Tests

Every case runs the real routes over the real migrations (`tests/fixtures/serialPrep.ts`).

| File | What it proves |
|---|---|
| `serialPrepScan` | §32.1, 2, 4, 5, 6/7, 13, 14, 15, 16, 17, 19; the window and its SQL twin; the hardened doors; old-form keys (M7) |
| `serialPrepBrief` | the brief's twenty tests as one map (a §32 item with no test fails the suite); §32.3 through the gate to three warranty units, §32.6 with the stock return, §32.9 receipt-only, §32.11 camera pixels → route, §32.12 USB / Bluetooth reader on an Arabic layout, §32.13 typing, §32.14 after delivery, §32.17 the lot, §32.20 the whole timeline with actors and the §25 keys |
| `serialReturnWarranty` | §32.8 activation, H3, §32.9 delivered devices, §32.10 return, quarantine, M6, L3, M5 |
| `serialPrepCanonical` | H1: one canonicaliser for the four sources and the change / override / post-delivery / replacement doors; one asset for every written form; box ↔ serial collisions, inside the batch too; L10, L16 |
| `serialPrepGate` | H2: serials freeze for staff once a courier shipment exists (also when it lands mid-batch); the courier door refuses before the courier is called, the owner's reason is audited, an unlink during the call is recorded as a breach; the legacy door's in-batch fence; what is and is not gated; the switch; M1 lot conflicts; M8, M9 |
| `serialPrepRaces`, `serialPrepConcurrency` | §32.18 and §24: requests run concurrently, and each race also deterministically both ways (`afterReadsOf`: B reads, A commits, B's batch lands) — same serial on N orders, one slot two serials, scan vs cancel, scan vs a stage move, change vs remove, remove vs the gated move, the owner's take vs staff, a double tap, three activations at once |
| `serialPrepPrivacy` | masked serial for assistants on every serial surface, order numbers to the owner only (§10, §11), every exception and policy write owner-only, the `receive` capability, customers locked out, no cost figure or cost field in any serial answer |
| `serialPrepCritique` | H4, M2, M3, M4, M13, M15, M1 / L14 flags, L6 |
| `serialPrepDeployAhead` | the code on the database one migration behind: every new door 503, HEAD behaviour everywhere else, and the feature live the moment the migration lands (no cached «not installed») |
| `serialPolicy`, `serialPrepBoard`, `serialPrepUi` | §29 policy; the board chip; the screens (wedge, sources, strings, Sorani) |
| `serialLandingReview` | the landing reviews' findings, one test each by name: a new product's flag (form create), the echo that must not pin an inherited answer, the import sheet's section policy and re-filing, the TXT template, the serial page masked at every depth (and the rebuilt «added» row's id), the contract's one sentence, re-parenting a section, the products-v2 catalog editor's printer flag and re-parent |
| `serialPrepReview` | the three reviews' findings, one test each by name: re-delivery without a scan, the registration a cancel revoked, the post-delivery / replacement / void doors re-checked inside their writes, a lot recorded after the scan, take-from-order's window, the fence under an unneeded reason, a change on a full line, op_id retries, atomic activation, in-batch adoption, the canonicaliser on returns and bulk add, placement by category, the masked serial page, re-link by binding; and the screens (focus, the queued burst, warnings until «تم», accessible names, plurals) |

## Renumbering

Only the file name and `worker/lib/schemaVersion.ts` (`EXPECTED_MIGRATION`,
`EXPECTED_MIGRATION_COUNT`) carry the number. The tests find the migration by
its name (`SERIAL_MIGRATION` / `BEFORE_SERIALS` in
`tests/fixtures/serialPrep.ts`), so the deploy-ahead tests keep building the
database one migration before it with no edit.
