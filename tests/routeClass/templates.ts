/**
 * ROUTE CLASSIFICATION — the product template and the import (owner decision
 * 2, step S1; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * Every admin may export, parse and apply a product template, and import a
 * catalogue: `op`. The cost lines are in the export for the owner only
 * (`includeCost` is canViewCost), a non-owner's parse and apply carry the
 * stored cost forward untouched (`money` is canWriteCost), and every preview
 * and report is projected. The parse, the section preview and the apply carry
 * a VALID body here — the caller's own export, sent back, the round trip the
 * template screen makes — so their success answers are walked (critique A3).
 */
import type { RouteClassFile } from './_types';
import { adminImportRoutes } from '../../worker/routes/adminImport';
import { templateRoutes } from '../../worker/routes/template';

export default {
  family: 'templates',
  mounts: [
    {
      prefix: '/api/admin/template',
      name: 'templateRoutes',
      router: templateRoutes,
      routes: {
        'GET /blank': 'op',
        'GET /example': 'op',
        'GET /export/:productId': 'op',
        'GET /section-export/:productId': 'op',
        'POST /parse': {
          cls: 'op',
          body: async (read: (p: string) => Promise<Record<string, unknown>>) => ({ text: (await read('/api/admin/template/export/p_a1')).text }),
        },
        'POST /section-preview': {
          cls: 'op',
          body: async (read: (p: string) => Promise<Record<string, unknown>>) => ({
            product_id: 'p_a1',
            text: (await read('/api/admin/template/section-export/p_a1')).text,
          }),
        },
        'GET /apply-status/:fingerprint': 'op',
        'POST /apply': {
          cls: 'op',
          body: async (read: (p: string) => Promise<Record<string, unknown>>) => ({
            text: (await read('/api/admin/template/section-export/p_a1')).text,
            mode: 'update',
            confirm: true,
            scope: 'specs_content',
            product_id: 'p_a1',
          }),
        },
        'POST /parse-zip': {
          cls: 'op',
          noBody: 'a multipart ZIP upload, not JSON; the same parser as /parse (swept with a valid body above), refused here before the archive is read',
        },
      },
    },
    {
      prefix: '/api/admin/import',
      name: 'adminImportRoutes',
      router: adminImportRoutes,
      routes: {
        'GET /template': 'op',
        'GET /types': 'op',
        'GET /lookups': 'op',
        'GET /export': 'op',
        'POST /preview': {
          cls: 'op',
          noBody: 'a multipart CSV upload, not JSON (a JSON request is refused before a row is read); tests/importBrandCreate.test.ts previews real files',
        },
        'POST /confirm': {
          cls: 'op',
          noBody: 'confirms an earlier preview by its token, which only the multipart preview returns; the unknown-token refusal is walked',
        },
        'GET /history': 'op',
        'GET /:id/report': 'op',
      },
    },
  ],
} satisfies RouteClassFile;
