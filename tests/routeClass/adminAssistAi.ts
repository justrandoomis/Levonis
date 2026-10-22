/**
 * ROUTE CLASSIFICATION — «الذكاء الاصطناعي للمساعد», the owner's assistant AI
 * tab (push B plan §11; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts; the behaviour is
 * tests/aiAdminOwnerOnly.test.ts).
 *
 * OWNER ONLY, AND NO COST. Every route sits behind `requireOwner`: the
 * verified owner alone; every other admin hears 403 OWNER_ONLY before anything
 * is read. The answers are the switch, the cap, model rows with the owner's
 * own rates, spend counters, outcome codes and credential BOOLEANS — never a
 * product cost, a price, the key, a prefix of it or its length.
 */
import type { RouteClassFile } from './_types';
import { adminAssistAiRoutes } from '../../worker/routes/adminAssistAi';

const OWNER = { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } } as const;

export default {
  family: 'assistAi',
  mounts: [
    {
      prefix: '/api/admin/assist-ai',
      name: 'adminAssistAiRoutes',
      router: adminAssistAiRoutes,
      routes: {
        'GET /': OWNER,
        'GET /models': { ...OWNER, path: '/api/admin/assist-ai/models?task=understand' },
        'PUT /tasks/:task/:rank': {
          ...OWNER,
          path: '/api/admin/assist-ai/tasks/understand/0',
          noBody:
            'every save re-fetches the provider live list; the sweep env has no provider key, so the list is unreadable and the save is refused (409 AI_MODEL_LIST_UNAVAILABLE) before anything is written — tests/aiAdminOwnerOnly.test.ts saves with a fake list',
        },
        'DELETE /tasks/:task/:rank': { ...OWNER, path: '/api/admin/assist-ai/tasks/understand/1', body: {} },
        'PUT /settings': {
          ...OWNER,
          body: { enabled: false, daily_cap_usd: 1, guests: false, guest_share_pct: 25, understand_ckb: false },
        },
        'POST /test/:task': {
          ...OWNER,
          path: '/api/admin/assist-ai/test/understand',
          body: {},
          why: 'no provider key in the sweep env: the Test answers 200 { ok: false, code: NOT_CONFIGURED } and calls nothing',
        },
      },
    },
  ],
} satisfies RouteClassFile;
