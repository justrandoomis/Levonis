# Individual inventory purchase references

Requested 2026-10-11 for supplier warranty follow-up. Migration `0187_inventory_unit_origins.sql` adds optional procurement evidence; existing inventory counters, cost lots and finance allocations remain the accounting sources.

## Admin workflow

1. In a purchase line, enable **تسجيل طلب المورد والتتبع لكل قطعة**. Each unit has a supplier order number and an optional supplier tracking number, stored as text so leading zeroes survive. Units from one supplier order may share references; the shared-order helper fills blank references or explicitly replaces all. The purchase name remains separate and editable.
2. Save the purchase, then label each carton with its internal unit ID. Up to 1,000 tracked units per line and 5,000 per document; bulk goods may remain untracked.
3. At receipt, choose the units that actually arrived. Unselected units stay pending. Partial receipts and supplier shipments arriving out of order are supported. Tracked damaged/unreceived units are left pending for purchase settlement rather than silently assigned an arbitrary rejection identity.
4. Confirmation consumes oldest inventory lots and assigns available individual records from those exact lots. In admin order details, **مصدر القطع** shows the unit ID, purchase/batch name and IDs, supplier order and tracking references. Serial preparation must use the lot assigned to that unit slot, even when staff scans slots out of order.
5. Match the physical carton's internal ID and the scanned serial before marking the source verified. Automatic allocation is a planned pick; it is not proof that staff handed over that physical carton.
6. A receiving admin can update supplier references independently of frozen purchase costs. Order allocation retains the original reference snapshot and displays current references when corrected.
7. Inspection identifies the exact returned pieces. Cancellation/return releases the original assignments; a later sale creates a new episode. Unsellable returns stay unavailable. Transfers retain unit identity and source references.
8. Optional device serials use the existing camera scanner, normalization and model rules. Scanning a saved purchase unit saves immediately to that exact origin and the canonical device inventory. Repeating the same scan is idempotent; another unit cannot claim its serial. Receipt ties it to the actual cost lot without activating a warranty or changing stock twice.
9. Finalize and confirm a purchase before binding physical serials. Draft scans stay in the local draft until confirmation; up to 50 serials can accompany one confirmation, with further pieces scanned individually afterward. Once a serial is bound, the whole-document cost/quantity editor is locked because that editor replaces incoming identities. Supplier-reference and name edits remain available. Estimated purchases must finalize costs first so receipt is never blocked by a serial binding.
10. During preorder preparation, **مصدر قطع الطلب المسبق** records each piece's batch name/reference, purchase reference, supplier order, optional tracking and note. Shared defaults fill blanks. These records do not fabricate an inventory receipt or change prepaid amounts, reserved capacity or order costs. Each revision is retained, including after cancellation and eligible order cleanup.

## Financial and privacy boundaries

- Raw supplier price, route freight, extra costs, exchange-rate snapshots and exact-dinar cost segmentation use the existing calculations.
- Unit references never feed product pricing, discounts, investor shares, employee earnings or historical COGS.
- FIFO order is `received_at, created_at, id`. `created_at` resolves same-day receipts whose legacy receiving time was fixed at 09:00; the random ID is only a final tie-break.
- Provenance reads/writes require platform admin access. Assistants can read source references; reference writes use the existing receiving capability. Purchase/cost permissions remain unchanged.
- Public orders, device-unit responses and invoice snapshots remove private provenance containers/keys, including preorder sources. Customer courier tracking and established device warranty views remain available. Purchase-enrolled serials cannot be claimed through the legacy same-product customer attachment shortcut.
- Old stock is not assigned invented supplier references. Order details explicitly show quantities without individual evidence.
- Supplier reference edits retain a bounded per-unit before/after audit record. Assignment provenance and physical confirmation facts are immutable; return history survives eligible cancelled-order housekeeping.

## Validation and release

Focused tests cover FIFO 2+3+5, same-day ordering, exact cost rounding, partial/out-of-order receiving, retries and races, cancellation/restoration/resale, transfers, write-offs, mixed tracked/legacy returns, preorder preparation and revision history, permissions and public-data leakage. Serial tests exercise registration, normalization, duplicate identity, receipt, allocation and customer-claim protection. Type checks and the production frontend build are also required.

The pre-release migration gate applies all 180 migrations to a throwaway database and replays all 27 statements in 0187. `IF NOT EXISTS` protects each new table, index and trigger; the replay changes no row, value or trigger. The resulting 358 tables pass the foreign-key and orphan-catalog checks.

No production customer or supplier records are seeded. Deploy through the repository's existing guarded workflow: checks, throwaway migration validation, restore point, migrations, code deployment and live probes. A local test result does not verify existing production data. Browser visual validation was unavailable in this session because the Chromium download failed; real camera capture still requires a device check.
