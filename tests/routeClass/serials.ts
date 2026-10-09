/**
 * ROUTE CLASSIFICATION — serials at order preparation (migration 0178, owner
 * brief 2026-10-07; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * OPERATIONS, NOT COST. Binding a device's serial to a physical unit of an
 * order is fulfilment work every admin does while the order is prepared
 * (`op`, behind the `receive` operations capability). No route of this router
 * reads or answers a cost: the answers carry the order's units, the serial
 * (whole for every admin, owner decision 1), the lot id the unit was taken from and the §19
 * gate — never a lot's unit cost, a purchase total or a margin. The GET and
 * write sweeps walk every answer and every refusal for every role.
 *
 * THE OWNER'S EXCEPTIONS. Taking a serial from another order, a delivered or
 * unavailable device, a batch or model mismatch: `POST /:id/serials/override`
 * is the owner's act alone (INITIAL_ADMIN_EMAIL on an admin row — the same
 * `isOwner` rule as S1's other owner-only acts that carry no cost), refused to
 * every other admin with 403 OWNER_ONLY before the body is read.
 */
import type { RouteClassFile } from './_types';
import { adminOrderSerialRoutes } from '../../worker/routes/adminOrderSerials';

const NEEDS_PREPARED_ORDER =
  'links, changes or unlinks a serial on a unit of an order inside its preparation window; needs an order in that window, a serial-required line and a free serial the role fixture does not seed (tests/serialPrepScan.test.ts and tests/serialPrepReview.test.ts walk them end to end); the answer carries the slot and the serial (whole for every admin — owner decision 1, 2026-10-09), never a cost';

export default {
  family: 'serials',
  mounts: [
    {
      prefix: '/api/admin/orders',
      name: 'adminOrderSerialRoutes',
      router: adminOrderSerialRoutes,
      writes: NEEDS_PREPARED_ORDER,
      routes: {
        'GET /:id/serials': 'op',
        'POST /:id/serials/scan': 'op',
        'POST /:id/serials/change': 'op',
        'POST /:id/serials/unlink': 'op',
        'POST /:id/serials/override': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } },
      },
    },
  ],
} satisfies RouteClassFile;
