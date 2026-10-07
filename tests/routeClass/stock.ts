/**
 * ROUTE CLASSIFICATION — inventory, procurement and stock operations (owner
 * decision 2, step S1; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * §52 has assistants counting units and receiving shipments all day, so the
 * stock screens stay open to every admin (`op`) and the server strips what a
 * unit cost from every non-owner answer: lot unit costs, purchase totals, FX
 * rates, valuation. Every write that touches a lot internally — receive,
 * count, transfer, scan, adjust — carries a VALID body here, so its success
 * answer is walked as well as its refusals (critique A3). Purchasing, supplier
 * payments, cost profiles and period documents are cost and refused outright.
 */
import type { RouteClassFile } from './_types';
import { adminInventoryRoutes } from '../../worker/routes/adminInventory';
import { adminProcurementRoutes } from '../../worker/routes/adminProcurement';
import { adminStockOperationsRoutes } from '../../worker/routes/adminStockOperations';

export default {
  family: 'stock',
  mounts: [
    {
      prefix: '/api/admin/inventory',
      name: 'adminInventoryRoutes',
      router: adminInventoryRoutes,
      routes: {
        'GET /overview': 'op',
        'GET /lines': 'op',
        'GET /lots': 'op',
        'GET /incoming': 'op',
        'POST /incoming': 'cost_write',
        'PATCH /incoming/:id': 'cost_write',
        'GET /incoming/:id/receive-preview': 'op',
        // A receipt writes a lot at its unit cost; the answer must not carry it.
        'POST /incoming/:id/receive': { cls: 'op', path: '/api/admin/inventory/incoming/inc1/receive', body: { receipt_id: 'rm-receipt-1', qty: 1 } },
        'GET /movements': 'op',
        'POST /adjustments': { cls: 'op', body: { product_id: 'p_a1', scope: 'base', delta: -1, reason: 'damaged', note: 'role matrix' } },
        'GET /suppliers': 'op',
        'POST /suppliers': { cls: 'op', body: { name: 'Role matrix supplier' } },
        // The one cost read that keeps its 404 for a non-owner (master plan C2).
        'GET /incoming/:id/profit-preview': {
          cls: 'cost_read',
          refusal: { status: 404 },
          path: '/api/admin/inventory/incoming/inc1/profit-preview',
          why: 'an unknown purchase and a refused caller look the same: 404, no existence oracle',
        },
      },
    },
    {
      prefix: '/api/admin/procurement',
      name: 'adminProcurementRoutes',
      router: adminProcurementRoutes,
      routes: {
        // Stays open: stock operations reads a selection by id (StockSelection.tsx); its cost is stripped.
        'GET /selections/:id': 'op',
        'POST /import-preview': 'cost_write',
        'GET /config': 'cost_read',
        'PUT /cost-profiles/:id': 'cost_write',
        'GET /documents': 'cost_read',
        'GET /documents/:id': { cls: 'cost_read', path: '/api/admin/procurement/documents/po1' },
        // The receiver's view (`receive`): an allowlist with no price, charge,
        // payment or funding column — the GET sweep walks it for every role.
        'GET /receiving': 'op',
        'GET /receiving/:id': { cls: 'op', path: '/api/admin/procurement/receiving/po1' },
        'POST /documents': 'cost_write',
        'PUT /documents/:id': { cls: 'cost_write', path: '/api/admin/procurement/documents/po1' },
        // A receiving assistant receives against the document; the answer carries no cost.
        'POST /documents/:id/receive': {
          cls: 'op',
          path: '/api/admin/procurement/documents/po1/receive',
          body: { operation_id: 'rm-po1-receive', lines: [{ line_id: 'pl1', qty: 1 }] },
        },
        'POST /documents/:id/payments': { cls: 'cost_write', path: '/api/admin/procurement/documents/po1/payments' },
        'POST /documents/:id/close': { cls: 'cost_write', path: '/api/admin/procurement/documents/po1/close' },
        'POST /documents/:id/investor-receipts': {
          cls: 'owner',
          refusal: { status: 403, code: 'FORBIDDEN' },
          path: '/api/admin/procurement/documents/po1/investor-receipts',
        },
      },
    },
    {
      prefix: '/api/admin/stock-operations',
      name: 'adminStockOperationsRoutes',
      router: adminStockOperationsRoutes,
      routes: {
        'GET /locations': 'op',
        'POST /locations': { cls: 'op', body: { name: 'رف المصفوفة' } },
        'POST /transfers': { cls: 'op', body: { operation_id: 'rm-transfer-1', lot_id: 'lot1', location_id: 'loc1', qty: 1 } },
        'GET /counts': 'op',
        'GET /counts/:id': 'op',
        'POST /counts': {
          cls: 'op',
          body: { operation_id: 'rm-count-0001', name: 'جرد', lines: [{ product_id: 'p_a1', scope: 'base', scope_id: '', counted_qty: 2 }] },
        },
        'POST /counts/:id/post': {
          cls: 'op',
          noBody: 'posts a count session by its id, which only a POST /counts in the same run returns; tests/operationsErp.test.ts posts one end to end',
        },
        'POST /counts/:id/cancel': { cls: 'op', noBody: 'cancels a count session by id; writes its state only' },
        'GET /health': 'op',
        'POST /reorder': { cls: 'op', body: { product_id: 'p_a1', scope: 'base', scope_id: '', reorder_point: 2, lead_time_days: 7 } },
        'GET /trace': 'op',
        'POST /serial-link': {
          cls: 'op',
          noBody: 'needs a registered serial (serial_inventory), which the role fixture does not seed; tests/operationsCapabilities.test.ts links one',
        },
        'POST /return-inspections': {
          cls: 'op',
          noBody: 'needs an open return case, which the role fixture does not seed; tests/operationsErp.test.ts inspects one',
        },
        // The scan answers the whole lot row — stripped for a non-owner.
        'POST /scan': { cls: 'op', body: { code: 'lot1' } },
        'POST /lot-counts': { cls: 'op', body: { operation_id: 'rm-lot-count-1', lot_id: 'lot1', counted_qty: 1 } },
      },
    },
  ],
} satisfies RouteClassFile;
