/**
 * ROUTE CLASSIFICATION — the Bambu catalogue import's dashboard API (import
 * spec §H.1; DECISIONS row 241; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * OWNER ONLY. Every route sits behind `requireOwner`: the verified owner
 * alone; every other admin hears 403 OWNER_ONLY before anything is read. The
 * answers are counts, states, codes, ids, names and public URLs — no price,
 * cost, stock fact, token hash or protected digest. The one write is the
 * owner's fill of the empty package measures from the imported logistics rows
 * (worker/lib/catalogImport/packageMeasures.ts; tests/catalogImportPackageFill.test.ts).
 *
 * The runner's ops door (`/api/ops/catalog-import`) is not an admin mount and is
 * not classified here: it has no session class at all (a bearer token on the run
 * row), and every session role meets its uniform 404 in the role matrix sweeps
 * (tests/fixtures/roleMatrix.ts BASE_MOUNTS) and tests/catalogImportAuth.test.ts.
 */
import type { RouteClassFile } from './_types';
import { adminCatalogImportRoutes } from '../../worker/routes/adminCatalogImport';

const OWNER = { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } } as const;

export default {
  family: 'catalogImport',
  mounts: [
    {
      prefix: '/api/admin/catalog-import',
      name: 'adminCatalogImportRoutes',
      router: adminCatalogImportRoutes,
      routes: {
        'GET /runs': OWNER,
        'GET /runs/:id': OWNER,
        'GET /runs/:id/items': OWNER,
        'GET /items/:id': OWNER,
        'GET /runs/:id/report.json': OWNER,
        'GET /runs/:id/report.csv': OWNER,
        'POST /fill-package-measures': OWNER,
      },
    },
  ],
} satisfies RouteClassFile;
