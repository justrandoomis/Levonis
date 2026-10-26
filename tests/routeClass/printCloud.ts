/**
 * ROUTE CLASSIFICATION — Levonis Print Cloud administration,
 * /api/admin/print-cloud (docs/PRINT_CLOUD.md §10.2, DECISIONS row 270).
 *
 * The workshop OPERATOR is an assistant admin: the queue, jobs, printers,
 * stock COUNTS, shipments and estimates are `op`. Prices, payments, refunds,
 * balance adjustments, buybacks, agent credentials and revenue are `money`.
 * What the workshop PAID — stock lot costs, machine acquisition, the profit
 * computed from them — is `cost_read`. On the mixed `op` doors the split is
 * per FIELD, in the handler: a price field needs money scope, a cost field
 * the owner (worker/lib/printCloud/catalog.ts `assertWritable`), and every
 * catalogue answer leaves through `stripCost`.
 */
import type { RouteClassFile } from './_types';
import { adminPrintCloudRoutes } from '../../worker/routes/printCloudAdmin';

const NEEDS_JOB = 'a print job transition; needs a job the role fixture does not seed (refused NOT_FOUND before any write)';

export default {
  family: 'print-cloud',
  mounts: [
    {
      prefix: '/api/admin/print-cloud',
      name: 'adminPrintCloudRoutes',
      router: adminPrintCloudRoutes,
      writes: 'Print Cloud workshop operations on rows the role fixture does not seed; refused NOT_FOUND before any write',
      routes: {
        'GET /overview': 'op',
        'GET /settings': { cls: 'op', why: 'cost_* keys are removed for every caller but the owner (publicSettings)' },
        'PATCH /settings': 'money',
        'GET /adapters': 'op',
        'GET /catalog/:entity': { cls: 'op', why: 'stripCost removes acquisition and upkeep costs for every caller but the owner' },
        'POST /catalog/:entity': {
          cls: 'op',
          path: '/api/admin/print-cloud/catalog/locations',
          body: { code: 'RACK-A', name: 'Rack A' },
          why: 'price fields need money scope and cost fields the owner, per field; the answer is cost-stripped',
        },
        'PATCH /catalog/:entity/:id': { cls: 'op', noBody: 'updates a catalogue row the role fixture does not seed; price and cost fields are refused per field' },
        'PUT /variants/:id/price-tiers': 'money',
        'GET /categories': 'op',
        'PATCH /categories/:code/buyback': 'money',
        'GET /price-changes': 'money',
        'GET /stock': { cls: 'op', why: 'counts only: on hand, held, customer-owned, sellable; no lot cost' },
        'GET /stock/lots': 'cost_read',
        'POST /stock/receive': { cls: 'op', noBody: 'receives a lot of a variant the role fixture does not seed; its cost field is the owner’s, refused per field' },
        'POST /stock/adjust': { cls: 'op', noBody: 'a count correction of a variant the role fixture does not seed' },
        'POST /stock/waste': { cls: 'op', noBody: 'records waste of a variant the role fixture does not seed' },
        'GET /customers/:userId': 'money',
        'POST /customers/:userId/credits/adjust': 'money',
        'POST /customers/:userId/inventory/adjust': 'money',
        'GET /orders': 'money',
        'GET /orders/:id': 'money',
        'POST /orders/:id/confirm-payment': 'money',
        'POST /orders/:id/cancel': 'money',
        'POST /orders/:id/refunds': 'money',
        'GET /payment-events': 'money',
        'GET /jobs': 'op',
        'GET /jobs/:id': 'op',
        'POST /jobs/:id/approve': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/reject': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/estimate': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/assign': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/unassign': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/start': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/pause': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/resume': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/complete': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/verify-completion': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/fail': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/cancel': { cls: 'op', noBody: NEEDS_JOB },
        'POST /jobs/:id/priority': { cls: 'op', noBody: NEEDS_JOB },
        'GET /failures': 'op',
        'POST /failures/:id/resolve': {
          cls: 'op',
          noBody: 'resolves a failure the role fixture does not seed; stating billable amounts by hand needs money scope, judged in the handler',
        },
        'GET /queue': 'op',
        'POST /queue/run': { cls: 'op', body: {}, why: 'assigns queued jobs to machines; no money or cost is read' },
        'GET /printers': { cls: 'op', why: 'status, connectivity and telemetry; no acquisition cost' },
        'GET /printers/:id/events': 'op',
        'POST /printers/:id/commands': { cls: 'op', noBody: 'queues a command for a printer the role fixture does not seed' },
        'POST /printers/:id/maintenance': { cls: 'op', noBody: 'plans maintenance of a printer the role fixture does not seed; its cost field is the owner’s, refused per field' },
        'PATCH /maintenance/:id': { cls: 'op', noBody: 'closes a maintenance window the role fixture does not seed' },
        'GET /agents': 'op',
        'POST /agents': 'money',
        'POST /agents/:id/revoke': 'money',
        'GET /shipments': { cls: 'op', why: 'the delivery fee is removed for every caller without money scope' },
        'POST /shipments/:id/advance': { cls: 'op', noBody: 'advances a shipment the role fixture does not seed' },
        'GET /buybacks': 'money',
        'POST /buybacks/:id/approve': 'money',
        'POST /buybacks/:id/reject': 'money',
        'POST /buybacks/:id/paid': 'money',
        'GET /reports/revenue': 'money',
        'GET /reports/profit': 'cost_read',
        'GET /reports/operations': 'op',
        'GET /reconcile': 'money',
        'GET /tasks': 'op',
        'POST /tasks/run': { cls: 'op', body: {}, why: 'runs due background work; reads no cost' },
        'GET /audit': 'money',
      },
    },
  ],
} satisfies RouteClassFile;

