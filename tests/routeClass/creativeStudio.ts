/**
 * ROUTE CLASSIFICATION — «استوديو Levonis الإبداعي», the Creative Studio
 * (docs/CREATIVE_STUDIO.md, DECISIONS row 270; the vocabulary is in
 * ./_types.ts, the test is tests/costRouteClassification.test.ts).
 *
 * NO COST, NO MONEY. The studio reads the store through the public card path
 * (the price a signed-out guest sees, worker/lib/creative/store.ts), and its
 * product answers are an allow-list with no cost, margin, supplier, stock
 * count or sales field; it writes only its own creative_* tables. So its
 * routes are:
 *
 *   owner  the provider key, the model list and settings, the connection test,
 *          the JSON snapshot import, brand-kit versions and their approval,
 *          and service claims — `requireOwner`: every other admin hears 403
 *          OWNER_ONLY (the unverified owner row OWNER_EMAIL_UNVERIFIED)
 *   op     everything else, behind the studio scope: the owner and full-scope
 *          admins (an assistant admin hears 403 CREATIVE_SCOPE_REQUIRED)
 *
 * tests/creativeStudio*.test.ts walk the flows end to end.
 */
import type { RouteClassFile } from './_types';
import { adminCreativeStudioRoutes } from '../../worker/routes/adminCreativeStudio';

const OWNER = { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } } as const;
const AI =
  'an AI request reaches the provider only with a configured key and a chosen model; the sweep has neither, so it is refused KEY_NOT_CONFIGURED before any studio row or store table is read or written';
const NEEDS_DESIGN =
  'acts on one stored studio design; the sweep has none, so it is refused 404 before anything is written — and a design holds no cost, price or stock column';
const NEEDS_ROW = 'acts on one stored studio row (a job, an idea, an asset or a snapshot); the sweep has none, so it is refused 404 before anything is written';
const MULTIPART = 'a multipart file upload; the sweep sends JSON, which is refused 400 before any byte is stored';

/** The smallest valid design: the normaliser fills every other field with its default. */
const MINIMAL_DESIGN = { schema_version: 1, format: { id: 'square', width: 1080, height: 1080 } };

export default {
  family: 'creativeStudio',
  mounts: [
    {
      prefix: '/api/admin/creative-studio',
      name: 'adminCreativeStudioRoutes',
      router: adminCreativeStudioRoutes,
      routes: {
        // Provider
        'GET /provider': 'op',
        'PUT /provider/key': OWNER,
        'DELETE /provider/key': OWNER,
        'POST /provider/test': OWNER,
        'GET /provider/models': OWNER,
        'PUT /provider/settings': OWNER,
        'GET /usage': 'op',
        // Store (read-only)
        'GET /products': 'op',
        'GET /products/:id': 'op',
        'POST /snapshots': { cls: 'op', noBody: 'builds a snapshot of a product a guest can see; the sweep database publishes none, so it answers 404 — and the snapshot is an allow-list with no cost field' },
        'POST /snapshots/import': OWNER,
        'GET /snapshots/:id': 'op',
        'POST /snapshots/:id/verify': { cls: 'op', noBody: NEEDS_ROW },
        // Brand
        'GET /brand': 'op',
        'GET /brand/versions': 'op',
        'GET /brand/versions/:version': 'op',
        'POST /brand/versions': OWNER,
        'POST /brand/versions/:version/approve': OWNER,
        // Claims
        'GET /claims': 'op',
        'POST /claims': OWNER,
        'PUT /claims/:id': OWNER,
        'POST /claims/:id/approve': OWNER,
        'GET /claims/:id/documents': 'op',
        // Assets
        'GET /assets': 'op',
        'POST /assets': { cls: 'op', noBody: MULTIPART },
        'GET /assets/:id/file': 'op',
        'PATCH /assets/:id': { cls: 'op', noBody: NEEDS_ROW },
        'DELETE /assets/:id': { cls: 'op', noBody: NEEDS_ROW },
        // Documents
        'GET /documents': 'op',
        'POST /documents': { cls: 'op', body: { title: 'role-matrix design', content: MINIMAL_DESIGN, kind: 'post' } },
        'GET /documents/:id': 'op',
        'PUT /documents/:id': { cls: 'op', noBody: NEEDS_DESIGN },
        'PATCH /documents/:id': { cls: 'op', noBody: NEEDS_DESIGN },
        'GET /documents/:id/versions': 'op',
        'GET /documents/:id/versions/:version': 'op',
        'POST /documents/:id/restore': { cls: 'op', noBody: NEEDS_DESIGN },
        'POST /documents/:id/duplicate': { cls: 'op', noBody: NEEDS_DESIGN },
        'POST /documents/:id/status': { cls: 'op', noBody: NEEDS_DESIGN },
        'POST /documents/:id/approve': { cls: 'op', noBody: NEEDS_DESIGN },
        'POST /documents/:id/reject': { cls: 'op', noBody: NEEDS_DESIGN },
        'GET /documents/:id/reviews': 'op',
        'POST /documents/:id/exports': { cls: 'op', noBody: MULTIPART },
        'GET /documents/:id/exports': 'op',
        'GET /exports/:id/file': 'op',
        // AI
        'POST /ai/ideas': { cls: 'op', noBody: AI },
        'POST /ai/compose': { cls: 'op', noBody: AI },
        'POST /ai/edit': { cls: 'op', noBody: AI },
        'POST /ai/review': { cls: 'op', noBody: AI },
        'POST /ai/carousel': { cls: 'op', noBody: AI },
        // Jobs
        'GET /jobs': 'op',
        'POST /jobs/:id/cancel': { cls: 'op', noBody: NEEDS_ROW },
        'POST /jobs/:id/applied': { cls: 'op', noBody: NEEDS_ROW },
        // Opportunities, ideas, feedback, the catalogue watch
        'GET /opportunities': 'op',
        'GET /ideas': 'op',
        'PATCH /ideas/:id': { cls: 'op', noBody: NEEDS_ROW },
        'POST /feedback': { cls: 'op', body: { kind: 'note', note: 'the product is too small', scope: 'brand' } },
        'GET /feedback': 'op',
        'POST /watch/sync': { cls: 'op', body: {}, why: 'records the card availability of visible products in the studio watch; reads the public card only' },
      },
    },
  ],
} satisfies RouteClassFile;
