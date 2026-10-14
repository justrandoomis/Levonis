import { adminOrderInventoryOriginRoutes } from '../../worker/routes/adminOrderInventoryOrigins';
import { adminPreorderOriginRoutes } from '../../worker/routes/adminPreorderOrigins';
import { adminProcurementOriginSerialRoutes } from '../../worker/routes/adminProcurementOriginSerials';
import type { RouteClassFile } from './_types';

export default {
  family: 'inventoryOrigins',
  mounts: [{
    prefix: '/api/admin/orders',
    name: 'adminOrderInventoryOriginRoutes',
    router: adminOrderInventoryOriginRoutes,
    writes: 'Requires a received provenance unit allocated to an order and a matching live serial slot; tests/inventoryOriginsPrivacy.test.ts exercises successful writes. No cost column is read or changed.',
    routes: {
      'GET /:id/inventory-origins': 'op',
      'POST /:id/inventory-origins/:assignmentId/confirm': 'op',
    },
  }, {
    prefix: '/api/admin/orders',
    name: 'adminPreorderOriginRoutes',
    router: adminPreorderOriginRoutes,
    writes: 'Requires a confirmed preorder in a preparation stage; tests/preorderOrigins.test.ts exercises authorized writes and lifecycle fences without inventory or cost changes.',
    routes: {
      'GET /:id/preorder-origins': 'op',
      'PATCH /:id/preorder-origins': 'op',
      // «اربط بالدفعة الواصلة» (the clean start's V2-6, addendum A.9 step 4): the lot's cost becomes the line's.
      'POST /:id/items/:itemId/link-batch': { cls: 'cost_write', why: 'links received lots to a pre-order line: FIFO allocations at the lots’ cost, one batch with the lot decrement' },
    },
  }, {
    prefix: '/api/admin/procurement',
    name: 'adminProcurementOriginSerialRoutes',
    router: adminProcurementOriginSerialRoutes,
    writes: 'Requires an available procurement unit and an unclaimed canonical device serial; tests/procurementOriginSerials.test.ts exercises successful writes. No monetary value is returned or changed.',
    routes: {
      'POST /documents/:id/unit-origins/:originId/serial': 'op',
    },
  }],
} satisfies RouteClassFile;
