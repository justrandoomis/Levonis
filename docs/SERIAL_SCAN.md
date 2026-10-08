# Serial scan at order preparation — server

Owner brief 2026-10-07 (33 sections): every printer / AMS unit in an order is
bound to its real serial while the order is prepared, by camera, a USB or
Bluetooth scanner, or typing. Design: the serial-scan spec with both critiques
applied. Code: `worker/lib/serialAssignments.ts` (the rules),
`worker/lib/serialPolicy.ts` (which products need a serial),
`worker/routes/adminOrderSerials.ts` (the doors), migration
`0177_serial_assignments.sql`.

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
| `GET /api/admin/orders/:id` | admin | adds `serials` (slots, linked, gate, re-open suggestions) through `soft()`; `installed:false` before 0177. |
| `GET /api/admin/orders/:id/serials` | admin | the same view alone. |
| `POST /api/admin/orders/:id/serials/scan` | admin with the `receive` capability | `{order_item_id, unit_index, part?, code, ean?, box_sn?, source, op_id}` → `outcome: created · existing · already`. |
| `POST /api/admin/orders/:id/serials/change` | same | `{assignment_id, code, …, op_id}` — the old binding is released in the same batch; a failed new link leaves it intact. |
| `POST /api/admin/orders/:id/serials/unlink` | same; owner only outside the window or once a courier shipment exists (reason 5–500) | targets the assignment id, so a replay can never release a newer link. |
| `POST /api/admin/orders/:id/serials/override` | owner only, reason 5–500 | `kind: take_from_order · delivered_device · unavailable · outside_window · batch · model_family`, optional `warranty_mode: carry · restart`; audited inside the batch. |
| `GET /api/devices/admin/serial-inventory/:serial` | admin | the §16 page: `story` (status, current/previous orders, warranty, lot, full timeline); order ids and the full serial for the owner and full-scope admins only. Answers devices known only to `device_serials` too. |
| `POST /api/devices/admin/serial-inventory/:serial/warranty-mode` | owner | `carry` (original end, default) or `restart` for a resold returned device, while its new binding is not delivered. |
| `PUT /api/admin/taxonomy/catalogs/:id/serial-policy` | owner | `inherit · required · off`. |
| `PUT /api/admin/settings/serialPrepGate` | owner | `{enabled, since}`; switching on without `since` stamps now. |
| `PATCH /api/admin/orders/:id/stage`, `PATCH /api/admin/orders/:id`, `POST /api/admin/orders/:id/delivery` | as before | the §19 gate; optional `serials_override_reason` (owner). |
| `POST /api/returns/admin/:id/transition` | as before | optional `serials[]` (scanned at inspection) or `unit_ids[]`; answers `serials:{closed, unattributed}`. |

Every refusal is a code with the brief's Arabic sentence (§31, §9, §10, §11,
§17, §19) — never a trace; the screen localises by code
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
`activateOrderSerials` — one batch PER assignment, after the units committed,
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

## Preparation gate (§19)

`serialPrepGate` ships OFF. When the owner switches it on (cutover `since`),
an order created after the cutover cannot move into `out_for_delivery` /
`delivered` or get a courier shipment while a serial-required unit has no
serial, or a serial's own lot is no longer among the line's allocations. The
pre-read gives the missing list; a count fence rides the stage flip itself and
the legacy flip, so an unlink racing the move is caught inside the move. The
courier door re-checks after the shipment is stored and records a breach.
Courier sync, the cron and backward moves are not gated. Merchant orders and
bundle parents never have slots.

## Which products need a serial (§29)

Resolved at read time, never written onto products: the product's own
`ops_policy.serialized`, else a printer catalog (always on), else the nearest
section on its branch with `serial_policy ≠ inherit` ('required' wins across
branches), else off. Owner only: the section policy, the printer flag, the
product's flag (form, ops-policy route, import sheet), and a re-filing that
flips the answer for a product with no word of its own. An echo of the stored
answer is never an attempt.

## Owner defaults (changeable later, no migration)

1. A Combo carries ONE serial — the box Product SN. `part='ams'` / `part_index` exist in the schema; the routes refuse them until the owner decides.
2. AMS: no name inference. The owner sets `required` on the section holding AMS products.
3. The owner (INITIAL_ADMIN_EMAIL) and full-scope admins see the full serial; assistants the masked form.
4. Resale of a returned device carries the original warranty end; `restart` only by the owner (a purchased plan on the new line raises `RESTART_SUGGESTED`, never a silent restart).
5. The preparation gate ships OFF; the owner switches it on with a cutover date.
6. Serial-policy writes are owner-only.

## Known limits / owner questions

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

## Renumbering

Only the file name and `worker/lib/schemaVersion.ts` (`EXPECTED_MIGRATION`,
`EXPECTED_MIGRATION_COUNT`) carry the number; the deploy-ahead tests build the
pre-migration database with `dbThrough('0176')`.
