/**
 * ROUTE CLASSIFICATION — «الأمان», the owner's security console (deception
 * layer, DECISIONS row 206; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * OWNER ONLY, AND NO COST. Every route sits behind `requireOwner`: the
 * verified owner alone; every other admin hears 403 OWNER_ONLY (the unverified
 * owner row OWNER_EMAIL_UNVERIFIED) before anything is read. The answers are
 * ids, codes, counts and times — blocks, the security log, scores, and an
 * incident's regenerated fake decoy text (a string of invented lines, never a
 * stored value). tests/adminSecurity.test.ts walks them end to end.
 */
import type { RouteClassFile } from './_types';
import { adminSecurityRoutes } from '../../worker/routes/adminSecurity';

const OWNER = { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } } as const;

export default {
  family: 'security',
  mounts: [
    {
      prefix: '/api/admin/security',
      name: 'adminSecurityRoutes',
      router: adminSecurityRoutes,
      routes: {
        'GET /summary': OWNER,
        'GET /blocks': OWNER,
        'GET /events': OWNER,
        'GET /incidents/:id': OWNER,
        'GET /scores': OWNER,
        'POST /blocks/:id/lift': OWNER,
      },
    },
  ],
} satisfies RouteClassFile;
