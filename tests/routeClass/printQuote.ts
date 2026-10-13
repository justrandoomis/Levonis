/**
 * ROUTE CLASSIFICATION — the customer print calculator, /api/print-quote
 * (Engine B). DECISIONS row 220.
 *
 * Not an admin mount, and classified anyway: these doors build the quote a
 * guest, a customer and a store owner read, and the write sweep used to call
 * them with an EMPTY body only — a validation refusal every time — so it never
 * walked a single priced answer. Each priced door names one VALID body here
 * (the analysis and the merchant's own printer are rows the role-matrix seed
 * adds: tests/fixtures/roleMatrix.ts seedAuditRows), so tests/costRoleMatrixWrites
 * walks the public quote (everyone) and the merchant's own costing (/compare)
 * for every role.
 *
 * Everything here is `open`: the guest door is the point. What a non-owner
 * may read on it is the final price alone — the platform's cost chain stays on
 * the server (publicQuote), and a store owner's /compare is built only from
 * the economics the store owner declared for their own machines.
 */
import { NB, type RouteClassFile } from './_types';
import { printQuoteRoutes } from '../../worker/routes/printQuote';

const GRAMS = { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 120 }], print_minutes: 180 };

export default {
  family: 'print-quote',
  mounts: [
    {
      prefix: '/api/print-quote',
      name: 'printQuoteRoutes',
      router: printQuoteRoutes,
      routes: {
        'GET /printers': 'open',
        'GET /accessories': 'open',
        'GET /materials': 'open',
        'POST /uploads': {
          cls: 'open',
          noBody: 'a multipart model upload to private storage; the analysis it creates is priced on the quote door, which names a body',
        },
        'POST /analyses/:id/measure': { cls: 'open', noBody: 'stores a client measurement on an analysis; no price, cost or rate is computed or answered' },
        'POST /analyses/:id': { cls: 'open', noBody: 'stores the slicer measurement of an analysis; the quote door prices it and names a body' },
        'POST /analyses/:id/lookup': { cls: 'open', noBody: NB.REFUSED_FIRST },
        'GET /analyses/:id': 'open',
        'GET /analyses/:id/file': 'open',
        'POST /analyses/:id/quote': { cls: 'open', path: '/api/print-quote/analyses/pa_um/quote', body: {} },
        'POST /grams-quote': { cls: 'open', body: GRAMS },
        'POST /link': {
          cls: 'open',
          // A provider with no API configured: answered from the URL alone, no outbound request.
          body: { url: 'https://makerworld.com/en/models/123456', printer_model_id: 'bbl-a1m', material_id: 'pla' },
        },
        'POST /analyses/:id/compare': { cls: 'open', path: '/api/print-quote/analyses/pa_um/compare', body: {}, caller: 'merchant' },
      },
    },
  ],
} satisfies RouteClassFile;
