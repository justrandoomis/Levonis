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
| `POST /api/admin/orders/:id/serials/scan` | admin with the `receive` capability (`requireSerialWrite`; refused as `SERIAL_WRITE_NOT_ALLOWED`, translated on every serial screen) | `{order_item_id, unit_index, part?, code, ean?, box_sn?, source, op_id}` → `outcome: created · existing · already`. «أعد ربطه» sends `previous_assignment_id` (a released binding of this order and unit) instead of `code`, so the screen re-links a free device without sending its serial. |
| `POST /api/admin/orders/:id/serials/change` | same | `{assignment_id, code, …, op_id}` — the old binding is released in the same batch; a failed new link leaves it intact. A retry with the same `op_id` answers the link it made (`already`), as does the override's. |
| `POST /api/admin/orders/:id/serials/unlink` | same; owner only outside the window or once a courier shipment exists (reason 5–500) | targets the assignment id, so a replay can never release a newer link. |
| `POST /api/admin/orders/:id/serials/override` | owner only, reason 5–500 | `kind: take_from_order · delivered_device · unavailable · outside_window · batch · model_family`, optional `warranty_mode: carry` (`restart` → 409 `WARRANTY_RESTART_RETIRED`, owner decision 3); audited inside the batch. |
| `GET /api/devices/admin/serial-inventory/:serial` | admin | the §16 page: `story` (status, current/previous orders, warranty, lot, full timeline). The whole serial for EVERY admin — the owner, full scope and assistants (owner decision 1, 2026-10-09; DECISIONS row 192), in the `row`, the story and every serial a history line names. Order ids for the owner and full-scope admins only (`orderRefs` = `canMoveMoney`, option A) — in the `row` too and at any depth of a history row. The serial-masking half of `maskedDetail` stays in the code as defence in depth and is shown to no admin today. What the viewer sees is decided by the viewer alone (and, before 0178, HEAD's row); a story that fails to read answers 503 `SERIAL_STORY_UNAVAILABLE`, never an unfiltered page. Answers devices known only to `device_serials` too. |
| `GET /api/devices/admin/units/:unitId/history`, `GET /api/admin/warranties/:id` | admin | the unit's and the receipt's audit trail, filtered exactly as the serial page filters its history (`maskedDetail`, viewer by `serialActor`): every admin reads the serials whole (decision 1); an assistant gets no order numbers. |
| `POST /api/devices/admin/serial-inventory/commit`, `/scan`, `/link-ean` | admin with the `receive` capability (`requireSerialWrite`, decision 1) | the inventory's intake doors: adding a serial follows `receive` like the preparation scan (the owner always passes, a missing row allows, `allowed = 0` refuses). `/preview`, `PATCH /:serial`, `/:serial/void` and `/:serial/restore` keep their own gates. |
| `POST /api/devices/admin/units/:unitId/serial` | admin with the `receive` capability (decision 1); owner to take a serial off an open warranty, in EITHER direction (the serial's old unit, or this unit's own serial) | a delivered order's open unit only (`ORDER_NOT_PREPARABLE` / `UNIT_NOT_OPEN`), the one canonicaliser, no live preparation binding elsewhere — re-checked inside the batch. |
| `POST /api/devices/admin/units/:unitId/replace` | admin; with `new_serial`, admin with the `receive` capability (`requireSerialWrite`, decision 1 — naming a new serial adds it: its asset row and an activated binding) | the replacement serial's bindings are re-checked inside the batch. A replacement with no new serial keeps the gate it always had. |
| `POST /api/admin/stock-operations/serial-link` | `receive` | a serial with a live binding takes only a lot that binding's line was allocated (`SERIAL_BATCH_MISMATCH`); a pending binding takes it as its verified lot in the same batch (an inferred lot on that lot trades places; a lot full of verified serials refuses). |
| `POST /api/devices/admin/serial-inventory/:serial/warranty-mode` | owner | `carry` only (puts back a binding saved as `restart` before owner decision 3); `restart` → 409 `WARRANTY_RESTART_RETIRED`. Activation carries a legacy `restart` binding anyway. |
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
an owner override named, or a TRADED-IN unit — owner decision 3), marks the
assignment activated only if the pointer really moved, and then: carry — the
previous unit's start and end (plus a paid extension the new line bought),
base and ext, `carried:'original_end'` + `resale_of` + `origin_unit_id` /
`origin_start_at`, and the used-sale cover of a condition listing kept apart
(`used_sale`) — written by `carriedWindow` (worker/lib/deviceCustody.ts), which
`createUnitsOnDelivery` already used to give the unit that window at birth
(S8: no reset window between the two batches); a traded-in or returned prior
unit is NOT closed, its live receipt becomes `replaced` (`resold`) and any
link left on it is revoked; an owner override of any other open unit closes it
(receipt voided, registration revoked),
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
branches), else off. Owner only: the section policy, the product's flag, a
re-filing that flips the answer for a product with no word of its own, a
printer flag that flips one (both catalog editors: `POST
/api/admin/taxonomy/catalogs` and `PATCH /api/admin/products-v2/catalogs/:id`
— a product filed under that catalog, by placement or by its section, whose
own word is silent and that is not a printer through another catalog; the flag
is not inherited down the tree), and moving a section under a parent whose
policy flips one of its products. Both editors judge a save as ONE edit
(round 4, `catalogEditSerialFlips`): every product under the catalog is
resolved by `lineDevicePolicy` before and after with the new flag AND the new
parent applied together, so switching a printer catalog off and moving it out
of a 'required' branch in one request is refused when the two together flip a
product (`details.via = printer_flag_and_reparent`), and passes when together
they flip nothing. A save that changes one of them is judged exactly as in
round 3 (`printerFlagSerialFlips` / `reparentSerialFlips` are that call with
one key). A printer flag that flips nothing — an echo, an empty catalog, one
whose products all carry their own word, and every NEW catalog (it holds no
product) — is anyone's. Every product door judges a
non-owner's write by ONE rule, `serializedWriteVerdict`
(worker/lib/serialPolicy.ts): the form on create and on update (by
`serialized` or `ops_policy.serialized`), the ops-policy route, the placement
route, the import sheet, the TXT template, and the two composition editors —
the bundles panel and the mystery-offer panel (`compositionSerializedVerdict`:
a body that does not mention `serialized` keeps the stored word; the filing is
the `catalog_ids` the bundles panel writes, else the stored shelves, with the
document's section). A non-owner never changes the product's own word: an echo
of the effective answer passes and is NOT written down, so a product that
inherits its answer keeps following its section.

USED / OPEN BOX / REFURBISHED (owner decision 4, 2026-10-09; DECISIONS row
192). `printerWarrantyRules` in worker/lib/warrantyPlans.ts fills
`serialized = true` on a graded product whose word is silent ONLY when it is
a printer — and a printer already answers «needs a serial», so that fill
changes no answer. A graded non-printer gets no word: its section policy or
the owner's own setting decides at read time — an AMS section set to
«required» covers AMS-like devices — and an ordinary accessory stays off.
No name matching (AMS is never inferred), whoever saves the grade, through
the form, the import sheet or the admin product route. Nothing stored is
bulk-changed: a product that already carries `serialized = true` from an
earlier grade keeps it until the owner switches it off on the product. The
product form shows one read-only line under the grade («تتبّع الرقم
التسلسلي: مفعّل — لأنه طابعة» …, `gradedSerialAnswer` in
src/components/adminProducts/form/ConditionSection.tsx; a printer is «لأنه
طابعة» unless its own word is `false`, and the section is named in the form's
language), and the section editor says that a used device needing a serial
needs its section set to «مطلوب» — the same hint shows under a graded listing
that is off only by default.

BEFORE THE PUSH (owner, decision 4): no section ships `required` (migration
0178 seeds none). A used AMS graded after the push in a section still on
«وراثة» gets no preparation slot, no unit at delivery and no warranty
receipt, while the warranty policy (v3) promises a used device the period
stated on its page and its receipt. Set every section that holds AMS units or
another device that needs a serial to «مطلوب» before (or with) the push — the
read-only query under «Live checks» lists them. Products graded before the
push keep the `true` they already carry.

The import sheet (round 3): a row writes the product's stored placements minus
the section pair it had, plus the pair the sheet states (`importPlacements`) —
an extra shelf (a printer catalog held beside a plain section) is never
dropped by a price row, and a new product gets exactly the sheet's pair. The
preview judges §29 on that set (`serialImportIssue`); the confirm re-reads the
LIVE row — its shelves, and every `ops_policy` key the row's own cells did not
set (`serialized` only when the row's cell set it) — and re-judges a
non-owner's row against it, failing that row alone, by line, with the
preview's sentence. Round 4: a row whose cells name NO section (the columns
absent or empty — the preview records it in `cells.section`) keeps the LIVE
section pair and shelves, so a re-filing made after the preview is never
undone, and the re-check judges exactly that filing; a row that names a
section moves the product as before. Each row's write is conditioned on the
`ops_policy` it re-read (a fence first in that row's batch): a word written
between the re-read and the write fails that row alone with
`IMPORT_ROW_CHANGED_RETRY` (ar / en / ckb, «upload the sheet again»), never
the word; the rest of the sheet is written. This applies to every importer —
it is a lost-write guard, not a §29 refusal.

WRITE-TIME FENCES (round 4). The verdicts above are reached on reads, and two
non-owner requests each judged before the other committed could together flip
a product (a placement into an empty catalog while its printer flag is
switched on). Every non-owner write a verdict allows now re-asserts the
invariant INSIDE its own batch (`serialAnswerFence`, worker/lib/serialPolicy.ts):
the set of products in scope whose effective answer is «needs a serial» —
by the resolver's SQL twin, `serializedProductSql` — is read with the
verdict, and the batch checks it is still that set just before and just after
its own statements. Scope: the product, for the product doors (placement
route, form update, bundles and mystery editors, TXT template update, each
import row); the products filed under the catalog — under its subtree when it
moves — for the two catalog editors. A D1 batch is one transaction, so equal
sets on both sides mean the write flipped nothing, whatever ran in between and
whichever input changed (a placement, a flag, a policy, a parent, the owner's
word). After a product write, a product that carries its OWN word passes the second
check: its answer is that word, which no placement, flag, policy or parent can
move — the stored word the verdict kept, or the used-printer fill above, which
writes the answer the printer already had. The word itself is not fenced: a save that
read the product just before the owner changed its word can write the old word
back (see Known limits). A lost race answers 409 `SERIAL_FILING_CHANGED` (the contract's three
sentences; the admin screens render it by code), and an import row fails
alone with `IMPORT_ROW_CHANGED_RETRY`. A create has no answer to keep and is
not fenced. The owner's writes carry no fence and no new read.

Refusals: 403 `OWNER_ONLY` with `details.via` = `flag`, `placement`,
`reparent`, `printer_flag` or `printer_flag_and_reparent` (`details.products`
= how many products flip); 409 `SERIAL_FILING_CHANGED` for a non-owner write
that lost its in-batch fence;
the import sheet refuses by line in ar / en / ckb
(`IMPORT_SERIALIZED_OWNER_ONLY`, `IMPORT_SERIAL_REFILE_OWNER_ONLY`), at the
preview and again at the confirm; the template preview shows it as its
validation error (code `OWNER_ONLY`). The admin screens that print these — the
taxonomy dialog, the product form, the section-update sheet and the import
window's TXT check — render the code from the contract in ar / en / ckb
(`contractRefusal`, src/lib/refusalStrings.ts) and keep the server's own
sentence for every other code.

Bundle and mystery PARENT lines never get warranty units of their own: the
parent is the composition row (no stock, no options, never reserved) and the
physical items are its component lines, which carry the real product. So
delivery (`createUnitsOnDelivery`) and its SQL twin, the delivered-units
sweep, skip a line other lines hang off — the same predicate as the
preparation slots and the board.

## Owner defaults (changeable later, no migration)

1. A Combo carries ONE serial — the box Product SN. `part='ams'` / `part_index` exist in the schema; the routes refuse them until the owner decides.
2. AMS: no name inference. The owner sets `required` on the section holding AMS products.
3. Every admin — the owner (INITIAL_ADMIN_EMAIL), full-scope (or legacy NULL-scope) admins and assistants (the preparer, support) — sees the full serial (owner decision 1, 2026-10-09; DECISIONS row 192): `canSeeFullSerial` in worker/lib/adminScope.ts (`serialActor.fullSerial`). A serial is no cost, so the owner-only cost predicates never decide it. Order numbers on the serial page and in serial histories stay with `canMoveMoney` (`serialActor.orderRefs`; option A). Adding, changing or removing a serial follows the `receive` capability on every door that writes one — the preparation scan, change and unlink, the inventory's commit, scan and link-EAN, the post-delivery assign, and a warranty replacement that names a new serial (`requireSerialWrite`, worker/lib/operations.ts) — refused as `SERIAL_WRITE_NOT_ALLOWED`, which every serial screen renders in ar / en / ckb; sensitive edits and exceptions keep their gates and their audit. Customers and visitors see the masked serial as before.
4. Resale carries the original start and end; there is no restart (owner decision 3, 2026-10-09; DECISIONS row 193). A returned or traded-in device sold again keeps the SAME warranty — start, end, base and ext — with its origin named; a paid extension the new line buys is added to the original end; a used listing's own months are a separate `used_sale` cover (a claim is accepted while either runs). `restart` is refused everywhere (409 `WARRANTY_RESTART_RETIRED`), the owner included.
5. The preparation gate ships OFF; the owner switches it on with a cutover date.
6. Serial-policy writes are owner-only.

**Who "the owner" is (S1, DECISIONS row 185).** Every owner-only serial act —
the exceptions (`/serials/override`, unlink outside the window), the serial
policy (`PUT /api/admin/taxonomy/catalogs/:id/serial-policy`, product and
import `serialized`), the §19 gate setting, the resale warranty mode (`carry` only since decision 3) — uses S1's rule
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

- ANSWERED (owner decision 1, 2026-10-09; DECISIONS row 192): assistants see full serials everywhere, so the serial INVENTORY list, «أجهزة الطلبات» and the WARRANTY RECEIPTS are no longer exceptions — the serial page, the unit history and the receipt history now show assistants the whole serial too. ORDER NUMBERS were not part of the decision: the serial page and the serial histories keep them for `canMoveMoney` (option A), while the inventory list, «أجهزة الطلبات» and one receipt's own record (`GET /api/admin/warranties/:id`, its `receipt.order_id`) still show assistants the order number, as before this feature (the receipts are found by serial, phone or order). Hiding order numbers there too is one predicate if the owner wants it.
- The inventory's bulk add now refuses a product barcode of any length and a box-SN-shaped value in the serial column (the same reading as the scan). A non-Bambu device whose real serial looks like a Bambu box SN (`B` + 4 digits + a letter …) can no longer be filed — say so if the shop sells such brands. The post-delivery and replacement doors read through the same canonicaliser (no `/ . _`, 6 characters at least).
- The inventory panel has no Sorani table (pre-existing: Sorani readers get its Arabic). Its two new bulk problems (a product barcode, a box SN in the serial column) carry their own Sorani (`PROBLEMS_CKB` / `problemText` in `src/components/adminWarranty/serialInventory/model.ts`).

- ANSWERED (owner decision 3, 2026-10-09; DECISIONS row 193): a trade-in does NOT close the unit — `warranty_closed_reason = 'traded_in'` is never written (the value stays in the CHECK list, unused). The traded-in state is DERIVED from `trade_in_requests` (status `completed`, scope not `ams_only`; `tradedInSql` in worker/lib/deviceCustody.ts), so trade-ins completed before the decision count too. Completion (whole / printer_only) revokes the trader's link and releases the activated binding as `traded_in` (`trade_in:<id>`), with `serial.traded_in` history, in the request's own fenced batch; the warranty dates, closure and receipt are never touched. Every customer door then treats the unit as the shop's (`/mine`, `/eligible`, `/register` by serial or receipt — the one non-enumerating answer, the trader included —, `/units/:id/register` and claims → 409 `DEVICE_NOT_WITH_CUSTOMER`, the support card); the inventory reads it `returned`; staff resell it without an exception (`classifyLink`), on the new product's listing or a condition listing of it (`condition_doc.new_product_id`, S12). `printer_only` is treated like `whole` (the serial is the printer's). The serial check at trade-in (plan S13) is NOT built: it would add a mandatory staff step the owner did not ask for.
- Phase 2 (with the inventory programme): the owner batch re-pin that moves the accounting allocation; until then the owner's `batch` exception records the mismatch without re-pinning.
- Open `warranty_claims` on a returned unit are left to the claims workflow.
- Re-open does not take stock again (pre-existing, DECISIONS 184(15)); the slot shows `STOCK_NOT_RETAKEN`.
- The product import's D1 budget (pre-existing, measured by the round-3 review, NOT introduced by this branch): the preview's `loadExisting` binds more than 100 parameters in one statement once a sheet holds more than about 50 rows, over D1's per-statement limit; the confirm prepares about 58–62 statements per row. Round 4 adds, per non-owner update row, one read and four in-batch fence statements (the answer fence), and per update row of any importer two more (the ops_policy fence). Large sheets are bounded by these, not by `MAX_PRODUCTS`; splitting a sheet is the workaround until the import is batched.
- The ops-policy route (`POST /api/devices/admin/products/:id/ops-policy`) writes the whole `ops_policy` from its own read, like the import did before round 4: a non-owner's `warranty_base_months` written in the same moment as the owner's word can carry the old word back. Not changed in round 4 (the finding was the import's); the same fence would close it.

- SAME-MOMENT SAVES (round-4 review, accepted as known limits): the fences above stop a non-owner's write from FLIPPING an answer through placements, flags, policies or parents, but several doors still write fields they read a few milliseconds earlier, so a non-owner's save that runs at the same moment as an owner's change can carry the old value back — the classic last-save-wins of every save in the shop, not something a non-owner can aim. Known cases: the product form, bundles, mystery offers and the TXT template copy `ops_policy` from their first read, so the owner's new `serialized` word can be written back (the own-word exception of the answer fence lets it through); both catalog editors rewrite `is_printer_catalog` and `parent_id` from their own read on every save, including a plain rename or the «active» toggle, so an owner's flag or move made in that moment can be undone; an import row that names no section can write back a section pair the owner changed between the confirm's re-read and that row's batch (the shelves stay the owner's, so section and shelves can disagree until the next save); deleting an empty catalog is not fenced against a product filed into it in the same moment (the placement cascades away); and the catalog-edit verdict counts a product filed under a catalog only by `category_id` (no shelf row) as becoming a printer, which the resolver never does — an extra 403 for a non-owner, never a wrong answer. Closing them means the same value-compared write condition on each door (`WHERE … AND ops_policy IS ?`, `… AND is_printer_catalog = ? AND parent_id IS ?`) with a retry message.

- ANSWERED (owner decision 4, 2026-10-09; DECISIONS row 192): a used / open-box / refurbished grade turns serial tracking on by itself for a printer only; every other graded product follows its section policy or the owner's own setting (§29 above). Products graded before the decision that already carry `serialized = true` are not changed; the owner may review them.
- The TXT template carries no grade: its export writes no `condition_*` lines for a product, and an update through it writes `condition_doc` back to new (`{}`), un-grading a used listing (pre-existing; seen while testing decision 4, not changed here). Grade products through the form or the import sheet until it is fixed.

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
-- owner decision 4 (run BEFORE the push too): every non-printer section holding an AMS product, with its
-- serial policy — each one still 'inherit' must be set to «مطلوب» or a used AMS graded there is not tracked
SELECT c.id, c.name_ar, c.serial_policy, COUNT(DISTINCT p.id) AS products
  FROM catalogs c
  JOIN products p ON p.id IN (SELECT pc.product_id FROM product_catalogs pc WHERE pc.catalog_id = c.id)
                  OR c.id IN (p.category_id, p.sub_category_id)
 WHERE c.is_printer_catalog = 0 AND (p.name LIKE '%AMS%' OR p.name_ar LIKE '%AMS%')
 GROUP BY c.id ORDER BY c.serial_policy, c.name_ar;
-- owner decision 1: admins whose «الاستلام» is off — each is refused every serial write door
SELECT user_id FROM ops_permissions WHERE capability = 'receive' AND allowed = 0;
-- owner decision 3 census (run BEFORE the push too; nothing is changed by it — a real
-- reset window found here is a per-unit audited correction the owner decides, never a bulk update):
-- C1 completed trade-ins whose device is still linked to an account (every door now refuses them anyway)
SELECT t.id, t.scope, t.completed_at, u.id AS unit_id, r.user_id
  FROM trade_in_requests t
  JOIN order_item_units u ON u.order_item_id = t.order_item_id AND u.unit_index = t.unit_index
  JOIN device_registrations r ON r.unit_id = u.id AND r.revoked_at IS NULL
 WHERE t.status = 'completed' AND t.scope <> 'ams_only';
-- C2 resales whose window moved (a carried unit whose start is not its previous unit's start)
SELECT u.id, u.warranty_start_at, pu.warranty_start_at AS original_start, u.warranty_end_at, pu.warranty_end_at AS original_end
  FROM order_item_units u JOIN order_item_units pu ON pu.id = json_extract(u.policy_version, '$.resale_of')
 WHERE json_valid(u.policy_version) AND json_extract(u.policy_version, '$.carried') = 'original_end'
   AND (u.warranty_start_at IS NOT pu.warranty_start_at OR u.warranty_end_at < pu.warranty_end_at);
-- C3 any binding ever saved as `restart` (activated = a warranty that was restarted)
SELECT id, serial_norm, order_id, activated_at FROM serial_assignments WHERE warranty_mode = 'restart';
-- printer_only trade-ins (treated like `whole`; raise with the owner if any)
SELECT COUNT(*) FROM trade_in_requests WHERE status = 'completed' AND scope = 'printer_only';
```

## Tests

Every case runs the real routes over the real migrations (`tests/fixtures/serialPrep.ts`).

| File | What it proves |
|---|---|
| `serialPrepScan` | §32.1, 2, 4, 5, 6/7, 13, 14, 15, 16, 17, 19; the window and its SQL twin; the hardened doors; old-form keys (M7) |
| `tradeInWarrantyContinuity` | owner decision 3: the trade-in leaves the warranty open (11 months / 335 days on day 30), revokes the link, releases the binding `traded_in`, one fenced batch; every customer door refuses the traded-in device; AMS-only leaves it; resale on a used listing without an exception carries start, end, base, ext and origin, replaces the old receipt, keeps `used_sale` apart (a claim accepted while either runs), a second resale keeps the origin; +12 bought → original end + 12; restart refused; S8 no reset window; S9; completion `op` for every admin |
| `serialPrepBrief` | the brief's twenty tests as one map (a §32 item with no test fails the suite); §32.3 through the gate to three warranty units, §32.6 with the stock return, §32.9 receipt-only, §32.11 camera pixels → route, §32.12 USB / Bluetooth reader on an Arabic layout, §32.13 typing, §32.14 after delivery, §32.17 the lot, §32.20 the whole timeline with actors and the §25 keys |
| `serialReturnWarranty` | §32.8 activation, H3, §32.9 delivered devices, §32.10 return, quarantine, M6, L3, M5 |
| `serialPrepCanonical` | H1: one canonicaliser for the four sources and the change / override / post-delivery / replacement doors; one asset for every written form; box ↔ serial collisions, inside the batch too; L10, L16 |
| `serialPrepGate` | H2: serials freeze for staff once a courier shipment exists (also when it lands mid-batch); the courier door refuses before the courier is called, the owner's reason is audited, an unlink during the call is recorded as a breach; the legacy door's in-batch fence; what is and is not gated; the switch; M1 lot conflicts; M8, M9 |
| `serialPrepRaces`, `serialPrepConcurrency` | §32.18 and §24: requests run concurrently, and each race also deterministically both ways (`afterReadsOf`: B reads, A commits, B's batch lands) — same serial on N orders, one slot two serials, scan vs cancel, scan vs a stage move, change vs remove, remove vs the gated move, the owner's take vs staff, a double tap, three activations at once |
| `serialPrepPrivacy` | the whole serial for every admin on every serial surface (decision 1), no order numbers on an assistant's serial page, order numbers in refusals to the owner only (§10, §11), every exception and policy write owner-only, the `receive` capability, customers locked out, no cost figure or cost field in any serial answer |
| `serialVisibilityRoles` | decision 1 (row 192): the matrix of owner / full / assistant / preparer / support over every admin serial surface, order numbers by `canMoveMoney`; the receipt's own `order_id` pinned as the documented exception; customers, merchants and visitors unchanged; `receive` on every serial write door — a replacement naming a new serial and the preparation unlink included — refused as `SERIAL_WRITE_NOT_ALLOWED`, edits on their old gates, the owner never locked out; every exception owner-only and audited; no cost to the newly unmasked roles; the predicate and its static nets |
| `serialPrepCritique` | H4, M2, M3, M4, M13, M15, M1 / L14 flags, L6 |
| `serialPrepDeployAhead` | the code on the database one migration behind: every new door 503, HEAD behaviour everywhere else, and the feature live the moment the migration lands (no cached «not installed») |
| `serialPolicy`, `serialPrepBoard`, `serialPrepUi` | §29 policy, and decision 4 (a graded printer tracked, a graded accessory not, a graded AMS by its «required» section — the form, the import sheet, the shared guard; no preparation slot and no unit for a graded accessory); the board chip; the screens (wedge, sources, strings, Sorani, the graded listing's tracking line — a saved printer «because it is a printer», the section named per language, the hint when off by default — and the section hint; `SERIAL_WRITE_NOT_ALLOWED` in three languages on the inventory panel, the camera sheet, «أجهزة الطلبات» and the warranty section) |
| `conditionRules` | the grade's warranty rules, and decision 4 at the rule itself: a grade fills `serialized` for a printer only; an explicit word is never overwritten |
| `serialLandingReview` | the landing reviews' findings, one test each by name: a new product's flag (form create), the echo that must not pin an inherited answer, the import sheet's section policy and re-filing, the TXT template, the serial page masked at every depth (and the rebuilt «added» row's id), the contract's one sentence, re-parenting a section, the products-v2 catalog editor's printer flag and re-parent |
| `serialLandingReview2` | round 3, one test per finding: the printer flag judged by its flips (empty catalog, worded products, a silent product, create); the import keeping extra placements (price row, owner, a move) and re-reading the live row at confirm (an owner's later word survives; a row the live row refuses fails alone); OWNER_ONLY in ar / en / ckb on the admin screens; the unit history and the warranty receipt masked; the serial page's 503 when its story fails; the bundle and mystery editors' §29 check; no units for a bundle parent (delivery and the sweep). Round 4: a flag and a re-parent judged as one edit (refused together, the halves alone as before, a whole that flips nothing passes, the owner); the write-time fence both ways (`afterReadsOf`: placement vs printer flag on both catalog editors, the product form), no fence and no new statement on the owner's writes, the used-grade door under decision 4 (a graded accessory gets no word, a graded printer still writes `true` and passes the fence), `SERIAL_FILING_CHANGED`'s three sentences; the import confirm failing only the row whose ops_policy changed under it; a sheet with no section keeping the live filing |
| `serialPrepReview` | the three reviews' findings, one test each by name: re-delivery without a scan, the registration a cancel revoked, the post-delivery / replacement / void doors re-checked inside their writes, a lot recorded after the scan, take-from-order's window, the fence under an unneeded reason, a change on a full line, op_id retries, atomic activation, in-batch adoption, the canonicaliser on returns and bulk add, placement by category, the masked serial page, re-link by binding; and the screens (focus, the queued burst, warnings until «تم», accessible names, plurals) |

## Renumbering

Only the file name and `worker/lib/schemaVersion.ts` (`EXPECTED_MIGRATION`,
`EXPECTED_MIGRATION_COUNT`) carry the number. The tests find the migration by
its name (`SERIAL_MIGRATION` / `BEFORE_SERIALS` in
`tests/fixtures/serialPrep.ts`), so the deploy-ahead tests keep building the
database one migration before it with no edit.
